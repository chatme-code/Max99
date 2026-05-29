import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { NOTIFICATION_TYPE, NOTIFICATION_STATUS, LEADERBOARD_TYPE, LEADERBOARD_PERIOD } from "@shared/schema";
import type { UserReputationRow, LevelThreshold } from "@shared/schema";
import { buildDefaultReputationLevels, reputationFormulaLevelFromScore, reputationLevelScore } from "./levelCurve";
import { getXpConfig, getXpConfigSync, updateXpConfig, XP_DEFAULTS, type XpConfig } from "./xpConfig";

// ─── Java Scoring Formula ─────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/reputation/file/ScoreFinalSummary.java
// and com/projectgoth/fusion/reputation/cache/ScoreFormulaParameters.java
//
// The Java system runs a daily batch that:
//   1. Collects raw activity metrics for each user
//   2. Normalises each metric to [0–100] relative to a "reasonable maximum"
//   3. Applies a bonus for high performers (closer to reasonableMax → bonus pts)
//   4. Groups normalised+weighted metrics into 4 categories (each capped at 100)
//   5. Sums categories → daily score (capped at dailyHardCap = 400)
//   6. Adds to cumulative score and re-derives the user's level via the DB table

// ScoreFormulaParameters.java default values
const REASONABLE_MAX = {
  chatRoomMessagesSent:   30,
  privateMessagesSent:    75,
  totalTime:              6000,  // seconds
  photosUploaded:         1,
  kicksInitiated:         5,
  authenticatedReferrals: 3,
  rechargedAmount:        1,
  virtualGiftsReceived:   2,
  virtualGiftsSent:       2,
  phoneCallDuration:      120,   // seconds
};

// Bonus table — from ScoreFormulaParameters:
//   reasonableMaximumMinus50 = 2 → if metric >= 50% of max, award +2
//   reasonableMaximumMinus45 = 4, Minus40 = 6, Minus35 = 8, Minus30 = 10
//   Minus25 = 6, Minus20 = 4, Minus15 = 2, Minus10 = 0
const BONUS_TABLE: Array<{ threshold: number; bonus: number }> = [
  { threshold: 0.50, bonus: 2  },
  { threshold: 0.45, bonus: 4  },
  { threshold: 0.40, bonus: 6  },
  { threshold: 0.35, bonus: 8  },
  { threshold: 0.30, bonus: 10 },
  { threshold: 0.25, bonus: 6  },
  { threshold: 0.20, bonus: 4  },
  { threshold: 0.15, bonus: 2  },
  { threshold: 0.10, bonus: 0  },
];

const DAILY_HARD_CAP = 400; // ScoreFormulaParameters.dailyHardCap

type MetricKey = keyof typeof REASONABLE_MAX;

function normalise(actual: number, max: number): number {
  const pct = Math.round((actual / max) * 100);
  return Math.max(0, Math.min(100, pct));
}

// Mirrors ScoreFinalSummary.score() bonus logic
function applyBonus(normalisedScore: number, reasonableMax: number): number {
  for (const entry of BONUS_TABLE) {
    if (normalisedScore >= entry.threshold * reasonableMax) {
      return normalisedScore + entry.bonus;
    }
  }
  return normalisedScore;
}

// Compute a single-period score from lifetime metrics.
// Real-time equivalent of the Java daily batch ScoreFinalSummary.scoreFile().
export function computeScoreFromMetrics(rep: UserReputationRow): number {
  const metrics: Record<MetricKey, number> = {
    chatRoomMessagesSent:   rep.chatRoomMessagesSent,
    privateMessagesSent:    rep.privateMessagesSent,
    totalTime:              rep.totalTime,
    photosUploaded:         rep.photosUploaded,
    kicksInitiated:         rep.kicksInitiated,
    authenticatedReferrals: rep.authenticatedReferrals,
    rechargedAmount:        rep.rechargedAmount,
    virtualGiftsReceived:   rep.virtualGiftsReceived,
    virtualGiftsSent:       rep.virtualGiftsSent,
    phoneCallDuration:      rep.phoneCallDuration,
  };

  const s: Record<MetricKey, number> = {} as any;
  for (const key of Object.keys(metrics) as MetricKey[]) {
    const raw = normalise(metrics[key], REASONABLE_MAX[key]);
    s[key]    = Math.min(100, applyBonus(raw, REASONABLE_MAX[key]));
  }

  // ScoreCategory.TIME_IN_PRODUCT
  const timeInProduct = s.totalTime;

  // ScoreCategory.CREDITS_SPENT = rechargedAmount + virtualGiftsSent + phoneCallDuration
  const creditsSpent = Math.min(100, s.rechargedAmount + s.virtualGiftsSent + s.phoneCallDuration);

  // ScoreCategory.HUMAN_LIKELY_BEHAVIOUR = photosUploaded + virtualGiftsReceived + authenticatedReferrals
  const humanLikely = Math.min(100, s.photosUploaded + s.virtualGiftsReceived + s.authenticatedReferrals);

  // ScoreCategory.BASIC_ACTIVITY = min(chatRoom,75) + min(privateMsg,75), capped at 100
  const basicActivity = Math.min(100, Math.min(s.chatRoomMessagesSent, 75) + Math.min(s.privateMessagesSent, 75));

  const total = timeInProduct + creditsSpent + humanLikely + basicActivity;
  return Math.min(DAILY_HARD_CAP, total);
}

// ─── Level Table (in-memory cache) ───────────────────────────────────────────
// Mirrors com/projectgoth/fusion/reputation/util/LevelTable.java
// The table is loaded from DB at startup and refreshed periodically.
// The Java system reads it with: SELECT score,level FROM ReputationScoreToLevel ORDER BY score DESC

let cachedLevelTable: LevelThreshold[] = [];
let levelTableLoadedAt = 0;
const LEVEL_TABLE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Force the next getLevelTable() call to re-fetch from DB (e.g. after schema seed). */
export function invalidateLevelCache(): void {
  cachedLevelTable = [];
  levelTableLoadedAt = 0;
}

async function getLevelTable(): Promise<LevelThreshold[]> {
  const now = Date.now();
  if (cachedLevelTable.length > 0 && now - levelTableLoadedAt < LEVEL_TABLE_TTL_MS) {
    return cachedLevelTable;
  }
  try {
    const table = await storage.getLevelTable();
    // Only trust the DB table if it has all 50 levels — a partial table causes wrong level lookups.
    // If fewer than 50 entries exist, seed the DB with the hardcoded defaults and use those.
    if (table.length >= 50) {
      cachedLevelTable = table; // already sorted DESC by score from DB
      levelTableLoadedAt = now;
      return cachedLevelTable;
    }
    // DB is incomplete — seed it with hardcoded defaults
    for (const entry of HARDCODED_LEVELS) {
      storage.upsertLevelThreshold(entry).catch(() => {});
    }
  } catch {
    // fall through to hardcoded defaults
  }
  // Hardcoded fallback matching the Java defaults (scores from level thresholds)
  cachedLevelTable = HARDCODED_LEVELS;
  levelTableLoadedAt = now;
  return cachedLevelTable;
}

const HARDCODED_LEVELS: LevelThreshold[] = buildDefaultReputationLevels();

// ─── Unlimited Level Formula ──────────────────────────────────────────────────
// For levels beyond the highest entry in the table, use the power-law formula:
//   score(n) = round(20 * (n-1)^1.5)
// This extends the same curve used by levels 1–50 infinitely.

/** Minimum XP required to reach a given level (formula-based). */
function formulaScore(level: number): number {
  return reputationLevelScore(level);
}

/** Derive level number from score using the formula (inverse of formulaScore). */
function formulaLevelFromScore(score: number): number {
  return reputationFormulaLevelFromScore(score);
}

/** Build a synthetic LevelThreshold for formula-computed levels (> max DB level). */
function buildFormulaLevelData(level: number): LevelThreshold {
  // Inherit all privileges from level 50 (everything unlocked).
  const top = HARDCODED_LEVELS[0]; // Level 50 — sorted DESC
  return {
    ...top,
    level,
    score: formulaScore(level),
    name:  `Level ${level}`,
    image: null,
  };
}

// Mirrors LevelTable.getLevelForScore() — floor lookup: highest level where score >= threshold
// levelTable must be sorted DESC by score (as returned by DB).
// For scores above the highest table entry, the formula extends levels infinitely.
export function scoreToLevel(score: number, levelTable: LevelThreshold[] = HARDCODED_LEVELS): number {
  const maxEntry = levelTable[0]; // Highest level (table sorted DESC)
  if (maxEntry && score > maxEntry.score) {
    return formulaLevelFromScore(score);
  }
  for (const entry of levelTable) {
    if (score >= entry.score) return entry.level;
  }
  return 1;
}

export function getLevelDataForScoreSync(score: number, levelTable: LevelThreshold[] = HARDCODED_LEVELS): LevelThreshold | undefined {
  const maxEntry = levelTable[0]; // Highest level (table sorted DESC)
  if (maxEntry && score > maxEntry.score) {
    return buildFormulaLevelData(formulaLevelFromScore(score));
  }
  for (const entry of levelTable) {
    if (score >= entry.score) return entry;
  }
  return undefined;
}

// ─── Per-action Score Awards ─────────────────────────────────────────────────
// Real-time equivalent of the daily batch.
// Per-unit values derived from the Java formula ceilings:
//   chatRoomMsg  → BASIC_ACTIVITY cap 75 / 30 max msgs    → ≈ 2.5 pts each
//   privateMsg   → BASIC_ACTIVITY cap 75 / 75 max msgs    → ≈ 1.0 pts each
//   virtualGift  → CREDITS_SPENT / HUMAN_LIKE (max 2)     → 50 pts each
//   photoUpload  → HUMAN_LIKELY (max 1 = 100 pts)         → 100 pts
//   referral     → HUMAN_LIKELY (max 3)                   → ≈ 33 pts each
//   phoneCall/s  → CREDITS_SPENT (max 120 s = 100 pts)    → ≈ 1 pt/s
//   sessionTime  → TIME_IN_PRODUCT (max 6000 s = 100 pts) → ≈ 0.017 pts/s
export type ReputationAction =
  | "chatRoomMessage"
  | "privateMessage"
  | "giftSent"
  | "giftReceived"
  | "photoUploaded"
  | "referral"
  | "phoneCallSecond"
  | "sessionSecond"
  | "gamePlayed"
  | "gameWon";

/**
 * XP awarded per action. These are the COMPILE-TIME defaults — at runtime
 * the values are read from `xpConfig` (backed by system_settings) and can be
 * tuned live via the admin UI without a Docker rebuild.
 */
const ACTION_SCORE: Record<ReputationAction, number> = {
  chatRoomMessage:  XP_DEFAULTS.chatRoomMessage,
  privateMessage:   XP_DEFAULTS.privateMessage,
  giftSent:         XP_DEFAULTS.giftSent,
  giftReceived:     XP_DEFAULTS.giftReceived,
  photoUploaded:    XP_DEFAULTS.photoUploaded,
  referral:         XP_DEFAULTS.referral,
  phoneCallSecond:  XP_DEFAULTS.phoneCallSecond,
  sessionSecond:    0,   // tracked but not directly scored — affects totalTime metric
  gamePlayed:       XP_DEFAULTS.gamePlayed,
  gameWon:          XP_DEFAULTS.gameWon,
};

/** Resolve current per-action XP value, preferring the runtime config. */
function getActionScore(action: ReputationAction): number {
  if (action === "sessionSecond") return 0;
  const cfg = getXpConfigSync();
  const v = (cfg as any)[action];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : ACTION_SCORE[action];
}

const ACTION_METRIC: Record<ReputationAction, MetricKey | "sessionCount" | null> = {
  chatRoomMessage:  "chatRoomMessagesSent",
  privateMessage:   "privateMessagesSent",
  giftSent:         "virtualGiftsSent",
  giftReceived:     "virtualGiftsReceived",
  photoUploaded:    "photosUploaded",
  referral:         "authenticatedReferrals",
  phoneCallSecond:  "phoneCallDuration",
  sessionSecond:    "totalTime",
  gamePlayed:       null, // no raw metric counter (XP only)
  gameWon:          null,
};

// ─── Anti-flood throttle for chat XP ──────────────────────────────────────────
// Without this, spamming the chatroom would be the fastest way to gain XP.
// Limits are read from runtime XP config (admin UI tunable):
//   xp.chatThrottleMinGapMs   minimum gap between XP-awarded msgs
//   xp.chatThrottlePerMinCap  max XP-eligible msgs per rolling minute
// Other actions (gift, photo, game) are NOT throttled — they have natural
// cost / cooldown of their own.
const CHAT_XP_PER_MIN_WIN = 60_000;
type ChatThrottleEntry = { lastAt: number; windowStart: number; countInWindow: number };
const chatThrottle = new Map<string, ChatThrottleEntry>();

/** Returns true if this chat message should be awarded XP (not a flood). */
function shouldAwardChatXp(username: string): boolean {
  const cfg = getXpConfigSync();
  const minGap = cfg.chatThrottleMinGapMs;
  const cap    = cfg.chatThrottlePerMinCap;
  // A non-positive limit disables throttling entirely.
  if (minGap <= 0 && cap <= 0) return true;

  const now = Date.now();
  const e = chatThrottle.get(username);
  if (!e) {
    chatThrottle.set(username, { lastAt: now, windowStart: now, countInWindow: 1 });
    return true;
  }
  if (minGap > 0 && now - e.lastAt < minGap) return false;          // too fast
  if (now - e.windowStart >= CHAT_XP_PER_MIN_WIN) {
    e.windowStart = now;
    e.countInWindow = 0;
  }
  if (cap > 0 && e.countInWindow >= cap) return false;              // capped /min
  e.lastAt = now;
  e.countInWindow += 1;
  return true;
}

// Periodic cleanup so the map doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - 5 * CHAT_XP_PER_MIN_WIN;
  for (const [u, e] of chatThrottle) if (e.lastAt < cutoff) chatThrottle.delete(u);
}, 10 * 60_000).unref?.();

export interface AwardResult {
  username:    string;
  scoreAdded:  number;
  newScore:    number;
  oldLevel:    number;
  newLevel:    number;
  leveledUp:   boolean;
  levelData:   LevelThreshold | null;
}

// ─── onLevelChanged ───────────────────────────────────────────────────────────
// Mirrors UpdateScoreTable.onLevelChanged() in the Java backend.
// Triggered whenever a user's computed level increases.
// Java side effects:
//   1. updateUserOwnedRoomSize() — update chatroom max size in DB + live rooms
//   2. ReputationLevelIncreaseTrigger → RewardCentre.sendTrigger()
//   3. UserNotificationServicePrx.notifyFusionUser() with MIGLEVEL_INCREASE_ALERT
async function onLevelChanged(
  username: string,
  oldLevelData: LevelThreshold | undefined,
  newLevelData: LevelThreshold,
): Promise<void> {
  // 1. Update chatroom size if it changed (mirrors updateUserOwnedRoomSize())
  if (
    newLevelData.chatRoomSize !== null &&
    (oldLevelData === undefined || oldLevelData.chatRoomSize !== newLevelData.chatRoomSize)
  ) {
    try {
      // Update all chatrooms owned by this user to the new max size
      const userChatrooms = await storage.getChatrooms();
      for (const room of userChatrooms) {
        if (room.userOwned && room.createdBy) {
          const creator = await storage.getUserByUsername(username);
          if (creator && room.createdBy === creator.id) {
            await storage.updateChatroom(room.id, { maxParticipants: newLevelData.chatRoomSize! });
          }
        }
      }
    } catch {
      // non-fatal
    }
  }

  // 2. Sync migLevel in user_profiles (mirrors the mig_level field on the profile)
  try {
    const user = await storage.getUserByUsername(username);
    if (user) {
      await storage.upsertUserProfile(user.id, { migLevel: newLevelData.level });
    }
  } catch {
    // non-fatal
  }

  // 3. Update MIG_LEVEL leaderboard across all periods.
  // Stores the user's *cumulative reputation score* (XP) so the leaderboard
  // ranks by score and the displayed value matches the user's actual XP — the
  // mobile UI labels this leaderboard's value as "xp". Storing the level
  // number here previously caused the leaderboard to be out of sync with
  // user_reputation.score (e.g. user with score 175 was shown as "3 xp"
  // because their level was 3).
  try {
    const rep = await storage.getUserReputation(username);
    const scoreXp = rep?.score ?? 0;
    const migLbPeriods = [
      LEADERBOARD_PERIOD.DAILY,
      LEADERBOARD_PERIOD.WEEKLY,
      LEADERBOARD_PERIOD.MONTHLY,
      LEADERBOARD_PERIOD.ALL_TIME,
    ];
    for (const period of migLbPeriods) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.MIG_LEVEL, period, username, scoreXp, false).catch(() => {});
    }
  } catch {
    // non-fatal
  }

  // 4. Send MIGLEVEL_INCREASE_ALERT notification (mirrors UNS notifyFusionUser())
  try {
    await storage.createNotification({
      username,
      type: NOTIFICATION_TYPE.ALERT,
      subject: "miglevel_increase",
      message: `Congratulations! You reached level ${newLevelData.level} (${newLevelData.name ?? ""}). Keep it up!`,
      status: NOTIFICATION_STATUS.PENDING,
    });
  } catch {
    // non-fatal
  }
}

/**
 * Award reputation score for a user action.
 * Mirrors UpdateScoreTable.java real-time variant.
 * Increments the raw metric counter, adds score, updates level in DB,
 * and triggers onLevelChanged() side effects when level increases.
 */
export async function awardReputationScore(
  username: string,
  action: ReputationAction,
  count = 1,
  meta?: { text?: string },
): Promise<AwardResult> {
  const levelTable = await getLevelTable();

  // Min-length filter: chat messages shorter than xpConfig.chatMinLengthForXp
  // earn 0 XP and do NOT increment the chatRoomMessagesSent counter. This
  // prevents farming XP via short messages like "ok", "iya", "ya".
  if (action === "chatRoomMessage" && meta?.text != null) {
    const minLen = getXpConfigSync().chatMinLengthForXp;
    if (minLen > 0 && meta.text.trim().length < minLen) {
      const repNow = await storage.getUserReputation(username);
      const lvlNow = getLevelDataForScoreSync(repNow?.score ?? 0, levelTable);
      return {
        username,
        scoreAdded: 0,
        newScore:   repNow?.score ?? 0,
        oldLevel:   lvlNow?.level ?? 1,
        newLevel:   lvlNow?.level ?? 1,
        leveledUp:  false,
        levelData:  lvlNow ?? null,
      };
    }
  }

  // Anti-flood: chat XP is throttled (gap + per-minute cap). Spammers get 0 XP
  // but the raw metric counter is NOT incremented either, to avoid inflating
  // the daily-batch chatRoomMessagesSent metric via flooding.
  if (action === "chatRoomMessage" && !shouldAwardChatXp(username)) {
    const repNow = await storage.getUserReputation(username);
    const lvlNow = getLevelDataForScoreSync(repNow?.score ?? 0, levelTable);
    return {
      username,
      scoreAdded: 0,
      newScore:   repNow?.score ?? 0,
      oldLevel:   lvlNow?.level ?? 1,
      newLevel:   lvlNow?.level ?? 1,
      leveledUp:  false,
      levelData:  lvlNow ?? null,
    };
  }

  const scoreAdded = getActionScore(action) * count;
  const metricKey  = ACTION_METRIC[action];

  let rep = await storage.getUserReputation(username);
  if (!rep) rep = await storage.createUserReputation(username);

  const oldScore = rep.score;
  const oldLevelData = getLevelDataForScoreSync(oldScore, levelTable);
  const oldLevel = oldLevelData?.level ?? 1;

  // Increment the raw metric counter
  if (metricKey) {
    await storage.updateReputationMetrics(username, { [metricKey]: count });
  }

  // Increment cumulative score (skip if action awards 0 pts like sessionSecond)
  let updated = rep;
  if (scoreAdded > 0) {
    updated = await storage.incrementReputationScore(username, scoreAdded);
  }

  const newLevelData = getLevelDataForScoreSync(updated.score, levelTable);
  const newLevel = newLevelData?.level ?? 1;

  // Update stored level if it changed
  if (newLevel !== oldLevel) {
    await storage.updateReputationLevel(username, newLevel);
    // Fire level-up side effects (mirrors UpdateScoreTable.onLevelChanged)
    await onLevelChanged(username, oldLevelData, newLevelData!);
  }

  // Keep MIG_LEVEL leaderboard in sync with user_reputation.score on every
  // award (not only on level-up). The mobile leaderboard labels this value
  // as "xp", so we store the cumulative reputation score itself — that way
  // the leaderboard ranking and displayed value always match the underlying
  // user_reputation.score column.
  if (scoreAdded > 0) {
    const migLbPeriods = [
      LEADERBOARD_PERIOD.DAILY,
      LEADERBOARD_PERIOD.WEEKLY,
      LEADERBOARD_PERIOD.MONTHLY,
      LEADERBOARD_PERIOD.ALL_TIME,
    ];
    for (const period of migLbPeriods) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.MIG_LEVEL, period, username, updated.score, false).catch(() => {});
    }
  }

  return {
    username,
    scoreAdded,
    newScore:  updated.score,
    oldLevel,
    newLevel,
    leveledUp: newLevel > oldLevel,
    levelData: newLevelData ?? null,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
export function registerReputationRoutes(app: Express) {

  // GET /api/reputation/levels — full level threshold table from DB
  // Mirrors ReputationLevelScoreRanges.java + ReputationScoreToLevel DB table
  app.get("/api/reputation/levels", async (_req, res) => {
    try {
      const levelThresholds = await getLevelTable();
      // Return sorted ascending (lowest first) for UI friendliness
      const sorted = [...levelThresholds].sort((a, b) => a.score - b.score);
      res.json({ levelThresholds: sorted });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reputation/top — leaderboard with level data
  app.get("/api/reputation/top", async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    try {
      const [top, levelTable] = await Promise.all([
        storage.getTopReputationUsers(limit, offset),
        getLevelTable(),
      ]);
      const enriched = top.map(u => ({
        ...u,
        levelName: getLevelDataForScoreSync(u.score, levelTable)?.name ?? "Newbie",
      }));
      res.json({ top: enriched, count: enriched.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reputation/:username — full profile + computed score breakdown + level privileges
  app.get("/api/reputation/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const [levelTable] = await Promise.all([getLevelTable()]);
      let rep = await storage.getUserReputation(username);
      if (!rep) rep = await storage.createUserReputation(username);

      const currentLevelData = getLevelDataForScoreSync(rep.score, levelTable);
      const computedLevel    = currentLevelData?.level ?? 1;

      // Auto-correct stored level if it is out of sync with the score.
      // Silently repairs levels that were never persisted (e.g. XP added directly to DB).
      if (rep.level !== computedLevel) {
        storage.updateReputationLevel(username, computedLevel).catch(() => {});
        // Also sync migLevel in user_profiles
        storage.getUserByUsername(username).then(user => {
          if (user) storage.upsertUserProfile(user.id, { migLevel: computedLevel }).catch(() => {});
        }).catch(() => {});
      }

      // Next level threshold — works for both table levels and formula levels (no cap)
      const maxTableEntry   = levelTable[0]; // highest level in table (sorted DESC)
      let nextLevelAt: number | null = null;
      if (maxTableEntry && rep.score > maxTableEntry.score) {
        // Already above max table level — use formula to compute next threshold
        nextLevelAt = formulaScore(computedLevel + 1);
      } else {
        const nextThreshold = levelTable.slice().sort((a, b) => a.score - b.score)
                                .find(t => t.score > rep!.score);
        nextLevelAt = nextThreshold?.score ?? null;
      }

      const currentMinScore = currentLevelData?.score ?? 0;
      const progressPct     = nextLevelAt
        ? Math.round(((rep.score - currentMinScore) / (nextLevelAt - currentMinScore)) * 100)
        : 100;

      const computedDailyMax = computeScoreFromMetrics(rep);

      res.json({
        ...rep,
        level:            computedLevel,
        levelName:        currentLevelData?.name ?? "Newbie",
        levelPrivileges:  currentLevelData ?? null,
        nextLevelAt,
        progressPct:      Math.max(0, Math.min(100, progressPct)),
        computedDailyMax,
        levelThresholds:  levelTable.slice().sort((a, b) => a.score - b.score),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reputation/:username/level — lightweight level + privileges lookup
  // Mirrors ReputationServiceI.getUserLevel() + getLevelDataForScore()
  app.get("/api/reputation/:username/level", async (req, res) => {
    const { username } = req.params;
    try {
      const [rep, levelTable] = await Promise.all([
        storage.getUserReputation(username),
        getLevelTable(),
      ]);
      const score     = rep?.score ?? 0;
      const levelData = getLevelDataForScoreSync(score, levelTable);
      res.json({
        username,
        score,
        level:      levelData?.level ?? 1,
        levelName:  levelData?.name  ?? "Newbie",
        privileges: levelData ?? null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/award — award points for a user action (real-time)
  // Mirrors UpdateScoreTable.java real-time variant + RewardCentre.sendTrigger()
  // Body: { username, action, count? }
  app.post("/api/reputation/award", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      action:   z.enum(["chatRoomMessage","privateMessage","giftSent","giftReceived",
                        "photoUploaded","referral","phoneCallSecond","sessionSecond"]),
      count:    z.number().int().positive().default(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const result = await awardReputationScore(parsed.data.username, parsed.data.action, parsed.data.count);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/update-score — direct score increment (admin / legacy batch)
  // Mirrors UpdateScoreTable.process() which adds daily score to cumulative
  app.post("/api/reputation/update-score", async (req, res) => {
    const schema = z.object({
      username:       z.string().min(1),
      scoreIncrement: z.number(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, scoreIncrement } = parsed.data;
    try {
      const levelTable  = await getLevelTable();
      const existing    = await storage.getUserReputation(username);
      const oldScore    = existing?.score ?? 0;
      const oldLevelData = getLevelDataForScoreSync(oldScore, levelTable);

      const rep        = await storage.incrementReputationScore(username, scoreIncrement);
      const newLevelData = getLevelDataForScoreSync(rep.score, levelTable);
      const newLevel   = newLevelData?.level ?? 1;
      const oldLevel   = oldLevelData?.level ?? 1;

      if (newLevel !== oldLevel) {
        await storage.updateReputationLevel(username, newLevel);
        await onLevelChanged(username, oldLevelData, newLevelData!);
      }

      res.json({
        success: true, username,
        score: rep.score, level: newLevel,
        levelName: newLevelData?.name ?? "Newbie",
        levelChanged: newLevel !== oldLevel,
        leveledUp: newLevel > oldLevel,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/metrics — raw metric increment
  // Mirrors AccountEntryMetrics, ScoreMetrics, PhoneCallMetrics, VirtualGiftMetrics
  app.post("/api/reputation/metrics", async (req, res) => {
    const schema = z.object({
      username:               z.string().min(1),
      chatRoomMessagesSent:   z.number().int().nonnegative().optional(),
      privateMessagesSent:    z.number().int().nonnegative().optional(),
      totalTime:              z.number().int().nonnegative().optional(),
      photosUploaded:         z.number().int().nonnegative().optional(),
      kicksInitiated:         z.number().int().nonnegative().optional(),
      authenticatedReferrals: z.number().int().nonnegative().optional(),
      rechargedAmount:        z.number().nonnegative().optional(),
      phoneCallDuration:      z.number().int().nonnegative().optional(),
      sessionCount:           z.number().int().nonnegative().optional(),
      virtualGiftsSent:       z.number().int().nonnegative().optional(),
      virtualGiftsReceived:   z.number().int().nonnegative().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, ...metrics } = parsed.data;
    try {
      const rep = await storage.updateReputationMetrics(username, metrics);
      res.json({ success: true, reputation: rep });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/recalculate — recompute level from cumulative score
  // Mirrors UpdateScoreTable behaviour of re-deriving level after score update
  app.post("/api/reputation/recalculate", async (req, res) => {
    const schema = z.object({ username: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username } = parsed.data;
    try {
      const [rep, levelTable] = await Promise.all([
        storage.getUserReputation(username),
        getLevelTable(),
      ]);
      if (!rep) return res.status(404).json({ error: "User reputation not found" });

      const oldLevel    = rep.level;
      const newLevelData = getLevelDataForScoreSync(rep.score, levelTable);
      const newLevel    = newLevelData?.level ?? 1;

      if (newLevel !== oldLevel) {
        await storage.updateReputationLevel(username, newLevel);
        const oldLevelData = getLevelDataForScoreSync(0, levelTable); // level 1
        await onLevelChanged(username, oldLevelData, newLevelData!);
      }

      res.json({
        success: true, username,
        score: rep.score,
        oldLevel, newLevel,
        levelName: newLevelData?.name ?? "Newbie",
        privileges: newLevelData ?? null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/daily-batch — simulate the Java daily batch process
  // Mirrors ReputationServiceI.gatherAndProcess() → ScoreFinalSummary.scoreFile()
  // → UpdateScoreTable.process()
  // Computes a daily score from each user's current metrics, adds it to cumulative
  // score, and re-derives levels.
  app.post("/api/reputation/daily-batch", async (req, res) => {
    try {
      const [allUsers, levelTable] = await Promise.all([
        storage.getTopReputationUsers(10000, 0),
        getLevelTable(),
      ]);

      let processed = 0;
      let levelUps  = 0;

      for (const rep of allUsers) {
        const dailyScore   = computeScoreFromMetrics(rep);
        if (dailyScore === 0) continue;

        const oldLevelData = getLevelDataForScoreSync(rep.score, levelTable);
        const updated      = await storage.incrementReputationScore(rep.username, dailyScore);
        const newLevelData = getLevelDataForScoreSync(updated.score, levelTable);
        const newLevel     = newLevelData?.level ?? 1;
        const oldLevel     = oldLevelData?.level ?? 1;

        if (newLevel !== oldLevel) {
          await storage.updateReputationLevel(rep.username, newLevel);
          await onLevelChanged(rep.username, oldLevelData, newLevelData!);
          levelUps++;
        }
        processed++;
      }

      res.json({ success: true, processed, levelUps, ranAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Level Threshold CRUD (admin) ──────────────────────────────────────────
  // Mirrors the reputationscoretolevel DB table management in the Java admin UI.

  // PUT /api/reputation/levels/:level — create or update a level threshold
  app.put("/api/reputation/levels/:level", async (req, res) => {
    const levelNum = parseInt(req.params.level);
    if (isNaN(levelNum) || levelNum < 1) return res.status(400).json({ error: "Invalid level number" });

    const schema = z.object({
      score:                  z.number().int().nonnegative(),
      name:                   z.string().optional(),
      image:                  z.string().optional().nullable(),
      chatRoomSize:           z.number().int().positive().optional().nullable(),
      groupSize:              z.number().int().positive().optional().nullable(),
      numGroupChatRooms:      z.number().int().nonnegative().optional().nullable(),
      createChatRoom:         z.boolean().optional(),
      createGroup:            z.boolean().optional(),
      publishPhoto:           z.boolean().optional(),
      postCommentLikeUserWall: z.boolean().optional(),
      addToPhotoWall:         z.boolean().optional(),
      enterPot:               z.boolean().optional(),
      numGroupModerators:     z.number().int().nonnegative().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const result = await storage.upsertLevelThreshold({ level: levelNum, ...parsed.data });
      // Invalidate in-memory cache
      cachedLevelTable = [];
      res.json({ success: true, levelThreshold: result });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/reputation/levels/:level — remove a level threshold
  app.delete("/api/reputation/levels/:level", async (req, res) => {
    const levelNum = parseInt(req.params.level);
    if (isNaN(levelNum)) return res.status(400).json({ error: "Invalid level number" });

    try {
      await storage.deleteLevelThreshold(levelNum);
      cachedLevelTable = [];
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

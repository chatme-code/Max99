import type { LevelThreshold } from "@shared/schema";

export const LEVEL_30_TARGET_SCORE = 7000;
export const LEVEL_50_TARGET_SCORE = 25000;

// ── Hard-cap tier breakpoint ────────────────────────────────────────────────
// Levels 1..70 use the original gentle progression untouched.
// From level 71 onwards, the curve becomes significantly steeper so reaching
// the top ranks (Grandmaster → God+) takes meaningfully more XP.
// ALL changes above level 70 — anything <= 70 is byte-identical to before.
export const LEVEL_HARDCAP_START = 70;

// Per-level XP cost for the gentle (≤70) tier, derived from the original
// linear coefficient 1250. We anchor the new tier here so score(70) stays
// exactly the same and there is NO discontinuity at the boundary.
const HARDCAP_LINEAR_COEFF   = 3500;   // ~2.8× the previous +1250 / level
const HARDCAP_QUAD_COEFF     = 80;     // quadratic-ish growth term
const HARDCAP_QUAD_EXPONENT  = 1.8;    // grows much faster than the old 1.35

const LEVEL_NAMES = [
  "Newbie", "Newcomer", "Rookie", "Beginner", "Apprentice",
  "Learner", "Student", "Scholar", "Trainee", "Explorer",
  "Adventurer", "Wanderer", "Voyager", "Seeker", "Discoverer",
  "Initiate", "Participant", "Contributor", "Member", "Regular",
  "Active", "Enthusiast", "Veteran", "Devoted", "Dedicated",
  "Senior", "Experienced", "Skilled", "Proficient", "Advanced",
  "Expert", "Specialist", "Professional", "Authority", "Champion",
  "Master", "Virtuoso", "Elite", "Ace", "Prodigy",
  "Grandmaster", "Legend", "Icon", "Mythic", "Epic",
  "Legendary", "Immortal", "Titan", "Demigod", "God",
];

// Score required for the gentle tier (levels 1..70). Untouched from the
// previous behaviour so existing players' progress and any thresholds <=70
// stay identical.
function gentleTierScore(level: number): number {
  if (level <= 1) return 0;
  if (level <= 30) {
    return Math.round(LEVEL_30_TARGET_SCORE * Math.pow((level - 1) / 29, 1.5));
  }
  if (level <= 50) {
    return Math.round(
      LEVEL_30_TARGET_SCORE +
        (LEVEL_50_TARGET_SCORE - LEVEL_30_TARGET_SCORE) *
          Math.pow((level - 30) / 20, 1.25),
    );
  }
  const extraLevel = level - 50;
  return Math.round(
    LEVEL_50_TARGET_SCORE + 1250 * extraLevel + 20 * Math.pow(extraLevel, 1.35),
  );
}

export function reputationLevelScore(level: number): number {
  if (level <= LEVEL_HARDCAP_START) {
    return gentleTierScore(level);
  }
  // Hard-cap tier (level > 70): anchor on the score at level 70 so the curve
  // is continuous, then add a steeper linear + super-linear term per level.
  const baseAt70    = gentleTierScore(LEVEL_HARDCAP_START);
  const stepsAbove  = level - LEVEL_HARDCAP_START;
  return Math.round(
    baseAt70 +
      HARDCAP_LINEAR_COEFF * stepsAbove +
      HARDCAP_QUAD_COEFF * Math.pow(stepsAbove, HARDCAP_QUAD_EXPONENT),
  );
}

export function reputationFormulaLevelFromScore(score: number): number {
  if (score <= 0) return 1;
  let low = 1;
  let high = 50;
  while (reputationLevelScore(high) <= score) high *= 2;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (reputationLevelScore(mid) <= score) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function buildDefaultReputationLevels(): LevelThreshold[] {
  return Array.from({ length: 50 }, (_, index) => {
    const level = index + 1;
    return {
      level,
      score: reputationLevelScore(level),
      name: LEVEL_NAMES[index] ?? `Level ${level}`,
      image: null,
      chatRoomSize: level === 1 ? null : Math.min(100, 3 + level * 2),
      groupSize: level < 5 ? null : level <= 30 ? 5 + (level - 5) * 4 : 90 + (level - 30) * 6,
      numGroupChatRooms: level < 5 ? null : Math.min(10, Math.max(1, Math.floor(level / 4))),
      createChatRoom: level >= 3,
      createGroup: level >= 5,
      publishPhoto: level >= 2,
      postCommentLikeUserWall: level >= 2,
      addToPhotoWall: level >= 4,
      enterPot: level >= 10,
      numGroupModerators: level < 5 ? 0 : Math.min(10, Math.floor(level / 5)),
    };
  }).sort((a, b) => b.score - a.score);
}
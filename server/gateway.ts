import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { log } from "./logger";
import { storage } from "./storage";
import { checkAccess } from "./middleware/accessControl";
import { getRedisClient, getOfflineMessages, clearOfflineMessages, invalidatePartyLeaderboard } from "./redis";
import { verifyJwt } from "./middleware/jwtAuth";
import { db } from "./db";
import { recordMessage as floodCheck, clearUserFloodState } from "./floodGuard";
import { checkMessageContent, reasonToMessage } from "./contentGuard";
import { friendships, contactRequests, userProfiles, LEADERBOARD_TYPE, LEADERBOARD_PERIOD, CREDIT_TRANSACTION_TYPE, NOTIFICATION_TYPE, NOTIFICATION_STATUS } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import type { ChatParticipant } from "@shared/schema";

// All four periods so Today / This Week / This Month / All Time tabs in the
// mobile leaderboard all populate from WS gift paths.
const GW_LB_PERIODS = [
  LEADERBOARD_PERIOD.DAILY,
  LEADERBOARD_PERIOD.WEEKLY,
  LEADERBOARD_PERIOD.MONTHLY,
  LEADERBOARD_PERIOD.ALL_TIME,
];

function recordGiftLeaderboardGW(senderUsername: string, recipientUsernames: string[], count = 1, coinAmount = 0) {
  const coinPerRecip = coinAmount > 0 ? Math.round(coinAmount / Math.max(1, recipientUsernames.length)) : 0;
  for (const period of GW_LB_PERIODS) {
    storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_SENT, period, senderUsername, count, true).catch(() => {});
    for (const r of recipientUsernames) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_RECEIVED, period, r, 1, true).catch(() => {});
    }
    if (coinAmount > 0) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_SENT, period, senderUsername, coinAmount, true).catch(() => {});
      for (const r of recipientUsernames) {
        storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_RECEIVED, period, r, coinPerRecip, true).catch(() => {});
      }
    }
  }
  // Invalidate party leaderboard cache saat ada gift masuk
  if (coinAmount > 0) {
    invalidatePartyLeaderboard().catch(() => {});
  }
}

// Party-specific leaderboard — terpisah total dari classic chatroom leaderboard
// Hanya dipanggil saat SEND_GIFT di party room.
// PARTY_GIFT_SENT     = total koin yang dikeluarkan pengirim gift di party room
// PARTY_GIFT_RECEIVED = coin per penerima (100% coin, bukan diamond) — sinkron dengan seat_coins di UI
function recordPartyGiftLeaderboardGW(
  senderUsername: string,
  recipientUsernames: string[],
  senderCoinAmount: number,
  _diamondPerRecipient: number,
) {
  // Coin per penerima = total coin / jumlah penerima
  const coinPerRecipient = Math.round(senderCoinAmount / Math.max(1, recipientUsernames.length));
  for (const period of GW_LB_PERIODS) {
    storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_SENT, period, senderUsername, senderCoinAmount, true).catch(() => {});
    for (const r of recipientUsernames) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_RECEIVED, period, r, coinPerRecipient, true).catch(() => {});
    }
  }
  // Invalidate party leaderboard cache setiap ada party gift dikirim
  invalidatePartyLeaderboard().catch(() => {});
}
import { processMessage as botProcessMessage, notifyUserJoin as botNotifyJoin, notifyUserLeave as botNotifyLeave, startBot as botStartBot, stopBot as botStopBot, getBot as botGetBot } from "./modules/botservice/botService";
import { isRegisteredGame, getRegisteredGames } from "./modules/botservice/BotLoader";
import { awardReputationScore } from "./modules/reputation/routes";
import { coinToDiamond, luxuryCoinToDiamond } from "./config/currency";

// ── Agency Host Check ─────────────────────────────────────────────────────────
// Returns true when username is an active host OR an approved agency owner.
// Diamonds from gifts are credited to both active hosts and agency owners.
async function isActiveAgencyHost(username: string): Promise<boolean> {
  try {
    // Cek sebagai active host
    const hostResult = await db.execute(sql`
      SELECT 1 FROM agency_hosts
      WHERE LOWER(username) = LOWER(${username})
        AND status = 'active'
      LIMIT 1
    `);
    if (hostResult.rows.length > 0) return true;
    // Cek sebagai owner agency yang approved
    const ownerResult = await db.execute(sql`
      SELECT 1 FROM agencies
      WHERE LOWER(registered_by) = LOWER(${username})
        AND status = 'approved'
      LIMIT 1
    `);
    return ownerResult.rows.length > 0;
  } catch {
    return false;
  }
}

// Cache agency name per username — TTL 5 minutes.
const _agencyNameCache = new Map<string, { name: string | null; exp: number }>();

async function getAgencyNameForUser(username: string): Promise<string | null> {
  const now = Date.now();
  const cached = _agencyNameCache.get(username.toLowerCase());
  if (cached && cached.exp > now) return cached.name;
  try {
    const hostRow = await db.execute(sql`
      SELECT a.agency_name
      FROM agency_hosts ah
      JOIN agencies a ON a.id = ah.agency_id
      WHERE LOWER(ah.username) = LOWER(${username})
        AND ah.status = 'active'
        AND a.status = 'approved'
      LIMIT 1
    `);
    if (hostRow.rows.length > 0) {
      const name = String((hostRow.rows[0] as any).agency_name);
      _agencyNameCache.set(username.toLowerCase(), { name, exp: now + 5 * 60 * 1000 });
      return name;
    }
    const ownerRow = await db.execute(sql`
      SELECT agency_name FROM agencies
      WHERE LOWER(registered_by) = LOWER(${username})
        AND status = 'approved'
      LIMIT 1
    `);
    if (ownerRow.rows.length > 0) {
      const name = String((ownerRow.rows[0] as any).agency_name);
      _agencyNameCache.set(username.toLowerCase(), { name, exp: now + 5 * 60 * 1000 });
      return name;
    }
    _agencyNameCache.set(username.toLowerCase(), { name: null, exp: now + 5 * 60 * 1000 });
    return null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LUCKY GIFT JACKPOT — Pool-based Instant (Opsi C)
//
// Reward keluar LANGSUNG saat user tap gift (tidak ada timer / delay).
// Pool/threshold tetap dipakai untuk menjaga house margin.
//
// ── TIER GLOBAL X1 ───────────────────────────────────────────────────────────
//   Threshold  : 1.000.000 coin global
//   Reward     : 50.000 coin × 10 pemenang (semua dibayar sekaligus saat tap)
//   House margin: 500.000 / 1.000.000 = 50% ✅
//
// ── TIER PER-ROOM 500 Times ──────────────────────────────────────────────────
//   Threshold  : 50.000.000 coin per room
//   Semua 4 tier dibayar SEKALIGUS saat tap yang menyeberangi threshold:
//     X3   → 150.000 coin   (reward ≥ 50K → broadcast global)
//     X9   → 450.000 coin   (reward ≥ 50K → broadcast global)
//     X99  → 4.500.000 coin (reward ≥ 50K → broadcast global)
//     X199 → 9.400.000 coin (reward ≥ 50K → broadcast global)
//   House margin: 14.500.000 / 50.000.000 = 71% ✅
//
// ── TIER PER-ROOM 50 Times ───────────────────────────────────────────────────
//   Threshold  : 350.000 coin per room
//   50X_X1   →   2.000 coin  (hanya broadcast ke room, < 50K)
//   50X_X3   →   4.000 coin  (hanya broadcast ke room, < 50K)
//   50X_X9   →   9.000 coin  (hanya broadcast ke room, < 50K)
//   50X_X99  →  13.000 coin  (hanya broadcast ke room, < 50K)
//   50X_X199 → 160.000 coin  (reward ≥ 50K → broadcast global)
//   House margin: 188.000 / 350.000 = 46% ✅
//
// ── TIER PER-ROOM 100 Times ──────────────────────────────────────────────────
//   Threshold  : 1.800.000 coin per room
//   100X_X1   →   10.000 coin (hanya broadcast ke room, < 50K)
//   100X_X3   →   15.000 coin (hanya broadcast ke room, < 50K)
//   100X_X9   →   45.000 coin (hanya broadcast ke room, < 50K)
//   100X_X99  →  450.000 coin (reward ≥ 50K → broadcast global)
//   100X_X199 →  450.000 coin (reward ≥ 50K → broadcast global)
//   House margin: 970.000 / 1.800.000 = 46% ✅
//
// TIDAK ADA setTimeout/setInterval JP — semua instant saat tap.
// Race condition dicegah dengan in-memory processing guard per room.
// ══════════════════════════════════════════════════════════════════════════════

// ── GLOBAL X1 config ─────────────────────────────────────────────────────────
const JP_GLOBAL_THRESHOLD   = 1_000_000;
const JP_GLOBAL_REWARD      = 50_000;
const JP_GLOBAL_WINNERS     = 10;
const JP_GLOBAL_COOLDOWN    = 30 * 60 * 1000; // 30 menit cooldown antar trigger

// ── PER-ROOM X3-X199 config (500 Times) ──────────────────────────────────────
const JP_ROOM_THRESHOLD = 50_000_000;

interface RoomJpTier {
  key:    string;
  label:  string;
  emoji:  string;
  reward: number;
}
const JP_ROOM_TIERS: RoomJpTier[] = [
  { key: 'X3',   label: '500x X3',   emoji: '🥉', reward:   150_000 },
  { key: 'X9',   label: '500x X9',   emoji: '🥈', reward:   450_000 },
  { key: 'X99',  label: '500x X99',  emoji: '🥇', reward: 4_500_000 },
  { key: 'X199', label: '500x X199', emoji: '👑', reward: 9_400_000 },
];

// ── PER-ROOM config 50 Times ──────────────────────────────────────────────────
const JP_ROOM_50X_THRESHOLD = 350_000;
const JP_ROOM_50X_TIERS: RoomJpTier[] = [
  { key: '50X_X1',   label: '50x X1',   emoji: '🎁', reward:   2_000 },
  { key: '50X_X3',   label: '50x X3',   emoji: '🥉', reward:   4_000 },
  { key: '50X_X9',   label: '50x X9',   emoji: '🥈', reward:   9_000 },
  { key: '50X_X99',  label: '50x X99',  emoji: '🥇', reward:  13_000 },
  { key: '50X_X199', label: '50x X199', emoji: '👑', reward: 160_000 },
];

// ── PER-ROOM config 100 Times ─────────────────────────────────────────────────
const JP_ROOM_100X_THRESHOLD = 1_800_000;
const JP_ROOM_100X_TIERS: RoomJpTier[] = [
  { key: '100X_X1',   label: '100x X1',   emoji: '🎁', reward:   10_000 },
  { key: '100X_X3',   label: '100x X3',   emoji: '🥉', reward:   15_000 },
  { key: '100X_X9',   label: '100x X9',   emoji: '🥈', reward:   45_000 },
  { key: '100X_X99',  label: '100x X99',  emoji: '🥇', reward:  450_000 },
  { key: '100X_X199', label: '100x X199', emoji: '👑', reward:  450_000 },
];

// Reward minimum untuk broadcast global (ke semua room)
const JP_GLOBAL_BROADCAST_MIN_REWARD = 50_000;

// ── In-memory processing guards (mencegah race condition double-trigger) ──────
let jp1GlobalLastTriggeredAt = 0;
let jp1GlobalProcessing      = false;

const jpRoomProcessing    = new Map<string, boolean>();
const jpRoom50xProcessing = new Map<string, boolean>();
const jpRoom100xProcessing= new Map<string, boolean>();

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcastLuckyJpGlobal(event: Record<string, unknown>): void {
  let count = 0;
  clients.forEach((client) => {
    if (client.state === 'AUTHENTICATED') {
      send(client.ws, event as any);
      count++;
    }
  });
  log(`[JP] Broadcast LUCKY_JACKPOT_GLOBAL ke ${count} client`, 'gateway');
}

// ── Random picker ─────────────────────────────────────────────────────────────
function pickRandom(pool: string[], n: number): string[] {
  if (!pool.length) return [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ── Pay a single winner (coin credit + notification) ─────────────────────────
async function payJpWinner(
  username: string,
  reward: number,
  label: string,
  emoji: string,
  reference: string,
): Promise<void> {
  await storage.adjustBalance(username, reward).catch(() => {});
  await storage.createCreditTransaction({
    username,
    type:         CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
    reference,
    description:  `${emoji} ${label} — menang ${reward.toLocaleString()} koin dari Lucky Gift Jackpot!`,
    currency:     'IDR',
    amount:       reward,
    fundedAmount: reward,
    tax:          0,
    runningBalance: 0,
  }).catch(() => {});
  storage.createNotification({
    username,
    type:    'ALERT',
    subject: `${emoji} ${label}!`,
    message: `Selamat! Kamu menang ${label} dan mendapat ${reward.toLocaleString()} koin dari Lucky Gift Jackpot!`,
    status:  1,
  }).catch(() => {});
}

// ── Broadcast helper: global ke semua room jika reward ≥ 50K, else hanya ke room ─
// NOTE: broadcastToRoom didefinisikan di bawah (line ~1460) — TypeScript hoisting OK.
function broadcastJpEvent(
  roomId: string,
  tier: RoomJpTier,
  winner: string,
  siklusId: number,
): void {
  const isGlobalBroadcast = tier.reward >= JP_GLOBAL_BROADCAST_MIN_REWARD;
  const event: any = {
    type:              'LUCKY_JACKPOT_GLOBAL' as const,
    milestone:         tier.key,
    label:             tier.label,
    emoji:             tier.emoji,
    winners:           [winner],
    reward:            tier.reward,
    roomId,
    siklusId,
    isGlobalBroadcast, // true = terbang ke semua room, false = hanya room ini
  };
  if (isGlobalBroadcast) {
    broadcastLuckyJpGlobal(event);
  } else {
    // broadcastToRoom hoisted — defined later in the file
    (broadcastToRoom as (roomId: string, event: any) => void)(roomId, event);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GLOBAL X1 — Pool-based Instant Processor
// Dipanggil setiap ada gift Lucky masuk — LANGSUNG bayar semua pemenang saat tap.
// ════════════════════════════════════════════════════════════════════════════
async function processGlobalX1JP(
  roomId: string,
  senderUsername: string,
  qty: number,
  coinAdded: number,
): Promise<void> {
  if (jp1GlobalProcessing) return;
  try {
    const cntRes = await db.execute(sql`
      UPDATE lucky_jp2_counter
      SET total_coin      = total_coin + ${coinAdded},
          cumulative_coin = cumulative_coin + ${coinAdded},
          updated_at      = NOW()
      WHERE id = 1
      RETURNING total_coin, cumulative_coin, siklus_id
    `);
    if (!cntRes.rows.length) return;

    const newCoin  = Number((cntRes.rows[0] as any).total_coin);
    const oldCoin  = newCoin - coinAdded;
    const siklusId = Number((cntRes.rows[0] as any).siklus_id);

    await db.execute(sql`
      INSERT INTO lucky_jp2_participants (username, total_gift_sent, last_gift_at, siklus_id)
      VALUES (${senderUsername}, ${qty}, NOW(), ${siklusId})
      ON CONFLICT (username, siklus_id) DO UPDATE
        SET total_gift_sent = lucky_jp2_participants.total_gift_sent + ${qty},
            last_gift_at    = NOW()
    `);

    const crossed = Math.floor(newCoin / JP_GLOBAL_THRESHOLD) > Math.floor(oldCoin / JP_GLOBAL_THRESHOLD);
    if (!crossed) return;

    const now = Date.now();
    if (now - jp1GlobalLastTriggeredAt < JP_GLOBAL_COOLDOWN) {
      const remainSec = Math.ceil((JP_GLOBAL_COOLDOWN - (now - jp1GlobalLastTriggeredAt)) / 1000);
      log(`[JP1] Global X1 skip — cooldown ${remainSec}s lagi`, 'gateway');
      return;
    }

    jp1GlobalProcessing = true;
    jp1GlobalLastTriggeredAt = now;

    const partRows = await db.execute(sql`
      SELECT username FROM lucky_jp2_participants WHERE siklus_id = ${siklusId}
    `);
    const pool = (partRows.rows as any[]).map(r => r.username as string);
    if (!pool.length) {
      log(`[JP1] Global X1 skip — tidak ada peserta`, 'gateway');
      jp1GlobalProcessing = false;
      return;
    }

    const winners = pickRandom(pool, JP_GLOBAL_WINNERS);
    log(`[JP1] Global X1 INSTANT! counter=${newCoin} siklus=${siklusId} winners=[${winners.join(',')}]`, 'gateway');

    await db.execute(sql`
      INSERT INTO lucky_jp2_milestone_log (milestone, triggered_at, total_coin_saat_trigger, jumlah_pemenang, siklus_id)
      VALUES ('X1_500', NOW(), ${newCoin}, ${winners.length}, ${siklusId})
    `).catch(() => {});

    // Reset counter DULU sebelum bayar (cegah double trigger)
    await db.execute(sql`
      UPDATE lucky_jp2_counter
      SET total_coin = 0,
          siklus_id  = siklus_id + 1,
          last_reset = NOW(),
          updated_at = NOW()
      WHERE id = 1
    `);
    log(`[JP1] Counter global di-reset. Siklus baru = ${siklusId + 1}`, 'gateway');

    // Bayar & broadcast semua pemenang SEKALIGUS (instant)
    for (let i = 0; i < winners.length; i++) {
      const winner = winners[i];
      const ref = `JP1-X1-${siklusId}-${winner}-${Date.now()}-${i}`;
      await payJpWinner(winner, JP_GLOBAL_REWARD, '500x Times X1', '🎊', ref).catch(() => {});
      await db.execute(sql`
        INSERT INTO lucky_jp2_winners (username, milestone, coin_reward, won_at, siklus_id)
        VALUES (${winner}, 'X1_500', ${JP_GLOBAL_REWARD}, NOW(), ${siklusId})
      `).catch(() => {});
      broadcastLuckyJpGlobal({
        type:       'LUCKY_JACKPOT_GLOBAL',
        milestone:  'X1_500',
        label:      '500x Times X1',
        emoji:      '🎊',
        winners:    [winner],
        reward:     JP_GLOBAL_REWARD,
        queueIdx:   i + 1,
        queueTotal: winners.length,
        siklusId,
        roomId,
      });
      log(`[JP1] Instant payout ${i + 1}/${winners.length} ke ${winner} — ${JP_GLOBAL_REWARD} coin`, 'gateway');
    }

  } catch (err) {
    console.error('[JP1] processGlobalX1JP error:', err);
  } finally {
    jp1GlobalProcessing = false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PER-ROOM X3/X9/X99/X199 — Pool-based Instant Processor (500 Times)
// ════════════════════════════════════════════════════════════════════════════
async function processRoomJP(
  roomId: string,
  senderUsername: string,
  qty: number,
  coinAdded: number,
): Promise<void> {
  if (jpRoomProcessing.get(roomId)) return;
  try {
    const cntRes = await db.execute(sql`
      INSERT INTO lucky_room_counter (room_id, total_coin, siklus_id, updated_at)
      VALUES (${roomId}, ${coinAdded}, 1, NOW())
      ON CONFLICT (room_id) DO UPDATE
        SET total_coin = lucky_room_counter.total_coin + ${coinAdded},
            updated_at = NOW()
      RETURNING total_coin, siklus_id
    `);
    if (!cntRes.rows.length) return;

    const newCoin  = Number((cntRes.rows[0] as any).total_coin);
    const oldCoin  = newCoin - coinAdded;
    const siklusId = Number((cntRes.rows[0] as any).siklus_id);

    await db.execute(sql`
      INSERT INTO lucky_room_participants (room_id, username, total_gift_sent, last_gift_at, siklus_id)
      VALUES (${roomId}, ${senderUsername}, ${coinAdded}, NOW(), ${siklusId})
      ON CONFLICT (room_id, username, siklus_id) DO UPDATE
        SET total_gift_sent = lucky_room_participants.total_gift_sent + ${coinAdded},
            last_gift_at    = NOW()
    `);

    const crossed = Math.floor(newCoin / JP_ROOM_THRESHOLD) > Math.floor(oldCoin / JP_ROOM_THRESHOLD);
    if (!crossed) return;

    jpRoomProcessing.set(roomId, true);
    log(`[JPR] Room ${roomId} INSTANT! counter=${newCoin} siklus=${siklusId}`, 'gateway');

    await db.execute(sql`
      INSERT INTO lucky_jp2_milestone_log (milestone, triggered_at, total_coin_saat_trigger, jumlah_pemenang, siklus_id)
      VALUES (${`ROOM_50M_${roomId.slice(-6)}`}, NOW(), ${newCoin}, 4, ${siklusId})
    `).catch(() => {});

    // Reset counter DULU sebelum bayar
    await db.execute(sql`
      UPDATE lucky_room_counter
      SET total_coin = 0, siklus_id = siklus_id + 1, updated_at = NOW()
      WHERE room_id = ${roomId}
    `);

    const partRows = await db.execute(sql`
      SELECT username FROM lucky_room_participants
      WHERE room_id = ${roomId} AND siklus_id = ${siklusId}
    `);
    const pool = (partRows.rows as any[]).map(r => r.username as string);
    if (!pool.length) {
      log(`[JPR] Room ${roomId} skip — tidak ada peserta`, 'gateway');
      return;
    }

    // Bayar semua tier SEKALIGUS (instant)
    for (const tier of JP_ROOM_TIERS) {
      const [winner] = pickRandom(pool, 1);
      if (!winner) continue;
      const ref = `JPR-${tier.key}-${roomId.slice(-6)}-${siklusId}-${Date.now()}`;
      await payJpWinner(winner, tier.reward, tier.label, tier.emoji, ref).catch(() => {});
      await db.execute(sql`
        INSERT INTO lucky_jp2_winners (username, milestone, coin_reward, won_at, siklus_id)
        VALUES (${winner}, ${tier.key}, ${tier.reward}, NOW(), ${siklusId})
      `).catch(() => {});
      broadcastJpEvent(roomId, tier, winner, siklusId);
      log(`[JPR] Room ${roomId} — ${tier.label} → ${winner} (${tier.reward.toLocaleString()} coin) INSTANT`, 'gateway');
    }

  } catch (err) {
    console.error('[JPR] processRoomJP error:', err);
  } finally {
    jpRoomProcessing.delete(roomId);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PER-ROOM 50x — Pool-based Instant Processor
// ════════════════════════════════════════════════════════════════════════════
async function processRoom50xJP(
  roomId: string,
  senderUsername: string,
  qty: number,
  coinAdded: number,
): Promise<void> {
  if (jpRoom50xProcessing.get(roomId)) return;
  try {
    const cntRes = await db.execute(sql`
      INSERT INTO lucky_room_counter_50x (room_id, total_coin, siklus_id, updated_at)
      VALUES (${roomId}, ${coinAdded}, 1, NOW())
      ON CONFLICT (room_id) DO UPDATE
        SET total_coin = lucky_room_counter_50x.total_coin + ${coinAdded},
            updated_at = NOW()
      RETURNING total_coin, siklus_id
    `);
    if (!cntRes.rows.length) return;

    const newCoin  = Number((cntRes.rows[0] as any).total_coin);
    const oldCoin  = newCoin - coinAdded;
    const siklusId = Number((cntRes.rows[0] as any).siklus_id);

    await db.execute(sql`
      INSERT INTO lucky_room_participants_50x (room_id, username, total_gift_sent, last_gift_at, siklus_id)
      VALUES (${roomId}, ${senderUsername}, ${coinAdded}, NOW(), ${siklusId})
      ON CONFLICT (room_id, username, siklus_id) DO UPDATE
        SET total_gift_sent = lucky_room_participants_50x.total_gift_sent + ${coinAdded},
            last_gift_at    = NOW()
    `);

    const crossed = Math.floor(newCoin / JP_ROOM_50X_THRESHOLD) > Math.floor(oldCoin / JP_ROOM_50X_THRESHOLD);
    if (!crossed) return;

    jpRoom50xProcessing.set(roomId, true);
    log(`[JP50x] Room ${roomId} INSTANT! counter=${newCoin} siklus=${siklusId}`, 'gateway');

    await db.execute(sql`
      INSERT INTO lucky_jp2_milestone_log (milestone, triggered_at, total_coin_saat_trigger, jumlah_pemenang, siklus_id)
      VALUES (${`R50X_${roomId.slice(-6)}`}, NOW(), ${newCoin}, 5, ${siklusId})
    `).catch(() => {});

    // Reset counter DULU sebelum bayar
    await db.execute(sql`
      UPDATE lucky_room_counter_50x
      SET total_coin = 0, siklus_id = siklus_id + 1, updated_at = NOW()
      WHERE room_id = ${roomId}
    `);

    const partRows = await db.execute(sql`
      SELECT username FROM lucky_room_participants_50x
      WHERE room_id = ${roomId} AND siklus_id = ${siklusId}
    `);
    const pool = (partRows.rows as any[]).map(r => r.username as string);
    if (!pool.length) return;

    // Bayar semua tier SEKALIGUS (instant)
    for (const tier of JP_ROOM_50X_TIERS) {
      const [winner] = pickRandom(pool, 1);
      if (!winner) continue;
      const ref = `JP50X-${tier.key}-${roomId.slice(-6)}-${siklusId}-${Date.now()}`;
      await payJpWinner(winner, tier.reward, tier.label, tier.emoji, ref).catch(() => {});
      await db.execute(sql`
        INSERT INTO lucky_jp2_winners (username, milestone, coin_reward, won_at, siklus_id)
        VALUES (${winner}, ${tier.key}, ${tier.reward}, NOW(), ${siklusId})
      `).catch(() => {});
      broadcastJpEvent(roomId, tier, winner, siklusId);
      log(`[JP50x] Room ${roomId} — ${tier.label} → ${winner} (${tier.reward.toLocaleString()} coin) INSTANT`, 'gateway');
    }

  } catch (err) {
    console.error('[JP50x] processRoom50xJP error:', err);
  } finally {
    jpRoom50xProcessing.delete(roomId);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PER-ROOM 100x — Pool-based Instant Processor
// ════════════════════════════════════════════════════════════════════════════
async function processRoom100xJP(
  roomId: string,
  senderUsername: string,
  qty: number,
  coinAdded: number,
): Promise<void> {
  if (jpRoom100xProcessing.get(roomId)) return;
  try {
    const cntRes = await db.execute(sql`
      INSERT INTO lucky_room_counter_100x (room_id, total_coin, siklus_id, updated_at)
      VALUES (${roomId}, ${coinAdded}, 1, NOW())
      ON CONFLICT (room_id) DO UPDATE
        SET total_coin = lucky_room_counter_100x.total_coin + ${coinAdded},
            updated_at = NOW()
      RETURNING total_coin, siklus_id
    `);
    if (!cntRes.rows.length) return;

    const newCoin  = Number((cntRes.rows[0] as any).total_coin);
    const oldCoin  = newCoin - coinAdded;
    const siklusId = Number((cntRes.rows[0] as any).siklus_id);

    await db.execute(sql`
      INSERT INTO lucky_room_participants_100x (room_id, username, total_gift_sent, last_gift_at, siklus_id)
      VALUES (${roomId}, ${senderUsername}, ${coinAdded}, NOW(), ${siklusId})
      ON CONFLICT (room_id, username, siklus_id) DO UPDATE
        SET total_gift_sent = lucky_room_participants_100x.total_gift_sent + ${coinAdded},
            last_gift_at    = NOW()
    `);

    const crossed = Math.floor(newCoin / JP_ROOM_100X_THRESHOLD) > Math.floor(oldCoin / JP_ROOM_100X_THRESHOLD);
    if (!crossed) return;

    jpRoom100xProcessing.set(roomId, true);
    log(`[JP100x] Room ${roomId} INSTANT! counter=${newCoin} siklus=${siklusId}`, 'gateway');

    await db.execute(sql`
      INSERT INTO lucky_jp2_milestone_log (milestone, triggered_at, total_coin_saat_trigger, jumlah_pemenang, siklus_id)
      VALUES (${`R100X_${roomId.slice(-6)}`}, NOW(), ${newCoin}, 5, ${siklusId})
    `).catch(() => {});

    // Reset counter DULU sebelum bayar
    await db.execute(sql`
      UPDATE lucky_room_counter_100x
      SET total_coin = 0, siklus_id = siklus_id + 1, updated_at = NOW()
      WHERE room_id = ${roomId}
    `);

    const partRows = await db.execute(sql`
      SELECT username FROM lucky_room_participants_100x
      WHERE room_id = ${roomId} AND siklus_id = ${siklusId}
    `);
    const pool = (partRows.rows as any[]).map(r => r.username as string);
    if (!pool.length) return;

    // Bayar semua tier SEKALIGUS (instant)
    for (const tier of JP_ROOM_100X_TIERS) {
      const [winner] = pickRandom(pool, 1);
      if (!winner) continue;
      const ref = `JP100X-${tier.key}-${roomId.slice(-6)}-${siklusId}-${Date.now()}`;
      await payJpWinner(winner, tier.reward, tier.label, tier.emoji, ref).catch(() => {});
      await db.execute(sql`
        INSERT INTO lucky_jp2_winners (username, milestone, coin_reward, won_at, siklus_id)
        VALUES (${winner}, ${tier.key}, ${tier.reward}, NOW(), ${siklusId})
      `).catch(() => {});
      broadcastJpEvent(roomId, tier, winner, siklusId);
      log(`[JP100x] Room ${roomId} — ${tier.label} → ${winner} (${tier.reward.toLocaleString()} coin) INSTANT`, 'gateway');
    }

  } catch (err) {
    console.error('[JP100x] processRoom100xJP error:', err);
  } finally {
    jpRoom100xProcessing.delete(roomId);
  }
}


// ════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY — dipanggil dari SEND_GIFT handler
// ════════════════════════════════════════════════════════════════════════════
async function processLuckyGiftJP(
  roomId: string,
  senderUsername: string,
  qty: number,
  giftPrice: number,
  giftEmoji: string,
  giftName: string,
) {
  const coinPerGift = giftPrice > 0 ? giftPrice : 100;
  const coinAdded   = qty * coinPerGift;

  await Promise.all([
    processGlobalX1JP(roomId, senderUsername, qty, coinAdded),
    processRoomJP(roomId, senderUsername, qty, coinAdded),
    processRoom50xJP(roomId, senderUsername, qty, coinAdded),
    processRoom100xJP(roomId, senderUsername, qty, coinAdded),
  ]).catch(err => console.error('[JP] processLuckyGiftJP error:', err));
}

export const GATEWAY_WS_PATH = "/gateway";

// Matches Gateway.ServerType in backend app
export type ServerType = "HTTP" | "TCP" | "WS";

// Matches FusionPktError.Code in backend app
export const ErrorCode = {
  UNDEFINED:            1,
  INCORRECT_CREDENTIAL: 3,
  INVALID_VERSION:      100,
  UNSUPPORTED_PROTOCOL: 101,
} as const;

// Matches ConnectionI lifecycle in backend app
type ConnectionState = "CONNECTING" | "AUTHENTICATED" | "DISCONNECTED";

interface GatewayClient {
  ws: WebSocket;
  sessionId: string;           // UUID per connection — matches ConnectionI.sessionID
  userId?: string;
  username?: string;
  subscribedRooms: Set<string>;
  state: ConnectionState;
  serverType: ServerType;
  connectedAt: number;
  lastActivity: number;
  migLevel: number;
  isChatroomAdmin: boolean;
  // Set to true when client sends SET_BACKGROUND (app minimised).
  // On disconnect the server uses a much longer grace period so the user stays
  // in the room while the OS suspends the connection — mirrors the Java
  // FusionService foreground-service behaviour that kept the socket alive.
  isBackground: boolean;
  // Per-room join timestamps — used for FAST_EXIT_SILENCE_MS check (mirrors
  // Java ChatRoom EXIT_SILENCE_TIME_IN_MS: suppress "has left" for quick visits).
  joinedRooms: Map<string, number>;  // roomId → joinedAt (ms)
  // User-selected chat color (matches TEXT_COLOR palette, packet 924). Default: blue "2196F3"
  chatColor: string;
  /**
   * Role-based color override — mirrors ChatRoomParticipant.getMessageSourceColorOverride().
   * Set on SUBSCRIBE per room (keyed by roomId). When present, this overrides chatColor
   * for that room so the username appears with the correct role color.
   * Sourced from com/projectgoth/fusion MessageData.SourceTypeEnum:
   *   GLOBAL_ADMIN     → F47422 (orange)
   *   MODERATOR_USER   → FCC504 (golden yellow)
   *   GROUP_ADMIN_USER → FCC504 (golden yellow)  [owner/group-admin]
   *   TOP_MERCHANT     → 990099/FF2EA7/FF0000     [merchant/mentor]
   */
  roleColors: Map<string, string>;  // roomId → hex color (no #)
  // Rate limiting — matches PacketProcessor flood control
  packetCount: number;
  packetWindowStart: number;
  eventsDispatched: number;
  displayPicture: string | null;
  displayName: string | null;
}

const clients = new Map<WebSocket, GatewayClient>();

// ─── Room-indexed client map (mirrors Java ChatRoom participant map) ───────────
// O(1) lookup: broadcastToRoom scans only sockets in the target room instead of
// iterating ALL connected clients.  Java equivalent: ChatRoom.participants (Map).
const roomClients = new Map<string, Set<WebSocket>>();

// ─── In-memory muted-user cache (mirrors Java ChatRoom.mutedParticipants) ─────
// Avoids a DB query on every SEND_MESSAGE.  Authoritative source is still the DB;
// this cache is populated on SUBSCRIBE and invalidated on every mute/unmute/silence.
// key: roomId  →  Set of userId strings that are currently muted in that room.
const mutedCache = new Map<string, Set<string>>();

// helpers ---
function roomClientsAdd(roomId: string, ws: WebSocket): void {
  let s = roomClients.get(roomId);
  if (!s) { s = new Set(); roomClients.set(roomId, s); }
  s.add(ws);
}
function roomClientsRemove(roomId: string, ws: WebSocket): void {
  const s = roomClients.get(roomId);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) roomClients.delete(roomId);
}
function mutedCacheAdd(roomId: string, userId: string): void {
  let s = mutedCache.get(roomId);
  if (!s) { s = new Set(); mutedCache.set(roomId, s); }
  s.add(userId);
}
function mutedCacheRemove(roomId: string, userId: string): void {
  mutedCache.get(roomId)?.delete(userId);
}
function isMutedCached(roomId: string, userId: string): boolean {
  return mutedCache.get(roomId)?.has(userId) ?? false;
}

// Matches PacketProcessor rate limiting config in backend app
const RATE_LIMIT_MAX_PACKETS = 30;
const RATE_LIMIT_WINDOW_MS   = 10_000;
const KEEP_ALIVE_TIMEOUT_MS  = 120_000;
const PURGE_INTERVAL_MS      = 30_000;
const APP_VERSION            = "9.0.0";

// ─── Disconnect grace period ──────────────────────────────────────────────────
// When WS closes (network blip, reconnect, app background), we wait this long
// before broadcasting "has left" and removing from DB.  If the same user
// re-SUBSCRIBEs within the window the timer is cancelled and no leave/enter
// messages are emitted — exactly as the original Java gateway behaved.
//
// Java equivalent: the Android client kept a persistent TCP socket inside a
// background Service (NetworkService), so the connection never dropped during
// normal in-app navigation.  We replicate this by using a generous grace window:
// 120 s covers brief network blips, app-backgrounding, and switching between
// menus — giving the client plenty of time to reconnect silently.
const LEAVE_GRACE_MS = 120_000;  // 2 minutes — covers network blips & fast task-switch

// When the client sends SET_BACKGROUND (app minimised by user), the OS may
// suspend or kill the WebSocket at any time.  We use a much longer window so
// the user stays in the room while the app is in the background — mirroring
// the Java FusionService foreground-service that kept the socket alive.
// 8 hours covers "berjam-jam" (many hours) use cases where the OS kills the
// socket but the user expects to silently re-enter on return.
const BACKGROUND_LEAVE_GRACE_MS = 8 * 60 * 60 * 1000; // 8 hours

// Mirrors Java ChatRoom SILENCE_FAST_EXIT_MESSAGES / EXIT_SILENCE_TIME_IN_MS:
// if a user was in the room for less than this duration before disconnecting,
// suppress the "has left" broadcast to avoid spam from quick in-and-out visits.
const FAST_EXIT_SILENCE_MS = 30_000; // 30 seconds
interface PendingLeave {
  timer:          NodeJS.Timeout;
  roomId:         string;
  userId:         string;
  username:       string;
  color:          string;
  migLevel:       number;
  disconnectedAt: number;   // ms timestamp — used to fetch missed messages on reconnect
  joinedAt:       number;   // ms timestamp — used for FAST_EXIT_SILENCE_MS check
  isBackground:   boolean;  // true if disconnect happened while app was minimised
}

// Matches Java ChatRoom.queueEntryExitAdminMessage:
// userLevel == 0 → plain username; userLevel > 0 → "username[level]"
// Show badge for all levels >= 1 so "mig33 [1] has entered" is displayed correctly.
function withLevel(username: string, migLevel: number): string {
  return migLevel >= 1 ? `${username}[${migLevel}]` : username;
}
// Gift messages always show [level] badge — matches Gift.java formatUserNameWithLevel exactly
// Gift.java: return username + " [" + userReputationLevel + "]"
// << sender [level] gives a/an giftName emoji to recipient [level]! >>
function withGiftLevel(username: string, migLevel: number): string {
  return `${username} [${migLevel}]`;
}
// Always fetch the recipient's latest migLevel from DB to ensure consistency.
// Using cached client.migLevel caused fluctuation when a user's level changed
// during their session (e.g. they levelled up after receiving gifts).
async function getUserDisplayName(username: string): Promise<string> {
  try {
    const res = await db.execute(sql`SELECT display_name FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`);
    const dn = (res.rows[0] as any)?.display_name;
    if (dn) return String(dn);
  } catch {}
  return username;
}

async function recipientDisplay(username: string): Promise<string> {
  const user = await storage.getUserByUsername(username);
  if (user) {
    const profile = await storage.getUserProfile(user.id);
    // Also refresh any active WS clients for this user so their cache stays current
    const freshLevel = profile?.migLevel ?? 1;
    for (const [, c] of clients) {
      if (c.state === "AUTHENTICATED" && c.userId === user.id) {
        c.migLevel = freshLevel;
      }
    }
    return `${user.username} [${freshLevel}]`;
  }
  return username; // unknown user — show as-is
}

// Fetch fresh migLevel for the sender from DB and update client cache.
// Prevents stale level showing in gift messages after the user levels up.
async function freshMigLevel(client: GatewayClient): Promise<number> {
  if (!client.userId) return client.migLevel;
  const profile = await storage.getUserProfile(client.userId);
  const level = profile?.migLevel ?? 1;
  client.migLevel = level;
  return level;
}
// key: `${userId}:${roomId}`
const pendingLeaves = new Map<string, PendingLeave>();

// Cross-gateway cancellation: TCP gateway registers this so the WS SUBSCRIBE
// handler can cancel any TCP-originated pending leave when the user rejoins via WS.
// Returns true if a timer was found and cancelled (used to set isReconnect correctly).
let _tcpLeaveCanceller: ((userId: string, roomId: string) => boolean) | null = null;
export function registerTcpLeaveCanceller(fn: (userId: string, roomId: string) => boolean) {
  _tcpLeaveCanceller = fn;
}

// Called by the TCP gateway when a TCP client joins, to cancel any WS-originated
// pending "has left" timer for the same user+room.
// Returns true if a timer was found and cancelled.
export function cancelWsPendingLeave(userId: string, roomId: string): boolean {
  const key     = `${userId}:${roomId}`;
  const pending = pendingLeaves.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingLeaves.delete(key);
    return true;
  }
  return false;
}

// Returns true if the user is still subscribed to the room via at least one
// active WebSocket connection (used by the TCP gateway on disconnect to decide
// whether to skip the grace-period timer entirely).
export function isUserInRoomViaWs(userId: string, roomId: string): boolean {
  for (const [, c] of clients) {
    if (c.state === "AUTHENTICATED" && c.userId === userId && c.subscribedRooms.has(roomId)) {
      return true;
    }
  }
  return false;
}

// TCP gateway registers this so the WS gateway can check whether the user is
// still present in the room via TCP before starting the WS grace timer.
let _tcpRoomPresence: ((userId: string, roomId: string) => boolean) | null = null;
export function registerTcpRoomPresence(fn: (userId: string, roomId: string) => boolean) {
  _tcpRoomPresence = fn;
}

let _tcpRoomEjector: ((userId: string, roomId: string, roomName: string, reason: "banned" | "kicked" | "bumped") => void) | null = null;
export function registerTcpRoomEjector(fn: (userId: string, roomId: string, roomName: string, reason: "banned" | "kicked" | "bumped") => void) {
  _tcpRoomEjector = fn;
}

// ─── Kick cooldown (5 minutes) ────────────────────────────────────────────────
// key: userId → Map(roomId → kickedAt timestamp)
const kickCooldowns = new Map<string, Map<string, number>>();
const KICK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export function setKickCooldown(userId: string, roomId: string): void {
  if (!kickCooldowns.has(userId)) kickCooldowns.set(userId, new Map());
  kickCooldowns.get(userId)!.set(roomId, Date.now());
}

export function checkKickCooldown(userId: string, roomId: string): { blocked: boolean; remainingMs: number } {
  const userMap = kickCooldowns.get(userId);
  if (!userMap) return { blocked: false, remainingMs: 0 };
  const kickedAt = userMap.get(roomId);
  if (kickedAt === undefined) return { blocked: false, remainingMs: 0 };
  const elapsed = Date.now() - kickedAt;
  if (elapsed >= KICK_COOLDOWN_MS) {
    userMap.delete(roomId);
    return { blocked: false, remainingMs: 0 };
  }
  return { blocked: true, remainingMs: KICK_COOLDOWN_MS - elapsed };
}

export function forceRemoveUserFromRoom(userId: string, roomId: string, roomName: string, reason: "banned" | "kicked" = "banned"): void {
  if (reason === "kicked") setKickCooldown(userId, roomId);
  const message = reason === "banned"
    ? `You have banned in chatroom ${roomName}`
    : `You have been kicked from chatroom ${roomName}`;

  for (const [sock, client] of clients) {
    if (client.state !== "AUTHENTICATED" || client.userId !== userId || !client.subscribedRooms.has(roomId)) continue;
    send(sock, reason === "banned"
      ? { type: "BANNED", roomId, username: client.username ?? "", message } as GatewayEvent
      : { type: "KICKED", roomId, username: client.username ?? "" } as GatewayEvent);
    send(sock, { type: "JOIN_FAIL", code: ErrorCode.UNDEFINED, message });
    client.subscribedRooms.delete(roomId);
    client.roleColors.delete(roomId);
    client.joinedRooms.delete(roomId);
    roomClientsRemove(roomId, sock);
  }

  const pendingKey = `${userId}:${roomId}`;
  const pending = pendingLeaves.get(pendingKey);
  if (pending) {
    clearTimeout(pending.timer);
    pendingLeaves.delete(pendingKey);
  }

  _tcpRoomEjector?.(userId, roomId, roomName, reason);
}

// ─── Soft bump: disconnect user from room without removing them from participants ─
// Unlike kick/ban, bump:
//   - sends BUMPED event (not KICKED/BANNED) — client shows alert and closes modal
//   - does NOT set kick cooldown → user can rejoin immediately
//   - does NOT call storage.leaveChatroom → user stays in participants list
//   - terminates the active WS connection so the client is actually disconnected
export function softBumpUserFromRoom(userId: string, roomId: string): void {
  for (const [sock, client] of clients) {
    if (client.state !== "AUTHENTICATED" || client.userId !== userId || !client.subscribedRooms.has(roomId)) continue;
    send(sock, { type: "BUMPED", roomId, username: client.username ?? "" } as GatewayEvent);
    sock.terminate();
  }
  _tcpRoomEjector?.(userId, roomId, "", "bumped");
}

// ─── Global rejoin block (admin disconnect-by-IP) ─────────────────────────────
// Map: userId → expiresAtMs. When set, all JOIN_ROOM attempts are rejected.
const globalRejoinBlocks = new Map<string, number>();

export function setGlobalRejoinBlock(userId: string, durationMs: number): void {
  globalRejoinBlocks.set(userId, Date.now() + durationMs);
}

export function checkGlobalRejoinBlock(userId: string): { blocked: boolean; remainingMs: number } {
  const exp = globalRejoinBlocks.get(userId);
  if (exp === undefined) return { blocked: false, remainingMs: 0 };
  const remaining = exp - Date.now();
  if (remaining <= 0) {
    globalRejoinBlocks.delete(userId);
    return { blocked: false, remainingMs: 0 };
  }
  return { blocked: true, remainingMs: remaining };
}

// Force a user out of all rooms immediately on explicit logout — broadcasts
// "has left", flushes participant list, cancels any pending grace timers
// (incl. the long 8-hour background grace) AND terminates any live sockets.
// Mirrors Java HomeNavigationActivity.logout() → leaves all joined rooms via
// chat.room.leave packets BEFORE the SocketService is torn down.
//
// Called from POST /api/auth/logout so it works even when the mobile app's
// WebSocket has already closed (e.g. user backgrounded the app, OS suspended
// the socket, then the user tapped "Sign out") — in that scenario the close
// handler scheduled an 8h grace timer; we must cancel it and broadcast now.
export async function forceLogoutCleanup(userId: string): Promise<{ rooms: number; sockets: number }> {
  // 1. Collect every room this user is currently in: union of
  //    (a) rooms attached to any live socket, (b) rooms with a pending leave
  //        timer (= already disconnected, awaiting grace), and
  //    (c) rooms reported by storage.getActiveRoomsByUser (covers TCP-only
  //        sessions and stale entries).
  const roomIds = new Set<string>();
  let usernameSnapshot = "";
  let chatColorSnapshot = "FFFFFF";
  let migLevelSnapshot = 1;

  for (const [, c] of clients) {
    if (c.userId !== userId) continue;
    if (c.username) usernameSnapshot = c.username;
    if (c.chatColor) chatColorSnapshot = c.chatColor;
    if (typeof c.migLevel === "number") migLevelSnapshot = c.migLevel;
    for (const rid of c.subscribedRooms) roomIds.add(rid);
  }

  for (const [key, pending] of pendingLeaves) {
    if (!key.startsWith(`${userId}:`)) continue;
    const rid = key.slice(userId.length + 1);
    roomIds.add(rid);
    if (!usernameSnapshot && pending.username) usernameSnapshot = pending.username;
    if (chatColorSnapshot === "FFFFFF" && pending.color) chatColorSnapshot = pending.color;
    if (migLevelSnapshot === 1 && typeof pending.migLevel === "number") migLevelSnapshot = pending.migLevel;
    // Cancel the long grace timer — we'll broadcast "has left" right now.
    clearTimeout(pending.timer);
    pendingLeaves.delete(key);
  }

  try {
    const active = await storage.getActiveRoomsByUser(userId);
    for (const a of active) roomIds.add(a.room.id);
  } catch { /* ignore */ }

  if (!usernameSnapshot) {
    try {
      const u = await storage.getUser(userId);
      if (u?.username) usernameSnapshot = u.username;
    } catch { /* ignore */ }
  }

  // 2. Leave each room: DB removal + "has left" broadcast + PARTICIPANTS update.
  for (const roomId of roomIds) {
    try {
      const room = await storage.getChatroom(roomId);
      await storage.leaveChatroom(roomId, userId);
      if (usernameSnapshot) {
        const leaveDisplayName = withLevel(usernameSnapshot, migLevelSnapshot);
        const leaveMsg = await storage.postMessage(roomId, {
          senderUsername: usernameSnapshot,
          senderColor: chatColorSnapshot,
          text: `${room?.name ?? roomId}::${leaveDisplayName} has left`,
          isSystem: true,
        });
        broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
      }
      const list = await storage.getParticipants(roomId);
      broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
      if (usernameSnapshot) botNotifyLeave(roomId, usernameSnapshot);
      _tcpRoomEjector?.(userId, roomId, room?.name ?? "", "kicked");
    } catch (e) {
      console.warn(`[gateway] forceLogoutCleanup: room=${roomId} err=`, (e as any)?.message);
    }
  }

  // 3. Clear party room seats — user logout must vacate all party seats immediately.
  //    Without this, the seat stays "occupied" by a ghost until the room is recreated.
  try {
    await db.execute(sql`
      UPDATE party_seats
      SET user_id          = NULL,
          username         = NULL,
          display_name     = NULL,
          avatar_url       = NULL,
          avatar_frame_url = NULL,
          is_muted         = false,
          livekit_identity = NULL,
          joined_at        = NULL,
          updated_at       = NOW()
      WHERE user_id = ${userId}
    `);
  } catch (e) {
    console.warn(`[gateway] forceLogoutCleanup: party seat clear failed:`, (e as any)?.message);
  }

  // 4. Terminate any live sockets so the old session can't keep using them.
  let socketsClosed = 0;
  for (const [sock, c] of clients) {
    if (c.userId !== userId) continue;
    try {
      c.subscribedRooms.clear();   // prevent the close handler from rescheduling grace timers
      sock.terminate();
    } catch { /* ignore */ }
    socketsClosed++;
  }

  return { rooms: roomIds.size, sockets: socketsClosed };
}

// Force a user to leave ALL rooms as a normal "has left" broadcast (not kick/ban),
// then disconnect their socket(s) and apply a global rejoin cooldown.
// Used by admin "disconnect-by-IP" to evict multi-account abuse.
export async function forceLeaveAllRoomsAsLeave(
  userId: string,
  blockDurationMs: number,
): Promise<{ rooms: number; sockets: number }> {
  // Collect rooms the user is currently subscribed to (across any socket).
  const roomIds = new Set<string>();
  let usernameSnapshot = "";
  let chatColorSnapshot = "FFFFFF";
  let migLevelSnapshot = 1;
  for (const [, c] of clients) {
    if (c.state !== "AUTHENTICATED" || c.userId !== userId) continue;
    if (c.username) usernameSnapshot = c.username;
    if (c.chatColor) chatColorSnapshot = c.chatColor;
    if (typeof c.migLevel === "number") migLevelSnapshot = c.migLevel;
    for (const rid of c.subscribedRooms) roomIds.add(rid);
  }

  // Fallback to DB lookup if no live socket (still set the rejoin block).
  if (!usernameSnapshot) {
    try {
      const u = await storage.getUser(userId);
      if (u?.username) usernameSnapshot = u.username;
    } catch { /* ignore */ }
  }

  let socketsClosed = 0;

  for (const roomId of roomIds) {
    try {
      const room = await storage.getChatroom(roomId);
      await storage.leaveChatroom(roomId, userId);
      if (usernameSnapshot) {
        const leaveDisplayName = withLevel(usernameSnapshot, migLevelSnapshot);
        const leaveMsg = await storage.postMessage(roomId, {
          senderUsername: usernameSnapshot,
          senderColor: chatColorSnapshot,
          text: `${room?.name ?? roomId}::${leaveDisplayName} has left`,
          isSystem: true,
        });
        broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
      }
      const list = await storage.getParticipants(roomId);
      broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
      if (usernameSnapshot) botNotifyLeave(roomId, usernameSnapshot);
      _tcpRoomEjector?.(userId, roomId, room?.name ?? "", "kicked");
    } catch (e) {
      console.warn(`[gateway] forceLeaveAllRooms: room=${roomId} err=`, (e as any)?.message);
    }
  }

  // Terminate all live sockets for this user.
  for (const [sock, c] of clients) {
    if (c.userId !== userId) continue;
    try { sock.terminate(); } catch { /* ignore */ }
    socketsClosed++;
  }

  setGlobalRejoinBlock(userId, blockDurationMs);
  return { rooms: roomIds.size, sockets: socketsClosed };
}

// ─── Gift rate limiting ───────────────────────────────────────────────────────
// /gift all: per-user, matches GiftAllRateLimitInSeconds = 60s in Gift.java
const giftAllLastSent = new Map<string, number>();
const GIFT_ALL_RATE_LIMIT_MS = 5_000;

// /gift single: per sender+recipient+gift combo, matches GiftSingleRateLimitInSeconds = 60s
// key: `${senderUsername}:${recipientLower}:${giftName}` — same key strategy as Java's
// MemCachedKeyUtils.getFullKeyForKeySpace(VIRTUAL_GIFT_RATE_LIMIT, sender, recipient, giftId)
const giftSingleRateLimitMap = new Map<string, number>();
const GIFT_SINGLE_RATE_LIMIT_MS = 5_000;

// Matches StringUtil.implodeUserList(allRecipients, 5) in Gift.java
function implodeUserList(usernames: string[], max = 5): string {
  if (usernames.length === 0) return "everyone";
  if (usernames.length <= max) return usernames.join(", ");
  const shown = usernames.slice(0, max);
  const rest = usernames.length - max;
  return `${shown.join(", ")} and ${rest} more`;
}

// ─── Chatroom Theme ───────────────────────────────────────────────────────────
// Matches FusionPktChatRoomTheme (packet 719) in backend app
export interface ChatroomTheme {
  themeId: number;
  name: string;
  background_color: string;
  background_img_url: string | null;
  background_img_alignment: number;
  sender_username_color: string;
  sender_message_color: string;
  recp_username_color: string;
  recp_message_color: string;
  admin_username_color: string;
  admin_message_color: string;
  emote_message_color: string;
  error_message_color: string;
  server_username_color: string;
  server_message_color: string;
  client_message_color: string;
}

// All available chatroom themes — mirrors Java ThemeEnum in com.projectgoth.fusion
// All themes are free (no purchase required)
export const CHATROOM_THEMES: ChatroomTheme[] = [
  {
    themeId: 1, name: "Dark",
    background_color: "1A1A2E", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "2196F3", sender_message_color: "FFFFFF",
    recp_username_color:   "2196F3", recp_message_color:   "FFFFFF",
    admin_username_color: "F47422",  admin_message_color:  "FCC504",
    emote_message_color: "DD587A",   error_message_color:  "FF4444",
    server_username_color: "607D8B", server_message_color: "9E9E9E",
    client_message_color: "FFFFFF",
  },
  {
    themeId: 2, name: "Light",
    background_color: "F5F5F5", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "1565C0", sender_message_color: "212121",
    recp_username_color:   "1565C0", recp_message_color:   "212121",
    admin_username_color: "E65100",  admin_message_color:  "F57F17",
    emote_message_color: "C2185B",   error_message_color:  "D32F2F",
    server_username_color: "546E7A", server_message_color: "616161",
    client_message_color: "212121",
  },
  {
    themeId: 3, name: "Ocean",
    background_color: "002244", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "00BCD4", sender_message_color: "E0F7FA",
    recp_username_color:   "00BCD4", recp_message_color:   "E0F7FA",
    admin_username_color: "FF6F00",  admin_message_color:  "FFCA28",
    emote_message_color: "18FFFF",   error_message_color:  "FF5252",
    server_username_color: "4DD0E1", server_message_color: "80DEEA",
    client_message_color: "E0F7FA",
  },
  {
    themeId: 4, name: "Forest",
    background_color: "1B4332", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "69F0AE", sender_message_color: "E8F5E9",
    recp_username_color:   "69F0AE", recp_message_color:   "E8F5E9",
    admin_username_color: "FFD600",  admin_message_color:  "FFF176",
    emote_message_color: "CCFF90",   error_message_color:  "FF6E40",
    server_username_color: "A5D6A7", server_message_color: "C8E6C9",
    client_message_color: "E8F5E9",
  },
  {
    themeId: 5, name: "Sunset",
    background_color: "3D0C0C", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "FF7043", sender_message_color: "FFF3E0",
    recp_username_color:   "FF7043", recp_message_color:   "FFF3E0",
    admin_username_color: "FFCA28",  admin_message_color:  "FFE082",
    emote_message_color: "FF8A65",   error_message_color:  "FF1744",
    server_username_color: "FFAB91", server_message_color: "FFCCBC",
    client_message_color: "FFF3E0",
  },
  {
    themeId: 6, name: "Purple",
    background_color: "1A0033", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "CE93D8", sender_message_color: "F3E5F5",
    recp_username_color:   "CE93D8", recp_message_color:   "F3E5F5",
    admin_username_color: "FFD600",  admin_message_color:  "FFF9C4",
    emote_message_color: "EA80FC",   error_message_color:  "FF4081",
    server_username_color: "B39DDB", server_message_color: "D1C4E9",
    client_message_color: "F3E5F5",
  },
  {
    themeId: 7, name: "Carbon",
    background_color: "1C1C1C", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "78909C", sender_message_color: "ECEFF1",
    recp_username_color:   "78909C", recp_message_color:   "ECEFF1",
    admin_username_color: "FF6F00",  admin_message_color:  "FFC107",
    emote_message_color: "80CBC4",   error_message_color:  "EF5350",
    server_username_color: "546E7A", server_message_color: "90A4AE",
    client_message_color: "ECEFF1",
  },
];

export function getThemeById(id: number): ChatroomTheme {
  return CHATROOM_THEMES.find(t => t.themeId === id) ?? CHATROOM_THEMES[0];
}

export const DEFAULT_THEME: ChatroomTheme = CHATROOM_THEMES[0];

// ─── Participants payload ─────────────────────────────────────────────────────
// Matches FusionPktChatRoomParticipantsOld (packet 708) in backend app
// Java sends: chatRoomName, participants (csv), administrators (csv), mutedParticipants (csv)
export interface ParticipantsPayload {
  type: "PARTICIPANTS";
  roomId: string;
  chatRoomName: string;
  participants: string[];
  administrators: string[];
  mutedParticipants: string[];
}

export function buildParticipantsPayload(
  roomId: string,
  roomName: string,
  list: ChatParticipant[]
): ParticipantsPayload {
  const participants:     string[] = [];
  const administrators:   string[] = [];
  const mutedParticipants: string[] = [];

  for (const p of list) {
    if (p.isMuted) {
      mutedParticipants.push(p.username);
    } else if (p.isGlobalAdmin || p.isMod || p.isOwner) {
      administrators.push(p.username);
    } else {
      participants.push(p.username);
    }
  }
  return { type: "PARTICIPANTS", roomId, chatRoomName: roomName, participants, administrators, mutedParticipants };
}

// ─── Incoming message types (client → server) ─────────────────────────────────
export type GatewayMessage =
  | { type: "AUTH"; token?: string; sessionUserId?: string; username?: string }
  | { type: "SUBSCRIBE"; roomId: string; isBackgroundReturn?: boolean }
  | { type: "JOIN_ROOM"; roomId: string; isBackgroundReturn?: boolean }
  | { type: "UNSUBSCRIBE"; roomId: string }
  | { type: "SEND_MESSAGE"; roomId: string; text: string }
  // Matches /gift [recipient|all] [giftName] from ChatController.java
  | { type: "SEND_GIFT"; roomId: string; recipient: string; giftName: string; giftEmoji?: string; price?: number; giftMessage?: string }
  | { type: "CMD"; roomId: string; cmd: string; target?: string; message?: string; waitTime?: number }
  // Matches FusionPktDataTextColor (packet 924) — returns sender + message color palettes
  | { type: "GET_COLORS" }
  // Allows user to change their chat username color (stored per WS session)
  | { type: "SET_COLOR"; color: string }
  | { type: "GET_ROOMS"; categoryId?: number; page?: number }
  | { type: "GET_MESSAGES"; roomId: string; after?: string; before?: string; limit?: number }
  | { type: "GET_PARTICIPANTS"; roomId: string }
  | { type: "GET_THEME"; roomId: string }
  | { type: "GET_STATS" }
  | { type: "PING" }
  // ─── Party music sync — broadcast track control to all room members ────────
  | { type: "PARTY_MUSIC"; roomId: string; action: "play" | "pause" | "stop"; trackId?: string; trackTitle?: string; trackArtist?: string; previewUrl?: string; coverUri?: string }
  | { type: "SEND_STICKER"; roomId: string; stickerId: string; seatIndex: number }
  // ─── Kursi Bebas — seat access mode control ────────────────────────────────
  | { type: "SEAT_MODE"; roomId: string; freeSeat: boolean }
  | { type: "SEAT_COUNT"; roomId: string; count: number }
  | { type: "SEAT_REQUEST"; roomId: string; seatIndex: number }
  | { type: "SEAT_APPROVE"; roomId: string; seatIndex: number; requester: string }
  | { type: "SEAT_DENY"; roomId: string; seatIndex: number; requester: string }
  | { type: "SEAT_LOCK"; roomId: string; seatIndex: number; locked: boolean }
  | { type: "SEAT_MUTED"; roomId: string; seatIndex: number; muted: boolean; targetUsername: string };

// ─── Outgoing event types (server → client) ───────────────────────────────────
export type GatewayEvent =
  | { type: "WELCOME"; clientId: string; sessionId: string; version: string }
  | { type: "AUTH_OK"; username: string; sessionId: string; migLevel: number }
  | { type: "AUTH_FAIL"; code: number; message: string }
  | { type: "SUBSCRIBED"; roomId: string; room: object; theme: ChatroomTheme; userColor: string }
  | { type: "JOIN_FAIL"; code: string | number; message: string }
  | { type: "MESSAGE"; roomId: string; message: object }
  | { type: "MESSAGES"; roomId: string; messages: object[] }
  | { type: "HISTORY"; roomId: string; messages: object[]; hasMore: boolean }
  | ParticipantsPayload
  | { type: "KICKED"; roomId: string; username: string }
  | { type: "BANNED"; roomId: string; username: string; message?: string }
  | { type: "MUTED"; roomId: string; username: string }
  | { type: "UNMUTED"; roomId: string; username: string }
  | { type: "MOD"; roomId: string; username: string }
  | { type: "UNMOD"; roomId: string; username: string }
  | { type: "WARNED"; roomId: string; username: string; message?: string }
  | { type: "ANNOUNCEMENT"; roomId: string; message: string }
  | { type: "ANNOUNCEMENT_OFF"; roomId: string }
  // Matches LoveMatch.java + FindMyMatch.java — broadcast love score result to room
  | { type: "LOVE_MATCH"; roomId: string; user1: string; user2: string; score: number }
  | { type: "FIND_MY_MATCH"; roomId: string; seeker: string; match: string; score: number }
  // Matches Flames.java — broadcast FLAMES result to room
  | { type: "FLAMES"; roomId: string; user1: string; user2: string; letter: string; label: string; emoji: string }
  | { type: "FLAMES_NO_MATCH"; roomId: string; user1: string; user2: string }
  // Matches Follow.java — sendMessageToSender only (only caller sees confirmation)
  | { type: "FOLLOW_OK"; username: string }
  | { type: "UNFOLLOW_OK"; username: string }
  // Matches GetMyLuck.java — broadcast 4 luck values (1-5) to entire room
  // Cached per user per day via Redis (mirrors MemCachedClientWrapper.add with TTL)
  | { type: "GET_MY_LUCK"; roomId: string; username: string; love: number; career: number; health: number; luck: number }
  | { type: "LOCKED"; roomId: string }
  | { type: "UNLOCKED"; roomId: string }
  | { type: "THEME"; roomId: string; theme: ChatroomTheme }
  // Matches FusionPktGiftHotkeys — broadcast gift event to room
  | { type: "GIFT"; roomId: string; sender: string; senderColor: string; recipient: string; giftName: string; giftEmoji: string; giftImageUrl?: string; price: number; qty?: number; recipientCount?: number; message: object }
  // Matches FusionPktDataTextColor (packet 924) — chatSenderColorList + chatMessageColorList
  | { type: "COLOR_LIST"; senderColors: string[]; messageColors: string[] }
  | { type: "COLOR_CHANGED"; roomId: string; username: string; color: string }
  | { type: "ROOMS_LIST"; chatrooms: object[]; page: number; totalPages: number }
  | { type: "ALERT"; title: string; message: string }
  | { type: "STATS"; connections: number; authenticated: number; totalEvents: number }
  | { type: "CMD_OK"; cmd: string; target?: string }
  | { type: "PONG"; timestamp: number }
  | { type: "ERROR"; code: number; message: string }
  | { type: "CHAT_MESSAGE"; conversationId: string; message: object }
  // ─── Presence (FusionPktPresence / FusionPktSetPresence) ──────────────────
  // Java: PresenceType values: AVAILABLE=0, AWAY=1, BUSY=2, INVISIBLE=3, OFFLINE=4
  | { type: "PRESENCE"; username: string; userId: string; status: "online" | "away" | "offline" }
  | { type: "PRESENCE_LIST"; users: { username: string; userId: string; status: "online" | "away" | "offline" }[] }
  // ─── Read receipt (FusionPktMessageStatusEvent pkt 505) ───────────────────
  // statusEventType: DELIVERED=1, READ=2 — we implement READ only (parity with Java logic)
  | { type: "READ_RECEIPT"; conversationId: string; messageIds: string[]; readByUsername: string; readAt: string }
  // ─── Server-generated RECEIVED event (ServerGeneratedReceivedEventPusher.java)
  // Pushed back to the original sender when the server stores a message.
  // Mirrors: messageSender.putMessageStatusEvent(toIceObject()) — status=RECEIVED (1)
  // Client uses this to flip ✓ (sending) → ✓ (delivered to server).
  // status: "RECEIVED" = server ack'd (pkt 505 statusEventType=1)
  //         "READ"     = recipient read (sent via READ_RECEIPT, included here for completeness)
  | { type: "MESSAGE_STATUS"; conversationId: string; messageId: string; status: "RECEIVED" | "READ"; serverGenerated: boolean; timestamp: number }
  // ─── Contact / Friend system (FusionPktContactRequest / Accept / Reject) ──
  | { type: "CONTACT_REQUEST"; requestId: string; fromUsername: string; fromDisplayName: string | null }
  | { type: "CONTACT_ACCEPTED"; byUsername: string; byDisplayName: string | null; friendshipId: string }
  | { type: "CONTACT_REJECTED"; byUsername: string }
  // ─── Party music sync ──────────────────────────────────────────────────────
  | { type: "PARTY_MUSIC"; roomId: string; action: "play" | "pause" | "stop"; sender: string; trackId?: string; trackTitle?: string; trackArtist?: string; previewUrl?: string; coverUri?: string }
  | { type: "PARTY_STICKER"; roomId: string; stickerId: string; seatIndex: number; sender: string }
  // ─── Kursi Bebas — seat access mode & request flow ────────────────────────
  | { type: "SEAT_MODE"; roomId: string; freeSeat: boolean }
  | { type: "SEAT_COUNT"; roomId: string; count: number }
  | { type: "SEAT_REQUEST"; roomId: string; seatIndex: number; requester: string }
  | { type: "SEAT_APPROVE"; roomId: string; seatIndex: number; requester: string }
  | { type: "SEAT_DENY"; roomId: string; seatIndex: number; requester: string }
  | { type: "SEAT_LOCK"; roomId: string; seatIndex: number; locked: boolean }
  | { type: "SEAT_MUTED"; roomId: string; seatIndex: number; muted: boolean; targetUsername: string }
  // ─── Grady Game win announcement ──────────────────────────────────────────
  | { type: "GAME_WIN"; eventId: string; roomId?: string; username: string; gameName: string; gameEmoji: string; amount: number; slotEmoji: string; multiplier: number; isGlobal?: boolean }
  // ─── Diamond withdraw status (admin approve / reject) ─────────────────────
  | { type: "DIAMOND_WITHDRAW_STATUS"; status: "approved" | "rejected"; refId: string; amount: number; idrValue: number; bankName?: string; accountNumber?: string; accountName?: string; notes?: string | null }
  // ─── Lucky Gift Jackpot ────────────────────────────────────────────────────
  | { type: "LUCKY_JACKPOT_GLOBAL"; milestone: string; label: string; emoji: string; winners: string[]; reward: number; roomId?: string; siklusId?: number; queueIdx?: number; queueTotal?: number; totalCoin?: number; triggeredBy?: string }
  | { type: "LUCKY_JACKPOT"; milestone?: string; tier?: string; tierEmoji?: string; multiplier?: number; winner?: string; reward?: number; roomId?: string; totalCoin?: number }
  | { type: "LUCKY_BAG_GLOBAL_SENT"; bagId: number; senderUsername: string; senderRoomId: string; senderRoomName: string; totalCoins: number; bagCount: number; claimableAt: string; expiresAt: string }
  | { type: "LUCKY_BAG_GLOBAL_CLAIMED"; bagId: number; claimerUsername: string; coinEarned: number; bagsRemaining: number }
  | { type: "LUXURY_BROADCAST_GLOBAL"; senderDisplayName: string; recipientDisplayName: string; giftName: string; giftImageUrl?: string; giftEmoji: string; roomName: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(ws: WebSocket, event: GatewayEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
    const client = clients.get(ws);
    if (client) client.eventsDispatched++;
  }
}

function isRateLimited(client: GatewayClient): boolean {
  const now = Date.now();
  if (now - client.packetWindowStart > RATE_LIMIT_WINDOW_MS) {
    client.packetWindowStart = now;
    client.packetCount = 0;
  }
  client.packetCount++;
  return client.packetCount > RATE_LIMIT_MAX_PACKETS;
}

// Matches FusionPktDataTextColor (packet 924) — chatSenderColorList sent to client
// Default index 0 = "2196F3" (blue) — the Migme original default user color
export const TEXT_SENDER_COLORS = [
  "2196F3", "FFFFFF", "FF5252", "69F0AE", "FFEB3B",
  "FF9800", "E040FB", "FF4081", "00E5FF", "FF6D00",
  "4CAF50", "F44336", "9C27B0", "009688", "795548",
];
export const TEXT_MESSAGE_COLORS = [
  "FFFFFF", "FFEB3B", "FF5252", "69F0AE", "00E5FF",
  "FF9800", "E040FB", "FF4081",
];

/**
 * Returns the allowed room capacity for a user based on their mig level.
 * Level 1-49  → 25 participants
 * Level 50+   → 40 participants
 */
export async function getRoomCapacityForUser(userId: string): Promise<number> {
  try {
    const user = await storage.getUser(userId);
    const level = user?.migLevel ?? 1;
    return level >= 50 ? 40 : 25;
  } catch {
    return 25;
  }
}

// Default = blue "2196F3" (index 0). Hash picks a color from the palette for variety.
export function userColor(username: string): string {
  const idx = Math.abs(username.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % TEXT_SENDER_COLORS.length;
  return TEXT_SENDER_COLORS[idx];
}

/**
 * Mirrors ChatRoomParticipant.getMessageSourceColorOverride() from com/projectgoth/fusion.
 *
 * Priority (highest → lowest):
 *   1. Global Admin               → GLOBAL_ADMIN     (17) = 0xF47422 (orange)
 *   2. Merchant / Mentor          → TOP_MERCHANT_LVL1(12) = 0x990099 (purple, or usernameColor)
 *      (merchant/mentor color is preserved even when they are mod or owner)
 *   3. Room Owner / Moderator     → GROUP_ADMIN_USER  (3) = 0xFCC504 (golden yellow)
 *      (only applied if user is NOT a merchant/mentor)
 *   4. Regular user               → fallback (client.chatColor)
 *
 * Source color values from MessageData.SourceTypeEnum:
 *   GROUP_ADMIN_USER (3)  = 16565508 = 0xFCC504
 *   MODERATOR_USER   (4)  = 16565508 = 0xFCC504
 *   TOP_MERCHANT_LVL1(12) = 0x990099
 *   TOP_MERCHANT_LVL2(13) = 16723623 = 0xFF2EA7
 *   TOP_MERCHANT_LVL3(15) = 0xFF0000
 *   GLOBAL_ADMIN     (17) = 16020514 = 0xF47422
 */
export async function getRoleColor(params: {
  userId: string;
  username: string;
  roomId: string;
  defaultColor: string;
}): Promise<string> {
  const { userId, username, roomId, defaultColor } = params;
  try {
    // Priority 1: Global Admin → orange F47422 (highest priority, overrides all)
    const isGlobalAdmin = await storage.isGlobalAdmin(userId);
    if (isGlobalAdmin) return "F47422";

    // Priority 2: Merchant / Mentor → usernameColor (preserved even if mod or owner)
    // Only ACTIVE merchants get the role color. Inactive (status != 1) or
    // deleted merchants fall through to owner/mod or regular user color so
    // that admin-deactivated merchants no longer appear purple.
    const merchant = await storage.getMerchantByUsername(username);
    if (merchant && merchant.status === 1) {
      return (merchant.usernameColor ?? "#990099").replace(/^#/, "");
    }

    const room = await storage.getChatroom(roomId);
    if (!room) return defaultColor;

    // Priority 3: Room Owner / Moderator → golden yellow FCC504
    // (only reaches here if user is NOT a merchant/mentor)
    const isOwner = room.createdBy === userId;
    const isMod   = await storage.isModUser(roomId, userId);
    if (isOwner || isMod) return "FCC504";
  } catch {}
  return defaultColor;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function broadcastToRoom(roomId: string, event: GatewayEvent): void {
  const sockets = roomClients.get(roomId);
  if (!sockets) return;
  for (const sock of sockets) {
    const c = clients.get(sock);
    if (c && c.state === "AUTHENTICATED") send(sock, event);
  }
}

export function broadcastToUser(userId: string, event: GatewayEvent): void {
  clients.forEach((client) => {
    if (client.state === "AUTHENTICATED" && client.userId === userId) {
      send(client.ws, event);
    }
  });
}

// Kirim event ke SEMUA authenticated client (semua room)
export function broadcastToAllClients(event: GatewayEvent): void {
  clients.forEach((client) => {
    if (client.state === "AUTHENTICATED") {
      send(client.ws, event);
    }
  });
}

// Kirim event ke semua WS connection milik username tertentu (case-insensitive)
export function broadcastToUsername(username: string, event: GatewayEvent): void {
  const lower = username.toLowerCase();
  clients.forEach((client) => {
    if (client.state === "AUTHENTICATED" && client.username?.toLowerCase() === lower) {
      send(client.ws, event);
    }
  });
}

// ─── Presence tracking ────────────────────────────────────────────────────────
// Mirrors FusionPktSetPresence / FusionPktPresence (Java: SessionPrx.setPresence)
// Java PresenceType: AVAILABLE=0, AWAY=1, BUSY=2, INVISIBLE=3, OFFLINE=4
// States: online (AVAILABLE), away (AWAY), busy (BUSY), offline (OFFLINE/INVISIBLE)
// In-memory map: userId → user-set override ("away" | "online" | "busy")
// Default: derived from WS connection — if authenticated WS connection exists → "online"
const presenceOverrides = new Map<string, "away" | "online" | "busy" | "offline">();

// In-memory status messages: userId → status message text
const statusMessages = new Map<string, string>();

export function getUserPresence(userId: string): "online" | "away" | "busy" | "offline" {
  let isConnected = false;
  clients.forEach((c) => {
    if (c.state === "AUTHENTICATED" && c.userId === userId) isConnected = true;
  });
  if (!isConnected) return "offline";
  const override = presenceOverrides.get(userId);
  if (override === "away") return "away";
  if (override === "busy") return "busy";
  if (override === "offline") return "offline";
  return "online";
}

export function getUserStatusMessage(userId: string): string {
  return statusMessages.get(userId) ?? "";
}

export function setUserStatusMessage(userId: string, message: string): void {
  if (message.trim()) {
    statusMessages.set(userId, message.trim());
  } else {
    statusMessages.delete(userId);
  }
}

export function setUserPresenceOverride(userId: string, status: "online" | "away" | "busy" | "offline"): void {
  if (status === "online") {
    presenceOverrides.delete(userId);
  } else {
    presenceOverrides.set(userId, status);
  }
}

export function isUserOnline(userId: string): boolean {
  return getUserPresence(userId) !== "offline";
}

// Push PRESENCE event to a list of online friend userIds
export function broadcastPresenceToFriends(userId: string, username: string, status: "online" | "away" | "busy" | "offline", friendUserIds: string[]): void {
  for (const fid of friendUserIds) {
    if (fid !== userId) {
      broadcastToUser(fid, { type: "PRESENCE", username, userId, status });
    }
  }
}

// ─── Public helper: batch presence for a list of userIds ──────────────────────
export function getPresenceList(userIds: string[]): { username: string; userId: string; status: "online" | "away" | "busy" | "offline" }[] {
  const result: { username: string; userId: string; status: "online" | "away" | "busy" | "offline" }[] = [];
  for (const uid of userIds) {
    let username = "";
    clients.forEach((c) => { if (c.userId === uid && c.username) username = c.username; });
    result.push({ userId: uid, username, status: getUserPresence(uid) });
  }
  return result;
}

// Matches GatewayAdminI.sendAlertToAllConnections() in backend app
export function broadcastAlertToAll(title: string, message: string): void {
  let dispatched = 0;
  clients.forEach((client) => {
    if (client.state === "AUTHENTICATED") {
      send(client.ws, { type: "ALERT", title, message });
      dispatched++;
    }
  });
  console.log(`[gateway] Alert "${title}" dispatched to ${dispatched} connections`);
}

export function getGatewayStats() {
  let authenticated = 0;
  let totalEvents = 0;
  clients.forEach((c) => {
    if (c.state === "AUTHENTICATED") authenticated++;
    totalEvents += c.eventsDispatched;
  });
  return { connections: clients.size, authenticated, totalEvents };
}

// ─── Announce repeat timers (mirrors Announce.java chatRoomPrx.announceOn/Off) ─
// Key: roomId → NodeJS timer handle
// waitTime -1 = one-shot (no repeat). 120-3600 = repeat interval in seconds.
const announceTimers = new Map<string, ReturnType<typeof setInterval>>();

function clearAnnounceTimer(roomId: string): void {
  const t = announceTimers.get(roomId);
  if (t) { clearInterval(t); announceTimers.delete(roomId); }
}

// ─── Flames helper — ported from Flames.java ─────────────────────────────────
// getFlamesScore: counts shared characters (user1 freq + user2 freq per shared char).
// Mirrors: Flames.java#getFlamesScore (lines 35-60)
// FLAMES_VALUES index = score % 6:
//   0→Sis/Bro  1→Friendship  2→Love  3→Admiration  4→Marriage  5→Enemy
const FLAMES_VALUES = [
  { letter: "S", label: "Sis/Bro",    emoji: "👫" },
  { letter: "F", label: "Friendship", emoji: "🤝" },
  { letter: "L", label: "Love",       emoji: "❤️"  },
  { letter: "A", label: "Admiration", emoji: "😍" },
  { letter: "M", label: "Marriage",   emoji: "💍" },
  { letter: "E", label: "Enemy",      emoji: "😡" },
];
function getFlamesScore(username1: string, username2: string): number {
  // Build char frequency map for username1
  const freq1 = new Map<string, number>();
  for (const c of username1) { freq1.set(c, (freq1.get(c) ?? 0) + 1); }
  // For each char in username2 that also appears in username1, accumulate
  // First occurrence: common[c] = freq1[c] + 1; subsequent: common[c] += 1
  // Mirrors Flames.java occurrenceCommon logic exactly
  const common = new Map<string, number>();
  for (const c of username2) {
    if (!freq1.has(c)) continue;
    if (common.has(c)) { common.set(c, common.get(c)! + 1); }
    else               { common.set(c, freq1.get(c)! + 1); }
  }
  let total = 0;
  for (const v of common.values()) total += v;
  return total;
}

// ─── LoveMatch helpers — ported from LoveMatch.java ──────────────────────────
// getLoveCode: rolling sum of char codes mod 101, with code==100 bumped to 101
// Mirrors: LoveMatch.java#getLoveCode (line 32-48)
function getLoveCode(username: string): number {
  if (!username) return 0;
  const v = username.trim().toLowerCase();
  if (!v.length) return 0;
  let code = 0;
  for (const c of v) { code = (code + c.charCodeAt(0)) % 101; }
  code %= 101;
  if (code === 100) code++;
  return code;
}
// getLoveMatchScore: (code2 * code1 + code1 + code2) % 101
// Mirrors: LoveMatch.java#getLoveMatchScore (line 50-52)
function getLoveMatchScore(username1: string, username2: string): number {
  const c1 = getLoveCode(username1);
  const c2 = getLoveCode(username2);
  return (c2 * c1 + c1 + c2) % 101;
}

// ─── Setup ────────────────────────────────────────────────────────────────────
export function setupGateway(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: GATEWAY_WS_PATH });

  // PurgeConnectionTask — drop idle/dead connections (matches backend PurgeConnectionTask)
  const purgeTimer = setInterval(() => {
    const now = Date.now();
    const toDelete: WebSocket[] = [];
    clients.forEach((client, ws) => {
      if (now - client.lastActivity > KEEP_ALIVE_TIMEOUT_MS) {
        send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Connection timed out" });
        client.state = "DISCONNECTED";
        ws.terminate();
        toDelete.push(ws);
      }
    });
    toDelete.forEach((ws) => clients.delete(ws));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  // Native WebSocket ping interval — sends WS-level ping frames to keep TCP connections
  // alive through proxies and load balancers that drop idle connections.
  // Mirrors FusionService.pingTimerTask in the Android client (scheduleNextPingTimerTask).
  const NATIVE_PING_INTERVAL_MS = 30_000;

  wss.on("connection", (ws, req) => {
    const now = Date.now();
    const sessionId = randomUUID();
    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    console.log(`[gateway] WS client connected: sessionId=${sessionId} ip=${clientIp}`);

    const client: GatewayClient = {
      ws,
      sessionId,
      subscribedRooms: new Set(),
      state: "CONNECTING",
      serverType: "WS",
      connectedAt: now,
      lastActivity: now,
      migLevel: 1,
      isChatroomAdmin: false,
      isBackground: false,
      joinedRooms: new Map(),
      chatColor: "2196F3",   // Default blue — matches Migme original default
      roleColors: new Map(),
      packetCount: 0,
      packetWindowStart: now,
      eventsDispatched: 0,
      displayPicture: null,
      displayName: null,
    };
    clients.set(ws, client);

    // Native ping — keeps the TCP connection alive through proxies/load balancers
    const nativePingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(nativePingTimer);
      }
    }, NATIVE_PING_INTERVAL_MS);

    // Pong reply updates lastActivity — prevents idle purge from dropping live connections
    ws.on("pong", () => {
      client.lastActivity = Date.now();
    });

    // WELCOME — matches GatewayWS initial handshake in backend app
    send(ws, { type: "WELCOME", clientId: sessionId, sessionId, version: APP_VERSION });

    ws.on("message", async (data) => {
      client.lastActivity = Date.now();

      // Rate limiting — PacketProcessor flood control
      if (isRateLimited(client)) {
        send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Too many requests. Slow down." });
        client.state = "DISCONNECTED";
        ws.terminate();
        clients.delete(ws);
        return;
      }

      let msg: GatewayMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Invalid JSON" });
        return;
      }

      switch (msg.type) {

        // ── AUTH ────────────────────────────────────────────────────────────
        case "AUTH": {
          let user = null;

          // Path 1: JWT token (preferred — works reliably across Docker/mobile)
          if (msg.token) {
            const payload = verifyJwt(msg.token);
            if (payload) {
              user = await storage.getUser(payload.userId);
              console.log(`[gateway] AUTH attempt via JWT: userId=${payload.userId} userFound=${!!user}`);
            } else {
              console.log(`[gateway] AUTH_FAIL: invalid JWT token`);
              send(ws, { type: "AUTH_FAIL", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Token tidak valid" });
              return;
            }
          }

          // Path 2: sessionUserId fallback (backward compat for web)
          if (!user && msg.sessionUserId) {
            const found = await storage.getUser(msg.sessionUserId);
            if (found && (!msg.username || found.username === msg.username)) {
              user = found;
            }
            const maskedSessionId = String(msg.sessionUserId).slice(0, 4) + "***";
            console.log(`[gateway] AUTH attempt via sessionUserId=${maskedSessionId} userFound=${!!user}`);
          }

          if (!user) {
            console.log(`[gateway] AUTH_FAIL: no valid credentials provided`);
            send(ws, { type: "AUTH_FAIL", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Autentikasi gagal" });
            return;
          }
          if (user.isSuspended) {
            console.log(`[gateway] AUTH_FAIL: userId=${user.id} account suspended`);
            send(ws, { type: "AUTH_FAIL", code: "SUSPENDED", message: "Your account has been suspended" });
            ws.terminate();
            return;
          }
          const profile = await storage.getUserProfile(user.id);
          client.userId         = user.id;
          client.username       = user.username;
          client.migLevel       = profile?.migLevel ?? 1;
          client.isChatroomAdmin = user.isAdmin === true;
          client.displayName    = user.displayName ?? null;
          const rawDp = profile?.displayPicture ?? null;
          client.displayPicture = rawDp && /\/api\/imageserver\/image\/[^/]+$/.test(rawDp) ? rawDp + '/data' : rawDp;
          // chatColor stays as "2196F3" (blue default) unless user changes it via SET_COLOR
          // Matches Migme original default — users pick color from TEXT_COLOR palette (packet 924)
          client.state     = "AUTHENTICATED";
          console.log(`[gateway] AUTH_OK: userId=${user.id} username=${user.username}`);
          send(ws, { type: "AUTH_OK", username: user.username, sessionId, migLevel: client.migLevel });
          // Broadcast ONLINE presence to friends — mirrors Java FusionPktPresence broadcast on login
          try {
            const myFriends = await db.select({ friendUserId: friendships.friendUserId })
              .from(friendships).where(eq(friendships.userId, user.id));
            const friendIds = myFriends.map((f: { friendUserId: string }) => f.friendUserId);
            broadcastPresenceToFriends(user.id, user.username, "online", friendIds);
          } catch {}

          // Flush offline messages queued while user was disconnected
          // Mirrors RedisChatSyncStore offline message delivery on reconnect
          try {
            const today = new Date();
            const yesterdayDate = new Date(today);
            yesterdayDate.setDate(today.getDate() - 1);
            const todayMsgs   = await getOfflineMessages(user.id, today);
            const yestMsgs    = await getOfflineMessages(user.id, yesterdayDate);
            const allOffline  = [...yestMsgs, ...todayMsgs];
            for (const raw of allOffline) {
              try {
                const event = JSON.parse(raw);
                send(ws, event);
              } catch {}
            }
            if (allOffline.length > 0) {
              await clearOfflineMessages(user.id, today);
              await clearOfflineMessages(user.id, yesterdayDate);
            }
          } catch {}
          break;
        }

        // ── SUBSCRIBE / JOIN_ROOM ────────────────────────────────────────────
        // Matches FusionPktJoinChatRoomOld (703): joins DB, sends theme+participants+history
        // JOIN_ROOM is the preferred name from mobile clients; SUBSCRIBE kept for web compat.
        case "JOIN_ROOM":
        case "SUBSCRIBE": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "JOIN_FAIL", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" });
            ws.terminate();
            return;
          }
          const roomId = (msg as any).roomId as string;
          console.log(`[gateway] JOIN_ROOM: userId=${client.userId} username=${client.username} roomId=${roomId}`);
          const room = await storage.getChatroom(roomId);

          // ── Party Room fast-path ─────────────────────────────────────────
          // Party rooms (Live Party / voice rooms) live in the party_rooms
          // table, not chatrooms. If the classic lookup misses, check if it
          // is a party room and handle with a simplified subscription that
          // skips ban/kick/lock/capacity guards.
          if (!room) {
            let partyRoomRow: { id: string; name: string; background_image?: string | null } | null = null;
            try {
              const pr = await db.execute(sql`SELECT id, name, background_image FROM party_rooms WHERE id = ${roomId} LIMIT 1`);
              if (pr.rows.length > 0) partyRoomRow = pr.rows[0] as any;
            } catch { /* query error — not a party room */ }

            if (!partyRoomRow) {
              console.log(`[gateway] JOIN_FAIL: room ${roomId} not found`);
              send(ws, { type: "JOIN_FAIL", code: ErrorCode.UNDEFINED, message: `Room ${roomId} tidak ditemukan` });
              ws.terminate();
              return;
            }

            // Party room join — simplified flow, no ban/kick/lock checks
            console.log(`[gateway] JOIN_OK (party): userId=${client.userId} username=${client.username} roomId=${roomId}`);
            const partyAlreadyInRoom = roomClients.get(roomId)?.has(ws) ?? false;
            client.subscribedRooms.add(roomId);
            roomClientsAdd(roomId, ws);
            if (!client.joinedRooms.has(roomId)) {
              client.joinedRooms.set(roomId, Date.now());
            }
            // Sertakan backgroundImage agar client selalu sync saat join/rejoin
            send(ws, { type: "SUBSCRIBED", roomId, room: { id: roomId, isParty: true, backgroundImage: partyRoomRow.background_image ?? null }, theme: null, userColor: client.chatColor ?? "#FFFFFF" });

            // ── PARTICIPANTS: build from live WS connections (party rooms are not in DB table) ──
            // Send full list privately to the joiner first, then broadcast to everyone.
            const buildPartyParticipants = (rId: string) => {
              const s = roomClients.get(rId);
              const names: string[] = [];
              if (s) { for (const w of s) { const c = clients.get(w); if (c?.username) names.push(c.username); } }
              return names;
            };
            const partyMembersOnJoin = buildPartyParticipants(roomId);
            // Send to new joiner — so they see accurate count immediately
            send(ws, { type: "PARTICIPANTS", roomId, chatRoomName: partyRoomRow.name, participants: partyMembersOnJoin, administrators: [], mutedParticipants: [] });
            // Broadcast to all room members so existing users' counts update
            broadcastToRoom(roomId, { type: "PARTICIPANTS", roomId, chatRoomName: partyRoomRow.name, participants: partyMembersOnJoin, administrators: [], mutedParticipants: [] });

            // Broadcast "has entered" join notification — only on genuine first join,
            // not on background return (user minimized then restored) or reconnect.
            const partyIsBackgroundReturn = !!(msg as any).isBackgroundReturn;
            if (!partyIsBackgroundReturn && !partyAlreadyInRoom && client.username) {
              try {
                const joinDisplayName = withLevel(client.username, client.migLevel);
                const joinMsg = await storage.postMessage(roomId, {
                  senderId:       client.userId,
                  senderUsername: client.username,
                  senderColor:    client.chatColor ?? 'FFFFFF',
                  text:           `${partyRoomRow.name}::${joinDisplayName} has entered`,
                  isSystem:       true,
                });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: { ...joinMsg, senderDisplayName: client.displayName ?? client.username! } });
              } catch { /* non-fatal: join message errors should not block room entry */ }
            }
            // Send recent chat history for the party room (same messages table)
            try {
              const history = await storage.getMessages(roomId, { limit: 30 });
              if (history.length > 0) {
                send(ws, { type: "HISTORY", roomId, messages: history, hasMore: false });
              }
            } catch { /* no history yet */ }
            break;
          }

          const banned = await storage.isBanned(roomId, client.userId!);
          if (banned) {
            console.log(`[gateway] JOIN_FAIL: userId=${client.userId} is banned from room ${roomId}`);
            send(ws, { type: "JOIN_FAIL", code: ErrorCode.UNDEFINED, message: `You have banned in chatroom ${room.name}` });
            ws.terminate();
            return;
          }

          const kickCheck = checkKickCooldown(client.userId!, roomId);
          if (kickCheck.blocked) {
            const remainingMin = Math.ceil(kickCheck.remainingMs / 60000);
            send(ws, { type: "JOIN_FAIL", code: "KICK_COOLDOWN", message: `You has been kicked from the chatroom ${room.name} wait ${remainingMin} minute${remainingMin !== 1 ? 's' : ''} to enter again!` });
            ws.terminate();
            return;
          }

          const globalBlock = checkGlobalRejoinBlock(client.userId!);
          if (globalBlock.blocked) {
            const remainingMin = Math.ceil(globalBlock.remainingMs / 60000);
            send(ws, { type: "JOIN_FAIL", code: "REJOIN_BLOCKED", message: `Akun Anda diblokir sementara oleh administrator. Coba lagi dalam ${remainingMin} menit.` });
            ws.terminate();
            return;
          }

          const alreadyInRoom = roomClients.get(roomId)?.has(ws) ?? false;
          if (room.isLocked && !alreadyInRoom) {
            const lockIsOwner       = room.createdBy === client.userId;
            const lockIsMod         = await storage.isModUser(roomId, client.userId!);
            const lockIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
            if (!lockIsOwner && !lockIsMod && !lockIsGlobalAdmin) {
              send(ws, { type: "JOIN_FAIL", code: ErrorCode.UNDEFINED, message: "You can't enter the chatroom has been locked" });
              ws.terminate();
              return;
            }
          }

          if (!alreadyInRoom) {
            const liveCount = roomClients.get(roomId)?.size ?? 0;
            if (room.maxParticipants > 0 && liveCount >= room.maxParticipants) {
              // Owner / mod / global admin bypass capacity (mirrors fusion ChatRoomPreSE454 logic)
              const capWsIsOwner       = room.createdBy === client.userId;
              const capWsIsMod         = await storage.isModUser(roomId, client.userId!);
              const capWsIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
              if (!capWsIsOwner && !capWsIsMod && !capWsIsGlobalAdmin) {
                send(ws, { type: "JOIN_FAIL", code: ErrorCode.UNDEFINED, message: `Room sudah penuh (maks ${room.maxParticipants} peserta)` });
                ws.terminate();
                return;
              }
            }
          }

          // AccessControl: ENTER_CHATROOM — mirrors AuthenticatedAccessControlTypeEnum.ENTER_CHATROOM
          const canEnter = await checkAccess("ENTER_CHATROOM", client.userId!);
          if (!canEnter) {
            console.log(`[gateway] JOIN_FAIL: userId=${client.userId} email not verified`);
            send(ws, { type: "JOIN_FAIL", code: "EMAIL_NOT_VERIFIED", message: "Verifikasi email kamu terlebih dahulu untuk masuk ke chatroom." });
            ws.terminate();
            return;
          }

          // ── Grace period reconnect check ─────────────────────────────────
          // If this user disconnected recently (within LEAVE_GRACE_MS), cancel
          // the pending "has left" and re-subscribe silently — no enter/leave
          // messages emitted, matching Java gateway reconnect behaviour.
          const graceKey = `${client.userId}:${roomId}`;
          const pending  = pendingLeaves.get(graceKey);
          if (pending) {
            clearTimeout(pending.timer);
            pendingLeaves.delete(graceKey);
          }
          // Also cancel any TCP-originated pending leave for the same user+room.
          // If the user disconnected via TCP and is rejoining via WS, we must cancel
          // that timer AND treat this as a reconnect (no "has entered" broadcast).
          const tcpPendingCancelled = _tcpLeaveCanceller?.(client.userId!, roomId) ?? false;

          // Duplicate-join guard: if the user is already live in this room via
          // another WS connection or via the TCP gateway (e.g. they have both the
          // web and mobile app open), treat this as a silent rejoin so we don't
          // emit a second "has entered" message.
          // Note: subscribedRooms.add() hasn't been called yet, so isUserInRoomViaWs
          // will not match the current WS connection — only other connections.
          const alreadyLiveInRoom = isUserInRoomViaWs(client.userId!, roomId)
                                 || (_tcpRoomPresence?.(client.userId!, roomId) ?? false);

          // isBackgroundReturn: client signals it is returning from app minimize.
          // Mirrors Android SocketService/AppLifeCycle: when the app is restored from
          // background the socket may have been killed by the OS (after hours), but
          // the user never explicitly left the room — treat as a silent rejoin
          // regardless of whether the grace period has expired.
          const isBackgroundReturn = !!(msg as any).isBackgroundReturn;

          const isReconnect = !!pending || tcpPendingCancelled || alreadyLiveInRoom || isBackgroundReturn;

          // Determine role-based color — mirrors ChatRoomParticipant.getMessageSourceColorOverride()
          // Owner/Mod → FCC504 (golden yellow), Merchant/Mentor → 990099 (purple), else chatColor
          const roleColor = await getRoleColor({
            userId: client.userId!,
            username: client.username!,
            roomId,
            defaultColor: client.chatColor,
          });
          client.roleColors.set(roomId, roleColor);

          // Join chatroom in DB — use role color so participant list reflects the correct color
          const color = roleColor;
          await storage.joinChatroom(roomId, {
            id: client.userId!, username: client.username!,
            displayName: client.username!, color,
          });
          client.subscribedRooms.add(roomId);
          roomClientsAdd(roomId, ws);
          // Track join timestamp per room — used for FAST_EXIT_SILENCE_MS check on disconnect.
          // On a silent reconnect, preserve the original joinedAt if available so that
          // a user who quickly disconnects+reconnects doesn't reset their "time in room" clock.
          if (!client.joinedRooms.has(roomId)) {
            client.joinedRooms.set(roomId, Date.now());
          }

          // Send SUBSCRIBED with room info, theme, and the user's resolved role color
          // so the client can use the correct color immediately for optimistic messages.
          const roomThemeId = parseInt((room as any).theme ?? "1", 10) || 1;
          const roomTheme   = getThemeById(roomThemeId);
          console.log(`[gateway] JOIN_OK: userId=${client.userId} username=${client.username} roomId=${roomId} isReconnect=${isReconnect} themeId=${roomThemeId}`);
          send(ws, { type: "SUBSCRIBED", roomId, room, theme: roomTheme, userColor: roleColor });

          // Send COLOR_LIST — matches FusionPktDataTextColor (packet 924)
          send(ws, { type: "COLOR_LIST", senderColors: TEXT_SENDER_COLORS, messageColors: TEXT_MESSAGE_COLORS });

          // Send PARTICIPANTS privately to the joining user — their personal
          // "Currently in the room" snapshot (mirrors Java queueAdminMessage
          // with MIMETYPE_PARTICIPANTS, sent only to the entrant).
          const list = await storage.getParticipants(roomId);
          // On reconnect / background-return: still refresh the sidebar list,
          // but flag the payload so the client skips re-injecting the
          // "Currently in the room: ..." welcome line (it was already shown
          // on the original join — re-showing it on every minimize-return is noisy).
          send(ws, { ...buildParticipantsPayload(roomId, room.name, list), isReconnect });

          // Populate muted cache from participant list (avoids per-message DB query)
          if (!mutedCache.has(roomId)) {
            const muted = new Set(list.filter(p => p.isMuted).map(p => p.id));
            mutedCache.set(roomId, muted);
          }

          if (isReconnect && pending) {
            // ── Reconnect backlog (capped) ────────────────────────────────────
            // Mirrors Android behaviour (sources/net/migers/chat): the singleton
            // ChatRoomRepository keeps the in-memory list, but the WS protocol
            // never auto-flushes a large backlog — history beyond the recent
            // window is only loaded when the user explicitly pulls-to-refresh.
            //
            // We therefore cap the missed-messages payload to the last
            // BACKGROUND_BACKLOG_CAP messages. This prevents the "flood" the
            // user sees after a long minimize (e.g. 6h away from a busy room
            // could otherwise deliver hundreds of messages at once). For shorter
            // disconnects (network blip during foreground) the cap is rarely hit.
            const BACKGROUND_BACKLOG_CAP = 30;
            const missed = await storage.getMessagesSince(roomId, pending.disconnectedAt);
            if (missed.length > 0) {
              const capped = missed.length > BACKGROUND_BACKLOG_CAP
                ? missed.slice(-BACKGROUND_BACKLOG_CAP)
                : missed;
              if (capped.length < missed.length) {
                console.log(`[gateway] JOIN_ROOM backlog cap applied: room=${roomId} user=${client.username} missed=${missed.length} delivered=${capped.length}`);
              }
              send(ws, { type: "MESSAGES", roomId, messages: capped });
            }
          }
          // On a fresh join: no history — matches FusionPktJoinChatRoomOld
          // behaviour where the server sends ONLY participants, theme, and the
          // "has entered" system message.  History is fetched on demand via
          // GET_MESSAGES (client explicitly requests it).

          // Broadcast "has entered" only on a genuine first join, not a reconnect.
          // Matches Java ChatRoom.queueEntryExitAdminMessage: include level badge
          // when migLevel > 1 — e.g. "alice[5] has entered".
          if (!isReconnect) {
            const displayName = withLevel(client.username!, client.migLevel);
            const joinMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: client.username!,
              senderColor: color, text: `${room.name}::${displayName} has entered`, isSystem: true,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: { ...joinMsg, senderDisplayName: client.displayName ?? client.username! } });
            // Mirrors Java ChatRoomParticipants.notifyUserJoinedChatRoom:
            // each existing participant is notified so they refresh their list.
            // Broadcast updated PARTICIPANTS to ALL clients in the room so
            // "Currently in the room" and the sidebar update for everyone.
            broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
            botNotifyJoin(roomId, client.username!);
          }
          break;
        }

        // ── UNSUBSCRIBE / LEAVE CHATROOM ─────────────────────────────────────
        // Matches FusionPktLeaveChatRoomOld: leaves DB, broadcasts USER_LEFT
        case "UNSUBSCRIBE": {
          const { roomId } = msg;
          if (!client.subscribedRooms.has(roomId)) return;
          client.subscribedRooms.delete(roomId);
          roomClientsRemove(roomId, ws);
          if (!client.userId) return;
          await storage.leaveChatroom(roomId, client.userId);
          const room = await storage.getChatroom(roomId);
          // Suppress "has left" for party room owner only — they sit directly in a seat,
          // so enter/leave system messages are not appropriate.
          // Classic chatroom: show "has left" for everyone including admins.
          let unsubIsPartyOwner = false;
          if (!room) {
            try {
              const pr = await db.execute(sql`SELECT created_by FROM party_rooms WHERE id = ${roomId} LIMIT 1`);
              if (pr.rows.length > 0) {
                unsubIsPartyOwner = (pr.rows[0] as any).created_by === client.userId;
              }
            } catch { /* not a party room */ }
          }
          if (!unsubIsPartyOwner) {
            const leaveDisplayName = withLevel(client.username!, client.migLevel);
            const leaveMsg = await storage.postMessage(roomId, {
              senderUsername: client.username!, senderColor: client.chatColor,
              text: `${room?.name ?? roomId}::${leaveDisplayName} has left`, isSystem: true,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
          }
          const list = await storage.getParticipants(roomId);
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
          botNotifyLeave(roomId, client.username!);
          break;
        }

        // ── SEND_MESSAGE ─────────────────────────────────────────────────────
        // Matches FusionPktMessage (500) in backend app
        case "SEND_MESSAGE": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" });
            return;
          }
          const { roomId, text } = msg;
          if (!roomId || !text?.trim()) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId dan text wajib" });
            return;
          }
          // Batas maksimum panjang pesan: 300 karakter. Diberlakukan di server
          // untuk konsisten — client juga membatasi via TextInput maxLength,
          // tapi guard ini melindungi terhadap client modifikasi/abuse.
          if (typeof text === "string" && text.length > 300) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Pesan tidak terkirim — pesan terlalu panjang (maksimal 300 karakter)" });
            return;
          }
          // Filter konten: tolak pesan yang berisi konfigurasi proxy/VPN
          // (V2Ray/VLESS/VMess/Trojan/SS), URI proxy, atau script tag. Pesan
          // semacam ini biasanya spam paste config yang tidak pantas di
          // chatroom. Lihat contentGuard.ts untuk daftar pola.
          {
            const cc = checkMessageContent(text);
            if (cc.blocked) {
              console.log(`[gateway] CONTENT BLOCKED: user=${client.username} reason=${cc.reason}`);
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: reasonToMessage(cc.reason) });
              return;
            }
          }
          // Anti-flood: cek throttling sebelum proses lebih lanjut. Konfigurasi
          // (enabled, maxMessages, windowMs, action) diatur dari panel admin via
          // tabel system_settings dan auto-refresh tiap 10 detik. Default: maks
          // 5 pesan per 3 detik → koneksi diputus.
          if (client.userId) {
            const f = floodCheck(client.userId);
            if (!f.allowed) {
              const seconds = Math.ceil(f.retryAfterMs / 1000);
              send(ws, {
                type: "ERROR",
                code: ErrorCode.UNDEFINED,
                message: `Terlalu cepat mengirim pesan (maks ${f.maxMessages} pesan / ${Math.round(f.windowMs / 1000)} dtk). ${f.action === "disconnect" ? "Koneksi diputus." : `Tunggu ${seconds} dtk.`}`,
              });
              if (f.action === "disconnect") {
                console.log(`[gateway] FLOOD: disconnecting user ${client.username} (${client.userId})`);
                clearUserFloodState(client.userId);
                try { ws.close(4008, "flood"); } catch {}
              }
              return;
            }
          }
          if (!client.subscribedRooms.has(roomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" });
            return;
          }
          // Resolve effective sender color — role overrides user-chosen color.
          // Mirrors ChatRoomParticipant.getMessageSourceColorOverride() from com/projectgoth/fusion:
          //   merchant/mentor → 990099 (purple) or merchant's usernameColor (preserved even if mod/owner)
          //   isOwner/isMod  → FCC504 (golden yellow) — only if NOT merchant/mentor
          //   regular user   → client.chatColor (user-chosen, default "2196F3")
          // Recompute fresh on every send so admin role/merchant changes
          // (e.g. deactivating a merchant from the admin panel) take effect
          // immediately without requiring the user to rejoin the room.
          const senderColor = await getRoleColor({
            userId: client.userId!,
            username: client.username!,
            roomId,
            defaultColor: client.chatColor,
          });
          client.roleColors.set(roomId, senderColor);

          // ── /gift command interceptor ────────────────────────────────────────
          // Matches Gift.java: /gift {recipient|all} {giftName} [-m {message}]
          // /gift all: shower format, billing msg to sender, balance check, rate limit
          const trimmed = text.trim();

          // Mute check — deferred until after slash-command parsing so that
          // admin/mod commands (/kick, /ban, /mute, /silence, etc.) are not blocked
          // when the executor themselves is somehow muted (edge case).
          // Regular chat messages are still blocked for muted users — EXCEPT for
          // the room owner, room moderators, and global admins, who can always
          // talk in any room they manage even if a previous mute is still active.
          const isAdminSlashCmd = /^\/(lock|unlock|kick|ban|mute|unmute|silence|unban|suspend|unsuspend|block|me|roll|brb|off|gift|g\s|bot|botstop|games|bal)(\s|$)/i.test(trimmed);
          if (!isAdminSlashCmd) {
            if (isMutedCached(roomId, client.userId!)) {
              const muteRoom         = await storage.getChatroom(roomId);
              const muteIsOwner      = muteRoom?.createdBy === client.userId;
              const muteIsMod        = await storage.isModUser(roomId, client.userId!);
              const muteIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
              if (!muteIsOwner && !muteIsMod && !muteIsGlobalAdmin) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Kamu sedang di-mute" });
                return;
              }
            }
          }
          if (/^\/g(?:ift)?\s+/i.test(trimmed)) {
            // /gift all (no giftName) — help message
            if (/^\/g(?:ift)?\s+all\s*$/i.test(trimmed)) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: 'To buy a gift for all users in this room, type "/gift all <gift name>". Type "/gift list" to see available gifts.' });
              return;
            }
            // Parse: /gift <recipient> <giftName> [-m <optional message>]
            const giftMatch = trimmed.match(/^\/g(?:ift)?\s+(\S+)\s+(\S+)(?:\s+-m\s+(.+))?$/i);
            if (!giftMatch) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Format: /gift {username|all} {gift_name} [-m message]" });
              return;
            }
            const [, giftRecipient, giftName, giftPersonalMsg] = giftMatch;
            const gift = await storage.getVirtualGiftByName(giftName);
            if (!gift) {
              // Matches Gift.java findVirtualGiftByName: "Sorry, there is no gift matching [giftName]"
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Sorry, there is no gift matching [${giftName}]` });
              return;
            }

            const senderUsername = client.username!;
            const senderDisplay  = withGiftLevel(senderUsername, await freshMigLevel(client));
            const isAll          = giftRecipient.toLowerCase() === "all";
            const article        = /^[aeiou]/i.test(giftName) ? "an" : "a";
            const hotkey         = gift.hotKey ?? "🎁";

            if (isAll) {
              // ── /gift all — Matches GiftAsync.giftAll() + GiftAllTask.java ──
              // Rate limit: once per 60 seconds per user (matches GiftAllRateLimitInSeconds)
              const now = Date.now();
              const lastSent = giftAllLastSent.get(senderUsername) ?? 0;
              if (now - lastSent < GIFT_ALL_RATE_LIMIT_MS) {
                const waitSec = Math.ceil((GIFT_ALL_RATE_LIMIT_MS - (now - lastSent)) / 1000);
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only use /gift all every 60 seconds. Try again in ${waitSec}s.` });
                return;
              }

              // Get all room participants (excluding sender) — matches getAllUsernamesInChat(false)
              const allParticipants = await storage.getParticipants(roomId);
              const recipients = allParticipants
                .map(p => p.username)
                .filter(u => u.toLowerCase() !== senderUsername.toLowerCase());

              if (recipients.length === 0) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "There are no other users in the room." });
                return;
              }

              // Balance check — matches GiftAsync: balance >= price * numRecipients
              const totalCost = gift.price * recipients.length;
              const acct      = await storage.getCreditAccount(senderUsername);
              if (acct.balance < totalCost) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
                return;
              }

              // Apply rate limit timestamp
              giftAllLastSent.set(senderUsername, now);

              // Deduct balance — matches GiftAllBiller.java billing step
              const updatedAll = await storage.adjustBalance(senderUsername, -totalCost);
              const remainingAcct = await storage.getCreditAccount(senderUsername);
              await storage.createCreditTransaction({
                username: senderUsername,
                type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
                reference: `GW-CMD-GIFT-ALL-${Date.now()}`,
                description: `Gift shower: ${giftName} ke ${recipients.length} user`,
                currency: remainingAcct.currency,
                amount: -totalCost,
                fundedAmount: 0,
                tax: 0,
                runningBalance: updatedAll.balance,
              });

              // Shower message — matches GiftAsync.sendGiftShowerMessageToAllUsersInChat()
              const recipientList = implodeUserList(recipients, 5);
              const wsGiftDisplay = gift.location64x64Png ? giftName : `${giftName} ${hotkey}`;
              let giftText = `<< (shower) *GIFT SHOWER* ${senderDisplay} gives ${article} ${wsGiftDisplay} to ${recipientList}! Hurray!`;
              if (giftPersonalMsg) giftText += ` -- ${giftPersonalMsg}`;
              giftText += " >>";

              const giftMsg = await storage.postMessage(roomId, {
                senderId: client.userId, senderUsername, senderColor,
                text: giftText, isSystem: false,
              });

              // Broadcast shower message + GIFT event to all in room
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: giftMsg });
              broadcastToRoom(roomId, {
                type: "GIFT", roomId,
                sender: senderUsername, senderColor,
                recipient: "all", giftName, giftEmoji: hotkey,
                giftImageUrl: gift.location64x64Png ?? undefined,
                price: totalCost, recipientCount: recipients.length,
                message: giftMsg,
                ...(giftPersonalMsg ? { personalMessage: giftPersonalMsg } : {}),
              });

              // Billing message — sent ONLY to sender (matches GiftAllBillingMessageData.java)
              send(ws, {
                type: "GIFT_BILLING",
                message: `Congratulations for sending gifts! You have used ${totalCost} ${remainingAcct.currency} and your estimated remaining balance after gifting will be ${remainingAcct.balance.toFixed(2)} ${remainingAcct.currency}.`,
                totalCost, remainingBalance: remainingAcct.balance, currency: remainingAcct.currency,
              });

              // Reputation: award gift XP to sender and each recipient
              recordGiftLeaderboardGW(senderUsername, recipients, recipients.length, totalCost);
              awardReputationScore(senderUsername, "giftSent", recipients.length).catch(() => {});
              for (const r of recipients) {
                awardReputationScore(r, "giftReceived").catch(() => {});
                // Persist into virtual_gifts_received so the recipient's profile
                // gift count + admin "Riwayat Gift Diterima" stays in sync with
                // /gift <user>. Previously /gift all only updated leaderboards.
                storage.createVirtualGiftReceived({
                  username: r,
                  sender: senderUsername,
                  virtualGiftId: gift.id,
                  message: `${giftName} ${hotkey}`.trim(),
                  isPrivate: 0,
                }).catch((err) => console.error('[gateway] /gift all createVirtualGiftReceived error:', err));
                // Notify each recipient — appears in the bell/Alerts tab.
                storage.createNotification({
                  username: r,
                  type: NOTIFICATION_TYPE.ALERT,
                  subject: 'Gift Received',
                  message: `${r} Receive a gift ${giftName} from ${senderUsername}`,
                  status: NOTIFICATION_STATUS.PENDING,
                }).catch((err) => console.error('[gateway] /gift all createNotification error:', err));
              }
              // ── Diamond reward (cmd /gift all) — only for active agency hosts ──
              const cmdAllDiamondPer = coinToDiamond(gift.price);
              if (cmdAllDiamondPer > 0) {
                const cmdAllRef = `GW-CMD-GIFT-ALL-${Date.now()}`;
                for (const r of recipients) {
                  isActiveAgencyHost(r).then(isHost => {
                    if (!isHost) return;
                    storage.adjustDiamondBalance(
                      r,
                      cmdAllDiamondPer,
                      "GIFT_RECEIVED",
                      `Gift shower dari @${senderUsername}: ${giftName} ${hotkey} (${gift.price} 🪙)`,
                      `${cmdAllRef}-${r}`,
                    ).then(newBal => {
                      broadcastToUsername(r, {
                        type: "DIAMOND_EARNED", amount: cmdAllDiamondPer, newBalance: newBal,
                        from: senderUsername, giftName,
                      } as any);
                    }).catch(() => {});
                  }).catch(() => {});
                }
              }

            } else {
              // ── /gift <username> <giftName> — single-user gift ──
              // Matches Gift.java handleGiftToUserEmote()
              const recipientLower = giftRecipient.toLowerCase();

              // Rate limit: 60s per sender+recipient+gift combo (matches GiftSingleRateLimitInSeconds)
              // Java: MemCachedRateLimiter.hit(VIRTUAL_GIFT_RATE_LIMIT, sender, recipient, giftId)
              const rlKey = `${senderUsername}:${recipientLower}:${giftName}`;
              const rlNow = Date.now();
              const rlLast = giftSingleRateLimitMap.get(rlKey) ?? 0;
              if (rlNow - rlLast < GIFT_SINGLE_RATE_LIMIT_MS) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only send the same gift to ${giftRecipient} every 60 seconds. Try sending a different gift.` });
                return;
              }

              // Balance check — matches Gift.java: "You do not have enough credit to purchase the gift"
              const sAcct = await storage.getCreditAccount(senderUsername);
              if (sAcct.balance < gift.price) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
                return;
              }

              // Apply rate limit and deduct credit — matches contentBean.buyVirtualGift(...)
              giftSingleRateLimitMap.set(rlKey, rlNow);
              const updatedSingle = await storage.adjustBalance(senderUsername, -gift.price);
              const singleAcct = await storage.getCreditAccount(senderUsername);
              await storage.createCreditTransaction({
                username: senderUsername,
                type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
                reference: `GW-CMD-GIFT-${Date.now()}`,
                description: `Gift: ${giftName} dikirim ke @${giftRecipient}`,
                currency: singleAcct.currency,
                amount: -gift.price,
                fundedAmount: 0,
                tax: 0,
                runningBalance: updatedSingle.balance,
              });

              // Format: << sender [level] gives a/an giftName to recipient [level]! -- msg >>
              // Matches Gift.java handleGiftToUserEmote lines 542-554
              const recipDisp  = await recipientDisplay(giftRecipient);
              const wsSingleDisplay = gift.location64x64Png ? giftName : `${giftName} ${hotkey}`;
              let giftText = `<< ${senderDisplay} gives ${article} ${wsSingleDisplay} to ${recipDisp}!`;
              if (giftPersonalMsg) giftText += ` -- ${giftPersonalMsg}`;
              giftText += " >>";

              const giftMsg = await storage.postMessage(roomId, {
                senderId: client.userId, senderUsername, senderColor,
                text: giftText, isSystem: false,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: giftMsg });
              broadcastToRoom(roomId, {
                type: "GIFT", roomId,
                sender: senderUsername, senderColor,
                recipient: giftRecipient, giftName, giftEmoji: hotkey,
                giftImageUrl: gift.location64x64Png ?? undefined,
                price: gift.price, message: giftMsg,
                ...(giftPersonalMsg ? { personalMessage: giftPersonalMsg } : {}),
              });

              // Leaderboard + Reputation for single gift
              recordGiftLeaderboardGW(senderUsername, [giftRecipient], 1, gift.price);
              awardReputationScore(senderUsername, "giftSent").catch(() => {});
              awardReputationScore(giftRecipient, "giftReceived").catch(() => {});
              // Record in virtual_gifts_received so profile gift count + admin
              // "Riwayat Gift Diterima" stay populated. Surface failures so we
              // catch schema/permission regressions instead of swallowing them.
              storage.createVirtualGiftReceived({
                username: giftRecipient,
                sender: senderUsername,
                virtualGiftId: gift.id,
                message: `${giftName} ${hotkey}`.trim(),
                isPrivate: 0,
              }).catch((err) => console.error('[gateway] /gift <user> createVirtualGiftReceived error:', err));
              // Notify recipient — bell badge + Alerts tab.
              storage.createNotification({
                username: giftRecipient,
                type: NOTIFICATION_TYPE.ALERT,
                subject: 'Gift Received',
                message: `${giftRecipient} Receive a gift ${giftName} from ${senderUsername}`,
                status: NOTIFICATION_STATUS.PENDING,
              }).catch((err) => console.error('[gateway] /gift <user> createNotification error:', err));
              // ── Diamond reward (cmd /gift <user>) — only for active agency hosts ──
              const cmdSingleDiamonds = coinToDiamond(gift.price);
              if (cmdSingleDiamonds > 0) {
                isActiveAgencyHost(giftRecipient).then(isHost => {
                  if (!isHost) return;
                  storage.adjustDiamondBalance(
                    giftRecipient,
                    cmdSingleDiamonds,
                    "GIFT_RECEIVED",
                    `Gift dari @${senderUsername}: ${giftName} ${hotkey} (${gift.price} 🪙)`,
                    `GW-CMD-GIFT-${Date.now()}-${giftRecipient}`,
                  ).then(newBal => {
                    broadcastToUsername(giftRecipient, {
                      type: "DIAMOND_EARNED", amount: cmdSingleDiamonds, newBalance: newBal,
                      from: senderUsername, giftName,
                    } as any);
                  }).catch(() => {});
                }).catch(() => {});
              }
            }
            break;
          }
          // ── End /gift interceptor ────────────────────────────────────────────

          // ── /bot, /botstop, /games slash command interceptor ────────────────
          // Mirrors ChatSession.sendFusionMessageToChatRoom() in Java:
          //   messageText.startsWith("/") → handleChatRoomCommand()
          //     /bot <gameType>  → StartBot.java  (admin/mod only)
          //     /bot stop        → StopBot.java   (admin/mod only)
          //     /botstop [! [timeout]] → StopAllBots.java (admin/mod only)
          //     /games           → SendGamesHelpToUser.java (all users)
          if (trimmed.startsWith("/bot") || /^\/games\b/i.test(trimmed)) {
            const slashArgs = trimmed.replace(/^\//, "").split(/\s+/);
            const slashCmd  = slashArgs[0]?.toLowerCase();

            // /games — available to all participants
            if (slashCmd === "games") {
              const games = getRegisteredGames();
              if (games.length === 0) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "No games in this room." });
              } else {
                for (const g of games) {
                  const helpMsg = await storage.postMessage(roomId, {
                    senderUsername: "System", senderColor: "DD587A",
                    text: `To start ${g}, type: /bot ${g}`, isSystem: true,
                  });
                  send(ws, { type: "MESSAGE", roomId, message: helpMsg });
                }
                const helpLink = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "DD587A",
                  text: "For help, see: migWorld", isSystem: true,
                });
                send(ws, { type: "MESSAGE", roomId, message: helpLink });
              }
              break;
            }

            // /bot and /botstop require admin/mod/global-admin
            const slashRoom = await storage.getChatroom(roomId);
            if (!slashRoom) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Room not found" }); return; }
            const slashIsOwner       = slashRoom.createdBy === client.userId;
            const slashIsMod         = await storage.isModUser(roomId, client.userId!);
            const slashIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
            if (!slashIsOwner && !slashIsMod && !slashIsGlobalAdmin) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You need to be owner/mod/admin to use this command." });
              break;
            }

            // /botstop [! [<timeout>]] — StopAllBots.java
            if (slashCmd === "botstop") {
              // arg[1] must be "!" to confirm all-stop
              if (slashArgs[1] !== "!") {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: 'Usage: /botstop ! [timeout in seconds, 120-3600]' });
                break;
              }
              const timeoutSec = slashArgs[2] ? parseInt(slashArgs[2], 10) : 0;
              if (slashArgs[2] && (isNaN(timeoutSec) || timeoutSec < 120 || timeoutSec > 3600)) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Timeout must be between 120 and 3600 seconds." });
                break;
              }
              const stopped = botStopBot(roomId);
              const stopMsg = stopped
                ? timeoutSec > 0
                  ? `All bots stopped by ${client.username}. Room bots blocked for ${timeoutSec}s.`
                  : `All bots stopped by ${client.username}.`
                : "No active bots to stop.";
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "DD587A",
                text: stopMsg, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              break;
            }

            // /bot stop [gamename] — StopBot.java
            if (slashCmd === "bot" && slashArgs[1]?.toLowerCase() === "stop") {
              const stopGameArg = slashArgs[2]?.toLowerCase();
              const activeBot   = botGetBot(roomId);

              if (stopGameArg) {
                // /bot stop <gamename> — only stop if the active game matches
                if (!activeBot) {
                  send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `No active game in this room.` });
                  break;
                }
                if (activeBot.gameType.toLowerCase() !== stopGameArg) {
                  send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `The active game is "${activeBot.gameType}", not "${stopGameArg}".` });
                  break;
                }
              }

              const stopped = botStopBot(roomId);
              const stopMsg = stopped
                ? stopGameArg
                  ? `Bot ${stopGameArg} in this room was stopped by ${client.username}.`
                  : `Bot was stopped by ${client.username}.`
                : "No active bot to stop.";
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "DD587A",
                text: stopMsg, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              break;
            }

            // /bot <gameType> — StartBot.java
            if (slashCmd === "bot" && slashArgs[1]) {
              const gameType = slashArgs[1].toLowerCase();
              if (!isRegisteredGame(gameType)) {
                const available = getRegisteredGames().join(", ");
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Unknown game "${gameType}". Available: ${available}` });
                break;
              }
              try {
                await botStartBot(roomId, gameType, client.username!);
                const startMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "DD587A",
                  text: `${client.username} started ${gameType}. Type !help for commands.`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: startMsg });
              } catch (err: any) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: err.message ?? "Failed to start bot." });
              }
              break;
            }

            // /bot with no subcommand — show usage
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: 'Usage: /bot <gameName> | /bot stop. Type /games for available games.' });
            break;
          }
          // ── End /bot,/botstop,/games slash command interceptor ───────────────

          // ── /me — mirrors Alias.java / ChatSession emote action ─────────
          // Usage: /me  → broadcasts just the username to everyone in room
          if (/^\/me(\s|$)/i.test(trimmed)) {
            const meMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "",
              senderColor: "800020", text: `${client.username}`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: meMsg });
            break;
          }

          // ── Emote commands (/slap, /kiss, /8ball, /hug, etc.) ───────────────
          {
            const emTokens  = trimmed.split(/\s+/);
            const emCmd     = emTokens[0].toLowerCase();
            const emTarget  = emTokens[1] ?? "";
            const s         = client.username!;
            const t         = emTarget;
            const EMOTE_COLOR = "800020";

            type EmoteDef = { action: string; actionTarget: string; random?: "roll" | "8ball" | "rps" };
            const EMOTES: Record<string, EmoteDef> = {
              "/slap":       { action: `* ${s} slaps himself`,                         actionTarget: `* ${s} slaps ${t}` },
              "/hug":        { action: `* ${s} gives himself a hug`,                   actionTarget: `* ${s} hugs ${t}` },
              "/kiss":       { action: `* ${s} blows a kiss to the room`,              actionTarget: `* ${s} kisses ${t}` },
              "/wave":       { action: `* ${s} waves`,                                  actionTarget: `* ${s} waves at ${t}` },
              "/dance":      { action: `* ${s} dances`,                                 actionTarget: `* ${s} dances with ${t}` },
              "/cry":        { action: `* ${s} cries`,                                  actionTarget: `* ${s} cries on ${t}'s shoulder` },
              "/laugh":      { action: `* ${s} laughs out loud`,                        actionTarget: `* ${s} laughs at ${t}` },
              "/poke":       { action: `* ${s} pokes himself`,                          actionTarget: `* ${s} pokes ${t}` },
              "/punch":      { action: `* ${s} punches the air`,                        actionTarget: `* ${s} punches ${t}` },
              "/love":       { action: `* ${s} has too much love to give`,              actionTarget: `* ${s} loves ${t}` },
              "/hi":         { action: `* ${s} waves hi to everyone`,                   actionTarget: `* ${s} waves hi at ${t}` },
              "/clap":       { action: `* ${s} claps`,                                  actionTarget: `* ${s} claps for ${t}` },
              "/bow":        { action: `* ${s} bows`,                                   actionTarget: `* ${s} bows to ${t}` },
              "/sit":        { action: `* ${s} sits down`,                              actionTarget: `* ${s} sits next to ${t}` },
              "/stand":      { action: `* ${s} stands up`,                              actionTarget: `* ${s} stands next to ${t}` },
              "/sleep":      { action: `* ${s} falls asleep`,                           actionTarget: `* ${s} falls asleep on ${t}'s shoulder` },
              "/yawn":       { action: `* ${s} yawns`,                                  actionTarget: `* ${s} yawns at ${t}` },
              "/facepalm":   { action: `* ${s} facepalms`,                              actionTarget: `* ${s} facepalms at ${t}` },
              "/shrug":      { action: `* ${s} shrugs`,                                 actionTarget: `* ${s} shrugs at ${t}` },
              "/lol":        { action: `* ${s} LOLs`,                                   actionTarget: `* ${s} LOLs at ${t}` },
              "/think":      { action: `* ${s} is thinking...`,                         actionTarget: `* ${s} is thinking about ${t}` },
              "/wink":       { action: `* ${s} winks`,                                  actionTarget: `* ${s} winks at ${t}` },
              "/smile":      { action: `* ${s} smiles`,                                 actionTarget: `* ${s} smiles at ${t}` },
              "/stare":      { action: `* ${s} stares into the void`,                   actionTarget: `* ${s} stares at ${t}` },
              "/shake":      { action: `* ${s} shakes his head`,                        actionTarget: `* ${s} shakes ${t}'s hand` },
              "/tackle":     { action: `* ${s} tackles himself`,                        actionTarget: `* ${s} tackles ${t}` },
              "/throw":      { action: `* ${s} throws something`,                       actionTarget: `* ${s} throws something at ${t}` },
              "/pat":        { action: `* ${s} pats himself on the back`,               actionTarget: `* ${s} pats ${t} on the head` },
              "/rofl":       { action: `* ${s} rolls on the floor laughing`,            actionTarget: `* ${s} rolls on the floor laughing at ${t}` },
              "/8ball":      { action: `* ${s} asks the Magic 8ball... %r`,             actionTarget: `* ${s} asks the Magic 8ball about ${t}... %r`, random: "8ball" },
              "/flip":       { action: `* ${s} flips a coin... It's %r!`,              actionTarget: `* ${s} flips a coin... It's %r!`, random: "roll" },
              "/rps":        { action: `* ${s} plays rock-paper-scissors... %r!`,       actionTarget: `* ${s} challenges ${t} to rock-paper-scissors... %r!`, random: "rps" },
            };

            const EIGHT_BALL_ANSWERS = ["Yep", "OK", "Maybe", "No", "Don't Bother", "Definitely", "Ask again later", "Not likely"];
            const RPS_CHOICES        = ["Rock 🪨", "Paper 📄", "Scissors ✂️"];

            function resolveEmoteRandom(type?: "roll" | "8ball" | "rps"): string {
              if (type === "roll")   return String(Math.floor(Math.random() * 100) + 1);
              if (type === "8ball")  return EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
              if (type === "rps")    return RPS_CHOICES[Math.floor(Math.random() * RPS_CHOICES.length)];
              return "";
            }

            const emoteDef = EMOTES[emCmd];
            if (emoteDef) {
              const rndVal    = resolveEmoteRandom(emoteDef.random);
              const template  = t ? emoteDef.actionTarget : emoteDef.action;
              const emoteText = template.replace(/%r/g, rndVal);
              const emoteMsg  = await storage.postMessage(roomId, {
                senderId: client.userId, senderUsername: "", senderColor: EMOTE_COLOR,
                text: emoteText, isSystem: false,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: emoteMsg });
              break;
            }
          }
          // ── End emote commands ───────────────────────────────────────────────

          // ── /bal — show user's balance, response visible only to sender ─────
          if (/^\/bal(\s|$)/i.test(trimmed)) {
            let balText = "Balance: 0";
            try {
              const acct = await storage.getCreditAccount(client.username!);
              const fmt  = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
              balText = `Balance: ${fmt.format(acct.balance)} ${acct.currency ?? "IDR"}`;
            } catch {
              balText = "Balance: 0";
            }
            send(ws, {
              type: "MESSAGE",
              roomId,
              message: {
                id:             `bal-${Date.now()}`,
                chatroomId:     roomId,
                senderId:       null,
                senderUsername: "",
                senderColor:    "800020",
                text:           balText,
                isSystem:       false,
                createdAt:      new Date().toISOString(),
              },
            });
            break;
          }

          // ── /go — public cheer ─────────────────────────────────────────────
          if (/^\/go(\s|$)/i.test(trimmed)) {
            const goMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} Cheer Go Team Goooo`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: goMsg });
            break;
          }

          // ── /goal — public goal cheer ──────────────────────────────────────
          if (/^\/goal(\s|$)/i.test(trimmed)) {
            const goalMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} GOAAAALLLL`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: goalMsg });
            break;
          }

          // ── /roll — dice roll 1-100 (emote style, no icon, no asterisk) ────
          if (/^\/roll(\s|$)/i.test(trimmed)) {
            const rollValue = Math.floor(Math.random() * 100) + 1;
            const rollMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} rolls ${rollValue}`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: rollMsg });
            break;
          }

          // ── /brb — be right back (emote style, no icon, no asterisk) ────────
          if (/^\/brb(\s|$)/i.test(trimmed)) {
            const brbMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} will be right back`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: brbMsg });
            break;
          }

          // ── /off — going offline (emote style, no icon, no asterisk) ─────────
          if (/^\/off(\s|$)/i.test(trimmed)) {
            const offMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} has been off`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: offMsg });
            break;
          }

          // ── Admin slash commands via SEND_MESSAGE text (mirrors Java emote routing) ──
          // Parse /lock, /unlock, /kick, /ban, /mute, /unmute, /silence, /unban, /suspend, /unsuspend, /block
          if (/^\/(lock|unlock|kick|ban|mute|unmute|silence|unban|suspend|unsuspend|block)(\s|$)/i.test(trimmed)) {
            const parts = trimmed.replace(/^\//, '').split(/\s+/);
            const slashCmd = parts[0].toLowerCase();
            const slashTarget = parts[1] ?? '';
            const slashRoom = await storage.getChatroom(roomId);
            if (!slashRoom) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Room not found" }); return; }
            const slashIsOwner = slashRoom.createdBy === client.userId;
            const slashIsMod   = await storage.isModUser(roomId, client.userId!);
            const slashIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
            const slashIsAdmin = slashIsGlobalAdmin || slashIsOwner || slashIsMod;

            if (slashCmd === 'lock' || slashCmd === 'unlock') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Only owner/mod can do this" }); return; }
              if (slashCmd === 'lock') {
                await storage.updateChatroom(roomId, { isLocked: true });
                const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "795548", text: "Chatroom has been locked. New members cannot join", isSystem: true });
                broadcastToRoom(roomId, { type: "LOCKED", roomId });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              } else {
                const unlockCapacity = slashRoom.createdBy ? await getRoomCapacityForUser(slashRoom.createdBy) : 25;
                await storage.updateChatroom(roomId, { isLocked: false, maxParticipants: unlockCapacity });
                const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "795548", text: "Chatroom has been unlocked. New members can join", isSystem: true });
                broadcastToRoom(roomId, { type: "UNLOCKED", roomId });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              }
              break;
            }

            // ── /silence (no target) → silence ALL non-admin users in the room ─
            // Owner/mod/global admin executes; only normal users get muted.
            if (slashCmd === 'silence' && !slashTarget) {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Only owner/mod can do this" }); return; }
              const allTimeoutSecs = parseInt(parts[1] ?? '60', 10);
              if (isNaN(allTimeoutSecs) || allTimeoutSecs < 1 || allTimeoutSecs > 86400) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /silence [seconds 1-86400] (no target = silence all users)" }); return;
              }
              const allParticipants = await storage.getParticipants(roomId);
              const silencedNames: string[] = [];
              for (const p of allParticipants) {
                // Skip the executor and any owner/mod/global-admin participant
                if (p.id === client.userId) continue;
                if (p.isOwner || p.isMod || p.isGlobalAdmin) continue;
                try {
                  await storage.silenceUser(roomId, p.id, p.username, allTimeoutSecs);
                  mutedCacheAdd(roomId, p.id);
                  silencedNames.push(p.username);
                  // Schedule auto-unmute
                  setTimeout(async () => {
                    try {
                      await storage.unmuteUser(roomId, p.id);
                      mutedCacheRemove(roomId, p.id);
                    } catch {}
                  }, allTimeoutSecs * 1000);
                } catch {}
              }
              const allMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `${client.username} silenced ${silencedNames.length} user${silencedNames.length !== 1 ? 's' : ''} for ${allTimeoutSecs} seconds.`,
                isSystem: true,
              });
              const allList = await storage.getParticipants(roomId);
              for (const name of silencedNames) {
                broadcastToRoom(roomId, { type: "MUTED", roomId, username: name });
              }
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: allMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, allList));
              setTimeout(async () => {
                try {
                  const endMsg = await storage.postMessage(roomId, {
                    senderUsername: "System", senderColor: "4CAF50",
                    text: `Silence-all telah berakhir. Semua user dapat chat kembali.`,
                    isSystem: true,
                  });
                  for (const name of silencedNames) {
                    broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: name });
                  }
                  broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: endMsg });
                } catch {}
              }, allTimeoutSecs * 1000);
              break;
            }

            if (!slashTarget) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Usage: /${slashCmd} [username]` }); return; }
            const slashTargetUser = await storage.getUserByUsername(slashTarget);
            if (!slashTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `User "${slashTarget}" not found` }); return; }

            if (slashCmd === 'kick') {
              // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be kicked
              const slashTargetIsProtected =
                slashRoom.createdBy === slashTargetUser.id ||
                await storage.isModUser(roomId, slashTargetUser.id) ||
                await storage.isGlobalAdmin(slashTargetUser.id);
              if (slashTargetIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin or moderator cannot be kicked" });
                break;
              }
              if (slashIsAdmin) {
                // Admin/mod direct kick — mirrors Kick.java admin path
                await storage.leaveChatroom(roomId, slashTargetUser.id);
              forceRemoveUserFromRoom(slashTargetUser.id, roomId, slashRoom.name, "kicked");
                const kickerLabel = slashIsGlobalAdmin
                  ? `administrator ${client.username}`
                  : client.username;
                const kickMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF4444",
                  text: `${slashTarget} has been kicked by ${kickerLabel}`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "KICKED", roomId, username: slashTarget });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: kickMsg });
                const pList = await storage.getParticipants(roomId);
                broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              } else {
                // Regular user vote kick — mirrors Kick.java voteToKickUser path
                const voteMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF8C00",
                  text: `${client.username} wants to kick ${slashTarget}. Type /kick ${slashTarget} to vote.`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: voteMsg });
              }
              break;
            }

            if (slashCmd === 'ban') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Only owner/mod can do this" }); return; }
              // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be banned
              const slashBanIsProtected =
                slashRoom.createdBy === slashTargetUser.id ||
                await storage.isModUser(roomId, slashTargetUser.id) ||
                await storage.isGlobalAdmin(slashTargetUser.id);
              if (slashBanIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin or moderator cannot be banned" });
                break;
              }
              await storage.banUser(roomId, slashTargetUser.id);
              forceRemoveUserFromRoom(slashTargetUser.id, roomId, slashRoom.name, "banned");
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF4444", text: `${slashTarget} has been banned from this chatroom`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "BANNED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              break;
            }

            if (slashCmd === 'mute') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Only owner/mod can do this" }); return; }
              // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be muted
              const slashMuteIsProtected =
                slashRoom.createdBy === slashTargetUser.id ||
                await storage.isModUser(roomId, slashTargetUser.id) ||
                await storage.isGlobalAdmin(slashTargetUser.id);
              if (slashMuteIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-mute" });
                break;
              }
              await storage.muteUser(roomId, slashTargetUser.id);
              mutedCacheAdd(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `${slashTarget} has been muted and cannot type`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              break;
            }

            if (slashCmd === 'unmute') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Only owner/mod can do this" }); return; }
              await storage.unmuteUser(roomId, slashTargetUser.id);
              mutedCacheRemove(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "4CAF50", text: `${slashTarget} has been unmuted`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              break;
            }

            if (slashCmd === 'silence') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Only owner/mod can do this" }); return; }
              // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be silenced
              const slashSilIsProtected =
                slashRoom.createdBy === slashTargetUser.id ||
                await storage.isModUser(roomId, slashTargetUser.id) ||
                await storage.isGlobalAdmin(slashTargetUser.id);
              if (slashSilIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-silence" });
                break;
              }
              const timeoutSecs = parseInt(parts[2] ?? '60', 10);
              if (isNaN(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > 86400) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /silence [username] [seconds 1-86400]" }); return;
              }
              await storage.silenceUser(roomId, slashTargetUser.id, slashTargetUser.username, timeoutSecs);
              mutedCacheAdd(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `${slashTarget} has been silenced for ${timeoutSecs} seconds. They will be unmuted automatically when the timer ends.`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              setTimeout(async () => {
                try {
                  await storage.unmuteUser(roomId, slashTargetUser.id);
                  mutedCacheRemove(roomId, slashTargetUser.id);
                  const unsilMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "4CAF50", text: `${slashTarget}'s silence has ended.`, isSystem: true });
                  broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: slashTarget });
                  broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unsilMsg });
                } catch {}
              }, timeoutSecs * 1000);
              break;
            }

            if (slashCmd === 'unban') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              await storage.unbanUser(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "4CAF50", text: `${slashTarget} telah di-unban dari chatroom`, isSystem: true });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              break;
            }

            if (slashCmd === 'suspend') {
              if (!slashIsGlobalAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya global admin yang bisa suspend user" }); return; }
              await storage.suspendUser(slashTargetUser.id);
              // Force-remove from room and terminate all connections
              await storage.leaveChatroom(roomId, slashTargetUser.id);
              forceRemoveUserFromRoom(slashTargetUser.id, roomId, slashRoom?.name ?? "", "kicked");
              for (const [sock, c] of clients) {
                if (c.userId === slashTargetUser.id) {
                  send(sock, { type: "AUTH_FAIL", code: "SUSPENDED", message: "Your account has been suspended" });
                  sock.terminate();
                }
              }
              const slashSuspList = await storage.getParticipants(roomId);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "F47422", text: `${slashTarget} telah di-suspend oleh administrator`, isSystem: true });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom?.name ?? "", slashSuspList));
              break;
            }

            if (slashCmd === 'unsuspend') {
              if (!slashIsGlobalAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya global admin yang bisa unsuspend user" }); return; }
              await storage.unsuspendUser(slashTargetUser.id);
              const unsuspMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "4CAF50",
                text: `${slashTarget} telah dipulihkan (unsuspend) oleh administrator`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unsuspMsg });
              send(ws, { type: "CMD_OK", cmd: "unsuspend", target: slashTarget });
              break;
            }

            if (slashCmd === 'block') {
              await storage.blockUserGlobal(client.username!, slashTarget);
              const blockMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "607D8B", text: `Kamu tidak akan melihat pesan dari ${slashTarget} lagi.`, isSystem: true });
              send(ws, { type: "MESSAGE", roomId, message: blockMsg });
              break;
            }
            break;
          }

          // ── Bot command interceptor ──────────────────────────────────────────
          // Route !commands to the active bot game in this room (if any).
          // Mirrors ChatSession.sendFusionMessageToChatRoom(): messageText.startsWith("!")
          //   → chatRoomPrx.sendMessageToBots(username, text, receivedTimestamp)
          // When handled by the bot, skip normal message posting.
          if (trimmed.startsWith("!") && botProcessMessage(roomId, client.username!, trimmed)) {
            break;
          }
          // ── End bot command interceptor ──────────────────────────────────────

          // Broadcast-first: build message in-memory, broadcast immediately, persist async.
          // Mirrors Java ChatRoom.broadcastMessage() which delivers to all participants
          // before writing to the message store, keeping latency perceptible for senders.
          const msgId = randomUUID();
          const message: import("@shared/schema").ChatroomMessage = {
            id: msgId, chatroomId: roomId,
            senderId: client.userId ?? null,
            senderUsername: client.username!,
            senderColor, text: text.trim(),
            isSystem: false, createdAt: new Date(),
          };
          const senderAgencyName = await getAgencyNameForUser(client.username!);
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: { ...message, senderMigLevel: client.migLevel ?? 1, senderAgencyName, senderAvatarUrl: client.displayPicture, senderDisplayName: client.displayName ?? client.username! } });
          storage.postMessage(roomId, {
            id: msgId, senderId: client.userId, senderUsername: client.username!,
            senderColor, text: text.trim(),
          }).catch((err) => console.error("[gateway] postMessage failed:", err));
          awardReputationScore(client.username!, "chatRoomMessage", 1, { text: text.trim() }).catch(() => {});
          break;
        }

        // ── PARTY_MUSIC — sync music playback to all room members ─────────────
        case "PARTY_MUSIC": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: pmRoomId, action: pmAction, trackId, trackTitle, trackArtist, previewUrl, coverUri } = msg;
          if (!pmRoomId || !pmAction) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId dan action wajib" }); return;
          }
          if (!client.subscribedRooms.has(pmRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          broadcastToRoom(pmRoomId, {
            type: "PARTY_MUSIC",
            roomId: pmRoomId,
            action: pmAction,
            sender: client.username!,
            trackId,
            trackTitle,
            trackArtist,
            previewUrl,
            coverUri,
          });
          break;
        }

        // ── SEND_STICKER — relay sticker animation to all room members ──────
        case "SEND_STICKER": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: stRoomId, stickerId, seatIndex: stSeatIdx } = msg;
          if (!stRoomId || !stickerId) break;
          if (!client.subscribedRooms.has(stRoomId)) break;
          broadcastToRoom(stRoomId, {
            type: "PARTY_STICKER",
            roomId: stRoomId,
            stickerId,
            seatIndex: stSeatIdx,
            sender: client.username!,
          });
          break;
        }

        // ── SEAT_COUNT — owner changes number of seats live ───────────────────
        case "SEAT_COUNT": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: scRoomId, count: scCount } = msg;
          if (!scRoomId) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId wajib" }); return;
          }
          if (!client.subscribedRooms.has(scRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          const safeCount = Number(scCount);
          if (!Number.isInteger(safeCount) || safeCount < 2 || safeCount > 30) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Jumlah kursi tidak valid" }); return;
          }
          broadcastToRoom(scRoomId, { type: "SEAT_COUNT", roomId: scRoomId, count: safeCount });
          break;
        }

        // ── SEAT_MODE — owner toggles kursi bebas on/off ──────────────────────
        case "SEAT_MODE": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: smRoomId, freeSeat: smFree } = msg;
          if (!smRoomId) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId wajib" }); return;
          }
          if (!client.subscribedRooms.has(smRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          // Persist to DB
          try {
            await db.execute(sql`
              UPDATE party_rooms SET free_seat = ${smFree !== false}, updated_at = NOW()
              WHERE id = ${smRoomId}
            `);
          } catch (e) {
            console.error("[gateway/SEAT_MODE] db error:", e);
          }
          broadcastToRoom(smRoomId, { type: "SEAT_MODE", roomId: smRoomId, freeSeat: smFree !== false });
          break;
        }

        // ── SEAT_REQUEST — member minta izin duduk di kursi (mode approval) ───
        case "SEAT_REQUEST": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: srRoomId, seatIndex: srSeat } = msg;
          if (!srRoomId || !srSeat) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId dan seatIndex wajib" }); return;
          }
          if (!client.subscribedRooms.has(srRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          // Broadcast request ke semua member (host/admin akan handle di client)
          broadcastToRoom(srRoomId, {
            type: "SEAT_REQUEST",
            roomId: srRoomId,
            seatIndex: srSeat,
            requester: client.username!,
          });
          break;
        }

        // ── SEAT_APPROVE — host/admin menyetujui request kursi ───────────────
        case "SEAT_APPROVE": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: saRoomId, seatIndex: saSeat, requester: saRequester } = msg;
          if (!saRoomId || !saSeat || !saRequester) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId, seatIndex, requester wajib" }); return;
          }
          if (!client.subscribedRooms.has(saRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          broadcastToRoom(saRoomId, { type: "SEAT_APPROVE", roomId: saRoomId, seatIndex: saSeat, requester: saRequester });
          break;
        }

        // ── SEAT_DENY — host/admin menolak request kursi ─────────────────────
        case "SEAT_DENY": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: sdRoomId, seatIndex: sdSeat, requester: sdRequester } = msg;
          if (!sdRoomId || !sdSeat || !sdRequester) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId, seatIndex, requester wajib" }); return;
          }
          if (!client.subscribedRooms.has(sdRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          broadcastToRoom(sdRoomId, { type: "SEAT_DENY", roomId: sdRoomId, seatIndex: sdSeat, requester: sdRequester });
          break;
        }

        // ── SEAT_LOCK — owner/admin kunci/buka kursi, persist ke DB + broadcast ─
        case "SEAT_LOCK": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: slRoomId, seatIndex: slSeat, locked: slLocked } = msg;
          if (!slRoomId || slSeat == null || slLocked == null) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId, seatIndex, locked wajib" }); return;
          }
          if (!client.subscribedRooms.has(slRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          // Persist ke DB agar pengguna baru yang join tahu state kunci terkini
          try {
            await db.execute(sql`
              UPDATE party_seats SET is_locked = ${slLocked}
              WHERE party_room_id = ${slRoomId} AND seat_index = ${slSeat}
            `);
          } catch (e) {
            console.error("[gateway/SEAT_LOCK] db error:", e);
          }
          broadcastToRoom(slRoomId, { type: "SEAT_LOCK", roomId: slRoomId, seatIndex: slSeat, locked: slLocked });
          break;
        }

        // ── SEAT_MUTED — host/admin mute/unmute kursi, broadcast ke semua ─────
        case "SEAT_MUTED": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: smutRoomId, seatIndex: smutSeat, muted: smutMuted, targetUsername: smutTarget } = msg;
          if (!smutRoomId || smutSeat == null || smutMuted == null || !smutTarget) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId, seatIndex, muted, targetUsername wajib" }); return;
          }
          if (!client.subscribedRooms.has(smutRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          broadcastToRoom(smutRoomId, {
            type: "SEAT_MUTED",
            roomId: smutRoomId,
            seatIndex: smutSeat,
            muted: smutMuted,
            targetUsername: smutTarget,
          });
          break;
        }

        // ── SEND_GIFT ─────────────────────────────────────────────────────────
        // Matches /gift [recipient|all] [giftName] from ChatController.java
        // When recipient === "all": shower format + billing msg (matches GiftAsync.java)
        case "SEND_GIFT": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: gRoomId, recipient, giftName, giftEmoji = "🎁", giftMessage, qty: gQty = 1 } = msg;
          const giftQty = Math.max(1, Math.min(1000, Number(gQty) || 1));
          if (!gRoomId || !recipient || !giftName) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId, recipient, dan giftName wajib" }); return;
          }
          if (!client.subscribedRooms.has(gRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          const gSenderUsername = client.username!;
          const gSenderDisplay  = withGiftLevel(gSenderUsername, await freshMigLevel(client));
          const gArticle        = /^[aeiou]/i.test(giftName) ? "an" : "a";
          const gHotkey         = giftEmoji;
          // Recompute role color fresh so admin merchant changes (e.g. deactivation)
          // take effect immediately without requiring the user to rejoin.
          const gSenderColor    = await getRoleColor({
            userId: client.userId!,
            username: gSenderUsername,
            roomId: gRoomId,
            defaultColor: client.chatColor,
          });
          client.roleColors.set(gRoomId, gSenderColor);

          // Look up gift from catalog — coba party_gifts dulu, fallback ke virtual_gifts
          let giftRecord: any = null;
          let giftPrice = (msg as any).price ?? 10;
          try {
            const pgRes = await db.execute(sql`
              SELECT id, name, price, category, emoji, image_url, lottie_url, video_url
              FROM party_gifts WHERE name ILIKE ${giftName.trim()} AND is_active = true LIMIT 1
            `);
            if (pgRes.rows.length > 0) {
              giftRecord = pgRes.rows[0];
              giftPrice  = Number((pgRes.rows[0] as any).price) || giftPrice;
            }
          } catch {}
          if (!giftRecord) {
            const vg = await storage.getVirtualGiftByName(giftName);
            if (vg) { giftRecord = vg; giftPrice = vg.price ?? giftPrice; }
          }

          const isAll = recipient.toLowerCase() === "all";

          // ── Detect party room vs classic room (sekali, dipakai di semua path) ──
          // Classic room: participants tracked via participantsMap (storage)
          // Party room:   participants tracked via active WS connections (roomClients)
          // Cek DB eksplisit — classic room logic sama sekali tidak tersentuh.
          let isPartyRoomGift = false;
          try {
            const prCheck = await db.execute(sql`SELECT id FROM party_rooms WHERE id = ${gRoomId} LIMIT 1`);
            isPartyRoomGift = prCheck.rows.length > 0;
          } catch { /* not a party room */ }

          // Lucky gifts in party rooms bypass the rate limit — balance check already
          // enforces spend limits, and client batches taps into a single send.
          const isLuckyPartyGift = isPartyRoomGift
            && String((giftRecord as any)?.category ?? '').toLowerCase() === 'lucky';

          if (isAll) {
            // ── SEND_GIFT all — shower format (matches GiftAsync.giftAll) ──
            // Party rooms have no rate limit — balance check enforces spend limits.
            // Rate limit only applies to classic rooms.
            if (!isPartyRoomGift) {
              const now      = Date.now();
              const lastSent = giftAllLastSent.get(gSenderUsername) ?? 0;
              if (now - lastSent < GIFT_ALL_RATE_LIMIT_MS) {
                const waitSec = Math.ceil((GIFT_ALL_RATE_LIMIT_MS - (now - lastSent)) / 1000);
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only use /gift all every 60 seconds. Try again in ${waitSec}s.` });
                return;
              }
              giftAllLastSent.set(gSenderUsername, now);
            }

            let gRecipients: string[];

            if (isPartyRoomGift) {
              // Party room: ambil dari party_seats DB — lebih reliable dari WS connections.
              // WS bisa disconnect sementara; tapi user tetap "duduk" di kursi.
              const seatedRes = await db.execute(sql`
                SELECT username FROM party_seats
                WHERE party_room_id = ${gRoomId}
                  AND username IS NOT NULL
                  AND LOWER(username) != LOWER(${gSenderUsername})
              `);
              gRecipients = seatedRes.rows
                .map((r: any) => r.username as string)
                .filter(Boolean);
            } else {
              // Classic room: unchanged — persis seperti di production
              const allParts = await storage.getParticipants(gRoomId);
              gRecipients = allParts
                .map(p => p.username)
                .filter(u => u.toLowerCase() !== gSenderUsername.toLowerCase());
            }

            if (gRecipients.length === 0) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "There are no other users in the room." });
              return;
            }
            const gTotalCost = giftPrice * giftQty * gRecipients.length;
            const gAcct      = await storage.getCreditAccount(gSenderUsername);
            if (gAcct.balance < gTotalCost) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
              return;
            }
            const gUpdatedAll = await storage.adjustBalance(gSenderUsername, -gTotalCost);
            const gAcctAll    = await storage.getCreditAccount(gSenderUsername);
            await storage.createCreditTransaction({
              username: gSenderUsername,
              type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
              reference: `GW-GIFT-ALL-${Date.now()}`,
              description: `Gift shower: ${giftName} ke ${gRecipients.length} user`,
              currency: gAcctAll.currency,
              amount: -gTotalCost,
              fundedAmount: 0,
              tax: 0,
              runningBalance: gUpdatedAll.balance,
            }).catch((err) => console.error('[gateway] SEND_GIFT-ALL createCreditTransaction error:', err));
            const gRemaining = gAcctAll;

            // Shower message — matches GiftAsync.sendGiftShowerMessageToAllUsersInChat()
            const gRecipList = implodeUserList(gRecipients, 5);
            let giftText = `<< (shower) *GIFT SHOWER* ${gSenderDisplay} gives ${gArticle} ${giftName} ${gHotkey} to ${gRecipList}! Hurray!`;
            if (giftMessage) giftText += ` -- ${giftMessage}`;
            giftText += " >>";

            const giftMsg = await storage.postMessage(gRoomId, {
              senderId: client.userId, senderUsername: gSenderUsername,
              senderColor: gSenderColor, text: giftText, isSystem: false,
            });
            broadcastToRoom(gRoomId, { type: "MESSAGE", roomId: gRoomId, message: giftMsg });
            broadcastToRoom(gRoomId, {
              type: "GIFT", roomId: gRoomId,
              sender: gSenderUsername, senderColor: gSenderColor,
              recipient: "all", giftName, giftEmoji: gHotkey,
              giftImageUrl: (giftRecord as any)?.image_url ?? (giftRecord as any)?.location64x64Png ?? undefined,
              giftCategory: (giftRecord as any)?.category ?? undefined,
              lottieUrl: (giftRecord as any)?.lottie_url ?? (giftRecord as any)?.lottieUrl ?? undefined,
              videoUrl: (giftRecord as any)?.video_url ?? (giftRecord as any)?.videoUrl ?? undefined,
              qty: giftQty, price: gTotalCost, unitPrice: giftPrice, recipientCount: gRecipients.length,
              message: giftMsg,
              ...(giftMessage ? { personalMessage: giftMessage } : {}),
            });
            // Billing message to sender only — matches GiftAllBillingMessageData.java
            send(ws, {
              type: "GIFT_BILLING",
              message: `Congratulations for sending gifts! You have used ${gTotalCost} ${gRemaining.currency} and your estimated remaining balance after gifting will be ${gRemaining.balance.toFixed(2)} ${gRemaining.currency}.`,
              totalCost: gTotalCost, remainingBalance: gRemaining.balance, currency: gRemaining.currency,
            });
            // ── Diamond reward — Lucky: 2%, Luxury: 30% (3×), Normal: 10% ──
            const isLuckyGift   = isPartyRoomGift && (giftRecord as any)?.category?.toLowerCase() === 'lucky';
            const isLuxuryGift  = isPartyRoomGift && (giftRecord as any)?.category?.toLowerCase() === 'luxury';
            const gDiamondPerRecip = isLuckyGift
              ? Math.floor(giftPrice * giftQty * 0.02)      // Lucky:  2%  (100 coin → 2 diamond)
              : isLuxuryGift
                ? luxuryCoinToDiamond(giftPrice * giftQty)  // Luxury: 30% (10 coin → 3 diamond)
                : coinToDiamond(giftPrice * giftQty);        // Normal: 10% (10 coin → 1 diamond)
            if (isPartyRoomGift) {
              recordPartyGiftLeaderboardGW(gSenderUsername, gRecipients, gTotalCost, gDiamondPerRecip);
              db.execute(sql`
                INSERT INTO party_income_log (room_id, sender_username, gift_name, coin_amount, diamond_amount, gift_qty)
                VALUES (${gRoomId}, ${gSenderUsername}, ${giftName}, ${gTotalCost}, ${gDiamondPerRecip * gRecipients.length}, ${giftQty * gRecipients.length})
              `).catch(() => {});
            } else {
              recordGiftLeaderboardGW(gSenderUsername, gRecipients, gRecipients.length, gTotalCost);
            }
            awardReputationScore(gSenderUsername, "giftSent", gRecipients.length).catch(() => {});
            for (const gr of gRecipients) {
              awardReputationScore(gr, "giftReceived").catch(() => {});
              storage.createVirtualGiftReceived({
                username: gr,
                sender: gSenderUsername,
                virtualGiftId: giftRecord?.id ?? 0,
                message: `${giftName} ${gHotkey}`.trim(),
                isPrivate: 0,
              }).catch(() => {});
              storage.createNotification({
                username: gr,
                type: 'ALERT',
                subject: 'Gift Received',
                message: `@${gSenderUsername} sent you a gift: ${giftName} ${gHotkey}`,
                status: 1,
              }).catch(() => {});
            }
            // ── Update seat_diamonds + seat_coins in DB for all seated recipients ──
            if (isPartyRoomGift) {
              // seat_diamonds: untuk WD — Lucky 2%, Luxury 30%, Normal 10%
              const seatDiamondsAdd = isLuckyGift
                ? Math.floor(giftPrice * giftQty * 0.02)
                : isLuxuryGift
                  ? luxuryCoinToDiamond(giftPrice * giftQty)
                  : Math.floor(giftPrice * giftQty / 10);
              // seat_coins: tampilan UI — selalu 100% coin (gift price × qty)
              const seatCoinsAdd = giftPrice * giftQty;
              for (const gr of gRecipients) {
                db.execute(sql`
                  UPDATE party_seats
                  SET seat_diamonds = COALESCE(seat_diamonds, 0) + ${seatDiamondsAdd},
                      seat_coins    = COALESCE(seat_coins, 0)    + ${seatCoinsAdd},
                      updated_at = NOW()
                  WHERE party_room_id = ${gRoomId} AND LOWER(username) = LOWER(${gr})
                `).catch(() => {});
              }
            }
            if (gDiamondPerRecip > 0) {
              const gDiamondRef = `GW-GIFT-ALL-${Date.now()}`;
              for (const gr of gRecipients) {
                isActiveAgencyHost(gr).then(isHost => {
                  if (!isHost) return;
                  storage.adjustDiamondBalance(
                    gr,
                    gDiamondPerRecip,
                    "GIFT_RECEIVED",
                    `Gift shower dari @${gSenderUsername}: ${giftName} ${gHotkey} (${giftPrice} 🪙)${isLuckyGift ? ' [Lucky 2%]' : ''}`,
                    `${gDiamondRef}-${gr}`,
                  ).then(newBal => {
                    broadcastToUsername(gr, {
                      type: "DIAMOND_EARNED", amount: gDiamondPerRecip, newBalance: newBal,
                      from: gSenderUsername, giftName,
                    } as any);
                  }).catch(() => {});
                }).catch(() => {});
              }
            }
            // ── Lucky Gift JP — hanya untuk gift kategori "Lucky" di party room ──
            if (isLuckyGift) {
              processLuckyGiftJP(gRoomId, gSenderUsername, giftQty * gRecipients.length, giftPrice, gHotkey, giftName).catch(() => {});
            }
            // ── Luxury Broadcast Global — broadcast ke semua room party ──
            if (isLuxuryGift) {
              (async () => {
                const senderDN = client.displayName ?? gSenderUsername;
                const hostRes  = await db.execute(sql`SELECT created_by FROM party_rooms WHERE id = ${gRoomId} LIMIT 1`);
                const hostUser = (hostRes.rows[0] as any)?.created_by ?? (gRecipients[0] ?? gSenderUsername);
                const recipDN  = await getUserDisplayName(hostUser);
                broadcastToAllClients({
                  type:                 'LUXURY_BROADCAST_GLOBAL',
                  senderDisplayName:    senderDN,
                  recipientDisplayName: recipDN,
                  giftName,
                  giftImageUrl:         (giftRecord as any)?.image_url ?? undefined,
                  giftEmoji:            gHotkey,
                  roomName:             gRoomId,
                });
              })().catch(() => {});
            }
          } else {
            // ── SEND_GIFT single user — matches Gift.java handleGiftToUserEmote() ──
            const gRecipientLower = recipient.toLowerCase();

            // Rate limit: 5s per sender+recipient+gift combo — classic rooms only.
            // Party rooms skip rate limit; balance check enforces spend limits.
            if (!isPartyRoomGift) {
              const gRlKey  = `${gSenderUsername}:${gRecipientLower}:${giftName}`;
              const gRlNow  = Date.now();
              const gRlLast = giftSingleRateLimitMap.get(gRlKey) ?? 0;
              if (gRlNow - gRlLast < GIFT_SINGLE_RATE_LIMIT_MS) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only send the same gift to ${recipient} every 60 seconds. Try sending a different gift.` });
                return;
              }
              giftSingleRateLimitMap.set(gRlKey, gRlNow);
            }

            // Balance check — "You do not have enough credit to purchase the gift"
            const gSingleCost = giftPrice * giftQty;
            const gSAcct = await storage.getCreditAccount(gSenderUsername);
            if (gSAcct.balance < gSingleCost) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
              return;
            }
            const gUpdatedSingle = await storage.adjustBalance(gSenderUsername, -gSingleCost);
            const gAcctSingle    = await storage.getCreditAccount(gSenderUsername);
            await storage.createCreditTransaction({
              username: gSenderUsername,
              type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
              reference: `GW-GIFT-${Date.now()}`,
              description: `Gift: ${giftQty}x ${giftName} dikirim ke @${recipient}`,
              currency: gAcctSingle.currency,
              amount: -gSingleCost,
              fundedAmount: 0,
              tax: 0,
              runningBalance: gUpdatedSingle.balance,
            }).catch((err) => console.error('[gateway] SEND_GIFT createCreditTransaction error:', err));

            // Format: << sender [level] gives a/an giftName hotKey to recipient [level]! -- msg >>
            const displayRecip = await recipientDisplay(recipient);
            const gQtyPrefix = giftQty > 1 ? `${giftQty}x ` : "";
            let giftText = `<< ${gSenderDisplay} gives ${gQtyPrefix}${giftName} ${gHotkey} to ${displayRecip}!`;
            if (giftMessage) giftText += ` -- ${giftMessage}`;
            giftText += " >>";

            const giftMsg = await storage.postMessage(gRoomId, {
              senderId: client.userId, senderUsername: gSenderUsername,
              senderColor: gSenderColor, text: giftText, isSystem: false,
            });
            broadcastToRoom(gRoomId, { type: "MESSAGE", roomId: gRoomId, message: giftMsg });
            broadcastToRoom(gRoomId, {
              type: "GIFT", roomId: gRoomId,
              sender: gSenderUsername, senderColor: gSenderColor,
              recipient, giftName, giftEmoji: gHotkey, price: gSingleCost, unitPrice: giftPrice, qty: giftQty,
              giftImageUrl: (giftRecord as any)?.image_url ?? (giftRecord as any)?.location64x64Png ?? undefined,
              giftCategory: (giftRecord as any)?.category ?? undefined,
              lottieUrl: (giftRecord as any)?.lottie_url ?? (giftRecord as any)?.lottieUrl ?? undefined,
              videoUrl: (giftRecord as any)?.video_url ?? (giftRecord as any)?.videoUrl ?? undefined,
              message: giftMsg,
              ...(giftMessage ? { personalMessage: giftMessage } : {}),
            });
            // ── Diamond reward — Lucky: 2%, Luxury: 30% (3×), Normal: 10% ──
            const isLuckyGiftSingle  = isPartyRoomGift && (giftRecord as any)?.category?.toLowerCase() === 'lucky';
            const isLuxuryGiftSingle = isPartyRoomGift && (giftRecord as any)?.category?.toLowerCase() === 'luxury';
            const sDiamonds = isLuckyGiftSingle
              ? Math.floor(gSingleCost * 0.02)        // Lucky:  2%  (100 coin → 2 diamond)
              : isLuxuryGiftSingle
                ? luxuryCoinToDiamond(gSingleCost)    // Luxury: 30% (10 coin → 3 diamond)
                : coinToDiamond(gSingleCost);          // Normal: 10% (10 coin → 1 diamond)
            if (isPartyRoomGift) {
              recordPartyGiftLeaderboardGW(gSenderUsername, [recipient], gSingleCost, sDiamonds);
              db.execute(sql`
                INSERT INTO party_income_log (room_id, sender_username, gift_name, coin_amount, diamond_amount, gift_qty)
                VALUES (${gRoomId}, ${gSenderUsername}, ${giftName}, ${gSingleCost}, ${sDiamonds}, ${giftQty})
              `).catch(() => {});
            } else {
              recordGiftLeaderboardGW(gSenderUsername, [recipient], 1, gSingleCost);
            }
            awardReputationScore(gSenderUsername, "giftSent").catch(() => {});
            awardReputationScore(recipient, "giftReceived").catch(() => {});
            // Record in virtual_gifts_received so profile gift count is persisted
            storage.createVirtualGiftReceived({
              username: recipient,
              sender: gSenderUsername,
              virtualGiftId: giftRecord?.id ?? 0,
              message: `${giftName} ${gHotkey}`.trim(),
              isPrivate: 0,
            }).catch(() => {});
            // Notify recipient — appears in the Alerts tab of NotificationsModal
            storage.createNotification({
              username: recipient,
              type: 'ALERT',
              subject: 'Gift Received',
              message: `@${gSenderUsername} sent you a gift: ${giftName} ${gHotkey}`,
              status: 1,
            }).catch(() => {});
            // ── Update seat_diamonds + seat_coins in DB for seated recipient ──
            if (isPartyRoomGift) {
              // seat_diamonds: untuk WD — Lucky 2%, Luxury 30%, Normal 10%
              const seatDiamondsAdd = isLuckyGiftSingle
                ? Math.floor(gSingleCost * 0.02)
                : isLuxuryGiftSingle
                  ? luxuryCoinToDiamond(gSingleCost)
                  : Math.floor(gSingleCost / 10);
              // seat_coins: tampilan UI — selalu 100% coin (gift price × qty)
              const seatCoinsAdd = gSingleCost;
              db.execute(sql`
                UPDATE party_seats
                SET seat_diamonds = COALESCE(seat_diamonds, 0) + ${seatDiamondsAdd},
                    seat_coins    = COALESCE(seat_coins, 0)    + ${seatCoinsAdd},
                    updated_at = NOW()
                WHERE party_room_id = ${gRoomId} AND LOWER(username) = LOWER(${recipient})
              `).catch(() => {});
            }
            if (sDiamonds > 0) {
              isActiveAgencyHost(recipient).then(isHost => {
                if (!isHost) return;
                storage.adjustDiamondBalance(
                  recipient,
                  sDiamonds,
                  "GIFT_RECEIVED",
                  `Gift dari @${gSenderUsername}: ${giftQty}x ${giftName} ${gHotkey} (${gSingleCost} 🪙)${isLuckyGiftSingle ? ' [Lucky 2%]' : ''}`,
                  `GW-GIFT-${Date.now()}-${recipient}`,
                ).then(newBal => {
                  broadcastToUsername(recipient, {
                    type: "DIAMOND_EARNED", amount: sDiamonds, newBalance: newBal,
                    from: gSenderUsername, giftName,
                  } as any);
                }).catch(() => {});
              }).catch(() => {});
            }
            // ── Lucky Gift JP — hanya untuk gift kategori "Lucky" di party room ──
            if (isLuckyGiftSingle) {
              processLuckyGiftJP(gRoomId, gSenderUsername, giftQty, giftPrice, gHotkey, giftName).catch(() => {});
            }
            // ── Luxury Broadcast Global — broadcast ke semua room party ──
            if (isLuxuryGiftSingle) {
              (async () => {
                const senderDN = client.displayName ?? gSenderUsername;
                const recipDN  = await getUserDisplayName(recipient);
                broadcastToAllClients({
                  type:                 'LUXURY_BROADCAST_GLOBAL',
                  senderDisplayName:    senderDN,
                  recipientDisplayName: recipDN,
                  giftName,
                  giftImageUrl:         (giftRecord as any)?.image_url ?? undefined,
                  giftEmoji:            gHotkey,
                  roomName:             gRoomId,
                });
              })().catch(() => {});
            }
          }
          break;
        }

        // ── GET_COLORS ────────────────────────────────────────────────────────
        // Matches FusionPktDataTextColor (packet 924) — returns available color palettes
        case "GET_COLORS": {
          send(ws, { type: "COLOR_LIST", senderColors: TEXT_SENDER_COLORS, messageColors: TEXT_MESSAGE_COLORS });
          break;
        }

        // ── SET_COLOR ─────────────────────────────────────────────────────────
        // Lets user change their chat username color from the TEXT_COLOR palette
        case "SET_COLOR": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { color } = msg;
          if (!TEXT_SENDER_COLORS.includes(color.replace(/^#/, ""))) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Warna tidak valid. Gunakan GET_COLORS untuk daftar warna." }); return;
          }
          client.chatColor = color.replace(/^#/, "");
          // Update roleColors cache for all subscribed rooms — if user's cached color
          // is not a role-specific special color (owner/mod=FCC504, merchant=990099 etc.),
          // replace it with the new chatColor so SEND_MESSAGE immediately picks up the change.
          const ROLE_SPECIAL_COLORS = new Set(["FCC504", "990099", "F47422", "FF2EA7", "FF0000"]);
          for (const scRoomId of Array.from(client.subscribedRooms)) {
            const cached = client.roleColors.get(scRoomId);
            if (!cached || !ROLE_SPECIAL_COLORS.has(cached)) {
              client.roleColors.set(scRoomId, client.chatColor);
            }
            broadcastToRoom(scRoomId, { type: "COLOR_CHANGED", roomId: scRoomId, username: client.username!, color: client.chatColor });
          }
          send(ws, { type: "CMD_OK", cmd: "set_color", target: client.chatColor });
          break;
        }

        // ── CMD (admin commands) ──────────────────────────────────────────────
        // Matches chatroom admin command handling in backend app
        case "CMD": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" });
            return;
          }
          const { roomId, cmd, target, message: cmdMsg } = msg;
          const room = await storage.getChatroom(roomId);
          if (!room) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Chatroom tidak ditemukan" });
            return;
          }
          const isOwner = room.createdBy === client.userId;
          const isMod   = await storage.isModUser(roomId, client.userId!);
          const isGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
          const isAdmin = isGlobalAdmin || isOwner || isMod;

          const ownerOnlyCmds = ["mod", "unmod", "lock", "unlock", "description"];
          const adminCmds = ["kick", "ban", "mute", "unmute", "warn", "kill", "bump", "broadcast", "announce", "announcement", "announce_off", "silence", "unban"];
          if (ownerOnlyCmds.includes(cmd) && !isOwner) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner yang bisa" }); return;
          }
          if (adminCmds.includes(cmd) && !isAdmin) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return;
          }

          const needsTarget = ["kick","kill","ban","mute","unmute","mod","unmod","warn","silence","unban","suspend","block"];
          if (needsTarget.includes(cmd) && !target) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Target wajib" }); return;
          }

          let targetUser = target ? await storage.getUserByUsername(target) : null;
          if (["kick","kill","ban","mute","unmute","mod","unmod","warn"].includes(cmd) && !targetUser) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return;
          }

          switch (cmd) {
            case "kick": case "kill": {
              // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be kicked
              const cmdTargetIsProtected =
                room.createdBy === targetUser!.id ||
                await storage.isModUser(roomId, targetUser!.id) ||
                await storage.isGlobalAdmin(targetUser!.id);
              if (cmdTargetIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-kick" });
                break;
              }
              await storage.leaveChatroom(roomId, targetUser!.id);
              forceRemoveUserFromRoom(targetUser!.id, roomId, room.name, "kicked");
              // Mirrors Kick.java: isGlobalAdmin → "kicked by administrator {username}"
              //                   isOwner/isMod → "kicked by {username}"
              //                   kill → "dikeluarkan paksa oleh {username}"
              const kickerLabel = isGlobalAdmin
                ? `administrator ${client.username}`
                : client.username;
              const kickText = cmd === "kill"
                ? `${target} dikeluarkan paksa oleh ${client.username}`
                : `${target} has been kicked by ${kickerLabel}`;
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF4444",
                text: kickText, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "KICKED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "ban": {
              // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be banned
              const cmdBanIsProtected =
                room.createdBy === targetUser!.id ||
                await storage.isModUser(roomId, targetUser!.id) ||
                await storage.isGlobalAdmin(targetUser!.id);
              if (cmdBanIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-ban" });
                break;
              }
              await storage.banUser(roomId, targetUser!.id);
              forceRemoveUserFromRoom(targetUser!.id, roomId, room.name, "banned");
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF4444",
                text: `${target} telah di-ban dari chatroom`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "BANNED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "mute": {
              // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be muted
              const cmdMuteIsProtected =
                room.createdBy === targetUser!.id ||
                await storage.isModUser(roomId, targetUser!.id) ||
                await storage.isGlobalAdmin(targetUser!.id);
              if (cmdMuteIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-mute" });
                break;
              }
              await storage.muteUser(roomId, targetUser!.id);
              mutedCacheAdd(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `${target} telah di-mute`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "unmute": {
              await storage.unmuteUser(roomId, targetUser!.id);
              mutedCacheRemove(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "4CAF50",
                text: `${target} sudah di-unmute`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "mod": {
              await storage.modUser(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "9C27B0",
                text: `${target} telah dipromosikan menjadi Mod`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MOD", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "unmod": {
              await storage.unmodUser(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "9C27B0",
                text: `${target} telah dicopot dari Mod`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "UNMOD", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "warn": {
              const note = cmdMsg ? ` — "${cmdMsg}"` : "";
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `${target} mendapat peringatan${note}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "WARNED", roomId, username: target!, message: cmdMsg });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "lock": {
              await storage.updateChatroom(roomId, { isLocked: true });
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "795548",
                text: "Chatroom telah dikunci. Member baru tidak dapat bergabung", isSystem: true,
              });
              broadcastToRoom(roomId, { type: "LOCKED", roomId });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            case "unlock": {
              const unlockRoom2 = await storage.getChatroom(roomId);
              const unlockCapacity2 = unlockRoom2?.createdBy ? await getRoomCapacityForUser(unlockRoom2.createdBy) : 25;
              await storage.updateChatroom(roomId, { isLocked: false, maxParticipants: unlockCapacity2 });
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "795548",
                text: "Chatroom telah dibuka. Member baru dapat bergabung", isSystem: true,
              });
              broadcastToRoom(roomId, { type: "UNLOCKED", roomId });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            case "bump": {
              if (target) {
                // /bump username — soft-disconnect target user, they stay in participants and can rejoin
                const bumpTarget = await storage.getUserByUsername(target);
                if (!bumpTarget) {
                  send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return;
                }
                // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be bumped
                const cmdBumpIsProtected =
                  room.createdBy === bumpTarget.id ||
                  await storage.isModUser(roomId, bumpTarget.id) ||
                  await storage.isGlobalAdmin(bumpTarget.id);
                if (cmdBumpIsProtected) {
                  send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-bump" });
                  break;
                }
                softBumpUserFromRoom(bumpTarget.id, roomId);
                const sysMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF8C00",
                  text: `${target} di-bump oleh ${client.username}`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
                send(ws, { type: "CMD_OK", cmd, target });
              } else {
                // /bump — move chatroom to top of room list
                await storage.updateChatroom(roomId, { createdAt: new Date() });
                const sysMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF8C00",
                  text: `Chatroom di-bump oleh ${client.username}`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
                send(ws, { type: "CMD_OK", cmd });
              }
              break;
            }
            case "broadcast": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Pesan wajib" }); return;
              }
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: client.username!, senderColor: "2196F3",
                text: `[Broadcast] ${cmdMsg.trim()}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            // ── /announce — mirrors Announce.java chatRoomPrx.announceOn/Off ─────
            // Usage: /announce [message] [time] or /announce off
            // time must be 120-3600 seconds (3-4 digits, matches Announce.java validation).
            // waitTime = -1 → one-shot (no repeat). 120-3600 → repeat every N seconds.
            // Max message length: 320 chars (matches Announce.java hardcoded limit).
            case "announce_off": {
              clearAnnounceTimer(roomId);
              const offMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "607D8B",
                text: `📢 Announcement dimatikan oleh ${client.username}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "ANNOUNCEMENT_OFF", roomId });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: offMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            case "announcement":
            case "announce": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /announce [pesan] [waktu] atau /announce off" }); return;
              }
              const rawAnnounce = cmdMsg.trim();
              // Matches Announce.java: max 320 chars
              if (rawAnnounce.length > 320) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Pesan tidak boleh lebih dari 320 karakter." }); return;
              }
              // Parse waitTime from message — mirrors Announce.java Pattern "^(.*) ([0-9]+)$"
              // waitTime passed from client, or try to parse from trailing number in message
              let announceMsg = rawAnnounce;
              let waitTime: number = msg.waitTime ?? -1;
              if (waitTime === -1) {
                const trailMatch = rawAnnounce.match(/^(.*)\s+([0-9]+)$/);
                if (trailMatch) {
                  const parsed = parseInt(trailMatch[2], 10);
                  const s = trailMatch[2];
                  if (s.length >= 3 && s.length <= 4 && parsed >= 120 && parsed <= 3600) {
                    announceMsg = trailMatch[1];
                    waitTime = parsed;
                  }
                }
              } else {
                // waitTime provided explicitly — validate range (mirrors Announce.java 120-3600)
                if (waitTime < 120 || waitTime > 3600) {
                  send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Waktu tidak valid. Harus antara 120 sampai 3600 detik." }); return;
                }
              }
              // Clear any existing timer for this room before starting new one
              clearAnnounceTimer(roomId);
              const sendAnnounce = async () => {
                const room2 = await storage.getChatroom(roomId);
                if (!room2) { clearAnnounceTimer(roomId); return; }
                const sysMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "2196F3",
                  text: `📢 [Announcement] ${announceMsg}`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "ANNOUNCEMENT", roomId, message: announceMsg });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              };
              // Fire once immediately, then repeat if waitTime > 0
              await sendAnnounce();
              if (waitTime > 0) {
                const timer = setInterval(sendAnnounce, waitTime * 1000);
                announceTimers.set(roomId, timer);
              }
              send(ws, { type: "CMD_OK", cmd, ...(waitTime > 0 ? { waitTime } : {}) });
              break;
            }
            // ── getmyluck — mirrors GetMyLuck.java EmoteCommand ──────────────────
            // Usage: /getmyluck
            // Generates 4 luck values (1-5) for the caller, cached per-user per-day in Redis.
            // Mirrors MemCachedClientWrapper.add (add-only if not exists) — same values all day.
            // TTL = 24 hours; re-generates on parse error (mirrors Java fallback logic).
            // Broadcasts to all users in room — mirrors sendMessageToAllUsersInChat.
            // Categories (mig33 tradition): Love / Career / Health / Luck (1-5 stars each).
            case "getmyluck": {
              // Redis key mirrors MemCachedKeySpaces.CommonKeySpace.EMOTE_GETMYLUCK pattern
              const luckKey = `getmyluck:${client.username}`;
              const LUCK_TTL = 24 * 60 * 60; // 24 hours — daily reset
              let luckValues: number[] = [];
              let redis: ReturnType<typeof getRedisClient> | null = null;
              try { redis = getRedisClient(); } catch { /* Redis unavailable — generate fresh */ }
              let cached: string | null = null;
              if (redis) {
                try { cached = await redis.get(luckKey); } catch { /* ignore */ }
              }
              const VALUE_RE = /^([1-5]):([1-5]):([1-5]):([1-5])$/;
              if (cached && VALUE_RE.test(cached)) {
                // Mirrors: VALUE_PATTERN.matcher(luckValue).matches() — parse cached
                luckValues = cached.split(':').map(Number);
              } else {
                // Mirrors: RANDOM_GENERATOR.nextInt(5) + 1  (SecureRandom, 1-5 inclusive)
                luckValues = Array.from({ length: 4 }, () => Math.floor(Math.random() * 5) + 1);
                const serialized = luckValues.join(':');
                if (redis) {
                  try {
                    // Mirrors: MemCachedClientWrapper.add — only stores if key absent
                    const nx = await redis.set(luckKey, serialized, 'EX', LUCK_TTL, 'NX');
                    if (!nx) {
                      // Another request stored first — read their value (mirrors Java add() fallback)
                      const freshCached = await redis.get(luckKey);
                      if (freshCached && VALUE_RE.test(freshCached)) {
                        luckValues = freshCached.split(':').map(Number);
                      }
                    }
                  } catch { /* ignore */ }
                }
              }
              const [love, career, health, luck] = luckValues;
              const stars = (n: number) => '⭐'.repeat(n);
              const gmlMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF9800",
                text: `🔮 Luck of ${client.username} hari ini — ` +
                      `Cinta: ${stars(love)} | Karir: ${stars(career)} | ` +
                      `Kesehatan: ${stars(health)} | Keberuntungan: ${stars(luck)}`,
                isSystem: true,
              });
              broadcastToRoom(roomId, { type: "GET_MY_LUCK", roomId, username: client.username!, love, career, health, luck });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: gmlMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── follow — mirrors Follow.java EmoteCommand ─────────────────────────
            // Usage: /follow [username] or /f [username]
            // Adds usernameToFollow as contact for caller.
            // sendMessageToSender only — only caller sees "You are now following…"
            // Mirrors: Follow.java line 64-65 (messageText + sendMessageToSender).
            // Not admin-only; available to all authenticated users.
            case "follow":
            case "f": {
              const followTarget = cmdMsg?.trim();
              if (!followTarget) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /follow [username]" }); return;
              }
              if (followTarget.toLowerCase() === client.username?.toLowerCase()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Tidak bisa follow diri sendiri" }); return;
              }
              const followTargetUser = await storage.getUserByUsername(followTarget);
              if (!followTargetUser) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `User "${followTarget}" tidak ditemukan` }); return;
              }
              const callerUser = await storage.getUserByUsername(client.username!);
              if (!callerUser) break;

              // One-way follow (legacy phone-book)
              await storage.followUser(client.username!, followTargetUser.username);

              // ── Also send contact request so target gets notified & can accept ──
              // Skip if already friends
              const [alreadyFriendF] = await db
                .select()
                .from(friendships)
                .where(and(eq(friendships.userId, callerUser.id), eq(friendships.friendUserId, followTargetUser.id)));

              if (!alreadyFriendF) {
                // Check for reverse request → auto-accept
                const [reverseF] = await db
                  .select()
                  .from(contactRequests)
                  .where(and(
                    eq(contactRequests.fromUserId, followTargetUser.id),
                    eq(contactRequests.toUserId, callerUser.id),
                    eq(contactRequests.status, "pending"),
                  ));

                const callerProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, callerUser.id)).then(r => r[0]);
                const callerDisplay = callerUser.displayName ?? callerProfile?.aboutMe ?? callerUser.username;
                const targetProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, followTargetUser.id)).then(r => r[0]);
                const targetDisplay = followTargetUser.displayName ?? targetProfile?.aboutMe ?? followTargetUser.username;

                if (reverseF) {
                  // Auto-accept
                  await db.update(contactRequests)
                    .set({ status: "accepted" })
                    .where(eq(contactRequests.id, reverseF.id));
                  const fId = randomUUID();
                  await db.insert(friendships).values([
                    { id: fId, userId: callerUser.id, friendUserId: followTargetUser.id, friendUsername: followTargetUser.username, friendDisplayName: targetDisplay },
                    { id: randomUUID(), userId: followTargetUser.id, friendUserId: callerUser.id, friendUsername: callerUser.username, friendDisplayName: callerDisplay },
                  ]);
                  broadcastToUser(callerUser.id, { type: "CONTACT_ACCEPTED", byUsername: followTargetUser.username, byDisplayName: targetDisplay, friendshipId: fId });
                  broadcastToUser(followTargetUser.id, { type: "CONTACT_ACCEPTED", byUsername: callerUser.username, byDisplayName: callerDisplay, friendshipId: fId });
                } else {
                  // Check no duplicate pending
                  const [existingF] = await db
                    .select()
                    .from(contactRequests)
                    .where(and(
                      eq(contactRequests.fromUserId, callerUser.id),
                      eq(contactRequests.toUserId, followTargetUser.id),
                      eq(contactRequests.status, "pending"),
                    ));

                  if (!existingF) {
                    const [newReq] = await db
                      .insert(contactRequests)
                      .values({
                        id: randomUUID(),
                        fromUserId: callerUser.id,
                        fromUsername: callerUser.username,
                        fromDisplayName: callerDisplay,
                        toUserId: followTargetUser.id,
                        toUsername: followTargetUser.username,
                        status: "pending",
                      })
                      .returning();

                    broadcastToUser(followTargetUser.id, {
                      type: "CONTACT_REQUEST",
                      requestId: newReq.id,
                      fromUsername: callerUser.username,
                      fromDisplayName: callerDisplay,
                    });
                    // Persist UNS ALERT for offline users
                    try {
                      await storage.createNotification({
                        username: followTargetUser.username,
                        type: "ALERT",
                        subject: "Permintaan Pertemanan",
                        message: `${callerUser.username} ingin berteman denganmu. Buka notifikasi untuk menerima atau menolak.`,
                        status: 1,
                      });
                    } catch {}
                  }
                }
              }

              // Mirrors Follow.java: sendMessageToSender (only caller sees this, NOT broadcast)
              send(ws, { type: "FOLLOW_OK", username: followTargetUser.username });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── unfollow — companion to Follow.java ───────────────────────────────
            // Usage: /unfollow [username]
            // Removes follow relationship; only caller sees confirmation.
            case "unfollow": {
              const unfollowTarget = cmdMsg?.trim();
              if (!unfollowTarget) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /unfollow [username]" }); return;
              }
              await storage.unfollowUser(client.username!, unfollowTarget);
              // sendMessageToSender only — mirrors Follow.java pattern
              send(ws, { type: "UNFOLLOW_OK", username: unfollowTarget });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── flames — mirrors Flames.java EmoteCommand ─────────────────────────
            // Usage: /flames [user1] [user2]
            // Computes shared-character score, maps via score % 6 to FLAMES_VALUES.
            // score == 0 → "Too bad, not a match" (mirrors Flames.java DEFAULT_NO_MATCH_MESSAGE)
            // Available to all users (not admin-only), broadcasts to entire room.
            case "flames": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /flames [user1] [user2]" }); return;
              }
              const flParts = cmdMsg.trim().split(/\s+/);
              if (flParts.length < 2) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /flames [user1] [user2]" }); return;
              }
              const flUser1 = flParts[0];
              const flUser2 = flParts[1];
              const flScore = getFlamesScore(flUser1, flUser2);
              if (flScore === 0) {
                // Mirrors Flames.java DEFAULT_NO_MATCH_MESSAGE
                const nmMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "9E9E9E",
                  text: `😔 Sayang sekali, ${flUser1} dan ${flUser2} tidak cocok.`,
                  isSystem: true,
                });
                broadcastToRoom(roomId, { type: "FLAMES_NO_MATCH", roomId, user1: flUser1, user2: flUser2 });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: nmMsg });
              } else {
                const flVal = FLAMES_VALUES[flScore % FLAMES_VALUES.length];
                const flMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF5722",
                  text: `🔥 ${flUser1} dan ${flUser2}::${flVal.emoji} ${flVal.letter} — ${flVal.label}!`,
                  isSystem: true,
                });
                broadcastToRoom(roomId, { type: "FLAMES", roomId, user1: flUser1, user2: flUser2, letter: flVal.letter, label: flVal.label, emoji: flVal.emoji });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: flMsg });
              }
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── lovematch — mirrors LoveMatch.java EmoteCommand ──────────────────
            // Usage: /lovematch [user1] [user2]
            // Broadcasts love score (0-100) between two users to entire room.
            // Available to all users (not admin-only), matches Java non-filtering behaviour.
            case "lovematch": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /lovematch [user1] [user2]" }); return;
              }
              const lmParts = cmdMsg.trim().split(/\s+/);
              if (lmParts.length < 2) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /lovematch [user1] [user2]" }); return;
              }
              const lmUser1 = lmParts[0];
              const lmUser2 = lmParts[1];
              const lmScore = getLoveMatchScore(lmUser1, lmUser2);
              // Mirrors LoveMatch.java sendMessageToAllUsersInChat — broadcast to entire room
              const lmMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "E91E63",
                text: `💕 ${lmUser1} dan ${lmUser2} memiliki love match score: ${lmScore}%`,
                isSystem: true,
              });
              broadcastToRoom(roomId, { type: "LOVE_MATCH", roomId, user1: lmUser1, user2: lmUser2, score: lmScore });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: lmMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── findmymatch — mirrors FindMyMatch.java EmoteCommand ───────────────
            // Usage: /findmymatch
            // Finds the best love match for the caller among all visible room users.
            // Broadcasts result to entire room — mirrors sendMessageToAllUsersInChat.
            // Error if no other users in chat — mirrors FusionException with "No Match" message.
            case "findmymatch": {
              // Get all visible usernames in room, excluding the caller
              // Mirrors: chatSource.getVisibleUsernamesInChat(false)
              const roomUsers: string[] = [];
              clients.forEach((c) => {
                if (
                  c.state === "AUTHENTICATED" &&
                  c.subscribedRooms.has(roomId) &&
                  c.username !== client.username
                ) {
                  roomUsers.push(c.username!);
                }
              });
              if (roomUsers.length === 0) {
                // Mirrors FusionException("No Match - there are no other users in the chat")
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "No Match - there are no other users in the chat" }); return;
              }
              // Find user with highest love match score — mirrors FindMyMatch.java loop
              let fmmBest = roomUsers[0];
              let fmmMax  = getLoveMatchScore(client.username!, fmmBest);
              for (const u of roomUsers.slice(1)) {
                const s = getLoveMatchScore(client.username!, u);
                if (s > fmmMax) { fmmMax = s; fmmBest = u; }
              }
              const fmmMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "E91E63",
                text: `💕 Match terbaik ${client.username} adalah ${fmmBest} dengan score: ${fmmMax}%`,
                isSystem: true,
              });
              broadcastToRoom(roomId, { type: "FIND_MY_MATCH", roomId, seeker: client.username!, match: fmmBest, score: fmmMax });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: fmmMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── silence — timed mute, mirrors Silence.java EmoteCommand ──────────
            // Usage: /silence [username] [seconds]
            // Mirrors: chatroomPrx.silenceUser(username, timeoutSeconds) in Silence.java
            // Auto-unmutes after timeoutSeconds via setTimeout; stores in DB with mutedUntil.
            case "silence": {
              if (!isAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              const cmdSilenceTimeoutSecs = parseInt(String(msg.timeoutSecs ?? cmdMsg ?? '60'), 10);
              if (isNaN(cmdSilenceTimeoutSecs) || cmdSilenceTimeoutSecs < 1 || cmdSilenceTimeoutSecs > 86400) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Durasi harus antara 1 dan 86400 detik" }); return;
              }
              // ── /silence (no target) → silence ALL non-admin users in the room ─
              if (!target) {
                const cmdAllParticipants = await storage.getParticipants(roomId);
                const cmdSilencedNames: string[] = [];
                for (const p of cmdAllParticipants) {
                  if (p.id === client.userId) continue;
                  if (p.isOwner || p.isMod || p.isGlobalAdmin) continue;
                  try {
                    await storage.silenceUser(roomId, p.id, p.username, cmdSilenceTimeoutSecs);
                    mutedCacheAdd(roomId, p.id);
                    cmdSilencedNames.push(p.username);
                    setTimeout(async () => {
                      try {
                        await storage.unmuteUser(roomId, p.id);
                        mutedCacheRemove(roomId, p.id);
                      } catch {}
                    }, cmdSilenceTimeoutSecs * 1000);
                  } catch {}
                }
                const cmdAllMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF8C00",
                  text: `${client.username} silenced ${cmdSilencedNames.length} user${cmdSilencedNames.length !== 1 ? 's' : ''} for ${cmdSilenceTimeoutSecs} seconds.`,
                  isSystem: true,
                });
                const cmdAllList = await storage.getParticipants(roomId);
                for (const name of cmdSilencedNames) {
                  broadcastToRoom(roomId, { type: "MUTED", roomId, username: name });
                }
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: cmdAllMsg });
                broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, cmdAllList));
                send(ws, { type: "CMD_OK", cmd });
                setTimeout(async () => {
                  try {
                    const endMsg = await storage.postMessage(roomId, {
                      senderUsername: "System", senderColor: "4CAF50",
                      text: `Silence-all telah berakhir. Semua user dapat chat kembali.`,
                      isSystem: true,
                    });
                    for (const name of cmdSilencedNames) {
                      broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: name });
                    }
                    broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: endMsg });
                  } catch {}
                }, cmdSilenceTimeoutSecs * 1000);
                break;
              }
              const silTargetUser = await storage.getUserByUsername(target);
              if (!silTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
              // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be silenced
              const cmdSilIsProtected =
                room.createdBy === silTargetUser.id ||
                await storage.isModUser(roomId, silTargetUser.id) ||
                await storage.isGlobalAdmin(silTargetUser.id);
              if (cmdSilIsProtected) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-silence" });
                break;
              }
              const timeoutSecs = cmdSilenceTimeoutSecs;
              await storage.silenceUser(roomId, silTargetUser.id, silTargetUser.username, timeoutSecs);
              mutedCacheAdd(roomId, silTargetUser.id);
              const silMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `${target} di-silence selama ${timeoutSecs} detik oleh ${client.username}`, isSystem: true,
              });
              const silList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: target });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: silMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, silList));
              send(ws, { type: "CMD_OK", cmd, target });
              setTimeout(async () => {
                try {
                  await storage.unmuteUser(roomId, silTargetUser.id);
                  mutedCacheRemove(roomId, silTargetUser.id);
                  const unsilMsg = await storage.postMessage(roomId, {
                    senderUsername: "System", senderColor: "4CAF50",
                    text: `${target} silence telah berakhir.`, isSystem: true,
                  });
                  broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: target });
                  broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unsilMsg });
                } catch {}
              }, timeoutSecs * 1000);
              break;
            }

            // ── unban — mirrors Unban.java EmoteCommand ───────────────────────────
            // Usage: /unban [username]
            case "unban": {
              if (!isAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /unban [username]" }); return; }
              const unbanTargetUser = await storage.getUserByUsername(target);
              if (!unbanTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
              await storage.unbanUser(roomId, unbanTargetUser.id);
              const unbanMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "4CAF50",
                text: `${target} telah di-unban oleh ${client.username}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unbanMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }

            // ── suspend — global admin only, mirrors Suspend.java ─────────────────
            // Usage: /suspend [username] — permanently disables the account
            case "suspend": {
              if (!client.isChatroomAdmin) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya global admin yang bisa suspend user" }); return;
              }
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /suspend [username]" }); return; }
              const suspTargetUser = await storage.getUserByUsername(target);
              if (!suspTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
              await storage.suspendUser(suspTargetUser.id);
              // Force-remove from the current room (disconnects WS, broadcasts KICKED)
              await storage.leaveChatroom(roomId, suspTargetUser.id);
              forceRemoveUserFromRoom(suspTargetUser.id, roomId, room.name, "kicked");
              // Terminate any remaining WS connections for this user (other rooms or idle)
              for (const [sock, c] of clients) {
                if (c.userId === suspTargetUser.id) {
                  send(sock, { type: "AUTH_FAIL", code: "SUSPENDED", message: "Your account has been suspended" });
                  sock.terminate();
                }
              }
              const suspMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "F47422",
                text: `${target} telah di-suspend oleh administrator ${client.username}`, isSystem: true,
              });
              const suspList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: suspMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, suspList));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }

            // ── unsuspend — global admin only ─────────────────────────────────────
            // Usage: /unsuspend [username] — restores a suspended account
            case "unsuspend": {
              if (!client.isChatroomAdmin) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya global admin yang bisa unsuspend user" }); return;
              }
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /unsuspend [username]" }); return; }
              const unsuspTargetUser = await storage.getUserByUsername(target);
              if (!unsuspTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
              if (!unsuspTargetUser.isSuspended) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `${target} tidak sedang di-suspend` }); return;
              }
              await storage.unsuspendUser(unsuspTargetUser.id);
              const unsuspMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "4CAF50",
                text: `${target} telah dipulihkan (unsuspend) oleh administrator ${client.username}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unsuspMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }

            // ── block — mirrors Block.java EmoteCommand ───────────────────────────
            // Usage: /block [username] — adds to personal block list (caller only)
            case "block": {
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /block [username]" }); return; }
              await storage.blockUserGlobal(client.username!, target);
              const blockMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "607D8B",
                text: `Kamu tidak akan melihat pesan dari ${target} lagi.`, isSystem: true,
              });
              send(ws, { type: "MESSAGE", roomId, message: blockMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }

            default:
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Unknown cmd: ${cmd}` });
          }
          break;
        }

        // ── GET_ROOMS ─────────────────────────────────────────────────────────
        // Matches ChatRoomList pagination in backend app (pageSize=5)
        case "GET_ROOMS": {
          const PAGE_SIZE = 5;
          const page = msg.page ?? 1;
          const allRooms = msg.categoryId
            ? await storage.getChatroomsByCategory(msg.categoryId)
            : await storage.getChatrooms();
          const totalPages = Math.ceil(allRooms.length / PAGE_SIZE);
          const chatrooms = allRooms.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
          send(ws, { type: "ROOMS_LIST", chatrooms, page, totalPages });
          break;
        }

        // ── GET_MESSAGES ──────────────────────────────────────────────────────
        // Matches FusionPktGetMessages / RedisChatSyncStore in backend app
        // Supports two cursor modes:
        //   after  → backlog (messages AFTER a timestamp, used for reconnect)
        //   before → history (messages BEFORE a timestamp, used for pull-to-refresh)
        // Returns { type: "HISTORY" } so the client can prepend instead of append.
        case "GET_MESSAGES": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId, after, before } = msg;
          if (!roomId) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId wajib" }); return; }
          const limit = msg.limit ?? 50;
          const messages = await storage.getMessages(roomId, { after, before, limit: limit + 1 });
          const hasMore = messages.length > limit;
          const page = hasMore ? messages.slice(0, limit) : messages;
          send(ws, { type: "HISTORY", roomId, messages: page, hasMore });
          break;
        }

        // ── GET_PARTICIPANTS ──────────────────────────────────────────────────
        // Matches FusionPktChatRoomParticipantsOld (708) in backend app
        case "GET_PARTICIPANTS": {
          const { roomId } = msg;
          const room = await storage.getChatroom(roomId);
          const list = await storage.getParticipants(roomId);
          send(ws, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
          break;
        }

        // ── GET_THEME ─────────────────────────────────────────────────────────
        case "GET_THEME": {
          send(ws, { type: "THEME", roomId: msg.roomId, theme: DEFAULT_THEME });
          break;
        }

        // ── GET_STATS ─────────────────────────────────────────────────────────
        case "GET_STATS": {
          send(ws, { type: "STATS", ...getGatewayStats() });
          break;
        }

        // ── PING ──────────────────────────────────────────────────────────────
        case "PING": {
          send(ws, { type: "PONG", timestamp: Date.now() });
          break;
        }

        // ── SET_BACKGROUND / SET_FOREGROUND ───────────────────────────────────
        // Mirrors the FusionService foreground-service lifecycle on Android.
        // Client sends SET_BACKGROUND when the app is minimised so the server
        // knows to use a much longer grace period if the OS kills the socket.
        // Client sends SET_FOREGROUND when the app returns to the screen so the
        // server resets to the normal short grace window for future disconnects.
        case "SET_BACKGROUND": {
          if (client.state === "AUTHENTICATED") {
            client.isBackground = true;
            log(`[gateway] ${client.username} sent SET_BACKGROUND — will use extended grace on disconnect`, "gateway");
          }
          break;
        }

        case "SET_FOREGROUND": {
          if (client.state === "AUTHENTICATED") {
            client.isBackground = false;
            log(`[gateway] ${client.username} sent SET_FOREGROUND — back to normal grace period`, "gateway");
          }
          break;
        }

        // ── SET_PRESENCE ───────────────────────────────────────────────────────
        // Mirrors FusionPktSetPresence (Java: sessionPrx.setPresence(value))
        // Client sends: { type: "SET_PRESENCE", status: "online" | "away" | "busy" | "offline" }
        // Java PresenceType: AVAILABLE=0, AWAY=1, BUSY=2, INVISIBLE=3, OFFLINE=4
        case "SET_PRESENCE": {
          if (client.state !== "AUTHENTICATED" || !client.userId || !client.username) break;
          let newStatus: "online" | "away" | "busy" = "online";
          if (msg.status === "away") newStatus = "away";
          else if (msg.status === "busy") newStatus = "busy";
          presenceOverrides.set(client.userId, newStatus);
          // Push to own friends list — same as Java broadcasting FusionPktPresence to contacts
          try {
            const friends = await db.select({ friendUserId: friendships.friendUserId })
              .from(friendships).where(eq(friendships.userId, client.userId));
            const friendIds = friends.map((f: { friendUserId: string }) => f.friendUserId);
            broadcastPresenceToFriends(client.userId, client.username, newStatus, friendIds);
          } catch {}
          send(ws, { type: "PONG", timestamp: Date.now() }); // ack
          break;
        }

        // ── SET_STATUS_MESSAGE ────────────────────────────────────────────────
        // Client sends: { type: "SET_STATUS_MESSAGE", message: string }
        // Stores status text in-memory and broadcasts STATUS_MESSAGE event to friends
        case "SET_STATUS_MESSAGE": {
          if (client.state !== "AUTHENTICATED" || !client.userId || !client.username) break;
          const message = typeof msg.message === "string" ? msg.message : "";
          setUserStatusMessage(client.userId, message);
          try {
            const friends = await db.select({ friendUserId: friendships.friendUserId })
              .from(friendships).where(eq(friendships.userId, client.userId));
            for (const f of friends) {
              broadcastToUser(f.friendUserId, {
                type: "STATUS_MESSAGE",
                userId: client.userId,
                username: client.username,
                message: message.trim(),
              });
            }
          } catch {}
          send(ws, { type: "PONG", timestamp: Date.now() }); // ack
          break;
        }

        // ── GET_PRESENCE ───────────────────────────────────────────────────────
        // Client sends: { type: "GET_PRESENCE", userIds: string[] }
        // Returns PRESENCE_LIST for the requested userIds
        case "GET_PRESENCE": {
          if (client.state !== "AUTHENTICATED") break;
          const ids: string[] = Array.isArray(msg.userIds) ? msg.userIds : [];
          send(ws, { type: "PRESENCE_LIST", users: getPresenceList(ids) });
          break;
        }

        // ── LOGOUT ────────────────────────────────────────────────────────────
        // Matches fusion SSO logout flow: immediately broadcast "has left" for
        // all subscribed rooms without the grace period, then close the WS.
        // Called by the Expo client when the user explicitly taps "Log Out".
        case "LOGOUT": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "LOGOUT_OK" });
            ws.close();
            break;
          }

          // Cancel any pending grace timers for this user so there's no
          // duplicate "has left" after the forced logout.
          for (const roomId of Array.from(client.subscribedRooms)) {
            const graceKey = `${client.userId}:${roomId}`;
            const pending  = pendingLeaves.get(graceKey);
            if (pending) {
              clearTimeout(pending.timer);
              pendingLeaves.delete(graceKey);
            }
          }

          // Broadcast "has left" immediately for every subscribed room,
          // mirroring Java ChatRoom.queueEntryExitAdminMessage(false).
          // Suppress "has left" broadcast for global admins (silent leave).
          const logoutIsGlobalAdmin = client.userId
            ? await storage.isGlobalAdmin(client.userId).catch(() => false)
            : false;
          for (const roomId of Array.from(client.subscribedRooms)) {
            if (!client.userId) continue;
            await storage.leaveChatroom(roomId, client.userId).catch(() => {});
            const room = await storage.getChatroom(roomId).catch(() => null);
            if (!logoutIsGlobalAdmin) {
              const displayName = withLevel(client.username ?? "user", client.migLevel);
              const leaveMsg = await storage.postMessage(roomId, {
                senderUsername: client.username ?? "user",
                senderColor:    client.chatColor,
                text:           `${room?.name ?? roomId}::${displayName} has left`,
                isSystem:       true,
              }).catch(() => null);
              if (leaveMsg) broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
            }
            const list = await storage.getParticipants(roomId).catch(() => []);
            broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
            botNotifyLeave(roomId, client.username ?? "user");
          }
          client.subscribedRooms.clear();

          send(ws, { type: "LOGOUT_OK" });
          ws.close();
          break;
        }
      }
    });

    ws.on("close", () => {
      clearInterval(nativePingTimer);
      client.state = "DISCONNECTED";
      clients.delete(ws);
      for (const rId of client.subscribedRooms) roomClientsRemove(rId, ws);

      // Broadcast OFFLINE presence to friends after disconnect
      // Mirrors Java: FusionPktPresence broadcast on session termination
      if (client.userId && client.username) {
        const offlineUserId   = client.userId;
        const offlineUsername = client.username;
        db.select({ friendUserId: friendships.friendUserId })
          .from(friendships).where(eq(friendships.userId, offlineUserId))
          .then((friends: { friendUserId: string }[]) => {
            // Only broadcast offline if user truly has no remaining connections
            const stillConnected = [...clients.values()].some(
              (c) => c.state === "AUTHENTICATED" && c.userId === offlineUserId,
            );
            if (!stillConnected) {
              presenceOverrides.delete(offlineUserId);
              broadcastPresenceToFriends(offlineUserId, offlineUsername, "offline", friends.map((f) => f.friendUserId));
            }
          }).catch(() => {});
      }

      // ── Grace period ──────────────────────────────────────────────────────
      // Don't broadcast "has left" immediately — the client may reconnect
      // within LEAVE_GRACE_MS (network blip, app backgrounded, etc.).
      // If they re-SUBSCRIBE within the window we cancel the timer silently.
      // Only after the grace period expires do we remove from DB and broadcast.
      for (const roomId of Array.from(client.subscribedRooms)) {
        if (!client.userId) continue;
        const graceKey = `${client.userId}:${roomId}`;

        // Cancel any pre-existing grace timer for this user+room (edge case:
        // two rapid disconnects before first timer fires)
        const existing = pendingLeaves.get(graceKey);
        if (existing) {
          clearTimeout(existing.timer);
          pendingLeaves.delete(graceKey);
        }

        // If the same user is still present in this room via another WS connection
        // or via the TCP gateway, they haven't actually left — skip the timer entirely.
        const stillInRoomViaWs  = isUserInRoomViaWs(client.userId, roomId);
        const stillInRoomViaTcp = _tcpRoomPresence?.(client.userId, roomId) ?? false;
        if (stillInRoomViaWs || stillInRoomViaTcp) continue;

        const userId         = client.userId;
        const username       = client.username ?? "user";
        const color          = client.chatColor;
        const migLevel       = client.migLevel;
        const isBackground   = client.isBackground;
        const disconnectedAt = Date.now();
        const joinedAt       = client.joinedRooms.get(roomId) ?? disconnectedAt;

        // Use the extended grace period when the user minimised the app
        // (SET_BACKGROUND received), so they stay in the room while the OS
        // suspends the socket — mirrors the Java foreground-service behaviour.
        // 8 hours covers "berjam-jam" scenarios where OS kills the socket.
        const graceMs = isBackground ? BACKGROUND_LEAVE_GRACE_MS : LEAVE_GRACE_MS;
        log(`[gateway] Grace period ${graceMs / 1000}s for ${username} in room ${roomId} (background=${isBackground})`, "gateway");

        const timer = setTimeout(async () => {
          pendingLeaves.delete(graceKey);
          await storage.leaveChatroom(roomId, userId).catch(() => {});
          const room = await storage.getChatroom(roomId).catch(() => null);
          // Mirrors Java ChatRoom SILENCE_FAST_EXIT_MESSAGES / EXIT_SILENCE_TIME_IN_MS:
          // suppress "has left" broadcast if the user was in the room for less than
          // FAST_EXIT_SILENCE_MS — prevents spam from quick in-and-out visits.
          const timeInRoom = disconnectedAt - joinedAt;
          // Suppress "has left" for party room owner only — not for classic chatroom admins.
          let graceIsPartyOwner = false;
          if (!room) {
            try {
              const pr = await db.execute(sql`SELECT created_by FROM party_rooms WHERE id = ${roomId} LIMIT 1`);
              if (pr.rows.length > 0) {
                graceIsPartyOwner = (pr.rows[0] as any).created_by === userId;
              }
            } catch { /* not a party room */ }
          }
          if (timeInRoom >= FAST_EXIT_SILENCE_MS && !graceIsPartyOwner) {
            // Matches Java queueEntryExitAdminMessage: include level badge when level > 1
            const displayName = withLevel(username, migLevel);
            const leaveMsg = await storage.postMessage(roomId, {
              senderUsername: username, senderColor: color,
              text: `${room?.name ?? roomId}::${displayName} has left`, isSystem: true,
            }).catch(() => null);
            if (leaveMsg) broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
          }
          // For party rooms (no DB participants table), build from live WS connections.
          // By this point the disconnected WS is already removed from roomClients,
          // so iterating gives us exactly the remaining members.
          let participantsList: ChatParticipant[] = [];
          let roomDisplayName = room?.name ?? roomId;
          if (!room) {
            // Likely a party room — check and build from live WS connections.
            // Party rooms are not tracked in the DB participants table, so
            // storage.getParticipants() returns [] for them.
            const partyRoomSet = roomClients.get(roomId);
            if (partyRoomSet) {
              for (const w of partyRoomSet) {
                const c = clients.get(w);
                if (c?.username) participantsList.push({ id: c.userId ?? c.username!, username: c.username!, displayName: c.displayName ?? c.username!, color: c.chatColor ?? "#FFFFFF", joinedAt: new Date().toISOString() });
              }
              try {
                const pr = await db.execute(sql`SELECT name FROM party_rooms WHERE id = ${roomId} LIMIT 1`);
                if (pr.rows.length > 0) roomDisplayName = (pr.rows[0] as any).name ?? roomId;
              } catch { /* ignore */ }
            } else {
              participantsList = await storage.getParticipants(roomId).catch(() => []);
            }
          } else {
            participantsList = await storage.getParticipants(roomId).catch(() => []);
          }
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, roomDisplayName, participantsList));
          botNotifyLeave(roomId, username);
        }, graceMs);

        pendingLeaves.set(graceKey, { timer, roomId, userId, username, color, migLevel, disconnectedAt, joinedAt, isBackground });
      }
    });

    ws.on("error", () => {
      clearInterval(nativePingTimer);
      client.state = "DISCONNECTED";
      clients.delete(ws);
    });
  });

  console.log(`[gateway] WebSocket gateway running at ws://0.0.0.0:PORT${GATEWAY_WS_PATH}`);
}

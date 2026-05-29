import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";

// ── Milestone info (untuk display di client) ──────────────────────────────────
const MILESTONE_INFO: Record<string, { label: string; emoji: string; reward: number }> = {
  'X1_500':    { label: '500x Times X1',  emoji: '🎊', reward:    50_000 },
  'X3':        { label: '500x X3',        emoji: '🥉', reward:   150_000 },
  'X9':        { label: '500x X9',        emoji: '🥈', reward:   450_000 },
  'X99':       { label: '500x X99',       emoji: '🥇', reward: 4_500_000 },
  'X199':      { label: '500x X199',      emoji: '👑', reward: 9_400_000 },
  '50X_X1':    { label: '50x X1',         emoji: '🎁', reward:     2_000 },
  '50X_X3':    { label: '50x X3',         emoji: '🥉', reward:     4_000 },
  '50X_X9':    { label: '50x X9',         emoji: '🥈', reward:     9_000 },
  '50X_X99':   { label: '50x X99',        emoji: '🥇', reward:    13_000 },
  '50X_X199':  { label: '50x X199',       emoji: '👑', reward:   160_000 },
  '100X_X1':   { label: '100x X1',        emoji: '🎁', reward:    10_000 },
  '100X_X3':   { label: '100x X3',        emoji: '🥉', reward:    15_000 },
  '100X_X9':   { label: '100x X9',        emoji: '🥈', reward:    45_000 },
  '100X_X99':  { label: '100x X99',       emoji: '🥇', reward:   450_000 },
  '100X_X199': { label: '100x X199',      emoji: '👑', reward:   450_000 },
};

export function registerLuckyGiftRoutes(app: Express) {

  // GET /api/lucky-gift/progress — status counter global X1
  app.get('/api/lucky-gift/progress', async (_req, res) => {
    try {
      const cntRes = await db.execute(sql`
        SELECT total_coin, cumulative_coin, siklus_id, last_reset, updated_at
        FROM lucky_jp2_counter
        WHERE id = 1
      `);
      if (!cntRes.rows.length) {
        return res.json({
          current_coin: 0,
          target_coin:  1_000_000,
          siklus_id:    1,
          system: 'X1_GLOBAL',
          reward_per_winner: 50_000,
          total_winners: 10,
        });
      }
      const row      = cntRes.rows[0] as any;
      const totalCoin = Number(row.total_coin);
      const siklusId  = Number(row.siklus_id);

      return res.json({
        current_coin:       totalCoin,
        target_coin:        1_000_000,
        percent:            Math.min(100, Math.round((totalCoin / 1_000_000) * 100)),
        siklus_id:          siklusId,
        cumulative_coin:    Number(row.cumulative_coin),
        last_reset:         row.last_reset,
        updated_at:         row.updated_at,
        system:             'X1_GLOBAL',
        reward_per_winner:  50_000,
        total_winners:      10,
        win_delay_minutes:  5,
      });
    } catch (err) {
      console.error('[LuckyGift] /progress error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/room-progress/:roomId — status counter per-room X3-X199
  app.get('/api/lucky-gift/room-progress/:roomId', async (req, res) => {
    try {
      const { roomId } = req.params;
      const cntRes = await db.execute(sql`
        SELECT total_coin, siklus_id, updated_at
        FROM lucky_room_counter
        WHERE room_id = ${roomId}
      `);

      const totalCoin = cntRes.rows.length ? Number((cntRes.rows[0] as any).total_coin) : 0;
      const siklusId  = cntRes.rows.length ? Number((cntRes.rows[0] as any).siklus_id) : 1;

      return res.json({
        room_id:      roomId,
        current_coin: totalCoin,
        target_coin:  50_000_000,
        percent:      Math.min(100, Math.round((totalCoin / 50_000_000) * 100)),
        siklus_id:    siklusId,
        tiers: [
          { key: 'X3',   label: '500x X3',   emoji: '🥉', reward: 150_000,   delay_minutes: 0  },
          { key: 'X9',   label: '500x X9',   emoji: '🥈', reward: 450_000,   delay_minutes: 10 },
          { key: 'X99',  label: '500x X99',  emoji: '🥇', reward: 4_500_000, delay_minutes: 20 },
          { key: 'X199', label: '500x X199', emoji: '👑', reward: 9_400_000, delay_minutes: 30 },
        ],
      });
    } catch (err) {
      console.error('[LuckyGift] /room-progress error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/room-progress-50x/:roomId — status counter 50 Times
  app.get('/api/lucky-gift/room-progress-50x/:roomId', async (req, res) => {
    try {
      const { roomId } = req.params;
      const cntRes = await db.execute(sql`
        SELECT total_coin, siklus_id, updated_at
        FROM lucky_room_counter_50x
        WHERE room_id = ${roomId}
      `);

      const totalCoin = cntRes.rows.length ? Number((cntRes.rows[0] as any).total_coin) : 0;
      const siklusId  = cntRes.rows.length ? Number((cntRes.rows[0] as any).siklus_id) : 1;

      return res.json({
        room_id:      roomId,
        tier:         '50x',
        current_coin: totalCoin,
        target_coin:  350_000,
        percent:      Math.min(100, Math.round((totalCoin / 350_000) * 100)),
        siklus_id:    siklusId,
        tiers: [
          { key: '50X_X1',   label: '50x X1',   emoji: '🎁', reward:   2_000, delay_minutes: 0  },
          { key: '50X_X3',   label: '50x X3',   emoji: '🥉', reward:   4_000, delay_minutes: 3  },
          { key: '50X_X9',   label: '50x X9',   emoji: '🥈', reward:   9_000, delay_minutes: 6  },
          { key: '50X_X99',  label: '50x X99',  emoji: '🥇', reward:  13_000, delay_minutes: 9  },
          { key: '50X_X199', label: '50x X199', emoji: '👑', reward: 160_000, delay_minutes: 12 },
        ],
      });
    } catch (err) {
      console.error('[LuckyGift] /room-progress-50x error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/room-progress-100x/:roomId — status counter 100 Times
  app.get('/api/lucky-gift/room-progress-100x/:roomId', async (req, res) => {
    try {
      const { roomId } = req.params;
      const cntRes = await db.execute(sql`
        SELECT total_coin, siklus_id, updated_at
        FROM lucky_room_counter_100x
        WHERE room_id = ${roomId}
      `);

      const totalCoin = cntRes.rows.length ? Number((cntRes.rows[0] as any).total_coin) : 0;
      const siklusId  = cntRes.rows.length ? Number((cntRes.rows[0] as any).siklus_id) : 1;

      return res.json({
        room_id:      roomId,
        tier:         '100x',
        current_coin: totalCoin,
        target_coin:  1_800_000,
        percent:      Math.min(100, Math.round((totalCoin / 1_800_000) * 100)),
        siklus_id:    siklusId,
        tiers: [
          { key: '100X_X1',   label: '100x X1',   emoji: '🎁', reward:   10_000, delay_minutes: 0  },
          { key: '100X_X3',   label: '100x X3',   emoji: '🥉', reward:   15_000, delay_minutes: 3  },
          { key: '100X_X9',   label: '100x X9',   emoji: '🥈', reward:   45_000, delay_minutes: 6  },
          { key: '100X_X99',  label: '100x X99',  emoji: '🥇', reward:  450_000, delay_minutes: 9  },
          { key: '100X_X199', label: '100x X199', emoji: '👑', reward:  450_000, delay_minutes: 12 },
        ],
      });
    } catch (err) {
      console.error('[LuckyGift] /room-progress-100x error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/room-leaderboard-50x/:roomId — top spender 50x per room
  app.get('/api/lucky-gift/room-leaderboard-50x/:roomId', async (req, res) => {
    try {
      const { roomId } = req.params;
      const cntRes = await db.execute(sql`SELECT siklus_id FROM lucky_room_counter_50x WHERE room_id = ${roomId}`);
      const siklusId = cntRes.rows.length ? Number((cntRes.rows[0] as any).siklus_id) : 1;

      const rows = await db.execute(sql`
        SELECT username, total_gift_sent, last_gift_at
        FROM lucky_room_participants_50x
        WHERE room_id = ${roomId} AND siklus_id = ${siklusId}
        ORDER BY total_gift_sent DESC
        LIMIT 50
      `);
      return res.json({ room_id: roomId, tier: '50x', siklus_id: siklusId, participants: rows.rows });
    } catch (err) {
      console.error('[LuckyGift] /room-leaderboard-50x error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/room-leaderboard-100x/:roomId — top spender 100x per room
  app.get('/api/lucky-gift/room-leaderboard-100x/:roomId', async (req, res) => {
    try {
      const { roomId } = req.params;
      const cntRes = await db.execute(sql`SELECT siklus_id FROM lucky_room_counter_100x WHERE room_id = ${roomId}`);
      const siklusId = cntRes.rows.length ? Number((cntRes.rows[0] as any).siklus_id) : 1;

      const rows = await db.execute(sql`
        SELECT username, total_gift_sent, last_gift_at
        FROM lucky_room_participants_100x
        WHERE room_id = ${roomId} AND siklus_id = ${siklusId}
        ORDER BY total_gift_sent DESC
        LIMIT 50
      `);
      return res.json({ room_id: roomId, tier: '100x', siklus_id: siklusId, participants: rows.rows });
    } catch (err) {
      console.error('[LuckyGift] /room-leaderboard-100x error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/winners?limit=20
  app.get('/api/lucky-gift/winners', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const rows = await db.execute(sql`
        SELECT username, milestone, coin_reward, won_at, siklus_id
        FROM lucky_jp2_winners
        ORDER BY won_at DESC
        LIMIT ${limit}
      `);
      const winners = (rows.rows as any[]).map(r => ({
        username:    r.username,
        milestone:   r.milestone,
        label:       MILESTONE_INFO[r.milestone]?.label ?? r.milestone,
        emoji:       MILESTONE_INFO[r.milestone]?.emoji ?? '🎊',
        coin_reward: Number(r.coin_reward),
        won_at:      r.won_at,
        siklus_id:   Number(r.siklus_id),
      }));
      return res.json({ winners });
    } catch (err) {
      console.error('[LuckyGift] /winners error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/my-wins — riwayat menang milik user yang login
  app.get('/api/lucky-gift/my-wins', async (req: Request, res: Response) => {
    try {
      if (!req.session?.userId) return res.status(401).json({ message: 'Belum login' });
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: 'User tidak ditemukan' });

      const limit = Math.min(Number(req.query.limit ?? 10), 50);
      const rows = await db.execute(sql`
        SELECT milestone, coin_reward, won_at, siklus_id
        FROM lucky_jp2_winners
        WHERE LOWER(username) = LOWER(${user.username})
        ORDER BY won_at DESC
        LIMIT ${limit}
      `);

      const wins = (rows.rows as any[]).map(r => ({
        milestone:   r.milestone,
        label:       MILESTONE_INFO[r.milestone]?.label ?? r.milestone,
        emoji:       MILESTONE_INFO[r.milestone]?.emoji ?? '🎊',
        coin_reward: Number(r.coin_reward),
        won_at:      r.won_at,
        siklus_id:   Number(r.siklus_id),
      }));

      return res.json({ username: user.username, wins, total: wins.length });
    } catch (err) {
      console.error('[LuckyGift] /my-wins error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/leaderboard?siklus_id=1 — top spender global
  app.get('/api/lucky-gift/leaderboard', async (req, res) => {
    try {
      const cntRes = await db.execute(sql`SELECT siklus_id FROM lucky_jp2_counter WHERE id = 1`);
      const currentSiklus = cntRes.rows.length ? Number((cntRes.rows[0] as any).siklus_id) : 1;
      const siklusId = req.query.siklus_id ? Number(req.query.siklus_id) : currentSiklus;

      const rows = await db.execute(sql`
        SELECT username, total_gift_sent, last_gift_at
        FROM lucky_jp2_participants
        WHERE siklus_id = ${siklusId}
        ORDER BY total_gift_sent DESC
        LIMIT 50
      `);
      return res.json({ siklus_id: siklusId, current_siklus: currentSiklus, participants: rows.rows });
    } catch (err) {
      console.error('[LuckyGift] /leaderboard error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });

  // GET /api/lucky-gift/room-leaderboard/:roomId — top spender per room
  app.get('/api/lucky-gift/room-leaderboard/:roomId', async (req, res) => {
    try {
      const { roomId } = req.params;
      const cntRes = await db.execute(sql`SELECT siklus_id FROM lucky_room_counter WHERE room_id = ${roomId}`);
      const siklusId = cntRes.rows.length ? Number((cntRes.rows[0] as any).siklus_id) : 1;

      const rows = await db.execute(sql`
        SELECT username, total_gift_sent, last_gift_at
        FROM lucky_room_participants
        WHERE room_id = ${roomId} AND siklus_id = ${siklusId}
        ORDER BY total_gift_sent DESC
        LIMIT 50
      `);
      return res.json({ room_id: roomId, siklus_id: siklusId, participants: rows.rows });
    } catch (err) {
      console.error('[LuckyGift] /room-leaderboard error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });
}

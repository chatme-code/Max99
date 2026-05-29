import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import {
  LEADERBOARD_TYPE,
  LEADERBOARD_PERIOD,
  userProfiles,
  users,
} from "@shared/schema";
import { db } from "../../db";
import { inArray, eq } from "drizzle-orm";

// Mirrors com/projectgoth/fusion/leaderboard/Leaderboard.java
// insert(), increment(), reset(), recordGamesMetric()
// Uses typed leaderboard keys with period suffixes (DAILY, WEEKLY, MONTHLY, ALL_TIME)

export function registerLeaderboardRoutes(app: Express) {

  // ── GET /api/leaderboard/:type/:period ──────────────────────────────────────
  // Get ranked leaderboard entries for a given type and period
  // leaderboardType: SPENDING | GAMES_WON | CHATROOM_MSGS | PAINTWARS | CREDITS_RECEIVED
  // period: DAILY | WEEKLY | MONTHLY | ALL_TIME | PREVIOUS_DAILY | PREVIOUS_WEEKLY | PREVIOUS_MONTHLY
  app.get("/api/leaderboard/:type/:period", async (req, res) => {
    const { type, period } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const validTypes = Object.values(LEADERBOARD_TYPE);
    const validPeriods = Object.values(LEADERBOARD_PERIOD);

    if (!validTypes.includes(type as any)) {
      return res.status(400).json({ error: `Invalid leaderboard type. Valid: ${validTypes.join(", ")}` });
    }
    if (!validPeriods.includes(period as any)) {
      return res.status(400).json({ error: `Invalid period. Valid: ${validPeriods.join(", ")}` });
    }

    try {
      const raw = await storage.getLeaderboard(type, period, limit, offset);
      const entries = raw.map((e, i) => ({ ...e, position: offset + i + 1 }));

      const usernames = entries.map(e => e.username);
      let profileMap: Record<string, string | null> = {};
      if (usernames.length > 0) {
        const profiles = await db
          .select({ username: users.username, displayPicture: userProfiles.displayPicture })
          .from(users)
          .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
          .where(inArray(users.username, usernames));
        for (const p of profiles) {
          const rawDp = p.displayPicture ?? null;
          profileMap[p.username] = rawDp && /\/api\/imageserver\/image\/[^/]+$/.test(rawDp)
            ? rawDp + '/data' : rawDp;
        }
      }

      const enriched = entries.map(e => ({
        ...e,
        displayPicture: profileMap[e.username] ?? null,
      }));

      res.json({ type, period, entries: enriched, count: enriched.length, offset });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/leaderboard/:type/:period/rank/:username ───────────────────────
  // Get rank of a specific user in a leaderboard
  app.get("/api/leaderboard/:type/:period/rank/:username", async (req, res) => {
    const { type, period, username } = req.params;
    try {
      const rank = await storage.getLeaderboardRank(type, period, username);
      if (rank === null) return res.status(404).json({ error: "User not found in leaderboard" });
      res.json({ type, period, username, rank, score: rank.score, position: rank.position });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/leaderboard/insert ────────────────────────────────────────────
  // Set/overwrite a user score in a leaderboard (Leaderboard.insert())
  // Body: { leaderboardType, period, username, score }
  app.post("/api/leaderboard/insert", async (req, res) => {
    const schema = z.object({
      leaderboardType: z.string().min(1),
      period: z.string().min(1),
      username: z.string().min(1),
      score: z.number(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { leaderboardType, period, username, score } = parsed.data;
    try {
      const entry = await storage.upsertLeaderboardEntry(leaderboardType, period, username, score, false);
      res.json({ success: true, entry });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/leaderboard/increment ─────────────────────────────────────────
  // Increment a user score in a leaderboard (Leaderboard.increment())
  // Body: { leaderboardType, period, username, amount }
  app.post("/api/leaderboard/increment", async (req, res) => {
    const schema = z.object({
      leaderboardType: z.string().min(1),
      period: z.string().min(1),
      username: z.string().min(1),
      amount: z.number().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { leaderboardType, period, username, amount } = parsed.data;
    try {
      const entry = await storage.upsertLeaderboardEntry(leaderboardType, period, username, amount, true);
      res.json({ success: true, entry });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/leaderboard/reset ──────────────────────────────────────────────
  // Reset (archive) a leaderboard period into previousPeriod (Leaderboard.reset())
  // Body: { leaderboardType, period, previousPeriod }
  app.post("/api/leaderboard/reset", async (req, res) => {
    const schema = z.object({
      leaderboardType: z.string().min(1),
      period: z.string().min(1),
      previousPeriod: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { leaderboardType, period, previousPeriod } = parsed.data;
    try {
      await storage.resetLeaderboard(leaderboardType, period, previousPeriod);
      res.json({ success: true, message: `Leaderboard ${leaderboardType}/${period} archived to ${previousPeriod}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/leaderboard/record-games ──────────────────────────────────────
  // Record game metrics for multiple users (Leaderboard.recordGamesMetric())
  // Body: { leaderboardType, usernames: string[] }
  app.post("/api/leaderboard/record-games", async (req, res) => {
    const schema = z.object({
      leaderboardType: z.string().min(1),
      usernames: z.array(z.string().min(1)).min(1),
      amount: z.number().positive().optional().default(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { leaderboardType, usernames, amount } = parsed.data;
    try {
      const results = await Promise.all(
        usernames.map(username =>
          storage.upsertLeaderboardEntry(leaderboardType, LEADERBOARD_PERIOD.DAILY, username, amount, true)
        )
      );
      await Promise.all(
        usernames.map(username =>
          storage.upsertLeaderboardEntry(leaderboardType, LEADERBOARD_PERIOD.ALL_TIME, username, amount, true)
        )
      );
      res.json({ success: true, recorded: usernames.length, results });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/leaderboard/types ───────────────────────────────────────────────
  // List all valid leaderboard types and periods
  app.get("/api/leaderboard/types", (_req, res) => {
    res.json({
      types: Object.values(LEADERBOARD_TYPE),
      periods: Object.values(LEADERBOARD_PERIOD),
    });
  });
}

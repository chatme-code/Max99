import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";

// Mirrors com/projectgoth/fusion/paintwars/Painter.java
// PainterStats.java: totalPaintWarsPoints, totalPaintsSent, totalPaintsReceived,
//                    totalCleansSent, totalCleansReceived, paintsRemaining, cleansRemaining
// Constants from Painter.java:
//   freePaintsPerDay = 3, freeCleansPerDay = 2 (daily reset)
//   INVENTORY_LIMIT = 30
//   priceOfPaintCredit = 100 IDR, priceOfCleanCredit = 200 IDR (paid via MIG credits)
//   DAY_IN_SECONDS = 86400, RECORD_EXPIRY_TIME = 30 days

const FREE_PAINTS_PER_DAY = 3;
const FREE_CLEANS_PER_DAY = 2;
const INVENTORY_LIMIT = 30;
const PRICE_OF_PAINT_CREDIT = 0.01;
const PRICE_OF_CLEAN_CREDIT = 0.02;

export function registerPaintwarsRoutes(app: Express) {

  // ── GET /api/paintwars/stats/:username ────────────────────────────────────────
  // Get paint wars stats for a user (mirrors PainterStats fields)
  app.get("/api/paintwars/stats/:username", async (req, res) => {
    const { username } = req.params;
    try {
      let stats = await storage.getPaintwarsStats(username);
      if (!stats) {
        stats = await storage.createPaintwarsStats(username);
      }
      res.json({
        ...stats,
        freePaintsPerDay: FREE_PAINTS_PER_DAY,
        freeCleansPerDay: FREE_CLEANS_PER_DAY,
        priceOfPaint: PRICE_OF_PAINT_CREDIT,
        priceOfClean: PRICE_OF_CLEAN_CREDIT,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/paintwars/paint ──────────────────────────────────────────────────
  // Paint another user (mirrors Painter.paint())
  // Body: { painterUsername, targetUsername, usePaidCredits? }
  app.post("/api/paintwars/paint", async (req, res) => {
    const schema = z.object({
      painterUsername: z.string().min(1),
      targetUsername: z.string().min(1),
      usePaidCredits: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { painterUsername, targetUsername, usePaidCredits } = parsed.data;
    if (painterUsername === targetUsername) return res.status(400).json({ error: "Cannot paint yourself" });

    try {
      let painterStats = await storage.getPaintwarsStats(painterUsername);
      if (!painterStats) painterStats = await storage.createPaintwarsStats(painterUsername);

      if (!usePaidCredits && painterStats.paintsRemaining <= 0) {
        return res.status(402).json({
          error: "No free paints remaining for today",
          paintsRemaining: 0,
          priceOfPaint: PRICE_OF_PAINT_CREDIT,
          hint: "Use usePaidCredits=true to pay with MIG credits",
        });
      }

      let targetStats = await storage.getPaintwarsStats(targetUsername);
      if (!targetStats) targetStats = await storage.createPaintwarsStats(targetUsername);

      const updatedPainter = await storage.recordPaint(painterUsername, targetUsername, usePaidCredits);
      res.json({
        success: true,
        message: `${painterUsername} painted ${targetUsername}!`,
        painterStats: updatedPainter.painter,
        targetStats: updatedPainter.target,
        priceCharged: usePaidCredits ? PRICE_OF_PAINT_CREDIT : 0,
      });
    } catch (e: any) {
      const status = e.message === "Insufficient balance" ? 402 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── POST /api/paintwars/clean ──────────────────────────────────────────────────
  // Clean another user's paint (mirrors Painter.clean())
  // Body: { cleanerUsername, targetUsername, usePaidCredits? }
  app.post("/api/paintwars/clean", async (req, res) => {
    const schema = z.object({
      cleanerUsername: z.string().min(1),
      targetUsername: z.string().min(1),
      usePaidCredits: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { cleanerUsername, targetUsername, usePaidCredits } = parsed.data;
    if (cleanerUsername === targetUsername) return res.status(400).json({ error: "Cannot clean yourself" });

    try {
      let cleanerStats = await storage.getPaintwarsStats(cleanerUsername);
      if (!cleanerStats) cleanerStats = await storage.createPaintwarsStats(cleanerUsername);

      if (!usePaidCredits && cleanerStats.cleansRemaining <= 0) {
        return res.status(402).json({
          error: "No free cleans remaining for today",
          cleansRemaining: 0,
          priceOfClean: PRICE_OF_CLEAN_CREDIT,
          hint: "Use usePaidCredits=true to pay with MIG credits",
        });
      }

      let targetStats = await storage.getPaintwarsStats(targetUsername);
      if (!targetStats) targetStats = await storage.createPaintwarsStats(targetUsername);

      const updatedCleaner = await storage.recordClean(cleanerUsername, targetUsername, usePaidCredits);
      res.json({
        success: true,
        message: `${cleanerUsername} cleaned ${targetUsername}!`,
        cleanerStats: updatedCleaner.cleaner,
        targetStats: updatedCleaner.target,
        priceCharged: usePaidCredits ? PRICE_OF_CLEAN_CREDIT : 0,
      });
    } catch (e: any) {
      const status = e.message === "Insufficient balance" ? 402 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── POST /api/paintwars/reset-daily ───────────────────────────────────────────
  // Reset daily paint/clean counts for all users (job scheduler endpoint)
  app.post("/api/paintwars/reset-daily", async (_req, res) => {
    try {
      const count = await storage.resetDailyPaintwarsAllowances(FREE_PAINTS_PER_DAY, FREE_CLEANS_PER_DAY);
      res.json({ success: true, usersReset: count, freePaintsPerDay: FREE_PAINTS_PER_DAY, freeCleansPerDay: FREE_CLEANS_PER_DAY });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/paintwars/leaderboard ────────────────────────────────────────────
  // Get top painters by total PaintWars points
  // Query: ?limit=20
  app.get("/api/paintwars/leaderboard", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    try {
      const leaderboard = await storage.getPaintwarsLeaderboard(limit);
      res.json({ leaderboard, count: leaderboard.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/paintwars/config ──────────────────────────────────────────────────
  // Get paintwars configuration constants (mirrors Painter.java statics)
  app.get("/api/paintwars/config", (_req, res) => {
    res.json({
      freePaintsPerDay: FREE_PAINTS_PER_DAY,
      freeCleansPerDay: FREE_CLEANS_PER_DAY,
      inventoryLimit: INVENTORY_LIMIT,
      priceOfPaintCredit: PRICE_OF_PAINT_CREDIT,
      priceOfCleanCredit: PRICE_OF_CLEAN_CREDIT,
      currency: "IDR",
    });
  });
}

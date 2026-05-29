import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { FASHION_SHOW_STATUS } from "@shared/schema";

// Mirrors com/projectgoth/fusion/fashionshow/AvatarCandidates.java
// populateAvatarCandidates(): reads FashionShow Redis key for:
//   FIELD_LEVEL (required mig level, default=1)
//   FIELD_DAYS  (required active days, default=14)
//   FIELD_ITEMS (required avatar item count, default=2)
// Chunk size: 250 candidates processed at a time
// Users in AvatarCandidates set are eligible for fashion show voting

const DEFAULT_REQUIRED_LEVEL = 1;
const DEFAULT_REQUIRED_ACTIVE_DAYS = 14;
const DEFAULT_REQUIRED_AVATAR_ITEMS = 2;
const CHUNK_SIZE = 250;

export function registerFashionShowRoutes(app: Express) {

  // ── GET /api/fashionshow/candidates ──────────────────────────────────────────
  // Get active fashion show candidates for voting
  // Query: ?limit=20&offset=0
  app.get("/api/fashionshow/candidates", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, CHUNK_SIZE);
    const offset = parseInt(req.query.offset as string) || 0;
    try {
      const candidates = await storage.getFashionShowCandidates(limit, offset);
      res.json({ candidates, count: candidates.length, offset });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/fashionshow/winners ──────────────────────────────────────────────
  // Get fashion show winners (top voted candidates)
  // Query: ?limit=10
  app.get("/api/fashionshow/winners", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    try {
      const winners = await storage.getFashionShowWinners(limit);
      res.json({ winners, count: winners.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/fashionshow/nominate ────────────────────────────────────────────
  // Self-nominate for fashion show (mirrors populateAvatarCandidates eligibility check)
  // Body: { username }
  app.post("/api/fashionshow/nominate", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      requiredLevel: z.number().int().min(1).optional().default(DEFAULT_REQUIRED_LEVEL),
      requiredActiveDays: z.number().int().min(0).optional().default(DEFAULT_REQUIRED_ACTIVE_DAYS),
      requiredAvatarItems: z.number().int().min(0).optional().default(DEFAULT_REQUIRED_AVATAR_ITEMS),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, requiredLevel, requiredActiveDays, requiredAvatarItems } = parsed.data;

    try {
      const existing = await storage.getFashionShowByUsername(username);
      if (existing && existing.status === FASHION_SHOW_STATUS.ACTIVE) {
        return res.status(409).json({ error: "User is already a candidate in the fashion show" });
      }

      const session = await storage.createFashionShowSession({
        username,
        requiredLevel,
        requiredActiveDays,
        requiredAvatarItems,
        status: FASHION_SHOW_STATUS.ACTIVE,
      });
      res.status(201).json({ success: true, session });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/fashionshow/vote ─────────────────────────────────────────────────
  // Vote for a fashion show candidate
  // Body: { sessionId, voterUsername }
  app.post("/api/fashionshow/vote", async (req, res) => {
    const schema = z.object({
      sessionId: z.string().min(1),
      voterUsername: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { sessionId, voterUsername } = parsed.data;
    try {
      const session = await storage.getFashionShowById(sessionId);
      if (!session) return res.status(404).json({ error: "Fashion show session not found" });
      if (session.status !== FASHION_SHOW_STATUS.ACTIVE) {
        return res.status(409).json({ error: "Fashion show session is not active" });
      }
      if (session.username === voterUsername) {
        return res.status(400).json({ error: "Cannot vote for yourself" });
      }

      const updated = await storage.incrementFashionShowVotes(sessionId);
      res.json({ success: true, session: updated, votes: updated.votes });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/fashionshow/:username ────────────────────────────────────────────
  // Get fashion show status for a user
  app.get("/api/fashionshow/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const session = await storage.getFashionShowByUsername(username);
      if (!session) return res.status(404).json({ error: "No fashion show session found for user" });
      res.json({ session });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/fashionshow/config ───────────────────────────────────────────────
  // Get current fashion show configuration (mirrors FashionShow Redis key fields)
  app.get("/api/fashionshow/config", (_req, res) => {
    res.json({
      requiredLevel: DEFAULT_REQUIRED_LEVEL,
      requiredActiveDays: DEFAULT_REQUIRED_ACTIVE_DAYS,
      requiredAvatarItems: DEFAULT_REQUIRED_AVATAR_ITEMS,
      chunkSize: CHUNK_SIZE,
    });
  });
}

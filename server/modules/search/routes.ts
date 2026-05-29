import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";

// Mirrors com/projectgoth/fusion/search/
// BaseIndex.java: abstract search index
// ChatRoomsIndex.java: index chatrooms by name/description
// IndexChatRooms.java: re-index all chatrooms into Elasticsearch
// ElasticSearch.java: search() with query string
// Also mirrors discovery/search endpoints from the REST API

export function registerSearchRoutes(app: Express) {

  // ── GET /api/search ─────────────────────────────────────────────────────────
  // Global search across users, chatrooms (mirrors ElasticSearch.search())
  // Query: ?q=xxx&limit=10
  app.get("/api/search", async (req, res) => {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) return res.status(400).json({ error: "Query must be at least 2 characters" });
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    try {
      const [users, chatrooms] = await Promise.all([
        storage.searchUsers(q, limit),
        storage.searchChatrooms(q, limit),
      ]);
      res.json({
        query: q,
        results: {
          users,
          chatrooms,
        },
        total: users.length + chatrooms.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/search/users ───────────────────────────────────────────────────
  // Search users by username or display name
  // Query: ?q=xxx&limit=20&offset=0
  app.get("/api/search/users", async (req, res) => {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) return res.status(400).json({ error: "Query must be at least 2 characters" });
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    try {
      const results = await storage.searchUsers(q, limit, offset);
      res.json({ query: q, results, count: results.length, offset });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/search/chatrooms ───────────────────────────────────────────────
  // Search chatrooms by name or description (mirrors ChatRoomsIndex.java)
  // Query: ?q=xxx&limit=20&categoryId=1&language=id
  app.get("/api/search/chatrooms", async (req, res) => {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) return res.status(400).json({ error: "Query must be at least 2 characters" });
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const categoryId = req.query.categoryId ? parseInt(req.query.categoryId as string) : undefined;
    const language = req.query.language as string | undefined;

    try {
      const results = await storage.searchChatrooms(q, limit, offset, categoryId, language);
      res.json({ query: q, results, count: results.length, offset });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/search/groups ──────────────────────────────────────────────────
  // Search groups by name
  // Query: ?q=xxx&limit=20
  app.get("/api/search/groups", async (req, res) => {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) return res.status(400).json({ error: "Query must be at least 2 characters" });
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    try {
      const results = await storage.searchGroups(q, limit);
      res.json({ query: q, results, count: results.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/search/merchants ───────────────────────────────────────────────
  // Search merchants by name
  // Query: ?q=xxx&limit=20
  app.get("/api/search/merchants", async (req, res) => {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) return res.status(400).json({ error: "Query must be at least 2 characters" });
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    try {
      const results = await storage.searchMerchants(q, limit);
      res.json({ query: q, results, count: results.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/search/index/chatrooms ───────────────────────────────────────
  // Trigger re-index of all chatrooms (mirrors IndexChatRooms.java)
  // Admin endpoint to rebuild the search index
  app.post("/api/search/index/chatrooms", async (_req, res) => {
    try {
      const chatrooms = await storage.getAllChatroomsForIndex();
      res.json({
        success: true,
        indexed: chatrooms.length,
        message: `Indexed ${chatrooms.length} chatrooms`,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

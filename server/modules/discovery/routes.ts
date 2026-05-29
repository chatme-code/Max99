import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { enrichMerchantsWithAvatar } from "../../utils/merchantAvatar";

// Mirrors com/projectgoth/fusion/restapi/resource/RecommendationResource.java
// - getRecommendation(): recommended users, chatrooms, merchants by type/target
// - getFeaturedRecommendation(): featured items (merchants with highest points)
// Mirrors com/projectgoth/fusion/restapi/resource/HashtagResource.java
// - getCountriesSupportedHashtag() → trending tags per country
// Mirrors com/projectgoth/fusion/restapi/resource/UserResource.java (search)
// Mirrors com/projectgoth/fusion/restapi/resource/ChatroomResource.java (trending)

export function registerDiscoveryRoutes(app: Express): void {

  // ── GET /api/discovery/search ────────────────────────────────────────────
  // Global search: users, chatrooms, merchants with proper indexed search
  // Mirrors ElasticSearch.search() and ChatRoomsIndex.java
  app.get("/api/discovery/search", async (req: Request, res: Response) => {
    const q = (req.query.q as string)?.trim();
    const type = req.query.type as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

    if (!q || q.length < 2) {
      return res.status(400).json({ message: "Query pencarian minimal 2 karakter" });
    }

    try {
      const results: Record<string, unknown[]> = {};

      if (!type || type === "users") {
        results.users = await storage.searchUsers(q, limit);
      }
      if (!type || type === "chatrooms") {
        results.chatrooms = await storage.searchChatrooms(q, limit);
      }
      if (!type || type === "merchants") {
        const rawMerchants = await storage.searchMerchants(q, limit);
        results.merchants = await enrichMerchantsWithAvatar(rawMerchants);
      }

      return res.status(200).json({ query: q, results });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/discovery/recommended-users ─────────────────────────────────
  // Mirrors RecommendationResource GET /{type}?targetType=user
  // Returns users the current user may know (excludes self, excludes contacts)
  app.get("/api/discovery/recommended-users", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    try {
      const recommendations = await storage.getRecommendedUsers(req.session.userId);
      return res.status(200).json({ recommendations });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/discovery/trending-chatrooms ─────────────────────────────────
  // Mirrors RecommendationResource GET /chatroom?targetType=chatroom
  // Sorts by participant count (trending signal), returns top 10
  app.get("/api/discovery/trending-chatrooms", async (_req: Request, res: Response) => {
    try {
      const all = await storage.getChatrooms();
      const trending = [...all]
        .filter((r) => r.status === 1)
        .sort((a, b) => b.currentParticipants - a.currentParticipants)
        .slice(0, 10);
      return res.status(200).json({ chatrooms: trending });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/discovery/recommended-merchants ──────────────────────────────
  // Mirrors RecommendationResource GET /merchant/featured
  // Returns featured merchants sorted by totalPoints desc
  app.get("/api/discovery/recommended-merchants", async (_req: Request, res: Response) => {
    try {
      const merchants = await storage.getMerchants();
      const featured = merchants
        .filter((m) => m.status === 1)
        .sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0))
        .slice(0, 10);

      const enriched = await enrichMerchantsWithAvatar(featured);
      return res.status(200).json({ merchants: enriched });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/discovery/trending-tags ─────────────────────────────────────
  // Mirrors HashtagResource.java (getCountriesSupportedHashtag)
  // Returns trending hashtag topics — derived from chatroom names/descriptions
  // and popular merchant categories
  app.get("/api/discovery/trending-tags", async (_req: Request, res: Response) => {
    try {
      const [chatrooms, merchants] = await Promise.all([
        storage.getChatrooms(),
        storage.getMerchants(),
      ]);

      const tagFreq: Record<string, number> = {};

      const stopWords = new Set([
        "the", "and", "for", "chat", "room", "group", "dengan", "yang", "dan", "di",
        "ke", "dari", "ini", "itu", "atau", "juga", "ada", "tidak", "bisa",
      ]);

      const extractWords = (text: string) => {
        return text
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .split(/\s+/)
          .filter((w) => w.length >= 3 && !stopWords.has(w));
      };

      for (const room of chatrooms) {
        const words = [
          ...extractWords(room.name),
          ...extractWords(room.description ?? ""),
          ...(room.language ? [room.language] : []),
        ];
        const weight = 1 + Math.min(room.currentParticipants / 10, 5);
        for (const w of words) {
          tagFreq[w] = (tagFreq[w] ?? 0) + weight;
        }
      }

      for (const m of merchants) {
        if (m.category) {
          const words = extractWords(m.category);
          for (const w of words) {
            tagFreq[w] = (tagFreq[w] ?? 0) + 2;
          }
        }
      }

      const DEFAULT_TAGS = [
        "migme", "indonesia", "music", "fashion", "travel", "food",
        "tech", "sports", "friends", "fun", "games", "viral",
      ];

      for (const tag of DEFAULT_TAGS) {
        if (!tagFreq[tag]) tagFreq[tag] = 1;
      }

      const tags = Object.entries(tagFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([tag]) => tag);

      return res.status(200).json({ tags });
    } catch (e: any) {
      return res.status(500).json({ message: e.message, tags: [] });
    }
  });

  // ── GET /api/discovery/nearby-rooms ──────────────────────────────────────
  // Returns open/unlocked rooms for discovery
  app.get("/api/discovery/nearby-rooms", async (_req: Request, res: Response) => {
    try {
      const rooms = await storage.getRooms();
      const open = rooms.filter((r) => !r.isLocked && r.status === 1).slice(0, 20);
      return res.status(200).json({ rooms: open });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });
}

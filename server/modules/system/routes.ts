import type { Express, Request, Response } from "express";
import { broadcastAlertToAll, broadcastToRoom, getGatewayStats, forceLeaveAllRoomsAsLeave } from "../../gateway";
import { getTcpClientCount } from "../../gateway/tcp";
import { redisHealthCheck, isRedisAvailable } from "../../redis";
import { storage } from "../../storage";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { reputationLevelScore } from "../reputation/levelCurve";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "migme-internal-admin-2024";

const START_TIME = Date.now();

export function registerSystemRoutes(app: Express): void {
  app.get("/api/system/health", async (_req: Request, res: Response) => {
    const uptime = Math.floor((Date.now() - START_TIME) / 1000);
    const redis  = await redisHealthCheck();
    return res.status(200).json({
      status: "UP",
      service: "Migme Fusion API",
      version: "9.0.0",
      uptime,
      timestamp: new Date().toISOString(),
      redis: {
        status:    redis.status,
        latencyMs: redis.latencyMs ?? null,
      },
    });
  });

  app.get("/api/system/status", (_req: Request, res: Response) => {
    return res.status(200).json({
      api:         "UP",
      gateway_ws:  "UP",
      gateway_tcp: process.env.TCP_PORT ? "UP" : "DISABLED",
      redis:       isRedisAvailable() ? "UP" : "UNAVAILABLE",
      database:    "MEMORY",
      version:     "9.0.0",
      environment: process.env.NODE_ENV || "development",
    });
  });

  app.get("/api/system/info", (_req: Request, res: Response) => {
    return res.status(200).json({
      project:      "com.projectgoth.fusion",
      artifactId:   "Fusion",
      version:      "9.0.0",
      javaEquivalent: "Spring Boot 3.3.1",
      nodeVersion:  process.version,
      platform:     process.platform,
      modules: [
        "auth", "feed", "profile", "system",
        "chatroom", "room", "lost", "merchant",
        "merchant-tag", "discovery", "credit",
      ],
      gateway: {
        http:    true,
        websocket: true,
        tcp:     !!process.env.TCP_PORT,
        tcpPort: process.env.TCP_PORT || "5001",
      },
      cache: {
        redis:     isRedisAvailable(),
        redisHost: process.env.REDIS_HOST || "127.0.0.1",
        redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
      },
    });
  });

  // ── Gateway admin endpoints (matches GatewayAdminI in backend app) ──────────

  // Matches GatewayAdminI.getStats() — returns connection counts and event totals
  app.get("/api/system/gateway/stats", (_req: Request, res: Response) => {
    const ws  = getGatewayStats();
    const tcp = getTcpClientCount();
    return res.status(200).json({
      ws: {
        connections:   ws.connections,
        authenticated: ws.authenticated,
        totalEvents:   ws.totalEvents,
      },
      tcp: {
        connections: tcp,
      },
      totalConnections: ws.connections + tcp,
    });
  });

  // Matches GatewayAdminI.sendAlertToAllConnections() — broadcast alert to all WS clients
  app.post("/api/system/gateway/alert", (req: Request, res: Response) => {
    const { title, message } = req.body as { title?: string; message?: string };
    if (!title || !message) {
      return res.status(400).json({ error: "title dan message wajib diisi" });
    }
    broadcastAlertToAll(title, message);
    const stats = getGatewayStats();
    return res.status(200).json({
      ok:         true,
      dispatched: stats.authenticated,
      title,
      message,
    });
  });

  // ── Global Admin Management ─────────────────────────────────────────────────
  // POST /api/system/admin/grant — grant global admin to a user
  // Requires caller to be a global admin (or no admins exist yet — bootstrap)
  app.post("/api/system/admin/grant", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const caller = await storage.getUser(req.session.userId);
    if (!caller) return res.status(401).json({ message: "Invalid session." });

    const callerIsAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!callerIsAdmin) {
      return res.status(403).json({ message: "Only an existing global admin can grant admin rights." });
    }

    const { username } = req.body as { username?: string };
    if (!username) return res.status(400).json({ message: "username wajib diisi." });

    const target = await storage.getUserByUsername(username);
    if (!target) return res.status(404).json({ message: `User '${username}' not found.` });

    await storage.setGlobalAdmin(target.id, true);
    return res.status(200).json({ message: `${username} is now a global admin.`, username, isAdmin: true });
  });

  // POST /api/system/admin/revoke — revoke global admin from a user
  app.post("/api/system/admin/revoke", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const callerIsAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!callerIsAdmin) {
      return res.status(403).json({ message: "Only an existing global admin can revoke admin rights." });
    }

    const { username } = req.body as { username?: string };
    if (!username) return res.status(400).json({ message: "username wajib diisi." });

    const target = await storage.getUserByUsername(username);
    if (!target) return res.status(404).json({ message: `User '${username}' not found.` });

    if (target.id === req.session.userId) {
      return res.status(400).json({ message: "You cannot revoke your own admin rights." });
    }

    await storage.setGlobalAdmin(target.id, false);
    return res.status(200).json({ message: `${username} is no longer a global admin.`, username, isAdmin: false });
  });

  // POST /api/system/admin/bootstrap — first-time setup: grant self admin (only if NO admin exists yet)
  app.post("/api/system/admin/bootstrap", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const caller = await storage.getUser(req.session.userId);
    if (!caller) return res.status(401).json({ message: "Invalid session." });

    const alreadyAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (alreadyAdmin) return res.status(409).json({ message: "You are already a global admin." });

    await storage.setGlobalAdmin(req.session.userId, true);
    return res.status(200).json({
      message: `Bootstrap successful. ${caller.username} is now a global admin.`,
      username: caller.username,
      isAdmin: true,
    });
  });

  // GET /api/system/admin/check — check if current user is a global admin
  app.get("/api/system/admin/check", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const isAdmin = await storage.isGlobalAdmin(req.session.userId);
    const caller = await storage.getUser(req.session.userId);
    return res.status(200).json({ username: caller?.username, isAdmin });
  });

  // POST /api/system/admin/set-level — admin-only manual level override
  // Used by ops to bump newly-promoted merchants to a specific level
  // without waiting for the daily reputation recompute. Updates ONLY
  // the target user's row in user_reputation; never touches anyone else.
  app.post("/api/system/admin/set-level", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const callerIsAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!callerIsAdmin) {
      return res.status(403).json({ message: "Only a global admin can set user levels." });
    }

    const { username, level } = req.body as { username?: string; level?: number };
    if (!username || typeof username !== "string") {
      return res.status(400).json({ message: "username wajib diisi." });
    }
    const lvl = Number(level);
    if (!Number.isInteger(lvl) || lvl < 1 || lvl > 100) {
      return res.status(400).json({ message: "level harus berupa bilangan bulat 1-100." });
    }

    const target = await storage.getUserByUsername(username);
    if (!target) return res.status(404).json({ message: `User '${username}' not found.` });

    // Bump score up to the threshold for the chosen level (only if it's
    // currently lower) so the next reputation recompute won't drop the
    // user back down. We use GREATEST so a higher pre-existing score
    // is preserved unchanged.
    const minScore = reputationLevelScore(lvl);

    const lookupName = target.username;
    const result = await db.execute(sql`
      UPDATE user_reputation
         SET level = ${lvl},
             score = GREATEST(score, ${minScore}),
             updated_at = NOW()
       WHERE LOWER(username) = LOWER(${lookupName})
       RETURNING id, username, score, level
    `);
    const rows = (result as any).rows ?? (result as any);
    if (!rows || rows.length === 0) {
      // No reputation row yet — create one so the level sticks.
      const insRes = await db.execute(sql`
        INSERT INTO user_reputation (username, score, level, updated_at)
        VALUES (${lookupName}, ${minScore}, ${lvl}, NOW())
        ON CONFLICT (username) DO UPDATE
          SET level = EXCLUDED.level,
              score = GREATEST(user_reputation.score, EXCLUDED.score),
              updated_at = NOW()
        RETURNING id, username, score, level
      `);
      const insRows = (insRes as any).rows ?? (insRes as any);
      return res.status(200).json({
        message: `${lookupName} sekarang level ${lvl}.`,
        username: lookupName,
        level: lvl,
        score: insRows?.[0]?.score ?? minScore,
      });
    }
    return res.status(200).json({
      message: `${lookupName} sekarang level ${lvl}.`,
      username: rows[0].username,
      level: rows[0].level,
      score: rows[0].score,
    });
  });

  // GET /api/system/admin/user-level?username=foo — peek a user's current level
  app.get("/api/system/admin/user-level", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const callerIsAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!callerIsAdmin) return res.status(403).json({ message: "Admin only." });

    const username = String(req.query.username ?? "").trim();
    if (!username) return res.status(400).json({ message: "username wajib diisi." });

    const target = await storage.getUserByUsername(username);
    if (!target) return res.status(404).json({ message: `User '${username}' not found.` });

    const r = await db.execute(sql`
      SELECT username, score, level FROM user_reputation
       WHERE LOWER(username) = LOWER(${target.username})
       LIMIT 1
    `);
    const rows = (r as any).rows ?? (r as any);
    if (!rows || rows.length === 0) {
      return res.status(200).json({ username: target.username, level: 1, score: 0 });
    }
    return res.status(200).json({
      username: rows[0].username,
      level: rows[0].level,
      score: rows[0].score,
    });
  });

  // GET /api/system/login-announcement — public, used by mobile app right
  // after a successful login to render a one-shot popup. Reads from the
  // shared `system_settings` table written by the admin panel.
  app.get("/api/system/login-announcement", async (_req: Request, res: Response) => {
    try {
      const r = await db.execute(sql`
        SELECT key, value FROM system_settings
        WHERE key IN (
          'login.announcement.enabled',
          'login.announcement.title',
          'login.announcement.body',
          'login.announcement.image_url',
          'login.announcement.version'
        )
      `);
      const map: Record<string, string> = {};
      for (const row of r.rows as Array<{ key: string; value: string }>) {
        map[row.key] = row.value;
      }
      const enabled = map["login.announcement.enabled"] === "true";
      const body = String(map["login.announcement.body"] || "");
      if (!enabled || !body.trim()) {
        return res.status(200).json({ enabled: false });
      }
      return res.status(200).json({
        enabled: true,
        title:    String(map["login.announcement.title"] || "Pengumuman"),
        body,
        imageUrl: String(map["login.announcement.image_url"] || ""),
        version:  parseInt(String(map["login.announcement.version"] || "0"), 10) || 0,
      });
    } catch (err: any) {
      return res.status(200).json({ enabled: false });
    }
  });

  // POST /api/system/admin/broadcast-rooms — send system message to all active chatrooms
  // Protected by internal API key (for admin panel use only)
  app.post("/api/system/admin/broadcast-rooms", async (req: Request, res: Response) => {
    const key = req.headers["x-internal-key"];
    if (key !== INTERNAL_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { message, title, mode = "both" } = req.body as {
      message?: string;
      title?: string;
      mode?: "rooms" | "alert" | "both";
    };

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "message wajib diisi" });
    }

    const results: { roomId: string; roomName: string; ok: boolean }[] = [];

    if (mode === "rooms" || mode === "both") {
      try {
        const allRooms = await storage.getChatrooms();
        for (const room of allRooms) {
          try {
            const sysMsg = await storage.postMessage(room.id, {
              senderUsername: "System",
              senderColor: "F47422",
              text: message.trim(),
              isSystem: true,
            });
            broadcastToRoom(room.id, { type: "MESSAGE", roomId: room.id, message: sysMsg });
            results.push({ roomId: room.id, roomName: room.name, ok: true });
          } catch {
            results.push({ roomId: room.id, roomName: room.name, ok: false });
          }
        }
      } catch (err: any) {
        return res.status(500).json({ error: err.message || "Gagal mengambil daftar chatroom" });
      }
    }

    if (mode === "alert" || mode === "both") {
      broadcastAlertToAll(title || "Pengumuman", message.trim());
    }

    const stats = getGatewayStats();
    return res.status(200).json({
      ok: true,
      roomsReached: results.filter((r) => r.ok).length,
      totalRooms: results.length,
      onlineUsers: stats.authenticated,
      mode,
      results,
    });
  });

  // POST /api/system/admin/disconnect-users — force-leave all rooms + apply
  // global rejoin cooldown (default 1h). Mass-disconnect for multi-account
  // abuse on shared IP. Broadcasts as a normal "has left" event.
  // Body: { usernames: string[], cooldownMs?: number }
  app.post("/api/system/admin/disconnect-users", async (req: Request, res: Response) => {
    const key = req.headers["x-internal-key"];
    if (key !== INTERNAL_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { usernames, cooldownMs } = req.body as { usernames?: string[]; cooldownMs?: number };
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: "usernames wajib (array)" });
    }
    const blockMs = typeof cooldownMs === "number" && cooldownMs > 0
      ? Math.min(cooldownMs, 24 * 60 * 60 * 1000)
      : 60 * 60 * 1000;

    const out: { username: string; userId?: string; ok: boolean; rooms?: number; sockets?: number; error?: string }[] = [];
    for (const uname of usernames) {
      try {
        const u = await storage.getUserByUsername(uname);
        if (!u) { out.push({ username: uname, ok: false, error: "user not found" }); continue; }
        if (await storage.isGlobalAdmin(u.id)) { out.push({ username: uname, userId: u.id, ok: false, error: "skip admin" }); continue; }
        const r = await forceLeaveAllRoomsAsLeave(u.id, blockMs);
        out.push({ username: uname, userId: u.id, ok: true, rooms: r.rooms, sockets: r.sockets });
      } catch (e: any) {
        out.push({ username: uname, ok: false, error: e?.message ?? String(e) });
      }
    }
    return res.status(200).json({ ok: true, blockMs, results: out });
  });
}

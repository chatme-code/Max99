import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";
import { AccessToken } from "livekit-server-sdk";
import { LEADERBOARD_TYPE, LEADERBOARD_PERIOD, CREDIT_TRANSACTION_TYPE } from "@shared/schema";
import { users, userProfiles } from "@shared/schema";
import { inArray, eq } from "drizzle-orm";
import { broadcastToRoom, broadcastToAllClients } from "../../gateway";
import {
  getPartyRoomsList, setPartyRoomsList, invalidatePartyRoomsList,
  getPartyRoom, setPartyRoom, invalidatePartyRoom,
  getPartySeats, setPartySeats, invalidatePartySeats,
  getPartyLeaderboard, setPartyLeaderboard, invalidatePartyLeaderboard,
} from "../../redis";

/**
 * Live Party — API mandiri terpisah dari classic chatroom.
 *
 * Tabel: party_rooms, party_seats (dibuat di index.ts)
 * Prefix: /api/party
 *
 * Endpoints:
 *   GET    /api/party/rooms                    — daftar semua party room
 *   POST   /api/party/rooms                    — buat room baru
 *   GET    /api/party/rooms/:id                — detail room
 *   PATCH  /api/party/rooms/:id                — update nama/deskripsi
 *   DELETE /api/party/rooms/:id                — hapus room (owner saja)
 *   GET    /api/party/rooms/:id/state          — kursi + state
 *   POST   /api/party/rooms/:id/token          — LiveKit token
 *   POST   /api/party/rooms/:id/seats/:n/take  — duduk di kursi
 *   POST   /api/party/rooms/:id/seats/:n/leave — tinggalkan kursi
 *   POST   /api/party/rooms/:id/seats/:n/mute       — mute/unmute
 *   POST   /api/party/rooms/:id/seats/:n/raise-hand — toggle angkat tangan
 */

// ─── LiveKit Dual-Provider (Cloud + Self-hosted) ──────────────────────────────
//
// LIVEKIT_MODE: "cloud" | "selfhosted" | "auto" (default)
//   auto       → pakai Cloud jika Cloud credentials tersedia, else self-hosted
//   cloud      → paksa Cloud
//   selfhosted → paksa self-hosted Docker
//
// Runtime switch tanpa restart: gunakan POST /api/admin/party/switch-provider
// ──────────────────────────────────────────────────────────────────────────────

// Mutable — bisa diubah via admin endpoint tanpa restart Docker
let livekitRuntimeMode: string = (process.env.LIVEKIT_MODE || "auto").toLowerCase();

// Cloud credentials (dibaca saat startup, tidak berubah)
const LIVEKIT_CLOUD_URL        = process.env.LIVEKIT_CLOUD_URL        || "";
const LIVEKIT_CLOUD_API_KEY    = process.env.LIVEKIT_CLOUD_API_KEY    || "";
const LIVEKIT_CLOUD_API_SECRET = process.env.LIVEKIT_CLOUD_API_SECRET || "";

// Self-hosted credentials (dibaca saat startup, tidak berubah)
const LIVEKIT_SELF_URL         = process.env.LIVEKIT_URL              || "";
const LIVEKIT_SELF_API_KEY     = process.env.LIVEKIT_API_KEY          || "";
const LIVEKIT_SELF_API_SECRET  = process.env.LIVEKIT_API_SECRET       || "";

export function getLivekitRuntimeMode(): string { return livekitRuntimeMode; }
export function setLivekitRuntimeMode(mode: "cloud" | "selfhosted" | "auto"): void {
  livekitRuntimeMode = mode;
  console.log(`[party] LiveKit provider switched to: ${mode}`);
}

function getActiveLiveKit(): { url: string; apiKey: string; apiSecret: string; provider: "cloud" | "selfhosted" } {
  const cloudReady = !!(LIVEKIT_CLOUD_URL && LIVEKIT_CLOUD_API_KEY && LIVEKIT_CLOUD_API_SECRET);
  const selfReady  = !!(LIVEKIT_SELF_URL  && LIVEKIT_SELF_API_KEY  && LIVEKIT_SELF_API_SECRET);

  if (livekitRuntimeMode === "cloud") {
    if (!cloudReady) console.warn("[party] mode=cloud tapi Cloud credentials belum diset");
    return { url: LIVEKIT_CLOUD_URL, apiKey: LIVEKIT_CLOUD_API_KEY, apiSecret: LIVEKIT_CLOUD_API_SECRET, provider: "cloud" };
  }
  if (livekitRuntimeMode === "selfhosted") {
    if (!selfReady) console.warn("[party] mode=selfhosted tapi Self-hosted credentials belum diset");
    return { url: LIVEKIT_SELF_URL, apiKey: LIVEKIT_SELF_API_KEY, apiSecret: LIVEKIT_SELF_API_SECRET, provider: "selfhosted" };
  }
  // auto: prefer cloud, fallback ke self-hosted
  if (cloudReady) {
    return { url: LIVEKIT_CLOUD_URL, apiKey: LIVEKIT_CLOUD_API_KEY, apiSecret: LIVEKIT_CLOUD_API_SECRET, provider: "cloud" };
  }
  return { url: LIVEKIT_SELF_URL, apiKey: LIVEKIT_SELF_API_KEY, apiSecret: LIVEKIT_SELF_API_SECRET, provider: "selfhosted" };
}

const MAX_SEATS = 8;

function partyRoomName(roomId: string): string {
  return `party-${roomId}`;
}

async function generateLiveKitToken(
  roomId: string,
  identity: string,
  canPublish: boolean,
): Promise<{ token: string; url: string; provider: "cloud" | "selfhosted" }> {
  const lk = getActiveLiveKit();
  const at = new AccessToken(lk.apiKey, lk.apiSecret, {
    identity,
    ttl: 3600,
  });
  at.addGrant({
    roomJoin: true,
    room: partyRoomName(roomId),
    canPublish,
    canSubscribe: true,
  });
  const token = await at.toJwt();
  return { token, url: lk.url, provider: lk.provider };
}

async function requirePartyOwner(
  req: Request,
  res: Response,
  roomId: string,
): Promise<boolean> {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not logged in" });
    return false;
  }
  const result = await db.execute(sql`
    SELECT creator_id FROM party_rooms WHERE id = ${roomId} LIMIT 1
  `);
  const row = result.rows[0] as { creator_id?: string } | undefined;
  if (!row) {
    res.status(404).json({ error: "Party room tidak ditemukan" });
    return false;
  }
  const isAdmin = await storage.isGlobalAdmin(req.session.userId);
  if (!isAdmin && row.creator_id !== req.session.userId) {
    res.status(403).json({ error: "Hanya owner atau admin yang bisa melakukan ini" });
    return false;
  }
  return true;
}

async function fetchPartySeats(roomId: string, maxSeats?: number) {
  const count = maxSeats ?? (await getRoomMaxSeats(roomId));
  const result = await db.execute(sql`
    SELECT ps.seat_index, ps.user_id, ps.username, ps.display_name, ps.avatar_url,
           ps.avatar_frame_url,
           ps.is_muted, ps.is_hand_raised, ps.livekit_identity, ps.joined_at,
           COALESCE(ps.seat_diamonds, 0) AS seat_diamonds,
           COALESCE(ps.seat_coins, 0) AS seat_coins,
           COALESCE(ps.is_locked, false) AS is_locked
    FROM party_seats ps
    WHERE ps.party_room_id = ${roomId}
    ORDER BY ps.seat_index ASC
  `);
  const bySeat = new Map<number, any>();
  for (const r of result.rows as any[]) {
    bySeat.set(Number(r.seat_index), r);
  }
  return Array.from({ length: count }, (_, i) => bySeat.get(i + 1) || {
    seat_index: i + 1,
    user_id: null,
    username: null,
    display_name: null,
    avatar_url: null,
    avatar_frame_url: null,
    is_muted: false,
    is_hand_raised: false,
    livekit_identity: null,
    joined_at: null,
    seat_diamonds: 0,
    seat_coins: 0,
    is_locked: false,
  });
}

async function getRoomMaxSeats(roomId: string): Promise<number> {
  const res = await db.execute(sql`SELECT max_seats FROM party_rooms WHERE id = ${roomId} LIMIT 1`);
  return Number((res.rows[0] as any)?.max_seats ?? MAX_SEATS);
}

async function ensurePartySeats(roomId: string): Promise<void> {
  const maxSeats = await getRoomMaxSeats(roomId);
  for (let i = 1; i <= maxSeats; i++) {
    await db.execute(sql`
      INSERT INTO party_seats (party_room_id, seat_index)
      VALUES (${roomId}, ${i})
      ON CONFLICT (party_room_id, seat_index) DO NOTHING
    `);
  }
}

// ── Helper: check owner OR party room admin ───────────────────────────────────
async function requireOwnerOrPartyAdmin(
  req: Request,
  res: Response,
  roomId: string,
): Promise<boolean> {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not logged in" });
    return false;
  }
  const roomResult = await db.execute(sql`
    SELECT creator_id FROM party_rooms WHERE id = ${roomId} LIMIT 1
  `);
  const row = roomResult.rows[0] as { creator_id?: string } | undefined;
  if (!row) {
    res.status(404).json({ error: "Party room tidak ditemukan" });
    return false;
  }
  if (row.creator_id === req.session.userId) return true;
  const isGlobal = await storage.isGlobalAdmin(req.session.userId);
  if (isGlobal) return true;
  const adminResult = await db.execute(sql`
    SELECT id FROM party_room_admins
    WHERE party_room_id = ${roomId} AND user_id = ${req.session.userId}
    LIMIT 1
  `);
  if (adminResult.rows.length > 0) return true;
  res.status(403).json({ error: "Hanya owner atau admin room yang bisa melakukan ini" });
  return false;
}

export function registerLivePartyRoutes(app: Express) {

  // ── GET /api/party/livekit-mode ───────────────────────────────────────────
  // Beri tahu klien provider mana yang aktif (cloud/selfhosted) dan readiness
  app.get("/api/party/livekit-mode", (_req, res) => {
    const lk = getActiveLiveKit();
    const cloudReady = !!(LIVEKIT_CLOUD_URL && LIVEKIT_CLOUD_API_KEY && LIVEKIT_CLOUD_API_SECRET);
    const selfReady  = !!(LIVEKIT_SELF_URL  && LIVEKIT_SELF_API_KEY  && LIVEKIT_SELF_API_SECRET);
    res.json({
      mode: livekitRuntimeMode,
      active: lk.provider,
      ready: !!(lk.url && lk.apiKey && lk.apiSecret),
      cloud: { configured: cloudReady, url: LIVEKIT_CLOUD_URL || null },
      self:  { configured: selfReady,  url: LIVEKIT_SELF_URL  || null },
    });
  });

  // ── GET /api/party/rooms ─────────────────────────────────────────────────
  app.get("/api/party/rooms", async (req, res) => {
    try {
      const cached = await getPartyRoomsList();
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.json(JSON.parse(cached));
      }

      const roomResult = await db.execute(sql`
        SELECT
          pr.id,
          pr.name,
          pr.description,
          pr.color,
          pr.creator_id,
          pr.creator_username,
          pr.max_seats,
          pr.is_active,
          pr.is_locked,
          pr.created_at,
          pr.updated_at,
          up.display_picture AS creator_avatar,
          COALESCE((
            SELECT SUM(pil.coin_amount)
            FROM party_income_log pil
            WHERE pil.room_id = pr.id
          ), 0) AS total_coins
        FROM party_rooms pr
        LEFT JOIN user_profiles up ON up.user_id = pr.creator_id
        WHERE pr.is_active = true
        ORDER BY total_coins DESC, pr.created_at DESC
        LIMIT 100
      `);
      const roomRows = roomResult.rows as any[];
      if (roomRows.length === 0) {
        const empty = { rooms: [] };
        await setPartyRoomsList(JSON.stringify(empty));
        return res.json(empty);
      }

      const seatsResult = await db.execute(sql`
        SELECT ps.party_room_id, ps.username, ps.display_name, ps.avatar_url
        FROM party_seats ps
        INNER JOIN party_rooms pr ON pr.id = ps.party_room_id
        WHERE pr.is_active = true
          AND ps.user_id IS NOT NULL
        ORDER BY ps.joined_at ASC
      `);
      const seatsByRoom = new Map<string, { username: string; displayName: string | null; avatarUrl: string | null }[]>();
      for (const s of seatsResult.rows as any[]) {
        const arr = seatsByRoom.get(s.party_room_id) ?? [];
        arr.push({ username: s.username, displayName: s.display_name ?? null, avatarUrl: s.avatar_url ?? null });
        seatsByRoom.set(s.party_room_id, arr);
      }

      const rooms = roomRows.map(r => {
        const participants = seatsByRoom.get(r.id) ?? [];
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          color: r.color,
          creatorUsername: r.creator_username,
          creatorAvatar: r.creator_avatar ?? null,
          maxParticipants: Number(r.max_seats),
          currentParticipants: participants.length,
          participants,
          isActive: r.is_active,
          isLocked: r.is_locked === true,
          createdAt: r.created_at,
          totalCoins: Number(r.total_coins ?? 0),
        };
      });
      const payload = { rooms };
      await setPartyRoomsList(JSON.stringify(payload));
      res.setHeader("X-Cache", "MISS");
      res.json(payload);
    } catch (err) {
      console.error("[party/rooms] GET error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms ─────────────────────────────────────────────────
  app.post("/api/party/rooms", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

      // ── Deduplication: return existing active room if creator already has one ──
      const existing = await db.execute(sql`
        SELECT id, name, description, color, creator_username, max_seats,
               is_active, is_locked, free_seat, created_at
        FROM party_rooms
        WHERE creator_id = ${user.id} AND is_active = true
        ORDER BY created_at DESC
        LIMIT 1
      `);
      if (existing.rows.length > 0) {
        const room = existing.rows[0] as any;
        await ensurePartySeats(room.id);
        return res.json({
          room: {
            id: room.id,
            name: room.name,
            description: room.description,
            color: room.color,
            creatorUsername: room.creator_username,
            maxParticipants: Number(room.max_seats),
            currentParticipants: 0,
            isActive: room.is_active,
            isLocked: room.is_locked,
            createdAt: room.created_at,
          },
        });
      }

      // Cleanup any old inactive rooms from this creator before creating new one
      await db.execute(sql`
        DELETE FROM party_seats WHERE party_room_id IN (
          SELECT id FROM party_rooms WHERE creator_id = ${user.id} AND is_active = false
        )
      `).catch(() => {});
      await db.execute(sql`
        DELETE FROM party_rooms WHERE creator_id = ${user.id} AND is_active = false
      `).catch(() => {});

      const { name, description, color } = req.body;
      const roomName  = String(name || `${user.username}'s Party`).slice(0, 80);
      const roomDesc  = description ? String(description).slice(0, 200) : null;
      const roomColor = String(color || "#7C3AED").slice(0, 20);

      const result = await db.execute(sql`
        INSERT INTO party_rooms (name, description, color, creator_id, creator_username, max_seats)
        VALUES (${roomName}, ${roomDesc}, ${roomColor}, ${user.id}, ${user.username}, ${MAX_SEATS})
        RETURNING id, name, description, color, creator_username, max_seats, is_active, created_at
      `);
      const room = result.rows[0] as any;

      await ensurePartySeats(room.id);

      await invalidatePartyRoomsList();

      res.status(201).json({
        room: {
          id: room.id,
          name: room.name,
          description: room.description,
          color: room.color,
          creatorUsername: room.creator_username,
          maxParticipants: Number(room.max_seats),
          currentParticipants: 0,
          isActive: room.is_active,
          createdAt: room.created_at,
        },
      });
    } catch (err) {
      console.error("[party/rooms] POST error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── GET /api/party/rooms/:id ──────────────────────────────────────────────
  app.get("/api/party/rooms/:id", async (req, res) => {
    try {
      const roomId = req.params.id;
      const cached = await getPartyRoom(roomId);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.json(JSON.parse(cached));
      }

      const result = await db.execute(sql`
        SELECT
          pr.id, pr.name, pr.description, pr.color,
          pr.creator_id, pr.creator_username, pr.max_seats, pr.is_active, pr.created_at,
          pr.free_seat, pr.is_locked, pr.background_image,
          COUNT(ps.id) FILTER (WHERE ps.user_id IS NOT NULL) AS participant_count
        FROM party_rooms pr
        LEFT JOIN party_seats ps ON ps.party_room_id = pr.id
        WHERE pr.id = ${roomId}
        GROUP BY pr.id
        LIMIT 1
      `);
      const r = result.rows[0] as any;
      if (!r) return res.status(404).json({ error: "Room tidak ditemukan" });
      const payload = {
        room: {
          id: r.id,
          name: r.name,
          description: r.description,
          color: r.color,
          creatorUsername: r.creator_username,
          maxParticipants: Number(r.max_seats),
          currentParticipants: Number(r.participant_count ?? 0),
          isActive: r.is_active,
          freeSeat: r.free_seat !== false,
          isLocked: r.is_locked === true,
          backgroundImage: r.background_image ?? null,
          createdAt: r.created_at,
        },
      };
      await setPartyRoom(roomId, JSON.stringify(payload));
      res.setHeader("X-Cache", "MISS");
      res.json(payload);
    } catch (err) {
      console.error("[party/rooms/:id] GET error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── PATCH /api/party/rooms/:id/seat-count ────────────────────────────────
  app.patch("/api/party/rooms/:id/seat-count", async (req, res) => {
    const roomId = req.params.id;
    if (!(await requireOwnerOrPartyAdmin(req, res, roomId))) return;
    try {
      const count = Number(req.body?.count);
      if (!Number.isInteger(count) || count < 2 || count > 30) {
        return res.status(400).json({ error: "Jumlah kursi harus antara 2–30" });
      }

      // 1. Keluarkan semua user dari kursi terlebih dahulu agar tidak kacau
      await db.execute(sql`
        UPDATE party_seats
        SET user_id = NULL, username = NULL, display_name = NULL,
            avatar_url = NULL, avatar_frame_url = NULL, is_muted = false,
            livekit_identity = NULL, joined_at = NULL, updated_at = NOW()
        WHERE party_room_id = ${roomId}
      `);

      // 2. Hapus baris kursi yang melebihi count baru (kalau shrink)
      await db.execute(sql`
        DELETE FROM party_seats
        WHERE party_room_id = ${roomId} AND seat_index > ${count}
      `);

      // 3. Update jumlah kursi di room
      await db.execute(sql`
        UPDATE party_rooms SET max_seats = ${count}, updated_at = NOW() WHERE id = ${roomId}
      `);

      // 4. Pastikan baris kursi baru tersedia (kalau expand)
      await ensurePartySeats(roomId);

      // 5. Invalidate cache
      await Promise.all([invalidatePartyRoom(roomId), invalidatePartySeats(roomId), invalidatePartyRoomsList()]);

      // 6. Broadcast ke semua member di room agar semua client reset seat grid
      broadcastToRoom(roomId, {
        type: 'SEAT_COUNT',
        roomId,
        count,
        reset: true,
      } as any);

      res.json({ ok: true, count });
    } catch (err) {
      console.error("[party/rooms/:id/seat-count] PATCH error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── PATCH /api/party/rooms/:id/seat-mode ─────────────────────────────────
  app.patch("/api/party/rooms/:id/seat-mode", async (req, res) => {
    const roomId = req.params.id;
    if (!(await requireOwnerOrPartyAdmin(req, res, roomId))) return;
    try {
      const freeSeat = req.body?.freeSeat !== false;
      await db.execute(sql`
        UPDATE party_rooms SET free_seat = ${freeSeat}, updated_at = NOW() WHERE id = ${roomId}
      `);
      await invalidatePartyRoom(roomId);
      res.json({ ok: true, freeSeat });
    } catch (err) {
      console.error("[party/rooms/:id/seat-mode] PATCH error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── PATCH /api/party/rooms/:id ────────────────────────────────────────────
  app.patch("/api/party/rooms/:id", async (req, res) => {
    const roomId = req.params.id;
    if (!(await requirePartyOwner(req, res, roomId))) return;
    try {
      const { name, description, backgroundImage } = req.body;
      const hasName        = name !== undefined;
      const hasDescription = description !== undefined;
      const hasBg          = backgroundImage !== undefined;
      if (!hasName && !hasDescription && !hasBg) return res.json({ ok: true });

      await db.execute(sql`
        UPDATE party_rooms
        SET name             = COALESCE(${name ?? null}, name),
            description      = COALESCE(${description ?? null}, description),
            background_image = CASE WHEN ${hasBg} THEN ${backgroundImage ?? null} ELSE background_image END,
            updated_at       = NOW()
        WHERE id = ${roomId}
      `);
      await Promise.all([
        invalidatePartyRoom(roomId),
        invalidatePartyRoomsList(),
        hasBg ? invalidatePartySeats(roomId) : Promise.resolve(),
      ]);

      if (hasBg) {
        broadcastToRoom(roomId, {
          type: 'BG_CHANGE',
          roomId,
          backgroundImage: backgroundImage ?? null,
        } as any);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("[party/rooms/:id] PATCH error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/upload-background ───────────────────────────
  app.post("/api/party/rooms/:id/upload-background", async (req, res) => {
    const roomId = req.params.id;
    if (!(await requirePartyOwner(req, res, roomId))) return;
    try {
      const { base64Data, mimeType = "image/jpeg" } = req.body;
      if (!base64Data) return res.status(400).json({ error: "base64Data wajib diisi" });

      const sizeBytes = Math.round(base64Data.length * 0.75);
      if (sizeBytes > 8 * 1024 * 1024) return res.status(413).json({ error: "File terlalu besar. Maks 8MB." });

      const extMap: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
      const ext = extMap[mimeType] ?? "jpg";

      const { saveFileToDisk } = await import("../../utils/selfHostedUpload");
      const fileName = `party_bg_${roomId}_${Date.now()}.${ext}`;
      await saveFileToDisk({
        base64Data,
        fileName,
        subfolder: "party/backgrounds",
      });

      // Build the public URL for the uploaded file.
      // Priority:
      //   1. PUBLIC_API_URL   — set in production nginx setup (e.g. https://api.chatmeapp.my.id)
      //   2. REPLIT_DEV_DOMAIN — set automatically in Replit dev environment
      //   3. Relative path    — client (mobile) must prepend its own API base; always works
      // Files are served by Express static at /uploads — NOT from the CDN (img.chatmeapp.my.id).
      const _apiBase = (
        process.env.PUBLIC_API_URL ??
        (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
      ).replace(/\/$/, "");
      const url = _apiBase
        ? `${_apiBase}/uploads/party/backgrounds/${fileName}`
        : `/uploads/party/backgrounds/${fileName}`; // relative — mobile app prepends API_BASE

      await db.execute(sql`
        UPDATE party_rooms SET background_image = ${url}, updated_at = NOW() WHERE id = ${roomId}
      `);
      await Promise.all([
        invalidatePartyRoom(roomId),
        invalidatePartyRoomsList(),
        invalidatePartySeats(roomId),
      ]);

      broadcastToRoom(roomId, {
        type: 'BG_CHANGE',
        roomId,
        backgroundImage: url,
      } as any);

      return res.json({ ok: true, backgroundImage: url });
    } catch (err) {
      console.error("[party/rooms/:id/upload-background] POST error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── DELETE /api/party/rooms/:id ───────────────────────────────────────────
  app.delete("/api/party/rooms/:id", async (req, res) => {
    const roomId = req.params.id;
    if (!(await requirePartyOwner(req, res, roomId))) return;
    try {
      await db.execute(sql`DELETE FROM party_rooms WHERE id = ${roomId}`);
      await Promise.all([
        invalidatePartyRoom(roomId),
        invalidatePartySeats(roomId),
        invalidatePartyRoomsList(),
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[party/rooms/:id] DELETE error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── GET /api/party/rooms/:id/state ───────────────────────────────────────
  app.get("/api/party/rooms/:id/state", async (req, res) => {
    try {
      const roomId = (req.params.id || "").trim();
      if (!roomId) return res.status(400).json({ error: "Room ID required" });

      const cached = await getPartySeats(roomId);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.json(JSON.parse(cached));
      }

      const roomRow = await db.execute(sql`SELECT max_seats, background_image FROM party_rooms WHERE id = ${roomId} LIMIT 1`);
      const roomMeta  = (roomRow.rows[0] as any) ?? {};
      const maxSeats  = Number(roomMeta.max_seats ?? MAX_SEATS);
      const seats = await fetchPartySeats(roomId, maxSeats);
      const bgImage   = (roomMeta.background_image as string | null) ?? null;
      const lockedSeats = seats
        .filter((s: any) => s.is_locked && !s.user_id)
        .map((s: any) => Number(s.seat_index));
      const payload = { roomId, seats, maxSeats, lockedSeats, backgroundImage: bgImage };
      await setPartySeats(roomId, JSON.stringify(payload));
      res.setHeader("X-Cache", "MISS");
      res.json(payload);
    } catch (err) {
      console.error("[party/rooms/:id/state] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/lock ───────────────────────────────────────
  app.post("/api/party/rooms/:id/lock", async (req, res) => {
    const roomId = req.params.id;
    if (!(await requirePartyOwner(req, res, roomId))) return;
    try {
      const { password } = req.body;
      if (password === null || password === undefined || password === '') {
        await db.execute(sql`
          UPDATE party_rooms SET is_locked = false, room_password = NULL, updated_at = NOW()
          WHERE id = ${roomId}
        `);
        await Promise.all([invalidatePartyRoom(roomId), invalidatePartyRoomsList()]);
        broadcastToRoom(roomId, { type: 'PARTY_UNLOCKED', roomId } as any);
        return res.json({ ok: true, isLocked: false });
      }
      const pw = String(password).trim();
      if (!/^\d{4}$/.test(pw)) {
        return res.status(400).json({ error: "Password harus 4 digit angka" });
      }
      await db.execute(sql`
        UPDATE party_rooms SET is_locked = true, room_password = ${pw}, updated_at = NOW()
        WHERE id = ${roomId}
      `);
      await Promise.all([invalidatePartyRoom(roomId), invalidatePartyRoomsList()]);
      broadcastToRoom(roomId, { type: 'PARTY_LOCKED', roomId } as any);
      return res.json({ ok: true, isLocked: true });
    } catch (err) {
      console.error("[party/rooms/:id/lock] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/token ──────────────────────────────────────
  app.post("/api/party/rooms/:id/token", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.id;
    try {
      const lkCheck = getActiveLiveKit();
      if (!lkCheck.url || !lkCheck.apiKey || !lkCheck.apiSecret) {
        return res.status(503).json({ error: "LiveKit belum dikonfigurasi di server" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

      const roomCheck = await db.execute(sql`
        SELECT id, is_locked, room_password, creator_id FROM party_rooms WHERE id = ${roomId} AND is_active = true LIMIT 1
      `);
      if (!roomCheck.rows[0]) {
        return res.status(404).json({ error: "Party room tidak ditemukan" });
      }

      // ── Password check for locked rooms ──────────────────────────────────
      const roomRow = roomCheck.rows[0] as any;
      if (roomRow.is_locked && roomRow.creator_id !== user.id) {
        const isAdmin = await storage.isGlobalAdmin(user.id);
        if (!isAdmin) {
          const provided = String(req.body?.password || '').trim();
          if (provided !== roomRow.room_password) {
            return res.status(403).json({ error: "WRONG_PASSWORD", message: "Kata sandi salah" });
          }
        }
      }

      // Auto-detect role: jika user sudah duduk di kursi, otomatis publisher
      const seatCheck = await db.execute(sql`
        SELECT seat_index FROM party_seats
        WHERE party_room_id = ${roomId} AND user_id = ${user.id}
        LIMIT 1
      `);
      const hasSeated = !!seatCheck.rows[0];
      const requestedRole = req.body?.role === "publisher" ? "publisher" : "audience";
      const role = hasSeated ? "publisher" : requestedRole;
      const canPublish = role === "publisher";
      const identity = user.username;

      const { token, url, provider } = await generateLiveKitToken(roomId, identity, canPublish);

      console.log(`[party/token] provider=${provider} room=${roomId} user=${identity} role=${role} hasSeated=${hasSeated}`);

      res.json({
        token,
        url,
        provider,
        roomName: partyRoomName(roomId),
        identity,
        role,
      });
    } catch (err) {
      console.error("[party/rooms/:id/token] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/seats/:n/take ───────────────────────────────
  app.post("/api/party/rooms/:id/seats/:n/take", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.id;
    const seatIndex = parseInt(String(req.params.n), 10);
    try {
      const roomMax = await getRoomMaxSeats(roomId);
      if (isNaN(seatIndex) || seatIndex < 1 || seatIndex > roomMax) {
        return res.status(400).json({ error: `Seat index tidak valid (1–${roomMax})` });
      }
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

      // Auto-clear ghost seats dari room LAIN (app close tanpa tekan Leave)
      await db.execute(sql`
        UPDATE party_seats
        SET user_id = NULL, username = NULL, display_name = NULL,
            avatar_url = NULL, avatar_frame_url = NULL, is_muted = false,
            livekit_identity = NULL, joined_at = NULL, updated_at = NOW()
        WHERE user_id = ${user.id} AND party_room_id != ${roomId}
      `).catch(() => {});

      const alreadySeated = await db.execute(sql`
        SELECT seat_index FROM party_seats
        WHERE party_room_id = ${roomId} AND user_id = ${user.id}
        LIMIT 1
      `);
      if (alreadySeated.rows[0]) {
        return res.status(409).json({ error: `Kamu sudah di kursi ${(alreadySeated.rows[0] as any).seat_index}` });
      }

      const occupied = await db.execute(sql`
        SELECT user_id, COALESCE(is_locked, false) AS is_locked FROM party_seats
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      if ((occupied.rows[0] as any)?.user_id) {
        return res.status(409).json({ error: "Kursi sudah dipakai" });
      }

      // Cek apakah kursi dikunci — hanya owner/admin yang boleh duduk
      if ((occupied.rows[0] as any)?.is_locked) {
        const roomOwner = await db.execute(sql`
          SELECT creator_id FROM party_rooms WHERE id = ${roomId} LIMIT 1
        `);
        const creatorId = (roomOwner.rows[0] as any)?.creator_id;
        const isOwner = creatorId === user.id;
        const isGlobalAdmin = await storage.isGlobalAdmin(user.id);
        const isRoomAdmin = isGlobalAdmin ? true : (await db.execute(sql`
          SELECT id FROM party_room_admins WHERE party_room_id = ${roomId} AND user_id = ${user.id} LIMIT 1
        `)).rows.length > 0;
        if (!isOwner && !isRoomAdmin) {
          return res.status(403).json({ error: "Kursi dikunci oleh host. Hubungi host untuk membuka kunci." });
        }
      }

      await ensurePartySeats(roomId);

      // Cek shop frame dari user_profiles terlebih dahulu (prioritas lebih tinggi)
      let avatarFrameUrl: string | null = null;
      try {
        const shopRow = await db.execute(sql`
          SELECT avatar_frame_url FROM user_profiles WHERE user_id = ${user.id} LIMIT 1
        `);
        avatarFrameUrl = (shopRow.rows[0] as any)?.avatar_frame_url ?? null;
      } catch {}

      // Fallback ke badge frame jika tidak ada shop frame
      if (!avatarFrameUrl) {
        try {
          const frameRow = await db.execute(sql`
            SELECT b.avatar_frame_url
            FROM user_badges ub
            JOIN badges b ON b.id = ub.badge_id
            WHERE ub.user_id = ${user.id} AND b.avatar_frame_url IS NOT NULL
            ORDER BY ub.awarded_at DESC
            LIMIT 1
          `);
          avatarFrameUrl = (frameRow.rows[0] as any)?.avatar_frame_url ?? null;
        } catch {
          // tabel user_badges belum ada — tidak masalah, lanjutkan tanpa frame
        }
      }

      await db.execute(sql`
        UPDATE party_seats
        SET user_id = ${user.id},
            username = ${user.username},
            display_name = ${(user as any).displayName || user.username},
            avatar_url = ${(user as any).avatarUrl || null},
            avatar_frame_url = ${avatarFrameUrl},
            is_muted = false,
            livekit_identity = ${user.username},
            joined_at = NOW(),
            updated_at = NOW(),
            seat_diamonds = 0,
            seat_coins = 0
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
      `);

      // ── Log sesi live ──────────────────────────────────────────────────────
      // Tutup ghost sessions di room lain (user tidak menekan Leave)
      db.execute(sql`
        UPDATE party_live_sessions
        SET ended_at = NOW(),
            duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER)
        WHERE user_id = ${user.id} AND ended_at IS NULL AND room_id != ${roomId}
      `).catch(() => {});
      // Buka sesi baru untuk kursi ini
      db.execute(sql`
        INSERT INTO party_live_sessions (room_id, room_name, user_id, username, seat_index, started_at)
        SELECT ${roomId}, COALESCE(r.name, ''), ${user.id}, ${user.username}, ${seatIndex}, NOW()
        FROM party_rooms r WHERE r.id = ${roomId}
      `).catch(() => {});

      await Promise.all([invalidatePartySeats(roomId), invalidatePartyRoomsList()]);
      res.json({ ok: true, seatIndex, username: user.username });
    } catch (err) {
      console.error("[party/seats/take] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/seats/:n/leave ──────────────────────────────
  app.post("/api/party/rooms/:id/seats/:n/leave", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.id;
    const seatIndex = parseInt(String(req.params.n), 10);
    try {
      const roomMax = await getRoomMaxSeats(roomId);
      if (isNaN(seatIndex) || seatIndex < 1 || seatIndex > roomMax) {
        return res.status(400).json({ error: `Seat index tidak valid (1–${roomMax})` });
      }
      const seatRes = await db.execute(sql`
        SELECT user_id FROM party_seats
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      const seat = seatRes.rows[0] as { user_id?: string } | undefined;
      if (!seat?.user_id) {
        return res.status(404).json({ error: "Kursi sudah kosong" });
      }

      const isSelf = seat.user_id === req.session.userId;
      if (!isSelf) {
        const [isAdmin, roomRow] = await Promise.all([
          storage.isGlobalAdmin(req.session.userId),
          db.execute(sql`SELECT creator_id FROM party_rooms WHERE id = ${roomId} LIMIT 1`),
        ]);
        const creatorId = (roomRow.rows[0] as any)?.creator_id;
        if (!isAdmin && creatorId !== req.session.userId) {
          return res.status(403).json({ error: "Hanya owner atau admin yang bisa mengeluarkan orang" });
        }
      }

      const vacatedUserId = seat.user_id!;

      await db.execute(sql`
        UPDATE party_seats
        SET user_id = NULL, username = NULL, display_name = NULL,
            avatar_url = NULL, is_muted = false, livekit_identity = NULL,
            joined_at = NULL, updated_at = NOW()
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
      `);

      // Tutup sesi live untuk user yang meninggalkan kursi
      db.execute(sql`
        UPDATE party_live_sessions
        SET ended_at = NOW(),
            duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER)
        WHERE room_id = ${roomId} AND user_id = ${vacatedUserId} AND ended_at IS NULL
      `).catch(() => {});

      // Room stays active even when creator leaves seat — room only closes when explicitly deleted
      await Promise.all([invalidatePartySeats(roomId), invalidatePartyRoomsList()]);
      res.json({ ok: true, seatIndex });
    } catch (err) {
      console.error("[party/seats/leave] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/seats/leave-all ──────────────────────────────────────
  // Dipanggil oleh mobile app saat modal party ditutup / app background.
  // Clear SEMUA seat user di semua room tanpa perlu tahu room/seat mana.
  app.post("/api/party/seats/leave-all", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    try {
      // Ambil daftar room yang akan terpengaruh sebelum di-clear
      const affectedRooms = await db.execute(sql`
        SELECT DISTINCT party_room_id FROM party_seats WHERE user_id = ${req.session.userId}
      `);

      await db.execute(sql`
        UPDATE party_seats
        SET user_id = NULL, username = NULL, display_name = NULL,
            avatar_url = NULL, avatar_frame_url = NULL, is_muted = false,
            livekit_identity = NULL, joined_at = NULL, updated_at = NOW()
        WHERE user_id = ${req.session.userId}
      `);

      // Tutup semua sesi live untuk user ini
      db.execute(sql`
        UPDATE party_live_sessions
        SET ended_at = NOW(),
            duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER)
        WHERE user_id = ${req.session.userId!} AND ended_at IS NULL
      `).catch(() => {});

      // Invalidasi seats cache semua room yang terpengaruh + list
      const roomIds = (affectedRooms.rows as any[]).map(r => r.party_room_id as string);
      await Promise.all([
        invalidatePartyRoomsList(),
        ...roomIds.map(id => invalidatePartySeats(id)),
      ]);

      res.json({ ok: true });
    } catch (err) {
      console.error("[party/seats/leave-all] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/seats/:n/mute ───────────────────────────────
  app.post("/api/party/rooms/:id/seats/:n/mute", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.id;
    const seatIndex = parseInt(String(req.params.n), 10);
    const muted = !!req.body?.muted;
    try {
      const roomMax = await getRoomMaxSeats(roomId);
      if (isNaN(seatIndex) || seatIndex < 1 || seatIndex > roomMax) {
        return res.status(400).json({ error: `Seat index tidak valid (1–${roomMax})` });
      }
      const seatRes = await db.execute(sql`
        SELECT user_id FROM party_seats
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      const seat = seatRes.rows[0] as { user_id?: string } | undefined;
      if (!seat?.user_id) return res.status(404).json({ error: "Kursi kosong" });

      const isSelf = seat.user_id === req.session.userId;
      if (!isSelf) {
        const [isAdmin, roomRow] = await Promise.all([
          storage.isGlobalAdmin(req.session.userId),
          db.execute(sql`SELECT creator_id FROM party_rooms WHERE id = ${roomId} LIMIT 1`),
        ]);
        const creatorId = (roomRow.rows[0] as any)?.creator_id;
        if (!isAdmin && creatorId !== req.session.userId) {
          return res.status(403).json({ error: "Tidak diizinkan" });
        }
      }

      await db.execute(sql`
        UPDATE party_seats
        SET is_muted = ${muted}, updated_at = NOW()
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
      `);

      await invalidatePartySeats(roomId);
      res.json({ ok: true, seatIndex, muted });
    } catch (err) {
      console.error("[party/seats/mute] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/seats/:n/raise-hand ────────────────────────
  // User toggle angkat tangan sendiri. Host/admin bisa lower tangan user lain.
  app.post("/api/party/rooms/:id/seats/:n/raise-hand", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId    = req.params.id;
    const seatIndex = parseInt(String(req.params.n), 10);
    const raised = !!req.body?.raised;
    try {
      const roomMax = await getRoomMaxSeats(roomId);
      if (isNaN(seatIndex) || seatIndex < 1 || seatIndex > roomMax) {
        return res.status(400).json({ error: `Seat index tidak valid (1–${roomMax})` });
      }
      const seatRes = await db.execute(sql`
        SELECT user_id FROM party_seats
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      const seat = seatRes.rows[0] as { user_id?: string } | undefined;
      if (!seat?.user_id) return res.status(404).json({ error: "Kursi kosong" });

      const isSelf = seat.user_id === req.session.userId;
      if (!isSelf) {
        // Host/admin boleh lower tangan user lain (raised=false saja)
        if (raised) return res.status(403).json({ error: "Tidak bisa raise tangan orang lain" });
        const [isAdmin, roomRow] = await Promise.all([
          storage.isGlobalAdmin(req.session.userId),
          db.execute(sql`SELECT creator_id FROM party_rooms WHERE id = ${roomId} LIMIT 1`),
        ]);
        const creatorId = (roomRow.rows[0] as any)?.creator_id;
        if (!isAdmin && creatorId !== req.session.userId) {
          return res.status(403).json({ error: "Tidak diizinkan" });
        }
      }

      await db.execute(sql`
        UPDATE party_seats
        SET is_hand_raised = ${raised}, updated_at = NOW()
        WHERE party_room_id = ${roomId} AND seat_index = ${seatIndex}
      `);

      await invalidatePartySeats(roomId);
      res.json({ ok: true, seatIndex, raised });
    } catch (err) {
      console.error("[party/seats/raise-hand] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MEMBER MANAGEMENT — Muted / Kicked / Admins
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/party/rooms/:id/muted ────────────────────────────────────────
  app.get("/api/party/rooms/:id/muted", async (req, res) => {
    const roomId = req.params.id;
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    try {
      const result = await db.execute(sql`
        SELECT user_id, username, avatar_url, muted_by_username, muted_at
        FROM party_muted_users WHERE party_room_id = ${roomId}
        ORDER BY muted_at DESC
      `);
      res.json({ muted: result.rows });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/muted ──────────────────────────────────────
  app.post("/api/party/rooms/:id/muted", async (req, res) => {
    const roomId = req.params.id;
    if (!await requireOwnerOrPartyAdmin(req, res, roomId)) return;
    const { userId, username, avatarUrl } = req.body;
    if (!userId) return res.status(400).json({ error: "userId diperlukan" });
    try {
      const me = await db.execute(sql`SELECT username FROM users WHERE id = ${req.session!.userId} LIMIT 1`);
      const myUsername = (me.rows[0] as any)?.username || '';
      await db.execute(sql`
        INSERT INTO party_muted_users (party_room_id, user_id, username, avatar_url, muted_by, muted_by_username)
        VALUES (${roomId}, ${userId}, ${username || ''}, ${avatarUrl || ''}, ${req.session!.userId}, ${myUsername})
        ON CONFLICT (party_room_id, user_id) DO NOTHING
      `);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── DELETE /api/party/rooms/:id/muted/:uid ────────────────────────────────
  app.delete("/api/party/rooms/:id/muted/:uid", async (req, res) => {
    const { id: roomId, uid } = req.params;
    if (!await requireOwnerOrPartyAdmin(req, res, roomId)) return;
    try {
      await db.execute(sql`
        DELETE FROM party_muted_users WHERE party_room_id = ${roomId} AND user_id = ${uid}
      `);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── GET /api/party/rooms/:id/kicked ──────────────────────────────────────
  app.get("/api/party/rooms/:id/kicked", async (req, res) => {
    const roomId = req.params.id;
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    try {
      const result = await db.execute(sql`
        SELECT user_id, username, avatar_url, kicked_by_username, kicked_at
        FROM party_kicked_users WHERE party_room_id = ${roomId}
        ORDER BY kicked_at DESC
      `);
      res.json({ kicked: result.rows });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/kicked ─────────────────────────────────────
  app.post("/api/party/rooms/:id/kicked", async (req, res) => {
    const roomId = req.params.id;
    if (!await requireOwnerOrPartyAdmin(req, res, roomId)) return;
    const { userId, username, avatarUrl } = req.body;
    if (!userId) return res.status(400).json({ error: "userId diperlukan" });
    try {
      const me = await db.execute(sql`SELECT username FROM users WHERE id = ${req.session!.userId} LIMIT 1`);
      const myUsername = (me.rows[0] as any)?.username || '';
      await db.execute(sql`
        INSERT INTO party_kicked_users (party_room_id, user_id, username, avatar_url, kicked_by, kicked_by_username)
        VALUES (${roomId}, ${userId}, ${username || ''}, ${avatarUrl || ''}, ${req.session!.userId}, ${myUsername})
        ON CONFLICT (party_room_id, user_id) DO NOTHING
      `);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── DELETE /api/party/rooms/:id/kicked/:uid ───────────────────────────────
  app.delete("/api/party/rooms/:id/kicked/:uid", async (req, res) => {
    const { id: roomId, uid } = req.params;
    if (!await requireOwnerOrPartyAdmin(req, res, roomId)) return;
    try {
      await db.execute(sql`
        DELETE FROM party_kicked_users WHERE party_room_id = ${roomId} AND user_id = ${uid}
      `);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── GET /api/party/rooms/:id/admins ──────────────────────────────────────
  app.get("/api/party/rooms/:id/admins", async (req, res) => {
    const roomId = req.params.id;
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    try {
      const result = await db.execute(sql`
        SELECT user_id, username, avatar_url, added_at
        FROM party_room_admins WHERE party_room_id = ${roomId}
        ORDER BY added_at ASC
      `);
      res.json({ admins: result.rows });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/admins ─────────────────────────────────────
  // Body: { username: string }  — owner only, max 5 admins
  app.post("/api/party/rooms/:id/admins", async (req, res) => {
    const roomId = req.params.id;
    if (!await requirePartyOwner(req, res, roomId)) return;
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "username diperlukan" });
    try {
      const countResult = await db.execute(sql`
        SELECT COUNT(*) as cnt FROM party_room_admins WHERE party_room_id = ${roomId}
      `);
      const cnt = Number((countResult.rows[0] as any)?.cnt || 0);
      if (cnt >= 5) return res.status(400).json({ error: "Maksimal 5 admin per ruangan" });

      const userResult = await db.execute(sql`
        SELECT u.id, u.username, up.display_picture
        FROM users u
        LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE LOWER(u.username) = LOWER(${username})
        LIMIT 1
      `);
      const target = userResult.rows[0] as any;
      if (!target) return res.status(404).json({ error: "User tidak ditemukan" });

      await db.execute(sql`
        INSERT INTO party_room_admins (party_room_id, user_id, username, avatar_url, added_by)
        VALUES (${roomId}, ${target.id}, ${target.username}, ${target.display_picture || ''}, ${req.session!.userId})
        ON CONFLICT (party_room_id, user_id) DO NOTHING
      `);
      res.json({ ok: true, admin: { user_id: target.id, username: target.username, avatar_url: target.display_picture || '' } });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── DELETE /api/party/rooms/:id/admins/:uid ───────────────────────────────
  app.delete("/api/party/rooms/:id/admins/:uid", async (req, res) => {
    const { id: roomId, uid } = req.params;
    if (!await requirePartyOwner(req, res, roomId)) return;
    try {
      await db.execute(sql`
        DELETE FROM party_room_admins WHERE party_room_id = ${roomId} AND user_id = ${uid}
      `);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LEADERBOARD
  // ══════════════════════════════════════════════════════════════════════════

  // Query params: period=DAILY|WEEKLY|MONTHLY|ALL_TIME (default WEEKLY), limit=20
  // Returns: host yang menerima gift terbanyak (GIFT_RECEIVED dari diamond_transactions)
  //          dan pengirim gift terbanyak (PARTY_GIFT_SENT dari leaderboard_entries)
  //
  // SINKRONISASI: Host scores dihitung langsung dari diamond_transactions
  // agar selalu sama dengan yang ditampilkan di Agency Dashboard dan Admin Panel.
  // Tidak lagi bergantung pada leaderboard_entries untuk RECEIVED (yang bisa drift
  // karena update-nya fire-and-forget).
  app.get("/api/party/leaderboard", async (req, res) => {
    const period = String(req.query.period || LEADERBOARD_PERIOD.WEEKLY);
    const limit  = Math.min(parseInt(String(req.query.limit || "20"), 10), 50);

    const validPeriods = Object.values(LEADERBOARD_PERIOD);
    if (!validPeriods.includes(period as any)) {
      return res.status(400).json({ error: `Period tidak valid. Pilihan: ${validPeriods.join(", ")}` });
    }

    try {
      // ── Cache check ──────────────────────────────────────────────────────────
      const cached = await getPartyLeaderboard(period, limit);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.json(JSON.parse(cached));
      }

      // Pemetaan period ke Date — dihitung di sisi JS, diparameterisasi ke DB
      const now = Date.now();
      const sinceMs: Record<string, number | null> = {
        [LEADERBOARD_PERIOD.DAILY]:    now - 1  * 24 * 60 * 60 * 1000,
        [LEADERBOARD_PERIOD.WEEKLY]:   now - 7  * 24 * 60 * 60 * 1000,
        [LEADERBOARD_PERIOD.MONTHLY]:  now - 30 * 24 * 60 * 60 * 1000,
        [LEADERBOARD_PERIOD.ALL_TIME]: null,
      };
      const sinceDate = sinceMs[period] !== undefined && sinceMs[period] !== null
        ? new Date(sinceMs[period] as number)
        : null;

      // ── HOST LEADERBOARD: langsung dari diamond_transactions (source of truth) ──
      // Ini menjamin angka SELALU sama dengan Agency Dashboard dan Admin Panel.
      // Tidak bergantung pada leaderboard_entries yang bisa drift karena fire-and-forget.
      const hostQuery = sinceDate
        ? await db.execute(sql`
            SELECT username, CAST(SUM(amount) AS BIGINT) AS score
            FROM diamond_transactions
            WHERE type = 'GIFT_RECEIVED'
              AND created_at >= ${sinceDate}
            GROUP BY username
            ORDER BY score DESC
            LIMIT ${limit}
          `)
        : await db.execute(sql`
            SELECT username, CAST(SUM(amount) AS BIGINT) AS score
            FROM diamond_transactions
            WHERE type = 'GIFT_RECEIVED'
            GROUP BY username
            ORDER BY score DESC
            LIMIT ${limit}
          `);

      const hostRaw = hostQuery.rows.map((r: any) => ({
        username: r.username as string,
        score:    Number(r.score ?? 0),
      }));

      // ── SENDER LEADERBOARD: tetap dari leaderboard_entries (koin terkirim) ──
      const senderRaw = await storage.getLeaderboard(LEADERBOARD_TYPE.PARTY_GIFT_SENT, period, limit, 0);

      // Enrich dengan avatar dari user profiles
      const allUsernames = [...new Set([
        ...hostRaw.map(e => e.username),
        ...senderRaw.map(e => e.username),
      ])];

      let profileMap: Record<string, { displayPicture: string | null }> = {};
      if (allUsernames.length > 0) {
        const profiles = await db
          .select({ username: users.username, displayPicture: userProfiles.displayPicture })
          .from(users)
          .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
          .where(inArray(users.username, allUsernames));
        for (const p of profiles) {
          const rawDp = p.displayPicture ?? null;
          profileMap[p.username] = {
            displayPicture: rawDp && /\/api\/imageserver\/image\/[^/]+$/.test(rawDp)
              ? rawDp + '/data' : rawDp,
          };
        }
      }

      const enrichHosts = hostRaw.map((e, i) => ({
        ...e,
        position: i + 1,
        displayPicture: profileMap[e.username]?.displayPicture ?? null,
      }));

      const enrichSenders = senderRaw.map((e, i) => ({
        ...e,
        position: i + 1,
        displayPicture: profileMap[e.username]?.displayPicture ?? null,
      }));

      // ── AGENCY LEADERBOARD: total GIFT_RECEIVED semua host+owner per agency ──
      const agencyLbQuery = sinceDate
        ? await db.execute(sql`
            WITH agency_members AS (
              SELECT a.id AS agency_id, a.agency_name AS agency_name, a.registered_by AS owner,
                     LOWER(a.registered_by) AS member_username
              FROM agencies a WHERE a.status = 'approved'
              UNION ALL
              SELECT a.id, a.agency_name, a.registered_by, LOWER(ah.username)
              FROM agencies a
              JOIN agency_hosts ah ON ah.agency_id = a.id AND ah.status = 'active'
              WHERE a.status = 'approved'
            ),
            member_earnings AS (
              SELECT LOWER(dt.username) AS username, CAST(SUM(dt.amount) AS BIGINT) AS earned
              FROM diamond_transactions dt
              WHERE dt.type = 'GIFT_RECEIVED' AND dt.created_at >= ${sinceDate}
              GROUP BY LOWER(dt.username)
            )
            SELECT am.agency_id, am.agency_name, am.owner,
                   COALESCE(SUM(me.earned), 0)::BIGINT AS total_score,
                   COUNT(DISTINCT am.member_username) AS member_count
            FROM agency_members am
            LEFT JOIN member_earnings me ON me.username = am.member_username
            GROUP BY am.agency_id, am.agency_name, am.owner
            ORDER BY total_score DESC
            LIMIT ${limit}
          `)
        : await db.execute(sql`
            WITH agency_members AS (
              SELECT a.id AS agency_id, a.agency_name AS agency_name, a.registered_by AS owner,
                     LOWER(a.registered_by) AS member_username
              FROM agencies a WHERE a.status = 'approved'
              UNION ALL
              SELECT a.id, a.agency_name, a.registered_by, LOWER(ah.username)
              FROM agencies a
              JOIN agency_hosts ah ON ah.agency_id = a.id AND ah.status = 'active'
              WHERE a.status = 'approved'
            ),
            member_earnings AS (
              SELECT LOWER(dt.username) AS username, CAST(SUM(dt.amount) AS BIGINT) AS earned
              FROM diamond_transactions dt
              WHERE dt.type = 'GIFT_RECEIVED'
              GROUP BY LOWER(dt.username)
            )
            SELECT am.agency_id, am.agency_name, am.owner,
                   COALESCE(SUM(me.earned), 0)::BIGINT AS total_score,
                   COUNT(DISTINCT am.member_username) AS member_count
            FROM agency_members am
            LEFT JOIN member_earnings me ON me.username = am.member_username
            GROUP BY am.agency_id, am.agency_name, am.owner
            ORDER BY total_score DESC
            LIMIT ${limit}
          `);

      const enrichAgencies = (agencyLbQuery.rows as any[]).map((r, i) => ({
        agency_id:    r.agency_id,
        agency_name:  r.agency_name as string,
        owner:        r.owner as string,
        total_score:  Number(r.total_score ?? 0),
        member_count: Number(r.member_count ?? 0),
        position:     i + 1,
      }));

      const payload = { period, hosts: enrichHosts, senders: enrichSenders, agencies: enrichAgencies };
      await setPartyLeaderboard(period, limit, JSON.stringify(payload));
      res.setHeader("X-Cache", "MISS");
      res.json(payload);
    } catch (err) {
      console.error("[party/leaderboard] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Lightweight coin total — all gift categories from party_income_log ───
  app.get("/api/party/rooms/:id/coin-total", async (req, res) => {
    const roomId = String(req.params.id);
    try {
      const rows = await db.execute(sql`
        SELECT
          COALESCE(SUM(coin_amount), 0)    AS total_coins,
          COALESCE(SUM(diamond_amount), 0) AS total_diamonds,
          sender_username,
          SUM(coin_amount) AS sender_coins
        FROM party_income_log
        WHERE room_id = ${roomId}
        GROUP BY sender_username
        ORDER BY sender_coins DESC
        LIMIT 20
      `);
      const spenders = (rows.rows as any[]).map(r => ({
        username:   r.sender_username as string,
        totalCoins: Number(r.sender_coins ?? 0),
      }));
      const totalCoins = spenders.reduce((s, r) => s + r.totalCoins, 0);
      res.json({ totalCoins, spenders });
    } catch (err) {
      console.error("[party/coin-total] error:", err);
      res.status(500).json({ totalCoins: 0, spenders: [] });
    }
  });

  // ── Per-room gift summary — used by "Siaran berakhir" screen ─────────────
  app.get("/api/party/rooms/:id/gift-summary", async (req, res) => {
    const roomId = String(req.params.id);
    try {
      const rows = await db.execute(sql`
        SELECT sender_username,
               SUM(coin_amount)    AS total_coins,
               SUM(diamond_amount) AS total_diamonds,
               SUM(gift_qty)       AS total_qty
        FROM party_income_log
        WHERE room_id = ${roomId}
        GROUP BY sender_username
        ORDER BY total_coins DESC
        LIMIT 20
      `);
      const spenders = (rows.rows as any[]).map(r => ({
        username:      r.sender_username as string,
        totalCoins:    Number(r.total_coins    ?? 0),
        totalDiamonds: Number(r.total_diamonds ?? 0),
        giftQty:       Number(r.total_qty      ?? 0),
      }));
      const totalDiamonds = spenders.reduce((s, r) => s + r.totalDiamonds, 0);
      const totalCoins    = spenders.reduce((s, r) => s + r.totalCoins, 0);

      const usernames = spenders.map(s => s.username);
      let avatarMap: Record<string, string | null> = {};
      if (usernames.length > 0) {
        const profiles = await db
          .select({ username: users.username, displayPicture: userProfiles.displayPicture })
          .from(users)
          .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
          .where(inArray(users.username, usernames));
        for (const p of profiles) {
          avatarMap[p.username] = p.displayPicture ?? null;
        }
      }

      res.json({
        spenders:     spenders.map(s => ({ ...s, avatarUrl: avatarMap[s.username] ?? null })),
        totalCoins,
        totalDiamonds,
        spenderCount: spenders.length,
      });
    } catch (err) {
      console.error("[party/gift-summary] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Lucky Bag: random coin distribution algorithm ────────────────────────
  function distributeCoins(total: number, count: number, minPerSlot = 1): number[] {
    if (count <= 1) return [total];
    const min = minPerSlot;
    let remaining = total - count * min;
    if (remaining < 0) remaining = 0;
    const extras: number[] = Array.from({ length: count }, () => 0);
    for (let i = 0; i < count - 1; i++) {
      const cut = Math.floor(Math.random() * (remaining + 1));
      extras[i] = cut;
      remaining -= cut;
    }
    extras[count - 1] = remaining;
    extras.sort(() => Math.random() - 0.5);
    return extras.map(e => e + min);
  }

  // ── POST /api/party/rooms/:id/lucky-bag/send ──────────────────────────────
  app.post("/api/party/rooms/:id/lucky-bag/send", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.id;
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

      const coinAmount = Number(req.body.coinAmount);
      const bagCount   = Number(req.body.bagCount);
      if (!coinAmount || coinAmount < 100)  return res.status(400).json({ error: "Minimum coin 100" });
      if (!bagCount   || bagCount < 1 || bagCount > 30) return res.status(400).json({ error: "Jumlah bag harus 1–30" });
      if (coinAmount < bagCount) return res.status(400).json({ error: "Coin kurang untuk dibagi" });

      // Cek apakah masih ada lucky bag aktif di room ini
      const activeBag = await db.execute(sql`
        SELECT id FROM party_lucky_bags
        WHERE room_id = ${roomId}
          AND is_active = true
          AND bags_remaining > 0
          AND expires_at > NOW()
        LIMIT 1
      `);
      if (activeBag.rows.length > 0) {
        return res.status(409).json({ error: "Masih ada Lucky Bag aktif di room ini. Tunggu habis dulu sebelum kirim yang baru." });
      }

      // Cek balance cukup
      const acct = await storage.getCreditAccount(user.username);
      if (acct.balance < coinAmount) return res.status(402).json({ error: "Saldo tidak cukup" });

      // Deduct coins dari sender
      await storage.adjustBalance(user.username, -coinAmount);
      await storage.createCreditTransaction({
        username:       user.username,
        type:           CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
        reference:      `luckybag_${roomId}_${Date.now()}`,
        description:    `Lucky Bag ${bagCount}x di room ${roomId}`,
        currency:       acct.currency,
        amount:         -coinAmount,
        fundedAmount:   0,
        tax:            0,
        runningBalance: acct.balance - coinAmount,
      });

      const bagRes = await db.execute(sql`
        INSERT INTO party_lucky_bags
          (room_id, sender_username, total_coins, bag_count, bags_remaining, expires_at)
        VALUES
          (${roomId}, ${user.username}, ${coinAmount}, ${bagCount}, ${bagCount},
           NOW() + INTERVAL '3 minutes')
        RETURNING id
      `);
      const bagId = Number((bagRes.rows[0] as any).id);

      // Pre-allocate slot amounts
      const amounts = distributeCoins(coinAmount, bagCount);
      for (let i = 0; i < amounts.length; i++) {
        await db.execute(sql`
          INSERT INTO party_lucky_bag_slots (bag_id, slot_index, coin_amount)
          VALUES (${bagId}, ${i + 1}, ${amounts[i]})
        `);
      }

      // Broadcast ke room
      const newBal = (await storage.getCreditAccount(user.username)).balance;
      const expiresAt = Date.now() + 3 * 60 * 1000;
      broadcastToRoom(roomId, {
        type:            "LUCKY_BAG_SENT" as any,
        roomId,
        bagId,
        senderUsername:  user.username,
        totalCoins:      coinAmount,
        bagCount,
        expiresAt,
      });

      // Auto-broadcast expiry after 3 minutes and deactivate bag
      setTimeout(async () => {
        try {
          await db.execute(sql`
            UPDATE party_lucky_bags SET is_active = false
            WHERE id = ${bagId} AND is_active = true
          `);
          broadcastToRoom(roomId, {
            type:   "LUCKY_BAG_EXPIRED" as any,
            roomId,
            bagId,
          });
        } catch {}
      }, 3 * 60 * 1000);

      return res.json({ ok: true, bagId, newBalance: newBal });
    } catch (err) {
      console.error("[party/lucky-bag/send] error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── GET /api/party/rooms/:id/lucky-bags ───────────────────────────────────
  app.get("/api/party/rooms/:id/lucky-bags", async (req: Request, res: Response) => {
    const roomId = req.params.id;
    try {
      const bags = await db.execute(sql`
        SELECT b.id, b.sender_username, b.total_coins, b.bag_count, b.bags_remaining,
               b.expires_at, b.created_at
        FROM party_lucky_bags b
        WHERE b.room_id = ${roomId}
          AND b.is_active = true
          AND b.bags_remaining > 0
        ORDER BY b.created_at DESC
        LIMIT 10
      `);
      return res.json({ bags: bags.rows });
    } catch (err) {
      console.error("[party/lucky-bags] GET error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/rooms/:id/lucky-bag/:bagId/claim ─────────────────────
  app.post("/api/party/rooms/:id/lucky-bag/:bagId/claim", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.id;
    const bagId  = Number(req.params.bagId);
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

      // Cek bag masih aktif
      const bagRes = await db.execute(sql`
        SELECT id, sender_username, bags_remaining, expires_at, is_active
        FROM party_lucky_bags
        WHERE id = ${bagId} AND room_id = ${roomId}
        LIMIT 1
      `);
      const bag = bagRes.rows[0] as any;
      if (!bag)                  return res.status(404).json({ error: "Lucky bag tidak ditemukan" });
      if (!bag.is_active)        return res.status(410).json({ error: "Lucky bag sudah tidak aktif" });
      if (Number(bag.bags_remaining) <= 0) return res.status(410).json({ error: "Lucky bag sudah habis" });
      if (bag.expires_at && new Date(bag.expires_at) < new Date()) {
        // Auto-deactivate expired bag
        await db.execute(sql`UPDATE party_lucky_bags SET is_active = false WHERE id = ${bagId}`).catch(() => {});
        return res.status(410).json({ error: "Lucky bag sudah expired" });
      }

      // Cek user belum pernah klaim bag ini
      const alreadyClaimed = await db.execute(sql`
        SELECT id FROM party_lucky_bag_slots
        WHERE bag_id = ${bagId} AND claimer_username = ${user.username}
        LIMIT 1
      `);
      if (alreadyClaimed.rows.length > 0) {
        return res.status(409).json({ error: "Kamu sudah klaim lucky bag ini" });
      }

      // Ambil slot acak yang belum diklaim — gunakan UPDATE ... RETURNING untuk atomik
      const slotRes = await db.execute(sql`
        UPDATE party_lucky_bag_slots
        SET claimer_username = ${user.username}, claimed_at = NOW()
        WHERE id = (
          SELECT id FROM party_lucky_bag_slots
          WHERE bag_id = ${bagId} AND claimer_username IS NULL
          ORDER BY RANDOM()
          LIMIT 1
        )
        RETURNING coin_amount, slot_index
      `);
      if (!slotRes.rows.length) {
        return res.status(410).json({ error: "Lucky bag sudah habis" });
      }
      const coinEarned = Number((slotRes.rows[0] as any).coin_amount);

      // Kurangi bags_remaining
      await db.execute(sql`
        UPDATE party_lucky_bags
        SET bags_remaining = bags_remaining - 1,
            is_active = CASE WHEN bags_remaining - 1 <= 0 THEN false ELSE is_active END
        WHERE id = ${bagId}
      `);

      // Tambah coin ke claimer
      const acct = await storage.getCreditAccount(user.username);
      await storage.adjustBalance(user.username, coinEarned);
      await storage.createCreditTransaction({
        username:       user.username,
        type:           CREDIT_TRANSACTION_TYPE.BONUS_CREDIT,
        reference:      `luckybag_claim_${bagId}`,
        description:    `Lucky Bag dari ${bag.sender_username}`,
        currency:       acct.currency,
        amount:         coinEarned,
        fundedAmount:   0,
        tax:            0,
        runningBalance: acct.balance + coinEarned,
      });

      // Broadcast claim event ke room
      broadcastToRoom(roomId, {
        type:           "LUCKY_BAG_CLAIMED" as any,
        roomId,
        bagId,
        claimerUsername: user.username,
        coinEarned,
        senderUsername:  bag.sender_username,
      });

      const newBal = (await storage.getCreditAccount(user.username)).balance;
      return res.json({ ok: true, coinEarned, newBalance: newBal });
    } catch (err) {
      console.error("[party/lucky-bag/claim] error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LUCKY BAG GLOBAL — broadcasts to ALL party rooms
  // ══════════════════════════════════════════════════════════════════════════

  let globalBagTableReady = false;
  async function ensureGlobalBagTable() {
    if (globalBagTableReady) return;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_bags_global (
        id               SERIAL PRIMARY KEY,
        sender_username  TEXT NOT NULL,
        sender_room_id   TEXT NOT NULL DEFAULT '',
        sender_room_name TEXT NOT NULL DEFAULT '',
        total_coins      BIGINT NOT NULL,
        bag_count        INT NOT NULL,
        bags_remaining   INT NOT NULL,
        claimable_at     TIMESTAMPTZ NOT NULL,
        expires_at       TIMESTAMPTZ NOT NULL,
        is_active        BOOLEAN NOT NULL DEFAULT true,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_bag_global_slots (
        id               SERIAL PRIMARY KEY,
        bag_id           INT NOT NULL,
        slot_index       INT NOT NULL,
        coin_amount      BIGINT NOT NULL,
        claimer_username TEXT,
        claimed_at       TIMESTAMPTZ
      )
    `);
    globalBagTableReady = true;
  }

  // ── POST /api/party/lucky-bag-global/send ────────────────────────────────
  app.post("/api/party/lucky-bag-global/send", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    try {
      await ensureGlobalBagTable();
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

      const coinAmount  = Number(req.body.coinAmount);
      const bagCount    = Number(req.body.bagCount);
      const senderRoomId   = String(req.body.roomId   ?? '');
      const senderRoomName = String(req.body.roomName ?? '');

      const GLOBAL_MIN_TOTAL   = 100000;
      const GLOBAL_MIN_PER_BAG = 2000;
      if (!coinAmount || coinAmount < GLOBAL_MIN_TOTAL) return res.status(400).json({ error: "Minimum coin untuk Lucky Bag Global adalah 100.000" });
      if (!bagCount || bagCount < 1 || bagCount > 30) return res.status(400).json({ error: "Jumlah bag harus 1–30" });
      if (coinAmount < bagCount * GLOBAL_MIN_PER_BAG) {
        return res.status(400).json({ error: `Total coin harus minimal ${(bagCount * GLOBAL_MIN_PER_BAG).toLocaleString('id-ID')} (${bagCount} bag × 2.000 min per bag)` });
      }

      const fee         = Math.ceil(coinAmount * 0.01);
      const totalDeduct = coinAmount + fee;
      const acct        = await storage.getCreditAccount(user.username);
      if (acct.balance < totalDeduct) return res.status(402).json({ error: "Saldo tidak cukup" });

      await storage.adjustBalance(user.username, -totalDeduct);
      await storage.createCreditTransaction({
        username:       user.username,
        type:           CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
        reference:      `luckybag_global_${Date.now()}`,
        description:    `Lucky Bag Global ${bagCount}x senilai ${coinAmount} coin`,
        currency:       acct.currency,
        amount:         -totalDeduct,
        fundedAmount:   0,
        tax:            fee,
        runningBalance: acct.balance - totalDeduct,
      });

      const bagRes = await db.execute(sql`
        INSERT INTO party_lucky_bags_global
          (sender_username, sender_room_id, sender_room_name, total_coins, bag_count, bags_remaining, claimable_at, expires_at)
        VALUES
          (${user.username}, ${senderRoomId}, ${senderRoomName}, ${coinAmount}, ${bagCount}, ${bagCount},
           NOW(), NOW() + INTERVAL '100 years')
        RETURNING id
      `);
      const bagId = Number((bagRes.rows[0] as any).id);

      const amounts = distributeCoins(coinAmount, bagCount, GLOBAL_MIN_PER_BAG);
      for (let i = 0; i < amounts.length; i++) {
        await db.execute(sql`
          INSERT INTO party_lucky_bag_global_slots (bag_id, slot_index, coin_amount)
          VALUES (${bagId}, ${i + 1}, ${amounts[i]})
        `);
      }

      const newBal = (await storage.getCreditAccount(user.username)).balance;

      broadcastToAllClients({
        type:           "LUCKY_BAG_GLOBAL_SENT" as any,
        bagId,
        senderUsername:  user.username,
        senderRoomId,
        senderRoomName,
        totalCoins:      coinAmount,
        bagCount,
      });

      return res.json({ ok: true, bagId, newBalance: newBal });
    } catch (err) {
      console.error("[party/lucky-bag-global/send] error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/party/lucky-bag-global/:bagId/claim ────────────────────────
  app.post("/api/party/lucky-bag-global/:bagId/claim", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const bagId = Number(req.params.bagId);
    try {
      await ensureGlobalBagTable();
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

      const bagRes = await db.execute(sql`
        SELECT id, sender_username, bags_remaining, claimable_at, expires_at, is_active
        FROM party_lucky_bags_global
        WHERE id = ${bagId}
        LIMIT 1
      `);
      const bag = bagRes.rows[0] as any;
      if (!bag)               return res.status(404).json({ error: "Lucky bag tidak ditemukan" });
      if (!bag.is_active)     return res.status(410).json({ error: "Lucky bag sudah tidak aktif" });
      if (Number(bag.bags_remaining) <= 0) return res.status(410).json({ error: "Lucky bag sudah habis" });

      const alreadyClaimed = await db.execute(sql`
        SELECT id FROM party_lucky_bag_global_slots
        WHERE bag_id = ${bagId} AND claimer_username = ${user.username}
        LIMIT 1
      `);
      if (alreadyClaimed.rows.length > 0) return res.status(409).json({ error: "Kamu sudah klaim lucky bag ini" });

      const slotRes = await db.execute(sql`
        UPDATE party_lucky_bag_global_slots
        SET claimer_username = ${user.username}, claimed_at = NOW()
        WHERE id = (
          SELECT id FROM party_lucky_bag_global_slots
          WHERE bag_id = ${bagId} AND claimer_username IS NULL
          ORDER BY RANDOM()
          LIMIT 1
        )
        RETURNING coin_amount
      `);
      if (!slotRes.rows.length) return res.status(410).json({ error: "Lucky bag sudah habis" });

      const coinEarned = Number((slotRes.rows[0] as any).coin_amount);

      const updRes = await db.execute(sql`
        UPDATE party_lucky_bags_global
        SET bags_remaining = bags_remaining - 1,
            is_active = CASE WHEN bags_remaining - 1 <= 0 THEN false ELSE is_active END
        WHERE id = ${bagId}
        RETURNING bags_remaining
      `);
      const bagsRemaining = Number((updRes.rows[0] as any)?.bags_remaining ?? 0);

      const acct = await storage.getCreditAccount(user.username);
      await storage.adjustBalance(user.username, coinEarned);
      await storage.createCreditTransaction({
        username:       user.username,
        type:           CREDIT_TRANSACTION_TYPE.BONUS_CREDIT,
        reference:      `luckybag_global_claim_${bagId}`,
        description:    `Lucky Bag Global dari ${bag.sender_username}`,
        currency:       acct.currency,
        amount:         coinEarned,
        fundedAmount:   0,
        tax:            0,
        runningBalance: acct.balance + coinEarned,
      });

      broadcastToAllClients({
        type:           "LUCKY_BAG_GLOBAL_CLAIMED" as any,
        bagId,
        claimerUsername: user.username,
        coinEarned,
        bagsRemaining,
      });

      const newBal = (await storage.getCreditAccount(user.username)).balance;
      return res.json({ ok: true, coinEarned, newBalance: newBal });
    } catch (err) {
      console.error("[party/lucky-bag-global/claim] error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Periodic cleanup: kosongkan seat ghost (duduk > 12 jam tanpa update) ───
  // Terjadi saat user close app tanpa tekan Leave dan tidak logout.
  setInterval(async () => {
    try {
      const result = await db.execute(sql`
        UPDATE party_seats
        SET user_id = NULL, username = NULL, display_name = NULL,
            avatar_url = NULL, avatar_frame_url = NULL, is_muted = false,
            livekit_identity = NULL, joined_at = NULL, updated_at = NOW()
        WHERE user_id IS NOT NULL
          AND joined_at < NOW() - INTERVAL '12 hours'
      `);
      const count = (result as any).rowCount ?? 0;
      if (count > 0) {
        console.log(`[party/cleanup] Cleared ${count} stale ghost seat(s) (>12h)`);
      }
    } catch { /* silent — non-critical */ }
  }, 30 * 60 * 1000); // every 30 minutes

  // ── Periodic cleanup: mark very old inactive party rooms ──────────────────
  // Rooms only become inactive when explicitly deleted by the owner.
  // We only purge rooms that are already inactive AND very old (7+ days) to keep DB clean.
  setInterval(async () => {
    try {
      await db.execute(sql`
        UPDATE party_rooms
        SET is_active = false, updated_at = NOW()
        WHERE is_active = true
          AND updated_at < NOW() - INTERVAL '7 days'
      `);
    } catch { /* silent — non-critical */ }
  }, 6 * 60 * 60 * 1000); // every 6 hours
}

// ── Public: GET /api/party/stickers ──────────────────────────────────────────
// Dipakai oleh mobile app untuk load sticker list dari DB (bukan hardcode)
export function registerPartyStickerRoutes(app: Express) {
  app.get("/api/party/stickers", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, name, lottie_url, sort_order
        FROM party_stickers
        WHERE is_active = true
        ORDER BY sort_order ASC, id ASC
      `);
      res.json({ stickers: result.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

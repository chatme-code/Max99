import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";

/**
 * Voice Room — Seat management untuk classic chatroom.
 *
 * Audio (Agora) sudah dihapus. Modul ini hanya mengelola:
 *   - Status kursi (siapa duduk di mana, is_muted)
 *   - Toggle voice room on/off per chatroom
 *   - Request/approve/reject naik kursi
 *
 * Untuk Live Party audio (LiveKit), lihat modules/liveParty/routes.ts
 *
 * Tabel: voice_seats, chatroom_voice_state, voice_seat_requests
 */

async function isVoiceEnabled(roomId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT enabled FROM chatroom_voice_state WHERE chatroom_id = ${roomId} LIMIT 1
  `);
  const row = result.rows[0] as { enabled?: boolean } | undefined;
  return row?.enabled === true;
}

function channelNameFor(roomId: string): string {
  return `max99-voice-${roomId}`;
}

async function getChannelName(roomId: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT channel FROM chatroom_voice_state WHERE chatroom_id = ${roomId} LIMIT 1
  `);
  const row = result.rows[0] as { channel?: string } | undefined;
  return (row?.channel as string) || channelNameFor(roomId);
}

async function fetchRoomCreator(roomId: string): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT created_by FROM chatrooms WHERE id = ${roomId} LIMIT 1
  `);
  const row = result.rows[0] as { created_by?: string } | undefined;
  return (row?.created_by as string) || null;
}

async function requireRoomAdmin(
  req: Request,
  res: Response,
  roomId: string,
): Promise<boolean> {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not logged in" });
    return false;
  }
  const [globalAdmin, creator] = await Promise.all([
    storage.isGlobalAdmin(req.session.userId),
    fetchRoomCreator(roomId),
  ]);
  if (!globalAdmin && creator !== req.session.userId) {
    res.status(403).json({ error: "Only room owner or global admin can do this" });
    return false;
  }
  return true;
}

async function fetchPendingRequests(roomId: string) {
  const result = await db.execute(sql`
    SELECT id, seat_index, user_id, username, display_name, avatar_url, requested_at
    FROM voice_seat_requests
    WHERE chatroom_id = ${roomId} AND status = 'pending'
    ORDER BY requested_at ASC
  `);
  return result.rows.map((r: any) => ({
    id:           Number(r.id),
    seat_index:   Number(r.seat_index),
    user_id:      r.user_id,
    username:     r.username,
    display_name: r.display_name,
    avatar_url:   r.avatar_url,
    requested_at: r.requested_at,
  }));
}

async function getRoomNumSeats(roomId: string): Promise<number> {
  try {
    const result = await db.execute(sql`
      SELECT category_id FROM chatrooms WHERE id = ${roomId} LIMIT 1
    `);
    const row = result.rows[0] as { category_id?: number } | undefined;
    return 2;
  } catch {
    return 2;
  }
}

async function fetchSeats(roomId: string) {
  const [result, numSeats] = await Promise.all([
    db.execute(sql`
      SELECT seat_index, user_id, username, display_name, avatar_url,
             avatar_frame_url, is_muted, joined_at
      FROM voice_seats
      WHERE chatroom_id = ${roomId}
      ORDER BY seat_index ASC
    `),
    getRoomNumSeats(roomId),
  ]);
  const bySeat = new Map<number, any>();
  for (const r of result.rows as any[]) {
    bySeat.set(Number(r.seat_index), r);
  }
  return Array.from({ length: numSeats }, (_, i) => bySeat.get(i + 1) || {
    seat_index:       i + 1,
    user_id:          null,
    username:         null,
    display_name:     null,
    avatar_url:       null,
    avatar_frame_url: null,
    is_muted:         false,
    joined_at:        null,
  });
}

async function ensureSeatRows(roomId: string): Promise<void> {
  const numSeats = await getRoomNumSeats(roomId);
  for (let i = 1; i <= numSeats; i++) {
    await db.execute(sql`
      INSERT INTO voice_seats (chatroom_id, seat_index)
      VALUES (${roomId}, ${i})
      ON CONFLICT (chatroom_id, seat_index) DO NOTHING
    `);
  }
}

function parseSeat(req: Request, res: Response): number | null {
  const seatIndex = parseInt(String(req.params.n), 10);
  if (isNaN(seatIndex) || seatIndex < 1 || seatIndex > 8) {
    res.status(400).json({ error: "Invalid seat index (must be 1–8)" });
    return null;
  }
  return seatIndex;
}

const emptySeat = (i: number) => ({
  seat_index:   i,
  user_id:      null,
  username:     null,
  display_name: null,
  avatar_url:   null,
  is_muted:     false,
  joined_at:    null,
});

export function registerVoiceRoomRoutes(app: Express) {
  const emptyVoiceState = (roomId: string | null = null, numSeats = 2) => ({
    enabled:         false,
    channel:         roomId ? channelNameFor(roomId) : "",
    seats:           Array.from({ length: numSeats }, (_, i) => emptySeat(i + 1)),
    pendingRequests: [],
    roomId,
  });

  // ── GET /api/voiceroom/state ──────────────────────────────────────────────
  // Defensive fallback: nginx/proxy yang collapse empty roomId ke single slash.
  app.get("/api/voiceroom/state", (_req, res) => {
    res.json(emptyVoiceState(null));
  });

  // ── GET /api/voiceroom/:roomId/state ──────────────────────────────────────
  app.get("/api/voiceroom/:roomId/state", async (req, res) => {
    try {
      const roomId = (req.params.roomId || "").trim();
      if (!roomId) return res.json(emptyVoiceState(null));

      const [enabled, seats, channel, pendingRequests] = await Promise.all([
        isVoiceEnabled(roomId),
        fetchSeats(roomId),
        getChannelName(roomId),
        fetchPendingRequests(roomId).catch(() => []),
      ]);
      res.json({ enabled, channel, seats, pendingRequests, roomId });
    } catch (err) {
      console.error("[voiceroom/state] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/seat/:n/request ───────────────────────────
  app.post("/api/voiceroom/:roomId/seat/:n/request", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.roomId;
    const seatIndex = parseSeat(req, res); if (seatIndex == null) return;

    try {
      if (!(await isVoiceEnabled(roomId))) {
        return res.status(409).json({ error: "Voice room is disabled" });
      }
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const seated = await db.execute(sql`
        SELECT seat_index FROM voice_seats
        WHERE chatroom_id = ${roomId} AND user_id = ${user.id}
        LIMIT 1
      `);
      if (seated.rows[0]) {
        return res.status(409).json({ error: "You are already on a seat" });
      }

      const target = await db.execute(sql`
        SELECT user_id FROM voice_seats
        WHERE chatroom_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      if ((target.rows[0] as any)?.user_id) {
        return res.status(409).json({ error: "Seat is already taken" });
      }

      await db.execute(sql`
        INSERT INTO voice_seat_requests
          (chatroom_id, seat_index, user_id, username, display_name, avatar_url)
        VALUES (
          ${roomId}, ${seatIndex}, ${user.id}, ${user.username},
          ${(user as any).displayName || user.username},
          ${(user as any).avatarUrl || null}
        )
        ON CONFLICT (chatroom_id, user_id) WHERE status = 'pending'
        DO UPDATE SET seat_index = EXCLUDED.seat_index, requested_at = NOW()
      `);

      res.json({ ok: true, seatIndex, status: "pending" });
    } catch (err) {
      console.error("[voiceroom/seat/request] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/request/:reqId/approve ────────────────────
  app.post("/api/voiceroom/:roomId/request/:reqId/approve", async (req, res) => {
    const roomId = req.params.roomId;
    if (!(await requireRoomAdmin(req, res, roomId))) return;
    const reqId = parseInt(String(req.params.reqId), 10);
    if (!reqId) return res.status(400).json({ error: "Invalid request id" });

    try {
      const r = await db.execute(sql`
        SELECT user_id, username, display_name, avatar_url, seat_index, status
        FROM voice_seat_requests
        WHERE id = ${reqId} AND chatroom_id = ${roomId}
        LIMIT 1
      `);
      const reqRow = r.rows[0] as any;
      if (!reqRow) return res.status(404).json({ error: "Request not found" });
      if (reqRow.status !== "pending") {
        return res.status(409).json({ error: `Request already ${reqRow.status}` });
      }

      const seatsRes = await db.execute(sql`
        SELECT seat_index, user_id FROM voice_seats
        WHERE chatroom_id = ${roomId}
        ORDER BY seat_index
      `);
      const empty = (seatsRes.rows as any[]).filter(s => !s.user_id);
      if (empty.length === 0) {
        return res.status(409).json({ error: "Tidak ada kursi kosong" });
      }
      const targetSeat = empty.find(s => Number(s.seat_index) === reqRow.seat_index) || empty[0];

      await ensureSeatRows(roomId);

      // user_badges mungkin belum ada di semua environment — graceful fallback
      let avatarFrameUrl: string | null = null;
      try {
        const frameRow = await db.execute(sql`
          SELECT b.avatar_frame_url
          FROM user_badges ub
          JOIN badges b ON b.id = ub.badge_id
          WHERE ub.user_id = ${reqRow.user_id} AND b.avatar_frame_url IS NOT NULL
          ORDER BY ub.awarded_at DESC
          LIMIT 1
        `);
        avatarFrameUrl = (frameRow.rows[0] as any)?.avatar_frame_url ?? null;
      } catch {
        // tabel user_badges belum ada — tidak masalah, lanjutkan tanpa frame
      }

      await db.execute(sql`
        UPDATE voice_seats
        SET user_id      = ${reqRow.user_id},
            username     = ${reqRow.username},
            display_name = ${reqRow.display_name},
            avatar_url   = ${reqRow.avatar_url},
            avatar_frame_url = ${avatarFrameUrl},
            is_muted     = false,
            agora_uid    = NULL,
            joined_at    = NOW(),
            updated_at   = NOW()
        WHERE chatroom_id = ${roomId} AND seat_index = ${targetSeat.seat_index}
      `);

      await db.execute(sql`
        UPDATE voice_seat_requests
        SET status = 'approved', resolved_at = NOW(), resolved_by = ${req.session!.userId}
        WHERE id = ${reqId}
      `);

      res.json({ ok: true, seatIndex: targetSeat.seat_index });
    } catch (err) {
      console.error("[voiceroom/request/approve] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/request/:reqId/reject ─────────────────────
  app.post("/api/voiceroom/:roomId/request/:reqId/reject", async (req, res) => {
    const roomId = req.params.roomId;
    if (!(await requireRoomAdmin(req, res, roomId))) return;
    const reqId = parseInt(String(req.params.reqId), 10);
    if (!reqId) return res.status(400).json({ error: "Invalid request id" });

    try {
      const result = await db.execute(sql`
        UPDATE voice_seat_requests
        SET status = 'rejected', resolved_at = NOW(), resolved_by = ${req.session!.userId}
        WHERE id = ${reqId} AND chatroom_id = ${roomId} AND status = 'pending'
      `);
      res.json({ ok: true, affected: (result as any).rowCount ?? 0 });
    } catch (err) {
      console.error("[voiceroom/request/reject] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/request/cancel ────────────────────────────
  app.post("/api/voiceroom/:roomId/request/cancel", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId = req.params.roomId;
    try {
      await db.execute(sql`
        UPDATE voice_seat_requests
        SET status = 'cancelled', resolved_at = NOW()
        WHERE chatroom_id = ${roomId} AND user_id = ${req.session.userId} AND status = 'pending'
      `);
      res.json({ ok: true });
    } catch (err) {
      console.error("[voiceroom/request/cancel] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/toggle ────────────────────────────────────
  app.post("/api/voiceroom/:roomId/toggle", async (req, res) => {
    const roomId = req.params.roomId;
    if (!(await requireRoomAdmin(req, res, roomId))) return;

    const enabled = !!req.body?.enabled;
    try {
      await db.execute(sql`
        INSERT INTO chatroom_voice_state (chatroom_id, enabled, channel, updated_at)
        VALUES (${roomId}, ${enabled}, ${channelNameFor(roomId)}, NOW())
        ON CONFLICT (chatroom_id) DO UPDATE
          SET enabled    = EXCLUDED.enabled,
              channel    = COALESCE(chatroom_voice_state.channel, EXCLUDED.channel),
              updated_at = NOW()
      `);

      if (enabled) {
        await ensureSeatRows(roomId);
      } else {
        await db.execute(sql`
          UPDATE voice_seats
          SET user_id = NULL, username = NULL, display_name = NULL,
              avatar_url = NULL, avatar_frame_url = NULL,
              is_muted = false, agora_uid = NULL,
              joined_at = NULL, updated_at = NOW()
          WHERE chatroom_id = ${roomId}
        `);
      }

      res.json({ ok: true, roomId, enabled });
    } catch (err) {
      console.error("[voiceroom/toggle] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/seat/:n/assign ────────────────────────────
  app.post("/api/voiceroom/:roomId/seat/:n/assign", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId   = req.params.roomId;
    const seatIndex = parseSeat(req, res); if (seatIndex == null) return;

    const username = String(req.body?.username || "").trim();
    if (!username) return res.status(400).json({ error: "username required" });

    try {
      if (!(await isVoiceEnabled(roomId))) {
        return res.status(409).json({ error: "Voice room is disabled" });
      }

      const user = await storage.getUserByUsername(username);
      if (!user) return res.status(404).json({ error: "User not found" });

      const isSelf = user.id === req.session.userId;
      if (!isSelf) {
        const [globalAdmin, creator] = await Promise.all([
          storage.isGlobalAdmin(req.session.userId),
          fetchRoomCreator(roomId),
        ]);
        if (!globalAdmin && creator !== req.session.userId) {
          return res.status(403).json({ error: "Only room owner or global admin can assign others" });
        }
      }

      const seatOccupied = await db.execute(sql`
        SELECT user_id FROM voice_seats
        WHERE chatroom_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      if ((seatOccupied.rows[0] as any)?.user_id) {
        return res.status(409).json({ error: "Seat is already taken" });
      }

      const existing = await db.execute(sql`
        SELECT seat_index FROM voice_seats
        WHERE chatroom_id = ${roomId} AND user_id = ${user.id}
        LIMIT 1
      `);
      if (existing.rows[0]) {
        return res.status(409).json({
          error: `User already at seat ${(existing.rows[0] as any).seat_index}`,
        });
      }

      await ensureSeatRows(roomId);

      // user_badges mungkin belum ada di semua environment — graceful fallback
      let avatarFrameUrl: string | null = null;
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

      await db.execute(sql`
        UPDATE voice_seats
        SET user_id      = ${user.id},
            username     = ${user.username},
            display_name = ${(user as any).displayName || user.username},
            avatar_url   = ${(user as any).avatarUrl || null},
            avatar_frame_url = ${avatarFrameUrl},
            is_muted     = false,
            agora_uid    = NULL,
            joined_at    = NOW(),
            updated_at   = NOW()
        WHERE chatroom_id = ${roomId} AND seat_index = ${seatIndex}
      `);

      res.json({ ok: true, roomId, seatIndex, username: user.username });
    } catch (err) {
      console.error("[voiceroom/seat/assign] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/seat/:n/release ───────────────────────────
  app.post("/api/voiceroom/:roomId/seat/:n/release", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId   = req.params.roomId;
    const seatIndex = parseSeat(req, res); if (seatIndex == null) return;

    try {
      const seatRes = await db.execute(sql`
        SELECT user_id FROM voice_seats
        WHERE chatroom_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      const seat = seatRes.rows[0] as { user_id?: string } | undefined;
      if (!seat?.user_id) {
        return res.status(404).json({ error: "Seat is already empty" });
      }

      const isSelf = seat.user_id === req.session.userId;
      let allowed  = isSelf;
      if (!allowed) {
        const [globalAdmin, creator] = await Promise.all([
          storage.isGlobalAdmin(req.session.userId),
          fetchRoomCreator(roomId),
        ]);
        allowed = globalAdmin || creator === req.session.userId;
      }
      if (!allowed) {
        return res.status(403).json({ error: "Not allowed to release this seat" });
      }

      await db.execute(sql`
        UPDATE voice_seats
        SET user_id = NULL, username = NULL, display_name = NULL,
            avatar_url = NULL, is_muted = false, agora_uid = NULL,
            joined_at = NULL, updated_at = NOW()
        WHERE chatroom_id = ${roomId} AND seat_index = ${seatIndex}
      `);

      res.json({ ok: true, roomId, seatIndex });
    } catch (err) {
      console.error("[voiceroom/seat/release] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── POST /api/voiceroom/:roomId/seat/:n/mute ──────────────────────────────
  app.post("/api/voiceroom/:roomId/seat/:n/mute", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const roomId   = req.params.roomId;
    const seatIndex = parseSeat(req, res); if (seatIndex == null) return;
    const muted = !!req.body?.muted;

    try {
      const seatRes = await db.execute(sql`
        SELECT user_id FROM voice_seats
        WHERE chatroom_id = ${roomId} AND seat_index = ${seatIndex}
        LIMIT 1
      `);
      const seat = seatRes.rows[0] as { user_id?: string } | undefined;
      if (!seat?.user_id) {
        return res.status(404).json({ error: "Seat is empty" });
      }

      const isSelf = seat.user_id === req.session.userId;
      let allowed  = isSelf;
      if (!allowed) {
        const [globalAdmin, creator] = await Promise.all([
          storage.isGlobalAdmin(req.session.userId),
          fetchRoomCreator(roomId),
        ]);
        allowed = globalAdmin || creator === req.session.userId;
      }
      if (!allowed) {
        return res.status(403).json({ error: "Not allowed to mute this seat" });
      }

      await db.execute(sql`
        UPDATE voice_seats
        SET is_muted = ${muted}, updated_at = NOW()
        WHERE chatroom_id = ${roomId} AND seat_index = ${seatIndex}
      `);

      res.json({ ok: true, roomId, seatIndex, muted });
    } catch (err) {
      console.error("[voiceroom/seat/mute] error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });
}

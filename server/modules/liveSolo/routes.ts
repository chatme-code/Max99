import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { AccessToken } from "livekit-server-sdk";
import multer from "multer";
import path from "path";
import fs from "fs";

// ── Thumbnail upload storage ─────────────────────────────────────────────────
const THUMB_DIR = path.join(process.cwd(), "uploads", "live-thumbnails");
function ensureThumbDir() {
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
}
const thumbStorage = multer.diskStorage({
  destination: (_req, _file, cb) => { ensureThumbDir(); cb(null, THUMB_DIR); },
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname) || ".jpg";
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const thumbUpload = multer({
  storage: thumbStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    cb(new Error("Hanya file gambar yang diizinkan"));
  },
});

/**
 * Live Solo — API streaming video solo untuk host perempuan agency.
 *
 * Tabel: live_streams, stream_gifts, stream_viewers (dibuat di index.ts)
 * Prefix: /api/live
 *
 * Endpoints:
 *   POST /api/live/start                — host mulai live
 *   GET  /api/live/streams              — list semua stream aktif
 *   GET  /api/live/streams/:id          — detail satu stream
 *   POST /api/live/streams/:id/token    — LiveKit token (host/viewer)
 *   POST /api/live/streams/:id/end      — host akhiri live
 *   POST /api/live/streams/:id/gift     — viewer kirim gift ke host
 *   POST /api/live/streams/:id/join     — viewer join (tracking)
 *   POST /api/live/streams/:id/leave    — viewer leave (tracking)
 */

// ─── LiveKit — same dual-provider logic as liveParty ─────────────────────────
const LIVEKIT_CLOUD_URL        = process.env.LIVEKIT_CLOUD_URL        || "";
const LIVEKIT_CLOUD_API_KEY    = process.env.LIVEKIT_CLOUD_API_KEY    || "";
const LIVEKIT_CLOUD_API_SECRET = process.env.LIVEKIT_CLOUD_API_SECRET || "";
const LIVEKIT_SELF_URL         = process.env.LIVEKIT_URL              || "";
const LIVEKIT_SELF_API_KEY     = process.env.LIVEKIT_API_KEY          || "";
const LIVEKIT_SELF_API_SECRET  = process.env.LIVEKIT_API_SECRET       || "";

function getActiveLiveKit(): { url: string; apiKey: string; apiSecret: string; provider: "cloud" | "selfhosted" } {
  const mode       = (process.env.LIVEKIT_MODE || "auto").toLowerCase();
  const cloudReady = !!(LIVEKIT_CLOUD_URL && LIVEKIT_CLOUD_API_KEY && LIVEKIT_CLOUD_API_SECRET);
  const selfReady  = !!(LIVEKIT_SELF_URL  && LIVEKIT_SELF_API_KEY  && LIVEKIT_SELF_API_SECRET);

  if (mode === "cloud")      return { url: LIVEKIT_CLOUD_URL, apiKey: LIVEKIT_CLOUD_API_KEY, apiSecret: LIVEKIT_CLOUD_API_SECRET, provider: "cloud" };
  if (mode === "selfhosted") return { url: LIVEKIT_SELF_URL,  apiKey: LIVEKIT_SELF_API_KEY,  apiSecret: LIVEKIT_SELF_API_SECRET,  provider: "selfhosted" };
  if (cloudReady) return { url: LIVEKIT_CLOUD_URL, apiKey: LIVEKIT_CLOUD_API_KEY, apiSecret: LIVEKIT_CLOUD_API_SECRET, provider: "cloud" };
  return { url: LIVEKIT_SELF_URL, apiKey: LIVEKIT_SELF_API_KEY, apiSecret: LIVEKIT_SELF_API_SECRET, provider: "selfhosted" };
}

function soloRoomName(streamId: string): string {
  return `livesolo-${streamId}`;
}

async function generateToken(
  streamId: string,
  identity: string,
  canPublish: boolean,
): Promise<{ token: string; url: string; provider: "cloud" | "selfhosted" }> {
  const lk = getActiveLiveKit();
  const at = new AccessToken(lk.apiKey, lk.apiSecret, { identity, ttl: 7200 });
  at.addGrant({
    roomJoin:     true,
    room:         soloRoomName(streamId),
    canPublish,
    canSubscribe: true,
  });
  const token = await at.toJwt();
  return { token, url: lk.url, provider: lk.provider };
}

// ─── Gate Keeper: validasi host female + agency aktif ────────────────────────
async function validateHostEligibility(userId: string): Promise<
  | { ok: true; username: string; displayName: string | null; avatarUrl: string | null }
  | { ok: false; status: number; message: string }
> {
  // 1. Ambil data user + profil
  const userRes = await db.execute(sql`
    SELECT u.username, u.display_name, up.display_picture
    FROM users u
    LEFT JOIN user_profiles up ON up.user_id = u.id
    WHERE u.id = ${userId}
    LIMIT 1
  `);
  const user = userRes.rows[0] as any;
  if (!user) return { ok: false, status: 404, message: "User tidak ditemukan" };

  // 2a. Cek apakah user adalah owner agency yang approved
  const ownerRes = await db.execute(sql`
    SELECT id FROM agencies
    WHERE LOWER(registered_by) = LOWER(${user.username})
      AND status = 'approved'
    LIMIT 1
  `);
  const isAgencyOwner = ownerRes.rows.length > 0;

  if (!isAgencyOwner) {
    // 2b. Cek agency_hosts aktif (host biasa)
    const hostRes = await db.execute(sql`
      SELECT ah.agency_id
      FROM agency_hosts ah
      WHERE ah.username = ${user.username}
        AND ah.status = 'active'
      LIMIT 1
    `);
    if (hostRes.rows.length === 0) {
      return { ok: false, status: 403, message: "Kamu harus terdaftar sebagai host aktif di sebuah agency" };
    }

    // 2c. Cek agency approved
    const agencyId = (hostRes.rows[0] as any).agency_id;
    const agencyRes = await db.execute(sql`
      SELECT id FROM agencies WHERE id = ${agencyId} AND status = 'approved' LIMIT 1
    `);
    if (agencyRes.rows.length === 0) {
      return { ok: false, status: 403, message: "Agency kamu belum disetujui oleh admin" };
    }
  }

  return {
    ok:          true,
    username:    user.username,
    displayName: user.display_name ?? null,
    avatarUrl:   user.display_picture ?? null,
  };
}

// ─── Register Routes ─────────────────────────────────────────────────────────
export function registerLiveSoloRoutes(app: Express) {

  // ── POST /api/live/thumbnail ─────────────────────────────────────────────
  // Upload gambar thumbnail untuk live stream. Returns { url }.
  app.post(
    "/api/live/thumbnail",
    thumbUpload.single("thumbnail"),
    (req: Request, res: Response) => {
      if (!req.session?.userId) return res.status(401).json({ message: "Login dulu" });
      if (!req.file) return res.status(400).json({ message: "Tidak ada file yang diunggah" });
      const url = `/uploads/live-thumbnails/${req.file.filename}`;
      res.json({ ok: true, url });
    }
  );

  // ── POST /api/live/start ─────────────────────────────────────────────────
  // Host mulai live. Validasi female + agency aktif.
  app.post("/api/live/start", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Kamu harus login terlebih dahulu" });

    try {
      const eligibility = await validateHostEligibility(req.session.userId);
      if (!eligibility.ok) {
        return res.status(eligibility.status).json({ message: eligibility.message });
      }
      const { username, displayName, avatarUrl } = eligibility;

      // Cek apakah host sudah punya stream aktif
      const existing = await db.execute(sql`
        SELECT id FROM live_streams
        WHERE host_user_id = ${req.session.userId} AND status = 'live'
        LIMIT 1
      `);
      if (existing.rows.length > 0) {
        const existingId = (existing.rows[0] as any).id;
        return res.json({ ok: true, streamId: existingId, resumed: true });
      }

      const title       = (req.body?.title       as string) || `${displayName ?? username}'s Live`;
      const category    = (req.body?.category     as string) || "general";
      const thumbnailUrl = (req.body?.thumbnailUrl as string) || avatarUrl || null;

      const insertRes = await db.execute(sql`
        INSERT INTO live_streams (
          host_user_id, host_username, host_display_name, host_avatar_url,
          title, category, thumbnail_url, status
        ) VALUES (
          ${req.session.userId}, ${username}, ${displayName}, ${avatarUrl},
          ${title}, ${category}, ${thumbnailUrl}, 'live'
        )
        RETURNING id
      `);
      const streamId = (insertRes.rows[0] as any).id as string;

      console.log(`[liveSolo] Stream started: ${streamId} by @${username}`);
      res.json({ ok: true, streamId, resumed: false });
    } catch (err) {
      console.error("[liveSolo/start] error:", err);
      res.status(500).json({ message: "Gagal memulai live" });
    }
  });

  // ── GET /api/live/streams ────────────────────────────────────────────────
  // List semua stream aktif (status = 'live'), diurutkan by viewer count.
  app.get("/api/live/streams", async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT
          ls.id,
          ls.host_username,
          ls.host_display_name,
          ls.host_avatar_url,
          ls.title,
          ls.category,
          ls.thumbnail_url,
          ls.viewer_count,
          ls.total_gifts,
          ls.started_at,
          COALESCE(
            (SELECT COUNT(*) FROM stream_viewers sv WHERE sv.stream_id = ls.id AND sv.left_at IS NULL),
            0
          ) AS live_viewer_count
        FROM live_streams ls
        WHERE ls.status = 'live'
        ORDER BY ls.viewer_count DESC, ls.started_at DESC
        LIMIT 100
      `);

      const streams = (result.rows as any[]).map(r => ({
        id:              r.id,
        hostUsername:    r.host_username,
        hostDisplayName: r.host_display_name ?? null,
        hostAvatar:      r.host_avatar_url ?? null,
        title:           r.title,
        category:        r.category ?? "general",
        thumbnailUrl:    r.thumbnail_url ?? null,
        viewerCount:     Number(r.live_viewer_count ?? r.viewer_count ?? 0),
        totalGifts:      Number(r.total_gifts ?? 0),
        startedAt:       r.started_at,
      }));

      res.json({ streams });
    } catch (err) {
      console.error("[liveSolo/streams] error:", err);
      res.status(500).json({ message: "Gagal mengambil daftar stream" });
    }
  });

  // ── GET /api/live/streams/:id ────────────────────────────────────────────
  // Detail satu stream.
  app.get("/api/live/streams/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await db.execute(sql`
        SELECT
          ls.*,
          COALESCE(
            (SELECT COUNT(*) FROM stream_viewers sv WHERE sv.stream_id = ls.id AND sv.left_at IS NULL),
            0
          ) AS live_viewer_count
        FROM live_streams ls
        WHERE ls.id = ${id}
        LIMIT 1
      `);
      if (result.rows.length === 0) return res.status(404).json({ message: "Stream tidak ditemukan" });
      const r = result.rows[0] as any;
      res.json({
        id:              r.id,
        hostUserId:      r.host_user_id,
        hostUsername:    r.host_username,
        hostDisplayName: r.host_display_name ?? null,
        hostAvatar:      r.host_avatar_url ?? null,
        title:           r.title,
        category:        r.category ?? "general",
        thumbnailUrl:    r.thumbnail_url ?? null,
        status:          r.status,
        viewerCount:     Number(r.live_viewer_count ?? 0),
        totalGifts:      Number(r.total_gifts ?? 0),
        startedAt:       r.started_at,
        endedAt:         r.ended_at ?? null,
      });
    } catch (err) {
      console.error("[liveSolo/stream-detail] error:", err);
      res.status(500).json({ message: "Gagal mengambil detail stream" });
    }
  });

  // ── POST /api/live/streams/:id/token ────────────────────────────────────
  // Host → publisher video+audio. Viewer → subscriber only.
  app.post("/api/live/streams/:id/token", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Kamu harus login terlebih dahulu" });
    const id = String(req.params.id);

    try {
      // Cek stream ada dan aktif
      const streamRes = await db.execute(sql`
        SELECT host_user_id, host_username, status FROM live_streams WHERE id = ${id} LIMIT 1
      `);
      if (streamRes.rows.length === 0) return res.status(404).json({ message: "Stream tidak ditemukan" });
      const stream = streamRes.rows[0] as any;
      if (stream.status !== "live") return res.status(400).json({ message: "Stream sudah berakhir" });

      // Ambil username user ini
      const userId = String(req.session.userId);
      const userRes = await db.execute(sql`SELECT username FROM users WHERE id = ${userId} LIMIT 1`);
      const username = (userRes.rows[0] as any)?.username ?? userId;

      const isHost = stream.host_user_id === req.session.userId;
      const { token, url, provider } = await generateToken(id, String(username), isHost);

      res.json({ token, url, provider, role: isHost ? "host" : "viewer" });
    } catch (err) {
      console.error("[liveSolo/token] error:", err);
      res.status(500).json({ message: "Gagal membuat token" });
    }
  });

  // ── POST /api/live/streams/:id/end ───────────────────────────────────────
  // Host akhiri live. Hanya host yang bisa.
  app.post("/api/live/streams/:id/end", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Kamu harus login terlebih dahulu" });
    const { id } = req.params;

    try {
      const streamRes = await db.execute(sql`
        SELECT host_user_id, status FROM live_streams WHERE id = ${id} LIMIT 1
      `);
      if (streamRes.rows.length === 0) return res.status(404).json({ message: "Stream tidak ditemukan" });
      const stream = streamRes.rows[0] as any;

      if (stream.host_user_id !== req.session.userId) {
        return res.status(403).json({ message: "Hanya host yang bisa mengakhiri stream ini" });
      }
      if (stream.status === "ended") {
        return res.json({ ok: true, alreadyEnded: true });
      }

      // Tutup semua viewer aktif
      await db.execute(sql`
        UPDATE stream_viewers
        SET left_at = NOW()
        WHERE stream_id = ${id} AND left_at IS NULL
      `);

      // Hitung ringkasan
      const summary = await db.execute(sql`
        SELECT
          COALESCE(SUM(sg.amount_coins), 0) AS total_gifts,
          COUNT(DISTINCT sv.user_id) AS total_viewers
        FROM live_streams ls
        LEFT JOIN stream_gifts   sg ON sg.stream_id = ls.id
        LEFT JOIN stream_viewers sv ON sv.stream_id = ls.id
        WHERE ls.id = ${id}
      `);
      const s = summary.rows[0] as any;

      await db.execute(sql`
        UPDATE live_streams
        SET status = 'ended',
            ended_at = NOW(),
            total_gifts = ${Number(s.total_gifts ?? 0)},
            viewer_count = ${Number(s.total_viewers ?? 0)}
        WHERE id = ${id}
      `);

      console.log(`[liveSolo] Stream ended: ${id}`);
      res.json({ ok: true, totalGifts: Number(s.total_gifts ?? 0), totalViewers: Number(s.total_viewers ?? 0) });
    } catch (err) {
      console.error("[liveSolo/end] error:", err);
      res.status(500).json({ message: "Gagal mengakhiri stream" });
    }
  });

  // ── POST /api/live/streams/:id/gift ─────────────────────────────────────
  // Viewer kirim gift ke host. Deduct kredit viewer, kredit host.
  app.post("/api/live/streams/:id/gift", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Kamu harus login terlebih dahulu" });
    const { id } = req.params;
    const { giftName = "Gift", amountCoins } = req.body as { giftName?: string; amountCoins?: number };

    if (!amountCoins || amountCoins <= 0) {
      return res.status(400).json({ message: "Jumlah gift tidak valid" });
    }

    try {
      // Cek stream aktif
      const streamRes = await db.execute(sql`
        SELECT host_user_id, host_username, status FROM live_streams WHERE id = ${id} LIMIT 1
      `);
      if (streamRes.rows.length === 0) return res.status(404).json({ message: "Stream tidak ditemukan" });
      const stream = streamRes.rows[0] as any;
      if (stream.status !== "live") return res.status(400).json({ message: "Stream sudah berakhir" });
      if (stream.host_user_id === req.session.userId) return res.status(400).json({ message: "Host tidak bisa mengirim gift ke diri sendiri" });

      // Ambil username pengirim
      const senderRes = await db.execute(sql`SELECT username FROM users WHERE id = ${req.session.userId} LIMIT 1`);
      const senderUsername = (senderRes.rows[0] as any)?.username ?? "";

      // Cek saldo sender
      const balRes = await db.execute(sql`
        SELECT balance FROM credit_accounts
        WHERE user_id = ${req.session.userId} AND currency = 'IDR'
        LIMIT 1
      `);
      const senderBalance = Number((balRes.rows[0] as any)?.balance ?? 0);
      if (senderBalance < amountCoins) {
        return res.status(400).json({ message: "Saldo tidak cukup untuk mengirim gift ini" });
      }

      // Deduct dari sender
      await db.execute(sql`
        UPDATE credit_accounts
        SET balance = balance - ${amountCoins}, updated_at = NOW()
        WHERE user_id = ${req.session.userId} AND currency = 'IDR' AND balance >= ${amountCoins}
      `);

      // Tambah ke host
      await db.execute(sql`
        INSERT INTO credit_accounts (user_id, currency, balance)
        VALUES (${stream.host_user_id}, 'IDR', ${amountCoins})
        ON CONFLICT (user_id, currency)
        DO UPDATE SET balance = credit_accounts.balance + ${amountCoins}, updated_at = NOW()
      `);

      // Log gift
      await db.execute(sql`
        INSERT INTO stream_gifts (stream_id, sender_user_id, sender_username, host_user_id, gift_name, amount_coins)
        VALUES (${id}, ${req.session.userId}, ${senderUsername}, ${stream.host_user_id}, ${giftName}, ${amountCoins})
      `);

      // Update total_gifts di live_streams
      await db.execute(sql`
        UPDATE live_streams SET total_gifts = total_gifts + ${amountCoins} WHERE id = ${id}
      `);

      res.json({ ok: true, giftName, amountCoins });
    } catch (err) {
      console.error("[liveSolo/gift] error:", err);
      res.status(500).json({ message: "Gagal mengirim gift" });
    }
  });

  // ── POST /api/live/streams/:id/join ─────────────────────────────────────
  // Viewer join stream — tracking analytics.
  app.post("/api/live/streams/:id/join", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Kamu harus login" });
    const { id } = req.params;

    try {
      const userRes = await db.execute(sql`SELECT username FROM users WHERE id = ${req.session.userId} LIMIT 1`);
      const username = (userRes.rows[0] as any)?.username ?? "";

      // Upsert — kalau sudah ada dan belum left, update joined_at saja
      await db.execute(sql`
        INSERT INTO stream_viewers (stream_id, user_id, username)
        VALUES (${id}, ${req.session.userId}, ${username})
        ON CONFLICT (stream_id, user_id) DO UPDATE SET joined_at = NOW(), left_at = NULL
      `);

      // Update viewer_count di live_streams
      await db.execute(sql`
        UPDATE live_streams
        SET viewer_count = (
          SELECT COUNT(*) FROM stream_viewers
          WHERE stream_id = ${id} AND left_at IS NULL
        )
        WHERE id = ${id}
      `);

      res.json({ ok: true });
    } catch (err) {
      console.error("[liveSolo/join] error:", err);
      res.status(500).json({ message: "Gagal join stream" });
    }
  });

  // ── POST /api/live/streams/:id/leave ────────────────────────────────────
  // Viewer leave stream — tracking analytics.
  app.post("/api/live/streams/:id/leave", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Kamu harus login" });
    const { id } = req.params;

    try {
      await db.execute(sql`
        UPDATE stream_viewers SET left_at = NOW()
        WHERE stream_id = ${id} AND user_id = ${req.session.userId} AND left_at IS NULL
      `);

      await db.execute(sql`
        UPDATE live_streams
        SET viewer_count = (
          SELECT COUNT(*) FROM stream_viewers
          WHERE stream_id = ${id} AND left_at IS NULL
        )
        WHERE id = ${id}
      `);

      res.json({ ok: true });
    } catch (err) {
      console.error("[liveSolo/leave] error:", err);
      res.status(500).json({ message: "Gagal leave stream" });
    }
  });
}

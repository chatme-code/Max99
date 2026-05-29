/**
 * adminRoutes.ts — Admin panel untuk Party Voice
 *
 * Routes:
 *   GET  /admin/party                    — HTML admin page
 *   GET  /api/party/gifts                — daftar gift aktif (public, untuk mobile app)
 *   GET  /api/admin/party/gifts          — semua gift (admin)
 *   POST /api/admin/party/gifts          — buat gift baru
 *   PATCH /api/admin/party/gifts/:id     — update gift
 *   DELETE /api/admin/party/gifts/:id    — hapus gift
 *   POST /api/admin/party/gifts/:id/image  — upload thumbnail ke ImageKit
 *   POST /api/admin/party/gifts/:id/lottie — upload Lottie JSON ke ImageKit
 *   GET  /api/admin/party/rooms          — semua rooms (admin view)
 *   DELETE /api/admin/party/rooms/:id    — force-delete room
 *   GET  /api/admin/party/stats          — statistik singkat
 */

import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { saveFileToDisk } from "../../utils/selfHostedUpload";
import { getLivekitRuntimeMode, setLivekitRuntimeMode } from "./routes";

function isAdmin(req: Request): boolean {
  return !!(req as any).session?.userId;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 60);
}

export function registerPartyAdminRoutes(app: Express) {

  // ── Public: GET /api/party/gifts — mobile app fetch ──────────────────────
  app.get("/api/party/gifts", async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT id, name, emoji, price, category, image_url, lottie_url, video_url, is_premium, sort_order
        FROM party_gifts
        WHERE is_active = true
        ORDER BY sort_order ASC, created_at ASC
      `);
      const gifts = (result.rows as any[]).map(g => ({
        id:        g.id,
        name:      g.name,
        hotKey:    g.emoji,
        price:     Number(g.price),
        category:  g.category,
        imageUrl:  g.image_url  ?? null,
        lottieUrl: g.lottie_url ?? null,
        videoUrl:  g.video_url  ?? null,
        isPremium: g.is_premium ?? false,
      }));
      return res.json({ gifts });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: GET /api/admin/party/gifts ─────────────────────────────────────
  app.get("/api/admin/party/gifts", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    try {
      const result = await db.execute(sql`
        SELECT * FROM party_gifts ORDER BY sort_order ASC, created_at ASC
      `);
      return res.json({ gifts: result.rows });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: POST /api/admin/party/gifts — create ───────────────────────────
  app.post("/api/admin/party/gifts", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    const { name, emoji = "🎁", price = 1000, category = "Populer", is_premium = false, sort_order = 0 } = req.body;
    if (!name) return res.status(400).json({ error: "name wajib diisi" });
    try {
      const result = await db.execute(sql`
        INSERT INTO party_gifts (name, emoji, price, category, is_premium, sort_order)
        VALUES (${name}, ${emoji}, ${Number(price)}, ${category}, ${!!is_premium}, ${Number(sort_order)})
        RETURNING *
      `);
      return res.status(201).json({ gift: result.rows[0] });
    } catch (e: any) {
      if (e.message?.includes("unique") || e.message?.includes("duplicate")) {
        return res.status(409).json({ error: "Gift dengan nama tersebut sudah ada" });
      }
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: PATCH /api/admin/party/gifts/:id — update ─────────────────────
  app.patch("/api/admin/party/gifts/:id", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const { name, emoji, price, category, is_active, is_premium, sort_order } = req.body;
    try {
      const result = await db.execute(sql`
        UPDATE party_gifts SET
          name       = COALESCE(${name       ?? null}, name),
          emoji      = COALESCE(${emoji      ?? null}, emoji),
          price      = COALESCE(${price != null ? Number(price) : null}, price),
          category   = COALESCE(${category   ?? null}, category),
          is_active  = COALESCE(${is_active  != null ? !!is_active  : null}, is_active),
          is_premium = COALESCE(${is_premium != null ? !!is_premium : null}, is_premium),
          sort_order = COALESCE(${sort_order != null ? Number(sort_order) : null}, sort_order),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `);
      if (result.rows.length === 0) return res.status(404).json({ error: "Gift tidak ditemukan" });
      return res.json({ gift: result.rows[0] });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: DELETE /api/admin/party/gifts/:id ──────────────────────────────
  app.delete("/api/admin/party/gifts/:id", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    try {
      await db.execute(sql`DELETE FROM party_gifts WHERE id = ${req.params.id}`);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: POST /api/admin/party/gifts/:id/image — upload thumbnail ───────
  app.post("/api/admin/party/gifts/:id/image", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });

    const { base64Data, mimeType = "image/png" } = req.body;
    if (!base64Data) return res.status(400).json({ error: "base64Data wajib diisi" });

    const sizeBytes = Math.round(base64Data.length * 0.75);
    if (sizeBytes > 5 * 1024 * 1024) return res.status(413).json({ error: "File terlalu besar. Maks 5MB." });

    const extMap: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
    const ext = extMap[mimeType] ?? "png";

    try {
      const gift = await db.execute(sql`SELECT name FROM party_gifts WHERE id = ${req.params.id} LIMIT 1`);
      if (!gift.rows[0]) return res.status(404).json({ error: "Gift tidak ditemukan" });
      const giftName = slugify((gift.rows[0] as any).name);

      const { url } = await saveFileToDisk({
        base64Data,
        fileName:  `party_gift_${giftName}.${ext}`,
        subfolder: "party/images",
      });

      await db.execute(sql`UPDATE party_gifts SET image_url = ${url}, updated_at = NOW() WHERE id = ${req.params.id}`);
      return res.json({ success: true, imageUrl: url });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: POST /api/admin/party/gifts/:id/lottie — upload Lottie JSON ────
  app.post("/api/admin/party/gifts/:id/lottie", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });

    const { base64Data } = req.body;
    if (!base64Data) return res.status(400).json({ error: "base64Data wajib diisi" });

    const sizeBytes = Math.round(base64Data.length * 0.75);
    if (sizeBytes > 10 * 1024 * 1024) return res.status(413).json({ error: "File terlalu besar. Maks 10MB." });

    try {
      const gift = await db.execute(sql`SELECT name FROM party_gifts WHERE id = ${req.params.id} LIMIT 1`);
      if (!gift.rows[0]) return res.status(404).json({ error: "Gift tidak ditemukan" });
      const giftName = slugify((gift.rows[0] as any).name);

      const { url } = await saveFileToDisk({
        base64Data,
        fileName:  `party_gift_${giftName}.json`,
        subfolder: "party/lottie",
      });

      await db.execute(sql`UPDATE party_gifts SET lottie_url = ${url}, updated_at = NOW() WHERE id = ${req.params.id}`);
      return res.json({ success: true, lottieUrl: url });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: DELETE lottie ──────────────────────────────────────────────────
  app.delete("/api/admin/party/gifts/:id/lottie", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    try {
      await db.execute(sql`UPDATE party_gifts SET lottie_url = NULL, updated_at = NOW() WHERE id = ${req.params.id}`);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: POST /api/admin/party/gifts/:id/video — upload WebM/MP4 ────────
  app.post("/api/admin/party/gifts/:id/video", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });

    const { base64Data, mimeType = "video/webm" } = req.body;
    if (!base64Data) return res.status(400).json({ error: "base64Data wajib diisi" });

    const sizeBytes = Math.round(base64Data.length * 0.75);
    if (sizeBytes > 50 * 1024 * 1024) return res.status(413).json({ error: "File terlalu besar. Maks 50MB." });

    const extMap: Record<string, string> = { "video/webm": "webm", "video/mp4": "mp4", "video/quicktime": "mov" };
    const ext = extMap[mimeType] ?? "webm";

    try {
      const gift = await db.execute(sql`SELECT name FROM party_gifts WHERE id = ${req.params.id} LIMIT 1`);
      if (!gift.rows[0]) return res.status(404).json({ error: "Gift tidak ditemukan" });
      const giftName = slugify((gift.rows[0] as any).name);

      const { url } = await saveFileToDisk({
        base64Data,
        fileName:  `party_gift_${giftName}.${ext}`,
        subfolder: "party/video",
      });

      await db.execute(sql`UPDATE party_gifts SET video_url = ${url}, updated_at = NOW() WHERE id = ${req.params.id}`);
      return res.json({ success: true, videoUrl: url });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: DELETE video ───────────────────────────────────────────────────
  app.delete("/api/admin/party/gifts/:id/video", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    try {
      await db.execute(sql`UPDATE party_gifts SET video_url = NULL, updated_at = NOW() WHERE id = ${req.params.id}`);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: GET /api/admin/party/rooms ─────────────────────────────────────
  app.get("/api/admin/party/rooms", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    try {
      const result = await db.execute(sql`
        SELECT
          pr.id, pr.name, pr.description, pr.color,
          pr.creator_username, pr.max_seats, pr.is_active,
          pr.is_locked, pr.created_at,
          COUNT(ps.id) FILTER (WHERE ps.user_id IS NOT NULL) AS participant_count
        FROM party_rooms pr
        LEFT JOIN party_seats ps ON ps.party_room_id = pr.id
        GROUP BY pr.id
        ORDER BY pr.created_at DESC
        LIMIT 200
      `);
      return res.json({ rooms: result.rows });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: DELETE /api/admin/party/rooms/:id — force-delete ──────────────
  app.delete("/api/admin/party/rooms/:id", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    try {
      await db.execute(sql`UPDATE party_rooms SET is_active = false WHERE id = ${req.params.id}`);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: GET /api/admin/party/livekit-status ───────────────────────────
  app.get("/api/admin/party/livekit-status", (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    const cloudReady = !!(process.env.LIVEKIT_CLOUD_URL && process.env.LIVEKIT_CLOUD_API_KEY && process.env.LIVEKIT_CLOUD_API_SECRET);
    const selfReady  = !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    const mode = getLivekitRuntimeMode();
    let activeProvider: "cloud" | "selfhosted";
    if (mode === "cloud") activeProvider = "cloud";
    else if (mode === "selfhosted") activeProvider = "selfhosted";
    else activeProvider = cloudReady ? "cloud" : "selfhosted";
    return res.json({
      mode,
      activeProvider,
      cloud: {
        configured: cloudReady,
        url: process.env.LIVEKIT_CLOUD_URL || null,
      },
      self: {
        configured: selfReady,
        url: process.env.LIVEKIT_URL || null,
      },
    });
  });

  // ── Admin: POST /api/admin/party/switch-provider ──────────────────────────
  // Switch LiveKit provider secara real-time tanpa restart Docker.
  // Auth: session userId (browser) OR x-internal-key header (admin panel service)
  app.post("/api/admin/party/switch-provider", (req: Request, res: Response) => {
    const INTERNAL_KEY = process.env.INTERNAL_API_KEY || "migme-internal-admin-2024";
    const isInternalReq = req.headers["x-internal-key"] === INTERNAL_KEY;
    if (!isAdmin(req) && !isInternalReq) return res.status(401).json({ message: "Unauthorized" });
    const { mode } = req.body;
    if (!["cloud", "selfhosted", "auto"].includes(mode)) {
      return res.status(400).json({ error: "mode harus: cloud | selfhosted | auto" });
    }
    const cloudReady = !!(process.env.LIVEKIT_CLOUD_URL && process.env.LIVEKIT_CLOUD_API_KEY && process.env.LIVEKIT_CLOUD_API_SECRET);
    const selfReady  = !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    if (mode === "cloud" && !cloudReady) {
      return res.status(422).json({ error: "LiveKit Cloud credentials belum dikonfigurasi di .env" });
    }
    if (mode === "selfhosted" && !selfReady) {
      return res.status(422).json({ error: "LiveKit Self-hosted credentials belum dikonfigurasi di .env" });
    }
    setLivekitRuntimeMode(mode as "cloud" | "selfhosted" | "auto");
    let activeProvider: "cloud" | "selfhosted";
    if (mode === "cloud") activeProvider = "cloud";
    else if (mode === "selfhosted") activeProvider = "selfhosted";
    else activeProvider = cloudReady ? "cloud" : "selfhosted";
    console.log(`[admin] LiveKit provider switched → ${mode} (active: ${activeProvider})`);
    return res.json({ ok: true, mode, activeProvider });
  });

  // ── Admin: GET /api/admin/party/stats ─────────────────────────────────────
  app.get("/api/admin/party/stats", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });
    try {
      const [rooms, gifts, seats] = await Promise.all([
        db.execute(sql`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active FROM party_rooms`),
        db.execute(sql`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active FROM party_gifts`),
        db.execute(sql`SELECT COUNT(*) AS total FROM party_seats WHERE user_id IS NOT NULL`),
      ]);
      return res.json({
        rooms:  { total: Number((rooms.rows[0] as any).total), active: Number((rooms.rows[0] as any).active) },
        gifts:  { total: Number((gifts.rows[0] as any).total), active: Number((gifts.rows[0] as any).active) },
        seats:  { occupied: Number((seats.rows[0] as any).total) },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── HTML Admin Page ───────────────────────────────────────────────────────
  app.get("/admin/party", (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Party Voice</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0c1e;color:#e2e8f0;min-height:100vh}
    .topbar{background:linear-gradient(135deg,#4c1d95,#7c3aed);padding:0 24px;display:flex;align-items:center;gap:16px;height:56px;position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,0.4)}
    .topbar h1{font-size:18px;font-weight:800;color:#fff;display:flex;align-items:center;gap:8px}
    .topbar a{color:rgba(255,255,255,0.6);font-size:13px;text-decoration:none}
    .topbar a:hover{color:#fff}
    .topbar-sep{color:rgba(255,255,255,0.3)}
    .tabs{display:flex;gap:4px;background:#1a1630;padding:0 24px;border-bottom:1px solid rgba(255,255,255,0.08)}
    .tab{padding:14px 20px;font-size:14px;font-weight:600;color:rgba(255,255,255,0.45);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
    .tab.active{color:#a78bfa;border-bottom-color:#7c3aed}
    .tab:hover:not(.active){color:rgba(255,255,255,0.75)}
    .page{display:none;max-width:1100px;margin:0 auto;padding:28px 24px}
    .page.active{display:block}
    .stats-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
    .stat-card{background:#1a1630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:18px 22px;flex:1;min-width:140px}
    .stat-num{font-size:28px;font-weight:900;color:#a78bfa}
    .stat-label{font-size:12px;color:rgba(255,255,255,0.45);margin-top:4px}
    .card{background:#1a1630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:22px;margin-bottom:20px}
    .card h2{font-size:15px;font-weight:700;color:#c4b5fd;margin-bottom:16px;display:flex;align-items:center;gap:8px}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:opacity .15s}
    .btn:hover{opacity:.85}
    .btn-primary{background:#7c3aed;color:#fff}
    .btn-success{background:#059669;color:#fff}
    .btn-danger{background:#dc2626;color:#fff}
    .btn-ghost{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.1)}
    .btn-sm{padding:5px 10px;font-size:11px}
    .btn:disabled{opacity:.4;cursor:not-allowed}
    .form-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .form-group{display:flex;flex-direction:column;gap:5px;flex:1;min-width:160px}
    .form-group label{font-size:12px;font-weight:600;color:rgba(255,255,255,0.5)}
    input,select,textarea{background:#0f0c1e;border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#e2e8f0;font-size:13px;padding:8px 12px;width:100%}
    input:focus,select:focus,textarea:focus{outline:none;border-color:#7c3aed}
    .gift-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-top:16px}
    .gift-card{background:#0f0c1e;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;position:relative;display:flex;flex-direction:column;align-items:center;gap:8px}
    .gift-card .preview{position:relative;width:72px;height:72px;display:flex;align-items:center;justify-content:center}
    .gift-card .preview img{width:72px;height:72px;object-fit:contain;border-radius:8px}
    .gift-card .preview .emoji-fallback{font-size:42px;line-height:72px}
    .badge-lottie{position:absolute;top:-4px;right:-4px;background:#7c3aed;color:#fff;font-size:9px;font-weight:800;border-radius:4px;padding:2px 5px}
    .badge-video{position:absolute;top:-4px;right:-4px;background:#dc2626;color:#fff;font-size:9px;font-weight:800;border-radius:4px;padding:2px 5px}
    .badge-premium{position:absolute;top:-4px;left:-4px;background:#f59e0b;color:#000;font-size:9px;font-weight:800;border-radius:4px;padding:2px 5px}
    .badge-inactive{position:absolute;top:-4px;left:-4px;background:#64748b;color:#fff;font-size:9px;font-weight:800;border-radius:4px;padding:2px 5px}
    .gift-name{font-size:13px;font-weight:700;color:#e2e8f0;text-align:center}
    .gift-price{font-size:12px;color:#fbbf24;font-weight:600}
    .gift-cat{font-size:10px;color:rgba(255,255,255,0.35);background:rgba(255,255,255,0.06);border-radius:4px;padding:2px 6px}
    .gift-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:4px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:10px 12px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid rgba(255,255,255,0.08)}
    td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.05);vertical-align:middle}
    tr:hover td{background:rgba(255,255,255,0.02)}
    .dot-active{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:5px}
    .dot-inactive{display:inline-block;width:7px;height:7px;border-radius:50%;background:#64748b;margin-right:5px}
    .toast{position:fixed;bottom:24px;right:24px;padding:12px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;opacity:0;transform:translateY(8px);transition:all .25s;pointer-events:none}
    .toast.show{opacity:1;transform:translateY(0)}
    .toast.success{background:#059669;color:#fff}
    .toast.error{background:#dc2626;color:#fff}
    .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:500;display:none;align-items:center;justify-content:center}
    .modal-backdrop.open{display:flex}
    .modal{background:#1a1630;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:28px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto}
    .modal h3{font-size:16px;font-weight:800;color:#c4b5fd;margin-bottom:20px}
    .empty{text-align:center;color:rgba(255,255,255,0.3);font-size:13px;padding:40px}
    #lottie-preview-wrap{display:none;margin:0 auto 16px;width:160px;height:160px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;overflow:hidden}
    #lottie-preview-info{font-size:11px;color:rgba(255,255,255,0.4);text-align:center;margin-bottom:14px;display:none}
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js" defer></script>
</head>
<body>

<div class="topbar">
  <h1>🎵 Party Voice Admin</h1>
  <span class="topbar-sep">|</span>
  <a href="/admin/gifts">🎁 Gift Classic</a>
</div>

<div class="tabs">
  <div class="tab active" onclick="switchTab('gifts')">🎁 Gift Party</div>
  <div class="tab" onclick="switchTab('rooms')">🎤 Party Rooms</div>
  <div class="tab" onclick="switchTab('stats')">📊 Statistik</div>
  <div class="tab" onclick="switchTab('income')">💰 Pendapatan</div>
  <div class="tab" onclick="switchTab('livekit')">🔀 LiveKit</div>
</div>

<!-- ══════════ TAB: GIFT ══════════ -->
<div class="page active" id="page-gifts">

  <div style="margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
    <div>
      <h2 style="font-size:18px;font-weight:800;color:#fff">Gift Manager — Party Voice</h2>
      <p style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:4px">Kelola gift khusus untuk party room. Support thumbnail PNG/WEBP/GIF dan animasi Lottie JSON.</p>
    </div>
    <button class="btn btn-primary" onclick="openCreateModal()">+ Tambah Gift</button>
  </div>

  <div id="gift-grid" class="gift-grid">
    <div class="empty">Memuat...</div>
  </div>
</div>

<!-- ══════════ TAB: ROOMS ══════════ -->
<div class="page" id="page-rooms">
  <div style="margin-bottom:20px;display:flex;justify-content:space-between;align-items:center">
    <div>
      <h2 style="font-size:18px;font-weight:800;color:#fff">Party Rooms</h2>
      <p style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:4px">Semua room (aktif + nonaktif). Klik Nonaktifkan untuk menutup paksa room.</p>
    </div>
    <button class="btn btn-ghost btn-sm" onclick="loadRooms()">↻ Refresh</button>
  </div>
  <div class="card" style="padding:0;overflow:hidden">
    <table>
      <thead><tr>
        <th>Status</th><th>Nama Room</th><th>Owner</th><th>Seat</th><th>Dibuat</th><th>Aksi</th>
      </tr></thead>
      <tbody id="rooms-tbody"><tr><td colspan="6" class="empty">Memuat...</td></tr></tbody>
    </table>
  </div>
</div>

<!-- ══════════ TAB: STATS ══════════ -->
<div class="page" id="page-stats">
  <h2 style="font-size:18px;font-weight:800;color:#fff;margin-bottom:20px">Statistik Party Voice</h2>
  <div class="stats-row" id="stats-row">
    <div class="stat-card"><div class="stat-num" id="s-rooms-active">—</div><div class="stat-label">Room Aktif</div></div>
    <div class="stat-card"><div class="stat-num" id="s-rooms-total">—</div><div class="stat-label">Total Room (all-time)</div></div>
    <div class="stat-card"><div class="stat-num" id="s-gifts-active">—</div><div class="stat-label">Gift Party Aktif</div></div>
    <div class="stat-card"><div class="stat-num" id="s-seats-occ">—</div><div class="stat-label">Kursi Terisi Saat Ini</div></div>
  </div>
</div>

<!-- ══════════ TAB: PENDAPATAN ══════════ -->
<div class="page" id="page-income">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px">
    <div>
      <h2 style="font-size:18px;font-weight:800;color:#fff">💰 Pendapatan Party Room</h2>
      <p style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:4px">Coin & diamond dari gift yang dikirim di party room.</p>
    </div>
    <button class="btn btn-ghost btn-sm" onclick="loadIncome()">↻ Refresh</button>
  </div>

  <!-- Summary hari ini -->
  <div class="stats-row" style="margin-bottom:24px">
    <div class="stat-card">
      <div class="stat-num" id="inc-coin-today" style="color:#fbbf24">—</div>
      <div class="stat-label">🪙 Total Koin Hari Ini</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" id="inc-diamond-today" style="color:#60a5fa">—</div>
      <div class="stat-label">💎 Total Diamond Hari Ini</div>
    </div>
  </div>

  <!-- Pendapatan harian (30 hari) -->
  <div class="card" style="margin-bottom:20px">
    <h2>📅 Pendapatan Per Hari (30 Hari Terakhir)</h2>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Tanggal</th>
          <th>Jumlah Transaksi</th>
          <th>Room Aktif</th>
          <th style="color:#fbbf24">Total Koin</th>
          <th style="color:#60a5fa">Total Diamond</th>
        </tr></thead>
        <tbody id="income-daily-tbody"><tr><td colspan="5" class="empty">Memuat...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Pendapatan per room -->
  <div class="card">
    <h2>🎤 Pendapatan Per Room (All-time)</h2>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Room</th>
          <th>Creator</th>
          <th>Status</th>
          <th>Transaksi</th>
          <th style="color:#fbbf24">Total Koin</th>
          <th style="color:#60a5fa">Total Diamond</th>
          <th>Terakhir Aktif</th>
        </tr></thead>
        <tbody id="income-rooms-tbody"><tr><td colspan="7" class="empty">Memuat...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════ MODALS ══════════ -->

<!-- Create/Edit Gift Modal -->
<div class="modal-backdrop" id="gift-modal">
  <div class="modal">
    <h3 id="modal-title">Tambah Gift Party</h3>
    <input type="hidden" id="edit-id">
    <div class="form-row">
      <div class="form-group">
        <label>Nama Gift *</label>
        <input type="text" id="f-name" placeholder="contoh: Singa Emas">
      </div>
      <div class="form-group" style="max-width:90px">
        <label>Emoji</label>
        <input type="text" id="f-emoji" placeholder="🎁" maxlength="8">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Harga (Koin)</label>
        <input type="number" id="f-price" value="1000" min="1">
      </div>
      <div class="form-group">
        <label>Kategori</label>
        <select id="f-category">
          <option>Populer</option>
          <option>Lucky</option>
          <option>Set Kostum</option>
          <option>Luxury</option>
          <option>Premium</option>
          <option>Spesial</option>
        </select>
      </div>
      <div class="form-group" style="max-width:80px">
        <label>Urutan</label>
        <input type="number" id="f-order" value="0" min="0">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group" style="max-width:180px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="f-premium" style="width:auto">
          Tandai sebagai Premium ⭐
        </label>
      </div>
      <div class="form-group" style="max-width:160px" id="f-active-wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="f-active" checked style="width:auto">
          Gift Aktif
        </label>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
      <button class="btn btn-ghost" onclick="closeModal('gift-modal')">Batal</button>
      <button class="btn btn-primary" id="modal-save-btn" onclick="saveGift()">Simpan</button>
    </div>
  </div>
</div>

<!-- Upload Image Modal -->
<div class="modal-backdrop" id="img-modal">
  <div class="modal">
    <h3>Upload Thumbnail Gift</h3>
    <p style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:16px">Format: PNG, WEBP, GIF, JPG. Maks 5MB. Disimpan ke self-hosted storage (img.chatmeapp.my.id).</p>
    <input type="hidden" id="img-gift-id">
    <div class="form-group" style="margin-bottom:16px">
      <label>File Gambar</label>
      <input type="file" id="img-file" accept="image/png,image/jpeg,image/gif,image/webp">
    </div>
    <div id="img-preview-wrap" style="text-align:center;margin-bottom:16px;display:none">
      <img id="img-preview" style="max-width:120px;max-height:120px;border-radius:10px;border:1px solid rgba(255,255,255,0.1)">
    </div>
    <div id="img-status" style="font-size:13px;margin-bottom:12px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="closeModal('img-modal')">Batal</button>
      <button class="btn btn-success" onclick="uploadImage()" id="img-upload-btn">⬆ Upload ke CDN</button>
    </div>
  </div>
</div>

<!-- Upload Lottie Modal -->
<div class="modal-backdrop" id="lottie-modal">
  <div class="modal">
    <h3>🎬 Upload Animasi Lottie</h3>
    <p style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:6px">Format: <strong style="color:#a78bfa">.json</strong> (Lottie/Bodymovin). Maks 10MB.</p>
    <p style="font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:16px">Buat file di: <a href="https://lottiefiles.com" target="_blank" style="color:#a78bfa">LottieFiles.com</a> atau Adobe After Effects + Bodymovin plugin.</p>
    <input type="hidden" id="lottie-gift-id">
    <div class="form-group" style="margin-bottom:16px">
      <label>File Lottie (.json)</label>
      <input type="file" id="lottie-file" accept=".json,application/json" onchange="previewLottie(this)">
    </div>
    <div id="lottie-preview-wrap"><div id="lottie-preview-canvas"></div></div>
    <div id="lottie-preview-info"></div>
    <div id="lottie-status" style="font-size:13px;margin-bottom:12px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="closeModal('lottie-modal')">Batal</button>
      <button class="btn btn-primary" onclick="uploadLottie()" id="lottie-upload-btn">⬆ Upload Lottie</button>
    </div>
  </div>
</div>

<!-- Upload Video Modal -->
<div class="modal-backdrop" id="video-modal">
  <div class="modal">
    <h3>🎥 Upload Video Gift (WebM / MP4)</h3>
    <p style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:6px">Format: <strong style="color:#f87171">.webm</strong> atau <strong style="color:#f87171">.mp4</strong>. Maks 50MB.</p>
    <p style="font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:16px">WebM dengan alpha channel akan transparan di Android. MP4 untuk kompatibilitas iOS.</p>
    <input type="hidden" id="video-gift-id">
    <div class="form-group" style="margin-bottom:16px">
      <label>File Video (.webm / .mp4)</label>
      <input type="file" id="video-file" accept="video/webm,video/mp4,video/quicktime,.webm,.mp4,.mov" onchange="previewVideo(this)">
    </div>
    <div id="video-preview-wrap" style="text-align:center;margin-bottom:16px;display:none">
      <video id="video-preview" controls muted style="max-width:100%;max-height:200px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:transparent"></video>
      <div id="video-preview-info" style="font-size:12px;color:rgba(255,255,255,0.45);margin-top:6px"></div>
    </div>
    <div id="video-status" style="font-size:13px;margin-bottom:12px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="closeModal('video-modal')">Batal</button>
      <button class="btn btn-danger" style="background:#dc2626" onclick="uploadVideo()" id="video-upload-btn">🎥 Upload Video</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
let allGifts = [];
let currentTab = 'gifts';

// ── Tab switch ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((el, i) => {
    el.classList.toggle('active', ['gifts','rooms','stats','income','livekit'][i] === tab);
  });
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + tab).classList.add('active');
  if (tab === 'gifts')   loadGifts();
  if (tab === 'rooms')   loadRooms();
  if (tab === 'stats')   loadStats();
  if (tab === 'income')  loadIncome();
  if (tab === 'livekit') loadLivekitStatus();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type='success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── Load Gifts ────────────────────────────────────────────────────────────────
async function loadGifts() {
  try {
    const res = await fetch('/api/admin/party/gifts', { credentials: 'include' });
    const data = await res.json();
    allGifts = data.gifts || [];
    renderGifts();
  } catch(e) {
    document.getElementById('gift-grid').innerHTML = '<div class="empty">Gagal memuat gift: ' + e.message + '</div>';
  }
}

function renderGifts() {
  const grid = document.getElementById('gift-grid');
  if (!allGifts.length) {
    grid.innerHTML = '<div class="empty">Belum ada gift party. Klik "+ Tambah Gift" untuk mulai.</div>';
    return;
  }
  grid.innerHTML = allGifts.map(g => {
    const hasImg    = !!g.image_url;
    const hasLottie = !!g.lottie_url;
    const hasVideo  = !!g.video_url;
    const imgEl = hasImg
      ? \`<img src="\${g.image_url}?t=\${Date.now()}" alt="\${g.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">\`
      : '';
    const emojiEl      = \`<span class="emoji-fallback" \${hasImg ? 'style="display:none"' : ''}>\${g.emoji || '🎁'}</span>\`;
    const videoBadge   = hasVideo   ? '<span class="badge-video">🎥 Video</span>'    : '';
    const lottieBadge  = !hasVideo && hasLottie ? '<span class="badge-lottie">✨ Lottie</span>' : '';
    const premiumBadge = g.is_premium ? '<span class="badge-premium">⭐ PREMIUM</span>' : '';
    const inactiveBadge = !g.is_active ? '<span class="badge-inactive">OFF</span>' : '';

    return \`<div class="gift-card">
      <div class="preview">\${imgEl}\${emojiEl}\${videoBadge}\${lottieBadge}\${premiumBadge}\${inactiveBadge}</div>
      <div class="gift-name">\${g.name}</div>
      <div class="gift-price">🪙 \${Number(g.price).toLocaleString('id-ID')}</div>
      <span class="gift-cat">\${g.category}</span>
      <div class="gift-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditModal('\${g.id}')">✏️ Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="openImgModal('\${g.id}')">🖼️</button>
        <button class="btn btn-primary btn-sm" onclick="openLottieModal('\${g.id}')">🎬 Lottie</button>
        <button class="btn btn-danger btn-sm" style="background:#dc2626" onclick="openVideoModal('\${g.id}')">🎥 Video</button>
        <button class="btn btn-danger btn-sm" onclick="deleteGift('\${g.id}','\${g.name}')">🗑️</button>
      </div>
    </div>\`;
  }).join('');
}

// ── Create modal ──────────────────────────────────────────────────────────────
function openCreateModal() {
  document.getElementById('modal-title').textContent = 'Tambah Gift Party';
  document.getElementById('edit-id').value = '';
  document.getElementById('f-name').value = '';
  document.getElementById('f-emoji').value = '🎁';
  document.getElementById('f-price').value = '1000';
  document.getElementById('f-category').value = 'Populer';
  document.getElementById('f-order').value = '0';
  document.getElementById('f-premium').checked = false;
  document.getElementById('f-active').checked = true;
  document.getElementById('f-active-wrap').style.display = 'none';
  openModal('gift-modal');
}

// ── Edit modal ────────────────────────────────────────────────────────────────
function openEditModal(id) {
  const g = allGifts.find(x => x.id === id);
  if (!g) return;
  document.getElementById('modal-title').textContent = 'Edit Gift: ' + g.name;
  document.getElementById('edit-id').value = g.id;
  document.getElementById('f-name').value = g.name;
  document.getElementById('f-emoji').value = g.emoji || '🎁';
  document.getElementById('f-price').value = g.price;
  document.getElementById('f-category').value = g.category || 'Populer';
  document.getElementById('f-order').value = g.sort_order ?? 0;
  document.getElementById('f-premium').checked = !!g.is_premium;
  document.getElementById('f-active').checked = !!g.is_active;
  document.getElementById('f-active-wrap').style.display = 'block';
  openModal('gift-modal');
}

// ── Save gift ─────────────────────────────────────────────────────────────────
async function saveGift() {
  const id    = document.getElementById('edit-id').value;
  const name  = document.getElementById('f-name').value.trim();
  const emoji = document.getElementById('f-emoji').value.trim() || '🎁';
  const price = parseInt(document.getElementById('f-price').value) || 1000;
  const cat   = document.getElementById('f-category').value;
  const order = parseInt(document.getElementById('f-order').value) || 0;
  const prem  = document.getElementById('f-premium').checked;
  const active = document.getElementById('f-active').checked;

  if (!name) { toast('Nama gift wajib diisi!', 'error'); return; }

  const btn = document.getElementById('modal-save-btn');
  btn.disabled = true; btn.textContent = 'Menyimpan...';

  try {
    const body = { name, emoji, price, category: cat, sort_order: order, is_premium: prem, is_active: active };
    const url  = id ? '/api/admin/party/gifts/' + id : '/api/admin/party/gifts';
    const method = id ? 'PATCH' : 'POST';
    const res = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body), credentials: 'include' });
    const data = await res.json();
    if (res.ok) {
      toast(id ? '✓ Gift diperbarui!' : '✓ Gift berhasil dibuat!');
      closeModal('gift-modal');
      await loadGifts();
    } else {
      toast(data.error || 'Gagal menyimpan gift', 'error');
    }
  } catch(e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan';
  }
}

// ── Delete gift ───────────────────────────────────────────────────────────────
async function deleteGift(id, name) {
  if (!confirm('Hapus gift "' + name + '"? Aksi ini tidak bisa dibatalkan.')) return;
  try {
    const res = await fetch('/api/admin/party/gifts/' + id, { method: 'DELETE', credentials: 'include' });
    if (res.ok) { toast('✓ Gift dihapus'); await loadGifts(); }
    else { const d = await res.json(); toast(d.error || 'Gagal hapus', 'error'); }
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

// ── Image upload ──────────────────────────────────────────────────────────────
function openImgModal(id) {
  document.getElementById('img-gift-id').value = id;
  document.getElementById('img-file').value = '';
  document.getElementById('img-status').textContent = '';
  document.getElementById('img-preview-wrap').style.display = 'none';
  openModal('img-modal');
}

document.getElementById('img-file').addEventListener('change', function() {
  const f = this.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('img-preview').src = e.target.result;
    document.getElementById('img-preview-wrap').style.display = 'block';
  };
  reader.readAsDataURL(f);
});

async function uploadImage() {
  const id   = document.getElementById('img-gift-id').value;
  const file = document.getElementById('img-file').files[0];
  if (!file) { toast('Pilih file gambar terlebih dahulu', 'error'); return; }

  const btn = document.getElementById('img-upload-btn');
  btn.disabled = true; btn.textContent = 'Mengupload...';
  document.getElementById('img-status').textContent = '⬆ Mengupload ke server...';

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result.split(',')[1];
    try {
      const res = await fetch('/api/admin/party/gifts/' + id + '/image', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ base64Data: base64, mimeType: file.type }),
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('img-status').innerHTML = '✓ <span style="color:#22c55e">Upload berhasil!</span>';
        toast('✓ Thumbnail gift diperbarui!');
        closeModal('img-modal');
        await loadGifts();
      } else {
        document.getElementById('img-status').innerHTML = '<span style="color:#f87171">' + (data.error || 'Upload gagal') + '</span>';
        toast(data.error || 'Upload gagal', 'error');
      }
    } catch(err) {
      document.getElementById('img-status').innerHTML = '<span style="color:#f87171">Error: ' + err.message + '</span>';
      toast('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '⬆ Upload ke CDN';
    }
  };
  reader.readAsDataURL(file);
}

// ── Lottie upload ─────────────────────────────────────────────────────────────
let _lottiePreviewAnim = null;

function clearLottiePreview() {
  if (_lottiePreviewAnim) { _lottiePreviewAnim.destroy(); _lottiePreviewAnim = null; }
  const canvas = document.getElementById('lottie-preview-canvas');
  canvas.innerHTML = '';
  document.getElementById('lottie-preview-wrap').style.display = 'none';
  document.getElementById('lottie-preview-info').style.display = 'none';
}

function previewLottie(input) {
  clearLottiePreview();
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const wrap   = document.getElementById('lottie-preview-wrap');
      const canvas = document.getElementById('lottie-preview-canvas');
      const info   = document.getElementById('lottie-preview-info');
      wrap.style.display = 'block';

      _lottiePreviewAnim = lottie.loadAnimation({
        container:     canvas,
        renderer:      'svg',
        loop:          true,
        autoplay:      true,
        animationData: data,
      });

      const fps  = data.fr ?? '?';
      const dur  = data.ip != null && data.op != null && data.fr
                    ? ((data.op - data.ip) / data.fr).toFixed(1) + 's'
                    : '?';
      const kb   = (file.size / 1024).toFixed(0);
      info.textContent = fps + ' fps · ' + dur + ' · ' + kb + ' KB';
      info.style.display = 'block';
    } catch {
      document.getElementById('lottie-status').innerHTML =
        '<span style="color:#f87171">File tidak valid — bukan format Lottie JSON.</span>';
    }
  };
  reader.readAsText(file);
}

function openLottieModal(id) {
  document.getElementById('lottie-gift-id').value = id;
  document.getElementById('lottie-file').value = '';
  document.getElementById('lottie-status').textContent = '';
  clearLottiePreview();
  openModal('lottie-modal');
}

async function uploadLottie() {
  const id   = document.getElementById('lottie-gift-id').value;
  const file = document.getElementById('lottie-file').files[0];
  if (!file) { toast('Pilih file Lottie (.json)', 'error'); return; }
  if (!file.name.endsWith('.json')) { toast('File harus berformat .json', 'error'); return; }

  const maxMB = 10;
  if (file.size > maxMB * 1024 * 1024) { toast('File terlalu besar. Maks ' + maxMB + 'MB.', 'error'); return; }

  const btn = document.getElementById('lottie-upload-btn');
  btn.disabled = true; btn.textContent = 'Mengupload...';
  document.getElementById('lottie-status').textContent = '⬆ Mengupload ke server...';

  const reader = new FileReader();
  reader.onload = async (e) => {
    // readAsDataURL menghasilkan "data:application/json;base64,XXXX"
    // ambil bagian base64 setelah koma
    const dataUrl = e.target.result;
    const base64  = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    try {
      const res = await fetch('/api/admin/party/gifts/' + id + '/lottie', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ base64Data: base64 }),
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('lottie-status').innerHTML = '✓ <span style="color:#22c55e">Lottie berhasil diupload!</span>';
        toast('✓ Animasi Lottie gift diperbarui!');
        closeModal('lottie-modal');
        await loadGifts();
      } else {
        document.getElementById('lottie-status').innerHTML = '<span style="color:#f87171">' + (data.error || 'Upload gagal') + '</span>';
        toast(data.error || 'Upload gagal', 'error');
      }
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '⬆ Upload Lottie';
    }
  };
  reader.onerror = () => {
    toast('Gagal membaca file. Coba lagi.', 'error');
    btn.disabled = false; btn.textContent = '⬆ Upload Lottie';
  };
  // Gunakan readAsDataURL — lebih efisien untuk file besar, tidak ada batas btoa()
  reader.readAsDataURL(file);
}

// ── Video upload ───────────────────────────────────────────────────────────────
function openVideoModal(id) {
  document.getElementById('video-gift-id').value = id;
  document.getElementById('video-file').value = '';
  document.getElementById('video-status').textContent = '';
  document.getElementById('video-preview-wrap').style.display = 'none';
  document.getElementById('video-preview').src = '';
  document.getElementById('video-preview-info').textContent = '';
  openModal('video-modal');
}

function previewVideo(input) {
  const file = input.files[0];
  if (!file) return;
  const wrap = document.getElementById('video-preview-wrap');
  const vid  = document.getElementById('video-preview');
  const info = document.getElementById('video-preview-info');
  const url  = URL.createObjectURL(file);
  vid.src = url;
  wrap.style.display = 'block';
  const mb = (file.size / 1024 / 1024).toFixed(2);
  info.textContent = file.name + ' — ' + mb + ' MB';
  if (file.size > 50 * 1024 * 1024) {
    document.getElementById('video-status').innerHTML = '<span style="color:#f87171">⚠ File terlalu besar (maks 50MB)</span>';
  } else {
    document.getElementById('video-status').textContent = '';
  }
}

async function uploadVideo() {
  const id   = document.getElementById('video-gift-id').value;
  const file = document.getElementById('video-file').files[0];
  if (!file) { toast('Pilih file video (.webm atau .mp4)', 'error'); return; }

  const allowed = ['video/webm', 'video/mp4', 'video/quicktime'];
  if (!allowed.includes(file.type) && !file.name.match(/\.(webm|mp4|mov)$/i)) {
    toast('Format harus .webm, .mp4, atau .mov', 'error'); return;
  }
  if (file.size > 50 * 1024 * 1024) { toast('File terlalu besar. Maks 50MB.', 'error'); return; }

  const btn = document.getElementById('video-upload-btn');
  btn.disabled = true; btn.textContent = 'Mengupload...';
  document.getElementById('video-status').textContent = '⬆ Membaca file...';

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    const base64  = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    document.getElementById('video-status').textContent = '⬆ Mengupload ke server...';
    try {
      const res = await fetch('/api/admin/party/gifts/' + id + '/video', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ base64Data: base64, mimeType: file.type || 'video/webm' }),
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('video-status').innerHTML = '✓ <span style="color:#22c55e">Video berhasil diupload!</span>';
        toast('✓ Video gift diperbarui!');
        closeModal('video-modal');
        await loadGifts();
      } else {
        document.getElementById('video-status').innerHTML = '<span style="color:#f87171">' + (data.error || 'Upload gagal') + '</span>';
        toast(data.error || 'Upload gagal', 'error');
      }
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '🎥 Upload Video';
    }
  };
  reader.onerror = () => {
    toast('Gagal membaca file. Coba lagi.', 'error');
    btn.disabled = false; btn.textContent = '🎥 Upload Video';
  };
  reader.readAsDataURL(file);
}

// ── Rooms ─────────────────────────────────────────────────────────────────────
async function loadRooms() {
  try {
    const res = await fetch('/api/admin/party/rooms', { credentials: 'include' });
    const data = await res.json();
    const tbody = document.getElementById('rooms-tbody');
    const rooms = data.rooms || [];
    if (!rooms.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Belum ada party room.</td></tr>';
      return;
    }
    tbody.innerHTML = rooms.map(r => {
      const dot = r.is_active ? '<span class="dot-active"></span>Aktif' : '<span class="dot-inactive"></span>Nonaktif';
      const date = new Date(r.created_at).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
      const deact = r.is_active
        ? \`<button class="btn btn-danger btn-sm" onclick="deactivateRoom('\${r.id}')">Nonaktifkan</button>\`
        : '<span style="color:rgba(255,255,255,.25);font-size:12px">—</span>';
      return \`<tr>
        <td>\${dot}</td>
        <td style="font-weight:700">\${r.name}</td>
        <td style="color:rgba(255,255,255,.6)">\${r.creator_username || '—'}</td>
        <td><span style="color:#a78bfa;font-weight:700">\${r.participant_count || 0}</span>/<span style="color:rgba(255,255,255,.4)">\${r.max_seats}</span></td>
        <td style="color:rgba(255,255,255,.4);font-size:12px">\${date}</td>
        <td>\${deact}</td>
      </tr>\`;
    }).join('');
  } catch(e) {
    document.getElementById('rooms-tbody').innerHTML = '<tr><td colspan="6" class="empty">Gagal memuat rooms: ' + e.message + '</td></tr>';
  }
}

async function deactivateRoom(id) {
  if (!confirm('Nonaktifkan room ini? Room akan disembunyikan dari daftar.')) return;
  try {
    const res = await fetch('/api/admin/party/rooms/' + id, { method: 'DELETE', credentials: 'include' });
    if (res.ok) { toast('✓ Room dinonaktifkan'); await loadRooms(); }
    else { const d = await res.json(); toast(d.error || 'Gagal', 'error'); }
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/admin/party/stats', { credentials: 'include' });
    const data = await res.json();
    document.getElementById('s-rooms-active').textContent = data.rooms?.active ?? '—';
    document.getElementById('s-rooms-total').textContent  = data.rooms?.total  ?? '—';
    document.getElementById('s-gifts-active').textContent = data.gifts?.active ?? '—';
    document.getElementById('s-seats-occ').textContent    = data.seats?.occupied ?? '—';
  } catch(e) { }
}

// ── Income ────────────────────────────────────────────────────────────────────
function fmt(n) { return Number(n).toLocaleString('id-ID'); }

async function loadIncome() {
  try {
    const [dailyRes, roomsRes] = await Promise.all([
      fetch('/api/admin/party/income/daily', { credentials: 'include' }),
      fetch('/api/admin/party/income/rooms',  { credentials: 'include' }),
    ]);
    const dailyData = await dailyRes.json();
    const roomsData = await roomsRes.json();

    // Summary hari ini
    const today = dailyData.today ?? {};
    document.getElementById('inc-coin-today').textContent    = fmt(today.total_coin_today    ?? 0);
    document.getElementById('inc-diamond-today').textContent = fmt(today.total_diamond_today ?? 0);

    // Tabel harian
    const daily = dailyData.daily ?? [];
    const dtbody = document.getElementById('income-daily-tbody');
    if (!daily.length) {
      dtbody.innerHTML = '<tr><td colspan="5" class="empty">Belum ada data pendapatan.</td></tr>';
    } else {
      dtbody.innerHTML = daily.map(d => {
        const tgl = new Date(d.tgl).toLocaleDateString('id-ID', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
        return \`<tr>
          <td style="font-weight:700">\${tgl}</td>
          <td style="color:rgba(255,255,255,.6)">\${fmt(d.transaksi)}</td>
          <td style="color:rgba(255,255,255,.6)">\${fmt(d.jumlah_room)} room</td>
          <td style="color:#fbbf24;font-weight:700">🪙 \${fmt(d.total_coin)}</td>
          <td style="color:#60a5fa;font-weight:700">💎 \${fmt(d.total_diamond)}</td>
        </tr>\`;
      }).join('');
    }

    // Tabel per room
    const rooms = roomsData.rooms ?? [];
    const rtbody = document.getElementById('income-rooms-tbody');
    if (!rooms.length) {
      rtbody.innerHTML = '<tr><td colspan="7" class="empty">Belum ada data pendapatan per room.</td></tr>';
    } else {
      rtbody.innerHTML = rooms.map(r => {
        const status = r.is_active
          ? '<span class="dot-active"></span>Aktif'
          : '<span class="dot-inactive"></span>Nonaktif';
        const lastAct = r.last_activity
          ? new Date(r.last_activity).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
          : '—';
        return \`<tr>
          <td style="font-weight:700">\${r.room_name || r.room_id}</td>
          <td style="color:rgba(255,255,255,.6)">\${r.creator_username || '—'}</td>
          <td>\${status}</td>
          <td style="color:rgba(255,255,255,.6)">\${fmt(r.transaksi)}</td>
          <td style="color:#fbbf24;font-weight:700">🪙 \${fmt(r.total_coin)}</td>
          <td style="color:#60a5fa;font-weight:700">💎 \${fmt(r.total_diamond)}</td>
          <td style="color:rgba(255,255,255,.4);font-size:12px">\${lastAct}</td>
        </tr>\`;
      }).join('');
    }
  } catch(e) {
    document.getElementById('income-daily-tbody').innerHTML = '<tr><td colspan="5" class="empty">Gagal memuat: ' + e.message + '</td></tr>';
    document.getElementById('income-rooms-tbody').innerHTML = '<tr><td colspan="7" class="empty">Gagal memuat: ' + e.message + '</td></tr>';
  }
}

<!-- ══════════ TAB: LIVEKIT ══════════ -->
<div class="page" id="page-livekit">
  <div style="margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
    <div>
      <h2 style="font-size:18px;font-weight:800;color:#fff">🔀 LiveKit Provider Manager</h2>
      <p style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:4px">Switch antara LiveKit Cloud dan Self-hosted secara real-time tanpa restart Docker.</p>
    </div>
    <button class="btn btn-ghost btn-sm" onclick="loadLivekitStatus()">↻ Refresh</button>
  </div>

  <div class="stats-row" style="margin-bottom:24px">
    <div class="stat-card">
      <div class="stat-num" id="lk-mode" style="font-size:18px;color:#a78bfa">—</div>
      <div class="stat-label">Mode Setting</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" id="lk-active" style="font-size:18px">—</div>
      <div class="stat-label">Provider Aktif</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:24px">
    <div class="card" id="card-cloud">
      <h2>☁️ LiveKit Cloud</h2>
      <div id="lk-cloud-status" style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:12px">Memuat...</div>
      <div id="lk-cloud-url" style="font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:16px;word-break:break-all"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="btn-cloud" onclick="switchProvider('cloud')" disabled>Pakai Cloud</button>
        <button class="btn btn-ghost btn-sm" onclick="switchProvider('auto')">Auto</button>
      </div>
      <p style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:10px">Gratis 10.000 mnt/bln di <a href="https://cloud.livekit.io" target="_blank" style="color:#a78bfa">cloud.livekit.io</a></p>
    </div>
    <div class="card" id="card-self">
      <h2>🖥️ Self-Hosted (Docker AWS)</h2>
      <div id="lk-self-status" style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:12px">Memuat...</div>
      <div id="lk-self-url" style="font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:16px;word-break:break-all"></div>
      <button class="btn btn-success" id="btn-self" onclick="switchProvider('selfhosted')" disabled>Pakai Self-Hosted</button>
    </div>
  </div>

  <div class="card" style="border-color:rgba(124,58,237,0.3);background:rgba(124,58,237,0.08)">
    <h2 style="color:#c4b5fd">ℹ️ Cara Kerja</h2>
    <ul style="font-size:13px;color:rgba(255,255,255,0.6);line-height:1.9;padding-left:18px;margin-top:8px">
      <li><strong style="color:#a78bfa">auto</strong> — pakai Cloud jika credentials tersedia, otomatis fallback ke self-hosted</li>
      <li><strong style="color:#a78bfa">cloud</strong> — paksa Cloud (cocok saat self-hosted bermasalah)</li>
      <li><strong style="color:#a78bfa">selfhosted</strong> — paksa self-hosted Docker (saat menit Cloud habis)</li>
    </ul>
    <p style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:12px">
      ⚠️ Switch ini berlaku langsung di memori server. Setelah Docker restart, mode kembali ke nilai <code style="color:#a78bfa">LIVEKIT_MODE</code> di <code style="color:#a78bfa">.env</code>. Untuk perubahan permanen, edit <code style="color:#a78bfa">.env</code> di server AWS.
    </p>
  </div>
</div>

// ── Close modal on backdrop click ─────────────────────────────────────────────
document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', e => { if(e.target === el) el.classList.remove('open'); });
});

// ── LiveKit ───────────────────────────────────────────────────────────────────
async function loadLivekitStatus() {
  try {
    const res = await fetch('/api/admin/party/livekit-status', { credentials: 'include' });
    const d = await res.json();
    document.getElementById('lk-mode').textContent   = d.mode || '—';
    document.getElementById('lk-active').textContent = d.activeProvider === 'cloud' ? '☁️ Cloud' : '🖥️ Self-hosted';
    document.getElementById('lk-active').style.color = d.activeProvider === 'cloud' ? '#60a5fa' : '#34d399';

    const cloudOk = d.cloud?.configured;
    document.getElementById('lk-cloud-status').innerHTML = cloudOk
      ? '<span style="color:#34d399">✓ Credentials dikonfigurasi</span>'
      : '<span style="color:#f87171">✗ Belum diset di .env</span>';
    document.getElementById('lk-cloud-url').textContent = d.cloud?.url ? 'URL: ' + d.cloud.url : '';
    const btnCloud = document.getElementById('btn-cloud');
    btnCloud.disabled = !cloudOk || d.activeProvider === 'cloud';
    btnCloud.textContent = d.activeProvider === 'cloud' ? '✓ Sedang Aktif' : 'Pakai Cloud';
    document.getElementById('card-cloud').style.borderColor = d.activeProvider === 'cloud' ? 'rgba(96,165,250,0.5)' : '';

    const selfOk = d.self?.configured;
    document.getElementById('lk-self-status').innerHTML = selfOk
      ? '<span style="color:#34d399">✓ Credentials dikonfigurasi</span>'
      : '<span style="color:#f87171">✗ Belum diset di .env</span>';
    document.getElementById('lk-self-url').textContent = d.self?.url ? 'URL: ' + d.self.url : '';
    const btnSelf = document.getElementById('btn-self');
    btnSelf.disabled = !selfOk || d.activeProvider === 'selfhosted';
    btnSelf.textContent = d.activeProvider === 'selfhosted' ? '✓ Sedang Aktif' : 'Pakai Self-Hosted';
    document.getElementById('card-self').style.borderColor = d.activeProvider === 'selfhosted' ? 'rgba(52,211,153,0.5)' : '';
  } catch(e) {
    toast('Gagal memuat status LiveKit: ' + e.message, 'error');
  }
}

async function switchProvider(mode) {
  const label = { cloud: 'LiveKit Cloud', selfhosted: 'Self-Hosted', auto: 'Auto' }[mode] || mode;
  if (!confirm(\`Switch ke \${label}? Provider aktif akan berubah langsung.\`)) return;
  try {
    const res = await fetch('/api/admin/party/switch-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
      credentials: 'include',
    });
    const d = await res.json();
    if (res.ok) {
      toast(\`✓ Berhasil switch ke \${label}!\`);
      await loadLivekitStatus();
    } else {
      toast(d.error || 'Gagal switch provider', 'error');
    }
  } catch(e) {
    toast('Error: ' + e.message, 'error');
  }
}

// Init
loadGifts();
</script>
</body>
</html>`);
  });
}

import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";
import { CREDIT_TRANSACTION_TYPE } from "@shared/schema";
import { log } from "../../logger";

/**
 * Cleanup job: runs every hour.
 * - Resets is_equipped/is_active for expired user_frames
 * - Clears avatar_frame_url on user_profiles when the equipped frame expired
 * - Deletes expired rows older than 30 days to keep the table clean
 */
export async function runFrameExpiryCleanup(): Promise<void> {
  try {
    // 1. Clear avatar_frame_url for users whose equipped frame has expired
    const cleared = await db.execute(sql`
      UPDATE user_profiles up
      SET avatar_frame_url = NULL
      FROM user_frames uf
      WHERE uf.user_id = up.user_id
        AND uf.is_equipped = true
        AND uf.expires_at <= NOW()
    `);
    const clearedCount = (cleared as any).rowCount ?? 0;

    // 2. Mark expired frames as unequipped and inactive
    const reset = await db.execute(sql`
      UPDATE user_frames
      SET is_equipped = false, is_active = false
      WHERE expires_at <= NOW()
        AND (is_equipped = true OR is_active = true)
    `);
    const resetCount = (reset as any).rowCount ?? 0;

    // 3. Delete rows that expired more than 30 days ago
    const deleted = await db.execute(sql`
      DELETE FROM user_frames
      WHERE expires_at <= NOW() - INTERVAL '30 days'
    `);
    const deletedCount = (deleted as any).rowCount ?? 0;

    if (resetCount > 0 || clearedCount > 0 || deletedCount > 0) {
      log(
        `[frame-expiry] cleared=${clearedCount} profiles, reset=${resetCount} frames, deleted=${deletedCount} old rows`,
        "shop"
      );
    }
  } catch (err: any) {
    console.error("[frame-expiry] cleanup error:", err?.message ?? err);
  }
}

export function startFrameExpiryCleanup(): void {
  // Run immediately on startup then every hour
  runFrameExpiryCleanup();
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  setInterval(runFrameExpiryCleanup, INTERVAL_MS);
  log("Frame expiry cleanup job started (interval: 1h)", "shop");
}

export function registerShopFrameRoutes(app: Express): void {

  // ── GET /api/shop/frames ────────────────────────────────────────────────
  // List all active frames in the shop
  app.get("/api/shop/frames", async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT id, name, image_url, category, price_1d, price_7d, price_30d, sort_order
        FROM shop_frames
        WHERE is_active = true
        ORDER BY sort_order ASC, created_at ASC
      `);
      return res.json({ frames: result.rows });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/my-frames ─────────────────────────────────────────────
  // List frames purchased by the current user (non-expired)
  app.get("/api/shop/my-frames", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    try {
      const result = await db.execute(sql`
        SELECT uf.id, uf.frame_id, uf.expires_at, uf.is_equipped, uf.purchased_at,
               sf.name, sf.image_url, sf.category
        FROM user_frames uf
        JOIN shop_frames sf ON sf.id = uf.frame_id
        WHERE uf.user_id = ${userId}
          AND uf.expires_at > NOW()
        ORDER BY uf.is_equipped DESC, uf.purchased_at DESC
      `);
      return res.json({ frames: result.rows });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/active-frame ──────────────────────────────────────────
  // Get the currently equipped frame URL for the current user
  app.get("/api/shop/active-frame", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.json({ frameUrl: null });
    try {
      const result = await db.execute(sql`
        SELECT sf.image_url
        FROM user_frames uf
        JOIN shop_frames sf ON sf.id = uf.frame_id
        WHERE uf.user_id = ${userId}
          AND uf.is_equipped = true
          AND uf.expires_at > NOW()
        LIMIT 1
      `);
      const frameUrl = (result.rows[0] as any)?.image_url ?? null;
      return res.json({ frameUrl });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/active-frame/:username ────────────────────────────────
  // Get the equipped frame URL for any user (for profile/feed/seat display)
  app.get("/api/shop/active-frame/:username", async (req: Request, res: Response) => {
    const { username } = req.params;
    try {
      const result = await db.execute(sql`
        SELECT sf.image_url
        FROM user_frames uf
        JOIN shop_frames sf ON sf.id = uf.frame_id
        WHERE uf.username = ${username}
          AND uf.is_equipped = true
          AND uf.expires_at > NOW()
        LIMIT 1
      `);
      const frameUrl = (result.rows[0] as any)?.image_url ?? null;
      return res.json({ frameUrl });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/shop/frames/:id/purchase ─────────────────────────────────
  // Purchase a frame for 1, 7, or 30 days
  // Body: { duration: 1 | 7 | 30 }
  app.post("/api/shop/frames/:id/purchase", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const frameId = req.params.id;
    const duration = parseInt(req.body?.duration ?? "1", 10);
    if (![1, 7, 30].includes(duration)) {
      return res.status(400).json({ message: "Durasi tidak valid. Pilih 1, 7, atau 30 hari." });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(401).json({ message: "User tidak ditemukan" });

      // Get frame details
      const frameResult = await db.execute(sql`
        SELECT * FROM shop_frames WHERE id = ${frameId} AND is_active = true LIMIT 1
      `);
      if (!frameResult.rows.length) {
        return res.status(404).json({ message: "Frame tidak ditemukan" });
      }
      const frame = frameResult.rows[0] as any;

      // Determine price
      const priceMap: Record<number, bigint | number> = {
        1:  frame.price_1d,
        7:  frame.price_7d,
        30: frame.price_30d,
      };
      const price = Number(priceMap[duration]);

      // Check balance
      const balance = await storage.getCreditAccount(user.username);
      if (!balance || Number(balance.balance) < price) {
        return res.status(402).json({ message: "Saldo koin tidak cukup. Top up terlebih dahulu." });
      }

      // Deduct balance
      const updated = await storage.adjustBalance(user.username, -price);
      await storage.createCreditTransaction({
        username: user.username,
        type: CREDIT_TRANSACTION_TYPE.FRAME_PURCHASE,
        reference: `shop_frame:${frameId}-${Date.now()}`,
        description: `Beli frame: ${frame.name} (${duration} hari)`,
        currency: balance.currency,
        amount: -price,
        fundedAmount: 0,
        tax: 0,
        runningBalance: updated.balance,
      });

      // Unequip any currently equipped frame
      await db.execute(sql`
        UPDATE user_frames SET is_equipped = false, is_active = false
        WHERE user_id = ${userId}
      `);

      // Add/extend frame for user
      const expiresAt = new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString();
      await db.execute(sql`
        INSERT INTO user_frames (user_id, username, frame_id, frame_url, expires_at, is_equipped, is_active)
        VALUES (${userId}, ${user.username}, ${frameId}, ${frame.image_url}, ${expiresAt}, true, true)
      `);

      // Update user_profiles.avatar_frame_url so all existing avatar rendering picks it up
      await db.execute(sql`
        UPDATE user_profiles SET avatar_frame_url = ${frame.image_url}
        WHERE user_id = ${userId}
      `).catch(() => {});

      const newBalance = await storage.getCreditAccount(user.username);
      return res.json({
        success: true,
        message: `Frame "${frame.name}" aktif selama ${duration} hari!`,
        frameUrl: frame.image_url,
        newBalance: newBalance?.balance ?? 0,
        expiresAt,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/shop/frames/equip/:userFrameId ────────────────────────────
  // Equip a previously purchased frame
  app.post("/api/shop/frames/equip/:userFrameId", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { userFrameId } = req.params;
    try {
      // Verify ownership
      const check = await db.execute(sql`
        SELECT uf.id, sf.image_url FROM user_frames uf
        JOIN shop_frames sf ON sf.id = uf.frame_id
        WHERE uf.id = ${userFrameId} AND uf.user_id = ${userId} AND uf.expires_at > NOW()
        LIMIT 1
      `);
      if (!check.rows.length) {
        return res.status(404).json({ message: "Frame tidak ditemukan atau sudah kadaluarsa" });
      }
      const row = check.rows[0] as any;
      // Unequip all
      await db.execute(sql`UPDATE user_frames SET is_equipped = false, is_active = false WHERE user_id = ${userId}`);
      // Equip selected
      await db.execute(sql`UPDATE user_frames SET is_equipped = true, is_active = true WHERE id = ${userFrameId}`);
      // Sync to profile
      await db.execute(sql`
        UPDATE user_profiles SET avatar_frame_url = ${row.image_url} WHERE user_id = ${userId}
      `).catch(() => {});
      return res.json({ success: true, frameUrl: row.image_url });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/frames/:id/lottie ─────────────────────────────────────
  // Serve stored Lottie JSON for a frame (used by mobile LottieView)
  app.get("/api/shop/frames/:id/lottie", async (req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT lottie_json FROM shop_frames WHERE id = ${req.params.id} LIMIT 1
      `);
      const row = result.rows[0] as any;
      if (!row?.lottie_json) return res.status(404).json({ message: "Lottie JSON tidak ditemukan" });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(row.lottie_json);
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── DELETE /api/shop/frames/unequip ─────────────────────────────────────
  // Remove equipped frame
  app.delete("/api/shop/frames/unequip", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    try {
      await db.execute(sql`UPDATE user_frames SET is_equipped = false, is_active = false WHERE user_id = ${userId}`);
      await db.execute(sql`UPDATE user_profiles SET avatar_frame_url = NULL WHERE user_id = ${userId}`).catch(() => {});
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  ENTRY EFFECTS SHOP
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/shop/entry-effects ─────────────────────────────────────────
  app.get("/api/shop/entry-effects", async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT id, name, lottie_url, price_1d, price_7d, price_30d, sort_order
        FROM shop_entry_effects
        WHERE is_active = true
        ORDER BY sort_order ASC, created_at ASC
      `);
      return res.json({ effects: result.rows });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/my-entry-effects ──────────────────────────────────────
  app.get("/api/shop/my-entry-effects", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    try {
      const result = await db.execute(sql`
        SELECT ue.id, ue.effect_id, ue.expires_at, ue.is_equipped, ue.purchased_at,
               se.name, se.lottie_url
        FROM user_entry_effects ue
        JOIN shop_entry_effects se ON se.id = ue.effect_id
        WHERE ue.user_id = ${userId}
          AND ue.expires_at > NOW()
        ORDER BY ue.is_equipped DESC, ue.purchased_at DESC
      `);
      return res.json({ effects: result.rows });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/active-entry-effect ───────────────────────────────────
  app.get("/api/shop/active-entry-effect", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.json({ effectUrl: null });
    try {
      const result = await db.execute(sql`
        SELECT se.lottie_url
        FROM user_entry_effects ue
        JOIN shop_entry_effects se ON se.id = ue.effect_id
        WHERE ue.user_id = ${userId}
          AND ue.is_equipped = true
          AND ue.expires_at > NOW()
        LIMIT 1
      `);
      const effectUrl = (result.rows[0] as any)?.lottie_url ?? null;
      return res.json({ effectUrl });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/active-entry-effect/:username ──────────────────────────
  app.get("/api/shop/active-entry-effect/:username", async (req: Request, res: Response) => {
    const { username } = req.params;
    try {
      const result = await db.execute(sql`
        SELECT se.lottie_url
        FROM user_entry_effects ue
        JOIN shop_entry_effects se ON se.id = ue.effect_id
        WHERE ue.username = ${username}
          AND ue.is_equipped = true
          AND ue.expires_at > NOW()
        LIMIT 1
      `);
      const effectUrl = (result.rows[0] as any)?.lottie_url ?? null;
      return res.json({ effectUrl });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/shop/entry-effects/:id/purchase ────────────────────────────
  app.post("/api/shop/entry-effects/:id/purchase", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const effectId = req.params.id;
    const duration = parseInt(req.body?.duration ?? "1", 10);
    if (![1, 7, 30].includes(duration)) {
      return res.status(400).json({ message: "Durasi tidak valid. Pilih 1, 7, atau 30 hari." });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(401).json({ message: "User tidak ditemukan" });

      const effectResult = await db.execute(sql`
        SELECT * FROM shop_entry_effects WHERE id = ${effectId} AND is_active = true LIMIT 1
      `);
      if (!effectResult.rows.length) {
        return res.status(404).json({ message: "Efek masuk tidak ditemukan" });
      }
      const effect = effectResult.rows[0] as any;

      const priceMap: Record<number, bigint | number> = {
        1:  effect.price_1d,
        7:  effect.price_7d,
        30: effect.price_30d,
      };
      const price = Number(priceMap[duration]);

      const balance = await storage.getCreditAccount(user.username);
      if (!balance || Number(balance.balance) < price) {
        return res.status(402).json({ message: "Saldo koin tidak cukup. Top up terlebih dahulu." });
      }

      const updated = await storage.adjustBalance(user.username, -price);
      await storage.createCreditTransaction({
        username: user.username,
        type: CREDIT_TRANSACTION_TYPE.FRAME_PURCHASE,
        reference: `entry_effect:${effectId}-${Date.now()}`,
        description: `Beli efek masuk: ${effect.name} (${duration} hari)`,
        currency: balance.currency,
        amount: -price,
        fundedAmount: 0,
        tax: 0,
        runningBalance: updated.balance,
      });

      // Unequip any currently equipped entry effect
      await db.execute(sql`
        UPDATE user_entry_effects SET is_equipped = false, is_active = false
        WHERE user_id = ${userId}
      `);

      const expiresAt = new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString();
      await db.execute(sql`
        INSERT INTO user_entry_effects (user_id, username, effect_id, expires_at, is_equipped, is_active)
        VALUES (${userId}, ${user.username}, ${effectId}, ${expiresAt}, true, true)
      `);

      const newBalance = await storage.getCreditAccount(user.username);
      return res.json({
        success: true,
        message: `Efek masuk "${effect.name}" aktif selama ${duration} hari!`,
        effectUrl: effect.lottie_url,
        newBalance: newBalance?.balance ?? 0,
        expiresAt,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/shop/entry-effects/equip/:userEffectId ────────────────────
  app.post("/api/shop/entry-effects/equip/:userEffectId", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { userEffectId } = req.params;
    try {
      const check = await db.execute(sql`
        SELECT ue.id, se.lottie_url FROM user_entry_effects ue
        JOIN shop_entry_effects se ON se.id = ue.effect_id
        WHERE ue.id = ${userEffectId} AND ue.user_id = ${userId} AND ue.expires_at > NOW()
        LIMIT 1
      `);
      if (!check.rows.length) {
        return res.status(404).json({ message: "Efek tidak ditemukan atau sudah kadaluarsa" });
      }
      await db.execute(sql`UPDATE user_entry_effects SET is_equipped = false, is_active = false WHERE user_id = ${userId}`);
      await db.execute(sql`UPDATE user_entry_effects SET is_equipped = true, is_active = true WHERE id = ${userEffectId}`);
      const row = check.rows[0] as any;
      return res.json({ success: true, effectUrl: row.lottie_url });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── DELETE /api/shop/entry-effects/unequip ──────────────────────────────
  app.delete("/api/shop/entry-effects/unequip", async (req: Request, res: Response) => {
    const userId: string | undefined = (req as any).session?.userId ?? (req as any).jwtUserId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    try {
      await db.execute(sql`UPDATE user_entry_effects SET is_equipped = false, is_active = false WHERE user_id = ${userId}`);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/shop/entry-effects/:id/lottie ──────────────────────────────
  app.get("/api/shop/entry-effects/:id/lottie", async (req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT lottie_json FROM shop_entry_effects WHERE id = ${req.params.id} LIMIT 1
      `);
      const row = result.rows[0] as any;
      if (!row?.lottie_json) return res.status(404).json({ message: "Lottie JSON tidak ditemukan" });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(row.lottie_json);
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });
}

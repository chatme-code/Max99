import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { RATES, diamondToIdr, formatDiamond } from "../../config/currency";
import { broadcastToUser, broadcastToUsername } from "../../gateway";

function requireAuth(req: Request, res: Response): string | null {
  const userId: string | undefined = (req as any).session?.userId;
  if (!userId) { res.status(401).json({ message: "Login dulu." }); return null; }
  return userId;
}

export function registerDiamondRoutes(app: Express): void {

  // ── GET /api/diamonds/balance ─ balance milik sendiri ────────────────────
  app.get("/api/diamonds/balance", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });
      const balance = await storage.getDiamondBalance(user.username);

      // Total earned dari gift saja (sumber kebenaran = diamond_transactions)
      // Angka ini sama dengan yang ditampilkan di Leaderboard (ALL_TIME), Agency Dashboard, dan Admin Panel.
      const totalEarned = await storage.getDiamondTotalEarned(user.username);

      // Total yang sudah dicairkan (WITHDRAW_REQUEST) — dari transaksi nyata, bukan formula
      const totalWithdrawn = await storage.getDiamondTotalWithdrawn(user.username);

      return res.json({
        balance,
        totalEarned,
        totalWithdrawn,
        formatted: formatDiamond(balance),
        totalEarnedFormatted: formatDiamond(totalEarned),
        totalWithdrawnFormatted: formatDiamond(totalWithdrawn),
        withdrawableIdr: balance >= RATES.MIN_WD_DIAMOND ? diamondToIdr(balance) : 0,
        minWithdrawDiamond: RATES.MIN_WD_DIAMOND,
        ratePerDiamond: RATES.DIAMOND_TO_IDR,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/diamonds/balance/:username ─ admin / public lookup ───────────
  app.get("/api/diamonds/balance/:username", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
      const caller = await storage.getUser(userId);
      if (!caller) return res.status(401).json({ message: "User tidak ditemukan." });
      const target = req.params.username.toLowerCase();
      if (caller.username.toLowerCase() !== target && !caller.isAdmin) {
        return res.status(403).json({ message: "Akses ditolak." });
      }
      const balance = await storage.getDiamondBalance(target);
      return res.json({ username: target, balance, formatted: formatDiamond(balance) });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/diamonds/history ─ riwayat transaksi sendiri ─────────────────
  app.get("/api/diamonds/history", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });
      const limit  = Math.min(100, Math.max(1, Number(req.query.limit)  || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const transactions = await storage.getDiamondTransactions(user.username, limit, offset);
      return res.json({ transactions });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/diamonds/rates ─ info rate publik ────────────────────────────
  app.get("/api/diamonds/rates", (_req: Request, res: Response) => {
    res.json({
      idrToCoin:     RATES.IDR_TO_COIN,
      coinToDiamond: RATES.COIN_TO_DIAMOND,
      diamondToIdr:  RATES.DIAMOND_TO_IDR,
      minWithdrawDiamond: RATES.MIN_WD_DIAMOND,
      minWithdrawIdr: diamondToIdr(RATES.MIN_WD_DIAMOND),
      example: {
        buy100kIdr_getCoins:    Math.floor(100000 * RATES.IDR_TO_COIN),
        gift150kCoin_getDiamond: Math.floor(150000 / RATES.COIN_TO_DIAMOND),
        wd15kDiamond_getIdr:    diamondToIdr(15000),
      },
    });
  });

  // ── POST /api/diamonds/withdraw ─ request penarikan (simpan ke DB) ────────
  app.post("/api/diamonds/withdraw", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const schema = z.object({
      amount:       z.number().int().min(RATES.MIN_WD_DIAMOND,
        `Minimum withdraw ${RATES.MIN_WD_DIAMOND.toLocaleString('id-ID')} Diamond`),
      method:       z.enum(["bank", "ewallet", "usdt_trc20"]).default("bank"),
      bankName:     z.string().min(1).max(100),
      accountNumber: z.string().min(1).max(50),
      accountName:  z.string().min(1).max(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Data tidak valid." });
    }

    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });

      const { amount, method, bankName, accountNumber, accountName } = parsed.data;
      const currentBalance = await storage.getDiamondBalance(user.username);

      if (currentBalance < amount) {
        return res.status(400).json({
          message: `Saldo Diamond tidak cukup. Saldo kamu: ${formatDiamond(currentBalance)}`,
        });
      }

      const idrValue = diamondToIdr(amount);
      const refId = `WD-${Date.now()}-${user.username.toUpperCase()}`;

      const newBalance = await storage.adjustDiamondBalance(
        user.username,
        -amount,
        "WITHDRAW_REQUEST",
        `Withdraw ${amount.toLocaleString('id-ID')} 💎 → Rp ${idrValue.toLocaleString('id-ID')} ke ${bankName} ${accountNumber} a/n ${accountName}`,
        refId,
      );

      // Cari agent_name dari agency_hosts (host) atau agencies (owner)
      let agentName: string | null = null;
      try {
        const { db: dbConn } = await import("../../db");
        const { sql: sqlFn } = await import("drizzle-orm");
        // Cek sebagai host
        const agRow = await dbConn.execute(sqlFn`
          SELECT a.agency_name
          FROM agency_hosts ah
          JOIN agencies a ON a.id = ah.agency_id
          WHERE LOWER(ah.username) = LOWER(${user.username})
            AND ah.status = 'active'
          LIMIT 1
        `);
        if (agRow.rows.length > 0) {
          agentName = (agRow.rows[0] as any).agency_name as string;
        } else {
          // Cek sebagai owner agency
          const ownerRow = await dbConn.execute(sqlFn`
            SELECT agency_name FROM agencies
            WHERE LOWER(registered_by) = LOWER(${user.username})
              AND status = 'approved'
            ORDER BY registered_at DESC
            LIMIT 1
          `);
          if (ownerRow.rows.length > 0) {
            agentName = (ownerRow.rows[0] as any).agency_name as string;
          }
        }
        // Simpan ke withdraw_requests table
        await dbConn.execute(sqlFn`
          INSERT INTO withdraw_requests
            (ref_id, username, agent_name, amount, idr_value, method, bank_name, account_number, account_name, status)
          VALUES
            (${refId}, ${user.username}, ${agentName}, ${amount}, ${idrValue},
             ${method}, ${bankName}, ${accountNumber}, ${accountName}, 'pending')
        `);
      } catch (dbErr: any) {
        // Non-fatal — log saja, withdraw tetap berhasil
        console.error("[withdraw] Failed to insert withdraw_requests:", dbErr?.message);
      }

      broadcastToUser(user.username, {
        type: "DIAMOND_WITHDRAW_REQUESTED",
        refId,
        amount,
        idrValue,
        newBalance,
        bankName,
        accountNumber,
        accountName,
      });

      return res.json({
        success: true,
        refId,
        message: `Permintaan withdraw ${formatDiamond(amount)} = Rp ${idrValue.toLocaleString('id-ID')} sedang diproses.`,
        newBalance,
        estimatedIdr: idrValue,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/diamonds/withdraw-requests ─ daftar request milik sendiri ───────
  app.get("/api/diamonds/withdraw-requests", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });

      const { db: dbConn } = await import("../../db");
      const { sql: sqlFn } = await import("drizzle-orm");
      const limit  = Math.min(parseInt(String(req.query.limit  ?? "20")), 50);
      const offset = parseInt(String(req.query.offset ?? "0"));

      const rows = await dbConn.execute(sqlFn`
        SELECT id, ref_id, amount, idr_value, bank_name, account_number, account_name,
               status, notes, created_at, processed_at
        FROM withdraw_requests
        WHERE LOWER(username) = LOWER(${user.username})
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      return res.json({ requests: rows.rows });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/diamonds/withdraw-requests/:refId/cancel ─ batalkan withdraw ──
  app.post("/api/diamonds/withdraw-requests/:refId/cancel", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });

      const { db: dbConn } = await import("../../db");
      const { sql: sqlFn } = await import("drizzle-orm");

      const existing = await dbConn.execute(sqlFn`
        SELECT * FROM withdraw_requests
        WHERE ref_id = ${req.params.refId}
          AND LOWER(username) = LOWER(${user.username})
        LIMIT 1
      `);
      if (!existing.rows.length) {
        return res.status(404).json({ message: "Request tidak ditemukan." });
      }
      const wr = existing.rows[0] as any;
      if (wr.status !== "pending") {
        return res.status(400).json({
          message: `Request sudah ${wr.status}, tidak bisa dibatalkan.`,
        });
      }

      // Kembalikan diamond
      const refundRef = `WD-CANCEL-${wr.ref_id}`;
      const newBalance = await storage.adjustDiamondBalance(
        user.username,
        Number(wr.amount),
        "WITHDRAW_REFUND",
        `Pembatalan withdraw ${wr.ref_id} (dibatalkan user)`,
        refundRef,
      );

      // Tandai cancelled
      await dbConn.execute(sqlFn`
        UPDATE withdraw_requests
        SET status = 'cancelled', processed_at = NOW(), processed_by = ${user.username}
        WHERE ref_id = ${req.params.refId}
      `);

      return res.json({
        success: true,
        refId: wr.ref_id,
        diamondRefunded: Number(wr.amount),
        newBalance,
        message: `Withdraw ${wr.ref_id} berhasil dibatalkan. 💎 ${Number(wr.amount).toLocaleString('id-ID')} dikembalikan ke saldo kamu.`,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/diamonds/ws-notify ─ admin panel trigger WS notification ──────
  // Called by admin panel after approve/reject withdraw — broadcasts real-time event
  app.post("/api/diamonds/ws-notify", async (req: Request, res: Response) => {
    const { username, status, refId, amount, idrValue, bankName, accountNumber, accountName, notes } = req.body;
    if (!username || !status || !refId) {
      return res.status(400).json({ message: "username, status, refId wajib diisi." });
    }
    try {
      broadcastToUsername(username, {
        type: "DIAMOND_WITHDRAW_STATUS",
        status,
        refId,
        amount: Number(amount) || 0,
        idrValue: Number(idrValue) || 0,
        bankName,
        accountNumber,
        accountName,
        notes: notes ?? null,
      });
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/diamonds/saved-accounts ─ daftar rekening tersimpan ────────────
  app.get("/api/diamonds/saved-accounts", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });
      const { db: dbConn } = await import("../../db");
      const { sql: sqlFn } = await import("drizzle-orm");
      const rows = await dbConn.execute(sqlFn`
        SELECT id, method, label, bank_name, account_number, account_name, created_at
        FROM user_saved_accounts
        WHERE LOWER(username) = LOWER(${user.username})
        ORDER BY created_at DESC
        LIMIT 10
      `);
      return res.json({ accounts: rows.rows });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/diamonds/saved-accounts ─ simpan rekening baru ─────────────
  app.post("/api/diamonds/saved-accounts", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const schema = z.object({
      method:         z.enum(["bank", "ewallet", "usdt_trc20"]),
      label:          z.string().min(1).max(60),
      bank_name:      z.string().min(1).max(100),
      account_number: z.string().min(1).max(100),
      account_name:   z.string().min(1).max(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Data tidak valid." });
    }
    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });
      const { db: dbConn } = await import("../../db");
      const { sql: sqlFn } = await import("drizzle-orm");
      // Batasi maks 10 rekening per user
      const countRow = await dbConn.execute(sqlFn`
        SELECT COUNT(*) as cnt FROM user_saved_accounts WHERE LOWER(username) = LOWER(${user.username})
      `);
      const cnt = Number((countRow.rows[0] as any)?.cnt ?? 0);
      if (cnt >= 10) {
        return res.status(400).json({ message: "Maksimum 10 rekening tersimpan. Hapus rekening lama terlebih dahulu." });
      }
      const { method, label, bank_name, account_number, account_name } = parsed.data;
      const inserted = await dbConn.execute(sqlFn`
        INSERT INTO user_saved_accounts (username, method, label, bank_name, account_number, account_name)
        VALUES (${user.username}, ${method}, ${label}, ${bank_name}, ${account_number}, ${account_name})
        RETURNING id, method, label, bank_name, account_number, account_name, created_at
      `);
      return res.json({ success: true, account: inserted.rows[0] });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── DELETE /api/diamonds/saved-accounts/:id ─ hapus rekening ─────────────
  app.delete("/api/diamonds/saved-accounts/:id", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User tidak ditemukan." });
      const { db: dbConn } = await import("../../db");
      const { sql: sqlFn } = await import("drizzle-orm");
      await dbConn.execute(sqlFn`
        DELETE FROM user_saved_accounts
        WHERE id = ${Number(req.params.id)} AND LOWER(username) = LOWER(${user.username})
      `);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/admin/diamonds/adjust ─ admin manual credit/debit ───────────
  app.post("/api/admin/diamonds/adjust", async (req: Request, res: Response) => {
    const userId = requireAuth(req, res);
    if (!userId) return;

    try {
      const caller = await storage.getUser(userId);
      if (!caller?.isAdmin) return res.status(403).json({ message: "Admin only." });

      const schema = z.object({
        username:    z.string().min(1),
        amount:      z.number().int(),
        description: z.string().min(1).max(255),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message });

      const { username, amount, description } = parsed.data;
      const newBalance = await storage.adjustDiamondBalance(
        username,
        amount,
        amount >= 0 ? "ADMIN_CREDIT" : "ADMIN_DEBIT",
        description,
        `ADM-${Date.now()}`,
      );

      return res.json({ success: true, username, amount, newBalance });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });
}

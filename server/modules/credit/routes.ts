import type { Express } from "express";
import { requireVerified } from "../../middleware/accessControl";
import { z } from "zod";
import { storage } from "../../storage";
import { insertRewardProgramSchema, insertVoucherBatchSchema, CREDIT_TRANSACTION_TYPE, VOUCHER_STATUS, NOTIFICATION_TYPE, NOTIFICATION_STATUS } from "@shared/schema";
import { formatCreditBalance, hashPassword, verifyPassword } from "../auth/routes";
import { broadcastToUser } from "../../gateway";

// ── PIN brute-force in-process store ─────────────────────────────────────────
// Tracks failed PIN attempts per userId. Resets on successful transfer.
// Map<userId, { count: number; firstAt: number }>
const _pinFailStore = new Map<string, { count: number; firstAt: number }>();

export function registerCreditRoutes(app: Express) {

  // ── POST /api/credits/pin ──────────────────────────────────────────────────
  // Create or update the transfer PIN for the authenticated user
  // Body: { pin: string } — must be exactly 6 numeric digits
  app.post("/api/credits/pin", async (req, res) => {
    const userId: string | undefined = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Invalid session. Please log in again." });

    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ message: "User not found." });

    const schema = z.object({ pin: z.string().regex(/^\d{6}$/, "PIN must be exactly 6 digits.") });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid PIN." });

    try {
      const hashedPin = await hashPassword(parsed.data.pin);
      await storage.setTransferPin(user.username, hashedPin);
      res.json({ success: true, message: "Transfer PIN created successfully." });
    } catch (e: any) {
      res.status(500).json({ message: "Gagal menyimpan PIN. Coba lagi." });
    }
  });

  // ── POST /api/credits/pin/verify ──────────────────────────────────────────
  // Verify a transfer PIN before performing a transfer
  // Body: { pin: string }
  app.post("/api/credits/pin/verify", async (req, res) => {
    const userId: string | undefined = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Invalid session." });

    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ message: "User not found." });

    const schema = z.object({ pin: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "PIN diperlukan." });

    try {
      const storedHash = await storage.getTransferPin(user.username);
      if (!storedHash) return res.status(404).json({ message: "PIN not created. Please create a PIN in settings first." });
      const valid = await verifyPassword(parsed.data.pin, storedHash);
      if (!valid) return res.status(403).json({ message: "Wrong PIN." });
      res.json({ success: true, message: "PIN valid." });
    } catch (e: any) {
      res.status(500).json({ message: "Gagal memverifikasi PIN." });
    }
  });

  // ── GET /api/credit/balance/me ───────────────────────────────────────────
  // Get credit balance for the logged-in session user
  app.get("/api/credit/balance/me", async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
      const acct = await storage.getCreditAccount(user.username);
      return res.json({
        username: acct.username,
        currency: acct.currency,
        balance: acct.balance,
        fundedBalance: acct.fundedBalance,
        formatted: formatCreditBalance(acct.balance, acct.currency),
        updatedAt: acct.updatedAt,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/balance ──────────────────────────────────────────────
  // Get credit balance for a user
  // Query: ?username=xxx  (if omitted uses session, for demo requires ?username=)
  app.get("/api/credit/balance/:username", async (req, res) => {
    try {
      const { username } = req.params;
      const acct = await storage.getCreditAccount(username);
      res.json({
        username: acct.username,
        currency: acct.currency,
        balance: acct.balance,
        fundedBalance: acct.fundedBalance,
        formatted: formatCreditBalance(acct.balance, acct.currency),
        updatedAt: acct.updatedAt,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/balance ──────────────────────────────────────────────
  // Shorthand with ?username= query param
  app.get("/api/credit/balance", async (req, res) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: "username query param required" });
    try {
      const acct = await storage.getCreditAccount(username);
      res.json({
        username: acct.username,
        currency: acct.currency,
        balance: acct.balance,
        fundedBalance: acct.fundedBalance,
        formatted: formatCreditBalance(acct.balance, acct.currency),
        updatedAt: acct.updatedAt,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/credit/transfer ─────────────────────────────────────────────
  // Transfer MIG credits from session user to another user.
  // Body: { toUsername, amount, pin }
  // - fromUsername is ALWAYS derived from the session — never trusted from the body.
  // - AccessControl: TRANSFER_CREDIT_OUT (emailVerified required)
  // - Merchant gate: only merchantType 1/2/3 may transfer
  // - PIN gate: user must have a transfer PIN; wrong PIN increments a brute-force counter
  // - Rate limit: max 5 wrong-PIN attempts per 15 min window before a hard lock
  app.post("/api/credit/transfer", requireVerified("TRANSFER_CREDIT_OUT"), async (req, res) => {
    // ── 1. Session identity — fromUsername is NEVER taken from the body ───────
    const userId: string | undefined = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Invalid session. Please log in again." });
    const sessionUser = await storage.getUser(userId);
    if (!sessionUser) return res.status(401).json({ error: "User not found." });

    // fromUsername is always the authenticated session user — body value is ignored
    const fromUsername = sessionUser.username;

    // ── 2. Validate body (toUsername, amount, pin only) ───────────────────────
    const schema = z.object({
      toUsername: z.string().min(1),
      amount: z.number().positive("Amount must be positive"),
      pin: z.string().regex(/^\d{6}$/, "PIN must be exactly 6 digits."),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { toUsername, amount, pin } = parsed.data;

    // ── 3. Cannot transfer to yourself ────────────────────────────────────────
    if (fromUsername.toLowerCase() === toUsername.toLowerCase()) {
      return res.status(400).json({ error: "Cannot transfer to yourself." });
    }

    // ── 4. Verify recipient exists ────────────────────────────────────────────
    const recipientUser = await storage.getUserByUsername(toUsername);
    if (!recipientUser) {
      return res.status(404).json({ error: "Recipient user not found." });
    }

    // ── 5. Minimum transfer amount ────────────────────────────────────────────
    const MIN_TRANSFER_AMOUNT_IDR = 1000;
    if (amount < MIN_TRANSFER_AMOUNT_IDR) {
      return res.status(400).json({
        error: `Minimum transfer amount is ${MIN_TRANSFER_AMOUNT_IDR.toLocaleString('en-US')} Coin.`,
        minimumAmount: MIN_TRANSFER_AMOUNT_IDR,
      });
    }

    // ── 6. Merchant gate — only merchantType 1/2/3 may transfer ──────────────
    const merchantRecord = await storage.getMerchantByUsername(fromUsername);
    const merchantType = merchantRecord?.merchantType ?? null;
    const ALLOWED_MERCHANT_TYPES = [1, 2, 3];
    if (!merchantType || !ALLOWED_MERCHANT_TYPES.includes(merchantType)) {
      return res.status(403).json({
        error: 'Creditite transfer applies to merchants',
        requiredRole: 'merchant',
      });
    }

    // ── 7. PIN brute-force rate limit (max 5 wrong attempts per 15 min) ───────
    const PIN_MAX_ATTEMPTS = 5;
    const PIN_WINDOW_MS    = 15 * 60 * 1000; // 15 minutes
    const pinAttemptKey    = `pin_fail:${userId}`;

    // In-process store (survives restarts only within the same process; good enough
    // for Replit single-instance deployment; swap for Redis if multi-instance).
    const now = Date.now();
    const existing = _pinFailStore.get(pinAttemptKey);
    if (existing && now - existing.firstAt < PIN_WINDOW_MS) {
      if (existing.count >= PIN_MAX_ATTEMPTS) {
        const retryAfterSec = Math.ceil((existing.firstAt + PIN_WINDOW_MS - now) / 1000);
        return res.status(429).json({
          error: `Too many wrong PIN attempts. Try again in ${retryAfterSec} seconds.`,
          retryAfterSeconds: retryAfterSec,
        });
      }
    }

    // ── 8. PIN gate ───────────────────────────────────────────────────────────
    const storedPin = await storage.getTransferPin(fromUsername);
    if (!storedPin) {
      return res.status(403).json({
        error: "Transfer PIN not created. Please create a PIN first in account settings.",
        requiresPin: true,
      });
    }
    const pinValid = await verifyPassword(pin, storedPin);
    if (!pinValid) {
      // Increment brute-force counter
      if (existing && now - existing.firstAt < PIN_WINDOW_MS) {
        existing.count += 1;
        _pinFailStore.set(pinAttemptKey, existing);
      } else {
        _pinFailStore.set(pinAttemptKey, { count: 1, firstAt: now });
      }
      const attemptsLeft = PIN_MAX_ATTEMPTS - (_pinFailStore.get(pinAttemptKey)?.count ?? 1);
      return res.status(403).json({
        error: `Wrong PIN. ${attemptsLeft > 0 ? `${attemptsLeft} attempt(s) left.` : 'Account locked for 15 minutes.'}`,
      });
    }

    // Clear brute-force counter on successful PIN
    _pinFailStore.delete(pinAttemptKey);

    // ── 9. Execute transfer ───────────────────────────────────────────────────
    try {
      const result = await storage.transferCredit(fromUsername, toUsername, amount);
      const netReceived = Math.round((amount - result.fee) * 100) / 100;

      storage.createNotification({
        username: toUsername,
        type: NOTIFICATION_TYPE.ALERT,
        subject: "Received Credit",
        message: `You received ${formatCreditBalance(netReceived, result.to.currency)} credit from ${fromUsername}`,
        status: NOTIFICATION_STATUS.PENDING,
      }).catch(() => {});

      // Real-time push to recipient
      broadcastToUser(recipientUser.id, {
        type: "CREDIT_RECEIVED",
        fromUsername,
        amount: netReceived,
        currency: result.to.currency,
        newBalance: result.to.balance,
      } as any);

      res.json({
        success: true,
        fromUsername,
        toUsername,
        transferAmount: amount,
        fee: result.fee,
        netReceived,
        fromBalance: result.from.balance,
        toBalance: result.to.balance,
        currency: result.from.currency,
      });
    } catch (e: any) {
      const status = e.message === "Insufficient balance" ? 402 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── GET /api/credit/transactions ──────────────────────────────────────────
  // Get transaction history for a user
  // Query: ?username=xxx&limit=50
  app.get("/api/credit/transactions", async (req, res) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: "username query param required" });
    const limit = parseInt(req.query.limit as string) || 50;
    try {
      const txns = await storage.getCreditTransactions(username, limit);
      const txTypeNames: Record<number, string> = {
        [CREDIT_TRANSACTION_TYPE.CREDIT_CARD]: "Credit Card",
        [CREDIT_TRANSACTION_TYPE.VOUCHER_RECHARGE]: "Voucher Recharge",
        [CREDIT_TRANSACTION_TYPE.BONUS_CREDIT]: "Bonus Credit",
        [CREDIT_TRANSACTION_TYPE.REFERRAL_CREDIT]: "Referral Credit",
        [CREDIT_TRANSACTION_TYPE.ACTIVATION_CREDIT]: "Activation Credit",
        [CREDIT_TRANSACTION_TYPE.USER_TO_USER_TRANSFER]: "User Transfer",
        [CREDIT_TRANSACTION_TYPE.TRANSFER_CREDIT_FEE]: "Transfer Fee",
        [CREDIT_TRANSACTION_TYPE.MARKETING_REWARD]: "Marketing Reward",
        [CREDIT_TRANSACTION_TYPE.GAME_BET]: "Game Bet",
        [CREDIT_TRANSACTION_TYPE.GAME_REWARD]: "Game Win",
        [CREDIT_TRANSACTION_TYPE.GAME_REFUND]: "Game Refund",
        [CREDIT_TRANSACTION_TYPE.REFUND]: "Refund",
        [CREDIT_TRANSACTION_TYPE.CREDIT_EXPIRED]: "Credit Expired",
        [CREDIT_TRANSACTION_TYPE.CREDIT_WRITE_OFF]: "Credit Write-off",
        [CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE]: "Virtual Gift Purchase",
        [CREDIT_TRANSACTION_TYPE.FRAME_PURCHASE]: "Frame Avatar",
        [CREDIT_TRANSACTION_TYPE.PRODUCT_PURCHASE]: "Product Purchase",
        [CREDIT_TRANSACTION_TYPE.BANK_TRANSFER]: "Bank Transfer",
      };
      res.json({
        username,
        count: txns.length,
        transactions: txns.map((t) => {
          // Override typeName based on description for more readable history labels
          const desc = (t.description ?? '').toLowerCase();
          let typeName: string;
          if (desc.includes('lucky bag')) {
            typeName = 'Lucky Bag';
          } else {
            typeName = txTypeNames[t.type] ?? `Type ${t.type}`;
          }
          return { ...t, typeName };
        }),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/transactions/:id ─────────────────────────────────────
  app.get("/api/credit/transactions/:id", async (req, res) => {
    const tx = await storage.getCreditTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    res.json(tx);
  });

  // ── POST /api/credit/transactions/reverse ────────────────────────────────
  // Reverse (refund) a transaction — creates a reversal entry (admin only)
  app.post("/api/credit/transactions/reverse", async (req, res) => {
    const callerId: string | undefined = req.session?.userId;
    if (!callerId) return res.status(401).json({ error: "Invalid session. Please log in again." });
    const isAdmin = await storage.isGlobalAdmin(callerId);
    if (!isAdmin) return res.status(403).json({ error: "Only admins can perform this operation." });
    const schema = z.object({
      transactionId: z.string().min(1),
      misUsername: z.string().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const tx = await storage.getCreditTransaction(parsed.data.transactionId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    try {
      await storage.adjustBalance(tx.username, -tx.amount, tx.currency);
      const acct = await storage.getCreditAccount(tx.username);
      const reversal = await storage.createCreditTransaction({
        username: tx.username,
        type: CREDIT_TRANSACTION_TYPE.REFUND,
        reference: tx.id,
        description: `Reversal of ${tx.description ?? tx.id}`,
        currency: tx.currency,
        amount: -tx.amount,
        fundedAmount: 0,
        tax: 0,
        runningBalance: acct.balance,
      });
      res.json({ success: true, reversal });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/vouchers/batches ─────────────────────────────────────
  // List all voucher batches (optionally filter by creator)
  app.get("/api/credit/vouchers/batches", async (req, res) => {
    const username = req.query.username as string | undefined;
    const batches = await storage.getVoucherBatches(username);
    res.json({ count: batches.length, batches });
  });

  // ── GET /api/credit/vouchers/batches/:id ─────────────────────────────────
  app.get("/api/credit/vouchers/batches/:id", async (req, res) => {
    const batch = await storage.getVoucherBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: "Voucher batch not found" });
    const vouchers = await storage.getVouchers(batch.id);
    res.json({ batch, vouchers });
  });

  // ── POST /api/credit/vouchers/batch ──────────────────────────────────────
  // Create a new voucher batch (admin — requires creator username)
  app.post("/api/credit/vouchers/batch", async (req, res) => {
    const schema = insertVoucherBatchSchema.extend({
      createdByUsername: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const result = await storage.createVoucherBatch(parsed.data);
      res.status(201).json({
        success: true,
        batch: result.batch,
        vouchers: result.vouchers,
        totalCreated: result.vouchers.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/credit/vouchers/redeem ─────────────────────────────────────
  // Redeem a voucher code
  app.post("/api/credit/vouchers/redeem", async (req, res) => {
    const schema = z.object({
      code: z.string().min(1),
      username: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const voucher = await storage.redeemVoucher(parsed.data.code, parsed.data.username);
      const acct = await storage.getCreditAccount(parsed.data.username);
      res.json({
        success: true,
        voucher,
        rewardedAmount: voucher.amount,
        currency: voucher.currency,
        newBalance: acct.balance,
        formatted: `${acct.balance.toFixed(2)} ${acct.currency}`,
      });
    } catch (e: any) {
      const status = e.message === "Voucher not found" ? 404 : 400;
      res.status(status).json({ error: e.message });
    }
  });

  // ── POST /api/credit/vouchers/:id/cancel ─────────────────────────────────
  app.post("/api/credit/vouchers/:id/cancel", async (req, res) => {
    const voucher = await storage.cancelVoucher(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found or not active" });
    res.json({ success: true, voucher });
  });

  // ── GET /api/credit/rewards ───────────────────────────────────────────────
  // List active reward programs
  app.get("/api/credit/rewards", async (_req, res) => {
    const programs = await storage.getRewardPrograms();
    const categoryNames: Record<number, string> = {
      1: "Referral", 2: "Activity", 3: "Purchase", 4: "Engagement", 5: "First Time",
    };
    const typeNames: Record<number, string> = {
      1: "Quantity Based", 2: "Amount Based", 3: "One Time",
    };
    res.json({
      count: programs.length,
      programs: programs.map((p) => ({
        ...p,
        typeName: typeNames[p.type] ?? `Type ${p.type}`,
        categoryName: categoryNames[p.category] ?? `Category ${p.category}`,
      })),
    });
  });

  // ── GET /api/credit/rewards/:id ───────────────────────────────────────────
  app.get("/api/credit/rewards/:id", async (req, res) => {
    const program = await storage.getRewardProgram(req.params.id);
    if (!program) return res.status(404).json({ error: "Reward program not found" });
    res.json(program);
  });

  // ── POST /api/credit/rewards ──────────────────────────────────────────────
  // Create a new reward program (admin)
  app.post("/api/credit/rewards", async (req, res) => {
    const parsed = insertRewardProgramSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const program = await storage.createRewardProgram(parsed.data);
      res.status(201).json(program);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/credit/rewards/:id ─────────────────────────────────────────
  app.patch("/api/credit/rewards/:id", async (req, res) => {
    const program = await storage.updateRewardProgram(req.params.id, req.body);
    if (!program) return res.status(404).json({ error: "Reward program not found" });
    res.json(program);
  });

  // ── GET /api/credit/rewards/history ──────────────────────────────────────
  // Get reward history for a user
  app.get("/api/credit/rewards/history", async (req, res) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: "username query param required" });
    const history = await storage.getUserRewardHistory(username);
    res.json({ username, count: history.length, history });
  });

  // ── POST /api/credit/rewards/trigger ─────────────────────────────────────
  // Trigger a reward event for a user
  // rewardType: "MIG_CREDIT" | "SCORE" | "LEVEL"
  app.post("/api/credit/rewards/trigger", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      programId: z.string().optional(),
      rewardType: z.enum(["MIG_CREDIT", "SCORE", "LEVEL", "BADGE"]),
      migCreditAmount: z.number().positive().optional(),
      migCreditCurrency: z.string().optional().default("IDR"),
      scoreAmount: z.number().int().positive().optional(),
      levelAmount: z.number().int().positive().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, programId, rewardType, migCreditAmount, migCreditCurrency, scoreAmount, levelAmount } = parsed.data;

    let programName: string | undefined;
    if (programId) {
      const prog = await storage.getRewardProgram(programId);
      if (!prog) return res.status(404).json({ error: "Reward program not found" });
      programName = prog.name;
    }

    try {
      const reward = await storage.addUserReward({
        username,
        programId: programId ?? null,
        programName: programName ?? null,
        rewardType,
        migCreditAmount: migCreditAmount ?? null,
        migCreditCurrency: migCreditCurrency ?? null,
        scoreAmount: scoreAmount ?? null,
        levelAmount: levelAmount ?? null,
      });

      const acct = await storage.getCreditAccount(username);
      res.json({
        success: true,
        reward,
        newBalance: acct.balance,
        currency: acct.currency,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/credit/topup ─────────────────────────────────────────
  // Admin: Add credits directly to a user account (admin only)
  // Body: { username, amount, currency?, description? }
  app.post("/api/admin/credit/topup", async (req, res) => {
    const callerId: string | undefined = req.session?.userId;
    if (!callerId) return res.status(401).json({ error: "Invalid session. Please log in again." });
    const isAdmin = await storage.isGlobalAdmin(callerId);
    if (!isAdmin) return res.status(403).json({ error: "Only admins can perform this operation." });
    const schema = z.object({
      username:    z.string().min(1),
      amount:      z.number().positive("Amount must be positive"),
      currency:    z.string().optional(),
      description: z.string().optional().default("Admin top-up"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, amount, currency, description } = parsed.data;
    try {
      const updated = await storage.adjustBalance(username, amount, currency);
      await storage.createCreditTransaction({
        username,
        type: CREDIT_TRANSACTION_TYPE.BONUS_CREDIT,
        reference: `TOPUP-${Date.now()}`,
        description,
        currency: updated.currency,
        amount,
        fundedAmount: amount,
        tax: 0,
        runningBalance: updated.balance,
      });
      res.json({
        success: true,
        username,
        added: amount,
        newBalance: updated.balance,
        currency: updated.currency,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/credit/accounts ───────────────────────────────────────
  // Admin: List credit accounts (optionally filtered by username substring).
  // Query: ?search=<term>&limit=<n>
  app.get("/api/admin/credit/accounts", async (req, res) => {
    const callerId: string | undefined = req.session?.userId;
    if (!callerId) return res.status(401).json({ error: "Invalid session. Please log in again." });
    const isAdmin = await storage.isGlobalAdmin(callerId);
    if (!isAdmin) return res.status(403).json({ error: "Only admins can perform this operation." });
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    try {
      const accounts = await storage.listCreditAccounts({ search, limit });
      res.json({ accounts });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/credit/set-balance ───────────────────────────────────
  // Admin: Overwrite a user's balance to an exact value (use 0 to zero out).
  // Logs an audit entry (BONUS_CREDIT for delta>0, CREDIT_WRITE_OFF for delta<0).
  // Body: { username, balance, description? }
  app.post("/api/admin/credit/set-balance", async (req, res) => {
    const callerId: string | undefined = req.session?.userId;
    if (!callerId) return res.status(401).json({ error: "Invalid session. Please log in again." });
    const isAdmin = await storage.isGlobalAdmin(callerId);
    if (!isAdmin) return res.status(403).json({ error: "Only admins can perform this operation." });
    const schema = z.object({
      username:    z.string().min(1),
      balance:     z.number().min(0, "Balance cannot be negative"),
      description: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, balance, description } = parsed.data;
    try {
      const before = await storage.getCreditAccount(username);
      const delta = Math.round((balance - before.balance) * 100) / 100;
      const updated = await storage.setBalance(username, balance);
      if (delta !== 0) {
        await storage.createCreditTransaction({
          username,
          type: delta >= 0 ? CREDIT_TRANSACTION_TYPE.BONUS_CREDIT : CREDIT_TRANSACTION_TYPE.CREDIT_WRITE_OFF,
          reference: `ADMIN-SET-${Date.now()}`,
          description: description ?? `Admin set balance to ${balance}`,
          currency: updated.currency,
          amount: delta,
          fundedAmount: 0,
          tax: 0,
          runningBalance: updated.balance,
        });
      }
      res.json({
        success: true,
        username,
        previousBalance: before.balance,
        newBalance: updated.balance,
        delta,
        currency: updated.currency,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /admin/credit ────────────────────────────────────────────────────
  // Admin web panel for managing credit balances.
  app.get("/admin/credit", (_req, res) => {
    res.send(creditAdminPageHtml());
  });

  // ── GET /api/credit/transaction-types ────────────────────────────────────
  // List all available transaction types (reference)
  app.get("/api/credit/transaction-types", (_req, res) => {
    const types = Object.entries(CREDIT_TRANSACTION_TYPE).map(([name, value]) => ({ value, name }));
    res.json({ types });
  });

  // ── GET /api/credit/voucher-statuses ─────────────────────────────────────
  // List all voucher status codes (reference)
  app.get("/api/credit/voucher-statuses", (_req, res) => {
    const statuses = Object.entries(VOUCHER_STATUS).map(([name, value]) => ({ value, name }));
    res.json({ statuses });
  });
}

// ── Admin web panel HTML ─────────────────────────────────────────────────────
// Self-contained page (no build step) for managing credit balances.
// Requires the admin to already have a logged-in session (cookie auth).
function creditAdminPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Kelola Saldo Akun</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7fa;color:#1a202c}
    .header{background:#9a3412;color:#fff;padding:18px 24px}
    .header h1{font-size:20px;font-weight:800;letter-spacing:.3px}
    .header p{font-size:13px;opacity:.85;margin-top:4px}
    .container{max-width:1100px;margin:24px auto;padding:0 20px}
    .card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
    .card h2{font-size:15px;font-weight:800;margin-bottom:14px;color:#9a3412;text-transform:uppercase;letter-spacing:.6px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
    label{font-size:12px;font-weight:700;color:#4a5568;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px}
    input[type=text],input[type=number]{padding:10px 12px;border:1px solid #cbd5e0;border-radius:8px;font-size:14px;background:#fff;min-width:0;width:100%}
    .field{flex:1;min-width:160px}
    .btn{padding:10px 16px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;border:none;transition:opacity .15s}
    .btn-primary{background:#f97316;color:#fff}
    .btn-secondary{background:#e2e8f0;color:#1a202c}
    .btn-danger{background:#dc2626;color:#fff}
    .btn:hover{opacity:.85}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #edf2f7}
    th{font-size:11px;text-transform:uppercase;color:#718096;letter-spacing:.5px;background:#f7fafc}
    tbody tr:hover{background:#fff7ed}
    .balance{font-variant-numeric:tabular-nums;font-weight:700;color:#9a3412}
    .currency{display:inline-block;padding:2px 8px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:800}
    .toast{position:fixed;top:20px;right:20px;padding:12px 18px;border-radius:10px;color:#fff;font-weight:700;font-size:14px;display:none;z-index:50;box-shadow:0 8px 20px rgba(0,0,0,.18)}
    .toast.success{background:#16a34a;display:block}
    .toast.error{background:#dc2626;display:block}
    .empty{padding:24px;text-align:center;color:#a0aec0;font-size:14px}
    .actions{display:flex;gap:6px;flex-wrap:wrap}
  </style>
</head>
<body>
  <div class="header">
    <h1>Admin · Kelola Saldo Akun</h1>
    <p>Atur atau kosongkan saldo kredit pengguna. Operasi tercatat di credit_transactions.</p>
  </div>

  <div class="container">
    <div class="card">
      <h2>Cari Akun</h2>
      <div class="row">
        <div class="field">
          <label for="searchInput">Cari username (kosongkan untuk lihat semua)</label>
          <input type="text" id="searchInput" placeholder="contoh: gerhana" autocomplete="off"/>
        </div>
        <button id="searchBtn" class="btn btn-primary">Cari</button>
      </div>
    </div>

    <div class="card">
      <h2>Hasil</h2>
      <div id="resultArea">
        <div class="empty">Klik "Cari" untuk memuat akun.</div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const $ = (id) => document.getElementById(id);
    const fmt = (n) => Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 });
    function toast(msg, ok) {
      const t = $('toast');
      t.textContent = msg;
      t.className = 'toast ' + (ok ? 'success' : 'error');
      setTimeout(() => { t.style.display = 'none'; t.className = 'toast'; }, 4000);
    }
    async function fetchAccounts() {
      const term = $('searchInput').value.trim();
      const url = '/api/admin/credit/accounts?limit=200' + (term ? '&search=' + encodeURIComponent(term) : '');
      const res = await fetch(url, { credentials: 'include' });
      if (res.status === 401) { toast('Sesi login admin diperlukan. Login dulu lewat aplikasi.', false); return; }
      if (res.status === 403) { toast('Akun bukan admin.', false); return; }
      if (!res.ok) { toast('Gagal memuat: ' + res.status, false); return; }
      const data = await res.json();
      renderAccounts(data.accounts || []);
    }
    function renderAccounts(accounts) {
      const area = $('resultArea');
      if (accounts.length === 0) {
        area.innerHTML = '<div class="empty">Tidak ada akun yang cocok.</div>';
        return;
      }
      let html = '<table><thead><tr><th>Username</th><th>Currency</th><th>Saldo</th><th>Funded</th><th>Set Saldo Baru</th><th>Aksi</th></tr></thead><tbody>';
      for (const a of accounts) {
        const u = a.username.replace(/"/g, '&quot;');
        html += '<tr data-username="' + u + '">';
        html += '<td><strong>' + u + '</strong></td>';
        html += '<td><span class="currency">' + a.currency + '</span></td>';
        html += '<td class="balance">' + fmt(a.balance) + '</td>';
        html += '<td>' + fmt(a.fundedBalance) + '</td>';
        html += '<td><input type="number" min="0" step="0.01" class="balance-input" placeholder="0" style="max-width:140px"/></td>';
        html += '<td><div class="actions">';
        html += '<button class="btn btn-primary set-btn">Simpan</button>';
        html += '<button class="btn btn-danger zero-btn">Kosongkan</button>';
        html += '</div></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      area.innerHTML = html;
      area.querySelectorAll('.set-btn').forEach(btn => btn.addEventListener('click', onSet));
      area.querySelectorAll('.zero-btn').forEach(btn => btn.addEventListener('click', onZero));
    }
    async function setBalance(username, balance) {
      const res = await fetch('/api/admin/credit/set-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, balance, description: 'Admin panel: set balance' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast('Gagal: ' + (data.error?.fieldErrors ? JSON.stringify(data.error.fieldErrors) : data.error || res.status), false); return; }
      toast(username + ': ' + fmt(data.previousBalance) + ' → ' + fmt(data.newBalance) + ' ' + data.currency, true);
      fetchAccounts();
    }
    async function onSet(ev) {
      const tr = ev.target.closest('tr');
      const username = tr.dataset.username;
      const input = tr.querySelector('.balance-input');
      const v = parseFloat(input.value);
      if (isNaN(v) || v < 0) { toast('Masukkan angka >= 0', false); return; }
      if (!confirm('Set saldo ' + username + ' menjadi ' + fmt(v) + '?')) return;
      setBalance(username, v);
    }
    async function onZero(ev) {
      const tr = ev.target.closest('tr');
      const username = tr.dataset.username;
      if (!confirm('Kosongkan saldo ' + username + ' menjadi 0?')) return;
      setBalance(username, 0);
    }
    $('searchBtn').addEventListener('click', fetchAccounts);
    $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchAccounts(); });
    fetchAccounts();
  </script>
</body>
</html>`;
}

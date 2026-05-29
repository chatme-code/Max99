import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import {
  insertPaymentSchema,
  PAYMENT_VENDOR_TYPE,
  PAYMENT_STATUS,
} from "@shared/schema";

// Mirrors com/projectgoth/fusion/payment/PaymentInterface.java:
//   isAccessAllowed(), clientInitiatePayment(), updatePaymentStatus()
//   onPaymentAuthorized(), approve(), reject()
// PaymentData.java: vendorType, vendorTransactionId, userId, status, amount, currency
// Vendors: CREDITCARD (payment/creditcard/), PAYPAL (payment/paypal/),
//          MOL (payment/mol/), MIMOPAY (payment/mimopay/)
// PaymentResource.java: REST resource exposing all payment operations

export function registerPaymentRoutes(app: Express) {

  // ── POST /api/payment/initiate ───────────────────────────────────────────────
  // Initiate a payment (mirrors clientInitiatePayment())
  // Body: { username, vendorType, amount, currency, description?, extraFields? }
  app.post("/api/payment/initiate", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      vendorType: z.enum(["CREDITCARD", "PAYPAL", "MOL", "MIMOPAY"]),
      amount: z.number().positive("Amount must be positive"),
      currency: z.string().length(3).default("IDR"),
      description: z.string().optional(),
      extraFields: z.record(z.any()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, vendorType, amount, currency, description, extraFields } = parsed.data;
    try {
      const payment = await storage.createPayment({
        username,
        vendorType,
        amount,
        currency,
        status: PAYMENT_STATUS.PENDING,
        description: description ?? null,
        extraFields: extraFields ?? null,
        vendorTransactionId: null,
      });
      res.status(201).json({
        success: true,
        paymentId: payment.id,
        status: "PENDING",
        payment,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/payment/:id ──────────────────────────────────────────────────────
  // Get payment details
  app.get("/api/payment/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid payment ID" });
    try {
      const payment = await storage.getPaymentById(id);
      if (!payment) return res.status(404).json({ error: "Payment not found" });
      const statusName = Object.entries(PAYMENT_STATUS).find(([, v]) => v === payment.status)?.[0] ?? "UNKNOWN";
      res.json({ ...payment, statusName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/payment/user/:username ───────────────────────────────────────────
  // Get all payments for a user
  // Query: ?limit=20&status=3 (optional filter by status)
  app.get("/api/payment/user/:username", async (req, res) => {
    const { username } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const statusFilter = req.query.status ? parseInt(req.query.status as string) : undefined;
    try {
      const payments = await storage.getPaymentsByUsername(username, limit, statusFilter);
      res.json({ username, payments, count: payments.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/payment/:id/status ─────────────────────────────────────────────
  // Update payment status (mirrors updatePaymentStatus())
  // Body: { status, vendorTransactionId? }
  app.patch("/api/payment/:id/status", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid payment ID" });

    const schema = z.object({
      status: z.number().int().min(1).max(5),
      vendorTransactionId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const updated = await storage.updatePaymentStatus(id, parsed.data.status, parsed.data.vendorTransactionId);
      if (!updated) return res.status(404).json({ error: "Payment not found" });
      res.json({ success: true, payment: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/payment/:id/authorize ───────────────────────────────────────────
  // Mark payment as authorized (mirrors onPaymentAuthorized())
  // Body: { vendorTransactionId }
  app.post("/api/payment/:id/authorize", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid payment ID" });

    const schema = z.object({ vendorTransactionId: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const payment = await storage.getPaymentById(id);
      if (!payment) return res.status(404).json({ error: "Payment not found" });
      if (payment.status !== PAYMENT_STATUS.PENDING) {
        return res.status(409).json({ error: "Payment is not in PENDING state" });
      }
      const updated = await storage.updatePaymentStatus(id, PAYMENT_STATUS.AUTHORIZED, parsed.data.vendorTransactionId);
      res.json({ success: true, payment: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/payment/:id/approve ─────────────────────────────────────────────
  // Approve payment and credit user (mirrors approve())
  // Body: { approvedBy? }
  app.post("/api/payment/:id/approve", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid payment ID" });

    try {
      const payment = await storage.getPaymentById(id);
      if (!payment) return res.status(404).json({ error: "Payment not found" });
      if (payment.status === PAYMENT_STATUS.COMPLETED) {
        return res.status(409).json({ error: "Payment already completed" });
      }
      const updated = await storage.updatePaymentStatus(id, PAYMENT_STATUS.COMPLETED, payment.vendorTransactionId ?? undefined);
      res.json({ success: true, payment: updated, message: "Payment approved and credited to user account" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/payment/:id/reject ──────────────────────────────────────────────
  // Reject payment (mirrors reject())
  // Body: { reason? }
  app.post("/api/payment/:id/reject", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid payment ID" });

    try {
      const payment = await storage.getPaymentById(id);
      if (!payment) return res.status(404).json({ error: "Payment not found" });
      if (payment.status === PAYMENT_STATUS.REJECTED) {
        return res.status(409).json({ error: "Payment already rejected" });
      }
      const updated = await storage.updatePaymentStatus(id, PAYMENT_STATUS.REJECTED);
      res.json({ success: true, payment: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/payment/vendors ───────────────────────────────────────────────────
  // List supported payment vendors (mirrors PaymentFactory)
  app.get("/api/payment/vendors", (_req, res) => {
    res.json({
      vendors: Object.values(PAYMENT_VENDOR_TYPE),
      statuses: PAYMENT_STATUS,
      description: {
        CREDITCARD: "Global Collect Credit Card",
        PAYPAL: "PayPal",
        MOL: "MOL Points",
        MIMOPAY: "MimoPay",
      },
    });
  });
}

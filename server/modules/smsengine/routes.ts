import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { SMS_STATUS, SMS_SUB_TYPE, SMS_GATEWAY } from "@shared/schema";

// Mirrors com/projectgoth/fusion/smsengine/
// SMSEngine.java: main engine with dispatch threads
// SMSMessage.java: phoneNumber, message, subType, status
// DispatchThread.java: picks pending SMS and dispatches
// RetryPendingSMSTask.java: retries failed SMS messages
// SMPPGateway.java / HTTPGateway.java: actual send mechanisms
// RoutingTable.java: routes by country code to gateway
// SMSControl.java: controls engine state

export function registerSmsEngineRoutes(app: Express) {

  // ── POST /api/smsengine/send ──────────────────────────────────────────────────
  // Queue an SMS for dispatch (mirrors SMSEngine dispatch)
  // Body: { phoneNumber, message, subType, username?, gateway? }
  app.post("/api/smsengine/send", async (req, res) => {
    const schema = z.object({
      phoneNumber: z.string().min(7).max(20).regex(/^\+?[0-9]+$/, "Invalid phone number"),
      message: z.string().min(1).max(160),
      subType: z.number().int().min(1).max(3).default(SMS_SUB_TYPE.ALERT),
      username: z.string().optional(),
      gateway: z.enum(["SMPP", "HTTP"]).optional().default("HTTP"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { phoneNumber, message, subType, username, gateway } = parsed.data;
    try {
      const sms = await storage.createSmsMessage({
        phoneNumber,
        message,
        subType,
        username: username ?? null,
        gateway: gateway ?? null,
        status: SMS_STATUS.PENDING,
        retryCount: 0,
      });
      res.status(201).json({
        success: true,
        smsId: sms.id,
        status: "PENDING",
        sms,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/smsengine/status/:id ─────────────────────────────────────────────
  // Get SMS message status
  app.get("/api/smsengine/status/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid SMS ID" });
    try {
      const sms = await storage.getSmsMessageById(id);
      if (!sms) return res.status(404).json({ error: "SMS not found" });
      const statusName = Object.entries(SMS_STATUS).find(([, v]) => v === sms.status)?.[0] ?? "UNKNOWN";
      res.json({ ...sms, statusName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/smsengine/history ─────────────────────────────────────────────────
  // Get SMS history by phone number or username
  // Query: ?phoneNumber=+628xxx OR ?username=xxx&limit=20
  app.get("/api/smsengine/history", async (req, res) => {
    const phoneNumber = req.query.phoneNumber as string | undefined;
    const username = req.query.username as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    if (!phoneNumber && !username) {
      return res.status(400).json({ error: "phoneNumber or username query param required" });
    }

    try {
      const messages = await storage.getSmsHistory(phoneNumber, username, limit);
      res.json({ messages, count: messages.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/smsengine/:id/status ───────────────────────────────────────────
  // Update SMS status (SENT, FAILED, RETRY)
  // Body: { status }
  app.patch("/api/smsengine/:id/status", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid SMS ID" });

    const schema = z.object({ status: z.number().int().min(1).max(4) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const updated = await storage.updateSmsStatus(id, parsed.data.status);
      if (!updated) return res.status(404).json({ error: "SMS not found" });
      res.json({ success: true, sms: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/smsengine/retry-pending ─────────────────────────────────────────
  // Retry all failed/pending SMS messages (mirrors RetryPendingSMSTask.java)
  app.post("/api/smsengine/retry-pending", async (_req, res) => {
    try {
      const count = await storage.retryPendingSmsMessages();
      res.json({ success: true, retried: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/smsengine/pending ─────────────────────────────────────────────────
  // Get pending SMS messages (mirrors DispatchThread picking up pending)
  // Query: ?limit=50
  app.get("/api/smsengine/pending", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    try {
      const pending = await storage.getPendingSmsMessages(limit);
      res.json({ pending, count: pending.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/smsengine/constants ──────────────────────────────────────────────
  // Get SMS engine constants
  app.get("/api/smsengine/constants", (_req, res) => {
    res.json({
      statuses: SMS_STATUS,
      subTypes: SMS_SUB_TYPE,
      gateways: SMS_GATEWAY,
      maxMessageLength: 160,
    });
  });
}

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { SWITCHBOARD_MSG_TYPE, SWITCHBOARD_STATUS } from "@shared/schema";

// Mirrors com/projectgoth/fusion/messageswitchboard/
// MessageSwitchboard.java: main switchboard dispatching messages
// MessageSwitchboardDispatcher.java: dispatches queued messages to users
// MessageSwitchboardI.java: interface (dispatch, getMessages, clear)
// MessageSwitchboardUtils.java: utility for message key construction
// MessageSwitchboardContext.java: context with configuration
// MessageSwitchboardAdminI.java: admin (stats, flush)

export function registerMessageSwitchboardRoutes(app: Express) {

  // ── POST /api/switchboard/dispatch ────────────────────────────────────────────
  // Dispatch a message from one user to another (mirrors MessageSwitchboardDispatcher)
  // Body: { fromUsername, toUsername, messageType, payload? }
  app.post("/api/switchboard/dispatch", async (req, res) => {
    const schema = z.object({
      fromUsername: z.string().min(1),
      toUsername: z.string().min(1),
      messageType: z.enum(["CHAT", "SYSTEM", "ALERT", "GIFT"]).default("CHAT"),
      payload: z.record(z.any()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { fromUsername, toUsername, messageType, payload } = parsed.data;
    try {
      const message = await storage.createSwitchboardMessage({
        fromUsername,
        toUsername,
        messageType,
        payload: payload ?? null,
        status: SWITCHBOARD_STATUS.QUEUED,
      });
      res.status(201).json({ success: true, messageId: message.id, message });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/switchboard/dispatch/broadcast ───────────────────────────────────
  // Broadcast a message to multiple users
  // Body: { fromUsername, toUsernames: string[], messageType, payload? }
  app.post("/api/switchboard/dispatch/broadcast", async (req, res) => {
    const schema = z.object({
      fromUsername: z.string().min(1),
      toUsernames: z.array(z.string().min(1)).min(1).max(100),
      messageType: z.enum(["CHAT", "SYSTEM", "ALERT", "GIFT"]).default("SYSTEM"),
      payload: z.record(z.any()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { fromUsername, toUsernames, messageType, payload } = parsed.data;
    try {
      const messages = await Promise.all(
        toUsernames.map(toUsername =>
          storage.createSwitchboardMessage({
            fromUsername,
            toUsername,
            messageType,
            payload: payload ?? null,
            status: SWITCHBOARD_STATUS.QUEUED,
          })
        )
      );
      res.status(201).json({ success: true, dispatched: messages.length, messageIds: messages.map(m => m.id) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/switchboard/pending/:username ────────────────────────────────────
  // Get pending messages for a user (mirrors MessageSwitchboardI.getMessages())
  // Query: ?limit=50&messageType=CHAT
  app.get("/api/switchboard/pending/:username", async (req, res) => {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const messageType = req.query.messageType as string | undefined;

    try {
      const messages = await storage.getPendingSwitchboardMessages(username, limit, messageType);
      res.json({ username, messages, count: messages.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/switchboard/message/:id/deliver ───────────────────────────────
  // Mark a message as delivered
  app.patch("/api/switchboard/message/:id/deliver", async (req, res) => {
    const { id } = req.params;
    try {
      const updated = await storage.updateSwitchboardMessageStatus(id, SWITCHBOARD_STATUS.DELIVERED);
      if (!updated) return res.status(404).json({ error: "Message not found" });
      res.json({ success: true, message: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/switchboard/clear/:username ───────────────────────────────────
  // Clear delivered messages for a user (mirrors MessageSwitchboardI.clear())
  app.delete("/api/switchboard/clear/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const count = await storage.clearDeliveredSwitchboardMessages(username);
      res.json({ success: true, cleared: count, username });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/switchboard/stats ─────────────────────────────────────────────────
  // Get switchboard statistics (mirrors MessageSwitchboardAdminI stats)
  app.get("/api/switchboard/stats", async (_req, res) => {
    try {
      const stats = await storage.getSwitchboardStats();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/switchboard/flush ────────────────────────────────────────────────
  // Flush all queued messages (admin - mirrors MessageSwitchboardAdminI.flush())
  app.post("/api/switchboard/flush", async (_req, res) => {
    try {
      const count = await storage.flushSwitchboardMessages();
      res.json({ success: true, flushed: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/switchboard/constants ────────────────────────────────────────────
  app.get("/api/switchboard/constants", (_req, res) => {
    res.json({ messageTypes: SWITCHBOARD_MSG_TYPE, statuses: SWITCHBOARD_STATUS });
  });
}

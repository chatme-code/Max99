import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { VOICE_CALL_STATUS } from "@shared/schema";

// Mirrors com/projectgoth/fusion/voiceengine/
// AsteriskGateway.java: Asterisk telephony gateway
// AsteriskConnection.java: connection to Asterisk server
// CallingCard.java: calling card for calls
// CallMakerI.java: interface for initiating calls
// AsteriskCommand.java: AGI commands sent to Asterisk
// AsteriskListener.java: listens for call events

export function registerVoiceEngineRoutes(app: Express) {

  // ── POST /api/voiceengine/call ─────────────────────────────────────────────────
  // Initiate a voice call (mirrors CallMakerI.makeCall())
  // Body: { callerUsername, calleeUsername, callingCard? }
  app.post("/api/voiceengine/call", async (req, res) => {
    const schema = z.object({
      callerUsername: z.string().min(1),
      calleeUsername: z.string().min(1),
      callingCard: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { callerUsername, calleeUsername, callingCard } = parsed.data;
    if (callerUsername === calleeUsername) return res.status(400).json({ error: "Cannot call yourself" });

    try {
      const call = await storage.createVoiceCall({
        callerUsername,
        calleeUsername,
        status: VOICE_CALL_STATUS.INITIATED,
        duration: 0,
        callingCard: callingCard ?? null,
        endedAt: null,
      });
      res.status(201).json({ success: true, callId: call.id, call });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/voiceengine/call/:id ─────────────────────────────────────────────
  // Get call details
  app.get("/api/voiceengine/call/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const call = await storage.getVoiceCallById(id);
      if (!call) return res.status(404).json({ error: "Call not found" });
      const statusName = Object.entries(VOICE_CALL_STATUS).find(([, v]) => v === call.status)?.[0] ?? "UNKNOWN";
      res.json({ ...call, statusName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/voiceengine/call/:id ───────────────────────────────────────────
  // Update call status (mirrors AsteriskListener.onCallEvent())
  // Body: { status, duration? }
  app.patch("/api/voiceengine/call/:id", async (req, res) => {
    const { id } = req.params;
    const schema = z.object({
      status: z.number().int().min(1).max(5),
      duration: z.number().int().nonnegative().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { status, duration } = parsed.data;
    try {
      const endedAt = (status === VOICE_CALL_STATUS.ENDED || status === VOICE_CALL_STATUS.FAILED || status === VOICE_CALL_STATUS.MISSED)
        ? new Date() : undefined;
      const updated = await storage.updateVoiceCallStatus(id, status, duration, endedAt);
      if (!updated) return res.status(404).json({ error: "Call not found" });
      res.json({ success: true, call: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/voiceengine/call/:id/answer ─────────────────────────────────────
  // Answer a call (mirrors AsteriskListener.onAnswer())
  app.post("/api/voiceengine/call/:id/answer", async (req, res) => {
    const { id } = req.params;
    try {
      const call = await storage.getVoiceCallById(id);
      if (!call) return res.status(404).json({ error: "Call not found" });
      if (call.status !== VOICE_CALL_STATUS.INITIATED) {
        return res.status(409).json({ error: "Call is not in INITIATED state" });
      }
      const updated = await storage.updateVoiceCallStatus(id, VOICE_CALL_STATUS.ANSWERED);
      res.json({ success: true, call: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/voiceengine/call/:id/end ────────────────────────────────────────
  // End a call (mirrors AsteriskCommand.hangup())
  // Body: { duration }
  app.post("/api/voiceengine/call/:id/end", async (req, res) => {
    const { id } = req.params;
    const schema = z.object({ duration: z.number().int().nonnegative().optional().default(0) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const updated = await storage.updateVoiceCallStatus(id, VOICE_CALL_STATUS.ENDED, parsed.data.duration, new Date());
      if (!updated) return res.status(404).json({ error: "Call not found" });
      res.json({ success: true, call: updated, duration: parsed.data.duration });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/voiceengine/history/:username ────────────────────────────────────
  // Get call history for a user (caller or callee)
  // Query: ?limit=20&type=caller|callee|all
  app.get("/api/voiceengine/history/:username", async (req, res) => {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const type = (req.query.type as string) || "all";

    try {
      const calls = await storage.getVoiceCallHistory(username, limit, type as "caller" | "callee" | "all");
      res.json({ username, calls, count: calls.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/voiceengine/constants ────────────────────────────────────────────
  app.get("/api/voiceengine/constants", (_req, res) => {
    res.json({ statuses: VOICE_CALL_STATUS });
  });
}

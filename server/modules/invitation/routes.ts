import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import {
  insertInvitationSchema,
  INVITATION_TYPE,
  INVITATION_CHANNEL,
  INVITATION_STATUS,
} from "@shared/schema";

// Mirrors com/projectgoth/fusion/invitation/restapi/
// SendingInvitationData: type, channel, destinations[], invitationMetadata
// InvitationDetailsData: createdTS, expiredTS
// Each destination becomes one invitation row (one-to-one mapping as in Java)

export function registerInvitationRoutes(app: Express) {

  // ── POST /api/invitation/send ────────────────────────────────────────────────
  // Send invitations to multiple destinations (SendingInvitationData)
  // Body: { senderUsername, type, channel, destinations: string[], metadata?, expiryDays? }
  app.post("/api/invitation/send", async (req, res) => {
    const schema = z.object({
      senderUsername: z.string().min(1),
      type: z.number().int().min(1).max(3).default(INVITATION_TYPE.EMAIL),
      channel: z.number().int().min(1).max(5).default(INVITATION_CHANNEL.EMAIL),
      destinations: z.array(z.string().min(1)).min(1).max(50),
      metadata: z.record(z.any()).optional(),
      expiryDays: z.number().int().min(1).max(30).optional().default(7),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { senderUsername, type, channel, destinations, metadata, expiryDays } = parsed.data;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    try {
      const created = await Promise.all(
        destinations.map(destination =>
          storage.createInvitation({
            senderUsername,
            type,
            channel,
            destination,
            status: INVITATION_STATUS.PENDING,
            metadata: metadata ?? null,
            expiresAt,
          })
        )
      );
      res.status(201).json({
        success: true,
        sent: created.length,
        invitations: created,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/invitation/sent ─────────────────────────────────────────────────
  // Get sent invitations by a user (InvitationDetailsData)
  // Query: ?username=xxx&limit=20
  app.get("/api/invitation/sent", async (req, res) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: "username query param required" });
    const limit = parseInt(req.query.limit as string) || 20;

    try {
      const invitations = await storage.getInvitationsBySender(username, limit);
      res.json({ username, invitations, count: invitations.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/invitation/received ─────────────────────────────────────────────
  // Get invitations received by a destination (email/phone)
  // Query: ?destination=xxx
  app.get("/api/invitation/received", async (req, res) => {
    const destination = req.query.destination as string;
    if (!destination) return res.status(400).json({ error: "destination query param required" });

    try {
      const invitations = await storage.getInvitationsByDestination(destination);
      res.json({ destination, invitations, count: invitations.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/invitation/:id ───────────────────────────────────────────────────
  // Get invitation details
  app.get("/api/invitation/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const invitation = await storage.getInvitationById(id);
      if (!invitation) return res.status(404).json({ error: "Invitation not found" });
      const isExpired = invitation.expiresAt && new Date() > invitation.expiresAt;
      res.json({ ...invitation, isExpired: !!isExpired });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/invitation/:id/respond ────────────────────────────────────────
  // Respond to an invitation (accept or decline)
  // Body: { response: "accept" | "decline" }
  app.patch("/api/invitation/:id/respond", async (req, res) => {
    const { id } = req.params;
    const schema = z.object({
      response: z.enum(["accept", "decline"]),
      respondingUsername: z.string().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { response } = parsed.data;
    const newStatus = response === "accept" ? INVITATION_STATUS.ACCEPTED : INVITATION_STATUS.DECLINED;

    try {
      const invitation = await storage.getInvitationById(id);
      if (!invitation) return res.status(404).json({ error: "Invitation not found" });
      if (invitation.status !== INVITATION_STATUS.PENDING) {
        return res.status(409).json({ error: "Invitation already responded to" });
      }
      if (invitation.expiresAt && new Date() > invitation.expiresAt) {
        await storage.updateInvitationStatus(id, INVITATION_STATUS.EXPIRED);
        return res.status(410).json({ error: "Invitation has expired" });
      }

      const updated = await storage.updateInvitationStatus(id, newStatus);
      res.json({ success: true, invitation: updated, response });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/invitation/expire-all ──────────────────────────────────────────
  // Expire all pending invitations past their expiry date
  app.post("/api/invitation/expire-all", async (_req, res) => {
    try {
      const count = await storage.expireOldInvitations();
      res.json({ success: true, expired: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/invitation/constants ─────────────────────────────────────────────
  // Return valid invitation types, channels, statuses
  app.get("/api/invitation/constants", (_req, res) => {
    res.json({
      types: INVITATION_TYPE,
      channels: INVITATION_CHANNEL,
      statuses: INVITATION_STATUS,
    });
  });
}

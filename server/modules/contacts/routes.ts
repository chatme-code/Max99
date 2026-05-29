import type { Express, Request, Response } from "express";
import { requireVerified } from "../../middleware/accessControl";
import { db } from "../../db";
import {
  contactRequests, friendships,
  users, userProfiles,
} from "@shared/schema";
import { eq, and, or, ne } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  broadcastToUser,
  getUserPresence,
  getUserStatusMessage,
  broadcastPresenceToFriends,
} from "../../gateway";
import { storage } from "../../storage";

// Helper: persist UNS ALERT so it survives offline periods
async function saveContactRequestNotification(toUsername: string, fromUsername: string) {
  try {
    await storage.createNotification({
      username: toUsername,
      type: "ALERT",
      subject: "Permintaan Pertemanan",
      message: `${fromUsername} ingin berteman denganmu. Buka notifikasi untuk menerima atau menolak.`,
      status: 1, // PENDING
    });
  } catch {}
}

// ─── Contact / Friends module ──────────────────────────────────────────────────
// Mirrors Java: FusionPktContactRequest, FusionPktAcceptContactRequest,
//               FusionPktRejectContactRequest, FusionPktGetContacts
// Java ContactEJB.addFusionUserAsContact() creates bidirectional records on accept.
// We store both directions in friendships table so each user can query their own list.

export function registerContactsRoutes(app: Express) {

  // ── GET /api/contacts ──────────────────────────────────────────────────────
  // Returns authenticated user's friends list with presence status + avatars
  // Mirrors FusionPktGetContacts + FusionPktPresence (online status per contact)
  app.get("/api/contacts", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const rows = await db
      .select({
        id: friendships.id,
        friendUserId: friendships.friendUserId,
        friendUsername: friendships.friendUsername,
        friendDisplayName: friendships.friendDisplayName,
        createdAt: friendships.createdAt,
        displayPicture: userProfiles.displayPicture,
      })
      .from(friendships)
      .leftJoin(userProfiles, eq(userProfiles.userId, friendships.friendUserId))
      .where(eq(friendships.userId, userId));

    const withPresence = rows.map((f) => {
      let dp = f.displayPicture ?? null;
      // Normalize legacy imageserver URLs: /api/imageserver/image/{id} → /api/imageserver/image/{id}/data
      if (dp && /\/api\/imageserver\/image\/[^/]+$/.test(dp)) dp = dp + '/data';
      return {
        ...f,
        displayPicture: dp,
        presence: getUserPresence(f.friendUserId),
        statusMessage: getUserStatusMessage(f.friendUserId),
      };
    });

    return res.json(withPresence);
  });

  // ── POST /api/contacts/request/:username ───────────────────────────────────
  // Send a friend request to another user
  // Mirrors FusionPktContactRequest — Java pushes to target user's session
  // AccessControl: ADD_FRIEND (emailVerified required, mirrors AuthenticatedAccessControlTypeEnum.ADD_FRIEND)
  app.post("/api/contacts/request/:username", requireVerified("ADD_FRIEND"), async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const fromUserId = req.session.userId;

    const [fromUser] = await db.select().from(users).where(eq(users.id, fromUserId));
    if (!fromUser) return res.status(404).json({ message: "User tidak ditemukan" });

    const targetUsername = req.params.username;
    if (targetUsername.toLowerCase() === fromUser.username.toLowerCase()) {
      return res.status(400).json({ message: "Tidak bisa menambah diri sendiri" });
    }

    const [toUser] = await db.select().from(users).where(eq(users.username, targetUsername));
    if (!toUser) return res.status(404).json({ message: "User target tidak ditemukan" });

    // Check if already friends
    const [alreadyFriend] = await db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userId, fromUserId), eq(friendships.friendUserId, toUser.id)));
    if (alreadyFriend) return res.status(409).json({ message: "Sudah berteman" });

    // Check for duplicate pending request
    const [existing] = await db
      .select()
      .from(contactRequests)
      .where(
        and(
          eq(contactRequests.fromUserId, fromUserId),
          eq(contactRequests.toUserId, toUser.id),
          eq(contactRequests.status, "pending"),
        ),
      );
    if (existing) return res.status(409).json({ message: "Permintaan sudah dikirim" });

    // Check if target already sent us a request — auto-accept as Java does
    const [reverseRequest] = await db
      .select()
      .from(contactRequests)
      .where(
        and(
          eq(contactRequests.fromUserId, toUser.id),
          eq(contactRequests.toUserId, fromUserId),
          eq(contactRequests.status, "pending"),
        ),
      );

    const fromProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, fromUserId)).then((r) => r[0]);
    const fromDisplayName = fromUser.displayName ?? fromProfile?.aboutMe ?? fromUser.username;

    if (reverseRequest) {
      // Auto-accept — mirrors Java contactEJB.addFusionUserAsContact() bidirectional
      await db.update(contactRequests)
        .set({ status: "accepted" })
        .where(eq(contactRequests.id, reverseRequest.id));

      const toProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, toUser.id)).then((r) => r[0]);
      const toDisplayName = toUser.displayName ?? toProfile?.aboutMe ?? toUser.username;

      // Create bidirectional friendship
      const friendshipId = randomUUID();
      await db.insert(friendships).values([
        { id: friendshipId, userId: fromUserId, friendUserId: toUser.id, friendUsername: toUser.username, friendDisplayName: toDisplayName },
        { id: randomUUID(), userId: toUser.id, friendUserId: fromUserId, friendUsername: fromUser.username, friendDisplayName: fromDisplayName },
      ]);

      // Notify both parties
      broadcastToUser(fromUserId, { type: "CONTACT_ACCEPTED", byUsername: toUser.username, byDisplayName: toDisplayName, friendshipId });
      broadcastToUser(toUser.id,  { type: "CONTACT_ACCEPTED", byUsername: fromUser.username, byDisplayName: fromDisplayName, friendshipId });

      // Broadcast presence to each other
      broadcastPresenceToFriends(fromUserId, fromUser.username, getUserPresence(fromUserId), [toUser.id]);
      broadcastPresenceToFriends(toUser.id, toUser.username, getUserPresence(toUser.id), [fromUserId]);

      return res.status(200).json({ message: "Permintaan otomatis diterima — kalian sudah berteman" });
    }

    // Create contact request
    const [request] = await db
      .insert(contactRequests)
      .values({
        id: randomUUID(),
        fromUserId,
        fromUsername: fromUser.username,
        fromDisplayName,
        toUserId: toUser.id,
        toUsername: toUser.username,
        status: "pending",
      })
      .returning();

    // Push WS event to target user (if online) — mirrors Java FusionPktContactRequest push
    broadcastToUser(toUser.id, {
      type: "CONTACT_REQUEST",
      requestId: request.id,
      fromUsername: fromUser.username,
      fromDisplayName,
    });

    // Persist UNS ALERT so offline users can see it when they open notifications
    await saveContactRequestNotification(toUser.username, fromUser.username);

    return res.status(201).json({ message: "Permintaan pertemanan dikirim", request });
  });

  // ── GET /api/contacts/requests ─────────────────────────────────────────────
  // List all incoming pending friend requests for the authenticated user
  // Mirrors FusionPktGetContactRequests
  app.get("/api/contacts/requests", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const incoming = await db
      .select()
      .from(contactRequests)
      .where(and(eq(contactRequests.toUserId, userId), eq(contactRequests.status, "pending")));

    const outgoing = await db
      .select()
      .from(contactRequests)
      .where(and(eq(contactRequests.fromUserId, userId), eq(contactRequests.status, "pending")));

    return res.json({ incoming, outgoing });
  });

  // ── POST /api/contacts/requests/:id/accept ─────────────────────────────────
  // Accept an incoming friend request
  // Mirrors FusionPktAcceptContactRequest → contactEJB.addFusionUserAsContact() (bidirectional)
  // AccessControl: BE_ADDED_AS_FRIEND (emailVerified required)
  app.post("/api/contacts/requests/:id/accept", requireVerified("BE_ADDED_AS_FRIEND"), async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const [request] = await db.select().from(contactRequests).where(eq(contactRequests.id, req.params.id));
    if (!request) return res.status(404).json({ message: "Permintaan tidak ditemukan" });
    if (request.toUserId !== userId) return res.status(403).json({ message: "Bukan permintaan untukmu" });
    if (request.status !== "pending") return res.status(409).json({ message: "Permintaan sudah diproses" });

    // Mark request accepted
    await db.update(contactRequests).set({ status: "accepted" }).where(eq(contactRequests.id, request.id));

    // Fetch display names
    const [accepter] = await db.select().from(users).where(eq(users.id, userId));
    const accepterProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).then((r) => r[0]);
    const accepterDisplayName = accepter?.displayName ?? accepterProfile?.aboutMe ?? accepter?.username ?? "";

    const requesterProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, request.fromUserId)).then((r) => r[0]);
    const requesterDisplayName = request.fromDisplayName ?? requesterProfile?.aboutMe ?? request.fromUsername;

    // Create bidirectional friendship (Java: addFusionUserAsContact creates two rows)
    const friendshipId = randomUUID();
    await db.insert(friendships).values([
      { id: friendshipId, userId, friendUserId: request.fromUserId, friendUsername: request.fromUsername, friendDisplayName: requesterDisplayName },
      { id: randomUUID(), userId: request.fromUserId, friendUserId: userId, friendUsername: accepter?.username ?? "", friendDisplayName: accepterDisplayName },
    ]);

    // WS: notify requester their request was accepted (mirrors Java CONTACT_ACCEPTED event)
    broadcastToUser(request.fromUserId, {
      type: "CONTACT_ACCEPTED",
      byUsername: accepter?.username ?? "",
      byDisplayName: accepterDisplayName,
      friendshipId,
    });

    // Broadcast presence to each other now that they're friends
    broadcastPresenceToFriends(userId, accepter?.username ?? "", getUserPresence(userId), [request.fromUserId]);
    broadcastPresenceToFriends(request.fromUserId, request.fromUsername, getUserPresence(request.fromUserId), [userId]);

    return res.json({ message: "Permintaan pertemanan diterima", friendshipId });
  });

  // ── POST /api/contacts/requests/:id/reject ─────────────────────────────────
  // Reject an incoming friend request
  // Mirrors FusionPktRejectContactRequest
  app.post("/api/contacts/requests/:id/reject", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const [request] = await db.select().from(contactRequests).where(eq(contactRequests.id, req.params.id));
    if (!request) return res.status(404).json({ message: "Permintaan tidak ditemukan" });
    if (request.toUserId !== userId) return res.status(403).json({ message: "Bukan permintaan untukmu" });
    if (request.status !== "pending") return res.status(409).json({ message: "Permintaan sudah diproses" });

    await db.update(contactRequests).set({ status: "rejected" }).where(eq(contactRequests.id, request.id));

    // Optionally notify requester (Java doesn't always do this, but it's good UX)
    broadcastToUser(request.fromUserId, {
      type: "CONTACT_REJECTED",
      byUsername: request.toUsername,
    });

    return res.json({ message: "Permintaan pertemanan ditolak" });
  });

  // ── DELETE /api/contacts/:username ─────────────────────────────────────────
  // Remove a friend — deletes both directions in friendships table
  // Mirrors FusionPktRemoveContact (Java removes bidirectional relationship)
  app.delete("/api/contacts/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;
    const targetUsername = req.params.username;

    const [targetUser] = await db.select().from(users).where(eq(users.username, targetUsername));
    if (!targetUser) return res.status(404).json({ message: "User tidak ditemukan" });

    // Delete both directions
    await db.delete(friendships).where(
      or(
        and(eq(friendships.userId, userId), eq(friendships.friendUserId, targetUser.id)),
        and(eq(friendships.userId, targetUser.id), eq(friendships.friendUserId, userId)),
      ),
    );

    // Notify target that they were removed (presence will show offline to each other)
    broadcastToUser(targetUser.id, { type: "PRESENCE", username: "", userId, status: "offline" });

    return res.json({ message: "Teman dihapus" });
  });

  // ── GET /api/contacts/presence ─────────────────────────────────────────────
  // Batch presence check for a list of userIds (query param: ids=id1,id2,...)
  // Mirrors FusionPktPresence — Java broadcasts to contacts; we serve on-demand
  app.get("/api/contacts/presence", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });

    const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : [];
    const result = ids.map((uid) => ({
      userId: uid,
      status: getUserPresence(uid),
    }));

    return res.json(result);
  });
}

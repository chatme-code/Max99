import type { Express, Request, Response } from "express";
import { db } from "../../db";
import {
  conversations, conversationParticipants, conversationMessages,
  users, userProfiles, userChatListVersions,
  NOTIFICATION_TYPE, NOTIFICATION_STATUS,
} from "@shared/schema";
import { eq, and, desc, ne, sql, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import { broadcastToUser, isUserOnline } from "../../gateway";
import { storage } from "../../storage";
import {
  saveChatMessage,
  saveMessageStatusEvent,
  saveOfflineMessage,
  addToOldChatList,
} from "../../redis";
import { pushServerGeneratedReceivedEvent } from "./serverGeneratedReceivedEventPusher";

const AVATAR_COLORS = ["#4CAF50", "#9C27B0", "#F44336", "#795548", "#FF9800", "#2196F3", "#E91E63", "#009688"];
const PASSIVATED_DAYS = 30;

function pickAvatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function isPassivated(lastMessageAt: Date | null, createdAt: Date): boolean {
  const cutoff = Date.now() - PASSIVATED_DAYS * 24 * 60 * 60 * 1000;
  const ref = lastMessageAt ?? createdAt;
  return ref.getTime() < cutoff;
}

// ── Chat list version helpers (mirrors fusion CurrentChatList versioning) ──────
async function getChatListVersion(userId: string): Promise<number> {
  const [row] = await db.select({ version: userChatListVersions.version })
    .from(userChatListVersions)
    .where(eq(userChatListVersions.userId, userId));
  return row?.version ?? 0;
}

async function incrementChatListVersion(userId: string): Promise<void> {
  await db.insert(userChatListVersions)
    .values({ userId, version: 1, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userChatListVersions.userId,
      set: {
        version: sql`${userChatListVersions.version} + 1`,
        updatedAt: new Date(),
      },
    });
}

async function getOrCreatePrivateConversation(
  userAId: string, userAUsername: string, userADisplay: string,
  userBId: string, userBUsername: string, userBDisplay: string,
) {
  const userAParticipations = await db.select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, userAId));

  const userAConvIds = userAParticipations.map((p) => p.conversationId);

  if (userAConvIds.length > 0) {
    const existing = await db.select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(and(eq(conversationParticipants.userId, userBId), inArray(conversationParticipants.conversationId, userAConvIds)));

    if (existing.length > 0) {
      const [conv] = await db.select().from(conversations).where(
        and(
          eq(conversations.id, existing[0].conversationId),
          eq(conversations.type, "private"),
          eq(conversations.isClosed, false),
        )
      );
      if (conv) return conv;
    }
  }

  const id = randomUUID();
  const [conv] = await db.insert(conversations).values({
    id,
    type: "private",
    name: null,
    avatarColor: pickAvatarColor(userBUsername),
    createdBy: userAId,
    groupOwner: null,
    isClosed: false,
    isPassivated: false,
    lastMessageType: "text",
  }).returning();

  await db.insert(conversationParticipants).values([
    { id: randomUUID(), conversationId: id, userId: userAId, username: userAUsername, displayName: userADisplay, unreadCount: 0 },
    { id: randomUUID(), conversationId: id, userId: userBId, username: userBUsername, displayName: userBDisplay, unreadCount: 0 },
  ]);

  await incrementChatListVersion(userAId);
  await incrementChatListVersion(userBId);

  return conv;
}

export function registerChatSyncRoutes(app: Express): void {
  // ─── GET conversation list (chat inbox) ─────────────────────────────────────
  // Mirrors fusion FusionPktGetChats(551) → FusionPktChat(560) × N → FusionPktLatestMessagesDigest(563)
  app.get("/api/chatsync/conversations", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const participations = await db.select({
      conversationId: conversationParticipants.conversationId,
      unreadCount: conversationParticipants.unreadCount,
    }).from(conversationParticipants).where(eq(conversationParticipants.userId, userId));

    if (participations.length === 0) {
      const chatListVersion = await getChatListVersion(userId);
      return res.status(200).json({ conversations: [], chatListVersion });
    }

    const convIds = participations.map((p) => p.conversationId);
    const unreadMap = Object.fromEntries(participations.map((p) => [p.conversationId, p.unreadCount]));

    const convRows = await db.select().from(conversations)
      .where(and(inArray(conversations.id, convIds), eq(conversations.isClosed, false)))
      .orderBy(desc(conversations.lastMessageAt));

    const allParticipants = await db.select().from(conversationParticipants)
      .where(inArray(conversationParticipants.conversationId, convIds));

    // Fetch displayGUID (profile picture) for all participant userIds
    const allUserIds = [...new Set(allParticipants.map((p) => p.userId))];
    const profileRows = allUserIds.length > 0
      ? await db.select({ userId: userProfiles.userId, displayPicture: userProfiles.displayPicture })
          .from(userProfiles)
          .where(inArray(userProfiles.userId, allUserIds))
      : [];
    const profileMap = Object.fromEntries(profileRows.map((p) => [p.userId, p.displayPicture]));

    const chatListVersion = await getChatListVersion(userId);

    const result = convRows.map((conv) => {
      const members = allParticipants.filter((p) => p.conversationId === conv.id);
      const others = members.filter((p) => p.userId !== userId);
      const displayName = conv.type === "private"
        ? (others[0]?.displayName || others[0]?.username || "Unknown")
        : (conv.name ?? "Group Chat");
      const avatarInitial = displayName.charAt(0).toUpperCase();
      const avatarColor = conv.type === "private"
        ? pickAvatarColor(others[0]?.username ?? displayName)
        : conv.avatarColor;

      // displayGUID: for private chats, return the other user's profile picture URL
      // mirrors fusion ChatDefinition.displayGUID used by ImageHandler.loadDisplayPictureFromGuid
      const displayGUID = conv.type === "private"
        ? (profileMap[others[0]?.userId ?? ""] ?? null)
        : null;

      const passivated = isPassivated(conv.lastMessageAt, conv.createdAt);

      return {
        id: conv.id,
        type: conv.type,
        name: displayName,
        avatarInitial,
        avatarColor,
        displayGUID,
        groupOwner: conv.groupOwner,
        lastMessageText: conv.lastMessageText,
        lastMessageType: conv.lastMessageType,
        lastMessageAt: conv.lastMessageAt,
        unreadCount: unreadMap[conv.id] ?? 0,
        isClosed: conv.isClosed,
        isPassivated: passivated,
        members: members.map((m) => ({
          userId: m.userId,
          username: m.username,
          displayName: m.displayName,
          displayGUID: profileMap[m.userId] ?? null,
        })),
      };
    });

    return res.status(200).json({ conversations: result, chatListVersion });
  });

  // ─── GET messages in a conversation ─────────────────────────────────────────
  app.get("/api/chatsync/conversations/:id/messages", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const [participant] = await db.select().from(conversationParticipants)
      .where(and(eq(conversationParticipants.conversationId, req.params.id), eq(conversationParticipants.userId, userId)));
    if (!participant) return res.status(403).json({ message: "Kamu bukan anggota percakapan ini" });

    const messages = await db.select().from(conversationMessages)
      .where(eq(conversationMessages.conversationId, req.params.id))
      .orderBy(conversationMessages.createdAt)
      .limit(200);

    await db.update(conversationParticipants)
      .set({ unreadCount: 0 })
      .where(and(eq(conversationParticipants.conversationId, req.params.id), eq(conversationParticipants.userId, userId)));

    return res.status(200).json({ messages });
  });

  // ─── POST start a private chat ───────────────────────────────────────────────
  app.post("/api/chatsync/conversations/private", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const { targetUsername } = req.body as { targetUsername?: string };
    if (!targetUsername) return res.status(400).json({ message: "targetUsername wajib diisi" });

    const [me] = await db.select().from(users).where(eq(users.id, req.session.userId));
    if (!me) return res.status(401).json({ message: "User tidak valid" });

    const [target] = await db.select().from(users).where(
      sql`lower(${users.username}) = lower(${targetUsername})`
    );
    if (!target) return res.status(404).json({ message: `User '${targetUsername}' tidak ditemukan` });
    if (target.id === me.id) return res.status(400).json({ message: "Tidak bisa chat dengan diri sendiri" });

    const conv = await getOrCreatePrivateConversation(
      me.id, me.username, me.displayName ?? me.username,
      target.id, target.username, target.displayName ?? target.username,
    );

    const members = await db.select().from(conversationParticipants).where(eq(conversationParticipants.conversationId, conv.id));
    return res.status(200).json({
      conversation: { ...conv, members: members.map((m) => ({ userId: m.userId, username: m.username })) },
    });
  });

  // ─── POST create a group chat ────────────────────────────────────────────────
  app.post("/api/chatsync/conversations/group", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const { name, memberUsernames } = req.body as { name?: string; memberUsernames?: string[] };
    if (!name?.trim()) return res.status(400).json({ message: "Nama grup wajib diisi" });
    if (!Array.isArray(memberUsernames) || memberUsernames.length === 0) {
      return res.status(400).json({ message: "Minimal satu anggota selain kamu" });
    }

    const [me] = await db.select().from(users).where(eq(users.id, req.session.userId));
    if (!me) return res.status(401).json({ message: "User tidak valid" });

    const targetUsers = await db.select().from(users).where(
      inArray(sql`lower(${users.username})`, memberUsernames.map((u) => u.toLowerCase()))
    );

    const id = randomUUID();
    const [conv] = await db.insert(conversations).values({
      id,
      type: "group",
      name: name.trim(),
      avatarColor: pickAvatarColor(name.trim()),
      createdBy: me.id,
      groupOwner: me.username,
      isClosed: false,
      isPassivated: false,
      lastMessageType: "system",
    }).returning();

    const memberValues = [
      { id: randomUUID(), conversationId: id, userId: me.id, username: me.username, displayName: me.displayName ?? me.username, unreadCount: 0 },
      ...targetUsers.map((u) => ({
        id: randomUUID(), conversationId: id, userId: u.id, username: u.username,
        displayName: u.displayName ?? u.username, unreadCount: 0,
      })),
    ];
    await db.insert(conversationParticipants).values(memberValues);

    const systemMsg = await db.insert(conversationMessages).values({
      id: randomUUID(), conversationId: id, senderId: null,
      senderUsername: "System",
      text: `${me.username} membuat grup "${name.trim()}"`,
      type: "system",
    }).returning();

    await db.update(conversations).set({
      lastMessageText: systemMsg[0].text,
      lastMessageType: "system",
      lastMessageAt: systemMsg[0].createdAt,
    }).where(eq(conversations.id, id));

    // Increment chatListVersion for all members (mirrors CurrentChatList.update)
    for (const m of memberValues) {
      await incrementChatListVersion(m.userId);
    }

    return res.status(201).json({
      conversation: conv,
      members: memberValues.map((m) => ({ userId: m.userId, username: m.username })),
    });
  });

  // ─── POST send a message ─────────────────────────────────────────────────────
  // messageType: "text" | "image" | "sticker" | "system"
  // mirrors fusion ContentTypeEnum: TEXT=1, IMAGE=2, EMOTE/STICKER=6
  app.post("/api/chatsync/conversations/:id/messages", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;
    const { text, type = "text" } = req.body as { text?: string; type?: string };
    if (!text?.trim()) return res.status(400).json({ message: "Pesan tidak boleh kosong" });

    const [participant] = await db.select().from(conversationParticipants)
      .where(and(eq(conversationParticipants.conversationId, req.params.id), eq(conversationParticipants.userId, userId)));
    if (!participant) return res.status(403).json({ message: "Kamu bukan anggota percakapan ini" });

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, req.params.id));
    if (!conv) return res.status(404).json({ message: "Percakapan tidak ditemukan" });
    if (conv.isClosed) return res.status(403).json({ message: "Percakapan ini sudah ditutup" });

    const [msg] = await db.insert(conversationMessages).values({
      id: randomUUID(), conversationId: req.params.id,
      senderId: userId, senderUsername: participant.username,
      text: text.trim(), type,
    }).returning();

    // Update last message + reset passivated if new message arrives
    await db.update(conversations).set({
      lastMessageText: text.trim(),
      lastMessageType: type,
      lastMessageAt: msg.createdAt,
      isPassivated: false,
    }).where(eq(conversations.id, req.params.id));

    await db.update(conversationParticipants)
      .set({ unreadCount: sql`${conversationParticipants.unreadCount} + 1` })
      .where(and(
        eq(conversationParticipants.conversationId, req.params.id),
        ne(conversationParticipants.userId, userId),
      ));

    const members = await db.select().from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, req.params.id));

    // Cache message in Redis sorted set (CV:{id}:M) — mirrors RedisChatSyncStore
    await saveChatMessage(req.params.id, msg.id, JSON.stringify(msg));

    // Server-generated RECEIVED event — mirrors ServerGeneratedReceivedEventPusher.java
    // Stores RECEIVED status in Redis (CV:{id}:E) and pushes MESSAGE_STATUS back
    // to the sender so their UI flips ✓ (sent) → ✓ (delivered to server).
    await pushServerGeneratedReceivedEvent(
      req.params.id,
      msg.id,
      userId,
      participant.username,
      new Date(msg.createdAt).getTime(),
    );

    for (const member of members) {
      if (member.userId !== userId) {
        if (isUserOnline(member.userId)) {
          // User is connected — push directly via WebSocket
          broadcastToUser(member.userId, {
            type: "CHAT_MESSAGE",
            conversationId: req.params.id,
            message: msg,
          });
        } else {
          // User is offline — queue in Redis (U:{id}:OLMSG:{date})
          // mirrors RedisChatSyncStore offline message queuing
          await saveOfflineMessage(
            member.userId,
            JSON.stringify({
              type: "CHAT_MESSAGE",
              conversationId: req.params.id,
              message: msg,
            }),
          );
        }

        // Gift notification — create ALERT for recipient when a gift message is received
        if (type === "gift") {
          const giftMatch = text.trim().match(/gives an? (\w+)/i);
          const giftName = giftMatch ? giftMatch[1] : "a gift";
          const notifMsg = `${member.username} Receive a gift ${giftName} from ${participant.username}`;
          storage.createNotification({
            username: member.username,
            type: NOTIFICATION_TYPE.ALERT,
            subject: "Gift Received",
            message: notifMsg,
            status: NOTIFICATION_STATUS.PENDING,
          }).catch(() => {});
        }
      }
    }

    return res.status(201).json({ message: msg });
  });

  // ─── POST mark conversation as read ─────────────────────────────────────────
  // Mirrors FusionPktMessageStatusEvent (pkt 505) READ status — marks messages as read
  // and pushes READ_RECEIPT WS event back to sender(s)
  app.post("/api/chatsync/conversations/:id/read", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;
    const convId = req.params.id;

    // Reset unread counter for this participant
    await db.update(conversationParticipants)
      .set({ unreadCount: 0 })
      .where(and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId),
      ));

    // Find current user's username for the receipt
    const [me] = await db.select({ username: users.username }).from(users).where(eq(users.id, userId));
    if (!me) return res.status(200).json({ ok: true });

    const readAt = new Date();

    // Find unread messages from other senders in this conversation
    // (readAt is null means not yet read by recipient)
    const unreadMessages = await db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, convId),
          ne(conversationMessages.senderUsername, me.username),
          isNull(conversationMessages.readAt),
        ),
      );

    if (unreadMessages.length > 0) {
      const messageIds = unreadMessages.map((m) => m.id);

      // Mark all as read in DB
      await db
        .update(conversationMessages)
        .set({ readAt, readBy: me.username })
        .where(and(
          eq(conversationMessages.conversationId, convId),
          ne(conversationMessages.senderUsername, me.username),
          isNull(conversationMessages.readAt),
        ));

      // Persist each read event in Redis sorted set (CV:{convId}:E)
      // mirrors RedisChatSyncStore MessageStatusEvent storage
      for (const msgId of messageIds) {
        await saveMessageStatusEvent(convId, msgId, me.username, readAt);
      }

      // Push READ_RECEIPT to each unique sender — mirrors FusionPktMessageStatusEvent (pkt 505)
      // Java: statusEventType = READ (2), source = reader, destination = sender
      const senderIds = [...new Set(unreadMessages.map((m) => m.senderId).filter(Boolean))] as string[];
      for (const senderId of senderIds) {
        broadcastToUser(senderId, {
          type: "READ_RECEIPT",
          conversationId: convId,
          messageIds,
          readByUsername: me.username,
          readAt: readAt.toISOString(),
        });
      }
    }

    return res.status(200).json({ ok: true });
  });

  // ─── DELETE leave / close a conversation ────────────────────────────────────
  app.delete("/api/chatsync/conversations/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const [participant] = await db.select().from(conversationParticipants)
      .where(and(eq(conversationParticipants.conversationId, req.params.id), eq(conversationParticipants.userId, userId)));
    if (!participant) return res.status(403).json({ message: "Kamu bukan anggota percakapan ini" });

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, req.params.id));
    if (!conv) return res.status(404).json({ message: "Percakapan tidak ditemukan" });

    if (conv.type === "private") {
      await db.update(conversations).set({ isClosed: true }).where(eq(conversations.id, req.params.id));
      // Mirror RedisChatSyncStore OldChatList: archive closed private conv for this user
      await addToOldChatList(userId, req.params.id);
      await incrementChatListVersion(userId);
      return res.status(200).json({ message: "Percakapan ditutup" });
    }

    await db.delete(conversationParticipants).where(
      and(eq(conversationParticipants.conversationId, req.params.id), eq(conversationParticipants.userId, userId))
    );
    // Mirror RedisChatSyncStore OldChatList: archive left group conv for this user
    await addToOldChatList(userId, req.params.id);
    const remainingCount = await db.select({ count: sql<number>`count(*)` })
      .from(conversationParticipants).where(eq(conversationParticipants.conversationId, req.params.id));
    if ((remainingCount[0]?.count ?? 0) === 0) {
      await db.delete(conversations).where(eq(conversations.id, req.params.id));
    }
    await incrementChatListVersion(userId);
    return res.status(200).json({ message: "Kamu keluar dari grup" });
  });

  // ─── GET conversation detail ─────────────────────────────────────────────────
  app.get("/api/chatsync/conversations/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const userId = req.session.userId;

    const [participant] = await db.select().from(conversationParticipants)
      .where(and(eq(conversationParticipants.conversationId, req.params.id), eq(conversationParticipants.userId, userId)));
    if (!participant) return res.status(403).json({ message: "Kamu bukan anggota percakapan ini" });

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, req.params.id));
    if (!conv) return res.status(404).json({ message: "Percakapan tidak ditemukan" });

    const members = await db.select().from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, req.params.id));

    return res.status(200).json({ conversation: conv, members });
  });

  // ─── GET unread total across all conversations ───────────────────────────────
  app.get("/api/chatsync/unread", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const [result] = await db.select({ total: sql<number>`sum(${conversationParticipants.unreadCount})` })
      .from(conversationParticipants).where(eq(conversationParticipants.userId, req.session.userId));
    return res.status(200).json({ unreadTotal: Number(result?.total ?? 0) });
  });

  // ─── GET chatListVersion for current user ────────────────────────────────────
  // Mirrors fusion FusionPktGetChats.getVersion() / FusionPktChatListVersion
  app.get("/api/chatsync/version", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const version = await getChatListVersion(req.session.userId);
    return res.status(200).json({ chatListVersion: version });
  });
}

import type { Express, Request, Response } from "express";
import { requireVerified } from "../../middleware/accessControl";
import { storage } from "../../storage";
import { insertChatroomSchema, insertMessageSchema, CHATROOM_CATEGORIES, LEADERBOARD_TYPE, LEADERBOARD_PERIOD, NOTIFICATION_TYPE, NOTIFICATION_STATUS, CREDIT_TRANSACTION_TYPE } from "@shared/schema";
import { broadcastToRoom, forceRemoveUserFromRoom, softBumpUserFromRoom, getRoleColor, getUserPresence, getRoomCapacityForUser, checkKickCooldown } from "../../gateway";
import { startBot, stopBot, purgeIdleBots, processMessage as botProcessMessage } from "../botservice/botService";
import { getGames } from "../botservice/BotChannelHelper";
import { isRegisteredGame } from "../botservice/BotLoader";
import { awardReputationScore } from "../reputation/routes";

// Mirrors Leaderboard.java sendVirtualGift(): increments GiftSent + GiftReceived
// across all four periods so Today / This Week / This Month / All Time tabs
// in the mobile leaderboard all populate correctly.
export function recordGiftLeaderboard(senderUsername: string, recipientUsername: string, count = 1, coinAmount = 0) {
  const periods = [
    LEADERBOARD_PERIOD.DAILY,
    LEADERBOARD_PERIOD.WEEKLY,
    LEADERBOARD_PERIOD.MONTHLY,
    LEADERBOARD_PERIOD.ALL_TIME,
  ];
  for (const period of periods) {
    storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_SENT,     period, senderUsername,    count, true).catch(() => {});
    storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_RECEIVED, period, recipientUsername, count, true).catch(() => {});
    if (coinAmount > 0) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_SENT,     period, senderUsername,    coinAmount, true).catch(() => {});
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_RECEIVED, period, recipientUsername, coinAmount, true).catch(() => {});
    }
  }
}

// Resolves createdBy (user UUID) → username so clients can show "managed by <owner>"
// Mirrors ChatRoom.java: "This room is managed by " + chatRoomData.getCreator()
async function withCreatorUsername(room: Awaited<ReturnType<typeof storage.getChatroom>>) {
  if (!room) return room;
  if (!room.createdBy) return { ...room, creatorUsername: null };
  const creator = await storage.getUser(room.createdBy).catch(() => null);
  return { ...room, creatorUsername: creator?.username ?? null };
}

// Rate limiting for HTTP /gift all — matches GiftAllRateLimitInSeconds in Gift.java
const httpGiftAllLastSent = new Map<string, number>();
const HTTP_GIFT_ALL_RATE_LIMIT_MS = 5_000;

// Rate limiting for HTTP /gift single — matches GiftSingleRateLimitInSeconds = 60s in Gift.java
// key: `${senderUsername}:${recipientLower}:${giftName}`
const httpGiftSingleRateLimitMap = new Map<string, number>();
const HTTP_GIFT_SINGLE_RATE_LIMIT_MS = 5_000;

// Matches StringUtil.implodeUserList(allRecipients, 5) in Gift.java
function httpImplodeUserList(usernames: string[], max = 5): string {
  if (usernames.length === 0) return "everyone";
  if (usernames.length <= max) return usernames.join(", ");
  const shown = usernames.slice(0, max);
  const rest  = usernames.length - max;
  return `${shown.join(", ")} and ${rest} more`;
}

// Matches Gift.java: "a" or "an" depending on first letter of gift name
function giftArticle(name: string): string {
  return /^[aeiou]/i.test(name) ? "an" : "a";
}

// Gift messages always show [level] badge — matches Gift.java formatUserNameWithLevel exactly
// Gift.java: return username + " [" + userReputationLevel + "]"
// << sender [level] gives a/an giftName emoji to recipient [level]! >>
function withGiftLevel(username: string, level: number): string {
  return `${username} [${level}]`;
}
// Lookup recipient's level from DB; returns "username [level]" or plain username if not found
async function getRecipientDisplay(username: string): Promise<string> {
  const user = await storage.getUserByUsername(username);
  if (user) {
    const profile = await storage.getUserProfile(user.id);
    return `${user.username} [${profile?.migLevel ?? 1}]`;
  }
  return username;
}


function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const FLAMES_RESULTS = ["Friends", "Love", "Affection", "Marriage", "Enemies", "Siblings"] as const;

function flamesCalc(a: string, b: string): string {
  const combined = (a + b).replace(/\s/g, "").toLowerCase();
  const counts = [...combined].reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {} as Record<string, number>);
  let total = Object.values(counts).reduce((s, v) => s + v, 0);
  const results = [...FLAMES_RESULTS];
  let idx = 0;
  while (results.length > 1) {
    idx = (idx + total - 1) % results.length;
    results.splice(idx, 1);
    if (idx >= results.length) idx = 0;
    total = total > 1 ? total - 1 : total;
  }
  return results[0];
}

async function isAdminOrMod(chatroomId: string, userId: string, room: { createdBy?: string | null }): Promise<boolean> {
  if (room.createdBy === userId) return true;
  if (await storage.isGlobalAdmin(userId)) return true;
  return await storage.isModUser(chatroomId, userId);
}

// Mirrors ChatRoomParticipant.hasAdminOrModeratorRights() in Java:
// isGlobalAdmin() || isGroupAdmin() || isGroupMod() || isRoomOwner() || isModerator()
// Used to determine if a user is protected from being kicked.
async function isProtectedUser(chatroomId: string, userId: string, room: { createdBy?: string | null }): Promise<boolean> {
  if (room.createdBy === userId) return true;
  if (await storage.isModUser(chatroomId, userId)) return true;
  if (await storage.isGlobalAdmin(userId)) return true;
  return false;
}

export function registerChatroomRoutes(app: Express): void {
  app.get("/api/chatrooms/categories", (_req: Request, res: Response) => {
    return res.status(200).json({ categories: CHATROOM_CATEGORIES });
  });

  // Rooms where the current user is an active participant (currently in)
  // Mirrors Android ChatManagerFragment tab 3: CHATROOM_LIST showing user's active rooms
  app.get("/api/chatrooms/my", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const myRooms = await storage.getActiveRoomsByUser(req.session.userId);
    return res.status(200).json({ myRooms });
  });

  app.get("/api/chatrooms", async (req: Request, res: Response) => {
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
    const search = req.query.search as string | undefined;
    let rooms = categoryId
      ? await storage.getChatroomsByCategory(categoryId)
      : await storage.getChatrooms();
    if (search) {
      const q = search.toLowerCase();
      rooms = rooms.filter(
        (r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)
      );
    }
    const chatrooms = await Promise.all(rooms.map(r => withCreatorUsername(r)));
    return res.status(200).json({ chatrooms });
  });

  app.get("/api/chatrooms/:id", async (req: Request, res: Response) => {
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const chatroom = await withCreatorUsername(room);
    return res.status(200).json({ chatroom });
  });

  // Room info: basic details + moderators + banned list (banned visible to owner only)
  app.get("/api/chatrooms/:id/info", async (req: Request, res: Response) => {
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const chatroom = await withCreatorUsername(room);
    const moderators = await storage.getChatroomModerators(req.params.id);
    let bannedUsers: { userId: string; username: string }[] = [];
    if (req.session.userId) {
      const isOwner = room.createdBy === req.session.userId;
      const isMod = await storage.isModUser(req.params.id, req.session.userId);
      if (isOwner || isMod) {
        bannedUsers = await storage.getChatroomBannedUsers(req.params.id);
      }
    }
    return res.status(200).json({ chatroom, moderators, bannedUsers });
  });

  // AccessControl: CREATE_GROUP_CHAT (emailVerified required)
  app.post("/api/chatrooms", requireVerified("CREATE_GROUP_CHAT"), async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet " });
    const parsed = insertChatroomSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    }

    // ── Room Capacity based on Creator Level ──────────────────────────────────
    // Level 1-49  → max 25 participants
    // Level 50+   → max 40 participants
    const creator = await storage.getUser(req.session.userId);
    const creatorLevel = creator?.migLevel ?? 1;
    const allowedCapacity = creatorLevel >= 50 ? 40 : 25;

    // Override maxParticipants — user cannot set higher than their level allows
    const maxParticipants = Math.min(parsed.data.maxParticipants ?? allowedCapacity, allowedCapacity);

    const created = await storage.createChatroom({
      ...parsed.data,
      maxParticipants,
      createdBy: req.session.userId,
    });
    const chatroom = await withCreatorUsername(created);
    return res.status(201).json({ chatroom, allowedCapacity });
  });

  // PATCH /api/chatrooms/:id — update name/description (creator only)
  app.patch("/api/chatrooms/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    if (room.createdBy !== req.session.userId) {
      return res.status(403).json({ message: "Only the owner can edit this room" });
    }
    const { name, description } = req.body as { name?: string; description?: string };
    const trimmedName = (name ?? "").trim();
    if (trimmedName && trimmedName.length > 50) {
      return res.status(400).json({ message: "Nama terlalu panjang (maks 50)" });
    }
    const updated = await storage.updateChatroom(req.params.id, {
      ...(trimmedName ? { name: trimmedName } : {}),
      ...(description !== undefined ? { description: description.trim() || null } : {}),
    });
    if (!updated) return res.status(404).json({ message: "Chatroom not found" });
    const chatroom = await withCreatorUsername(updated);
    return res.status(200).json({ chatroom });
  });

  app.delete("/api/chatrooms/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const chatroom = await storage.getChatroom(req.params.id);
    if (!chatroom) return res.status(404).json({ message: "Chatroom not found" });
    if (chatroom.createdBy !== req.session.userId) {
      return res.status(403).json({ message: "Only the owner can delete a chatroom" });
    }
    await storage.deleteChatroom(req.params.id);
    return res.status(200).json({ message: "Chatroom dihapus" });
  });

  app.get("/api/chatrooms/:id/messages", async (req: Request, res: Response) => {
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const after = req.query.after as string | undefined;
    let messages = await storage.getMessages(req.params.id, after);

    // Filter out messages from users the requester has blocked
    // A logged-in user's block list is applied server-side so blocked senders are invisible
    if (req.session.userId) {
      const me = await storage.getUser(req.session.userId);
      if (me) {
        const blockedUsers = await storage.getBlockedUsers(me.username);
        if (blockedUsers.length > 0) {
          const blockedSet = new Set(blockedUsers.map(u => u.toLowerCase()));
          messages = messages.filter(msg => {
            if (!msg.senderUsername) return true;
            return !blockedSet.has(msg.senderUsername.toLowerCase());
          });
        }
      }
    }

    return res.status(200).json({ messages });
  });

  app.post("/api/chatrooms/:id/messages", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const parsed = insertMessageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid message" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const muted = await storage.isMuted(req.params.id, user.id);
    if (muted) return res.status(403).json({ message: "You are currently muted in this chatroom" });

    const rawText = parsed.data.text.trim();
    const roomId  = req.params.id;
    const color   = await getRoleColor({ userId: user.id, username: user.username, roomId, defaultColor: "2196F3" });

    // ── /gift command interceptor (HTTP path) ──────────────────────────────
    // Matches Gift.java: /gift {recipient|all} {giftName} [-m {message}]
    // /gift all: shower format + billing response (matches GiftAsync.java)
    if (/^\/g(?:ift)?\s+/i.test(rawText)) {
      // /gift all with no gift name — help message (matches Gift.java line 372-376)
      if (/^\/g(?:ift)?\s+all\s*$/i.test(rawText)) {
        return res.status(400).json({ message: 'To buy a gift for all users in this room, type "/gift all <gift name>". Type "/gift list" to see available gifts.' });
      }
      const giftMatch = rawText.match(/^\/g(?:ift)?\s+(\S+)\s+(\S+)(?:\s+-m\s+(.+))?$/i);
      if (!giftMatch) {
        return res.status(400).json({ message: "Format: /gift {username|all} {gift_name} [-m message]" });
      }
      const [, giftRecipient, giftName, giftPersonalMsg] = giftMatch;
      const gift = await storage.getVirtualGiftByName(giftName);
      // Fallback: if gift not in DB catalog, use price from message or default 10
      const giftPrice  = gift?.price ?? 10;
      const giftId     = gift?.id ?? 0;

      const profile       = await storage.getUserProfile(user.id);
      const migLevel      = profile?.migLevel ?? 1;
      const senderDisplay = withGiftLevel(user.username, migLevel);
      const hotkey        = gift?.hotKey ?? "🎁";
      const article       = giftArticle(giftName);
      const isAll         = giftRecipient.toLowerCase() === "all";

      if (isAll) {
        // ── /gift all — shower format (matches GiftAsync.giftAll) ──
        // Rate limit: once per 60 seconds per user
        const now = Date.now();
        const lastSent = httpGiftAllLastSent.get(user.username) ?? 0;
        if (now - lastSent < HTTP_GIFT_ALL_RATE_LIMIT_MS) {
          const waitSec = Math.ceil((HTTP_GIFT_ALL_RATE_LIMIT_MS - (now - lastSent)) / 1000);
          return res.status(429).json({ message: `You can only use /gift all every 60 seconds. Try again in ${waitSec}s.` });
        }

        const allParticipants = await storage.getParticipants(roomId);
        const recipients = allParticipants
          .map(p => p.username)
          .filter(u => u.toLowerCase() !== user.username.toLowerCase());

        if (recipients.length === 0) {
          return res.status(400).json({ message: "There are no other users in the room." });
        }

        const totalCost = giftPrice * recipients.length;
        const acct      = await storage.getCreditAccount(user.username);
        if (acct.balance < totalCost) {
          return res.status(402).json({ message: "You do not have enough credit to purchase the gift" });
        }

        httpGiftAllLastSent.set(user.username, now);
        const updatedAll = await storage.adjustBalance(user.username, -totalCost);
        const remaining = await storage.getCreditAccount(user.username);
        await storage.createCreditTransaction({
          username: user.username,
          type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
          reference: `HTTP-CMD-GIFT-ALL-${Date.now()}`,
          description: `Gift shower: ${giftName} ke ${recipients.length} user`,
          currency: remaining.currency,
          amount: -totalCost,
          fundedAmount: 0,
          tax: 0,
          runningBalance: updatedAll.balance,
        });

        // Shower message — matches GiftAsync.sendGiftShowerMessageToAllUsersInChat()
        const recipientList = httpImplodeUserList(recipients, 5);
        const giftDisplay = gift?.location64x64Png ? giftName : `${giftName} ${hotkey}`;
        let giftText = `<< (shower) *GIFT SHOWER* ${senderDisplay} gives ${article} ${giftDisplay} to ${recipientList}! Hurray!`;
        if (giftPersonalMsg) giftText += ` -- ${giftPersonalMsg}`;
        giftText += " >>";

        const giftMsg = await storage.postMessage(roomId, {
          senderId: user.id, senderUsername: user.username,
          senderColor: color, text: giftText, isSystem: false,
        });

        broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: giftMsg });
        broadcastToRoom(roomId, {
          type: "GIFT", roomId,
          sender: user.username, senderColor: color,
          recipient: "all", giftName, giftEmoji: hotkey,
          giftImageUrl: gift?.location64x64Png ?? undefined,
          price: totalCost, recipientCount: recipients.length,
          message: giftMsg,
          ...(giftPersonalMsg ? { personalMessage: giftPersonalMsg } : {}),
        });

        // Leaderboard: mirrors Leaderboard.java sendVirtualGift() for gift-all shower.
        // All four periods so Today / This Week / This Month / All Time tabs populate.
        const periods = [
          LEADERBOARD_PERIOD.DAILY,
          LEADERBOARD_PERIOD.WEEKLY,
          LEADERBOARD_PERIOD.MONTHLY,
          LEADERBOARD_PERIOD.ALL_TIME,
        ];
        const coinPerRecipHttp = totalCost > 0 ? Math.round(totalCost / Math.max(1, recipients.length)) : 0;
        for (const period of periods) {
          storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_SENT, period, user.username, recipients.length, true).catch(() => {});
          for (const r of recipients) {
            storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_RECEIVED, period, r, 1, true).catch(() => {});
          }
          if (totalCost > 0) {
            storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_SENT, period, user.username, totalCost, true).catch(() => {});
            for (const r of recipients) {
              storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.PARTY_GIFT_RECEIVED, period, r, coinPerRecipHttp, true).catch(() => {});
            }
          }
        }

        // Reputation: award gift-sent XP to sender, gift-received XP to each recipient
        awardReputationScore(user.username, "giftSent", recipients.length).catch(() => {});
        for (const r of recipients) {
          awardReputationScore(r, "giftReceived").catch(() => {});
          // Record gift received and notify each recipient
          storage.createVirtualGiftReceived({
            username: r,
            sender: user.username,
            virtualGiftId: giftId,
            message: giftName,
            isPrivate: 0,
          }).catch(() => {});
          storage.createNotification({
            username: r,
            type: NOTIFICATION_TYPE.ALERT,
            subject: "Gift Received",
            message: `${r} Receive a gift ${giftName} from ${user.username}`,
            status: NOTIFICATION_STATUS.PENDING,
          }).catch(() => {});
        }

        // Billing info returned to sender — matches GiftAllBillingMessageData.java
        return res.status(201).json({
          message: giftMsg,
          billing: {
            text: `Congratulations for sending gifts! You have used ${totalCost} ${remaining.currency} and your estimated remaining balance after gifting will be ${remaining.balance.toFixed(2)} ${remaining.currency}.`,
            totalCost, remainingBalance: remaining.balance, currency: remaining.currency,
          },
        });
      } else {
        // ── /gift <username> — single user — matches Gift.java handleGiftToUserEmote() ──
        const recipientLower = giftRecipient.toLowerCase();

        // Rate limit: 60s per sender+recipient+gift combo (GiftSingleRateLimitInSeconds)
        const rlKey  = `${user.username}:${recipientLower}:${giftName}`;
        const rlNow  = Date.now();
        const rlLast = httpGiftSingleRateLimitMap.get(rlKey) ?? 0;
        if (rlNow - rlLast < HTTP_GIFT_SINGLE_RATE_LIMIT_MS) {
          return res.status(429).json({ message: `You can only send the same gift to ${giftRecipient} every 60 seconds. Try sending a different gift.` });
        }

        // Balance check — "You do not have enough credit to purchase the gift"
        const sAcct = await storage.getCreditAccount(user.username);
        if (sAcct.balance < giftPrice) {
          return res.status(402).json({ message: "You do not have enough credit to purchase the gift" });
        }

        // Apply rate limit and deduct credit — matches contentBean.buyVirtualGift(...)
        httpGiftSingleRateLimitMap.set(rlKey, rlNow);
        const updatedSingle = await storage.adjustBalance(user.username, -giftPrice);
        const singleAcct = await storage.getCreditAccount(user.username);
        await storage.createCreditTransaction({
          username: user.username,
          type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
          reference: `HTTP-CMD-GIFT-${Date.now()}`,
          description: `Gift: ${giftName} dikirim ke @${giftRecipient}`,
          currency: singleAcct.currency,
          amount: -giftPrice,
          fundedAmount: 0,
          tax: 0,
          runningBalance: updatedSingle.balance,
        });

        // Format: << sender [level] gives a/an giftName to recipient [level]! -- msg >>
        // Matches Gift.java handleGiftToUserEmote lines 542-554
        const recipDisplay = await getRecipientDisplay(giftRecipient);
        const singleGiftDisplay = gift?.location64x64Png ? giftName : `${giftName} ${hotkey}`;
        let giftText = `<< ${senderDisplay} gives ${article} ${singleGiftDisplay} to ${recipDisplay}!`;
        if (giftPersonalMsg) giftText += ` -- ${giftPersonalMsg}`;
        giftText += " >>";

        const giftMsg = await storage.postMessage(roomId, {
          senderId: user.id, senderUsername: user.username,
          senderColor: color, text: giftText, isSystem: false,
        });
        broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: giftMsg });
        broadcastToRoom(roomId, {
          type: "GIFT", roomId,
          sender: user.username, senderColor: color,
          recipient: giftRecipient, giftName, giftEmoji: hotkey,
          giftImageUrl: gift?.location64x64Png ?? undefined,
          price: giftPrice, message: giftMsg,
          ...(giftPersonalMsg ? { personalMessage: giftPersonalMsg } : {}),
        });

        // Leaderboard: mirrors Leaderboard.java sendVirtualGift() for single gift
        recordGiftLeaderboard(user.username, giftRecipient, 1, giftPrice);

        // Reputation: award gift XP to sender and recipient
        awardReputationScore(user.username, "giftSent").catch(() => {});
        awardReputationScore(giftRecipient, "giftReceived").catch(() => {});

        // Gift notification — alert the recipient in the Notifications menu
        storage.createNotification({
          username: giftRecipient,
          type: NOTIFICATION_TYPE.ALERT,
          subject: "Gift Received",
          message: `${giftRecipient} Receive a gift ${giftName} from ${user.username}`,
          status: NOTIFICATION_STATUS.PENDING,
        }).catch(() => {});

        // Record in virtual_gifts_received so profile gift count is persisted
        storage.createVirtualGiftReceived({
          username: giftRecipient,
          sender: user.username,
          virtualGiftId: giftId,
          message: giftName,
          isPrivate: 0,
        }).catch(() => {});

        return res.status(201).json({ message: giftMsg });
      }
    }
    // ── End /gift interceptor ──────────────────────────────────────────────

    // ── Bot !command interceptor (HTTP path) ──────────────────────────────
    // Mirrors ChatSession.sendFusionMessageToChatRoom():
    //   messageText.startsWith("!") → chatRoomPrx.sendMessageToBots(username, text)
    // When a bot is active and handles the command, do NOT persist to DB or
    // broadcast — only the bot's own response should appear in chat.
    if (rawText.startsWith("!")) {
      const handled = botProcessMessage(roomId, user.username, rawText);
      if (handled) {
        // Bot consumed the command — return silently (no message saved)
        return res.status(200).json({ ok: true, handled: "bot" });
      }
      // No active bot — fall through and save as plain text
    }
    // ── End bot !command interceptor ─────────────────────────────────────

    // ── Emote / slash-command interceptor ────────────────────────────────
    // Mirrors Emote.java (com.projectgoth.fusion.objectcache.Emote)
    // All logged-in users can use these. Messages are stored in DB (persist).
    // Display color: dark maroon #800020 — rendered without "username:" prefix
    // on the client (senderUsername='').
    if (rawText.startsWith("/")) {
      const tokens   = rawText.split(/\s+/);
      const cmd      = (tokens[0] ?? "").toLowerCase();
      const target   = tokens[1] ?? "";
      const rest     = tokens.slice(1).join(" ");
      const s        = user.username;
      const t        = target;
      const EMOTE_COLOR = "800020";

      type EmoteDef = { action: string; actionTarget: string; random?: "roll" | "d100" | "8ball" | "rps" };
      const EMOTES: Record<string, EmoteDef> = {
        "/roll":       { action: `${s} rolls %r`,                                  actionTarget: `${s} rolls %r`, random: "d100" },
        "/brb":        { action: `${s} will be right back`,                       actionTarget: `${s} will be right back` },
        "/off":        { action: `${s} has been off`,                             actionTarget: `${s} has been off` },
        "/slap":       { action: `* ${s} slaps himself`,                         actionTarget: `* ${s} slaps ${t}` },
        "/hug":        { action: `* ${s} gives himself a hug`,                   actionTarget: `* ${s} hugs ${t}` },
        "/kiss":       { action: `* ${s} blows a kiss to the room`,              actionTarget: `* ${s} kisses ${t}` },
        "/wave":       { action: `* ${s} waves`,                                  actionTarget: `* ${s} waves at ${t}` },
        "/dance":      { action: `* ${s} dances`,                                 actionTarget: `* ${s} dances with ${t}` },
        "/cry":        { action: `* ${s} cries`,                                  actionTarget: `* ${s} cries on ${t}'s shoulder` },
        "/laugh":      { action: `* ${s} laughs out loud`,                        actionTarget: `* ${s} laughs at ${t}` },
        "/poke":       { action: `* ${s} pokes himself`,                          actionTarget: `* ${s} pokes ${t}` },
        "/punch":      { action: `* ${s} punches the air`,                        actionTarget: `* ${s} punches ${t}` },
        "/love":       { action: `* ${s} has too much love to give`,              actionTarget: `* ${s} loves ${t}` },
        "/hi":         { action: `* ${s} waves hi to everyone`,                   actionTarget: `* ${s} waves hi at ${t}` },
        "/clap":       { action: `* ${s} claps`,                                  actionTarget: `* ${s} claps for ${t}` },
        "/bow":        { action: `* ${s} bows`,                                   actionTarget: `* ${s} bows to ${t}` },
        "/sit":        { action: `* ${s} sits down`,                              actionTarget: `* ${s} sits next to ${t}` },
        "/stand":      { action: `* ${s} stands up`,                              actionTarget: `* ${s} stands next to ${t}` },
        "/sleep":      { action: `* ${s} falls asleep`,                           actionTarget: `* ${s} falls asleep on ${t}'s shoulder` },
        "/yawn":       { action: `* ${s} yawns`,                                  actionTarget: `* ${s} yawns at ${t}` },
        "/facepalm":   { action: `* ${s} facepalms`,                              actionTarget: `* ${s} facepalms at ${t}` },
        "/shrug":      { action: `* ${s} shrugs`,                                 actionTarget: `* ${s} shrugs at ${t}` },
        "/lol":        { action: `* ${s} LOLs`,                                   actionTarget: `* ${s} LOLs at ${t}` },
        "/think":      { action: `* ${s} is thinking...`,                         actionTarget: `* ${s} is thinking about ${t}` },
        "/wink":       { action: `* ${s} winks`,                                  actionTarget: `* ${s} winks at ${t}` },
        "/smile":      { action: `* ${s} smiles`,                                 actionTarget: `* ${s} smiles at ${t}` },
        "/stare":      { action: `* ${s} stares into the void`,                   actionTarget: `* ${s} stares at ${t}` },
        "/shake":      { action: `* ${s} shakes his head`,                        actionTarget: `* ${s} shakes ${t}'s hand` },
        "/tackle":     { action: `* ${s} tackles himself`,                        actionTarget: `* ${s} tackles ${t}` },
        "/throw":      { action: `* ${s} throws something`,                       actionTarget: `* ${s} throws something at ${t}` },
        "/pat":        { action: `* ${s} pats himself on the back`,               actionTarget: `* ${s} pats ${t} on the head` },
        "/rofl":       { action: `* ${s} rolls on the floor laughing`,            actionTarget: `* ${s} rolls on the floor laughing at ${t}` },
        "/8ball":      { action: `* ${s} asks the Magic 8ball... %r`,             actionTarget: `* ${s} asks the Magic 8ball about ${t}... %r`, random: "8ball" },
        "/flip":       { action: `* ${s} flips a coin... It's %r!`,              actionTarget: `* ${s} flips a coin... It's %r!`, random: "roll" },
        "/rps":        { action: `* ${s} plays rock-paper-scissors... %r!`,       actionTarget: `* ${s} challenges ${t} to rock-paper-scissors... %r!`, random: "rps" },
      };

      const EIGHT_BALL_ANSWERS = ["Yep", "OK", "Maybe", "No", "Don't Bother", "Definitely", "Ask again later", "Not likely"];
      const RPS_CHOICES        = ["Rock 🪨", "Paper 📄", "Scissors ✂️"];

      function resolveRandom(type?: "roll" | "d100" | "8ball" | "rps"): string {
        if (type === "roll")   return String(Math.floor(Math.random() * 6) + 1);
        if (type === "d100")   return String(Math.floor(Math.random() * 100) + 1);
        if (type === "8ball")  return EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
        if (type === "rps")    return RPS_CHOICES[Math.floor(Math.random() * RPS_CHOICES.length)];
        return "";
      }

      // /me [action] — replaces /me with the sender's username
      if (cmd === "/me") {
        if (!rest) return res.status(400).json({ message: "Usage: /me [action]" });
        const emoteText = `* ${s} ${rest}`;
        const emoteMsg = await storage.postMessage(roomId, {
          senderId: user.id, senderUsername: "", senderColor: EMOTE_COLOR,
          text: emoteText, isSystem: false,
        });
        broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: emoteMsg });
        return res.status(201).json({ message: emoteMsg });
      }

      const emoteDef = EMOTES[cmd];
      if (emoteDef) {
        const rndVal   = resolveRandom(emoteDef.random);
        const template = t ? emoteDef.actionTarget : emoteDef.action;
        const emoteText = template.replace(/%r/g, rndVal);
        const emoteMsg  = await storage.postMessage(roomId, {
          senderId: user.id, senderUsername: "", senderColor: EMOTE_COLOR,
          text: emoteText, isSystem: false,
        });
        broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: emoteMsg });
        return res.status(201).json({ message: emoteMsg });
      }
    }
    // ── End emote interceptor ─────────────────────────────────────────────

    const message = await storage.postMessage(roomId, {
      senderId: user.id,
      senderUsername: user.username,
      senderColor: color,
      text: rawText,
    });
    broadcastToRoom(roomId, { type: "MESSAGE", roomId, message });
    awardReputationScore(user.username, "chatRoomMessage", 1, { text: rawText }).catch(() => {});

    // Mention detection — notify any @mentioned users in the message
    const mentionMatches = rawText.match(/@([a-zA-Z0-9_]+)/g) ?? [];
    for (const mention of [...new Set(mentionMatches)]) {
      const mentionedUsername = mention.slice(1).toLowerCase();
      if (mentionedUsername === user.username.toLowerCase()) continue;
      const mentionedUser = await storage.getUserByUsername(mentionedUsername).catch(() => null);
      if (!mentionedUser) continue;
      storage.createNotification({
        username: mentionedUser.username,
        type: NOTIFICATION_TYPE.ALERT,
        subject: "Mention",
        message: `${user.username} mentioned you in room "${room.name}": "${rawText.slice(0, 60)}${rawText.length > 60 ? '...' : ''}"`,
        status: NOTIFICATION_STATUS.PENDING,
      }).catch(() => {});
    }

    return res.status(201).json({ message });
  });

  app.get("/api/chatrooms/:id/participants", async (req: Request, res: Response) => {
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const participants = await storage.getParticipants(req.params.id);
    // Overlay fresh role color for each participant so admin role/merchant
    // changes (e.g. deactivating a merchant) are reflected in the sidebar
    // immediately without requiring users to rejoin the room.
    const refreshed = await Promise.all(participants.map(async (p) => {
      try {
        const freshColor = await getRoleColor({
          userId: p.id,
          username: p.username,
          roomId: req.params.id,
          defaultColor: p.color || "2196F3",
        });
        return { ...p, color: freshColor };
      } catch {
        return p;
      }
    }));
    return res.status(200).json({ participants: refreshed });
  });

  // HTTP join — DB-only, no broadcast. "has entered" is handled exclusively
  // by the WS SUBSCRIBE packet (matches FusionPktJoinChatRoomOld behaviour
  // where the gateway packet owns the broadcast, not the HTTP session).
  // AccessControl: ENTER_CHATROOM (emailVerified required)
  app.post("/api/chatrooms/:id/join", requireVerified("ENTER_CHATROOM"), async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const banned = await storage.isBanned(req.params.id, user.id);
    if (banned) return res.status(403).json({ message: `You have banned in chatroom ${room.name}` });

    const kickCheck = checkKickCooldown(user.id, req.params.id);
    if (kickCheck.blocked) {
      const remainingSec = Math.ceil(kickCheck.remainingMs / 1000);
      return res.status(403).json({
        message: `You has been kicked in the chatroom ${room.name} wait ${Math.ceil(remainingSec / 60)} minutes for enter this room`,
        code: "KICK_COOLDOWN",
        remainingSeconds: remainingSec,
        roomName: room.name,
      });
    }

    // Owner / mod / global admin bypass lock and capacity checks
    const joinerIsAdmin = await isAdminOrMod(req.params.id, user.id, room);

    if (room.isLocked && !joinerIsAdmin) {
      return res.status(403).json({ message: "You can't enter the chatroom has been locked", code: "ROOM_LOCKED" });
    }

    // ── Capacity check (mirrors fusion ChatRoomPreSE454 logic) ───────────
    const currentParticipants = await storage.getParticipants(req.params.id);
    if (currentParticipants.length >= room.maxParticipants && !joinerIsAdmin) {
      return res.status(403).json({
        message: `This room is full (${room.maxParticipants}/${room.maxParticipants}). Please try again later.`,
        code: "ROOM_FULL",
      });
    }

    const color = await getRoleColor({ userId: user.id, username: user.username, roomId: req.params.id, defaultColor: "2196F3" });
    await storage.joinChatroom(req.params.id, {
      id: user.id, username: user.username,
      displayName: user.displayName || user.username, color,
    });
    await storage.addRecentChatroom(user.id, req.params.id);
    return res.status(200).json({ ok: true });
  });

  // HTTP leave — DB-only, no broadcast. "has left" is handled exclusively
  // by the WS UNSUBSCRIBE packet or the gateway disconnect grace period.
  app.post("/api/chatrooms/:id/leave", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const user = await storage.getUser(req.session.userId);
    if (user) {
      await storage.leaveChatroom(req.params.id, user.id);
    }
    return res.status(200).json({ ok: true });
  });

  // ─── KICK ROUTE (admin/mod = instant kick; regular user = vote kick) ──────
  // Mirrors Kick.java: admin/mod → direct kick; others → voteToKickUser()
  // Vote kick: VOTE_KICK_THRESHOLD votes from different users required to execute kick
  // Rate limit: 60/1M per instigator, 5/1S per chatroom (KickPerInstigatorRateLimitExpr)

  const VOTE_KICK_THRESHOLD = 3;
  const voteKickMap = new Map<string, Set<string>>(); // key: `${roomId}:${targetUsername}`
  const voteKickRateMap = new Map<string, { count: number; windowStart: number }>();
  const voteKickRoomRateMap = new Map<string, { count: number; windowStart: number }>();

  function checkVoteKickRateLimit(key: string, maxCount: number, windowMs: number, map: Map<string, { count: number; windowStart: number }>): boolean {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      map.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= maxCount) return false;
    entry.count++;
    return true;
  }

  app.post("/api/chatrooms/:id/kick/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User not found" });

    const voterIsAdmin = await isAdminOrMod(req.params.id, req.session.userId, room);

    // Mirrors voteToKickUser: allowKicking=false only blocks regular users, not admin/mod
    if (!room.allowKick && !voterIsAdmin) {
      return res.status(403).json({ message: "Kicking is not allowed in this chatroom" });
    }

    // Mirrors hasAdminOrModeratorRights(): target is protected if they are owner, mod, or global admin
    const targetIsProtected = await isProtectedUser(req.params.id, target.id, room);

    if (voterIsAdmin) {
      // Admin/mod: instant kick (mirrors voteToKickUser admin branch in ChatRoom.java)
      if (target.id === req.session.userId) {
        return res.status(400).json({ message: "You cannot kick yourself." });
      }
      // Mirrors: "User is an admin or moderator and cannot be kicked"
      if (targetIsProtected) {
        return res.status(403).json({ message: "Admin or moderator cannot be kicked." });
      }
      await storage.leaveChatroom(req.params.id, target.id);
      forceRemoveUserFromRoom(target.id, req.params.id, room.name, "kicked");
      const systemMsg = await storage.postMessage(req.params.id, {
        senderUsername: "System", senderColor: "#FF4444",
        text: `⚑ ${req.params.username} has been kicked from the chatroom`, isSystem: true,
      });
      const participants = await storage.getParticipants(req.params.id);
      broadcastToRoom(req.params.id, { type: "KICKED", roomId: req.params.id, username: req.params.username });
      broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
      broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
      return res.status(200).json({ message: `${req.params.username} kicked`, kicked: true });
    } else {
      // Regular user: vote to kick (mirrors Kick.java voteToKickUser — non-admin branch)
      const me = await storage.getUser(req.session.userId);
      if (!me) return res.status(401).json({ message: "Invalid session." });
      if (target.id === req.session.userId) {
        return res.status(400).json({ message: "You cannot vote to kick yourself." });
      }
      // Mirrors: "User is an admin or moderator and cannot be kicked"
      if (targetIsProtected) {
        return res.status(403).json({ message: "Admin or moderator cannot be kicked." });
      }

      // Rate limit: 60/1M per instigator
      if (!checkVoteKickRateLimit(`vk:u:${me.username}`, 60, 60_000, voteKickRateMap)) {
        return res.status(429).json({ message: "You are voting to kick too quickly. Slow down (limit: 60 per minute)." });
      }
      // Rate limit: 5/1S per chatroom
      if (!checkVoteKickRateLimit(`vk:r:${req.params.id}`, 5, 1_000, voteKickRoomRateMap)) {
        return res.status(429).json({ message: "Too many kick votes in this room right now. Try again shortly." });
      }

      const voteKey = `${req.params.id}:${req.params.username.toLowerCase()}`;
      if (!voteKickMap.has(voteKey)) voteKickMap.set(voteKey, new Set());
      const votes = voteKickMap.get(voteKey)!;

      if (votes.has(me.username)) {
        return res.status(409).json({ message: `You have already voted to kick ${req.params.username}.`, votes: votes.size, threshold: VOTE_KICK_THRESHOLD });
      }
      votes.add(me.username);

      const voteMsg = await storage.postMessage(req.params.id, {
        senderUsername: "System", senderColor: "#FF8C00",
        text: `🗳️ ${me.username} voted to kick ${req.params.username}. (${votes.size}/${VOTE_KICK_THRESHOLD} votes)`, isSystem: true,
      });
      broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: voteMsg });
      broadcastToRoom(req.params.id, { type: "VOTE_KICK", roomId: req.params.id, target: req.params.username, votes: votes.size, threshold: VOTE_KICK_THRESHOLD });

      if (votes.size >= VOTE_KICK_THRESHOLD) {
        // Threshold reached — execute kick
        voteKickMap.delete(voteKey);
        await storage.leaveChatroom(req.params.id, target.id);
        forceRemoveUserFromRoom(target.id, req.params.id, room.name, "kicked");
        const kickMsg = await storage.postMessage(req.params.id, {
          senderUsername: "System", senderColor: "#FF4444",
          text: `⚑ ${req.params.username} has been kicked from the chatroom by vote (${votes.size} votes).`, isSystem: true,
        });
        const participants = await storage.getParticipants(req.params.id);
        broadcastToRoom(req.params.id, { type: "KICKED", roomId: req.params.id, username: req.params.username });
        broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: kickMsg });
        broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
        return res.status(200).json({ message: `${req.params.username} kicked by vote`, kicked: true, votes: votes.size });
      }

      return res.status(200).json({
        message: `Your vote to kick ${req.params.username} has been recorded. (${votes.size}/${VOTE_KICK_THRESHOLD})`,
        kicked: false, votes: votes.size, threshold: VOTE_KICK_THRESHOLD,
      });
    }
  });

  // ─── /kick clear [username] — clears vote kicks for a user (admin/mod only) ─
  // Mirrors Kick.java: /kick clear [username] or /kick c [username]
  app.post("/api/chatrooms/:id/cmd/kick/clear/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can clear kick votes." });
    const voteKey = `${req.params.id}:${req.params.username.toLowerCase()}`;
    const hadVotes = voteKickMap.has(voteKey);
    voteKickMap.delete(voteKey);
    const me = await storage.getUser(req.session.userId);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#4CAF50",
      text: `✅ Kick votes for ${req.params.username} have been cleared by ${me?.username ?? "mod"}.`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: `Kick votes for ${req.params.username} cleared.`, hadVotes });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN TOOLS (owner / mod only)
  // Logic ported from Java: Ban.java, Unban.java, Mute.java, Unmute.java
  // com.projectgoth.fusion.emote
  // ═══════════════════════════════════════════════════════════════════════════

  // GroupBanReasonEnum — mirrors com.projectgoth.fusion.common.Enums
  const BAN_REASON_CODES: Record<number, string> = {
    1: "spamming in the chatroom",
    2: "flooding in the chatroom",
    3: "abusing",
    4: "hacking",
    5: "imposter",
  };
  const BAN_REASON_LABEL = Object.entries(BAN_REASON_CODES)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  // GroupUnbanReasonEnum — mirrors com.projectgoth.fusion.common.Enums
  const UNBAN_REASON_CODES: Record<number, string> = {
    1: "giving user his first chance",
    2: "giving user his last chance",
  };
  const UNBAN_REASON_LABEL = Object.entries(UNBAN_REASON_CODES)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  // Rate limiter — mirrors SystemProperty BAN/MUTE RateLimitExpr "30/1M"
  // key → { count, windowStart }
  const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
  function checkRateLimit(key: string, maxCount = 30, windowMs = 60_000): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      rateLimitMap.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= maxCount) return false;
    entry.count++;
    return true;
  }

  // /ban [username] [reasonCode]
  // Mirrors Ban.java: banGroupMembers(), validates reason code, rate-limited per instigator
  app.post("/api/chatrooms/:id/cmd/ban/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Permission denied. Only the room owner or a moderator can ban users." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });
    if (target.id === req.session.userId) return res.status(400).json({ message: "You cannot ban yourself." });

    // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be banned
    if (await isProtectedUser(req.params.id, target.id, room)) {
      return res.status(403).json({ message: "Admin atau moderator tidak bisa di-ban." });
    }

    const reasonCode = parseInt(String(req.body?.reasonCode ?? ""), 10);
    if (!reasonCode || !BAN_REASON_CODES[reasonCode]) {
      return res.status(400).json({
        message: `Please provide a valid reason code. Valid reason codes are: [ ${BAN_REASON_LABEL} ]`,
        usage: "/ban [username] [reasonCode]",
      });
    }

    const me = await storage.getUser(req.session.userId);
    if (!checkRateLimit(`ban:${me?.username ?? req.session.userId}`)) {
      return res.status(429).json({ message: "You are performing this action too quickly. Please slow down." });
    }

    const alreadyBanned = await storage.isBanned(req.params.id, target.id);
    if (alreadyBanned) {
      return res.status(409).json({ message: `${req.params.username} is already banned from this chatroom.` });
    }

    await storage.banUser(req.params.id, target.id);
    forceRemoveUserFromRoom(target.id, req.params.id, room.name, "banned");
    const reason = BAN_REASON_CODES[reasonCode];
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#FF4444",
      text: `🚫 ${req.params.username} has been banned from the chatroom. Reason: ${reason}.`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "BANNED", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({
      message: `${req.params.username} has been banned.`,
      username: req.params.username,
      reasonCode,
      reason,
    });
  });

  // /unban [username] [reasonCode]
  // Mirrors Unban.java: unbanGroupMember(), validates reason code, rate-limited per instigator
  app.post("/api/chatrooms/:id/cmd/unban/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Permission denied. Only the room owner or a moderator can unban users." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });

    const reasonCode = parseInt(String(req.body?.reasonCode ?? ""), 10);
    if (!reasonCode || !UNBAN_REASON_CODES[reasonCode]) {
      return res.status(400).json({
        message: `Please provide a valid reason code. Valid reason codes are: [ ${UNBAN_REASON_LABEL} ]`,
        usage: "/unban [username] [reasonCode]",
      });
    }

    const me = await storage.getUser(req.session.userId);
    if (!checkRateLimit(`unban:${me?.username ?? req.session.userId}`)) {
      return res.status(429).json({ message: "You are performing this action too quickly. Please slow down." });
    }

    const isBanned = await storage.isBanned(req.params.id, target.id);
    if (!isBanned) {
      return res.status(409).json({ message: `${req.params.username} is not currently banned from this chatroom.` });
    }

    await storage.unbanUser(req.params.id, target.id);
    const reason = UNBAN_REASON_CODES[reasonCode];
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#4CAF50",
      text: `✅ ${req.params.username} has been unbanned. Reason: ${reason}.`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "UNBANNED", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({
      message: `${req.params.username} has been unbanned.`,
      username: req.params.username,
      reasonCode,
      reason,
    });
  });

  // /mute [username]
  // Mirrors Mute.java: chatRoomPrx.mute(), rate-limited 30/1M per instigator
  app.post("/api/chatrooms/:id/cmd/mute/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Permission denied. Only the room owner or a moderator can mute users." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });
    if (target.id === req.session.userId) return res.status(400).json({ message: "You cannot mute yourself." });
    // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be muted
    if (await isProtectedUser(req.params.id, target.id, room)) {
      return res.status(403).json({ message: "Admin atau moderator tidak bisa di-mute." });
    }

    const me = await storage.getUser(req.session.userId);
    if (!checkRateLimit(`mute:${me?.username ?? req.session.userId}`)) {
      return res.status(429).json({ message: "You are performing this action too quickly. Please slow down (limit: 30 per minute)." });
    }

    const alreadyMuted = await storage.isMuted(req.params.id, target.id);
    if (alreadyMuted) {
      return res.status(409).json({ message: `${req.params.username} is already muted in this chatroom.` });
    }

    await storage.muteUser(req.params.id, target.id);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#FF8C00",
      text: `🔇 ${req.params.username} has been muted in this chatroom.`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "MUTED", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({ message: `${req.params.username} has been muted.`, username: req.params.username });
  });

  // /unmute [username]
  // Mirrors Unmute.java: chatRoomPrx.unmute(), rate-limited 30/1M per instigator
  app.post("/api/chatrooms/:id/cmd/unmute/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Permission denied. Only the room owner or a moderator can unmute users." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });

    const me = await storage.getUser(req.session.userId);
    if (!checkRateLimit(`unmute:${me?.username ?? req.session.userId}`)) {
      return res.status(429).json({ message: "You are performing this action too quickly. Please slow down (limit: 30 per minute)." });
    }

    const isMuted = await storage.isMuted(req.params.id, target.id);
    if (!isMuted) {
      return res.status(409).json({ message: `${req.params.username} is not currently muted in this chatroom.` });
    }

    await storage.unmuteUser(req.params.id, target.id);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#4CAF50",
      text: `🔊 ${req.params.username} has been unmuted.`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "UNMUTED", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({ message: `${req.params.username} has been unmuted.`, username: req.params.username });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /gift — Mirrors Gift.java (com.projectgoth.fusion.emote)
  // Patterns: /gift list | /gift help | /gift [all|username] [giftName] [-m msg]
  // Gift list and help are exposed as GET; send-gift is POST (requires auth + credit)
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/chatrooms/:id/cmd/gift/list
  // Mirrors Gift.java giftListPattern: /gift list → list available gifts with hotKey + price
  app.get("/api/chatrooms/:id/cmd/gift/list", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const gifts = await storage.getVirtualGifts();
    const list = gifts.map(g => ({
      name: g.name,
      hotKey: g.hotKey,
      imageUrl: g.location64x64Png ?? null,
      price: g.price,
      currency: g.currency,
      vipOnly: g.groupVipOnly,
    }));
    return res.status(200).json({
      message: `${list.length} gift(s) available. Use: /gift [username|all] [gift name] [-m optional message]`,
      gifts: list,
    });
  });

  // GET /api/chatrooms/:id/cmd/gift/help
  // Mirrors Gift.java giftHelpPattern: /gift help → show usage
  app.get("/api/chatrooms/:id/cmd/gift/help", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    return res.status(200).json({
      usage: [
        "/gift [username] [gift name]            — Send a gift to a specific user",
        "/gift [username] [gift name] -m [msg]  — Send a gift with a personal message",
        "/gift all [gift name]                  — Send a gift shower to everyone in the room",
        "/gift list                             — List all available gifts",
        "/gift search [keyword]                 — Search for a gift by name",
        "/gift gifts [username]                 — View gifts received by a user",
      ],
    });
  });

  // GET /api/chatrooms/:id/cmd/gift/search
  // Mirrors Gift.java giftSearchPattern: /gift search [keyword]
  app.get("/api/chatrooms/:id/cmd/gift/search", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const query = (req.query.q as string ?? "").trim();
    if (!query) return res.status(400).json({ message: "Please provide a search keyword. Usage: /gift search [keyword]" });
    const results = await storage.searchVirtualGifts(query, 10);
    if (results.length === 0) {
      return res.status(404).json({ message: `Sorry, there is no gift matching [${query}]` });
    }
    return res.status(200).json({
      message: `Found ${results.length} gift(s) matching "${query}"`,
      gifts: results.map(g => ({ name: g.name, hotKey: g.hotKey, price: g.price, currency: g.currency })),
    });
  });

  // POST /api/chatrooms/:id/cmd/gift/:username
  // Mirrors Gift.java handleGiftToUserEmote():
  //   << sender [level] gives a/an giftName hotKey to recipient [level]! -- msg >>
  // Body: { giftName: string, message?: string }
  // Rate limit: 60s per sender:recipient:gift pair (matches GiftSingleRateLimitInSeconds=60)
  const giftSingleRateMap = new Map<string, number>();
  const GIFT_SINGLE_RATE_MS = 60_000;

  app.post("/api/chatrooms/:id/cmd/gift/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });

    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid session." });

    const { giftName, message: giftPersonalMsg } = req.body as { giftName?: string; message?: string };
    if (!giftName) {
      return res.status(400).json({
        message: "Please specify a gift name.",
        usage: "/gift [username] [gift name] [-m optional message]",
      });
    }

    const gift = await storage.getVirtualGiftByName(giftName);
    if (!gift) {
      const suggestions = await storage.searchVirtualGifts(giftName, 5);
      if (suggestions.length > 0) {
        const names = suggestions.map(g => `${g.name} ${g.hotKey}`).join(", ");
        return res.status(404).json({ message: `Sorry, there is no gift matching [${giftName}], here are some suggestions: ${names}` });
      }
      return res.status(404).json({ message: `Sorry, there is no gift matching [${giftName}]` });
    }

    const recipientUsername = req.params.username;
    const isSelf = recipientUsername.toLowerCase() === user.username.toLowerCase();
    if (isSelf) return res.status(400).json({ message: "You cannot send a gift to yourself." });

    const recipientUser = await storage.getUserByUsername(recipientUsername);
    if (!recipientUser) return res.status(404).json({ message: `User '${recipientUsername}' not found.` });

    // Rate limit — matches GiftSingleRateLimitInSeconds = 60s
    const rateKey = `${user.username.toLowerCase()}:${recipientUsername.toLowerCase()}:${giftName.toLowerCase()}`;
    const now = Date.now();
    const lastSent = giftSingleRateMap.get(rateKey) ?? 0;
    if (now - lastSent < GIFT_SINGLE_RATE_MS) {
      const waitSec = Math.ceil((GIFT_SINGLE_RATE_MS - (now - lastSent)) / 1000);
      return res.status(429).json({ message: `You can only send the same gift to the same user every 60 seconds. Try again in ${waitSec}s.` });
    }

    // Credit check — mirrors GiftAsync.billUser()
    const acct = await storage.getCreditAccount(user.username);
    if (acct.balance < gift.price) {
      return res.status(402).json({ message: `You do not have enough credit to purchase this gift. Required: ${gift.price} ${gift.currency}, Balance: ${acct.balance} ${gift.currency}.` });
    }

    giftSingleRateMap.set(rateKey, now);
    await storage.adjustBalance(user.username, -gift.price);

    // Build message — mirrors GiftSentToUserMessageData constructor
    // "a" or "an" based on first letter
    const article = /^[aeiou]/i.test(giftName) ? "an" : "a";
    const senderProfile = await storage.getUserProfile(user.id);
    const recipProfile  = await storage.getUserProfile(recipientUser.id);
    const senderLevel   = senderProfile?.migLevel ?? 1;
    const recipLevel    = recipProfile?.migLevel ?? 1;
    const hotkey        = gift.hotKey ?? "🎁";

    let giftText = `<< ${user.username} [${senderLevel}] gives ${article} ${giftName} ${hotkey} to ${recipientUsername} [${recipLevel}]!`;
    if (giftPersonalMsg?.trim()) giftText += ` -- ${giftPersonalMsg.trim()}`;
    giftText += " >>";

    const color = await getRoleColor({ userId: user.id, username: user.username, roomId: req.params.id, defaultColor: "2196F3" });
    const giftMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username,
      senderColor: color, text: giftText, isSystem: false,
    });

    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: giftMsg });
    broadcastToRoom(req.params.id, {
      type: "GIFT", roomId: req.params.id,
      sender: user.username, recipient: recipientUsername,
      giftName, giftEmoji: hotkey, price: gift.price,
      ...(giftPersonalMsg?.trim() ? { personalMessage: giftPersonalMsg.trim() } : {}),
    });

    const remaining = await storage.getCreditAccount(user.username);

    // Leaderboard + Reputation for this gift
    recordGiftLeaderboard(user.username, recipientUsername);
    awardReputationScore(user.username, "giftSent").catch(() => {});
    awardReputationScore(recipientUsername, "giftReceived").catch(() => {});

    return res.status(201).json({
      message: giftMsg,
      gift: { name: giftName, hotKey: hotkey, price: gift.price },
      sender: user.username,
      recipient: recipientUsername,
      creditRemaining: remaining.balance,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /sticker [stickerName]
  // Mirrors Sticker.java + StickerDeliveredMessageData.java
  // Checks sticker exists by alias, broadcasts emoteContentType=STICKERS to room
  // Rate limit: STICKER_RATE_LIMIT (default 10/1M)
  // ═══════════════════════════════════════════════════════════════════════════

  const stickerRateMap = new Map<string, { count: number; windowStart: number }>();

  // POST /api/chatrooms/:id/cmd/sticker/:stickerName
  // Body: optional { message?: string }
  app.post("/api/chatrooms/:id/cmd/sticker/:stickerName", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });

    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid session." });

    // Rate limit: 10 per minute — mirrors SystemPropertyEntities.Emote.STICKER_RATE_LIMIT
    const stickerKey = `sticker:${user.username}`;
    const now = Date.now();
    const sEntry = stickerRateMap.get(stickerKey);
    if (!sEntry || now - sEntry.windowStart > 60_000) {
      stickerRateMap.set(stickerKey, { count: 1, windowStart: now });
    } else if (sEntry.count >= 10) {
      return res.status(429).json({ message: "You are sending stickers too quickly. Please slow down (limit: 10 per minute)." });
    } else {
      sEntry.count++;
    }

    // Sanitize sticker name — mirrors StickerDeliveredMessageData.sanitizeStickerName()
    const stickerName = req.params.stickerName.toLowerCase().trim();

    // Lookup sticker by alias — mirrors ContentBean.getStickerDataByNameForUser()
    const sticker = await storage.getEmoticonByAlias(stickerName);
    if (!sticker) {
      // Mirrors EmoteCommandException(ErrorCause.EmoteCommandError.INVALID_STICKER_NAME)
      return res.status(404).json({ message: `Invalid or unknown sticker name '${stickerName}'. Use /emosticker list to see available stickers.` });
    }

    // Build messages — mirrors StickerDeliveredMessageData constructor
    // msgToInstigator: "You sent a sticker '{alias}' {hotKey}"  — NOT in this server (sent via WS to sender only)
    // msgToRecipients: "'{sender}' has sent a sticker '{alias}' {hotKey}" — broadcast to room
    const msgToRoom = `'${user.username}' has sent a sticker '${sticker.alias}'`;

    const isMuted = await storage.isMuted(req.params.id, user.id);
    if (isMuted) return res.status(403).json({ message: "You are currently muted in this chatroom." });

    const color = await getRoleColor({ userId: user.id, username: user.username, roomId: req.params.id, defaultColor: "2196F3" });
    const stickerMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username,
      senderColor: color, text: msgToRoom, isSystem: false,
    });

    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: stickerMsg });
    broadcastToRoom(req.params.id, {
      type: "STICKER", roomId: req.params.id,
      sender: user.username,
      stickerName: sticker.alias,
      emoteContentType: "STICKERS",
    });

    return res.status(201).json({
      message: stickerMsg,
      toInstigator: `You sent a sticker '${sticker.alias}'`,
      sticker: { alias: sticker.alias, packId: sticker.emoticonPackId },
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /whois [username]
  // Mirrors Whois.java (com.projectgoth.fusion.emote)
  // Returns: gender, migLevel, country, presence status, active chatrooms
  // Rate limit: 1/5S per instigator (WhoisRateLimitExpr default "1/5S")
  // Only shows chatrooms if target is in requester's broadcast list (or self)
  // ═══════════════════════════════════════════════════════════════════════════

  const whoisRateMap = new Map<string, number>();

  // GET /api/chatrooms/:id/cmd/whois/:username
  app.get("/api/chatrooms/:id/cmd/whois/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });

    const requester = await storage.getUser(req.session.userId);
    if (!requester) return res.status(401).json({ message: "Invalid session." });

    // Rate limit: 1 per 5 seconds — mirrors WhoisRateLimitExpr = "1/5S"
    const whoisKey = `whois:${requester.username}`;
    const now = Date.now();
    const lastWhois = whoisRateMap.get(whoisKey) ?? 0;
    if (now - lastWhois < 5_000) {
      const waitMs = Math.ceil((5_000 - (now - lastWhois)) / 1000);
      return res.status(429).json({ message: `You are using /whois too quickly. Please wait ${waitMs}s.` });
    }
    whoisRateMap.set(whoisKey, now);

    const targetUsername = req.params.username;
    const targetUser = await storage.getUserByUsername(targetUsername);

    if (!targetUser) {
      // Mirrors: messageData.messageText + " Not Found. **"
      return res.status(404).json({ message: `** ${targetUsername} : Not Found. **` });
    }

    // Load profile — mirrors userBean.getUserProfile() + misBean.getCountry()
    const profile = await storage.getUserProfile(targetUser.id);
    const migLevel = profile?.migLevel ?? 1;
    const gender   = profile?.gender
      ? (profile.gender === "male" ? "Male" : "Female")
      : "Unknown";
    const country  = profile?.country ?? "Unknown";

    // Presence — mirrors userPrx.getOverallFusionPresence()
    const presenceStatus = getUserPresence(targetUser.id);
    const isSelf = targetUser.id === req.session.userId;

    // Active chatrooms — mirrors userPrx.getCurrentChatrooms()
    // Only shown if: target is self OR target is online and in requester's contacts
    let activeChatrooms: string[] = [];
    const isContact = await storage.isFollowing(requester.username, targetUser.username);
    const showChatrooms = isSelf || (presenceStatus !== "offline" && isContact);

    if (showChatrooms) {
      // Find all rooms where the target is a current participant
      const allRooms = await storage.getChatrooms();
      for (const r of allRooms) {
        const parts = await storage.getParticipants(r.id).catch(() => []);
        if (parts.some(p => p.id === targetUser.id)) {
          activeChatrooms.push(r.name);
        }
      }
    }

    // Build whois message — mirrors Whois.java output format exactly:
    // "** username : Gender: X, migLevel: Y, Location: Z. Status: Z. Chatting in: X,Y. **"
    let whoisText = `** ${targetUsername} : Gender: ${gender}, migLevel: ${migLevel}, Location: ${country}.`;
    whoisText += ` Status: ${presenceStatus}.`;
    if (activeChatrooms.length > 0) {
      whoisText += ` Chatting in: ${activeChatrooms.join(", ")}.`;
    }
    whoisText += " **";

    return res.status(200).json({
      raw: whoisText,
      username: targetUsername,
      gender,
      migLevel,
      country,
      status: presenceStatus,
      activeChatrooms: showChatrooms ? activeChatrooms : [],
    });
  });

  // /mod [username]
  app.post("/api/chatrooms/:id/cmd/mod/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    if (room.createdBy !== req.session.userId) return res.status(403).json({ message: "Only owner can mod" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User not found" });
    await storage.modUser(req.params.id, target.id);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#9C27B0",
      text: `⭐ ${req.params.username} has been promoted to Mod`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "MOD", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({ message: `${req.params.username} made into a mod` });
  });

  // /unmod [username]
  app.post("/api/chatrooms/:id/cmd/unmod/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "made into a mod" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    if (room.createdBy !== req.session.userId) return res.status(403).json({ message: "Only owner can unmod" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User not found" });
    await storage.unmodUser(req.params.id, target.id);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#9C27B0",
      text: `🔽 ${req.params.username} telah dicopot dari Mod`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "UNMOD", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({ message: `${req.params.username} in unmod` });
  });

  // /warn [username] — body: { message? }
  app.post("/api/chatrooms/:id/cmd/warn/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can warn" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User not found" });
    const warnMsg = req.body.message ? ` — "${req.body.message}"` : "";
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#FF8C00",
      text: `⚠️ ${req.params.username} mendapat peringatan${warnMsg}`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "WARNED", roomId: req.params.id, username: req.params.username, message: req.body.message });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: `${req.params.username} di-warn` });
  });

  // /kill [username]
  app.post("/api/chatrooms/:id/cmd/kill/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can kill" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User not found" });
    await storage.leaveChatroom(req.params.id, target.id);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#FF4444",
      text: `💀 ${req.params.username} telah dikeluarkan paksa`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "KICKED", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({ message: `${req.params.username} di-kill` });
  });

  // /bump [username] — mirrors Bump.java chatRoomPrx.bumpUser()
  // Moves the target user to the top of the participant list (admin/mod only).
  // Syntax: exactly 2 args (/bump username) — matches Bump.java checkSyntax: cmdArgs.length != 2
  // Rate limit handled in-memory (mirrors Bump.getRateLimitThreshold BUMP_RATE_LIMIT).
  const bumpUserLastMap = new Map<string, number>();
  const BUMP_USER_RATE_LIMIT_MS = 10_000;

  app.post("/api/chatrooms/:id/cmd/bump/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can bump user" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User not found" });
    // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be bumped
    if (await isProtectedUser(req.params.id, target.id, room)) {
      return res.status(403).json({ message: "Admin atau moderator tidak bisa di-bump." });
    }
    const rlKey = `${req.session.userId}:${req.params.id}:${target.id}`;
    const now = Date.now();
    const last = bumpUserLastMap.get(rlKey) ?? 0;
    if (now - last < BUMP_USER_RATE_LIMIT_MS) {
      const waitSec = Math.ceil((BUMP_USER_RATE_LIMIT_MS - (now - last)) / 1000);
      return res.status(429).json({ message: `Rate limit: coba lagi dalam ${waitSec} detik.` });
    }
    bumpUserLastMap.set(rlKey, now);
    // Soft-bump: disconnect user's active connections only, do NOT remove from participants.
    // User stays visible in the participant list and can rejoin immediately (no cooldown).
    softBumpUserFromRoom(target.id, req.params.id);
    const issuer = await storage.getUser(req.session.userId);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "FF8C00",
      text: `${req.params.username} di-bump oleh ${issuer?.username ?? "mod"}`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: `${req.params.username} di-bump (disconnect)` });
  });

  // /bump — move chatroom to top (reset its sort timestamp)
  app.post("/api/chatrooms/:id/cmd/bump", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can bump" });
    await storage.updateChatroom(req.params.id, { createdAt: new Date() });
    const user = await storage.getUser(req.session.userId);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#FF8C00",
      text: `📢 Chatroom di-bump oleh ${user?.username ?? "admin"}`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: "Chatroom di-bump" });
  });

  // /lock
  app.post("/api/chatrooms/:id/cmd/lock", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    if (!await isAdminOrMod(req.params.id, req.session.userId, room)) return res.status(403).json({ message: "Only owner/mod can lock" });
    await storage.updateChatroom(req.params.id, { isLocked: true });
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#795548",
      text: "🔒 Chatroom has been locked. New members cannot join", isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "LOCKED", roomId: req.params.id });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: "Chatroom locked" });
  });

  // /unlock
  app.post("/api/chatrooms/:id/cmd/unlock", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    if (!await isAdminOrMod(req.params.id, req.session.userId, room)) return res.status(403).json({ message: "Only owner/mod can unlock" });
    const unlockCapacityRest = room.createdBy ? await getRoomCapacityForUser(room.createdBy) : 25;
    await storage.updateChatroom(req.params.id, { isLocked: false, maxParticipants: unlockCapacityRest });
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#795548",
      text: "🔓 Chatroom telah dibuka. Member baru dapat bergabung", isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "UNLOCKED", roomId: req.params.id });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: "Chatroom dibuka" });
  });

  // /description [text]
  app.post("/api/chatrooms/:id/cmd/description", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    if (room.createdBy !== req.session.userId) return res.status(403).json({ message: "Only owner can edit description" });
    const text = (req.body.text as string | undefined)?.trim();
    if (!text) return res.status(400).json({ message: "Teks deskripsi wajib diisi" });
    await storage.updateChatroom(req.params.id, { description: text });
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#4CAF50",
      text: `📝 Deskripsi chatroom diubah: "${text}"`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: "Deskripsi diubah" });
  });

  // /broadcast [message]
  app.post("/api/chatrooms/:id/cmd/broadcast", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can broadcast" });
    const msg = (req.body.message as string | undefined)?.trim();
    if (!msg) return res.status(400).json({ message: "Pesan broadcast wajib diisi" });
    const user = await storage.getUser(req.session.userId);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: user?.username ?? "Admin", senderColor: "#2196F3",
      text: `📣 [Broadcast] ${msg}`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: "Broadcast terkirim" });
  });

  // /announce [message]
  app.post("/api/chatrooms/:id/cmd/announce", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can announce" });
    const msg = (req.body.message as string | undefined)?.trim();
    if (!msg) return res.status(400).json({ message: "Pesan announce wajib diisi" });
    const user = await storage.getUser(req.session.userId);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: user?.username ?? "Admin", senderColor: "#2196F3",
      text: `📢 [Announcement] ${msg}`, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "ANNOUNCEMENT", roomId: req.params.id, message: msg });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: "Announcement terkirim" });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /list [size] [startIndex]
  // Mirrors List.java: chatRoomPrx.listParticipants(source, size, startIndex)
  // Rate limit: LIST_RATE_LIMIT per source
  // Usage: /list [size] [start index (optional)]
  // ═══════════════════════════════════════════════════════════════════════════

  const listRateMap = new Map<string, { count: number; windowStart: number }>();

  app.get("/api/chatrooms/:id/cmd/list", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });

    const sizeParam = parseInt(req.query.size as string ?? "", 10);
    const startParam = parseInt(req.query.start as string ?? "1", 10);

    if (isNaN(sizeParam) || sizeParam < 1) {
      return res.status(400).json({ message: "Usage: /list [size] [start index (optional)] — size must be a number larger than 1." });
    }
    if (!isNaN(startParam) && startParam < 1) {
      return res.status(400).json({ message: "You must specify a number larger than 1 for your second parameter." });
    }

    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "Invalid session." });

    // Rate limit: 10/1M per user (mirrors LIST_RATE_LIMIT)
    const now = Date.now();
    const lEntry = listRateMap.get(me.username);
    if (!lEntry || now - lEntry.windowStart > 60_000) {
      listRateMap.set(me.username, { count: 1, windowStart: now });
    } else if (lEntry.count >= 10) {
      return res.status(429).json({ message: "You are using /list too quickly. Please slow down (limit: 10 per minute)." });
    } else {
      lEntry.count++;
    }

    const allParticipants = await storage.getParticipants(req.params.id);
    const startIndex = Math.max(0, startParam - 1);
    const page = allParticipants.slice(startIndex, startIndex + sizeParam);

    const listLines = page.map((p, i) => `${startIndex + i + 1}. ${p.username}`).join("\n");
    const summary = `Participants (${startIndex + 1}–${startIndex + page.length} of ${allParticipants.length}):\n${listLines}`;

    return res.status(200).json({
      total: allParticipants.length,
      size: sizeParam,
      startIndex: startIndex + 1,
      participants: page,
      text: summary,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /suspend [username] [seconds]  &  /unsuspend [username]
  // Mirrors Silence.java: chatRoomPrx.silenceUser(source, username, timeout)
  // Suspend = timed mute; unsuspend = unsilence before timeout
  // Timeout bounds: 30–3600 seconds per individual (defaults from SystemPropertyEntities)
  // Rate limit: 10/1M per instigator
  // ═══════════════════════════════════════════════════════════════════════════

  const SUSPEND_MIN_SECONDS = 30;
  const SUSPEND_MAX_SECONDS = 3600;
  const suspendTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key: `${roomId}:${userId}`
  const suspendRateMap = new Map<string, { count: number; windowStart: number }>();

  app.post("/api/chatrooms/:id/cmd/suspend/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const globalAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!globalAdmin) return res.status(403).json({ message: "Permission denied. /suspend is a system-level command reserved for global admins only." });

    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });
    if (target.id === req.session.userId) return res.status(400).json({ message: "You cannot suspend yourself." });

    const seconds = parseInt(String(req.body?.seconds ?? req.query.seconds ?? ""), 10);
    if (isNaN(seconds) || seconds < SUSPEND_MIN_SECONDS || seconds > SUSPEND_MAX_SECONDS) {
      return res.status(400).json({
        message: `Usage: /suspend [username] [seconds]. Timeout must be between ${SUSPEND_MIN_SECONDS} and ${SUSPEND_MAX_SECONDS} seconds.`,
      });
    }

    const me = await storage.getUser(req.session.userId);
    // Rate limit: 10/1M per instigator
    const now = Date.now();
    const sEntry = suspendRateMap.get(me?.username ?? req.session.userId);
    if (!sEntry || now - sEntry.windowStart > 60_000) {
      suspendRateMap.set(me?.username ?? req.session.userId, { count: 1, windowStart: now });
    } else if (sEntry.count >= 10) {
      return res.status(429).json({ message: "You are performing this action too quickly. Slow down (limit: 10 per minute)." });
    } else {
      sEntry.count++;
    }

    const alreadyMuted = await storage.isMuted(req.params.id, target.id);
    if (alreadyMuted) {
      return res.status(409).json({ message: `${req.params.username} is already muted/suspended in this chatroom.` });
    }

    await storage.muteUser(req.params.id, target.id);

    const timerKey = `${req.params.id}:${target.id}`;
    const existing = suspendTimers.get(timerKey);
    if (existing) clearTimeout(existing);

    // Auto-unsuspend after timeout
    const timer = setTimeout(async () => {
      try {
        const stillMuted = await storage.isMuted(req.params.id, target.id);
        if (stillMuted) {
          await storage.unmuteUser(req.params.id, target.id);
          const autoMsg = await storage.postMessage(req.params.id, {
            senderUsername: "System", senderColor: "#4CAF50",
            text: `🔊 ${req.params.username}'s suspension has expired. They can speak again.`, isSystem: true,
          });
          broadcastToRoom(req.params.id, { type: "UNMUTED", roomId: req.params.id, username: req.params.username });
          broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: autoMsg });
        }
      } catch (_) {}
      suspendTimers.delete(timerKey);
    }, seconds * 1000);
    suspendTimers.set(timerKey, timer);

    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#FF8C00",
      text: `⏸️ ${req.params.username} has been suspended for ${seconds} second(s). They cannot speak until the timeout expires.`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "SUSPENDED", roomId: req.params.id, username: req.params.username, seconds });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({ message: `${req.params.username} suspended for ${seconds}s.`, username: req.params.username, seconds });
  });

  // /unsuspend [username] — remove suspension before timeout (mirrors Unsilence.java)
  app.post("/api/chatrooms/:id/cmd/unsuspend/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const globalAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!globalAdmin) return res.status(403).json({ message: "Permission denied. /unsuspend is a system-level command reserved for global admins only." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });

    const isMuted = await storage.isMuted(req.params.id, target.id);
    if (!isMuted) {
      return res.status(409).json({ message: `${req.params.username} is not currently suspended.` });
    }

    // Clear pending auto-unsuspend timer
    const timerKey = `${req.params.id}:${target.id}`;
    const existing = suspendTimers.get(timerKey);
    if (existing) { clearTimeout(existing); suspendTimers.delete(timerKey); }

    await storage.unmuteUser(req.params.id, target.id);
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#4CAF50",
      text: `🔊 ${req.params.username}'s suspension has been lifted.`, isSystem: true,
    });
    const participants = await storage.getParticipants(req.params.id);
    broadcastToRoom(req.params.id, { type: "UNMUTED", roomId: req.params.id, username: req.params.username });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    broadcastToRoom(req.params.id, { type: "PARTICIPANTS", roomId: req.params.id, participants });
    return res.status(200).json({ message: `${req.params.username} unsuspended.`, username: req.params.username });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /block [username]  &  /unblock [username]
  // Global user block — mirrors blockList table (blockUserGlobal / unblockUserGlobal)
  // Block prevents the blocked user's messages from reaching the blocker (client-side filter)
  // and optionally prevents DM initiation (enforced by the server).
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/chatrooms/:id/cmd/block/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "Invalid session." });
    if (me.username.toLowerCase() === req.params.username.toLowerCase()) {
      return res.status(400).json({ message: "You cannot block yourself." });
    }
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });
    const alreadyBlocked = await storage.isBlockedGlobal(me.username, target.username);
    if (alreadyBlocked) {
      return res.status(409).json({ message: `You have already blocked ${req.params.username}.` });
    }
    await storage.blockUserGlobal(me.username, target.username);
    return res.status(200).json({ message: `${req.params.username} has been blocked. Their messages will no longer appear for you.`, blocked: true });
  });

  app.post("/api/chatrooms/:id/cmd/unblock/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "Invalid session." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });
    const isBlocked = await storage.isBlockedGlobal(me.username, target.username);
    if (!isBlocked) {
      return res.status(409).json({ message: `${req.params.username} is not in your block list.` });
    }
    await storage.unblockUserGlobal(me.username, target.username);
    return res.status(200).json({ message: `${req.params.username} has been unblocked.`, blocked: false });
  });

  // GET /api/chatrooms/:id/cmd/blocklist — view your own block list
  app.get("/api/chatrooms/:id/cmd/blocklist", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "Invalid session." });
    const blocked = await storage.getBlockedUsers(me.username);
    return res.status(200).json({ blockedUsers: blocked, count: blocked.length });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /emote [alias] — Send an emoticon inline in chat
  // Mirrors EmoAndStickerDAO emoticon lookup; broadcasts EMOTE event to room.
  // Any logged-in user can use this command.
  // Rate limit: 20/1M per user
  // ═══════════════════════════════════════════════════════════════════════════

  const emoteRateMap = new Map<string, { count: number; windowStart: number }>();

  app.post("/api/chatrooms/:id/cmd/emote/:alias", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found." });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid session." });

    const isMuted = await storage.isMuted(req.params.id, user.id);
    if (isMuted) return res.status(403).json({ message: "You are currently muted/suspended in this chatroom." });

    // Rate limit: 20/1M per user
    const now = Date.now();
    const eEntry = emoteRateMap.get(user.username);
    if (!eEntry || now - eEntry.windowStart > 60_000) {
      emoteRateMap.set(user.username, { count: 1, windowStart: now });
    } else if (eEntry.count >= 20) {
      return res.status(429).json({ message: "You are sending emoticons too quickly. Please slow down (limit: 20 per minute)." });
    } else {
      eEntry.count++;
    }

    const alias = req.params.alias.toLowerCase().trim();
    const emoticon = await storage.getEmoticonByAlias(alias);
    if (!emoticon) {
      return res.status(404).json({ message: `Emoticon '${alias}' not found. Use /emote list to see available emoticons.` });
    }

    const color = await getRoleColor({ userId: user.id, username: user.username, roomId: req.params.id, defaultColor: "2196F3" });
    const emoteText = `${user.username} used emoticon: [${emoticon.alias}]`;
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username,
      senderColor: color, text: emoteText, isSystem: false,
    });

    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    broadcastToRoom(req.params.id, {
      type: "EMOTE", roomId: req.params.id,
      sender: user.username,
      alias: emoticon.alias,
      emoticonPackId: emoticon.emoticonPackId,
      emoteContentType: "EMOTICONS",
    });

    return res.status(201).json({
      message: chatMsg,
      toInstigator: `You used emoticon '${emoticon.alias}'`,
      emoticon: { alias: emoticon.alias, packId: emoticon.emoticonPackId },
    });
  });

  // GET /api/chatrooms/:id/cmd/emote/list — list available emoticons
  app.get("/api/chatrooms/:id/cmd/emote/list", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const packId = req.query.packId ? parseInt(req.query.packId as string, 10) : undefined;
    const emoticons = await storage.getEmoticons(packId);
    const packs = await storage.getEmoticonPacks(true);
    return res.status(200).json({
      message: `${emoticons.length} emoticon(s) available. Use: /emote [alias]`,
      emoticons: emoticons.map(e => ({ alias: e.alias, packId: e.emoticonPackId })),
      packs: packs.map(p => ({ id: p.id, name: p.name })),
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // USER TOOLS (all logged-in users)
  // ═══════════════════════════════════════════════════════════════════════════

  // /help — daftar semua perintah
  app.get("/api/chatrooms/:id/cmd/help", async (req: Request, res: Response) => {
    const userCmds = [
      { cmd: "/help", desc: "Tampilkan daftar perintah" },
      { cmd: "/list [size] [start?]", desc: "Show chatroom participants list with pagination" },
      { cmd: "/whois [username]", desc: "Lihat info user (gender, level, lokasi, status)" },
      { cmd: "/block [username]", desc: "Block user — their messages will be hidden" },
      { cmd: "/unblock [username]", desc: "Hapus blokir user" },
      { cmd: "/emote [alias]", desc: "Send emoticon to chatroom" },
      { cmd: "/emote list", desc: "Lihat daftar emotikon yang tersedia" },
      { cmd: "/lovematch [username]", desc: "Check your love match percentage with another user" },
      { cmd: "/findmymatch", desc: "Find your best match in the chatroom" },
      { cmd: "/flames [username]", desc: "FLAMES game between you and another user" },
      { cmd: "/getmyluck", desc: "See your daily luck" },
      { cmd: "/throwball [username]", desc: "Throw a ball at a user" },
      { cmd: "/catchball", desc: "Tangkap bola yang dilempar" },
      { cmd: "/stealball", desc: "Steal a ball from another user" },
      { cmd: "/whackit", desc: "Check your strength level" },
      { cmd: "/follow [username]", desc: "Follow user" },
      { cmd: "/unfollow [username]", desc: "Unfollow user" },
      { cmd: "/sticker [name]", desc: "Send sticker to chatroom" },
      { cmd: "/gift [user] [gift] [-m msg]", desc: "Send gift to user" },
      { cmd: "/gift all [gift]", desc: "Send gift to everyone in the room (gift shower)" },
      { cmd: "/gift list", desc: "Lihat daftar gift tersedia" },
      { cmd: "/me [action]", desc: "Show your action (e.g. /me dancing)" },
      { cmd: "/roll", desc: "Lempar dadu 1-100" },
      { cmd: "/slap [username?]", desc: "Slap a user (or yourself)" },
      { cmd: "/hug [username?]", desc: "Peluk user" },
      { cmd: "/kiss [username?]", desc: "Cium user" },
      { cmd: "/wave [username?]", desc: "Lambaikan tangan" },
      { cmd: "/dance [username?]", desc: "Menari" },
      { cmd: "/cry [username?]", desc: "Menangis" },
      { cmd: "/laugh [username?]", desc: "Tertawa" },
      { cmd: "/poke [username?]", desc: "Colek user" },
      { cmd: "/punch [username?]", desc: "Tinju user" },
      { cmd: "/love [username?]", desc: "Ungkapkan cinta" },
      { cmd: "/hi [username?]", desc: "Sapa user" },
      { cmd: "/clap [username?]", desc: "Tepuk tangan" },
      { cmd: "/bow [username?]", desc: "Membungkuk" },
      { cmd: "/sit [username?]", desc: "Duduk" },
      { cmd: "/stand [username?]", desc: "Berdiri" },
      { cmd: "/sleep [username?]", desc: "Tidur" },
      { cmd: "/yawn [username?]", desc: "Menguap" },
      { cmd: "/facepalm [username?]", desc: "Facepalm" },
      { cmd: "/shrug [username?]", desc: "Angkat bahu" },
      { cmd: "/wink [username?]", desc: "Wink" },
      { cmd: "/think [username?]", desc: "Berpikir" },
      { cmd: "/stare [username?]", desc: "Menatap" },
      { cmd: "/pat [username?]", desc: "Pat on the head" },
      { cmd: "/tackle [username?]", desc: "Menerjang user" },
      { cmd: "/rofl [username?]", desc: "Rolling on the floor laughing" },
      { cmd: "/8ball [pertanyaan?]", desc: "Tanya Magic 8-Ball" },
      { cmd: "/flip", desc: "Lempar koin" },
      { cmd: "/rps [username?]", desc: "Play rock-paper-scissors" },
    ];
    const adminCmds = [
      { cmd: "/kick [username]", desc: "Admin/mod: langsung kick. User biasa: vote kick (butuh 3 vote)" },
      { cmd: "/kick clear [username]", desc: "Clear vote kick for user (admin/mod only)" },
      { cmd: "/ban [username] [reasonCode]", desc: "Ban user from chatroom (reason: 1=spam, 2=flood, 3=abuse, 4=hack, 5=imposter)" },
      { cmd: "/unban [username] [reasonCode]", desc: "Cabut ban user (reason: 1=first chance, 2=last chance)" },
      { cmd: "/suspend [username] [seconds]", desc: "Suspend (timed mute) user — auto-expire setelah timeout (30–3600 detik) [GLOBAL ADMIN ONLY]" },
      { cmd: "/unsuspend [username]", desc: "Lift suspend before timeout [GLOBAL ADMIN ONLY]" },
      { cmd: "/mute [username]", desc: "Mute user (permanent until unmuted)" },
      { cmd: "/unmute [username]", desc: "Cabut mute user" },
      { cmd: "/mod [username]", desc: "Jadikan user sebagai Mod (owner only)" },
      { cmd: "/unmod [username]", desc: "Copot status Mod user (owner only)" },
      { cmd: "/warn [username]", desc: "Peringatkan user" },
      { cmd: "/kill [username]", desc: "Force user to leave" },
      { cmd: "/bump [username]", desc: "Force-disconnect (soft kick) user from room — they can rejoin" },
      { cmd: "/bump", desc: "Bump chatroom to the top of the list" },
      { cmd: "/lock", desc: "Kunci chatroom (owner only)" },
      { cmd: "/unlock", desc: "Unlock chatroom (owner only)" },
      { cmd: "/description [teks]", desc: "Ubah deskripsi chatroom (owner only)" },
      { cmd: "/broadcast [pesan]", desc: "Send broadcast to all members" },
      { cmd: "/announce [pesan]", desc: "Send announcement to all members" },
      { cmd: "/bot [gameType]", desc: `Start game bot di room (${getGames().join(", ")})` },
      { cmd: "/bot stop", desc: "Stop game yang sedang berjalan" },
      { cmd: "/botstop ! [timeout?]", desc: "Stop semua bot di room (timeout 120–3600 detik, optional)" },
      { cmd: "/games", desc: "Tampilkan daftar semua game yang tersedia" },
    ];
    return res.status(200).json({ userCmds, adminCmds });
  });

  // /help — post version (creates visible help message in chat)
  app.post("/api/chatrooms/:id/cmd/help", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const helpText = [
      "📋 USER COMMANDS: /list [size] [start] | /whois [user] | /block [user] | /unblock [user] | /emote [alias] | /lovematch [user] | /findmymatch | /flames [user] | /getmyluck | /throwball [user] | /catchball | /stealball | /whackit | /follow [user] | /unfollow [user] | /sticker [name] | /gift [user] [gift]",
      "🔧 ADMIN COMMANDS: /kick [user] | /kick clear [user] | /ban | /unban | /suspend [user] [sec] | /unsuspend | /mute | /unmute | /mod | /unmod | /warn | /kill | /bump | /lock | /unlock | /description | /broadcast | /announce",
    ].join("\n");
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "System", senderColor: "#607D8B",
      text: helpText, isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: systemMsg });
  });

  // /lovematch [username]  — warna #DD587A
  app.post("/api/chatrooms/:id/cmd/lovematch/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const pct = randInt(0, 100);
    const emoji = pct >= 80 ? "💖" : pct >= 50 ? "💕" : pct >= 30 ? "💛" : "💔";
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#DD587A",
      text: `${emoji} ${user.username} ❤️ ${req.params.username}: ${pct}% match!`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg, pct });
  });

  // /findmymatch — warna #DD587A
  app.post("/api/chatrooms/:id/cmd/findmymatch", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const participants = await storage.getParticipants(req.params.id);
    const others = participants.filter((p) => p.id !== user.id);
    if (others.length === 0) {
      return res.status(200).json({ message: "Tidak ada user lain di chatroom ini" });
    }
    const best = others[randInt(0, others.length - 1)];
    const pct = randInt(60, 100);
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#DD587A",
      text: `💖 Pasangan terbaik ${user.username} adalah: ${best.username} — ${pct}% match!`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg, match: best.username, pct });
  });

  // /flames [username]  — warna #DD587A
  app.post("/api/chatrooms/:id/cmd/flames/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const result = flamesCalc(user.username, req.params.username);
    const emoji = result === "Love" ? "❤️" : result === "Friends" ? "👫" : result === "Marriage" ? "💍" : result === "Enemies" ? "⚔️" : "🔥";
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#DD587A",
      text: `🔥 FLAMES: ${user.username} + ${req.params.username} = ${emoji} ${result}`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg, result });
  });

  // /getmyluck  — warna #DD587A
  app.post("/api/chatrooms/:id/cmd/getmyluck", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const love = randInt(0, 100);
    const money = randInt(0, 100);
    const health = randInt(0, 100);
    const success = randInt(0, 100);
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#DD587A",
      text: `🍀 Keberuntungan ${user.username} hari ini — ❤️ Cinta: ${love}% | 💰 Uang: ${money}% | 💪 Kesehatan: ${health}% | ⭐ Sukses: ${success}%`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg, love, money, health, success });
  });

  // /throwball [username]  — warna #FF8C00
  app.post("/api/chatrooms/:id/cmd/throwball/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#FF8C00",
      text: `⚽ ${user.username} melempar bola ke ${req.params.username}!`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg });
  });

  // /catchball  — warna #FF8C00
  app.post("/api/chatrooms/:id/cmd/catchball", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#FF8C00",
      text: `🙌 ${user.username} menangkap bola!`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg });
  });

  // /stealball  — warna #FF8C00
  app.post("/api/chatrooms/:id/cmd/stealball", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const participants = await storage.getParticipants(req.params.id);
    const others = participants.filter((p) => p.id !== user.id);
    const target = others.length > 0 ? others[randInt(0, others.length - 1)].username : "orang lain";
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#FF8C00",
      text: `🤾 ${user.username} mencuri bola dari ${target}!`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg });
  });

  // /whackit  — warna #FF8C00
  app.post("/api/chatrooms/:id/cmd/whackit", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const pct = randInt(1, 100);
    const reactions = ["lemah banget 😅", "lumayan 💪", "kuat juga nih! 🔥", "SUPER KUAT! 💥"];
    const reaction = pct < 25 ? reactions[0] : pct < 50 ? reactions[1] : pct < 80 ? reactions[2] : reactions[3];
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: "#FF8C00",
      text: `🔨 Level kekuatan ${user.username}: ${pct}%! ${reaction}`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg, pct });
  });

  // /follow [username]
  app.post("/api/chatrooms/:id/cmd/follow/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    if (user.username.toLowerCase() === req.params.username.toLowerCase()) {
      return res.status(400).json({ message: "Tidak bisa follow diri sendiri" });
    }
    const followColor = await getRoleColor({ userId: user.id, username: user.username, roomId: req.params.id, defaultColor: "2196F3" });
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: followColor,
      text: `➕ ${user.username} sekarang mengikuti ${req.params.username}`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg });
  });

  // /unfollow [username]
  app.post("/api/chatrooms/:id/cmd/unfollow/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    const unfollowColor = await getRoleColor({ userId: user.id, username: user.username, roomId: req.params.id, defaultColor: "2196F3" });
    const chatMsg = await storage.postMessage(req.params.id, {
      senderId: user.id, senderUsername: user.username, senderColor: unfollowColor,
      text: `➖ ${user.username} berhenti mengikuti ${req.params.username}`,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: chatMsg });
    return res.status(200).json({ message: chatMsg });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FAVOURITES  (mirrors getFavouriteChatRooms in ChatRoomDAO.java)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get("/api/chatrooms/favourites/list", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const chatrooms = await storage.getFavouriteChatrooms(req.session.userId);
    return res.status(200).json({ chatrooms });
  });

  app.post("/api/chatrooms/:id/favourite", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    await storage.addFavouriteChatroom(req.session.userId, req.params.id);
    return res.status(200).json({ ok: true });
  });

  app.delete("/api/chatrooms/:id/favourite", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    await storage.removeFavouriteChatroom(req.session.userId, req.params.id);
    return res.status(200).json({ ok: true });
  });

  app.get("/api/chatrooms/:id/favourite", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const isFav = await storage.isFavouriteChatroom(req.session.userId, req.params.id);
    return res.status(200).json({ isFavourite: isFav });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BOT / GAME COMMANDS
  // Mirrors: Bot.java → StartBot.java / StopBot.java
  //          BotStop.java → StopAllBots.java
  //          Games.java → SendGamesHelpToUser.java
  // ═══════════════════════════════════════════════════════════════════════════

  // /games — tampilkan daftar game ke user (semua member bisa akses)
  // Mirrors: Games.java execute() → SendGamesHelpToUser
  app.get("/api/chatrooms/:id/cmd/games", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const games = getGames();
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "GameBot", senderColor: "FF9800",
      text: `🎮 Game tersedia: ${games.join(", ")} — ketik /bot [nama game] untuk mulai.`,
      isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ games, message: systemMsg });
  });

  // /bot [gameType] — start game bot di room (admin/mod only)
  // Mirrors: Bot.java execute() → StartBot.java → chatRoomPrx.startBot(username, botCommandName)
  app.post("/api/chatrooms/:id/cmd/bot/:gameType", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can start game" });
    const gameType = req.params.gameType.toLowerCase();
    if (!isRegisteredGame(gameType)) {
      return res.status(400).json({ message: `Unknown game. Available: ${getGames().join(", ")}` });
    }
    const user = await storage.getUser(req.session.userId);
    try {
      const bot = await startBot(req.params.id, gameType, user?.username ?? req.session.userId);
      const systemMsg = await storage.postMessage(req.params.id, {
        senderUsername: "GameBot", senderColor: "FF9800",
        text: `🎮 Game "${gameType}" dimulai oleh ${user?.username ?? "admin"}! Ketik !help untuk perintah game.`,
        isSystem: true,
      });
      broadcastToRoom(req.params.id, { type: "BOT_STARTED", roomId: req.params.id, gameType, instanceId: bot.instanceId });
      broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
      return res.status(201).json({ message: systemMsg, gameType, instanceId: bot.instanceId });
    } catch (err: any) {
      return res.status(409).json({ message: err.message ?? "Tidak bisa start game" });
    }
  });

  // /bot stop — stop game yang sedang berjalan (admin/mod only)
  // Mirrors: Bot.java execute() → args[1] === "stop" → StopBot.java → chatRoomPrx.stopBot(username, null)
  app.post("/api/chatrooms/:id/cmd/bot/stop", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can stop game" });
    const user = await storage.getUser(req.session.userId);
    const stopped = stopBot(req.params.id);
    if (!stopped) return res.status(404).json({ message: "Tidak ada game yang aktif di room ini" });
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "GameBot", senderColor: "FF9800",
      text: `🛑 Game dihentikan oleh ${user?.username ?? "admin"}.`,
      isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "BOT_STOPPED", roomId: req.params.id });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: systemMsg });
  });

  // /botstop ! [timeout?] — stop semua bot di room (admin/mod only)
  // Mirrors: BotStop.java execute() → StopAllBots.java → chatRoomPrx.stopAllBots(username, timeout)
  // timeout: 0 = immediate, 120–3600 = delay in seconds before stop
  app.post("/api/chatrooms/:id/cmd/botstop", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can stop all bots" });
    const timeoutRaw = Number(req.body.timeout ?? 0);
    if (req.body.timeout !== undefined && req.body.timeout !== 0) {
      if (isNaN(timeoutRaw) || timeoutRaw < 120 || timeoutRaw > 3600) {
        return res.status(400).json({ message: "Timeout must be between 120 and 3600 seconds" });
      }
    }
    const user = await storage.getUser(req.session.userId);
    const executeStop = () => {
      stopBot(req.params.id);
      purgeIdleBots();
    };
    if (timeoutRaw > 0) {
      const systemMsgScheduled = await storage.postMessage(req.params.id, {
        senderUsername: "GameBot", senderColor: "FF9800",
        text: `⏳ Semua game akan dihentikan dalam ${timeoutRaw} detik oleh ${user?.username ?? "admin"}.`,
        isSystem: true,
      });
      broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsgScheduled });
      setTimeout(executeStop, timeoutRaw * 1000);
      return res.status(200).json({ message: systemMsgScheduled, scheduledIn: timeoutRaw });
    }
    executeStop();
    const systemMsg = await storage.postMessage(req.params.id, {
      senderUsername: "GameBot", senderColor: "FF9800",
      text: `🛑 Semua game dihentikan oleh ${user?.username ?? "admin"}.`,
      isSystem: true,
    });
    broadcastToRoom(req.params.id, { type: "ALL_BOTS_STOPPED", roomId: req.params.id });
    broadcastToRoom(req.params.id, { type: "MESSAGE", roomId: req.params.id, message: systemMsg });
    return res.status(200).json({ message: systemMsg });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RECENT  (mirrors getAllRecentChatRooms / getRecentChatRooms in ChatRoomDAO.java)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get("/api/chatrooms/recent/list", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const chatrooms = await storage.getRecentChatrooms(req.session.userId);
    return res.status(200).json({ chatrooms });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MODERATORS & BANNED LISTS  (mirrors getChatRoomModerators / getChatRoomBannedUsers)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get("/api/chatrooms/:id/moderators", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const moderators = await storage.getChatroomModerators(req.params.id);
    return res.status(200).json({ moderators });
  });

  app.get("/api/chatrooms/:id/banned", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in yet" });
    const room = await storage.getChatroom(req.params.id);
    if (!room) return res.status(404).json({ message: "Chatroom not found" });
    const admin = await isAdminOrMod(req.params.id, req.session.userId, room);
    if (!admin) return res.status(403).json({ message: "Only owner/mod can view banned list" });
    const bannedUsers = await storage.getChatroomBannedUsers(req.params.id);
    return res.status(200).json({ bannedUsers });
  });
}

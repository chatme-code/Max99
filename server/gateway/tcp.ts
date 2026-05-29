/**
 * TCP Gateway — dual-protocol support
 *
 * Protocol detection on first byte received:
 *   0x02 → Binary FusionPacket mode  (Expo Android/iOS mobile app)
 *   0x7B → JSON newline mode         (web debug clients / existing protocol)
 *
 * Binary protocol follows ConnectionTCP.java + FusionPacket.java wire format.
 * JSON protocol follows existing newline-delimited JSON-over-TCP convention.
 *
 * Both protocols share the same business logic and broadcast infrastructure,
 * and interoperate with the WebSocket JSON gateway (gateway.ts).
 */

import * as net        from "net";
import { randomUUID }  from "crypto";
import { log }         from "../logger";
import { maskSensitiveStr } from "../utils/maskSensitive";
import { storage }     from "../storage";
import { broadcastToRoom, DEFAULT_THEME, buildParticipantsPayload, userColor, getRoleColor, cancelWsPendingLeave, registerTcpLeaveCanceller, isUserInRoomViaWs, registerTcpRoomPresence, registerTcpRoomEjector, forceRemoveUserFromRoom, softBumpUserFromRoom, getRoomCapacityForUser, checkKickCooldown } from "../gateway";
import { notifyUserJoin as botNotifyJoin, notifyUserLeave as botNotifyLeave } from "../modules/botservice/botService";
import { scoreToLevel } from "../modules/reputation/routes";
import {
  haveFusionPacket, packetSize, decodePacket,
  getStr, getInt32, getInt16, getUInt8, getLong,
  encodePacket,
  buildLoginChallenge, buildLoginOk, buildError,
  buildPong, buildOk, buildSessionTerminated,
  buildChatroomMessage, buildChatroomInfo, buildChatroomParticipants,
  buildChatroomNotification, buildChatroomUserStatus,
  buildChatroomCategory, buildGetCategorizedChatroomsComplete,
  buildChat, buildEndMessages, buildChatListVersion, buildPrivateMessage,
  PKT, ROOM_NOTIFY, USER_STATUS, DEST_TYPE,
} from "./fusionCodec";
import { db } from "../db";
import {
  conversations, conversationParticipants, conversationMessages, userChatListVersions,
} from "../../shared/schema";
import { eq, and, inArray, desc } from "drizzle-orm";
import { findTokenForUser, consumeTcpToken, verifyTcpToken } from "./tcpTokens";

// ─── Types ────────────────────────────────────────────────────────────────────

type TcpState = "CONNECTING" | "CHALLENGING" | "AUTHENTICATED" | "DISCONNECTED";
type Protocol  = "detecting" | "binary" | "json";

const ErrCode = {
  UNDEFINED:            1,
  INCORRECT_CREDENTIAL: 3,
  INVALID_VERSION:      100,
  UNSUPPORTED_PROTOCOL: 101,
} as const;

const APP_VERSION = "9.0.0";

interface TcpClient {
  socket:    net.Socket;
  id:        string;
  sessionId: string;
  userId?:   string;
  username?: string;
  roomId?:   string;
  state:     TcpState;
  protocol:  Protocol;

  // JSON protocol buffer
  jsonBuffer: string;

  // Binary protocol buffer
  binBuffer:  Buffer;

  // Binary login challenge (stored between LOGIN and LOGIN_RESPONSE)
  loginChallenge?: string;

  connectedAt:      number;
  lastActivity:     number;
  packetCount:      number;
  packetWindowStart: number;
  eventsDispatched: number;
  migLevel:         number;
  isChatroomAdmin:  boolean;

  // Grace period tracking — mirrors WS gateway subscribedRooms / pendingLeaves
  subscribedRooms: Set<string>;
  chatColor:       string;  // resolved role color for enter/leave messages
}

// ─── TCP Disconnect grace period ──────────────────────────────────────────────
// Same 120 s window as the WS gateway.  When a TCP socket drops (network blip,
// OS killed connection) we defer "has left" so the client can reconnect silently.
// TCP from the Expo singleton NEVER closes on back-button press — this grace
// period only fires for genuine network interruptions.
const TCP_LEAVE_GRACE_MS = 120_000;

interface PendingTcpLeave {
  timer:          NodeJS.Timeout;
  roomId:         string;
  userId:         string;
  username:       string;
  color:          string;
  migLevel:       number;
  disconnectedAt: number;  // ms timestamp — used to send missed messages on reconnect
}

const pendingTcpLeaves = new Map<string, PendingTcpLeave>();

// ─── State ────────────────────────────────────────────────────────────────────

const clients       = new Map<string, TcpClient>();
let   clientIdCount = 0;

const RATE_LIMIT_MAX_PACKETS = 20;
const RATE_LIMIT_WINDOW_MS   = 10_000;
const KEEP_ALIVE_TIMEOUT_MS  = 120_000;
const PURGE_INTERVAL_MS      = 30_000;

// ─── Generic helpers ──────────────────────────────────────────────────────────

/** Send JSON string to a client (JSON protocol). */
function sendJson(client: TcpClient, data: object): void {
  try {
    if (!client.socket.destroyed) {
      client.socket.write(JSON.stringify(data) + "\n");
      client.eventsDispatched++;
    }
  } catch { /* ignore */ }
}

/** Send binary FusionPacket buffer to a client (binary protocol). */
function sendBinary(client: TcpClient, buf: Buffer): void {
  try {
    if (!client.socket.destroyed) {
      client.socket.write(buf);
      client.eventsDispatched++;
    }
  } catch { /* ignore */ }
}

/** Dispatch to appropriate send based on client protocol. */
function sendToClient(client: TcpClient, data: object): void {
  if (client.protocol === "binary") {
    // Binary clients don't receive JSON — callers should use sendBinary directly
    // for binary-specific packets. This fallback is for internal shared code paths.
    return;
  }
  sendJson(client, data);
}

/** Send error packet (protocol-aware). */
function sendError(client: TcpClient, code: number, message: string): void {
  if (client.protocol === "binary") {
    sendBinary(client, buildError(0, code, message));
  } else {
    sendJson(client, { type: "ERROR", code, message });
  }
}

function isRateLimited(client: TcpClient): boolean {
  const now = Date.now();
  if (now - client.packetWindowStart > RATE_LIMIT_WINDOW_MS) {
    client.packetWindowStart = now;
    client.packetCount       = 0;
  }
  client.packetCount++;
  return client.packetCount > RATE_LIMIT_MAX_PACKETS;
}

/**
 * Broadcast to all TCP clients in a room (excluding optional id).
 * Sends JSON to JSON clients, binary chatroom message to binary clients.
 */
function broadcastToTcpRoom(
  roomId:      string,
  data:        object,
  excludeId?:  string,
  binBuf?:     Buffer,   // optional pre-built binary packet for binary clients
): void {
  clients.forEach((c, cid) => {
    if (c.roomId === roomId && cid !== excludeId && c.state === "AUTHENTICATED") {
      if (c.protocol === "binary" && binBuf) {
        sendBinary(c, binBuf);
      } else if (c.protocol !== "binary") {
        sendJson(c, data);
      }
    }
  });
}

// ─── Business logic helpers ───────────────────────────────────────────────────

async function handleLeaveRoom(client: TcpClient): Promise<void> {
  if (!client.roomId || !client.userId) return;
  const roomId = client.roomId;
  const room   = await storage.getChatroom(roomId).catch(() => null);

  await storage.leaveChatroom(roomId, client.userId).catch(() => {});

  const leaveUsername    = client.username ?? "user";
  const leaveDisplayName = client.migLevel >= 1
    ? `${leaveUsername}[${client.migLevel}]`
    : leaveUsername;
  const roomLabel = room?.name ?? roomId;
  // Suppress "has left" broadcast for global admins (silent leave).
  const leaverIsGlobalAdmin = await storage.isGlobalAdmin(client.userId).catch(() => false);
  const leaveMsg = leaverIsGlobalAdmin ? null : await storage.postMessage(roomId, {
    senderUsername: leaveUsername,
    senderColor:    userColor(leaveUsername),
    text:           `${roomLabel}::${leaveDisplayName} has left`,
    isSystem:       true,
  }).catch(() => null);

  const list = await storage.getParticipants(roomId).catch(() => []);

  if (leaveMsg) {
    broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
  }
  broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));

  // Notify TCP binary clients in the room
  const participantsBuf = buildChatroomParticipants(0, roomId, list.map((p) => p.username));
  broadcastToTcpRoom(roomId, { type: "USER_LEFT", roomId, username: client.username }, client.id, participantsBuf);

  botNotifyLeave(roomId, leaveUsername);
  client.roomId = undefined;
}

// ─── Binary protocol handler ──────────────────────────────────────────────────

async function handleBinaryPacket(client: TcpClient, type: number, txId: number, fields: Map<number, Buffer>): Promise<void> {
  const pkt = { type, txId, fields };

  switch (type) {

    // ── PING → PONG ─────────────────────────────────────────────────────────
    case PKT.PING: {
      sendBinary(client, buildPong(txId));
      return;
    }

    // ── LOGIN (200) ─────────────────────────────────────────────────────────
    // Client sends: field 1=protocolVersion(short), 2=clientType(byte),
    //               3=clientVersion(short), 5=username(string), 8=deviceName(string)
    // Server responds: LOGIN_CHALLENGE with random challenge + sessionId
    case PKT.LOGIN: {
      if (client.state !== "CONNECTING") {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Already logged in or logging in"));
        return;
      }

      const username = getStr(pkt, 5);
      if (!username) {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Username required"));
        return;
      }

      // Check user exists before issuing challenge (prevents username enumeration
      // but we still validate to match Java server behaviour)
      const user = await storage.getUserByUsername(username);
      if (!user) {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Username or password incorrect"));
        return;
      }

      // Generate and store challenge
      const challenge = randomUUID().replace(/-/g, "").slice(0, 16);
      client.loginChallenge = challenge;
      client.username       = user.username;  // store for LOGIN_RESPONSE lookup
      client.userId         = user.id;
      client.state          = "CHALLENGING";

      sendBinary(client, buildLoginChallenge(txId, challenge, client.sessionId));
      log(`[TCP/binary] LOGIN challenge sent to ${username}`, "gateway-tcp");
      return;
    }

    // ── LOGIN_RESPONSE (202) ────────────────────────────────────────────────
    // Client sends: field 1=passwordHash(int32) = SHA-1 XOR-fold of (challenge+password)
    // Server verifies and responds with LOGIN_OK or ERROR
    case PKT.LOGIN_RESPONSE: {
      if (client.state !== "CHALLENGING") {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "No pending login challenge"));
        return;
      }

      const clientHash = getInt32(pkt, 1);
      if (clientHash === null) {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Password hash required"));
        return;
      }

      // Look up stored password for the user
      const user = await storage.getUserByUsername(client.username!);
      if (!user) {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "User not found"));
        return;
      }

      // Verify using the TCP token issued at HTTP login time.
      // Mobile clients POST /api/auth/login → receive { tcpToken } →
      // pass it as "password" into FusionTcpClient.connect() →
      // client sends SHA-1(challenge + tcpToken) in LOGIN_RESPONSE.
      const tokenEntry = findTokenForUser(user.id, clientHash, client.loginChallenge!);
      const authenticated = !!tokenEntry;
      if (authenticated && tokenEntry) {
        consumeTcpToken(tokenEntry.token); // one-time use
      }

      if (!authenticated) {
        client.state          = "CONNECTING";
        client.loginChallenge = undefined;
        client.username       = undefined;
        client.userId         = undefined;
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Username or password incorrect"));
        return;
      }

      if (user.isSuspended) {
        client.state          = "CONNECTING";
        client.loginChallenge = undefined;
        client.username       = undefined;
        client.userId         = undefined;
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Your account has been suspended"));
        return;
      }

      const [profile, rep] = await Promise.all([
        storage.getUserProfile(user.id),
        storage.getUserReputation(user.username),
      ]);
      const computedLevel    = rep ? scoreToLevel(rep.score) : (profile?.migLevel ?? 1);
      client.userId          = user.id;
      client.username        = user.username;
      client.migLevel        = computedLevel;
      client.state           = "AUTHENTICATED";
      client.loginChallenge  = undefined;

      // Sync stale stored migLevel in background
      if (profile && profile.migLevel !== computedLevel) {
        storage.upsertUserProfile(user.id, { migLevel: computedLevel }).catch(() => {});
      }

      sendBinary(client, buildLoginOk(txId));
      log(`[TCP/binary] ${user.username} authenticated (migLevel=${client.migLevel})`, "gateway-tcp");
      return;
    }

    // ── LOGOUT (300) ────────────────────────────────────────────────────────
    case PKT.LOGOUT: {
      if (client.roomId) await handleLeaveRoom(client);
      sendBinary(client, buildSessionTerminated(txId));
      client.state = "DISCONNECTED";
      client.socket.destroy();
      return;
    }

    // ── JOIN_CHATROOM (703) ─────────────────────────────────────────────────
    // Client sends: field 1=chatroomName(string)
    // Server responds: CHATROOM(701) info + CHATROOM_PARTICIPANTS(708) + OK(1)
    case PKT.JOIN_CHATROOM: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }

      const chatroomName = getStr(pkt, 1);
      if (!chatroomName) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom name required"));
        return;
      }

      // Find room by name or id
      const room = await storage.getChatroomByName(chatroomName) ??
                   await storage.getChatroom(chatroomName);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, `Chatroom not found: ${chatroomName}`));
        return;
      }

      const banned = await storage.isBanned(room.id, client.userId!);
      if (banned) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, `You have banned in chatroom ${room.name}`));
        return;
      }

      const binKickCheck = checkKickCooldown(client.userId!, room.id);
      if (binKickCheck.blocked) {
        const binRemainingMin = Math.ceil(binKickCheck.remainingMs / 60000);
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, `You has been kicked from the chatroom ${room.name} wait ${binRemainingMin} minute${binRemainingMin !== 1 ? 's' : ''} to enter again!`));
        return;
      }

      const binAlreadyInBeforeLock = client.subscribedRooms.has(room.id);
      if (room.isLocked && !binAlreadyInBeforeLock) {
        const binIsOwner       = room.createdBy === client.userId;
        const binIsMod         = await storage.isModUser(room.id, client.userId!);
        const binIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
        if (!binIsOwner && !binIsMod && !binIsGlobalAdmin) {
          sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "You can't enter the chatroom has been locked"));
          return;
        }
      }

      // ── Grace period / silent rejoin check (same logic as JSON JOIN_ROOM) ──
      const binGraceKey    = `tcp:${client.userId}:${room.id}`;
      const binPending     = pendingTcpLeaves.get(binGraceKey);
      const binAlreadyIn   = binAlreadyInBeforeLock;
      if (binPending) { clearTimeout(binPending.timer); pendingTcpLeaves.delete(binGraceKey); }
      // Also cancel any WS-originated pending leave for the same user+room.
      // If the user disconnected via WS and is rejoining via TCP, cancel that timer
      // and treat this as a reconnect so we don't emit a duplicate "has entered".
      const wsLeaveCancelled = cancelWsPendingLeave(client.userId!, room.id);

      // Duplicate-join guard: if the user is already live in this room via a
      // different TCP connection or via the WS gateway, suppress "has entered".
      const alreadyLiveViaTcp = [...clients.values()].some(
        (c) => c.id !== client.id && c.state === "AUTHENTICATED"
            && c.userId === client.userId && c.subscribedRooms.has(room.id),
      );
      const alreadyLiveViaWs = isUserInRoomViaWs(client.userId!, room.id);

      const binIsReconnect = !!binPending || binAlreadyIn || wsLeaveCancelled
                          || alreadyLiveViaTcp || alreadyLiveViaWs;

      // Leave previous room if in one
      if (client.roomId && client.roomId !== room.id) {
        await handleLeaveRoom(client);
        client.subscribedRooms.delete(client.roomId);
      }

      const color = await getRoleColor({
        userId:       client.userId!,
        username:     client.username!,
        roomId:       room.id,
        defaultColor: userColor(client.username!),
      });
      client.chatColor = color;
      await storage.joinChatroom(room.id, {
        id:          client.userId!,
        username:    client.username!,
        displayName: client.username!,
        color,
      });
      client.roomId = room.id;
      client.subscribedRooms.add(room.id);

      const list    = await storage.getParticipants(room.id);
      let binHistory;
      if (binIsReconnect && binPending) {
        binHistory = await storage.getMessagesSince(room.id, binPending.disconnectedAt);
      } else {
        binHistory = (await storage.getMessages(room.id)).slice(-30);
      }

      // Send room info
      sendBinary(client, buildChatroomInfo({
        txId,
        name:        room.name,
        description: room.description ?? "",
        maxPartic:   room.maxParticipants ?? 25,
        numPartic:   list.length,
      }));

      // Send participants
      sendBinary(client, buildChatroomParticipants(txId, room.name, list.map((p) => p.username)));

      // Replay history as binary MESSAGE packets
      for (const msg of binHistory) {
        sendBinary(client, buildChatroomMessage({
          txId:      0,
          source:    msg.senderUsername,
          destination: room.name,
          text:      msg.text,
          timestamp: msg.createdAt ? new Date(msg.createdAt).getTime() : undefined,
        }));
      }

      // Send OK to confirm join
      sendBinary(client, buildOk(txId));

      // Only announce entry on genuine first join.
      // Suppress entry/exit broadcast for global admins (silent join/leave).
      const binJoinerIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!).catch(() => false);
      if (!binIsReconnect && !binJoinerIsGlobalAdmin) {
        const joinDisplayName = client.migLevel >= 1 ? `${client.username}[${client.migLevel}]` : client.username!;
        const joinMsg = await storage.postMessage(room.id, {
          senderId:       client.userId,
          senderUsername: client.username!,
          senderColor:    color,
          text:           `${room.name}::${joinDisplayName} has entered`,
          isSystem:       true,
        });
        const updatedList      = await storage.getParticipants(room.id);
        const participantsBuf  = buildChatroomParticipants(0, room.name, updatedList.map((p) => p.username));
        broadcastToRoom(room.id, { type: "MESSAGE", roomId: room.id, message: joinMsg });
        broadcastToRoom(room.id, buildParticipantsPayload(room.id, room.name, updatedList));
        broadcastToTcpRoom(room.id, { type: "USER_JOINED", roomId: room.id, username: client.username }, client.id, participantsBuf);
      } else if (!binIsReconnect && binJoinerIsGlobalAdmin) {
        // Still refresh participant lists so admins appear in the sidebar.
        const updatedList      = await storage.getParticipants(room.id);
        const participantsBuf  = buildChatroomParticipants(0, room.name, updatedList.map((p) => p.username));
        broadcastToRoom(room.id, buildParticipantsPayload(room.id, room.name, updatedList));
        broadcastToTcpRoom(room.id, { type: "USER_JOINED", roomId: room.id, username: client.username }, client.id, participantsBuf);
      }

      log(`[TCP/binary] ${client.username} ${binIsReconnect ? "silently rejoined" : "joined"} chatroom ${room.name}`, "gateway-tcp");
      return;
    }

    // ── LEAVE_CHATROOM (704) ────────────────────────────────────────────────
    case PKT.LEAVE_CHATROOM: {
      if (client.state !== "AUTHENTICATED" || !client.roomId) {
        sendBinary(client, buildOk(txId));
        return;
      }
      // Cancel grace period if one is active (explicit leave bypasses grace window)
      if (client.userId) {
        const leaveGraceKey = `tcp:${client.userId}:${client.roomId}`;
        const leavePending  = pendingTcpLeaves.get(leaveGraceKey);
        if (leavePending) { clearTimeout(leavePending.timer); pendingTcpLeaves.delete(leaveGraceKey); }
      }
      client.subscribedRooms.delete(client.roomId);
      await handleLeaveRoom(client);
      sendBinary(client, buildOk(txId));
      return;
    }

    // ── MESSAGE (500) ───────────────────────────────────────────────────────
    // Client sends chatroom message.
    // Field 1=messageType(byte), 3=destType(byte), 4=destination(string,
    //       chatroom name), 6=contentType(short), 8=text(string)
    case PKT.MESSAGE: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }

      const text        = getStr(pkt, 8);
      const destination = getStr(pkt, 4) ?? "";
      const destType    = getUInt8(pkt, 3) ?? DEST_TYPE.CHATROOM;

      if (!text?.trim()) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Message text required"));
        return;
      }

      // ── Private message (destType = 1 = INDIVIDUAL) ──────────────────────
      if (destType === DEST_TYPE.INDIVIDUAL) {
        const recipientUsername = destination;
        if (!recipientUsername) {
          sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Destination username required"));
          return;
        }

        const recipient = await storage.getUserByUsername(recipientUsername);
        if (!recipient) {
          sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "User not found"));
          return;
        }

        // Find or create conversation between sender and recipient
        const senderParticipations = await db
          .select({ conversationId: conversationParticipants.conversationId })
          .from(conversationParticipants)
          .where(eq(conversationParticipants.userId, client.userId!));

        const recipientParticipations = await db
          .select({ conversationId: conversationParticipants.conversationId })
          .from(conversationParticipants)
          .where(eq(conversationParticipants.userId, recipient.id));

        const senderConvIds    = senderParticipations.map(p => p.conversationId);
        const recipientConvIds = recipientParticipations.map(p => p.conversationId);
        const sharedConvIds    = senderConvIds.filter(id => recipientConvIds.includes(id));

        let convId: string;
        if (sharedConvIds.length > 0) {
          convId = sharedConvIds[0];
        } else {
          // Create new private conversation
          const [newConv] = await db.insert(conversations).values({
            type:      "private",
            createdBy: client.userId!,
          }).returning({ id: conversations.id });
          convId = newConv.id;
          await db.insert(conversationParticipants).values([
            { conversationId: convId, userId: client.userId!,   username: client.username!,   displayName: client.username! },
            { conversationId: convId, userId: recipient.id,     username: recipientUsername,  displayName: recipientUsername },
          ]);
        }

        // Store the message
        const [newMsg] = await db.insert(conversationMessages).values({
          conversationId: convId,
          senderId:       client.userId!,
          senderUsername: client.username!,
          text:           text.trim(),
          type:           "text",
        }).returning();

        // Update conversation last message
        await db
          .update(conversations)
          .set({ lastMessageText: text.trim(), lastMessageAt: new Date() })
          .where(eq(conversations.id, convId));

        const msgTimestamp = newMsg.createdAt ? new Date(newMsg.createdAt).getTime() : Date.now();

        // Build private MESSAGE packet to push to each party
        const msgBuf = buildPrivateMessage({
          txId:        0,
          source:      client.username!,
          destination: recipientUsername,
          text:        text.trim(),
          guid:        newMsg.id,
          timestamp:   msgTimestamp,
        });

        // Echo back to sender
        sendBinary(client, msgBuf);
        sendBinary(client, buildOk(txId));

        // Push to recipient's TCP connection(s) if online
        for (const [, peer] of clients) {
          if (peer.username === recipientUsername && peer.state === "AUTHENTICATED") {
            sendBinary(peer, msgBuf);
          }
        }

        log(`[TCP/binary] Private message from ${client.username} → ${recipientUsername}`, "gateway-tcp");
        return;
      }

      // ── Chatroom message (destType = 3 = CHATROOM) ───────────────────────

      // Determine target room
      const roomId = destination
        ? (await storage.getChatroomByName(destination))?.id ?? client.roomId
        : client.roomId;

      if (!roomId) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Not in a chatroom"));
        return;
      }

      const room = await storage.getChatroom(roomId);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom not found"));
        return;
      }

      const muted = await storage.isMuted(roomId, client.userId!);
      if (muted) {
        // Owner, mod, and global admins can always talk in their managed rooms
        // even if a previous mute is still active.
        const tcpMsgIsOwner       = room.createdBy === client.userId;
        const tcpMsgIsMod         = await storage.isModUser(roomId, client.userId!);
        const tcpMsgIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
        if (!tcpMsgIsOwner && !tcpMsgIsMod && !tcpMsgIsGlobalAdmin) {
          sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "You are muted in this chatroom"));
          return;
        }
      }

      const tcpMsgColor = await getRoleColor({
        userId:       client.userId!,
        username:     client.username!,
        roomId,
        defaultColor: userColor(client.username!),
      });
      const message = await storage.postMessage(roomId, {
        senderId:       client.userId,
        senderUsername: client.username!,
        senderColor:    tcpMsgColor,
        text:           text.trim(),
      });

      // Build binary broadcast packet for binary TCP peers
      const msgBuf = buildChatroomMessage({
        txId:        0,
        source:      client.username!,
        destination: room.name,
        text:        text.trim(),
        guid:        message.id,
        timestamp:   message.createdAt ? new Date(message.createdAt).getTime() : Date.now(),
      });

      // Echo back to sender (binary)
      sendBinary(client, msgBuf);

      // Broadcast to all room members
      broadcastToTcpRoom(roomId, { type: "MESSAGE", roomId, message }, client.id, msgBuf);
      broadcastToRoom(roomId, { type: "MESSAGE", roomId, message });

      // ACK
      sendBinary(client, buildOk(txId));
      return;
    }

    // ── GET_CHATROOMS (700) ─────────────────────────────────────────────────
    case PKT.GET_CHATROOMS: {
      const rooms = await storage.getChatrooms();
      for (const room of rooms.slice(0, 20)) {
        sendBinary(client, buildChatroomInfo({
          txId:      0,
          name:      room.name,
          description: room.description ?? "",
          numPartic: room.currentParticipants ?? 0,
          maxPartic: room.maxParticipants ?? 25,
        }));
      }
      sendBinary(client, encodeRaw(PKT.GET_CHATROOMS_COMPLETE, txId));
      return;
    }

    // ── GET_CHATROOM_CATEGORIES (713) ──────────────────────────────────────
    // Client sends no fields; server replies with CHATROOM_CATEGORY(714) for
    // each category and then GET_CHATROOM_CATEGORIES_COMPLETE(715).
    // Mirrors GetChatroomCategories.java flow.
    case PKT.GET_CHATROOM_CATEGORIES: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const CATEGORIES = [
        { id: 1, label: "Favorites",        itemsCanBeDeleted: true  },
        { id: 2, label: "Recent",           itemsCanBeDeleted: false },
        { id: 8, label: "Recommended",      itemsCanBeDeleted: false },
        { id: 7, label: "Games",            itemsCanBeDeleted: false },
        { id: 4, label: "Find Friends",     itemsCanBeDeleted: false },
        { id: 5, label: "Game Zone",        itemsCanBeDeleted: false },
        { id: 6, label: "Help",             itemsCanBeDeleted: false },
      ];
      for (const cat of CATEGORIES) {
        sendBinary(client, buildChatroomCategory({
          txId,
          categoryId:        cat.id,
          categoryName:      cat.label,
          refreshMethod:     1,   // REPLACE
          isCollapsed:       false,
          itemsCanBeDeleted: cat.itemsCanBeDeleted,
        }));
      }
      sendBinary(client, encodeRaw(PKT.GET_CHATROOM_CATEGORIES_COMPLETE, txId));
      log(`[TCP/binary] ${client.username} fetched chatroom categories`, "gateway-tcp");
      return;
    }

    // ── GET_CATEGORIZED_CHATROOMS (716) ────────────────────────────────────
    // Client sends: field 1=categoryId(short), field 2=doRefresh(bool)
    // Server replies with CHATROOM(701) for each room and then
    // GET_CATEGORIZED_CHATROOMS_COMPLETE(717).
    // Special handling: categoryId=1 → Favourites, categoryId=2 → Recent.
    case PKT.GET_CATEGORIZED_CHATROOMS: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const categoryId = getInt16(pkt, 1) ?? 0;
      let rooms: Awaited<ReturnType<typeof storage.getChatrooms>>;
      if (categoryId === 1) {
        rooms = await storage.getFavouriteChatrooms(client.userId!);
      } else if (categoryId === 2) {
        rooms = await storage.getRecentChatrooms(client.userId!);
      } else {
        rooms = await storage.getChatroomsByCategory(categoryId);
      }
      for (const room of rooms) {
        sendBinary(client, buildChatroomInfo({
          txId:        0,
          name:        room.name,
          description: room.description ?? "",
          numPartic:   room.currentParticipants ?? 0,
          maxPartic:   room.maxParticipants ?? 25,
        }));
      }
      sendBinary(client, buildGetCategorizedChatroomsComplete(txId));
      log(`[TCP/binary] ${client.username} fetched category ${categoryId} (${rooms.length} rooms)`, "gateway-tcp");
      return;
    }

    // ── KICK_CHATROOM_PARTICIPANT (706) ─────────────────────────────────────
    // Client sends: field 1=chatroomName(string), field 2=targetUsername(string)
    // Mirrors FusionPktKickChatroomParticipant.java — owner/mod only.
    case PKT.KICK_CHATROOM_PARTICIPANT: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const chatroomName  = getStr(pkt, 1);
      const targetUsername = getStr(pkt, 2);
      if (!chatroomName || !targetUsername) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "chatroomName and targetUsername required"));
        return;
      }
      const room = await storage.getChatroomByName(chatroomName) ??
                   await storage.getChatroom(chatroomName);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom not found"));
        return;
      }
      const isOwner = room.createdBy === client.userId;
      const isMod   = await storage.isModUser(room.id, client.userId!);
      const isGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
      if (!isGlobalAdmin && !isOwner && !isMod) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Owner or mod required"));
        return;
      }
      const targetUser = await storage.getUserByUsername(targetUsername);
      if (!targetUser) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "User not found"));
        return;
      }
      // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be kicked
      const targetIsProtected = room.createdBy === targetUser.id ||
        await storage.isModUser(room.id, targetUser.id) ||
        await storage.isGlobalAdmin(targetUser.id);
      if (targetIsProtected) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Admin atau moderator tidak bisa di-kick"));
        return;
      }
      await storage.leaveChatroom(room.id, targetUser.id);
      forceRemoveUserFromRoom(targetUser.id, room.id, room.name, "kicked");
      const sysMsg = await storage.postMessage(room.id, {
        senderUsername: "System", senderColor: "FF4444",
        text: `${targetUsername} has been kicked`, isSystem: true,
      });
      const list = await storage.getParticipants(room.id);
      const notifyBuf = buildChatroomNotification({
        txId: 0, chatroomName: room.name,
        notificationType: ROOM_NOTIFY.KICKED, targetUsername,
        message: `${targetUsername} has been kicked`,
      });
      const partsBuf = buildChatroomParticipants(0, room.name, list.map((p) => p.username));
      broadcastToRoom(room.id, { type: "KICKED",  roomId: room.id, username: targetUsername });
      broadcastToRoom(room.id, { type: "MESSAGE", roomId: room.id, message: sysMsg });
      broadcastToRoom(room.id, buildParticipantsPayload(room.id, room.name, list));
      broadcastToTcpRoom(room.id, { type: "KICKED", roomId: room.id, username: targetUsername }, client.id, notifyBuf);
      broadcastToTcpRoom(room.id, {}, client.id, partsBuf);
      sendBinary(client, buildOk(txId));
      log(`[TCP/binary] ${client.username} kicked ${targetUsername} from ${room.name}`, "gateway-tcp");
      return;
    }

    // ── GET_CHATROOM_PARTICIPANTS (707) ─────────────────────────────────────
    // Client sends: field 1=chatroomName(string)
    // Server responds: CHATROOM_PARTICIPANTS (708)
    // Mirrors FusionPktGetChatroomParticipants.java.
    case PKT.GET_CHATROOM_PARTICIPANTS: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const chatroomName = getStr(pkt, 1);
      const roomId = chatroomName
        ? (await storage.getChatroomByName(chatroomName))?.id ?? client.roomId
        : client.roomId;
      if (!roomId) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Not in a chatroom"));
        return;
      }
      const room = await storage.getChatroom(roomId);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom not found"));
        return;
      }
      const list = await storage.getParticipants(roomId);
      sendBinary(client, buildChatroomParticipants(txId, room.name, list.map((p) => p.username)));
      return;
    }

    // ── MUTE_CHATROOM_PARTICIPANT (709) ─────────────────────────────────────
    // Client sends: field 1=chatroomName(string), field 2=targetUsername(string)
    // Mirrors FusionPktMuteChatroomParticipant.java — owner/mod only.
    case PKT.MUTE_CHATROOM_PARTICIPANT: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const chatroomName   = getStr(pkt, 1);
      const targetUsername = getStr(pkt, 2);
      if (!chatroomName || !targetUsername) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "chatroomName and targetUsername required"));
        return;
      }
      const room = await storage.getChatroomByName(chatroomName) ??
                   await storage.getChatroom(chatroomName);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom not found"));
        return;
      }
      const isOwner = room.createdBy === client.userId;
      const isMod   = await storage.isModUser(room.id, client.userId!);
      const isGlobalAdminExec = await storage.isGlobalAdmin(client.userId!);
      if (!isOwner && !isMod && !isGlobalAdminExec) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Owner or mod required"));
        return;
      }
      const targetUser = await storage.getUserByUsername(targetUsername);
      if (!targetUser) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "User not found"));
        return;
      }
      // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be muted
      const tcpBinMuteIsProtected =
        room.createdBy === targetUser.id ||
        await storage.isModUser(room.id, targetUser.id) ||
        await storage.isGlobalAdmin(targetUser.id);
      if (tcpBinMuteIsProtected) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Admin atau moderator tidak bisa di-mute"));
        return;
      }
      await storage.muteUser(room.id, targetUser.id);
      const sysMsg = await storage.postMessage(room.id, {
        senderUsername: "System", senderColor: "FF8C00",
        text: `${targetUsername} has been muted`, isSystem: true,
      });
      const list = await storage.getParticipants(room.id);
      const notifyBuf = buildChatroomNotification({
        txId: 0, chatroomName: room.name,
        notificationType: ROOM_NOTIFY.MUTED, targetUsername,
        message: `${targetUsername} has been muted`,
      });
      const statusBuf = buildChatroomUserStatus({
        txId: 0, chatroomName: room.name, username: targetUsername,
        status: USER_STATUS.MUTED,
      });
      broadcastToRoom(room.id, { type: "MUTED",   roomId: room.id, username: targetUsername });
      broadcastToRoom(room.id, { type: "MESSAGE", roomId: room.id, message: sysMsg });
      broadcastToRoom(room.id, buildParticipantsPayload(room.id, room.name, list));
      broadcastToTcpRoom(room.id, {}, client.id, notifyBuf);
      broadcastToTcpRoom(room.id, {}, client.id, statusBuf);
      sendBinary(client, buildOk(txId));
      log(`[TCP/binary] ${client.username} muted ${targetUsername} in ${room.name}`, "gateway-tcp");
      return;
    }

    // ── UNMUTE_CHATROOM_PARTICIPANT (710) ───────────────────────────────────
    // Client sends: field 1=chatroomName(string), field 2=targetUsername(string)
    // Mirrors FusionPktUnmuteChatroomParticipant.java — owner/mod only.
    case PKT.UNMUTE_CHATROOM_PARTICIPANT: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const chatroomName   = getStr(pkt, 1);
      const targetUsername = getStr(pkt, 2);
      if (!chatroomName || !targetUsername) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "chatroomName and targetUsername required"));
        return;
      }
      const room = await storage.getChatroomByName(chatroomName) ??
                   await storage.getChatroom(chatroomName);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom not found"));
        return;
      }
      const isOwner = room.createdBy === client.userId;
      const isMod   = await storage.isModUser(room.id, client.userId!);
      if (!isOwner && !isMod) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Owner or mod required"));
        return;
      }
      const targetUser = await storage.getUserByUsername(targetUsername);
      if (!targetUser) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "User not found"));
        return;
      }
      await storage.unmuteUser(room.id, targetUser.id);
      const sysMsg = await storage.postMessage(room.id, {
        senderUsername: "System", senderColor: "22AA55",
        text: `${targetUsername} has been unmuted`, isSystem: true,
      });
      const list = await storage.getParticipants(room.id);
      const notifyBuf = buildChatroomNotification({
        txId: 0, chatroomName: room.name,
        notificationType: ROOM_NOTIFY.UNMUTED, targetUsername,
        message: `${targetUsername} has been unmuted`,
      });
      const statusBuf = buildChatroomUserStatus({
        txId: 0, chatroomName: room.name, username: targetUsername,
        status: USER_STATUS.NORMAL,
      });
      broadcastToRoom(room.id, { type: "UNMUTED",  roomId: room.id, username: targetUsername });
      broadcastToRoom(room.id, { type: "MESSAGE",  roomId: room.id, message: sysMsg });
      broadcastToRoom(room.id, buildParticipantsPayload(room.id, room.name, list));
      broadcastToTcpRoom(room.id, {}, client.id, notifyBuf);
      broadcastToTcpRoom(room.id, {}, client.id, statusBuf);
      sendBinary(client, buildOk(txId));
      log(`[TCP/binary] ${client.username} unmuted ${targetUsername} in ${room.name}`, "gateway-tcp");
      return;
    }

    // ── ADD_FAVOURITE_CHATROOM (711) ────────────────────────────────────────
    // Client sends: field 1=chatroomName(string)
    // Mirrors AddFavouriteChatroom.java — persists to user's favourites list.
    case PKT.ADD_FAVOURITE_CHATROOM: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const chatroomName = getStr(pkt, 1);
      if (!chatroomName) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "chatroomName required"));
        return;
      }
      const room = await storage.getChatroomByName(chatroomName) ??
                   await storage.getChatroom(chatroomName);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom not found"));
        return;
      }
      await storage.addFavouriteChatroom(client.userId!, room.id);
      sendBinary(client, buildOk(txId));
      log(`[TCP/binary] ${client.username} added ${room.name} to favourites`, "gateway-tcp");
      return;
    }

    // ── REMOVE_FAVOURITE_CHATROOM (712) ────────────────────────────────────
    // Client sends: field 1=chatroomName(string)
    // Mirrors RemoveFavouriteChatroom.java — removes from user's favourites list.
    case PKT.REMOVE_FAVOURITE_CHATROOM: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }
      const chatroomName = getStr(pkt, 1);
      if (!chatroomName) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "chatroomName required"));
        return;
      }
      const room = await storage.getChatroomByName(chatroomName) ??
                   await storage.getChatroom(chatroomName);
      if (!room) {
        sendBinary(client, buildError(txId, ErrCode.UNDEFINED, "Chatroom not found"));
        return;
      }
      await storage.removeFavouriteChatroom(client.userId!, room.id);
      sendBinary(client, buildOk(txId));
      log(`[TCP/binary] ${client.username} removed ${room.name} from favourites`, "gateway-tcp");
      return;
    }

    // ── HAVE_LATEST_CHAT_LIST (552) ─────────────────────────────────────────
    // Client tells the server its current chat list version.
    // We respond with OK if up-to-date; otherwise we push updated CHAT packets.
    case PKT.HAVE_LATEST_CHAT_LIST: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }

      const clientVersion = getInt32(pkt, 1) ?? 0;

      // Get server version for this user
      const [versionRow] = await db
        .select()
        .from(userChatListVersions)
        .where(eq(userChatListVersions.userId, client.userId!));

      const serverVersion = versionRow?.version ?? 0;

      if (clientVersion >= serverVersion) {
        // Client is up to date
        sendBinary(client, buildOk(txId));
        return;
      }

      // Push updated conversations to client
      const myParticipations = await db
        .select({ conversationId: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.userId, client.userId!));

      if (myParticipations.length > 0) {
        const convIds = myParticipations.map(p => p.conversationId);
        const convList = await db
          .select()
          .from(conversations)
          .where(inArray(conversations.id, convIds));

        for (const conv of convList) {
          const participants = await db
            .select()
            .from(conversationParticipants)
            .where(eq(conversationParticipants.conversationId, conv.id));

          const myPart = participants.find(p => p.userId === client.userId);
          const otherPart = participants.find(p => p.userId !== client.userId);

          const chatIdentifier = conv.type === "private"
            ? (otherPart?.username ?? conv.id)
            : conv.id;
          const displayName = conv.type === "private"
            ? (otherPart?.displayName ?? otherPart?.username ?? chatIdentifier)
            : (conv.name ?? conv.id);
          const chatType = conv.type === "private" ? DEST_TYPE.INDIVIDUAL : DEST_TYPE.GROUP_CHAT;

          sendBinary(client, buildChat({
            txId:           0,
            chatIdentifier,
            displayName,
            chatType,
            unreadCount:    myPart?.unreadCount ?? 0,
            isClosed:       conv.isClosed,
            isPassivated:   conv.isPassivated,
            timestamp:      conv.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : undefined,
            chatListVersion: serverVersion,
          }));
        }
      }

      sendBinary(client, buildChatListVersion(txId, serverVersion));
      return;
    }

    // ── GET_CHATS (551) ──────────────────────────────────────────────────────
    // Client requests the full chat list.
    case PKT.GET_CHATS: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }

      const myParticipations = await db
        .select({ conversationId: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.userId, client.userId!));

      const [versionRow] = await db
        .select()
        .from(userChatListVersions)
        .where(eq(userChatListVersions.userId, client.userId!));
      const serverVersion = versionRow?.version ?? 0;

      if (myParticipations.length > 0) {
        const convIds = myParticipations.map(p => p.conversationId);
        const convList = await db
          .select()
          .from(conversations)
          .where(inArray(conversations.id, convIds));

        for (const conv of convList) {
          const participants = await db
            .select()
            .from(conversationParticipants)
            .where(eq(conversationParticipants.conversationId, conv.id));

          const myPart   = participants.find(p => p.userId === client.userId);
          const otherPart = participants.find(p => p.userId !== client.userId);

          const chatIdentifier = conv.type === "private"
            ? (otherPart?.username ?? conv.id)
            : conv.id;
          const displayName = conv.type === "private"
            ? (otherPart?.displayName ?? otherPart?.username ?? chatIdentifier)
            : (conv.name ?? conv.id);
          const chatType = conv.type === "private" ? DEST_TYPE.INDIVIDUAL : DEST_TYPE.GROUP_CHAT;

          sendBinary(client, buildChat({
            txId:           0,
            chatIdentifier,
            displayName,
            chatType,
            unreadCount:    myPart?.unreadCount ?? 0,
            isClosed:       conv.isClosed,
            isPassivated:   conv.isPassivated,
            timestamp:      conv.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : undefined,
            chatListVersion: serverVersion,
          }));
        }
      }

      sendBinary(client, buildChatListVersion(txId, serverVersion));
      return;
    }

    // ── GET_MESSAGES (550) ───────────────────────────────────────────────────
    // Client requests messages for a conversation (private or group).
    // field 1 = chatIdentifier (username for private, convId for group)
    // field 2 = chatType      (1=private, 2=group, 3=chatroom)
    // field 3 = latestTimestamp (long, optional)
    // field 4 = oldestTimestamp (long, optional)
    // field 5 = limit           (int, optional)
    case PKT.GET_MESSAGES: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }

      const chatId   = getStr(pkt, 1) ?? "";
      const chatType = getUInt8(pkt, 2) ?? DEST_TYPE.CHATROOM;
      const limit    = getInt32(pkt, 5) ?? 50;

      // ── Chatroom messages (type=3) ─────────────────────────────────────
      if (chatType === DEST_TYPE.CHATROOM) {
        const room = chatId
          ? (await storage.getChatroomByName(chatId) ?? await storage.getChatroom(chatId))
          : null;
        const msgs = room ? await storage.getMessages(room.id) : [];

        for (const msg of msgs) {
          sendBinary(client, buildChatroomMessage({
            txId:        0,
            source:      msg.senderUsername,
            destination: room!.name,
            text:        msg.text,
            guid:        msg.id,
            timestamp:   msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now(),
          }));
        }

        sendBinary(client, buildEndMessages({
          txId,
          chatIdentifier: chatId,
          firstGUID:      msgs[0]?.id,
          finalGUID:      msgs[msgs.length - 1]?.id,
          messagesSent:   msgs.length,
        }));
        return;
      }

      // ── Private / group conversation messages (type=1 or 2) ───────────
      // For private chats, chatId is the OTHER user's username.
      let convId: string | null = null;

      if (chatType === DEST_TYPE.INDIVIDUAL) {
        const otherUsername = chatId;
        const otherUser = await storage.getUserByUsername(otherUsername);
        if (otherUser) {
          const senderParticipations = await db
            .select({ conversationId: conversationParticipants.conversationId })
            .from(conversationParticipants)
            .where(eq(conversationParticipants.userId, client.userId!));

          const recipientParticipations = await db
            .select({ conversationId: conversationParticipants.conversationId })
            .from(conversationParticipants)
            .where(eq(conversationParticipants.userId, otherUser.id));

          const senderConvIds    = senderParticipations.map(p => p.conversationId);
          const recipientConvIds = recipientParticipations.map(p => p.conversationId);
          const shared = senderConvIds.filter(id => recipientConvIds.includes(id));
          convId = shared[0] ?? null;
        }
      } else {
        // Group: chatId is the conversation UUID directly
        convId = chatId;
      }

      if (!convId) {
        sendBinary(client, buildEndMessages({ txId, chatIdentifier: chatId, messagesSent: 0 }));
        return;
      }

      const msgs = await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, convId))
        .orderBy(desc(conversationMessages.createdAt))
        .limit(limit);

      // Return in chronological order (oldest first)
      msgs.reverse();

      for (const msg of msgs) {
        sendBinary(client, buildPrivateMessage({
          txId:        0,
          source:      msg.senderUsername,
          destination: chatId,
          text:        msg.text,
          guid:        msg.id,
          timestamp:   msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now(),
        }));
      }

      sendBinary(client, buildEndMessages({
        txId,
        chatIdentifier: chatId,
        firstGUID:      msgs[0]?.id,
        finalGUID:      msgs[msgs.length - 1]?.id,
        messagesSent:   msgs.length,
      }));
      return;
    }

    // ── LEAVE_PRIVATE_CHAT (507) ─────────────────────────────────────────────
    // Client closes/leaves a private conversation. We mark it as passivated.
    case PKT.LEAVE_PRIVATE_CHAT: {
      if (client.state !== "AUTHENTICATED") {
        sendBinary(client, buildError(txId, ErrCode.INCORRECT_CREDENTIAL, "Not authenticated"));
        return;
      }

      const otherUsername = getStr(pkt, 1);
      if (!otherUsername) {
        sendBinary(client, buildOk(txId));
        return;
      }

      const otherUser = await storage.getUserByUsername(otherUsername);
      if (otherUser) {
        const senderParticipations = await db
          .select({ conversationId: conversationParticipants.conversationId })
          .from(conversationParticipants)
          .where(eq(conversationParticipants.userId, client.userId!));

        const recipientParticipations = await db
          .select({ conversationId: conversationParticipants.conversationId })
          .from(conversationParticipants)
          .where(eq(conversationParticipants.userId, otherUser.id));

        const senderConvIds    = senderParticipations.map(p => p.conversationId);
        const recipientConvIds = recipientParticipations.map(p => p.conversationId);
        const shared = senderConvIds.filter(id => recipientConvIds.includes(id));

        if (shared.length > 0) {
          await db
            .update(conversations)
            .set({ isPassivated: true })
            .where(eq(conversations.id, shared[0]));
        }
      }

      sendBinary(client, buildOk(txId));
      log(`[TCP/binary] ${client.username} left private chat with ${otherUsername}`, "gateway-tcp");
      return;
    }

    default:
      log(`[TCP/binary] Unhandled packet type ${type} from ${client.username ?? client.id}`, "gateway-tcp");
      sendBinary(client, buildError(txId, ErrCode.UNDEFINED, `Unknown packet type: ${type}`));
  }
}

/** Encode a zero-field packet (e.g. GET_CHATROOMS_COMPLETE). */
function encodeRaw(type: number, txId: number): Buffer {
  return encodePacket(type, txId, []);
}

// ─── JSON protocol handler ────────────────────────────────────────────────────

async function handleJsonPacket(client: TcpClient, packet: Record<string, unknown>): Promise<void> {
  const type = packet.type as string;

  switch (type) {

    case "LOGIN": {
      const username = packet.username as string;
      const password = packet.password as string;
      if (!username || !password) {
        sendJson(client, { type: "ERROR", code: ErrCode.INCORRECT_CREDENTIAL, message: "Username dan password wajib diisi" });
        return;
      }
      const user = await storage.getUserByUsername(username);
      if (!user) {
        sendJson(client, { type: "ERROR", code: ErrCode.INCORRECT_CREDENTIAL, message: "Username atau password salah" });
        return;
      }

      // Accept either a tcpToken (mobile app) or a real password (web/debug clients).
      // tcpToken is a UUID issued by HTTP /api/auth/login — verified directly without
      // consuming it so that automatic TCP reconnects keep working.
      let valid = verifyTcpToken(user.id, password);
      if (!valid) {
        const { verifyPassword } = await import("../modules/auth/routes");
        valid = await verifyPassword(password, user.password);
      }

      if (!valid) {
        sendJson(client, { type: "ERROR", code: ErrCode.INCORRECT_CREDENTIAL, message: "Username atau password salah" });
        return;
      }
      if (user.isSuspended) {
        sendJson(client, { type: "LOGIN_FAIL", code: "SUSPENDED", message: "Your account has been suspended" });
        return;
      }
      const [profile, rep2] = await Promise.all([
        storage.getUserProfile(user.id),
        storage.getUserReputation(user.username),
      ]);
      const computedLevel2   = rep2 ? scoreToLevel(rep2.score) : (profile?.migLevel ?? 1);
      client.userId      = user.id;
      client.username    = user.username;
      client.migLevel    = computedLevel2;
      client.state       = "AUTHENTICATED";

      if (profile && profile.migLevel !== computedLevel2) {
        storage.upsertUserProfile(user.id, { migLevel: computedLevel2 }).catch(() => {});
      }

      sendJson(client, {
        type:      "LOGIN_OK",
        sessionId: client.sessionId,
        user:      { id: user.id, username: user.username, displayName: user.displayName },
        migLevel:  client.migLevel,
        theme:     DEFAULT_THEME,
      });
      log(`[TCP/json] ${username} authenticated`, "gateway-tcp");
      break;
    }

    case "JOIN_ROOM": {
      if (client.state !== "AUTHENTICATED") {
        sendJson(client, { type: "ERROR", code: ErrCode.INCORRECT_CREDENTIAL, message: "Belum login" });
        return;
      }
      const roomId = packet.roomId as string;
      const room   = await storage.getChatroom(roomId);
      if (!room) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Chatroom tidak ditemukan" }); return; }

      const banned = await storage.isBanned(roomId, client.userId!);
      if (banned) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: `You have banned in chatroom ${room.name}` }); return; }

      const jsonKickCheck = checkKickCooldown(client.userId!, roomId);
      if (jsonKickCheck.blocked) {
        const jsonRemainingMin = Math.ceil(jsonKickCheck.remainingMs / 60000);
        sendJson(client, { type: "JOIN_FAIL", code: "KICK_COOLDOWN", message: `You has been kicked from the chatroom ${room.name} wait ${jsonRemainingMin} minute${jsonRemainingMin !== 1 ? 's' : ''} to enter again!` });
        return;
      }

      const alreadyIn = client.subscribedRooms.has(roomId);
      if (room.isLocked && !alreadyIn) {
        const jsonIsOwner       = room.createdBy === client.userId;
        const jsonIsMod         = await storage.isModUser(roomId, client.userId!);
        const jsonIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
        if (!jsonIsOwner && !jsonIsMod && !jsonIsGlobalAdmin) {
          sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "You can't enter the chatroom has been locked" });
          return;
        }
      }

      // ── Room capacity check ───────────────────────────────────────────────
      // Admins / mods / global admin bypass the limit (mirrors fusion ChatRoomPreSE454 logic)
      const participants = await storage.getParticipants(roomId);
      const capIsOwner       = room.createdBy === client.userId;
      const capIsMod         = await storage.isModUser(roomId, client.userId!);
      const capIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
      const isAdmin = capIsOwner || capIsMod || capIsGlobalAdmin;
      if (!alreadyIn && !isAdmin && participants.length >= room.maxParticipants) {
        sendJson(client, {
          type: "ERROR",
          code: ErrCode.UNDEFINED,
          message: `This room is full (${room.maxParticipants}/${room.maxParticipants}). Please try again later.`,
        });
        return;
      }

      // ── Grace period / silent rejoin check ───────────────────────────────
      // Matches WS gateway behaviour: if the user disconnected recently
      // (TCP socket dropped) and reconnects within TCP_LEAVE_GRACE_MS, cancel
      // the pending "has left" timer and rejoin silently — no enter/leave msgs.
      // Also covers the Expo singleton case: TCP never closes on back-button,
      // so the client re-sends JOIN_ROOM when re-opening the UI; if the user
      // is already subscribed we treat it as a silent rejoin.
      const graceKey   = `tcp:${client.userId}:${roomId}`;
      const pending    = pendingTcpLeaves.get(graceKey);
      if (pending) {
        clearTimeout(pending.timer);
        pendingTcpLeaves.delete(graceKey);
      }
      // Also cancel any WS-originated pending leave for the same user+room.
      // If the user disconnected via WS and is rejoining via TCP, cancel that timer
      // and treat this as a reconnect so we don't emit a duplicate "has entered".
      const wsLeaveCancelledJson = cancelWsPendingLeave(client.userId!, roomId);

      // Duplicate-join guard: if the user is already live in this room via a
      // different TCP connection or via the WS gateway, suppress "has entered".
      const alreadyLiveViaTcpJson = [...clients.values()].some(
        (c) => c.id !== client.id && c.state === "AUTHENTICATED"
            && c.userId === client.userId && c.subscribedRooms.has(roomId),
      );
      const alreadyLiveViaWsJson = isUserInRoomViaWs(client.userId!, roomId);

      const isReconnect = !!pending || alreadyIn || wsLeaveCancelledJson
                       || alreadyLiveViaTcpJson || alreadyLiveViaWsJson;

      // If switching rooms, leave previous room first
      if (client.roomId && client.roomId !== roomId) {
        await handleLeaveRoom(client);
        client.subscribedRooms.delete(client.roomId);
      }

      const color = await getRoleColor({
        userId:       client.userId!,
        username:     client.username!,
        roomId,
        defaultColor: userColor(client.username!),
      });
      client.chatColor = color;
      await storage.joinChatroom(roomId, { id: client.userId!, username: client.username!, displayName: client.username!, color });
      client.roomId = roomId;
      client.subscribedRooms.add(roomId);

      const list    = await storage.getParticipants(roomId);

      // On silent reconnect: send only missed messages since disconnect
      // On fresh join: send full history (last 50)
      let history;
      if (isReconnect && pending) {
        history = await storage.getMessagesSince(roomId, pending.disconnectedAt);
      } else {
        history = (await storage.getMessages(roomId)).slice(-50);
      }

      sendJson(client, {
        type: "JOIN_OK", roomId, room,
        theme:        DEFAULT_THEME,
        participants: buildParticipantsPayload(roomId, room.name, list),
        history,
        isReconnect,
      });

      // Only broadcast "has entered" on genuine first join — not on reconnect
      if (!isReconnect) {
        const joinDisplayName2 = client.migLevel >= 1 ? `${client.username}[${client.migLevel}]` : client.username!;
        const joinMsg  = await storage.postMessage(roomId, {
          senderId: client.userId, senderUsername: client.username!, senderColor: color,
          text: `${room.name}::${joinDisplayName2} has entered`, isSystem: true,
        });
        const updList  = await storage.getParticipants(roomId);
        broadcastToTcpRoom(roomId, { type: "USER_JOINED", roomId, username: client.username }, client.id);
        broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: joinMsg });
        broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, updList));
        botNotifyJoin(roomId, client.username!);
      }
      log(`[TCP/json] ${client.username} ${isReconnect ? "silently rejoined" : "joined"} room ${room.name}`, "gateway-tcp");
      break;
    }

    case "LEAVE_ROOM": {
      if (client.state !== "AUTHENTICATED" || !client.roomId) return;
      const roomId = client.roomId;
      // Cancel any pending grace-period timer for this room (explicit leave bypasses it)
      if (client.userId) {
        const graceKey = `tcp:${client.userId}:${roomId}`;
        const pending  = pendingTcpLeaves.get(graceKey);
        if (pending) { clearTimeout(pending.timer); pendingTcpLeaves.delete(graceKey); }
      }
      client.subscribedRooms.delete(roomId);
      await handleLeaveRoom(client);
      sendJson(client, { type: "LEAVE_OK", roomId });
      break;
    }

    case "SEND_MESSAGE": {
      if (client.state !== "AUTHENTICATED") {
        sendJson(client, { type: "ERROR", code: ErrCode.INCORRECT_CREDENTIAL, message: "Belum login" });
        return;
      }
      const roomId = (packet.roomId as string) || client.roomId;
      const text   = packet.text as string;
      if (!roomId || !text?.trim()) {
        sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "roomId dan text wajib" });
        return;
      }
      const room = await storage.getChatroom(roomId);
      if (!room) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Chatroom tidak ditemukan" }); return; }

      const muted = await storage.isMuted(roomId, client.userId!);
      if (muted) {
        // Owner, mod, and global admins can always talk in their managed rooms
        // even if a previous mute is still active.
        const jsonMsgIsOwner       = room.createdBy === client.userId;
        const jsonMsgIsMod         = await storage.isModUser(roomId, client.userId!);
        const jsonMsgIsGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
        if (!jsonMsgIsOwner && !jsonMsgIsMod && !jsonMsgIsGlobalAdmin) {
          sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Kamu sedang di-mute di chatroom ini" }); return;
        }
      }

      const jsonMsgColor = await getRoleColor({
        userId:       client.userId!,
        username:     client.username!,
        roomId,
        defaultColor: userColor(client.username!),
      });
      const message = await storage.postMessage(roomId, {
        senderId: client.userId, senderUsername: client.username!,
        senderColor: jsonMsgColor, text: text.trim(),
      });
      const payload = { type: "MESSAGE", roomId, message };
      sendJson(client, payload);
      broadcastToTcpRoom(roomId, payload, client.id);
      broadcastToRoom(roomId, { type: "MESSAGE", roomId, message });
      break;
    }

    case "CMD": {
      if (client.state !== "AUTHENTICATED") {
        sendJson(client, { type: "ERROR", code: ErrCode.INCORRECT_CREDENTIAL, message: "Belum login" });
        return;
      }
      const cmd    = packet.cmd as string;
      const roomId = (packet.roomId as string) || client.roomId;
      const target = packet.target as string | undefined;
      const msg    = packet.message as string | undefined;
      if (!roomId) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "roomId wajib" }); return; }

      const room = await storage.getChatroom(roomId);
      if (!room) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Chatroom tidak ditemukan" }); return; }

      const isOwner = room.createdBy === client.userId;
      const isMod   = await storage.isModUser(roomId, client.userId!);
      const isGlobalAdmin = await storage.isGlobalAdmin(client.userId!);
      const isAdmin = isGlobalAdmin || isOwner || isMod;

      const ownerOnly = ["mod", "unmod", "lock", "unlock", "description"];
      const adminOnly = ["kick", "kill", "ban", "mute", "unmute", "warn", "bump", "broadcast", "announce"];
      if (ownerOnly.includes(cmd) && !isOwner) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Hanya owner" }); return; }
      if (adminOnly.includes(cmd) && !isAdmin) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Hanya owner/mod" }); return; }

      const needsTarget = ["kick", "kill", "ban", "mute", "unmute", "mod", "unmod", "warn"];
      if (needsTarget.includes(cmd) && !target) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Target wajib" }); return; }

      const targetUser = target ? await storage.getUserByUsername(target) : null;
      if (needsTarget.includes(cmd) && !targetUser) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "User tidak ditemukan" }); return; }

      switch (cmd) {
        case "kick": case "kill": {
          // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be kicked
          const tgtIsProtected = room.createdBy === targetUser!.id ||
            await storage.isModUser(roomId, targetUser!.id) ||
            await storage.isGlobalAdmin(targetUser!.id);
          if (tgtIsProtected) {
            sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-kick" });
            break;
          }
          await storage.leaveChatroom(roomId, targetUser!.id);
          forceRemoveUserFromRoom(targetUser!.id, roomId, room.name, "kicked");
          const label  = cmd === "kill" ? "dikeluarkan paksa" : "di-kick";
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF4444", text: `${target} telah ${label}`, isSystem: true });
          const list   = await storage.getParticipants(roomId);
          const kickNotifyBuf = buildChatroomNotification({
            txId: 0, chatroomName: room.name, notificationType: ROOM_NOTIFY.KICKED,
            targetUsername: target!, message: `${target} telah ${label}`,
          });
          broadcastToRoom(roomId, { type: "KICKED",   roomId, username: target! });
          broadcastToRoom(roomId, { type: "MESSAGE",  roomId, message: sysMsg });
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
          broadcastToTcpRoom(roomId, {}, undefined, kickNotifyBuf);
          sendJson(client, { type: "CMD_OK", cmd, target });
          break;
        }
        case "ban": {
          // Mirrors hasAdminOrModeratorRights(): owner, mod, or global admin cannot be banned
          const banTgtIsProtected = room.createdBy === targetUser!.id ||
            await storage.isModUser(roomId, targetUser!.id) ||
            await storage.isGlobalAdmin(targetUser!.id);
          if (banTgtIsProtected) {
            sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-ban" });
            break;
          }
          await storage.banUser(roomId, targetUser!.id);
          forceRemoveUserFromRoom(targetUser!.id, roomId, room.name, "banned");
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF4444", text: `${target} telah di-ban`, isSystem: true });
          const list   = await storage.getParticipants(roomId);
          const banNotifyBuf = buildChatroomNotification({
            txId: 0, chatroomName: room.name, notificationType: ROOM_NOTIFY.BANNED,
            targetUsername: target!, message: `${target} telah di-ban`,
          });
          const banStatusBuf = buildChatroomUserStatus({
            txId: 0, chatroomName: room.name, username: target!, status: USER_STATUS.BANNED,
          });
          broadcastToRoom(roomId, { type: "BANNED",  roomId, username: target! });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
          broadcastToTcpRoom(roomId, {}, undefined, banNotifyBuf);
          broadcastToTcpRoom(roomId, {}, undefined, banStatusBuf);
          sendJson(client, { type: "CMD_OK", cmd, target });
          break;
        }
        case "mute": {
          // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be muted
          const tcpJsonMuteIsProtected =
            room.createdBy === targetUser!.id ||
            await storage.isModUser(roomId, targetUser!.id) ||
            await storage.isGlobalAdmin(targetUser!.id);
          if (tcpJsonMuteIsProtected) {
            sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-mute" });
            return;
          }
          await storage.muteUser(roomId, targetUser!.id);
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `${target} telah di-mute`, isSystem: true });
          const list   = await storage.getParticipants(roomId);
          const muteNotifyBuf = buildChatroomNotification({
            txId: 0, chatroomName: room.name, notificationType: ROOM_NOTIFY.MUTED,
            targetUsername: target!, message: `${target} telah di-mute`,
          });
          const muteStatusBuf = buildChatroomUserStatus({
            txId: 0, chatroomName: room.name, username: target!, status: USER_STATUS.MUTED,
          });
          broadcastToRoom(roomId, { type: "MUTED",   roomId, username: target! });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
          broadcastToTcpRoom(roomId, {}, undefined, muteNotifyBuf);
          broadcastToTcpRoom(roomId, {}, undefined, muteStatusBuf);
          sendJson(client, { type: "CMD_OK", cmd, target });
          break;
        }
        case "unmute": {
          await storage.unmuteUser(roomId, targetUser!.id);
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "4CAF50", text: `${target} sudah di-unmute`, isSystem: true });
          const list   = await storage.getParticipants(roomId);
          const unmuteNotifyBuf = buildChatroomNotification({
            txId: 0, chatroomName: room.name, notificationType: ROOM_NOTIFY.UNMUTED,
            targetUsername: target!, message: `${target} sudah di-unmute`,
          });
          const unmuteStatusBuf = buildChatroomUserStatus({
            txId: 0, chatroomName: room.name, username: target!, status: USER_STATUS.NORMAL,
          });
          broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: target! });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
          broadcastToTcpRoom(roomId, {}, undefined, unmuteNotifyBuf);
          broadcastToTcpRoom(roomId, {}, undefined, unmuteStatusBuf);
          sendJson(client, { type: "CMD_OK", cmd, target });
          break;
        }
        case "mod": {
          await storage.modUser(roomId, targetUser!.id);
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "9C27B0", text: `${target} dipromosikan jadi Mod`, isSystem: true });
          const list   = await storage.getParticipants(roomId);
          const modNotifyBuf = buildChatroomNotification({
            txId: 0, chatroomName: room.name, notificationType: ROOM_NOTIFY.MODDED,
            targetUsername: target!, message: `${target} dipromosikan jadi Mod`,
          });
          const modStatusBuf = buildChatroomUserStatus({
            txId: 0, chatroomName: room.name, username: target!, status: USER_STATUS.MOD,
          });
          broadcastToRoom(roomId, { type: "MOD",     roomId, username: target! });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
          broadcastToTcpRoom(roomId, {}, undefined, modNotifyBuf);
          broadcastToTcpRoom(roomId, {}, undefined, modStatusBuf);
          sendJson(client, { type: "CMD_OK", cmd, target });
          break;
        }
        case "unmod": {
          await storage.unmodUser(roomId, targetUser!.id);
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "9C27B0", text: `${target} dicopot dari Mod`, isSystem: true });
          const list   = await storage.getParticipants(roomId);
          const unmodNotifyBuf = buildChatroomNotification({
            txId: 0, chatroomName: room.name, notificationType: ROOM_NOTIFY.UNMODDED,
            targetUsername: target!, message: `${target} dicopot dari Mod`,
          });
          const unmodStatusBuf = buildChatroomUserStatus({
            txId: 0, chatroomName: room.name, username: target!, status: USER_STATUS.NORMAL,
          });
          broadcastToRoom(roomId, { type: "UNMOD",   roomId, username: target! });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
          broadcastToTcpRoom(roomId, {}, undefined, unmodNotifyBuf);
          broadcastToTcpRoom(roomId, {}, undefined, unmodStatusBuf);
          sendJson(client, { type: "CMD_OK", cmd, target });
          break;
        }
        case "warn": {
          const note   = msg ? ` — "${msg}"` : "";
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `${target} mendapat peringatan${note}`, isSystem: true });
          broadcastToRoom(roomId, { type: "WARNED",  roomId, username: target!, message: msg });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          sendJson(client, { type: "CMD_OK", cmd, target });
          break;
        }
        case "bump": {
          if (target) {
            // /bump username — soft-disconnect target user, stays in participants, can rejoin immediately
            const bumpTarget = targetUser ?? await storage.getUserByUsername(target);
            if (!bumpTarget) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
            // Mirrors hasAdminOrModeratorRights(): owner, mod, global admin cannot be bumped
            const tcpJsonBumpIsProtected =
              room.createdBy === bumpTarget.id ||
              await storage.isModUser(roomId, bumpTarget.id) ||
              await storage.isGlobalAdmin(bumpTarget.id);
            if (tcpJsonBumpIsProtected) {
              sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Admin atau moderator tidak bisa di-bump" });
              return;
            }
            softBumpUserFromRoom(bumpTarget.id, roomId);
            const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `${target} di-bump oleh ${client.username}`, isSystem: true });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
            sendJson(client, { type: "CMD_OK", cmd, target });
          } else {
            // /bump — move chatroom to top of room list
            await storage.updateChatroom(roomId, { createdAt: new Date() });
            const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `Chatroom di-bump oleh ${client.username}`, isSystem: true });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
            sendJson(client, { type: "CMD_OK", cmd });
          }
          break;
        }
        case "lock": {
          await storage.updateChatroom(roomId, { isLocked: true });
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "795548", text: "Chatroom telah dikunci", isSystem: true });
          broadcastToRoom(roomId, { type: "LOCKED",  roomId });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          sendJson(client, { type: "CMD_OK", cmd });
          break;
        }
        case "unlock": {
          const unlockRoomTcp = await storage.getChatroom(roomId);
          const unlockCapacityTcp = unlockRoomTcp?.createdBy ? await getRoomCapacityForUser(unlockRoomTcp.createdBy) : 25;
          await storage.updateChatroom(roomId, { isLocked: false, maxParticipants: unlockCapacityTcp });
          const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "795548", text: "Chatroom telah dibuka", isSystem: true });
          broadcastToRoom(roomId, { type: "UNLOCKED", roomId });
          broadcastToRoom(roomId, { type: "MESSAGE",  roomId, message: sysMsg });
          sendJson(client, { type: "CMD_OK", cmd });
          break;
        }
        case "broadcast": case "announce": {
          if (!msg?.trim()) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Pesan wajib" }); return; }
          const prefix = cmd === "broadcast" ? "[Broadcast]" : "[Announcement]";
          const sysMsg = await storage.postMessage(roomId, { senderUsername: client.username!, senderColor: "2196F3", text: `${prefix} ${msg}`, isSystem: true });
          if (cmd === "announce") broadcastToRoom(roomId, { type: "ANNOUNCEMENT", roomId, message: msg });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
          sendJson(client, { type: "CMD_OK", cmd });
          break;
        }
        default:
          sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: `Unknown cmd: ${cmd}` });
      }
      break;
    }

    case "GET_ROOMS": {
      const PAGE_SIZE  = 5;
      const page       = (packet.page as number) ?? 1;
      const categoryId = packet.categoryId as number | undefined;
      const allRooms   = categoryId
        ? await storage.getChatroomsByCategory(categoryId)
        : await storage.getChatrooms();
      const totalPages = Math.ceil(allRooms.length / PAGE_SIZE);
      const chatrooms  = allRooms.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      sendJson(client, { type: "ROOMS_LIST", chatrooms, page, totalPages });
      break;
    }

    case "GET_MESSAGES": {
      if (client.state !== "AUTHENTICATED") { sendJson(client, { type: "ERROR", code: ErrCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return; }
      const roomId   = (packet.roomId as string) || client.roomId;
      if (!roomId) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "roomId wajib" }); return; }
      const after    = packet.after as string | undefined;
      const limit    = (packet.limit as number) ?? 50;
      const messages = await storage.getMessages(roomId, after ? { after } : undefined);
      sendJson(client, { type: "MESSAGES", roomId, messages: messages.slice(-limit) });
      break;
    }

    case "GET_PARTICIPANTS": {
      const roomId = (packet.roomId as string) || client.roomId;
      if (!roomId) { sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "roomId wajib" }); return; }
      const room = await storage.getChatroom(roomId);
      const list = await storage.getParticipants(roomId);
      sendJson(client, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
      break;
    }

    case "GET_THEME": {
      const roomId = (packet.roomId as string) || client.roomId;
      sendJson(client, { type: "THEME", roomId: roomId || "", theme: DEFAULT_THEME });
      break;
    }

    case "GET_STATS": {
      sendJson(client, {
        type:          "STATS",
        connections:   clients.size,
        authenticated: Array.from(clients.values()).filter((c) => c.state === "AUTHENTICATED").length,
        totalEvents:   Array.from(clients.values()).reduce((a, c) => a + c.eventsDispatched, 0),
      });
      break;
    }

    case "PING": {
      sendJson(client, { type: "PONG", timestamp: Date.now() });
      break;
    }

    default:
      sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: `Unknown packet type: ${type}` });
  }
}

// ─── TCP Server ───────────────────────────────────────────────────────────────

export function startTcpGateway(): net.Server {
  const port = parseInt(process.env.TCP_PORT || "9119", 10);

  // Register cross-gateway TCP leave canceller so the WS gateway can cancel
  // TCP-originated pending leaves when a user rejoins via WebSocket.
  // Returns true when a timer was found and cancelled.
  registerTcpLeaveCanceller((userId: string, roomId: string): boolean => {
    const key     = `tcp:${userId}:${roomId}`;
    const pending = pendingTcpLeaves.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      pendingTcpLeaves.delete(key);
      return true;
    }
    return false;
  });

  // Register TCP room presence checker so the WS gateway can determine whether
  // the user is still in a room via TCP before starting a WS grace timer.
  registerTcpRoomPresence((userId: string, roomId: string): boolean => {
    for (const [, c] of clients) {
      if (c.state === "AUTHENTICATED" && c.userId === userId && c.subscribedRooms.has(roomId)) {
        return true;
      }
    }
    return false;
  });

  registerTcpRoomEjector((userId: string, roomId: string, roomName: string, reason: "banned" | "kicked" | "bumped"): void => {
    const pendingKey = `tcp:${userId}:${roomId}`;
    const pending = pendingTcpLeaves.get(pendingKey);
    if (pending) {
      clearTimeout(pending.timer);
      pendingTcpLeaves.delete(pendingKey);
    }

    for (const [, c] of clients) {
      if (c.state !== "AUTHENTICATED" || c.userId !== userId || !c.subscribedRooms.has(roomId)) continue;
      // Bump: send BUMPED and close socket; user stays in participants and can rejoin immediately
      if (reason === "bumped") {
        sendJson(c, { type: "BUMPED", roomId, username: c.username });
        c.socket.destroy();
        return;
      }
      c.subscribedRooms.delete(roomId);
      if (c.roomId === roomId) c.roomId = undefined;
      const message = reason === "banned"
        ? `You have banned in chatroom ${roomName}`
        : `You have been kicked from chatroom ${roomName}`;
      if (reason === "banned") {
        if (c.protocol === "binary") {
          sendBinary(c, buildChatroomNotification({
            txId: 0,
            chatroomName: roomName,
            notificationType: ROOM_NOTIFY.BANNED,
            targetUsername: c.username ?? "",
            message,
          }));
          sendBinary(c, buildChatroomUserStatus({
            txId: 0,
            chatroomName: roomName,
            username: c.username ?? "",
            status: USER_STATUS.BANNED,
          }));
        } else {
          sendJson(c, { type: "BANNED", roomId, username: c.username, message });
          sendJson(c, { type: "ERROR", code: ErrCode.UNDEFINED, message });
        }
      } else {
        if (c.protocol === "binary") {
          sendBinary(c, buildChatroomNotification({
            txId: 0,
            chatroomName: roomName,
            notificationType: ROOM_NOTIFY.KICKED,
            targetUsername: c.username ?? "",
            message,
          }));
        } else {
          sendJson(c, { type: "KICKED", roomId, username: c.username, message });
          sendJson(c, { type: "ERROR", code: ErrCode.UNDEFINED, message });
        }
      }
    }
  });

  // Periodic idle-connection cleanup (PurgeConnectionTask)
  const purgeTimer = setInterval(() => {
    const now      = Date.now();
    const toDelete: string[] = [];
    clients.forEach((client, id) => {
      if (now - client.lastActivity > KEEP_ALIVE_TIMEOUT_MS) {
        if (client.protocol === "binary") {
          sendBinary(client, buildSessionTerminated(0));
        } else {
          sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Connection timed out" });
        }
        client.state = "DISCONNECTED";
        client.socket.destroy();
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => clients.delete(id));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  const server = net.createServer((socket) => {
    const id        = `tcp_${++clientIdCount}`;
    const sessionId = randomUUID();
    const now       = Date.now();

    const client: TcpClient = {
      socket,
      id,
      sessionId,
      state:             "CONNECTING",
      protocol:          "detecting",
      jsonBuffer:        "",
      binBuffer:         Buffer.alloc(0),
      connectedAt:       now,
      lastActivity:      now,
      packetCount:       0,
      packetWindowStart: now,
      eventsDispatched:  0,
      migLevel:          1,
      isChatroomAdmin:   false,
      subscribedRooms:   new Set<string>(),
      chatColor:         "",
    };
    clients.set(id, client);
    log(`[TCP] Client connected: ${id} from ${socket.remoteAddress}`, "gateway-tcp");

    socket.on("data", (chunk: Buffer) => {
      client.lastActivity = Date.now();

      // ── Protocol detection ───────────────────────────────────────────────
      if (client.protocol === "detecting") {
        // Peek at first byte to decide protocol
        const firstByte = chunk[0];
        if (firstByte === 0x02) {
          // Binary FusionPacket protocol (mobile Expo app)
          client.protocol = "binary";
          log(`[TCP] ${id}: binary FusionPacket protocol detected`, "gateway-tcp");
        } else {
          // JSON protocol (web debug / existing clients)
          client.protocol = "json";
          log(`[TCP] ${id}: JSON protocol detected`, "gateway-tcp");
          // Send WELCOME for JSON clients only
          sendJson(client, { type: "WELCOME", clientId: id, sessionId, version: APP_VERSION });
        }
      }

      // ── Binary path ──────────────────────────────────────────────────────
      if (client.protocol === "binary") {
        // Append to binary buffer
        client.binBuffer = Buffer.concat([client.binBuffer, chunk]);

        // Rate limit check
        if (isRateLimited(client)) {
          sendBinary(client, buildSessionTerminated(0));
          client.state = "DISCONNECTED";
          socket.destroy();
          clients.delete(id);
          return;
        }

        // Extract and process complete FusionPacket frames
        let offset = 0;
        while (offset < client.binBuffer.length) {
          const size = packetSize(client.binBuffer, offset);
          if (size === -1) break;  // incomplete packet — wait for more data
          if (offset + size > client.binBuffer.length) break;

          const pkt = decodePacket(client.binBuffer, offset);
          offset += size;

          if (pkt) {
            handleBinaryPacket(client, pkt.type, pkt.txId, pkt.fields).catch((err) => {
              const safeMsg = err instanceof Error ? maskSensitiveStr(err.message) : String(err);
              console.error(`[TCP/binary] Error handling packet type ${pkt.type} from ${id}:`, safeMsg);
            });
          }
        }
        // Keep only the unprocessed remainder
        client.binBuffer = client.binBuffer.slice(offset);
        return;
      }

      // ── JSON path ────────────────────────────────────────────────────────
      client.jsonBuffer += chunk.toString("utf8");

      if (isRateLimited(client)) {
        sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Too many requests" });
        client.state = "DISCONNECTED";
        socket.destroy();
        clients.delete(id);
        return;
      }

      let newlineIdx: number;
      while ((newlineIdx = client.jsonBuffer.indexOf("\n")) !== -1) {
        const line = client.jsonBuffer.slice(0, newlineIdx).trim();
        client.jsonBuffer = client.jsonBuffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const packet = JSON.parse(line) as Record<string, unknown>;
          handleJsonPacket(client, packet).catch((err) => {
            const safeMsg = err instanceof Error ? maskSensitiveStr(err.message) : String(err);
            console.error(`[TCP/json] Error handling packet from ${id}:`, safeMsg);
          });
        } catch {
          sendJson(client, { type: "ERROR", code: ErrCode.UNDEFINED, message: "Invalid JSON packet" });
        }
      }
    });

    socket.on("close", async () => {
      client.state = "DISCONNECTED";
      clients.delete(id);
      log(`[TCP] Client disconnected: ${id}`, "gateway-tcp");

      // ── TCP disconnect grace period (mirrors WS gateway pendingLeaves) ───────
      // For every room this client was subscribed to, defer "has left" for
      // TCP_LEAVE_GRACE_MS.  If the client reconnects (JOIN_ROOM) within that
      // window the timer is cancelled and no enter/leave messages are emitted.
      for (const roomId of Array.from(client.subscribedRooms)) {
        if (!client.userId || !client.username) continue;
        const graceKey = `tcp:${client.userId}:${roomId}`;

        // Cancel any existing timer for the same room (shouldn't happen, but safe)
        const existing = pendingTcpLeaves.get(graceKey);
        if (existing) { clearTimeout(existing.timer); }

        // If the same user is still present in this room via another TCP connection
        // or via the WebSocket gateway, they haven't actually left — skip the timer.
        const stillInRoomViaTcp = [...clients.values()].some(
          (c) => c.state === "AUTHENTICATED" && c.userId === client.userId && c.subscribedRooms.has(roomId),
        );
        const stillInRoomViaWs = isUserInRoomViaWs(client.userId, roomId);
        if (stillInRoomViaTcp || stillInRoomViaWs) continue;

        const disconnectedAt = Date.now();
        const username       = client.username;
        const color          = client.chatColor;
        const migLevel       = client.migLevel;
        const userId         = client.userId;

        const timer = setTimeout(async () => {
          pendingTcpLeaves.delete(graceKey);
          // Produce and broadcast a synthetic leave message (same as handleLeaveRoom)
          try {
            const room = await storage.getChatroom(roomId);
            if (!room) return;
            await storage.leaveChatroom(roomId, userId);
            const leaveDisplayName = migLevel >= 1 ? `${username}[${migLevel}]` : username;
            const leaveMsg = await storage.postMessage(roomId, {
              senderId: userId, senderUsername: username, senderColor: color || "#aaaaaa",
              text: `${room.name}::${leaveDisplayName} has left`, isSystem: true,
            });
            const updList = await storage.getParticipants(roomId);
            broadcastToRoom(roomId, { type: "MESSAGE",      roomId, message: leaveMsg });
            broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, updList));
            botNotifyLeave(roomId, username);
            log(`[TCP] Grace expired — broadcast leave for ${username} in ${room.name}`, "gateway-tcp");
          } catch (err) {
            console.error("[TCP] Grace period leave error:", err);
          }
        }, TCP_LEAVE_GRACE_MS);

        pendingTcpLeaves.set(graceKey, { timer, roomId, userId, username, color, migLevel, disconnectedAt });
        log(`[TCP] Grace period started for ${username} in room ${roomId} (${TCP_LEAVE_GRACE_MS / 1000}s)`, "gateway-tcp");
      }
    });

    socket.on("error", (err) => {
      console.error(`[TCP] Socket error for ${id}:`, err.message);
      client.state = "DISCONNECTED";
      clients.delete(id);
    });
  });

  server.listen(port, "0.0.0.0", () => {
    log(`TCP Gateway listening on port ${port} (dual-protocol: binary FusionPacket + JSON)`, "gateway-tcp");
  });

  server.on("error", (err) => {
    console.error("[TCP] Server error:", err.message);
  });

  return server;
}

export function getTcpClientCount(): number {
  return clients.size;
}

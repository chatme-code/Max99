/**
 * ServerGeneratedReceivedEventPusher
 *
 * TypeScript port of:
 *   com/projectgoth/fusion/chatsync/ServerGeneratedReceivedEventPusher.java
 *   extends MessageStatusEventPersistable
 *
 * Java behaviour:
 *   1. After the server saves an inbound message it creates this pusher with
 *      status = RECEIVED and serverGenerated = true.
 *   2. store(stores) calls super.store() → persists to Redis sorted set
 *      (CV:{convKey}:E) via zadd — the same set backed by
 *      MessageStatusEventPersistable.storePipeline().
 *   3. Then it looks up the sender's live proxy (registryPrx.findUserObject)
 *      and calls messageSender.putMessageStatusEvent() — i.e. it pushes
 *      a real-time "your message was received by the server" event back to
 *      the original sender so their UI can flip ✓ (sending) → ✓ (delivered).
 *   4. If the sender has since gone offline, ObjectNotFoundException is caught
 *      and only a warning is logged (typical for bots).
 *
 * Our equivalent:
 *   • store(): saveMessageStatusEvent() → Redis (CV:{id}:E)
 *   • push(): broadcastToUser(senderUserId, MESSAGE_STATUS{RECEIVED})
 *             only if sender is currently online (isUserOnline guard mirrors
 *             the ObjectNotFoundException catch in Java).
 *
 * MessageStatusEventTypeEnum values (mirrors Java Enums.java):
 *   COMPOSING = 0
 *   RECEIVED  = 1   ← this class always uses RECEIVED (serverGenerated=true)
 *   READ      = 2
 */

import { saveMessageStatusEvent } from "../../redis";
import { broadcastToUser, isUserOnline } from "../../gateway";

// ─── Types (mirror Java Enums.MessageStatusEventTypeEnum) ────────────────────

export type MessageStatusEventType = "COMPOSING" | "RECEIVED" | "READ";

export const MessageStatusEventTypeEnum: Record<MessageStatusEventType, number> = {
  COMPOSING: 0,
  RECEIVED:  1,
  READ:      2,
};

// ─── MessageStatusEvent shape (mirrors MessageStatusEvent.java fields) ────────

export interface MessageStatusEventData {
  /** Conversation/chat key — maps to Java chatID (ChatDefinition) */
  conversationId: string;
  /** Message GUID — mirrors messageGUID (@Expose "G") */
  messageId: string;
  /** The user who originally sent the message (mirrors messageSource) */
  senderUserId: string;
  senderUsername: string;
  /** Status of this event — always RECEIVED for server-generated events */
  status: MessageStatusEventType;
  /** True when the server auto-generated this (not sent by client) */
  serverGenerated: boolean;
  /** Original message timestamp (ms) — used as Redis zadd score */
  timestamp: number;
}

// ─── ServerGeneratedReceivedEventPusher ──────────────────────────────────────

export class ServerGeneratedReceivedEventPusher {
  private readonly event: MessageStatusEventData;

  /**
   * @param convId      - Conversation ID (maps to Java chatID / ChatDefinition)
   * @param msgId       - DB message UUID (maps to Java messageGUID)
   * @param senderUserId - WS userId of the original sender
   * @param senderUsername - Username of the original sender
   * @param timestamp   - Original message creation timestamp (ms)
   *
   * Mirrors Java constructor:
   *   ServerGeneratedReceivedEventPusher(FusionPktMessage msg,
   *     Enums.MessageStatusEventTypeEnum status, boolean serverGenerated,
   *     RegistryPrx regy)
   * We always pass status=RECEIVED and serverGenerated=true.
   */
  constructor(
    convId: string,
    msgId: string,
    senderUserId: string,
    senderUsername: string,
    timestamp: number,
  ) {
    this.event = {
      conversationId:  convId,
      messageId:       msgId,
      senderUserId,
      senderUsername,
      status:          "RECEIVED",
      serverGenerated: true,
      timestamp,
    };
  }

  /**
   * store() — mirrors MessageStatusEventPersistable.store(ChatSyncStore[] stores)
   *
   * 1. Persists the RECEIVED event to Redis sorted set (CV:{convId}:E)
   *    via saveMessageStatusEvent() — equivalent to:
   *      pipelineStore.zadd(this, this.messageTimestamp, this.getValue())
   *
   * 2. Pushes the MESSAGE_STATUS WebSocket event back to the sender
   *    (mirrors messageSender.putMessageStatusEvent(this.toIceObject())).
   *    If sender is offline, logs a warning and skips — mirrors the
   *    ObjectNotFoundException catch block in Java.
   */
  async store(): Promise<void> {
    const { conversationId, messageId, senderUsername, senderUserId, timestamp } = this.event;

    // Step 1: persist to Redis (CV:{convId}:E) — mirrors super.store(stores)
    await saveMessageStatusEvent(
      conversationId,
      messageId,
      senderUsername,
      new Date(timestamp),
    );

    // Step 2: push real-time RECEIVED event to sender
    // Mirrors: messageSender.putMessageStatusEvent(this.toIceObject())
    // ObjectNotFoundException equivalent: isUserOnline guard
    if (isUserOnline(senderUserId)) {
      broadcastToUser(senderUserId, {
        type:            "MESSAGE_STATUS",
        conversationId,
        messageId,
        status:          "RECEIVED",
        serverGenerated: true,
        timestamp,
      });
    } else {
      // Mirrors Java warn: "Message sender went offline before server-generated
      // RECEIVED event could be pushed (typical bot behaviour)"
      console.warn(
        `[ServerGeneratedReceivedEventPusher] sender ${senderUsername} offline` +
        ` — RECEIVED event not pushed for msg ${messageId}`,
      );
    }
  }
}

/**
 * Convenience factory — call this immediately after a message is saved.
 * Mirrors the Java call site in FusionMessageProcessor / ChatSyncController:
 *   new ServerGeneratedReceivedEventPusher(msg, RECEIVED, true, regy).store(stores)
 */
export async function pushServerGeneratedReceivedEvent(
  convId: string,
  msgId: string,
  senderUserId: string,
  senderUsername: string,
  timestamp: number,
): Promise<void> {
  const pusher = new ServerGeneratedReceivedEventPusher(
    convId, msgId, senderUserId, senderUsername, timestamp,
  );
  await pusher.store();
}

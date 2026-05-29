/**
 * fusionCodec.ts  –  Server-side binary FusionPacket encoder / decoder
 *
 * Wire format (big-endian), ported from FusionPacket.java + FusionField.java:
 *
 *   [1 byte]  packet marker = 0x02
 *   [2 bytes] PacketType (int16)
 *   [2 bytes] transactionId (int16)
 *   [4 bytes] contentLength (int32) = Σ(6 + fieldLen) for each field
 *   ── repeated fields ──────────────────────────────────────────────────────
 *   [2 bytes] fieldNumber (int16)
 *   [4 bytes] fieldLength (int32)
 *   [N bytes] fieldBytes  (raw — int=4 B, short=2 B, byte=1 B, string=UTF-8)
 */

export const PACKET_MARKER  = 0x02;
export const HEADER_LEN     = 9;   // 1 marker + 2 type + 2 txId + 4 contentLen
export const FIELD_HDR_LEN  = 6;   // 2 fieldNum + 4 fieldLen

// ── Packet type constants (mirrors FusionPacket.java) ─────────────────────────
export const PKT = {
  ERROR:                       0,
  OK:                          1,
  PING:                        2,
  PONG:                        3,
  ALERT:                       5,
  LOGIN:                     200,
  LOGIN_CHALLENGE:            201,
  LOGIN_RESPONSE:             202,
  LOGIN_OK:                   203,
  SLIM_LOGIN:                 209,
  SLIM_LOGIN_OK:              210,
  SLIM_LOGIN_CHALLENGE:       212,
  LOGOUT:                     300,
  SESSION_TERMINATED:         301,
  GET_CONTACTS:               400,
  GROUP:                      401,
  CONTACT:                    402,
  GET_CONTACTS_COMPLETE:      403,
  PRESENCE:                   404,
  MESSAGE:                    500,
  LEAVE_PRIVATE_CHAT:         507,
  GET_MESSAGES:               550,
  GET_CHATS:                  551,
  HAVE_LATEST_CHAT_LIST:      552,
  CHAT:                       560,
  CHAT_LIST_VERSION:          561,
  END_MESSAGES:               562,
  GET_CHATROOMS:              700,
  CHATROOM:                   701,
  GET_CHATROOMS_COMPLETE:     702,
  JOIN_CHATROOM:              703,
  LEAVE_CHATROOM:             704,
  CREATE_CHATROOM:            705,
  KICK_CHATROOM_PARTICIPANT:  706,
  GET_CHATROOM_PARTICIPANTS:  707,
  CHATROOM_PARTICIPANTS:      708,
  MUTE_CHATROOM_PARTICIPANT:  709,
  UNMUTE_CHATROOM_PARTICIPANT:710,
  ADD_FAVOURITE_CHATROOM:           711,
  REMOVE_FAVOURITE_CHATROOM:        712,
  GET_CHATROOM_CATEGORIES:          713,
  CHATROOM_CATEGORY:                714,
  GET_CHATROOM_CATEGORIES_COMPLETE: 715,
  GET_CATEGORIZED_CHATROOMS:        716,
  GET_CATEGORIZED_CHATROOMS_COMPLETE: 717,
  CHATROOM_NOTIFICATION:            718,
  CHATROOM_USER_STATUS:             720,
} as const;

// ── CHATROOM_NOTIFICATION sub-types ───────────────────────────────────────────
// Sent server→client as field 2 (byte) inside CHATROOM_NOTIFICATION (718).
export const ROOM_NOTIFY = {
  KICKED:   0,
  BANNED:   1,
  MUTED:    2,
  UNMUTED:  3,
  MODDED:   4,
  UNMODDED: 5,
} as const;

// ── CHATROOM_USER_STATUS role values ──────────────────────────────────────────
// Sent server→client as field 3 (byte) inside CHATROOM_USER_STATUS (720).
export const USER_STATUS = {
  NORMAL: 0,
  MOD:    1,
  OWNER:  2,
  MUTED:  3,
  BANNED: 4,
} as const;

// ── Destination type (field 3 of MESSAGE) ─────────────────────────────────────
export const DEST_TYPE = {
  INDIVIDUAL: 1,
  GROUP_CHAT: 2,
  CHATROOM:   3,
} as const;

// ── Decoded packet ────────────────────────────────────────────────────────────
export interface RawPacket {
  type:   number;
  txId:   number;
  fields: Map<number, Buffer>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection / decoding
// ─────────────────────────────────────────────────────────────────────────────

/** True when buf (from offset) contains a fully-buffered FusionPacket. */
export function haveFusionPacket(buf: Buffer, offset = 0): boolean {
  if (buf.length - offset < HEADER_LEN) return false;
  if (buf[offset] !== PACKET_MARKER) return false;
  const contentLen = buf.readInt32BE(offset + 5);
  if (contentLen < 0 || contentLen > 358_400) return false;
  return buf.length - offset >= HEADER_LEN + contentLen;
}

/** Total wire byte length of the next packet at offset (or -1 if incomplete). */
export function packetSize(buf: Buffer, offset = 0): number {
  if (buf.length - offset < HEADER_LEN) return -1;
  if (buf[offset] !== PACKET_MARKER) return -1;
  const contentLen = buf.readInt32BE(offset + 5);
  if (contentLen < 0 || contentLen > 358_400) return -1;
  return HEADER_LEN + contentLen;
}

/** Decode one FusionPacket from buf at offset. Returns null if incomplete/invalid. */
export function decodePacket(buf: Buffer, offset = 0): RawPacket | null {
  if (!haveFusionPacket(buf, offset)) return null;
  const type       = buf.readInt16BE(offset + 1);
  const txId       = buf.readInt16BE(offset + 3);
  const contentLen = buf.readInt32BE(offset + 5);

  const fields = new Map<number, Buffer>();
  let pos = offset + HEADER_LEN;
  const end = pos + contentLen;

  while (pos < end) {
    if (pos + FIELD_HDR_LEN > end) break;
    const fieldNum = buf.readInt16BE(pos);       pos += 2;
    const fieldLen = buf.readInt32BE(pos);       pos += 4;
    if (fieldLen < 0 || pos + fieldLen > end) break;
    fields.set(fieldNum, buf.slice(pos, pos + fieldLen));
    pos += fieldLen;
  }
  return { type, txId, fields };
}

// ─────────────────────────────────────────────────────────────────────────────
// Field value extractors
// ─────────────────────────────────────────────────────────────────────────────

export function getStr(pkt: RawPacket, field: number): string | null {
  const b = pkt.fields.get(field);
  return b ? b.toString('utf-8') : null;
}

export function getInt32(pkt: RawPacket, field: number): number | null {
  const b = pkt.fields.get(field);
  if (!b || b.length < 4) return null;
  return b.readInt32BE(0);
}

export function getInt16(pkt: RawPacket, field: number): number | null {
  const b = pkt.fields.get(field);
  if (!b || b.length < 2) return null;
  return b.readInt16BE(0);
}

export function getUInt8(pkt: RawPacket, field: number): number | null {
  const b = pkt.fields.get(field);
  if (!b || b.length < 1) return null;
  return b[0];
}

/** Read a field encoded as 8-byte big-endian long (hi int32 + lo uint32). */
export function getLong(pkt: RawPacket, field: number): number | null {
  const b = pkt.fields.get(field);
  if (!b || b.length < 8) return null;
  const hi = b.readInt32BE(0);
  const lo = b.readUInt32BE(4);
  return hi * 0x100000000 + lo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────────────

type FieldDef =
  | { f: number; type: 'str';   v: string  }
  | { f: number; type: 'i64';   v: number  }
  | { f: number; type: 'i32';   v: number  }
  | { f: number; type: 'i16';   v: number  }
  | { f: number; type: 'u8';    v: number  }
  | { f: number; type: 'bool';  v: boolean }
  | { f: number; type: 'raw';   v: Buffer  };

function makeLongBuffer(ms: number): Buffer {
  const buf = Buffer.allocUnsafe(8);
  const hi = Math.floor(ms / 0x100000000);
  const lo = ms >>> 0;
  buf.writeInt32BE(hi, 0);
  buf.writeInt32BE(lo, 4);
  return buf;
}

function fieldBytes(fd: FieldDef): Buffer {
  let val: Buffer;
  switch (fd.type) {
    case 'str':  val = Buffer.from(fd.v, 'utf-8'); break;
    case 'i64':  val = makeLongBuffer(fd.v); break;
    case 'i32':  val = Buffer.allocUnsafe(4); val.writeInt32BE(fd.v, 0); break;
    case 'i16':  val = Buffer.allocUnsafe(2); val.writeInt16BE(fd.v, 0); break;
    case 'u8':   val = Buffer.from([fd.v & 0xff]);                        break;
    case 'bool': val = Buffer.from([fd.v ? 1 : 0]);                       break;
    case 'raw':  val = fd.v;                                              break;
  }
  const hdr = Buffer.allocUnsafe(FIELD_HDR_LEN);
  hdr.writeInt16BE(fd.f, 0);
  hdr.writeInt32BE(val.length, 2);
  return Buffer.concat([hdr, val]);
}

/** Encode a FusionPacket to a Node.js Buffer. */
export function encodePacket(type: number, txId: number, fields: FieldDef[]): Buffer {
  const encodedFields = fields.map(fieldBytes);
  const contentLen    = encodedFields.reduce((s, b) => s + b.length, 0);

  const hdr = Buffer.allocUnsafe(HEADER_LEN);
  hdr[0] = PACKET_MARKER;
  hdr.writeInt16BE(type,       1);
  hdr.writeInt16BE(txId,       3);
  hdr.writeInt32BE(contentLen, 5);

  return Buffer.concat([hdr, ...encodedFields]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-built server→client packet builders
// ─────────────────────────────────────────────────────────────────────────────

/** Server→client: challenge the client to prove their password. */
export function buildLoginChallenge(txId: number, challenge: string, sessionId: string): Buffer {
  return encodePacket(PKT.LOGIN_CHALLENGE, txId, [
    { f: 1, type: 'str', v: challenge  },
    { f: 2, type: 'str', v: sessionId  },
  ]);
}

/** Server→client: login successful. */
export function buildLoginOk(txId: number): Buffer {
  return encodePacket(PKT.LOGIN_OK, txId, []);
}

/** Server→client: error response. */
export function buildError(txId: number, code: number, message: string): Buffer {
  return encodePacket(PKT.ERROR, txId, [
    { f: 1, type: 'i16', v: code    },
    { f: 2, type: 'str', v: message },
  ]);
}

/** Server→client: pong reply. */
export function buildPong(txId: number): Buffer {
  return encodePacket(PKT.PONG, txId, []);
}

/** Server→client: generic OK. */
export function buildOk(txId: number): Buffer {
  return encodePacket(PKT.OK, txId, []);
}

/** Server→client: session terminated. */
export function buildSessionTerminated(txId = 0): Buffer {
  return encodePacket(PKT.SESSION_TERMINATED, txId, []);
}

/**
 * Server→client: send a chatroom message.
 * destinationType 3 = CHATROOM.
 */
export function buildChatroomMessage(params: {
  txId:           number;
  source:         string;     // sender username
  destination:    string;     // chatroom name / id
  text:           string;
  sourceColor?:   number;     // 0xRRGGBB int
  guid?:          string;
  timestamp?:     number;     // ms epoch
}): Buffer {
  const { txId, source, destination, text, sourceColor, guid, timestamp } = params;
  const fields: FieldDef[] = [
    { f: 1,  type: 'u8',  v: 1           },   // messageType=FUSION(1)
    { f: 2,  type: 'str', v: source       },   // source username
    { f: 3,  type: 'u8',  v: DEST_TYPE.CHATROOM },  // destinationType=CHATROOM
    { f: 4,  type: 'str', v: destination  },   // chatroom name
    { f: 6,  type: 'i16', v: 1            },   // contentType=TEXT(1)
    { f: 8,  type: 'str', v: text         },   // content text
  ];
  if (sourceColor !== undefined) {
    fields.push({ f: 12, type: 'i32', v: sourceColor });
  }
  if (guid) {
    fields.push({ f: 15, type: 'str', v: guid });
  }
  if (timestamp !== undefined) {
    // field 16 = timestamp as long (8 bytes) — pack as i32 high + i32 low
    const tsBuf = Buffer.allocUnsafe(8);
    const hi = Math.floor(timestamp / 0x100000000);
    const lo = timestamp >>> 0;
    tsBuf.writeInt32BE(hi, 0);
    tsBuf.writeInt32BE(lo, 4);
    fields.push({ f: 16, type: 'raw', v: tsBuf });
  }
  return encodePacket(PKT.MESSAGE, txId, fields);
}

/**
 * Server→client: chatroom info packet (CHATROOM = 701).
 * Mirrors FusionPktDataChatroom field layout.
 */
export function buildChatroomInfo(params: {
  txId:         number;
  name:         string;
  description?: string;
  maxPartic?:   number;
  numPartic?:   number;
}): Buffer {
  const { txId, name, description, maxPartic, numPartic } = params;
  const fields: FieldDef[] = [
    { f: 1, type: 'str', v: name },
  ];
  if (description) fields.push({ f: 2, type: 'str', v: description });
  if (maxPartic !== undefined) fields.push({ f: 3, type: 'i32', v: maxPartic });
  if (numPartic !== undefined) fields.push({ f: 4, type: 'i32', v: numPartic });
  return encodePacket(PKT.CHATROOM, txId, fields);
}

/**
 * Server→client: chatroom participants list (CHATROOM_PARTICIPANTS = 708).
 * Participants encoded as a newline-delimited string list in field 2.
 */
export function buildChatroomParticipants(txId: number, chatroomName: string, participants: string[]): Buffer {
  return encodePacket(PKT.CHATROOM_PARTICIPANTS, txId, [
    { f: 1, type: 'str', v: chatroomName },
    { f: 2, type: 'str', v: participants.join('\n') },
  ]);
}

/**
 * Server→client: chatroom moderation notification (CHATROOM_NOTIFICATION = 718).
 * Mirrors FusionPktChatroomNotification.java field layout:
 *   field 1 = chatroomName (string)
 *   field 2 = notificationType (byte)  — see ROOM_NOTIFY constants
 *   field 3 = targetUsername (string)  — affected user
 *   field 4 = message (string)         — optional human-readable text
 */
export function buildChatroomNotification(params: {
  txId:             number;
  chatroomName:     string;
  notificationType: number;  // ROOM_NOTIFY.*
  targetUsername:   string;
  message?:         string;
}): Buffer {
  const { txId, chatroomName, notificationType, targetUsername, message } = params;
  const fields: FieldDef[] = [
    { f: 1, type: 'str', v: chatroomName      },
    { f: 2, type: 'u8',  v: notificationType  },
    { f: 3, type: 'str', v: targetUsername    },
  ];
  if (message) fields.push({ f: 4, type: 'str', v: message });
  return encodePacket(PKT.CHATROOM_NOTIFICATION, txId, fields);
}

/**
 * Server→client: one chatroom category descriptor (CHATROOM_CATEGORY = 714).
 * Mirrors FusionPktDataChatroomCategory field layout:
 *   field 1 = categoryId (short)
 *   field 2 = categoryName (string)
 *   field 3 = refreshMethod (byte) — 1=REPLACE, 2=APPEND
 *   field 4 = isCollapsed (bool)
 *   field 5 = itemsCanBeDeleted (bool)  — true for Favourites so user can remove entries
 */
export function buildChatroomCategory(params: {
  txId:              number;
  categoryId:        number;
  categoryName:      string;
  refreshMethod?:    number;   // 1=REPLACE (default), 2=APPEND
  isCollapsed?:      boolean;
  itemsCanBeDeleted?: boolean;
}): Buffer {
  const { txId, categoryId, categoryName, refreshMethod = 1, isCollapsed = false, itemsCanBeDeleted = false } = params;
  return encodePacket(PKT.CHATROOM_CATEGORY, txId, [
    { f: 1, type: 'i16',  v: categoryId        },
    { f: 2, type: 'str',  v: categoryName      },
    { f: 3, type: 'u8',   v: refreshMethod     },
    { f: 4, type: 'bool', v: isCollapsed       },
    { f: 5, type: 'bool', v: itemsCanBeDeleted },
  ]);
}

/**
 * Server→client: marks end of categorized chatroom list (GET_CATEGORIZED_CHATROOMS_COMPLETE = 717).
 * Mirrors FusionPktDataGetCategorizedChatroomsComplete field layout:
 *   field 1 = categoryFooterText (string)
 */
export function buildGetCategorizedChatroomsComplete(txId: number, footerText = ""): Buffer {
  return encodePacket(PKT.GET_CATEGORIZED_CHATROOMS_COMPLETE, txId, [
    { f: 1, type: 'str', v: footerText },
  ]);
}

/**
 * Server→client: chatroom user role/status update (CHATROOM_USER_STATUS = 720).
 * Mirrors FusionPktChatroomUserStatus.java field layout:
 *   field 1 = chatroomName (string)
 *   field 2 = username (string)
 *   field 3 = status (byte) — see USER_STATUS constants (0=normal,1=mod,2=owner,3=muted,4=banned)
 */
export function buildChatroomUserStatus(params: {
  txId:         number;
  chatroomName: string;
  username:     string;
  status:       number;  // USER_STATUS.*
}): Buffer {
  const { txId, chatroomName, username, status } = params;
  return encodePacket(PKT.CHATROOM_USER_STATUS, txId, [
    { f: 1, type: 'str', v: chatroomName },
    { f: 2, type: 'str', v: username     },
    { f: 3, type: 'u8',  v: status       },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat-sync packet builders (GET_CHATS / GET_MESSAGES response)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server→client: CHAT (560) — one entry in the user's chat list.
 *   field 1  = chatIdentifier  (string) — username for private, UUID for group
 *   field 2  = displayName     (string)
 *   field 3  = chatType        (u8)  — 1=private, 2=group
 *   field 4  = unreadCount     (i32)
 *   field 5  = contactId       (i32) — always 0 for us
 *   field 6  = groupOwner      (string, optional)
 *   field 7  = isClosedChat    (u8)  — 0
 *   field 8  = displayGUID     (string) — avatar URL
 *   field 9  = lastMessageType (u8)  — 1=text
 *   field 10 = timestamp       (i64) — last message ms
 *   field 11 = chatListVersion (i32)
 *   field 12 = chatListTimestamp (i64)
 *   field 13 = isRenamed       (u8)  — 0
 *   field 14 = isPassivated    (u8)  — 0
 */
export function buildChat(params: {
  txId:              number;
  chatIdentifier:    string;
  displayName:       string;
  chatType:          number;
  unreadCount?:      number;
  groupOwner?:       string;
  isClosed?:         boolean;
  displayGUID?:      string;
  lastMessageType?:  number;
  timestamp?:        number;
  chatListVersion?:  number;
  isPassivated?:     boolean;
}): Buffer {
  const {
    txId, chatIdentifier, displayName, chatType,
    unreadCount = 0, groupOwner, isClosed = false, displayGUID = "",
    lastMessageType = 1, timestamp, chatListVersion = 1, isPassivated = false,
  } = params;
  const now = Date.now();
  const fields: FieldDef[] = [
    { f: 1,  type: 'str', v: chatIdentifier              },
    { f: 2,  type: 'str', v: displayName                 },
    { f: 3,  type: 'u8',  v: chatType                    },
    { f: 4,  type: 'i32', v: unreadCount                 },
    { f: 5,  type: 'i32', v: 0                           },
    { f: 7,  type: 'u8',  v: isClosed ? 1 : 0            },
    { f: 8,  type: 'str', v: displayGUID                 },
    { f: 9,  type: 'u8',  v: lastMessageType             },
    { f: 10, type: 'i64', v: timestamp ?? now            },
    { f: 11, type: 'i32', v: chatListVersion             },
    { f: 12, type: 'i64', v: now                         },
    { f: 13, type: 'u8',  v: 0                           },
    { f: 14, type: 'u8',  v: isPassivated ? 1 : 0        },
  ];
  if (groupOwner) fields.splice(5, 0, { f: 6, type: 'str', v: groupOwner });
  return encodePacket(PKT.CHAT, txId, fields);
}

/**
 * Server→client: END_MESSAGES (562) — marks end of a GET_MESSAGES response.
 *   field 1 = chatIdentifier (string)
 *   field 2 = firstGUID      (string)
 *   field 3 = finalGUID      (string)
 *   field 4 = messagesSent   (i32)
 */
export function buildEndMessages(params: {
  txId:           number;
  chatIdentifier: string;
  firstGUID?:     string;
  finalGUID?:     string;
  messagesSent:   number;
}): Buffer {
  const { txId, chatIdentifier, firstGUID = "", finalGUID = "", messagesSent } = params;
  return encodePacket(PKT.END_MESSAGES, txId, [
    { f: 1, type: 'str', v: chatIdentifier },
    { f: 2, type: 'str', v: firstGUID      },
    { f: 3, type: 'str', v: finalGUID      },
    { f: 4, type: 'i32', v: messagesSent   },
  ]);
}

/**
 * Server→client: CHAT_LIST_VERSION (561) — current server chat list version.
 *   field 1 = version   (i32)
 *   field 2 = timestamp (i64)
 */
export function buildChatListVersion(txId: number, version: number): Buffer {
  return encodePacket(PKT.CHAT_LIST_VERSION, txId, [
    { f: 1, type: 'i32', v: version        },
    { f: 2, type: 'i64', v: Date.now()     },
  ]);
}

/**
 * Server→client: private MESSAGE (500) — a single private chat message.
 *   field 2  = source      (string) — sender username
 *   field 3  = destType    (u8)  — 1=INDIVIDUAL
 *   field 4  = destination (string) — recipient username
 *   field 6  = contentType (i16) — 1=text
 *   field 8  = text        (string)
 *   field 15 = guid        (string)
 *   field 16 = timestamp   (i64)
 */
export function buildPrivateMessage(params: {
  txId:        number;
  source:      string;
  destination: string;
  text:        string;
  guid?:       string;
  timestamp?:  number;
}): Buffer {
  const { txId, source, destination, text, guid = randomUUID(), timestamp } = params;
  const fields: FieldDef[] = [
    { f: 2,  type: 'str', v: source                   },
    { f: 3,  type: 'u8',  v: DEST_TYPE.INDIVIDUAL     },
    { f: 4,  type: 'str', v: destination              },
    { f: 6,  type: 'i16', v: 1                        },
    { f: 8,  type: 'str', v: text                     },
    { f: 15, type: 'str', v: guid                     },
  ];
  if (timestamp !== undefined) {
    fields.push({ f: 16, type: 'i64', v: timestamp });
  }
  return encodePacket(PKT.MESSAGE, txId, fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// Password hash verification
// Mirrors AuthenticationServiceI.getSha1HashCode + Java String.hashCode
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'crypto';

/**
 * SHA-1 XOR-fold 20→4 bytes, returned as signed int32.
 * Matches AuthenticationServiceI.getSha1HashCode(String saltedPassword).
 */
export function sha1HashCode(saltedPassword: string): number {
  const data = Buffer.from(saltedPassword, 'utf-8');
  const hash = createHash('sha1').update(data).digest();
  let value = 0;
  for (let i = 0; i < hash.length; i += 4) {
    const x =
      ((hash[i]     & 0xff) << 24) |
      ((hash[i + 1] & 0xff) << 16) |
      ((hash[i + 2] & 0xff) <<  8) |
       (hash[i + 3] & 0xff);
    value ^= x;
  }
  return value | 0; // ensure signed int32
}

/**
 * Java String.hashCode polynomial.
 * Matches challenge.hashCode() in AuthenticationServiceI.
 */
export function javaHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Verify client-submitted passwordHash against stored clear-text password.
 * Accepts any of the three hash methods the Java server accepts:
 *   1. SHA-1 XOR-fold (getSha1HashCode)
 *   2. Java hashCode of challenge+password
 *   3. Java hashCode of challenge+password.toLowerCase()
 */
export function verifyPasswordHash(
  challenge:    string,
  password:     string,
  clientHash:   number,
): boolean {
  if (clientHash === sha1HashCode(challenge + password))              return true;
  if (clientHash === javaHashCode(challenge + password))              return true;
  if (clientHash === javaHashCode(challenge + password.toLowerCase())) return true;
  return false;
}

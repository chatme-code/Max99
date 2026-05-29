/**
 * Redis client for Migme Fusion
 *
 * Node.js equivalent of:
 *   - RedisConnectionManager.java  — singleton pool-based connection manager
 *   - Redis.java                   — key-space helpers and utility methods
 *
 * Key-spaces match the backend app exactly (Redis.KeySpace enum):
 *   User:                       user detail hash        (KeySpace.USER)
 *   U:                          user entity sub-keys    (KeySpace.USER_ENTITY)
 *   UserActivity:               user activity           (KeySpace.USER_ACTIVITY)
 *   UserLikes:                  user likes              (KeySpace.USER_LIKES)
 *   UserFootprints:             user footprints         (KeySpace.USER_FOOTPRINTS)
 *   Group:                      group details           (KeySpace.GROUP)
 *   GroupActivity:              group activity          (KeySpace.GROUP_ACTIVITY)
 *   UserNotification:           notifications           (KeySpace.USER_NOTIFICATION)
 *   Captcha:                    captcha challenge       (KeySpace.CAPTCHA)
 *   ExternalEmailVerificationToken: email token        (KeySpace.EXTERNAL_EMAIL_VERIFICATION_TOKEN)
 *   CV:                         conversation entity     (KeySpace.CONVERSATION_ENTITY)
 *   CO:                         country entity          (KeySpace.COUNTRY_ENTITY)
 *   WR:                         web resource entity     (KeySpace.WEB_RESOURCE_ENTITY)
 *   I:                          IP address              (KeySpace.IP_ADDRESS)
 *   session:                    session data            (web-server specific)
 */

import Redis, { type RedisOptions } from "ioredis";

// ─── Config ───────────────────────────────────────────────────────────────────
const REDIS_URL   = process.env.REDIS_URL   || "";
const REDIS_HOST  = process.env.REDIS_HOST  || "127.0.0.1";
const REDIS_PORT  = parseInt(process.env.REDIS_PORT || "6379", 10);
const REDIS_PASS  = process.env.REDIS_PASSWORD || undefined;

// Default TTLs (seconds) — match backend app SystemProperty defaults
export const TTL = {
  SESSION:           7 * 24 * 60 * 60,  // 7 days
  USER_CACHE:        60 * 60,            // 1 hour
  FAILED_AUTH:       15 * 60,            // 15 min — decaying score window
  CAPTCHA:           10 * 60,            // 10 min
  CHAT_MESSAGES:     7 * 24 * 60 * 60,  // 7 days
  NOTIFICATION:      30 * 24 * 60 * 60, // 30 days
  EMAIL_TOKEN:       24 * 60 * 60,       // 24 hours
  PARTY_ROOMS_LIST:  10,                 // 10 sec — daftar semua room
  PARTY_ROOM_DETAIL: 30,                 // 30 sec — detail satu room
  PARTY_SEATS:       3,                  // 3 sec  — state kursi per room
  PARTY_LB_DAILY:    60,                 // 1 min  — leaderboard harian
  PARTY_LB_WEEKLY:   3 * 60,            // 3 min  — leaderboard mingguan
  PARTY_LB_MONTHLY:  10 * 60,           // 10 min — leaderboard bulanan
  PARTY_LB_ALLTIME:  15 * 60,           // 15 min — leaderboard all-time
} as const;

// ─── Key-space builders (matches Redis.KeySpace / Redis.key* methods) ─────────
export const KEY = {
  // User detail hash: `User:{userId}` — fields: Avatar, NumOfGiftsRecieved, etc.
  // → Redis.KeySpace.USER / Redis.getUserDetailKey()
  user:             (id: string) => `User:${id}`,

  // User entity sub-keys: `U:{userId}:{subkey}`
  // → Redis.KeySpace.USER_ENTITY
  userEntity:       (id: string, sub: string) => `U:${id}:${sub}`,

  // User entity config: `U:{userId}:Config`
  // → Redis.SubKeySpaceUserEntity.CONFIG
  userEntityConfig: (id: string) => `U:${id}:Config`,

  // User rewarded invitee timestamp: `U:{userId}:RewardedInviteeTimestamp`
  // → Redis.SubKeySpaceUserEntity.REWARDED_INVITEE_TIMESTAMP
  rewardedInviteeTs:(id: string) => `U:${id}:RewardedInviteeTimestamp`,

  // User activity: `UserActivity:{userId}`
  // → Redis.KeySpace.USER_ACTIVITY
  userActivity:     (id: string) => `UserActivity:${id}`,

  // User likes: `UserLikes:{userId}`
  // → Redis.KeySpace.USER_LIKES
  userLikes:        (id: string) => `UserLikes:${id}`,

  // User footprints: `UserFootprints:{userId}`
  // → Redis.KeySpace.USER_FOOTPRINTS
  userFootprints:   (id: string) => `UserFootprints:${id}`,

  // Group details hash: `Group:{groupId}`
  // → Redis.KeySpace.GROUP
  group:            (id: string) => `Group:${id}`,

  // Group activity: `GroupActivity:{groupId}`
  // → Redis.KeySpace.GROUP_ACTIVITY
  groupActivity:    (id: string) => `GroupActivity:${id}`,

  // Offline messages: `U:{userId}:OLMSG:{YYYYMMDD}`
  // → Redis.getOfflineMessageKey()
  offlineMessage:   (id: string, date: Date) => {
    const d = date.toISOString().slice(0, 10).replace(/-/g, "");
    return `U:${id}:OLMSG:${d}`;
  },

  // Chat/conversation messages sorted set: `CV:{roomId}:M`
  // → Redis.getConversationMessageKey()
  chatMessages:     (roomId: string) => `CV:${roomId}:M`,

  // Chat definition hash: `CV:{roomId}:D`
  // → Redis.getConversationDefinitionKey()
  chatDefinition:   (roomId: string) => `CV:${roomId}:D`,

  // Chat participants set: `CV:{roomId}:P`
  // → Redis.getConversationParticipantsKey()
  chatParticipants: (roomId: string) => `CV:${roomId}:P`,

  // Message status events sorted set: `CV:{key}:E`
  // → Redis.getMessageStatusEventKey()
  msgStatusEvents:  (key: string)   => `CV:${key}:E`,

  // IP address failed auth counter: `I:{ip}:F`
  // → Redis.getFailedAuthsPerIPKey() — KEY WAS "FAILED" BEFORE, NOW FIXED TO ":F"
  failedAuth:       (ip: string)    => `I:${ip}:F`,

  // Captcha: `Captcha:{id}`
  // → Redis.KeySpace.CAPTCHA
  captcha:          (id: string)    => `Captcha:${id}`,

  // External email verification token: `ExternalEmailVerificationToken:{token}`
  // → Redis.KeySpace.EXTERNAL_EMAIL_VERIFICATION_TOKEN
  emailVerifyToken: (token: string) => `ExternalEmailVerificationToken:${token}`,

  // Country entity: `CO:{countryId}`
  // → Redis.KeySpace.COUNTRY_ENTITY
  country:          (id: string)    => `CO:${id}`,

  // Web resource entity: `WR:{key}`
  // → Redis.KeySpace.WEB_RESOURCE_ENTITY
  webResource:      (key: string)   => `WR:${key}`,

  // Session: `session:{sessionId}` (web-server specific)
  session:          (id: string)    => `session:${id}`,

  // User notification list: `UserNotification:{userId}`
  // → Redis.KeySpace.USER_NOTIFICATION
  notification:     (userId: string) => `UserNotification:${userId}`,

  // Old chat list: `U:{userId}:CLO`
  // → Redis.getOldChatListsKey()
  oldChatList:      (userId: string) => `U:${userId}:CLO`,

  // Current chat list: `U:{userId}:CLC`
  // → Redis.getCurrentChatListKey()
  currentChatList:  (userId: string) => `U:${userId}:CLC`,

  // Chat list version: `U:{userId}:CLV`
  // → Redis.getChatListVersionKey()
  chatListVersion:  (userId: string) => `U:${userId}:CLV`,

  // Reputation score: `U:{userId}:RS`
  // → Redis.getReputationScoreKey()
  reputationScore:  (userId: string) => `U:${userId}:RS`,

  // Party room cache keys
  partyRoomsList:   ()               => `party:rooms:list`,
  partyRoom:        (id: string)     => `party:room:${id}`,
  partySeats:       (id: string)     => `party:seats:${id}`,

  // Party leaderboard cache: `party:lb:{period}:{limit}`
  partyLeaderboard: (period: string, limit: number) => `party:lb:${period}:${limit}`,
} as const;

// ─── User detail fields (matches Redis.FieldUserDetails enum) ─────────────────
export const FIELD = {
  // Core fields — matches FieldUserDetails enum exactly
  AVATAR:                   "Avatar",
  AVATAR_VOTES:             "AvatarVotes",
  AVATAR_COMMENTS:          "NumOfAvatarComments",
  CONTACT_LIST_VERSION:     "ContactListVersion",
  DISPLAY_PICTURE:          "DispPic",
  GIFTS_RECEIVED:           "NumOfGiftsRecieved",
  IS_VERIFIED:              "IsVerified",
  VERIFIED_ABOUT_ME:        "VerifiedAbout",
  // Sub-key fields for UserLikes set / games
  USER_LIKES_SET:           ":LK:UL",
  GAMES_PLAYED:             ":Application:INDEX",
  // Web-server specific extensions
  DISPLAY_NAME:             "DisplayName",
  USERNAME:                 "Username",
  MIG_LEVEL:                "MigLevel",
  STATUS:                   "Status",
} as const;

// ─── Client singleton (matches RedisConnectionManagerHolder pattern) ──────────
let _client: Redis | null = null;
let _available = false;

function buildOptions(): RedisOptions {
  const opts: RedisOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
  };
  if (REDIS_PASS) opts.password = REDIS_PASS;
  return opts;
}

export function getRedisClient(): Redis {
  if (!_client) {
    const opts = buildOptions();
    _client = REDIS_URL
      ? new Redis(REDIS_URL, opts)
      : new Redis({ ...opts, host: REDIS_HOST, port: REDIS_PORT });

    _client.on("connect", () => {
      _available = true;
      console.log("[redis] Connected to Redis");
    });
    _client.on("ready", () => {
      _available = true;
    });
    _client.on("error", (err) => {
      if (_available) {
        console.warn("[redis] Connection lost:", err.message);
      }
      _available = false;
    });
    _client.on("close", () => {
      _available = false;
    });

    // Try to connect; failure is non-fatal — storage falls back to in-memory
    _client.connect().catch((err) => {
      console.warn("[redis] Redis unavailable, running without cache:", err.message);
    });
  }
  return _client;
}

export function isRedisAvailable(): boolean {
  return _available;
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit().catch(() => {});
    _client = null;
    _available = false;
  }
}

// ─── Helper — safe command wrapper (never throws) ─────────────────────────────
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!_available) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// ─── User cache (matches GiftsReceivedCounter + FieldUserDetails) ─────────────
export async function cacheUserField(userId: string, field: string, value: string): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    await r.hset(KEY.user(userId), field, value);
    await r.expire(KEY.user(userId), TTL.USER_CACHE);
  }, undefined);
}

export async function getUserField(userId: string, field: string): Promise<string | null> {
  return safe(() => getRedisClient().hget(KEY.user(userId), field), null);
}

export async function cacheUserHash(userId: string, data: Record<string, string>): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    await r.hset(KEY.user(userId), data);
    await r.expire(KEY.user(userId), TTL.USER_CACHE);
  }, undefined);
}

export async function getUserHash(userId: string): Promise<Record<string, string> | null> {
  const data = await safe(() => getRedisClient().hgetall(KEY.user(userId)), null);
  return data && Object.keys(data).length > 0 ? data : null;
}

export async function incUserField(userId: string, field: string, by = 1): Promise<number> {
  return safe(
    () => getRedisClient().hincrby(KEY.user(userId), field, by),
    0
  );
}

// ─── Session cache ─────────────────────────────────────────────────────────────
export async function cacheSession(sessionId: string, userId: string, ttl = TTL.SESSION): Promise<void> {
  await safe(() => getRedisClient().set(KEY.session(sessionId), userId, "EX", ttl), undefined);
}

export async function getSession(sessionId: string): Promise<string | null> {
  return safe(() => getRedisClient().get(KEY.session(sessionId)), null);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await safe(() => getRedisClient().del(KEY.session(sessionId)), undefined);
}

export async function refreshSession(sessionId: string, ttl = TTL.SESSION): Promise<void> {
  await safe(() => getRedisClient().expire(KEY.session(sessionId), ttl), undefined);
}

// ─── Email verification token cache ───────────────────────────────────────────
// Matches Redis.KeySpace.EXTERNAL_EMAIL_VERIFICATION_TOKEN
export async function setEmailVerifyToken(token: string, userId: string): Promise<void> {
  await safe(
    () => getRedisClient().set(KEY.emailVerifyToken(token), userId, "EX", TTL.EMAIL_TOKEN),
    undefined
  );
}

export async function getEmailVerifyToken(token: string): Promise<string | null> {
  return safe(() => getRedisClient().get(KEY.emailVerifyToken(token)), null);
}

export async function deleteEmailVerifyToken(token: string): Promise<void> {
  await safe(() => getRedisClient().del(KEY.emailVerifyToken(token)), undefined);
}

// ─── ChatSync — messages (matches RedisChatSyncStore, key CV:{id}:M) ──────────
export async function saveChatMessage(roomId: string, msgId: string, payload: string): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    const score = Date.now();
    await r.zadd(KEY.chatMessages(roomId), score, `${msgId}:${payload}`);
    // Keep last 500 messages — matches backend retention
    await r.zremrangebyrank(KEY.chatMessages(roomId), 0, -501);
    await r.expire(KEY.chatMessages(roomId), TTL.CHAT_MESSAGES);
  }, undefined);
}

export async function getChatMessages(roomId: string, count = 50): Promise<string[]> {
  return safe(
    () => getRedisClient().zrevrange(KEY.chatMessages(roomId), 0, count - 1),
    []
  );
}

// ─── ChatSync — participants (key CV:{id}:P) ───────────────────────────────────
export async function addChatParticipant(roomId: string, userId: string): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    await r.sadd(KEY.chatParticipants(roomId), userId);
    await r.expire(KEY.chatParticipants(roomId), TTL.CHAT_MESSAGES);
  }, undefined);
}

export async function removeChatParticipant(roomId: string, userId: string): Promise<void> {
  await safe(() => getRedisClient().srem(KEY.chatParticipants(roomId), userId), undefined);
}

export async function getChatParticipants(roomId: string): Promise<string[]> {
  return safe(() => getRedisClient().smembers(KEY.chatParticipants(roomId)), []);
}

// ─── Chat definition cache (key CV:{id}:D) ────────────────────────────────────
export async function setChatDefinition(roomId: string, data: Record<string, string>): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    await r.hset(KEY.chatDefinition(roomId), data);
    await r.expire(KEY.chatDefinition(roomId), TTL.CHAT_MESSAGES);
  }, undefined);
}

export async function getChatDefinition(roomId: string): Promise<Record<string, string> | null> {
  const data = await safe(() => getRedisClient().hgetall(KEY.chatDefinition(roomId)), null);
  return data && Object.keys(data).length > 0 ? data : null;
}

// ─── User current chat list (key U:{id}:CLC) ──────────────────────────────────
export async function setCurrentChatList(userId: string, roomIds: string[]): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    const key = KEY.currentChatList(userId);
    await r.del(key);
    if (roomIds.length > 0) await r.rpush(key, ...roomIds);
    await r.expire(key, TTL.USER_CACHE);
  }, undefined);
}

export async function getCurrentChatList(userId: string): Promise<string[]> {
  return safe(() => getRedisClient().lrange(KEY.currentChatList(userId), 0, -1), []);
}

// ─── Chat list version (key U:{id}:CLV) ───────────────────────────────────────
export async function getChatListVersion(userId: string): Promise<number> {
  const v = await safe(() => getRedisClient().get(KEY.chatListVersion(userId)), null);
  return v ? parseInt(v, 10) : 0;
}

export async function incrementChatListVersion(userId: string): Promise<number> {
  return safe(async () => {
    const r = getRedisClient();
    const v = await r.incr(KEY.chatListVersion(userId));
    await r.expire(KEY.chatListVersion(userId), TTL.USER_CACHE);
    return v;
  }, 0);
}

// ─── Reputation score (key U:{id}:RS) ─────────────────────────────────────────
export async function setReputationScore(userId: string, score: number): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    await r.set(KEY.reputationScore(userId), String(score));
    await r.expire(KEY.reputationScore(userId), TTL.USER_CACHE);
  }, undefined);
}

export async function getReputationScore(userId: string): Promise<number | null> {
  const v = await safe(() => getRedisClient().get(KEY.reputationScore(userId)), null);
  return v !== null ? parseFloat(v) : null;
}

// ─── Failed auth tracking (matches getFailedAuthsPerIPKey: `I:{ip}:F`) ─────────
export async function trackFailedAuth(ip: string): Promise<number> {
  return safe(async () => {
    const r = getRedisClient();
    const count = await r.incr(KEY.failedAuth(ip));
    if (count === 1) await r.expire(KEY.failedAuth(ip), TTL.FAILED_AUTH);
    return count;
  }, 0);
}

export async function getFailedAuthCount(ip: string): Promise<number> {
  const v = await safe(() => getRedisClient().get(KEY.failedAuth(ip)), null);
  return v ? parseInt(v, 10) : 0;
}

export async function resetFailedAuth(ip: string): Promise<void> {
  await safe(() => getRedisClient().del(KEY.failedAuth(ip)), undefined);
}

// ─── Captcha cache (key Captcha:{id}) ─────────────────────────────────────────
export async function setCaptcha(id: string, answer: string): Promise<void> {
  await safe(() => getRedisClient().set(KEY.captcha(id), answer, "EX", TTL.CAPTCHA), undefined);
}

export async function getCaptcha(id: string): Promise<string | null> {
  return safe(() => getRedisClient().get(KEY.captcha(id)), null);
}

export async function deleteCaptcha(id: string): Promise<void> {
  await safe(() => getRedisClient().del(KEY.captcha(id)), undefined);
}

// ─── User notifications (key UserNotification:{userId}) ───────────────────────
export async function pushNotification(userId: string, payload: string): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    await r.lpush(KEY.notification(userId), payload);
    await r.ltrim(KEY.notification(userId), 0, 99);  // keep last 100
    await r.expire(KEY.notification(userId), TTL.NOTIFICATION);
  }, undefined);
}

export async function getNotifications(userId: string, count = 20): Promise<string[]> {
  return safe(() => getRedisClient().lrange(KEY.notification(userId), 0, count - 1), []);
}

// ─── Message Status Events (key CV:{key}:E) ───────────────────────────────────
// Mirrors RedisChatSyncStore: zadd/zrangeByScore for MessageStatusEvent sorted set
// Score = timestamp (ms). Each member is JSON: { msgId, readByUsername, readAt }
export async function saveMessageStatusEvent(
  convId: string,
  msgId: string,
  readByUsername: string,
  readAt: Date,
): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    const key = KEY.msgStatusEvents(convId);
    const score = readAt.getTime();
    const member = JSON.stringify({ msgId, readByUsername, readAt: readAt.toISOString() });
    await r.zadd(key, score, member);
    await r.zremrangebyrank(key, 0, -201); // keep last 200 events
    await r.expire(key, TTL.CHAT_MESSAGES);
  }, undefined);
}

export async function getMessageStatusEvents(
  convId: string,
  sinceMs = 0,
): Promise<Array<{ msgId: string; readByUsername: string; readAt: string }>> {
  const raw = await safe(
    () => getRedisClient().zrangebyscore(KEY.msgStatusEvents(convId), sinceMs, "+inf"),
    [] as string[],
  );
  return raw.map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
}

// ─── Offline Messages (key U:{id}:OLMSG:{YYYYMMDD}) ───────────────────────────
// Mirrors RedisChatSyncStore offline message queue — stores messages for
// users who are not connected so they can receive them on reconnect.
// Score = timestamp (ms). TTL 3 days to auto-expire stale offline queues.
const TTL_OFFLINE_MSG = 3 * 24 * 60 * 60; // 3 days

export async function saveOfflineMessage(
  userId: string,
  payload: string,
  date = new Date(),
): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    const key = KEY.offlineMessage(userId, date);
    await r.zadd(key, Date.now(), `${Date.now()}:${payload}`);
    await r.zremrangebyrank(key, 0, -101); // keep last 100 per day
    await r.expire(key, TTL_OFFLINE_MSG);
  }, undefined);
}

export async function getOfflineMessages(
  userId: string,
  date = new Date(),
): Promise<string[]> {
  const raw = await safe(
    () => getRedisClient().zrange(KEY.offlineMessage(userId, date), 0, -1),
    [] as string[],
  );
  // Strip the leading timestamp prefix added during save
  return raw.map((s) => s.slice(s.indexOf(":") + 1));
}

export async function clearOfflineMessages(userId: string, date = new Date()): Promise<void> {
  await safe(() => getRedisClient().del(KEY.offlineMessage(userId, date)), undefined);
}

// ─── Old Chat List (key U:{id}:CLO) ───────────────────────────────────────────
// Mirrors RedisChatSyncStore OldChatList — archived/closed conversation IDs.
// Stored as a Redis List (lpush/lrange) with a session-length TTL.
export async function addToOldChatList(userId: string, convId: string): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    const key = KEY.oldChatList(userId);
    await r.lrem(key, 0, convId);   // deduplicate
    await r.lpush(key, convId);
    await r.ltrim(key, 0, 499);     // keep last 500 archived convs
    await r.expire(key, TTL.SESSION);
  }, undefined);
}

export async function getOldChatList(userId: string): Promise<string[]> {
  return safe(() => getRedisClient().lrange(KEY.oldChatList(userId), 0, -1), []);
}

export async function removeFromOldChatList(userId: string, convId: string): Promise<void> {
  await safe(() => getRedisClient().lrem(KEY.oldChatList(userId), 0, convId), undefined);
}

// ─── Feed flood / rate-limit (key FeedRL:{userId}:{action}) ───────────────────
// Sliding-window counter: increment on each action, expire after the window.
// Returns the new count so callers can check the limit.
export async function feedRateLimitIncr(
  userId: string,
  action: "post" | "comment",
  windowSeconds: number,
): Promise<number> {
  const key = `FeedRL:${userId}:${action}`;
  return safe(async () => {
    const r = getRedisClient();
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, windowSeconds);
    return count;
  }, 0); // 0 means Redis is down — let the in-memory fallback handle it
}

export async function feedRateLimitGet(
  userId: string,
  action: "post" | "comment",
): Promise<number> {
  const key = `FeedRL:${userId}:${action}`;
  const v = await safe(() => getRedisClient().get(key), null);
  return v ? parseInt(v, 10) : 0;
}

// ─── Health check ─────────────────────────────────────────────────────────────
export async function redisHealthCheck(): Promise<{ status: string; latencyMs?: number }> {
  if (!_available) return { status: "unavailable" };
  try {
    const start = Date.now();
    await getRedisClient().ping();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (e) {
    return { status: "error" };
  }
}

// ─── Party Room Cache ──────────────────────────────────────────────────────────
// party:rooms:list  — daftar semua active rooms (TTL 10 detik)
// party:room:{id}   — detail satu room (TTL 30 detik)
// party:seats:{id}  — state kursi room (TTL 3 detik)
// Setiap write operation wajib panggil invalidate yang sesuai.

export async function getPartyRoomsList(): Promise<string | null> {
  return safe(() => getRedisClient().get(KEY.partyRoomsList()), null);
}

export async function setPartyRoomsList(data: string): Promise<void> {
  await safe(
    () => getRedisClient().set(KEY.partyRoomsList(), data, "EX", TTL.PARTY_ROOMS_LIST),
    undefined,
  );
}

export async function invalidatePartyRoomsList(): Promise<void> {
  await safe(() => getRedisClient().del(KEY.partyRoomsList()), undefined);
}

export async function getPartyRoom(id: string): Promise<string | null> {
  return safe(() => getRedisClient().get(KEY.partyRoom(id)), null);
}

export async function setPartyRoom(id: string, data: string): Promise<void> {
  await safe(
    () => getRedisClient().set(KEY.partyRoom(id), data, "EX", TTL.PARTY_ROOM_DETAIL),
    undefined,
  );
}

export async function invalidatePartyRoom(id: string): Promise<void> {
  await safe(() => getRedisClient().del(KEY.partyRoom(id)), undefined);
}

export async function getPartySeats(roomId: string): Promise<string | null> {
  return safe(() => getRedisClient().get(KEY.partySeats(roomId)), null);
}

export async function setPartySeats(roomId: string, data: string): Promise<void> {
  await safe(
    () => getRedisClient().set(KEY.partySeats(roomId), data, "EX", TTL.PARTY_SEATS),
    undefined,
  );
}

export async function invalidatePartySeats(roomId: string): Promise<void> {
  await safe(() => getRedisClient().del(KEY.partySeats(roomId)), undefined);
}

// ─── Party Leaderboard Cache ───────────────────────────────────────────────────
// party:lb:{period}:{limit} — TTL bervariasi per period (daily lebih pendek, all-time lebih lama)

function partyLbTtl(period: string): number {
  if (period === "daily")    return TTL.PARTY_LB_DAILY;
  if (period === "weekly")   return TTL.PARTY_LB_WEEKLY;
  if (period === "monthly")  return TTL.PARTY_LB_MONTHLY;
  return TTL.PARTY_LB_ALLTIME;
}

export async function getPartyLeaderboard(period: string, limit: number): Promise<string | null> {
  return safe(() => getRedisClient().get(KEY.partyLeaderboard(period, limit)), null);
}

export async function setPartyLeaderboard(period: string, limit: number, data: string): Promise<void> {
  await safe(
    () => getRedisClient().set(KEY.partyLeaderboard(period, limit), data, "EX", partyLbTtl(period)),
    undefined,
  );
}

export async function invalidatePartyLeaderboard(period?: string): Promise<void> {
  await safe(async () => {
    const r = getRedisClient();
    if (period) {
      // Hapus semua limit-variant untuk period tertentu
      const keys = await r.keys(`party:lb:${period}:*`);
      if (keys.length > 0) await r.del(...keys);
    } else {
      // Hapus semua leaderboard cache (dipanggil saat gift dikirim)
      const keys = await r.keys("party:lb:*");
      if (keys.length > 0) await r.del(...keys);
    }
  }, undefined);
}

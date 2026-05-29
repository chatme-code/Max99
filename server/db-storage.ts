import { eq, and, ilike, or, desc, gt, lt, sql, asc, ne, lte } from "drizzle-orm";
import { db } from "./db";
import {
  users, userProfiles, wallPosts, postComments, chatrooms, chatroomMessages,
  chatroomFavourites, chatroomBannedUsers, chatroomModerators, chatroomMutedUsers,
  rooms, lostContacts, merchants, merchantLocations, merchantPoints,
  merchantTags, creditAccounts, creditTransactions, voucherBatches,
  vouchers, rewardPrograms, userRewardHistory, userRecommendations,
  blockList, virtualGifts, virtualGiftsReceived, contacts,
  bots, botConfigs, emoticonPacks, emoticons, guardsetRules,
  campaigns, campaignParticipants,
  bounceEmails,
  groups, groupMembers,
  clientTexts, alertMessages,
  leaderboardEntries, invitations, userReputation, reputationScoreToLevel, payments,
  userEvents, userEventPrivacy, fashionShowSessions, paintwarsStats, smsMessages,
  voiceCalls, notifications, switchboardMessages, serverImages,
  userPrivacySettings, userSettings,
} from "@shared/schema";
import type {
  User, InsertUser, UserProfile, InsertUserProfile, WallPost,
  Chatroom, InsertChatroom, ChatroomMessage, ChatParticipant,
  Room, InsertRoom, LostContact, InsertLostContact,
  Merchant, InsertMerchant, MerchantLocation, InsertMerchantLocation,
  MerchantPoint, MerchantTag, InsertMerchantTag, UserRecommendation,
  CreditAccount, CreditTransaction, VoucherBatch, InsertVoucherBatch,
  Voucher, RewardProgram, InsertRewardProgram, UserRewardHistory,
  VirtualGift, VirtualGiftReceived, InsertVirtualGiftReceived,
  Bot, InsertBot, BotConfig, InsertBotConfig,
  EmoticonPack, InsertEmoticonPack, Emoticon, InsertEmoticon,
  GuardsetRule,
  Campaign, InsertCampaign, CampaignParticipant, InsertCampaignParticipant,
  BounceEmail,
  Group, InsertGroup, GroupMember, InsertGroupMember,
  ClientText, InsertClientText, AlertMessage, InsertAlertMessage,
  LeaderboardEntry, InsertLeaderboardEntry,
  Invitation, InsertInvitation,
  UserReputationRow, InsertUserReputation,
  LevelThreshold, InsertLevelThreshold,
  Payment, InsertPayment,
  UserEvent, InsertUserEvent, UserEventPrivacy,
  FashionShowSession, InsertFashionShowSession,
  PaintwarsStats as PaintwarsStatsType, InsertPaintwarsStats,
  SmsMessage, InsertSmsMessage,
  VoiceCall, InsertVoiceCall,
  Notification, InsertNotification,
  SwitchboardMessage, InsertSwitchboardMessage,
  ServerImage, InsertServerImage,
  UserPrivacySettings,
  UserSetting,
} from "@shared/schema";
import { GROUP_MEMBER_STATUS, GROUP_MEMBER_TYPE, CLIENT_TEXT_TYPE, ALERT_MESSAGE_STATUS } from "@shared/schema";
import {
  CHATROOM_COLORS, CREDIT_TRANSACTION_TYPE, VOUCHER_STATUS,
} from "@shared/schema";
import type { IStorage, PostComment } from "./storage";
import { randomUUID, randomBytes, scrypt } from "crypto";
import { promisify } from "util";
import { buildDefaultReputationLevels } from "./modules/reputation/levelCurve";

const scryptAsync = promisify(scrypt);

async function hashPasswordSeed(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}


function pickColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return CHATROOM_COLORS[Math.abs(hash) % CHATROOM_COLORS.length];
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

// Seed chatrooms for first boot
const SEED_CHATROOMS_DATA = [
  { name: "Indonesia", description: "Obrolan umum Indonesia", categoryId: 8, color: "#4CAF50", currentParticipants: 32 },
  { name: "Bandung Corner", description: "Komunitas Bandung", categoryId: 8, color: "#9C27B0", currentParticipants: 14 },
  { name: "Jakarta Chat", description: "Obrolan warga Jakarta", categoryId: 8, color: "#F44336", currentParticipants: 41 },
  { name: "Mig33 Global", description: "International chat", categoryId: 8, color: "#FF9800", language: "en", currentParticipants: 27 },
  { name: "Game Talk", description: "Diskusi game seru", categoryId: 7, color: "#795548", currentParticipants: 19 },
  { name: "Mobile Legends", description: "Komunitas MLBB", categoryId: 7, color: "#9C27B0", currentParticipants: 38 },
  { name: "Free Fire", description: "FF squad wanted", categoryId: 7, color: "#F44336", currentParticipants: 22 },
  { name: "Find Friends", description: "Cari teman baru di sini!", categoryId: 4, color: "#4CAF50", currentParticipants: 11 },
  { name: "Jodoh Indo", description: "Cari jodoh di sini", categoryId: 4, color: "#FF9800", currentParticipants: 29 },
  { name: "Help Desk", description: "Ada masalah? Tanya di sini!", categoryId: 6, color: "#4CAF50", currentParticipants: 5 },
];

const SEED_REWARD_PROGRAMS_DATA = [
  {
    name: "First Login Bonus", description: "Bonus Kredit IDR untuk login pertama kali",
    type: 3, category: 5, countryId: null, minMigLevel: 1, maxMigLevel: null,
    quantityRequired: 1, amountRequired: null, amountRequiredCurrency: null,
    migCreditReward: 1000, migCreditRewardCurrency: "IDR", scoreReward: 5, levelReward: null, status: 1,
    startDate: null, endDate: null,
  },
  {
    name: "Referral Reward", description: "Dapat 2.000 Kredit IDR setiap berhasil referral user baru",
    type: 1, category: 1, countryId: null, minMigLevel: 1, maxMigLevel: null,
    quantityRequired: 1, amountRequired: null, amountRequiredCurrency: null,
    migCreditReward: 2000, migCreditRewardCurrency: "IDR", scoreReward: 10, levelReward: null, status: 1,
    startDate: null, endDate: null,
  },
  {
    name: "Active Chatter", description: "Kirim 50 pesan di chatroom, dapat bonus kredit IDR",
    type: 1, category: 4, countryId: null, minMigLevel: 1, maxMigLevel: null,
    quantityRequired: 50, amountRequired: null, amountRequiredCurrency: null,
    migCreditReward: 1500, migCreditRewardCurrency: "IDR", scoreReward: 20, levelReward: 1, status: 1,
    startDate: null, endDate: null,
  },
];

export class DatabaseStorage implements IStorage {
  // Transient in-memory state (session-based, reset on restart; ban/mod/mute persisted in DB)
  private participantsMap: Map<string, ChatParticipant[]> = new Map();
  private recentMap: Map<string, string[]> = new Map();

  async seed(): Promise<void> {
    const existing = await db.select({ id: chatrooms.id }).from(chatrooms).limit(1);
    if (existing.length === 0) {
      for (const s of SEED_CHATROOMS_DATA) {
        const room = await db.insert(chatrooms).values({
          id: randomUUID(), name: s.name, description: s.description,
          categoryId: s.categoryId, currentParticipants: Math.min(s.currentParticipants, 25),
          maxParticipants: 25, color: s.color, language: (s as any).language ?? "id",
      allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
        }).returning();
        if (room[0]) this.participantsMap.set(room[0].id, []);
      }
    } else {
      const allRooms = await db.select({ id: chatrooms.id }).from(chatrooms);
      for (const r of allRooms) {
        if (!this.participantsMap.has(r.id)) this.participantsMap.set(r.id, []);
      }
    }

    const existingRewards = await db.select({ id: rewardPrograms.id }).from(rewardPrograms).limit(1);
    if (existingRewards.length === 0) {
      for (const rp of SEED_REWARD_PROGRAMS_DATA) {
        await db.insert(rewardPrograms).values({ id: randomUUID(), ...rp });
      }
    }

    for (const level of buildDefaultReputationLevels()) {
      await this.upsertLevelThreshold(level);
    }

    // Seed virtual gifts catalog (matches old migme gift store)
    const existingGifts = await db.select({ id: virtualGifts.id }).from(virtualGifts).limit(1);
    if (existingGifts.length === 0) {
      const SEED_GIFTS = [
        { name: "rose",      hotKey: "🌹", price: 10,  sortOrder: 1,  groupId: 1, location64x64Png: "/gifts/rose.png", location16x16Png: "/gifts/rose.png" },
        { name: "heart",     hotKey: "❤️", price: 10,  sortOrder: 2,  groupId: 1 },
        { name: "diamond",   hotKey: "💎", price: 50,  sortOrder: 3,  groupId: 1 },
        { name: "star",      hotKey: "⭐", price: 10,  sortOrder: 4,  groupId: 1 },
        { name: "chocolate", hotKey: "🍫", price: 10,  sortOrder: 5,  groupId: 1 },
        { name: "bear",      hotKey: "🧸", price: 20,  sortOrder: 6,  groupId: 1 },
        { name: "cake",      hotKey: "🎂", price: 15,  sortOrder: 7,  groupId: 1 },
        { name: "crown",     hotKey: "👑", price: 100, sortOrder: 8,  groupId: 2 },
        { name: "flower",    hotKey: "🌸", price: 10,  sortOrder: 9,  groupId: 1 },
        { name: "butterfly", hotKey: "🦋", price: 15,  sortOrder: 10, groupId: 1 },
        { name: "music",     hotKey: "🎵", price: 10,  sortOrder: 11, groupId: 1 },
        { name: "trophy",    hotKey: "🏆", price: 30,  sortOrder: 12, groupId: 1 },
        { name: "kiss",      hotKey: "💋", price: 10,  sortOrder: 13, groupId: 1 },
        { name: "candy",     hotKey: "🍬", price: 5,   sortOrder: 14, groupId: 1 },
        { name: "sunflower", hotKey: "🌻", price: 10,  sortOrder: 15, groupId: 1 },
      ];
      for (const g of SEED_GIFTS) {
        await db.insert(virtualGifts).values({
          name: g.name, hotKey: g.hotKey, price: g.price,
          currency: "IDR", numSold: 0, sortOrder: g.sortOrder,
          groupId: g.groupId, groupVipOnly: false, status: 1,
        });
      }
    }

    // Seed sticker packs for store (forSale=1, status=1 means active/Aktif)
    const existingPacks = await db.select({ id: emoticonPacks.id }).from(emoticonPacks).limit(1);
    if (existingPacks.length === 0) {
      const SEED_PACKS = [
        { name: "Kawaii Cats",      description: "Cute cat stickers for every mood",         price: 30,  type: 1, sortOrder: 1 },
        { name: "Love & Hearts",    description: "Express your love with heart stickers",     price: 20,  type: 1, sortOrder: 2 },
        { name: "Funny Faces",      description: "Hilarious emoji faces pack",                price: 25,  type: 1, sortOrder: 3 },
        { name: "Travel Vibes",     description: "Stickers for every travel moment",          price: 40,  type: 1, sortOrder: 4 },
        { name: "Food Lovers",      description: "Delicious food sticker collection",         price: 20,  type: 1, sortOrder: 5 },
        { name: "Classic Migme",    description: "Original migme classics — free to unlock", price: 0,   type: 0, sortOrder: 6 },
      ];
      for (const p of SEED_PACKS) {
        await db.insert(emoticonPacks).values({
          name: p.name, description: p.description, price: p.price,
          type: p.type, sortOrder: p.sortOrder, forSale: 1, status: 1, version: 1,
        });
      }
    } else {
      // One-time migration: update existing seeded packs (status=0) to status=1 (Aktif)
      // This fixes packs created before the status convention was clarified
      await db.update(emoticonPacks)
        .set({ status: 1 })
        .where(eq(emoticonPacks.status, 0));
    }

    // Seed default test users
    const SEED_USERS = [
      { username: "migme",  email: "migme@migme.com",  password: "migme123",  displayName: "Migme" },
      { username: "admin",  email: "admin@migme.com",  password: "admin123",  displayName: "Admin" },
    ];
    for (const u of SEED_USERS) {
      const exists = await db.select({ id: users.id }).from(users)
        .where(sql`lower(${users.username}) = lower(${u.username})`).limit(1);
      if (exists.length === 0) {
        const hashed = await hashPasswordSeed(u.password);
        await db.insert(users).values({
          id: randomUUID(), username: u.username, email: u.email,
          password: hashed, displayName: u.displayName, emailVerified: true,
          verifyToken: null, verifyTokenExpiry: null,
        });
      }
    }
  }

  // ── Auth / Users ───────────────────────────────────────────────────────────
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }
  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(
      sql`lower(${users.username}) = lower(${username})`
    );
    return user;
  }
  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(
      sql`lower(${users.email}) = lower(${email})`
    );
    return user;
  }
  async getUserByVerifyToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.verifyToken, token));
    return user;
  }
  async getUserByResetToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.resetToken, token));
    return user;
  }
  async createUser(data: InsertUser & { password: string; verifyToken?: string; verifyTokenExpiry?: Date }): Promise<User> {
    const [user] = await db.insert(users).values({
      id: randomUUID(), username: data.username, displayName: data.displayName ?? null,
      email: data.email, password: data.password, emailVerified: data.emailVerified ?? false,
      verifyToken: data.verifyToken ?? null, verifyTokenExpiry: data.verifyTokenExpiry ?? null,
    }).returning();
    return user;
  }
  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const [user] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
    return user;
  }
  async searchUsers(query: string, limit = 20, offset = 0): Promise<Partial<User>[]> {
    const q = `%${query.toLowerCase()}%`;
    const result = await db.select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      displayPicture: userProfiles.displayPicture,
      aboutMe: userProfiles.aboutMe,
    })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(or(ilike(users.username, q), ilike(users.displayName, q)))
      .limit(limit)
      .offset(offset);
    return result;
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  async getUserProfile(userId: string): Promise<UserProfile | undefined> {
    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
    return profile;
  }
  async upsertUserProfile(userId: string, data: Partial<InsertUserProfile>): Promise<UserProfile> {
    const existing = await this.getUserProfile(userId);
    if (existing) {
      const [updated] = await db.update(userProfiles)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(userProfiles.userId, userId))
        .returning();
      return updated;
    }
    const [created] = await db.insert(userProfiles).values({
      id: randomUUID(), userId, ...data,
    }).returning();
    return created;
  }

  // ── Feed / Wall Posts ──────────────────────────────────────────────────────
  async getFeedPosts(_userId: string, limit = 15, offset = 0): Promise<{ posts: WallPost[]; hasMore: boolean }> {
    const posts = await db.select().from(wallPosts)
      .where(eq(wallPosts.status, 1))
      .orderBy(desc(wallPosts.createdAt))
      .limit(limit + 1)
      .offset(offset);
    const hasMore = posts.length > limit;
    return { posts: hasMore ? posts.slice(0, limit) : posts, hasMore };
  }
  async getWallPosts(userId: string, limit = 15, offset = 0): Promise<{ posts: WallPost[]; hasMore: boolean }> {
    const posts = await db.select().from(wallPosts)
      .where(and(eq(wallPosts.userId, userId), eq(wallPosts.status, 1)))
      .orderBy(desc(wallPosts.createdAt))
      .limit(limit + 1)
      .offset(offset);
    const hasMore = posts.length > limit;
    return { posts: hasMore ? posts.slice(0, limit) : posts, hasMore };
  }
  async getWallPost(id: string): Promise<WallPost | undefined> {
    const [post] = await db.select().from(wallPosts).where(eq(wallPosts.id, id));
    return post;
  }
  async createWallPost(data: { userId: string; authorUserId: string; authorUsername: string; comment: string; imageUrl?: string | null; videoUrl?: string | null; mediaType?: string; type?: number; repostId?: string | null; repostAuthorUsername?: string | null; repostComment?: string | null }): Promise<WallPost> {
    const [post] = await db.insert(wallPosts).values({
      id: randomUUID(), userId: data.userId, authorUserId: data.authorUserId,
      authorUsername: data.authorUsername, comment: data.comment,
      imageUrl: data.imageUrl ?? null, videoUrl: data.videoUrl ?? null,
      mediaType: data.mediaType ?? 'text', type: data.type ?? 1,
      status: 1, numComments: 0, numLikes: 0, numDislikes: 0,
      repostId: data.repostId ?? null,
      repostAuthorUsername: data.repostAuthorUsername ?? null,
      repostComment: data.repostComment ?? null,
    }).returning();
    return post;
  }
  async likeWallPost(id: string): Promise<WallPost | undefined> {
    const [updated] = await db.update(wallPosts)
      .set({ numLikes: sql`${wallPosts.numLikes} + 1` })
      .where(eq(wallPosts.id, id))
      .returning();
    return updated;
  }
  async dislikeWallPost(id: string): Promise<WallPost | undefined> {
    const [updated] = await db.update(wallPosts)
      .set({ numDislikes: sql`${wallPosts.numDislikes} + 1` })
      .where(eq(wallPosts.id, id))
      .returning();
    return updated;
  }
  async removeWallPost(id: string): Promise<void> {
    await db.update(wallPosts).set({ status: 0 }).where(eq(wallPosts.id, id));
  }

  // ── Chatrooms ──────────────────────────────────────────────────────────────
  async getChatrooms(): Promise<Chatroom[]> {
    return db.select().from(chatrooms).orderBy(desc(chatrooms.createdAt));
  }
  async getChatroomsByCategory(categoryId: number): Promise<Chatroom[]> {
    return db.select().from(chatrooms).where(eq(chatrooms.categoryId, categoryId)).orderBy(desc(chatrooms.createdAt));
  }
  async getChatroom(id: string): Promise<Chatroom | undefined> {
    const [room] = await db.select().from(chatrooms).where(eq(chatrooms.id, id));
    return room;
  }

  async getChatroomByName(name: string): Promise<Chatroom | undefined> {
    const [room] = await db.select().from(chatrooms).where(eq(chatrooms.name, name));
    return room;
  }
  async createChatroom(data: InsertChatroom & { createdBy?: string }): Promise<Chatroom> {
    const id = randomUUID();
    const [room] = await db.insert(chatrooms).values({
      id, name: data.name, description: data.description ?? null,
      categoryId: data.categoryId, currentParticipants: 1,
      maxParticipants: data.maxParticipants ?? 25, color: pickColor(data.name),
      language: data.language ?? "id", allowKick: data.allowKick ?? true,
      isLocked: false, adultOnly: data.adultOnly ?? false, userOwned: false, type: 1, status: 1,
      createdBy: data.createdBy ?? null,
    }).returning();
    this.participantsMap.set(id, []);
    return room;
  }
  async deleteChatroom(id: string): Promise<void> {
    await db.delete(chatrooms).where(eq(chatrooms.id, id));
    this.participantsMap.delete(id);
  }
  async updateChatroom(id: string, updates: Partial<Chatroom>): Promise<Chatroom | undefined> {
    const [updated] = await db.update(chatrooms).set(updates).where(eq(chatrooms.id, id)).returning();
    return updated;
  }
  async getMessages(chatroomId: string, opts?: { after?: string; before?: string; limit?: number }): Promise<ChatroomMessage[]> {
    const limit = opts?.limit ?? 50;
    const conditions = [eq(chatroomMessages.chatroomId, chatroomId)];
    if (opts?.after) conditions.push(gt(chatroomMessages.createdAt, new Date(opts.after)));
    if (opts?.before) conditions.push(lt(chatroomMessages.createdAt, new Date(opts.before)));
    const rows = await db.select().from(chatroomMessages)
      .where(and(...conditions))
      .orderBy(chatroomMessages.createdAt)
      .limit(limit);
    return rows;
  }
  async getMessagesSince(chatroomId: string, sinceMs: number): Promise<ChatroomMessage[]> {
    const since = new Date(sinceMs);
    return db.select().from(chatroomMessages)
      .where(and(eq(chatroomMessages.chatroomId, chatroomId), gt(chatroomMessages.createdAt, since)))
      .orderBy(chatroomMessages.createdAt);
  }
  async postMessage(chatroomId: string, msg: { id?: string; senderId?: string; senderUsername: string; senderColor: string; text: string; isSystem?: boolean }): Promise<ChatroomMessage> {
    const [message] = await db.insert(chatroomMessages).values({
      id: msg.id ?? randomUUID(), chatroomId, senderId: msg.senderId ?? null,
      senderUsername: msg.senderUsername, senderColor: msg.senderColor,
      text: msg.text, isSystem: msg.isSystem ?? false,
    }).returning();
    return message;
  }
  async getParticipants(chatroomId: string): Promise<ChatParticipant[]> {
    return this.participantsMap.get(chatroomId) ?? [];
  }
  async getActiveRoomsByUser(userId: string): Promise<{ room: Chatroom; participantCount: number }[]> {
    const results: { room: Chatroom; participantCount: number }[] = [];
    for (const [chatroomId, participants] of this.participantsMap.entries()) {
      if (participants.find((p) => p.id === userId)) {
        const room = await this.getChatroom(chatroomId);
        if (room) results.push({ room, participantCount: participants.length });
      }
    }
    return results;
  }
  async joinChatroom(chatroomId: string, user: { id: string; username: string; displayName: string; color: string }): Promise<void> {
    const list = this.participantsMap.get(chatroomId) ?? [];
    const room = await this.getChatroom(chatroomId);
    const isOwner = room?.createdBy === user.id;
    const isMod = await this.isModUser(chatroomId, user.id);
    const isMuted = await this.isMuted(chatroomId, user.id);
    const isGlobalAdmin = await this.isGlobalAdmin(user.id);
    const [profile] = await db.select({ displayPicture: userProfiles.displayPicture })
      .from(userProfiles).where(eq(userProfiles.userId, user.id));
    const rawDp = profile?.displayPicture ?? null;
    const displayPicture = rawDp && /\/api\/imageserver\/image\/[^/]+$/.test(rawDp) ? rawDp + '/data' : rawDp;
    const existingIndex = list.findIndex((p) => p.id === user.id);
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...user, isMod, isMuted, isOwner, isGlobalAdmin, displayPicture };
      this.participantsMap.set(chatroomId, list);
    } else {
      list.push({ ...user, joinedAt: new Date().toISOString(), isMod, isMuted, isOwner, isGlobalAdmin, displayPicture });
      this.participantsMap.set(chatroomId, list);
      await db.update(chatrooms).set({ currentParticipants: list.length }).where(eq(chatrooms.id, chatroomId));
    }
  }
  async leaveChatroom(chatroomId: string, userId: string): Promise<void> {
    const list = (this.participantsMap.get(chatroomId) ?? []).filter((p) => p.id !== userId);
    this.participantsMap.set(chatroomId, list);
    await db.update(chatrooms).set({ currentParticipants: list.length }).where(eq(chatrooms.id, chatroomId));
  }
  async banUser(chatroomId: string, userId: string): Promise<void> {
    const userRow = await this.getUser(userId);
    const username = userRow?.username ?? userId;
    const existing = await db.select({ id: chatroomBannedUsers.id })
      .from(chatroomBannedUsers)
      .where(and(eq(chatroomBannedUsers.chatroomId, chatroomId), eq(chatroomBannedUsers.username, username)));
    if (existing.length === 0) {
      await db.insert(chatroomBannedUsers).values({ chatroomId, username });
    }
    await this.leaveChatroom(chatroomId, userId);
  }
  async unbanUser(chatroomId: string, userId: string): Promise<void> {
    const userRow = await this.getUser(userId);
    const username = userRow?.username ?? userId;
    await db.delete(chatroomBannedUsers)
      .where(and(eq(chatroomBannedUsers.chatroomId, chatroomId), eq(chatroomBannedUsers.username, username)));
  }
  async isBanned(chatroomId: string, userId: string): Promise<boolean> {
    const userRow = await this.getUser(userId);
    if (!userRow) return false;
    const rows = await db.select({ id: chatroomBannedUsers.id })
      .from(chatroomBannedUsers)
      .where(and(eq(chatroomBannedUsers.chatroomId, chatroomId), eq(chatroomBannedUsers.username, userRow.username)));
    return rows.length > 0;
  }
  async muteUser(chatroomId: string, userId: string): Promise<void> {
    const userRow = await this.getUser(userId);
    const username = userRow?.username ?? userId;
    const existing = await db.select({ id: chatroomMutedUsers.id })
      .from(chatroomMutedUsers)
      .where(and(eq(chatroomMutedUsers.chatroomId, chatroomId), eq(chatroomMutedUsers.userId, userId)));
    if (existing.length === 0) {
      await db.insert(chatroomMutedUsers).values({ chatroomId, userId, username, mutedUntil: null });
    } else {
      await db.update(chatroomMutedUsers)
        .set({ mutedUntil: null })
        .where(and(eq(chatroomMutedUsers.chatroomId, chatroomId), eq(chatroomMutedUsers.userId, userId)));
    }
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMuted: true } : p));
  }
  async silenceUser(chatroomId: string, userId: string, username: string, timeoutSecs: number): Promise<void> {
    const mutedUntil = new Date(Date.now() + timeoutSecs * 1000);
    const existing = await db.select({ id: chatroomMutedUsers.id })
      .from(chatroomMutedUsers)
      .where(and(eq(chatroomMutedUsers.chatroomId, chatroomId), eq(chatroomMutedUsers.userId, userId)));
    if (existing.length === 0) {
      await db.insert(chatroomMutedUsers).values({ chatroomId, userId, username, mutedUntil });
    } else {
      await db.update(chatroomMutedUsers)
        .set({ mutedUntil })
        .where(and(eq(chatroomMutedUsers.chatroomId, chatroomId), eq(chatroomMutedUsers.userId, userId)));
    }
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMuted: true } : p));
  }
  async unmuteUser(chatroomId: string, userId: string): Promise<void> {
    await db.delete(chatroomMutedUsers)
      .where(and(eq(chatroomMutedUsers.chatroomId, chatroomId), eq(chatroomMutedUsers.userId, userId)));
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMuted: false } : p));
  }
  async isMuted(chatroomId: string, userId: string): Promise<boolean> {
    const rows = await db.select({ mutedUntil: chatroomMutedUsers.mutedUntil })
      .from(chatroomMutedUsers)
      .where(and(eq(chatroomMutedUsers.chatroomId, chatroomId), eq(chatroomMutedUsers.userId, userId)));
    if (rows.length === 0) return false;
    const { mutedUntil } = rows[0];
    if (mutedUntil === null) return true;
    if (mutedUntil > new Date()) return true;
    await db.delete(chatroomMutedUsers)
      .where(and(eq(chatroomMutedUsers.chatroomId, chatroomId), eq(chatroomMutedUsers.userId, userId)));
    return false;
  }
  async modUser(chatroomId: string, userId: string): Promise<void> {
    const userRow = await this.getUser(userId);
    const username = userRow?.username ?? userId;
    const existing = await db.select({ id: chatroomModerators.id })
      .from(chatroomModerators)
      .where(and(eq(chatroomModerators.chatroomId, chatroomId), eq(chatroomModerators.username, username)));
    if (existing.length === 0) {
      await db.insert(chatroomModerators).values({ chatroomId, username });
    }
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMod: true } : p));
  }
  async unmodUser(chatroomId: string, userId: string): Promise<void> {
    const userRow = await this.getUser(userId);
    const username = userRow?.username ?? userId;
    await db.delete(chatroomModerators)
      .where(and(eq(chatroomModerators.chatroomId, chatroomId), eq(chatroomModerators.username, username)));
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMod: false } : p));
  }
  async isModUser(chatroomId: string, userId: string): Promise<boolean> {
    const userRow = await this.getUser(userId);
    if (!userRow) return false;
    const rows = await db.select({ id: chatroomModerators.id })
      .from(chatroomModerators)
      .where(and(eq(chatroomModerators.chatroomId, chatroomId), eq(chatroomModerators.username, userRow.username)));
    return rows.length > 0;
  }
  async bumpUser(chatroomId: string, userId: string): Promise<void> {
    await this.leaveChatroom(chatroomId, userId);
  }
  async isSuspended(userId: string): Promise<boolean> {
    const row = await db.select({ isSuspended: users.isSuspended })
      .from(users).where(eq(users.id, userId)).limit(1);
    return row[0]?.isSuspended ?? false;
  }
  async suspendUser(userId: string): Promise<void> {
    await db.update(users).set({ isSuspended: true }).where(eq(users.id, userId));
  }
  async unsuspendUser(userId: string): Promise<void> {
    await db.update(users).set({ isSuspended: false }).where(eq(users.id, userId));
  }

  // ── Chatroom Favourites (persisted to DB) ─────────────────────────────────
  async getFavouriteChatrooms(userId: string): Promise<Chatroom[]> {
    const rows = await db.select({ chatroomId: chatroomFavourites.chatroomId })
      .from(chatroomFavourites)
      .where(eq(chatroomFavourites.userId, userId))
      .orderBy(desc(chatroomFavourites.createdAt));
    if (rows.length === 0) return [];
    const results: Chatroom[] = [];
    for (const row of rows) {
      const room = await this.getChatroom(row.chatroomId);
      if (room) results.push(room);
    }
    return results;
  }
  async addFavouriteChatroom(userId: string, chatroomId: string): Promise<void> {
    const existing = await db.select({ id: chatroomFavourites.id })
      .from(chatroomFavourites)
      .where(and(eq(chatroomFavourites.userId, userId), eq(chatroomFavourites.chatroomId, chatroomId)));
    if (existing.length === 0) {
      await db.insert(chatroomFavourites).values({ userId, chatroomId });
    }
  }
  async removeFavouriteChatroom(userId: string, chatroomId: string): Promise<void> {
    await db.delete(chatroomFavourites)
      .where(and(eq(chatroomFavourites.userId, userId), eq(chatroomFavourites.chatroomId, chatroomId)));
  }
  async isFavouriteChatroom(userId: string, chatroomId: string): Promise<boolean> {
    const rows = await db.select({ id: chatroomFavourites.id })
      .from(chatroomFavourites)
      .where(and(eq(chatroomFavourites.userId, userId), eq(chatroomFavourites.chatroomId, chatroomId)));
    return rows.length > 0;
  }

  // ── Chatroom Recent (session-based in-memory, max 20 per user) ────────────
  async getRecentChatrooms(userId: string): Promise<Chatroom[]> {
    const ids = this.recentMap.get(userId) ?? [];
    const rooms: Chatroom[] = [];
    for (const id of ids) {
      const room = await this.getChatroom(id);
      if (room) rooms.push(room);
    }
    return rooms;
  }
  async addRecentChatroom(userId: string, chatroomId: string): Promise<void> {
    const list = (this.recentMap.get(userId) ?? []).filter((id) => id !== chatroomId);
    list.unshift(chatroomId);
    this.recentMap.set(userId, list.slice(0, 20));
  }

  // ── Chatroom Moderators & Banned Lists ────────────────────────────────────
  async getChatroomModerators(chatroomId: string): Promise<{ userId: string; username: string }[]> {
    const rows = await db.select({ username: chatroomModerators.username })
      .from(chatroomModerators)
      .where(eq(chatroomModerators.chatroomId, chatroomId));
    return rows.map(r => ({ userId: r.username, username: r.username }));
  }
  async getChatroomBannedUsers(chatroomId: string): Promise<{ userId: string; username: string }[]> {
    const rows = await db.select({ username: chatroomBannedUsers.username })
      .from(chatroomBannedUsers)
      .where(eq(chatroomBannedUsers.chatroomId, chatroomId));
    return rows.map(r => ({ userId: r.username, username: r.username }));
  }

  // ── Social — Follow (persisted via contacts table) ────────────────────────
  // Mirrors Android contactBean.addFusionUserAsContact — the "follow" creates
  // a Contact row with fusionUsername set to the followed user's username.
  async followUser(followerUsername: string, targetUsername: string): Promise<void> {
    const existing = await db.select().from(contacts)
      .where(and(eq(contacts.username, followerUsername), eq(contacts.fusionUsername, targetUsername)));
    if (existing.length === 0) {
      await db.insert(contacts).values({
        username: followerUsername,
        displayName: targetUsername,
        fusionUsername: targetUsername,
        displayOnPhone: 0,
        status: 1,
      });
    }
  }
  async unfollowUser(followerUsername: string, targetUsername: string): Promise<void> {
    await db.delete(contacts)
      .where(and(eq(contacts.username, followerUsername), eq(contacts.fusionUsername, targetUsername)));
  }
  async isFollowing(followerUsername: string, targetUsername: string): Promise<boolean> {
    const rows = await db.select().from(contacts)
      .where(and(eq(contacts.username, followerUsername), eq(contacts.fusionUsername, targetUsername)));
    return rows.length > 0;
  }
  async getFollowing(username: string): Promise<string[]> {
    const rows = await db.select().from(contacts)
      .where(and(eq(contacts.username, username), sql`${contacts.fusionUsername} IS NOT NULL`));
    return rows.map(r => r.fusionUsername!).filter(Boolean);
  }
  async getContacts(username: string): Promise<{ username: string; displayName: string; fusionUsername: string }[]> {
    const rows = await db.select().from(contacts)
      .where(and(eq(contacts.username, username), sql`${contacts.fusionUsername} IS NOT NULL`));
    return rows.map(r => ({
      username: r.username,
      displayName: r.displayName || r.fusionUsername || r.username,
      fusionUsername: r.fusionUsername!,
    }));
  }

  // ── Social — Block (persisted via blockList table) ─────────────────────────
  async blockUserGlobal(blockerUsername: string, targetUsername: string): Promise<void> {
    const existing = await db.select().from(blockList)
      .where(and(eq(blockList.username, blockerUsername), eq(blockList.blockUsername, targetUsername)));
    if (existing.length === 0) {
      await db.insert(blockList).values({ username: blockerUsername, blockUsername: targetUsername });
    }
  }
  async unblockUserGlobal(blockerUsername: string, targetUsername: string): Promise<void> {
    await db.delete(blockList)
      .where(and(eq(blockList.username, blockerUsername), eq(blockList.blockUsername, targetUsername)));
  }
  async isBlockedGlobal(blockerUsername: string, targetUsername: string): Promise<boolean> {
    const rows = await db.select().from(blockList)
      .where(and(eq(blockList.username, blockerUsername), eq(blockList.blockUsername, targetUsername)));
    return rows.length > 0;
  }
  async getBlockedUsers(blockerUsername: string): Promise<string[]> {
    const rows = await db.select().from(blockList)
      .where(eq(blockList.username, blockerUsername));
    return rows.map(r => r.blockUsername);
  }
  async isGlobalAdmin(userId: string): Promise<boolean> {
    const rows = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
    return rows[0]?.isAdmin === true;
  }
  async setGlobalAdmin(userId: string, isAdmin: boolean): Promise<void> {
    await db.update(users).set({ isAdmin }).where(eq(users.id, userId));
  }
  async setTransferPin(username: string, hashedPin: string): Promise<void> {
    await db.execute(sql`UPDATE users SET transfer_pin = ${hashedPin} WHERE username = ${username}`);
  }
  async getTransferPin(username: string): Promise<string | null> {
    const rows = await db.execute(sql`SELECT transfer_pin FROM users WHERE username = ${username}`);
    const row = (rows as any).rows?.[0] ?? (rows as any)[0];
    return row?.transfer_pin ?? null;
  }

  // ── Rooms ──────────────────────────────────────────────────────────────────
  async getRooms(): Promise<Room[]> {
    return db.select().from(rooms).where(eq(rooms.status, 1));
  }
  async getRoomsByOwner(ownerId: string): Promise<Room[]> {
    return db.select().from(rooms).where(and(eq(rooms.ownerId, ownerId), eq(rooms.status, 1)));
  }
  async getRoom(id: string): Promise<Room | undefined> {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, id));
    return room;
  }
  async createRoom(data: InsertRoom & { ownerId: string; ownerUsername: string }): Promise<Room> {
    const [room] = await db.insert(rooms).values({
      id: randomUUID(), ownerId: data.ownerId, ownerUsername: data.ownerUsername,
      name: data.name, description: data.description ?? null, theme: data.theme ?? "default",
      maxParticipants: data.maxParticipants ?? 20, status: 1, isLocked: data.isLocked ?? false,
    }).returning();
    return room;
  }
  async updateRoom(id: string, updates: Partial<Room>): Promise<Room | undefined> {
    const [updated] = await db.update(rooms).set(updates).where(eq(rooms.id, id)).returning();
    return updated;
  }
  async deleteRoom(id: string): Promise<void> {
    await db.update(rooms).set({ status: 0 }).where(eq(rooms.id, id));
  }

  // ── Lost Contacts ──────────────────────────────────────────────────────────
  async getLostContacts(userId: string): Promise<LostContact[]> {
    return db.select().from(lostContacts)
      .where(and(eq(lostContacts.userId, userId), eq(lostContacts.status, 1)));
  }
  async getLostContact(id: string): Promise<LostContact | undefined> {
    const [c] = await db.select().from(lostContacts).where(eq(lostContacts.id, id));
    return c;
  }
  async createLostContact(data: InsertLostContact & { userId: string }): Promise<LostContact> {
    const [contact] = await db.insert(lostContacts).values({
      id: randomUUID(), userId: data.userId, lostUsername: data.lostUsername, note: data.note ?? null, status: 1,
    }).returning();
    return contact;
  }
  async updateLostContactStatus(id: string, status: number): Promise<LostContact | undefined> {
    const [updated] = await db.update(lostContacts).set({ status }).where(eq(lostContacts.id, id)).returning();
    return updated;
  }
  async deleteLostContact(id: string): Promise<void> {
    await db.delete(lostContacts).where(eq(lostContacts.id, id));
  }

  // ── Merchants ──────────────────────────────────────────────────────────────
  async getMerchants(): Promise<Merchant[]> {
    return db.select().from(merchants).where(eq(merchants.status, 1));
  }
  async getMerchantByUsername(username: string): Promise<Merchant | undefined> {
    const [m] = await db.select().from(merchants).where(eq(merchants.username, username));
    return m;
  }
  async createMerchant(data: InsertMerchant): Promise<Merchant> {
    const [m] = await db.insert(merchants).values({
      id: randomUUID(), status: 1, totalPoints: 0,
      usernameColorType: 0, merchantType: 1,
      mentor: null, referrer: null, ...data,
    }).returning();
    return m;
  }
  async updateMerchant(username: string, updates: Partial<Merchant>): Promise<Merchant | undefined> {
    const [updated] = await db.update(merchants).set(updates).where(eq(merchants.username, username)).returning();
    return updated;
  }
  async updateMerchantColorType(username: string, colorType: number): Promise<Merchant | undefined> {
    const colorHexMap: Record<number, string> = {
      0: "#990099",
      1: "#FF0000",
      2: "#FF69B4",
    };
    const usernameColor = colorHexMap[colorType] ?? "#990099";
    const [updated] = await db.update(merchants)
      .set({ usernameColorType: colorType, usernameColor })
      .where(eq(merchants.username, username))
      .returning();
    return updated;
  }
  async getMerchantLocations(merchantUsername: string): Promise<MerchantLocation[]> {
    return db.select().from(merchantLocations)
      .where(and(eq(merchantLocations.merchantUsername, merchantUsername), eq(merchantLocations.status, 1)));
  }
  async getMerchantLocationsByCountryId(countryId: number, offset: number, limit: number): Promise<MerchantLocation[]> {
    return db.select().from(merchantLocations)
      .where(and(eq(merchantLocations.countryId, countryId), eq(merchantLocations.status, 1)))
      .offset(offset)
      .limit(limit > 0 ? limit : 20);
  }
  async getMerchantLocationsByCountryName(countryName: string, offset: number, limit: number): Promise<MerchantLocation[]> {
    return db.select().from(merchantLocations)
      .where(and(
        sql`LOWER(${merchantLocations.country}) = ${countryName.toLowerCase()}`,
        eq(merchantLocations.status, 1)
      ))
      .offset(offset)
      .limit(limit > 0 ? limit : 20);
  }
  async getCountriesWithMerchants(): Promise<Array<{ countryId: number | null; country: string | null; count: number }>> {
    const rows = await db.select({
      countryId: merchantLocations.countryId,
      country: merchantLocations.country,
      count: sql<number>`cast(count(*) as int)`,
    })
      .from(merchantLocations)
      .where(eq(merchantLocations.status, 1))
      .groupBy(merchantLocations.countryId, merchantLocations.country);
    return rows.filter((r) => r.countryId !== null || r.country !== null);
  }
  async createMerchantLocation(data: InsertMerchantLocation): Promise<MerchantLocation> {
    const [loc] = await db.insert(merchantLocations).values({
      id: randomUUID(), status: 1, locationId: null, userData: null,
      phoneNumber: null, emailAddress: null, notes: null, address: null,
      countryId: null, country: null, ...data,
    }).returning();
    return loc;
  }
  async addMerchantPoints(merchantUsername: string, userId: string, points: number, entryType?: number, reason?: string) {
    await db.insert(merchantPoints).values({
      id: randomUUID(), merchantUsername, userId, points,
      type: entryType ?? 1,
      reason: reason ?? null,
    });
    await db.update(merchants).set({ totalPoints: sql`${merchants.totalPoints} + ${points}` })
      .where(eq(merchants.username, merchantUsername));
    return { merchantUsername, userId, points, reason };
  }
  async getUserMerchantPoints(merchantUsername: string, userId: string): Promise<number> {
    const rows = await db.select({ points: merchantPoints.points }).from(merchantPoints)
      .where(and(eq(merchantPoints.merchantUsername, merchantUsername), eq(merchantPoints.userId, userId)));
    return rows.reduce((sum, r) => sum + r.points, 0);
  }
  async getMerchantPointsHistory(merchantUsername: string, userId: string) {
    return db.select().from(merchantPoints)
      .where(and(eq(merchantPoints.merchantUsername, merchantUsername), eq(merchantPoints.userId, userId)))
      .orderBy(desc(merchantPoints.createdAt));
  }

  // ── Merchant Tags ──────────────────────────────────────────────────────────
  async getMerchantTags(filter: { merchantUsername?: string; taggedUsername?: string; type?: number; page?: number; numRecords?: number }): Promise<MerchantTag[]> {
    const now = new Date();
    const page = filter.page ?? 1;
    const limit = filter.numRecords ?? 50;
    const offset = (page - 1) * limit;
    const conditions = [eq(merchantTags.status, 1), gt(merchantTags.expiry, now)];
    if (filter.merchantUsername) conditions.push(eq(merchantTags.merchantUsername, filter.merchantUsername));
    if (filter.taggedUsername) conditions.push(eq(merchantTags.taggedUsername, filter.taggedUsername));
    if (filter.type !== undefined) conditions.push(eq(merchantTags.type, filter.type));
    return db.select().from(merchantTags)
      .where(and(...conditions))
      .orderBy(desc(merchantTags.createdAt))
      .limit(limit)
      .offset(offset);
  }
  async getMerchantTag(id: string): Promise<MerchantTag | undefined> {
    const [tag] = await db.select().from(merchantTags).where(eq(merchantTags.id, id));
    return tag;
  }
  async getMerchantTagByUsername(taggedUsername: string): Promise<MerchantTag | undefined> {
    const now = new Date();
    const [tag] = await db.select().from(merchantTags)
      .where(and(
        eq(merchantTags.taggedUsername, taggedUsername),
        eq(merchantTags.status, 1),
        gt(merchantTags.expiry, now)
      ))
      .orderBy(desc(merchantTags.createdAt))
      .limit(1);
    return tag;
  }
  async getExpiringMerchantTags(merchantUsername: string, daysAhead: number): Promise<MerchantTag[]> {
    const now = new Date();
    const future = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    return db.select().from(merchantTags)
      .where(and(
        eq(merchantTags.merchantUsername, merchantUsername),
        eq(merchantTags.status, 1),
        gt(merchantTags.expiry, now),
        lt(merchantTags.expiry, future)
      ))
      .orderBy(asc(merchantTags.expiry));
  }
  async createMerchantTag(data: InsertMerchantTag & { expiry?: Date }): Promise<MerchantTag> {
    const [tag] = await db.insert(merchantTags).values({
      id: randomUUID(),
      merchantUsername: data.merchantUsername,
      taggedUsername: data.taggedUsername,
      type: data.type ?? 2,
      expiry: data.expiry ?? null,
      status: 1,
      amount: (data as any).amount ?? null,
      currency: (data as any).currency ?? null,
      accountEntryId: (data as any).accountEntryId ?? null,
    }).returning();
    return tag;
  }
  async removeMerchantTag(id: string): Promise<void> {
    await db.update(merchantTags).set({ status: 0 }).where(eq(merchantTags.id, id));
  }

  // ── Discovery ──────────────────────────────────────────────────────────────
  async getRecommendedUsers(userId: string): Promise<Partial<User>[]> {
    return db.select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      country: users.country,
      displayPicture: users.displayPicture,
    })
      .from(users)
      .where(sql`${users.id} != ${userId}`)
      .orderBy(sql`RANDOM()`)
      .limit(10);
  }

  // ── Credit — Account Balance ───────────────────────────────────────────────
  async getCreditAccount(username: string): Promise<CreditAccount> {
    const [acct] = await db.select().from(creditAccounts).where(eq(creditAccounts.username, username));
    if (acct) return acct;
    const [created] = await db.insert(creditAccounts).values({
      id: randomUUID(), username, currency: "IDR", balance: 0, fundedBalance: 0,
    }).returning();
    return created;
  }
  async adjustBalance(username: string, amount: number, currency?: string): Promise<CreditAccount> {
    // Ensure account exists (auto-creates with 0 balance if missing)
    await this.getCreditAccount(username);
    const amountRounded = Math.round(amount * 100) / 100;
    // Use atomic SQL arithmetic to prevent race conditions from concurrent requests
    const updateFields: Parameters<typeof db.update>[0] extends never ? never : any = {
      balance: sql`ROUND((${creditAccounts.balance} + ${amountRounded})::numeric, 2)`,
      updatedAt: new Date(),
    };
    if (currency) updateFields.currency = currency;
    const [updated] = await db.update(creditAccounts)
      .set(updateFields)
      .where(eq(creditAccounts.username, username))
      .returning();
    return updated;
  }

  async setBalance(username: string, balance: number, currency?: string): Promise<CreditAccount> {
    // Ensure account exists; auto-creates row with 0 balance if missing.
    await this.getCreditAccount(username);
    const balanceRounded = Math.round(balance * 100) / 100;
    const updateFields: Parameters<typeof db.update>[0] extends never ? never : any = {
      balance: balanceRounded,
      updatedAt: new Date(),
    };
    if (currency) updateFields.currency = currency;
    const [updated] = await db.update(creditAccounts)
      .set(updateFields)
      .where(eq(creditAccounts.username, username))
      .returning();
    return updated;
  }

  async listCreditAccounts(opts: { search?: string; limit?: number } = {}): Promise<CreditAccount[]> {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const term = (opts.search ?? "").trim();
    if (term) {
      const like = `%${term.toLowerCase()}%`;
      return db.select().from(creditAccounts)
        .where(sql`LOWER(${creditAccounts.username}) LIKE ${like}`)
        .orderBy(creditAccounts.username)
        .limit(limit);
    }
    return db.select().from(creditAccounts).orderBy(creditAccounts.username).limit(limit);
  }

  // ── Credit — Transactions ──────────────────────────────────────────────────
  async getCreditTransactions(username: string, limit = 50): Promise<CreditTransaction[]> {
    return db.select().from(creditTransactions)
      .where(eq(creditTransactions.username, username))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit);
  }
  async createCreditTransaction(data: Omit<CreditTransaction, "id" | "createdAt">): Promise<CreditTransaction> {
    const [tx] = await db.insert(creditTransactions).values({ id: randomUUID(), ...data }).returning();
    return tx;
  }
  async getCreditTransaction(id: string): Promise<CreditTransaction | undefined> {
    const [tx] = await db.select().from(creditTransactions).where(eq(creditTransactions.id, id));
    return tx;
  }

  // ── Credit — Transfer ──────────────────────────────────────────────────────
  async transferCredit(fromUsername: string, toUsername: string, amount: number, _feeType = 1): Promise<{ from: CreditAccount; to: CreditAccount; fee: number }> {
    const amountRounded = Math.round(amount * 100) / 100;

    return db.transaction(async (tx) => {
      // Read both accounts inside the transaction for consistency
      const [fromAcct] = await tx.select().from(creditAccounts).where(eq(creditAccounts.username, fromUsername));
      if (!fromAcct || fromAcct.balance < amountRounded) throw new Error("Insufficient balance");

      const [toAcct] = await tx.select().from(creditAccounts).where(eq(creditAccounts.username, toUsername));
      if (!toAcct) throw new Error("Recipient account not found");

      // Atomic debit sender
      const [fromUpdated] = await tx.update(creditAccounts)
        .set({
          balance: sql`ROUND((${creditAccounts.balance} - ${amountRounded})::numeric, 2)`,
          updatedAt: new Date(),
        })
        .where(eq(creditAccounts.username, fromUsername))
        .returning();

      // Atomic credit receiver
      const [toUpdated] = await tx.update(creditAccounts)
        .set({
          balance: sql`ROUND((${creditAccounts.balance} + ${amountRounded})::numeric, 2)`,
          updatedAt: new Date(),
        })
        .where(eq(creditAccounts.username, toUsername))
        .returning();

      const ref = `TRF-${Date.now()}`;
      await tx.insert(creditTransactions).values({
        id: randomUUID(),
        username: fromUsername, type: CREDIT_TRANSACTION_TYPE.USER_TO_USER_TRANSFER,
        reference: ref, description: `Transfer to ${toUsername}`,
        currency: fromAcct.currency, amount: -amountRounded, fundedAmount: 0, tax: 0,
        runningBalance: fromUpdated.balance,
      });
      await tx.insert(creditTransactions).values({
        id: randomUUID(),
        username: toUsername, type: CREDIT_TRANSACTION_TYPE.USER_TO_USER_TRANSFER,
        reference: ref, description: `Received from ${fromUsername}`,
        currency: toAcct.currency, amount: amountRounded, fundedAmount: 0, tax: 0,
        runningBalance: toUpdated.balance,
      });

      return { from: fromUpdated, to: toUpdated, fee: 0 };
    });
  }

  // ── Credit — Vouchers ──────────────────────────────────────────────────────
  async getVoucherBatches(username?: string): Promise<VoucherBatch[]> {
    if (username) {
      return db.select().from(voucherBatches).where(eq(voucherBatches.createdByUsername, username));
    }
    return db.select().from(voucherBatches);
  }
  async getVoucherBatch(id: string): Promise<VoucherBatch | undefined> {
    const [b] = await db.select().from(voucherBatches).where(eq(voucherBatches.id, id));
    return b;
  }
  async createVoucherBatch(data: InsertVoucherBatch & { createdByUsername: string }): Promise<{ batch: VoucherBatch; vouchers: Voucher[] }> {
    const batchId = randomUUID();
    const count = data.numVoucher ?? 1;
    const [batch] = await db.insert(voucherBatches).values({
      id: batchId, createdByUsername: data.createdByUsername, currency: data.currency ?? "IDR",
      amount: data.amount, numVoucher: count, notes: data.notes ?? null,
      expiryDate: data.expiryDate ?? null, numActive: count,
      numCancelled: 0, numRedeemed: 0, numExpired: 0,
    }).returning();
    const created: Voucher[] = [];
    for (let i = 0; i < count; i++) {
      const code = `MIG-${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 12)}`;
      const [v] = await db.insert(vouchers).values({
        id: randomUUID(), voucherBatchId: batchId, code,
        currency: data.currency ?? "IDR", amount: data.amount,
        status: VOUCHER_STATUS.ACTIVE, redeemedByUsername: null,
        notes: data.notes ?? null, expiryDate: data.expiryDate ?? null,
      }).returning();
      created.push(v);
    }
    const acct = await this.getCreditAccount(data.createdByUsername);
    await this.createCreditTransaction({
      username: data.createdByUsername, type: CREDIT_TRANSACTION_TYPE.VOUCHERS_CREATED,
      reference: batchId, description: `Created ${count} voucher(s) of ${data.amount} ${data.currency ?? "IDR"}`,
      currency: data.currency ?? "IDR", amount: -(data.amount * count),
      fundedAmount: 0, tax: 0, runningBalance: acct.balance,
    });
    return { batch, vouchers: created };
  }
  async getVouchers(batchId: string): Promise<Voucher[]> {
    return db.select().from(vouchers).where(eq(vouchers.voucherBatchId, batchId));
  }
  async redeemVoucher(code: string, username: string): Promise<Voucher> {
    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.code, code));
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== VOUCHER_STATUS.ACTIVE) throw new Error("Voucher is not active");
    if (voucher.expiryDate && voucher.expiryDate < new Date()) throw new Error("Voucher has expired");
    const [updated] = await db.update(vouchers)
      .set({ status: VOUCHER_STATUS.REDEEMED, redeemedByUsername: username, updatedAt: new Date() })
      .where(eq(vouchers.code, code))
      .returning();
    await db.update(voucherBatches)
      .set({ numActive: sql`${voucherBatches.numActive} - 1`, numRedeemed: sql`${voucherBatches.numRedeemed} + 1` })
      .where(eq(voucherBatches.id, voucher.voucherBatchId));
    await this.adjustBalance(username, voucher.amount, voucher.currency);
    const acct = await this.getCreditAccount(username);
    await this.createCreditTransaction({
      username, type: CREDIT_TRANSACTION_TYPE.VOUCHER_RECHARGE,
      reference: code, description: `Voucher redemption: ${code}`,
      currency: voucher.currency, amount: voucher.amount, fundedAmount: 0, tax: 0,
      runningBalance: acct.balance,
    });
    return updated;
  }
  async cancelVoucher(id: string): Promise<Voucher | undefined> {
    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, id));
    if (!voucher || voucher.status !== VOUCHER_STATUS.ACTIVE) return undefined;
    const [updated] = await db.update(vouchers)
      .set({ status: VOUCHER_STATUS.CANCELLED, updatedAt: new Date() })
      .where(eq(vouchers.id, id))
      .returning();
    await db.update(voucherBatches)
      .set({ numActive: sql`${voucherBatches.numActive} - 1`, numCancelled: sql`${voucherBatches.numCancelled} + 1` })
      .where(eq(voucherBatches.id, voucher.voucherBatchId));
    return updated;
  }

  // ── Credit — Reward Programs ───────────────────────────────────────────────
  async getRewardPrograms(): Promise<RewardProgram[]> {
    return db.select().from(rewardPrograms).where(eq(rewardPrograms.status, 1));
  }
  async getRewardProgram(id: string): Promise<RewardProgram | undefined> {
    const [rp] = await db.select().from(rewardPrograms).where(eq(rewardPrograms.id, id));
    return rp;
  }
  async createRewardProgram(data: InsertRewardProgram): Promise<RewardProgram> {
    const [rp] = await db.insert(rewardPrograms).values({ id: randomUUID(), ...data }).returning();
    return rp;
  }
  async updateRewardProgram(id: string, updates: Partial<RewardProgram>): Promise<RewardProgram | undefined> {
    const [updated] = await db.update(rewardPrograms).set(updates).where(eq(rewardPrograms.id, id)).returning();
    return updated;
  }

  // ── Credit — User Reward History ───────────────────────────────────────────
  async getUserRewardHistory(username: string): Promise<UserRewardHistory[]> {
    return db.select().from(userRewardHistory)
      .where(eq(userRewardHistory.username, username))
      .orderBy(desc(userRewardHistory.createdAt));
  }
  async addUserReward(data: Omit<UserRewardHistory, "id" | "createdAt">): Promise<UserRewardHistory> {
    const [record] = await db.insert(userRewardHistory).values({ id: randomUUID(), ...data }).returning();
    if (data.migCreditAmount && data.migCreditAmount > 0) {
      await this.adjustBalance(data.username, data.migCreditAmount, data.migCreditCurrency ?? "IDR");
      const acct = await this.getCreditAccount(data.username);
      await this.createCreditTransaction({
        username: data.username, type: CREDIT_TRANSACTION_TYPE.MARKETING_REWARD,
        reference: data.programId ?? record.id,
        description: `Reward: ${data.programName ?? data.rewardType}`,
        currency: data.migCreditCurrency ?? "IDR", amount: data.migCreditAmount,
        fundedAmount: 0, tax: 0, runningBalance: acct.balance,
      });
    }
    return record;
  }

  async getVirtualGiftByName(name: string): Promise<VirtualGift | undefined> {
    const [gift] = await db.select().from(virtualGifts)
      .where(ilike(virtualGifts.name, name.trim()))
      .limit(1);
    return gift ?? undefined;
  }

  // Mirrors ContentBean.java: getVirtualGifts() → SELECT * FROM virtualgift WHERE status = 1 ORDER BY sortOrder
  async getVirtualGifts(): Promise<VirtualGift[]> {
    return db.select().from(virtualGifts)
      .where(eq(virtualGifts.status, 1))
      .orderBy(asc(virtualGifts.sortOrder));
  }

  // Mirrors ContentBean.java: searchVirtualGifts(username, offset, keyword, limit, activeOnly)
  // SQL: SELECT * FROM virtualgift WHERE name ILIKE '%keyword%' AND status = 1 LIMIT ?
  async searchVirtualGifts(query: string, limit = 5): Promise<VirtualGift[]> {
    return db.select().from(virtualGifts)
      .where(and(eq(virtualGifts.status, 1), ilike(virtualGifts.name, `%${query.trim()}%`)))
      .limit(limit);
  }

  async updateGiftImage(name: string, imageUrl: string | null): Promise<void> {
    await db.update(virtualGifts)
      .set({ location64x64Png: imageUrl, location16x16Png: imageUrl })
      .where(ilike(virtualGifts.name, name.trim()));
  }

  // Mirrors ContentBean.java: buyVirtualGiftForMultipleUsers()
  // SQL: INSERT INTO virtualgiftreceived (username, sender, virtual_gift_id, message, purchase_location, is_private)
  async createVirtualGiftReceived(data: InsertVirtualGiftReceived): Promise<VirtualGiftReceived> {
    const [record] = await db.insert(virtualGiftsReceived).values({
      username: data.username,
      sender: data.sender,
      virtualGiftId: data.virtualGiftId,
      message: data.message ?? null,
      purchaseLocation: 1,
      isPrivate: data.isPrivate ?? 0,
    }).returning();
    return record;
  }

  // Mirrors ContentBean.java: getStickerDataByNameForUser(senderUsername, stickerName)
  // SQL: SELECT * FROM emoticon WHERE LOWER(alias) = LOWER(stickerName) LIMIT 1
  async getEmoticonByAlias(alias: string): Promise<Emoticon | undefined> {
    const [emo] = await db.select().from(emoticons)
      .where(ilike(emoticons.alias, alias.trim()))
      .limit(1);
    return emo ?? undefined;
  }

  // ── Bot (mirrors BotDAO.java / FusionDbBotDAOChain.java) ──────────────────
  // SQL mirrors: SELECT * FROM bot WHERE id = ? AND status = 1
  async getBot(id: number): Promise<Bot | undefined> {
    const [bot] = await db.select().from(bots).where(eq(bots.id, id)).limit(1);
    return bot ?? undefined;
  }

  async getBots(activeOnly = true): Promise<Bot[]> {
    if (activeOnly) return db.select().from(bots).where(eq(bots.status, 1)).orderBy(asc(bots.sortOrder));
    return db.select().from(bots).orderBy(asc(bots.sortOrder));
  }

  async getBotConfigs(botId: number): Promise<BotConfig[]> {
    return db.select().from(botConfigs).where(eq(botConfigs.botId, botId));
  }

  async createBot(data: InsertBot): Promise<Bot> {
    const [bot] = await db.insert(bots).values(data).returning();
    return bot;
  }

  async updateBot(id: number, updates: Partial<Bot>): Promise<Bot | undefined> {
    const [bot] = await db.update(bots).set(updates).where(eq(bots.id, id)).returning();
    return bot ?? undefined;
  }

  async deleteBot(id: number): Promise<void> {
    await db.delete(bots).where(eq(bots.id, id));
  }

  // ── EmoAndSticker (mirrors EmoAndStickerDAO.java / FusionDbEmoAndStickerDAOChain.java) ──
  // SQL mirrors loadEmoticonPacks: SELECT ep.* FROM emoticonpack ep WHERE ep.status = ?
  async getEmoticonPacks(activeOnly = true): Promise<EmoticonPack[]> {
    if (activeOnly) return db.select().from(emoticonPacks).where(eq(emoticonPacks.status, 1)).orderBy(asc(emoticonPacks.sortOrder));
    return db.select().from(emoticonPacks).orderBy(asc(emoticonPacks.sortOrder));
  }

  async getEmoticonPack(id: number): Promise<EmoticonPack | undefined> {
    const [pack] = await db.select().from(emoticonPacks).where(eq(emoticonPacks.id, id)).limit(1);
    return pack ?? undefined;
  }

  // SQL mirrors loadEmoticons: SELECT e.* FROM emoticon e WHERE type IN (1,2,3,4)
  async getEmoticons(packId?: number): Promise<Emoticon[]> {
    if (packId != null) return db.select().from(emoticons).where(eq(emoticons.emoticonPackId, packId)).orderBy(asc(emoticons.id));
    return db.select().from(emoticons).orderBy(asc(emoticons.id));
  }

  // SQL mirrors loadEmoticonHeights: SELECT DISTINCT height FROM emoticon WHERE type IN (1,2,3,4) ORDER BY height
  async getEmoticonHeights(): Promise<number[]> {
    const rows = await db.selectDistinct({ height: emoticons.height }).from(emoticons).orderBy(asc(emoticons.height));
    return rows.map(r => r.height);
  }

  // Mirrors EmoAndStickerDAO.getOptimalEmoticonHeight: find closest height <= fontHeight
  async getOptimalEmoticonHeight(fontHeight: number): Promise<number> {
    const heights = await this.getEmoticonHeights();
    if (heights.length === 0) return fontHeight;
    let prev = heights[0];
    for (const h of heights) { if (h > fontHeight) return prev === 0 ? heights[0] : prev; prev = h; }
    return prev;
  }

  async createEmoticonPack(data: InsertEmoticonPack): Promise<EmoticonPack> {
    const [pack] = await db.insert(emoticonPacks).values(data).returning();
    return pack;
  }

  async updateEmoticonPack(id: number, updates: Partial<EmoticonPack>): Promise<EmoticonPack | undefined> {
    const [pack] = await db.update(emoticonPacks).set(updates).where(eq(emoticonPacks.id, id)).returning();
    return pack ?? undefined;
  }

  async createEmoticon(data: InsertEmoticon): Promise<Emoticon> {
    const [emo] = await db.insert(emoticons).values(data).returning();
    return emo;
  }

  async updateEmoticon(id: number, updates: Partial<Emoticon>): Promise<Emoticon | undefined> {
    const [emo] = await db.update(emoticons).set(updates).where(eq(emoticons.id, id)).returning();
    return emo ?? undefined;
  }

  async deleteEmoticon(id: number): Promise<void> {
    await db.delete(emoticons).where(eq(emoticons.id, id));
  }

  // ── Guardset (mirrors GuardsetDAO.java / FusionDbGuardsetDAOChain.java) ────
  // SQL mirrors: SELECT cv.clientversion FROM guardcapability gc, guardsetcapability gsc,
  //   guardsetmember gsm, guardset gs, clientversion cv
  //   WHERE gsc.capabilitytype = GUARD_BY_MIN_CLIENT_VERSION AND ... AND cv.clienttype = ?
  async getMinimumClientVersionForAccess(clientType: number, guardCapability: number): Promise<number | null> {
    const [rule] = await db.select().from(guardsetRules)
      .where(and(eq(guardsetRules.clientType, clientType), eq(guardsetRules.guardCapability, guardCapability)))
      .limit(1);
    return rule ? rule.minVersion : null;
  }

  async setGuardsetRule(clientType: number, guardCapability: number, minVersion: number, description?: string): Promise<GuardsetRule> {
    const existing = await this.getMinimumClientVersionForAccess(clientType, guardCapability);
    if (existing !== null) {
      const [updated] = await db.update(guardsetRules)
        .set({ minVersion, ...(description !== undefined ? { description } : {}) })
        .where(and(eq(guardsetRules.clientType, clientType), eq(guardsetRules.guardCapability, guardCapability)))
        .returning();
      return updated;
    }
    const [rule] = await db.insert(guardsetRules).values({ clientType, guardCapability, minVersion, description }).returning();
    return rule;
  }

  async getGuardsetRules(): Promise<GuardsetRule[]> {
    return db.select().from(guardsetRules).orderBy(asc(guardsetRules.clientType), asc(guardsetRules.guardCapability));
  }

  async deleteGuardsetRule(id: number): Promise<void> {
    await db.delete(guardsetRules).where(eq(guardsetRules.id, id));
  }

  // ── Message (mirrors MessageDAOChain.java / FusionDbMessageDAOChain.java) ─────
  // SQL: SELECT * FROM clienttext WHERE type = 1
  async loadHelpTexts(): Promise<Record<number, string>> {
    const rows = await db.select().from(clientTexts).where(eq(clientTexts.type, CLIENT_TEXT_TYPE.HELP));
    const result: Record<number, string> = {};
    rows.forEach(r => { result[r.id] = r.text; });
    return result;
  }

  // SQL: SELECT * FROM clienttext WHERE type = 2
  async loadInfoTexts(): Promise<Record<number, string>> {
    const rows = await db.select().from(clientTexts).where(eq(clientTexts.type, CLIENT_TEXT_TYPE.INFO));
    const result: Record<number, string> = {};
    rows.forEach(r => { result[r.id] = r.text; });
    return result;
  }

  // SELECT text FROM clienttext WHERE id = ? AND type = 2
  async getInfoText(infoId: number): Promise<string | undefined> {
    const [row] = await db.select({ text: clientTexts.text })
      .from(clientTexts)
      .where(and(eq(clientTexts.id, infoId), eq(clientTexts.type, CLIENT_TEXT_TYPE.INFO)));
    return row?.text;
  }

  async createClientText(data: InsertClientText): Promise<ClientText> {
    const [row] = await db.insert(clientTexts).values(data).returning();
    return row;
  }

  async updateClientText(id: number, updates: Partial<ClientText>): Promise<ClientText | undefined> {
    const [updated] = await db.update(clientTexts).set(updates).where(eq(clientTexts.id, id)).returning();
    return updated ?? undefined;
  }

  async deleteClientText(id: number): Promise<void> {
    await db.delete(clientTexts).where(eq(clientTexts.id, id));
  }

  async getClientTexts(): Promise<ClientText[]> {
    return db.select().from(clientTexts).orderBy(asc(clientTexts.type), asc(clientTexts.id));
  }

  // SQL: SELECT * FROM alertmessage
  //   WHERE MinMidletVersion<=? AND MaxMidletVersion>=?
  //   AND Type=? AND (CountryID=? OR CountryID IS NULL)
  //   AND StartDate<=now() AND ExpiryDate>now()
  //   AND Status=1 AND clientType=? [AND ContentType=?]
  //   ORDER BY CountryID
  async getLatestAlertMessages(params: {
    midletVersion: number;
    type: number;
    countryId: number;
    contentType?: number;
    clientType: number;
  }): Promise<AlertMessage[]> {
    const conditions = [
      sql`${alertMessages.minMidletVersion} <= ${params.midletVersion}`,
      sql`${alertMessages.maxMidletVersion} >= ${params.midletVersion}`,
      eq(alertMessages.type, params.type),
      or(eq(alertMessages.countryId, params.countryId), sql`${alertMessages.countryId} IS NULL`),
      lt(alertMessages.startDate, sql`now()`),
      gt(alertMessages.expiryDate, sql`now()`),
      eq(alertMessages.status, ALERT_MESSAGE_STATUS.ACTIVE),
      eq(alertMessages.clientType, params.clientType),
    ];
    if (params.contentType !== undefined) conditions.push(eq(alertMessages.contentType, params.contentType));
    return db.select().from(alertMessages)
      .where(and(...conditions))
      .orderBy(asc(alertMessages.countryId));
  }

  async createAlertMessage(data: InsertAlertMessage): Promise<AlertMessage> {
    const [msg] = await db.insert(alertMessages).values(data).returning();
    return msg;
  }

  async updateAlertMessage(id: number, updates: Partial<AlertMessage>): Promise<AlertMessage | undefined> {
    const [updated] = await db.update(alertMessages).set(updates).where(eq(alertMessages.id, id)).returning();
    return updated ?? undefined;
  }

  async deleteAlertMessage(id: number): Promise<void> {
    await db.delete(alertMessages).where(eq(alertMessages.id, id));
  }

  async getAlertMessages(status?: number): Promise<AlertMessage[]> {
    if (status !== undefined) {
      return db.select().from(alertMessages).where(eq(alertMessages.status, status)).orderBy(desc(alertMessages.createdAt));
    }
    return db.select().from(alertMessages).orderBy(desc(alertMessages.createdAt));
  }

  // ── Group (mirrors GroupDAOChain.java / FusionDbGroupDAOChain.java) ─────────
  // SQL: SELECT groups.* FROM groups LEFT OUTER JOIN service ON (groups.vipserviceid=service.id AND service.status=1)
  //      WHERE groups.id=? AND groups.status=1
  async getGroup(groupId: number): Promise<Group | undefined> {
    const [group] = await db.select().from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.status, 1)));
    return group ?? undefined;
  }

  async getGroups(status?: number): Promise<Group[]> {
    if (status !== undefined) {
      return db.select().from(groups).where(eq(groups.status, status)).orderBy(asc(groups.name));
    }
    return db.select().from(groups).orderBy(asc(groups.name));
  }

  async createGroup(data: InsertGroup): Promise<Group> {
    const [group] = await db.insert(groups).values(data).returning();
    return group;
  }

  async updateGroup(id: number, updates: Partial<Group>): Promise<Group | undefined> {
    const [updated] = await db.update(groups).set(updates).where(eq(groups.id, id)).returning();
    return updated ?? undefined;
  }

  async deleteGroup(id: number): Promise<void> {
    await db.delete(groups).where(eq(groups.id, id));
  }

  // SQL: SELECT gm.username FROM groupmember WHERE groupid=? AND status=ACTIVE AND type=MODERATOR
  async getModeratorUserNames(groupId: number): Promise<string[]> {
    const rows = await db.select({ username: groupMembers.username })
      .from(groupMembers)
      .where(and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.status, GROUP_MEMBER_STATUS.ACTIVE),
        eq(groupMembers.type, GROUP_MEMBER_TYPE.MODERATOR),
      ));
    return rows.map(r => r.username).sort();
  }

  async getGroupMembers(groupId: number, status?: number): Promise<GroupMember[]> {
    const conditions = [eq(groupMembers.groupId, groupId)];
    if (status !== undefined) conditions.push(eq(groupMembers.status, status));
    return db.select().from(groupMembers).where(and(...conditions)).orderBy(asc(groupMembers.joinedAt));
  }

  async getGroupMembersByUsername(username: string): Promise<GroupMember[]> {
    return db.select().from(groupMembers).where(eq(groupMembers.username, username));
  }

  async addGroupMember(data: InsertGroupMember): Promise<GroupMember> {
    const [member] = await db.insert(groupMembers).values({ ...data, status: GROUP_MEMBER_STATUS.ACTIVE }).returning();
    return member;
  }

  async updateGroupMember(id: number, updates: Partial<GroupMember>): Promise<GroupMember | undefined> {
    const [updated] = await db.update(groupMembers).set(updates).where(eq(groupMembers.id, id)).returning();
    return updated ?? undefined;
  }

  async removeGroupMember(id: number): Promise<void> {
    await db.delete(groupMembers).where(eq(groupMembers.id, id));
  }

  // ── Email Bounce (mirrors EmailDAOChain.java / FusionDbEmailDAOChain.java) ──
  // SQL: SELECT bounceType FROM bouncedb WHERE emailaddress = ? LIMIT 1
  async isBounceEmailAddress(email: string): Promise<boolean> {
    const [record] = await db.select({ bounceType: bounceEmails.bounceType })
      .from(bounceEmails)
      .where(eq(bounceEmails.emailAddress, email.toLowerCase()))
      .limit(1);
    if (!record) return false;
    const sendToTransient = process.env.ENABLE_SEND_TO_TRANSIENT_EMAIL === "true";
    if (sendToTransient && record.bounceType === "Transient") return false;
    return true;
  }

  async addBounceEmail(email: string, bounceType = "Permanent"): Promise<void> {
    await db.insert(bounceEmails)
      .values({ emailAddress: email.toLowerCase(), bounceType })
      .onConflictDoUpdate({ target: bounceEmails.emailAddress, set: { bounceType } });
  }

  async removeBounceEmail(email: string): Promise<void> {
    await db.delete(bounceEmails).where(eq(bounceEmails.emailAddress, email.toLowerCase()));
  }

  async listBounceEmails(limit = 100, offset = 0): Promise<{ email: string; bounceType: string; createdAt: Date }[]> {
    const rows = await db.select({
      email: bounceEmails.emailAddress,
      bounceType: bounceEmails.bounceType,
      createdAt: bounceEmails.createdAt,
    }).from(bounceEmails)
      .orderBy(desc(bounceEmails.createdAt))
      .limit(limit)
      .offset(offset);
    return rows;
  }

  // ── Campaign (mirrors CampaignDataDAOChain.java / FusionDbCampaignDataDAOChain.java) ──
  // SQL: SELECT * FROM campaign WHERE id = ?
  async getCampaign(campaignId: number): Promise<Campaign | undefined> {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    return campaign ?? undefined;
  }

  // SQL: SELECT * FROM campaign [WHERE status=1 AND startdate<now() AND enddate>now()]
  async getCampaigns(activeOnly = true): Promise<Campaign[]> {
    if (!activeOnly) return db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
    return db.select().from(campaigns)
      .where(and(
        eq(campaigns.status, 1),
        or(sql`${campaigns.startDate} IS NULL`, lt(campaigns.startDate, sql`now()`)),
        or(sql`${campaigns.endDate} IS NULL`, gt(campaigns.endDate, sql`now()`)),
      ))
      .orderBy(desc(campaigns.createdAt));
  }

  async createCampaign(data: InsertCampaign): Promise<Campaign> {
    const [campaign] = await db.insert(campaigns).values(data).returning();
    return campaign;
  }

  async updateCampaign(id: number, updates: Partial<Campaign>): Promise<Campaign | undefined> {
    const [updated] = await db.update(campaigns).set(updates).where(eq(campaigns.id, id)).returning();
    return updated ?? undefined;
  }

  async deleteCampaign(id: number): Promise<void> {
    await db.delete(campaigns).where(eq(campaigns.id, id));
  }

  // SQL: SELECT * FROM campaignparticipant WHERE campaignid = ? AND userid = ?
  async getCampaignParticipant(userId: string, campaignId: number): Promise<CampaignParticipant | undefined> {
    const [participant] = await db.select().from(campaignParticipants)
      .where(and(eq(campaignParticipants.campaignId, campaignId), eq(campaignParticipants.userId, userId)));
    return participant ?? undefined;
  }

  // SQL: SELECT cp.* FROM campaignparticipant cp JOIN campaign c ON c.id = cp.campaignid
  //   WHERE c.type = ? AND cp.userid = ? AND c.status = 1 AND c.startdate < now() AND c.enddate > now()
  async getActiveCampaignParticipants(userId: string, type?: number): Promise<CampaignParticipant[]> {
    const conditions = [
      eq(campaignParticipants.userId, userId),
      eq(campaigns.status, 1),
      or(sql`${campaigns.startDate} IS NULL`, lt(campaigns.startDate, sql`now()`)),
      or(sql`${campaigns.endDate} IS NULL`, gt(campaigns.endDate, sql`now()`)),
    ];
    if (type !== undefined) conditions.push(eq(campaigns.type, type));
    return db.select({ campaignParticipants })
      .from(campaignParticipants)
      .innerJoin(campaigns, eq(campaigns.id, campaignParticipants.campaignId))
      .where(and(...conditions))
      .then(rows => rows.map(r => r.campaignParticipants));
  }

  // SQL: SELECT * FROM campaignparticipant WHERE campaignid = ? AND mobilephone = ?
  async getCampaignParticipantByMobile(mobilePhone: string, campaignId: number): Promise<CampaignParticipant | undefined> {
    const [participant] = await db.select().from(campaignParticipants)
      .where(and(eq(campaignParticipants.campaignId, campaignId), eq(campaignParticipants.mobilePhone, mobilePhone)));
    return participant ?? undefined;
  }

  // SQL: INSERT INTO campaignparticipant (campaignid, userid, mobilephone, emailaddress, reference)
  async joinCampaign(data: InsertCampaignParticipant): Promise<CampaignParticipant> {
    const [participant] = await db.insert(campaignParticipants).values(data).returning();
    return participant;
  }

  async getCampaignParticipants(campaignId: number): Promise<CampaignParticipant[]> {
    return db.select().from(campaignParticipants)
      .where(eq(campaignParticipants.campaignId, campaignId))
      .orderBy(asc(campaignParticipants.joinedAt));
  }

  async getPostComments(postId: string): Promise<PostComment[]> {
    const rows = await db.select().from(postComments)
      .where(eq(postComments.postId, postId))
      .orderBy(asc(postComments.createdAt));
    return rows.map(r => ({
      id: r.id,
      postId: r.postId,
      authorUserId: r.authorUserId,
      authorUsername: r.authorUsername,
      text: r.text,
      createdAt: r.createdAt,
    }));
  }

  async createPostComment(data: { postId: string; authorUserId: string; authorUsername: string; text: string }): Promise<PostComment> {
    const [row] = await db.insert(postComments).values({
      postId: data.postId,
      authorUserId: data.authorUserId,
      authorUsername: data.authorUsername,
      text: data.text,
    }).returning();
    await db.update(wallPosts)
      .set({ numComments: sql`${wallPosts.numComments} + 1` })
      .where(eq(wallPosts.id, data.postId));
    return {
      id: row.id,
      postId: row.postId,
      authorUserId: row.authorUserId,
      authorUsername: row.authorUsername,
      text: row.text,
      createdAt: row.createdAt,
    };
  }

  // ── Leaderboard ──────────────────────────────────────────────────────────────
  async getLeaderboard(type: string, period: string, limit: number, offset: number): Promise<LeaderboardEntry[]> {
    return db.select().from(leaderboardEntries)
      .where(and(eq(leaderboardEntries.leaderboardType, type), eq(leaderboardEntries.period, period)))
      .orderBy(desc(leaderboardEntries.score))
      .limit(limit).offset(offset);
  }
  async getLeaderboardRank(type: string, period: string, username: string): Promise<{ score: number; position: number } | null> {
    const all = await db.select().from(leaderboardEntries)
      .where(and(eq(leaderboardEntries.leaderboardType, type), eq(leaderboardEntries.period, period)))
      .orderBy(desc(leaderboardEntries.score));
    const idx = all.findIndex(e => e.username === username);
    if (idx === -1) return null;
    return { score: all[idx].score, position: idx + 1 };
  }
  async upsertLeaderboardEntry(type: string, period: string, username: string, score: number, increment: boolean): Promise<LeaderboardEntry> {
    const [existing] = await db.select().from(leaderboardEntries)
      .where(and(eq(leaderboardEntries.leaderboardType, type), eq(leaderboardEntries.period, period), eq(leaderboardEntries.username, username)));
    if (existing) {
      const newScore = increment ? existing.score + score : score;
      const [updated] = await db.update(leaderboardEntries)
        .set({ score: newScore, updatedAt: new Date() })
        .where(eq(leaderboardEntries.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(leaderboardEntries).values({ leaderboardType: type, period, username, score }).returning();
    return created;
  }
  async resetLeaderboard(type: string, period: string, previousPeriod: string): Promise<void> {
    const entries = await db.select().from(leaderboardEntries)
      .where(and(eq(leaderboardEntries.leaderboardType, type), eq(leaderboardEntries.period, period)));
    if (entries.length > 0) {
      await db.delete(leaderboardEntries).where(and(eq(leaderboardEntries.leaderboardType, type), eq(leaderboardEntries.period, previousPeriod)));
      await db.insert(leaderboardEntries).values(entries.map(e => ({ ...e, id: undefined as any, period: previousPeriod })));
      await db.delete(leaderboardEntries).where(and(eq(leaderboardEntries.leaderboardType, type), eq(leaderboardEntries.period, period)));
    }
  }

  // ── Invitation ────────────────────────────────────────────────────────────────
  async createInvitation(data: InsertInvitation): Promise<Invitation> {
    const [inv] = await db.insert(invitations).values({ id: randomUUID(), ...data }).returning();
    return inv;
  }
  async getInvitationById(id: string): Promise<Invitation | undefined> {
    const [inv] = await db.select().from(invitations).where(eq(invitations.id, id));
    return inv;
  }
  async getInvitationsBySender(username: string, limit: number): Promise<Invitation[]> {
    return db.select().from(invitations).where(eq(invitations.senderUsername, username)).orderBy(desc(invitations.createdAt)).limit(limit);
  }
  async getInvitationsByDestination(destination: string): Promise<Invitation[]> {
    return db.select().from(invitations).where(eq(invitations.destination, destination)).orderBy(desc(invitations.createdAt));
  }
  async updateInvitationStatus(id: string, status: number): Promise<Invitation | undefined> {
    const [updated] = await db.update(invitations).set({ status }).where(eq(invitations.id, id)).returning();
    return updated;
  }
  async expireOldInvitations(): Promise<number> {
    const now = new Date();
    const expired = await db.update(invitations).set({ status: 4 })
      .where(and(eq(invitations.status, 1), lt(invitations.expiresAt, now)))
      .returning();
    return expired.length;
  }

  // ── Reputation ────────────────────────────────────────────────────────────────
  async getUserReputation(username: string): Promise<UserReputationRow | undefined> {
    const [rep] = await db.select().from(userReputation).where(eq(userReputation.username, username));
    return rep;
  }
  async createUserReputation(username: string): Promise<UserReputationRow> {
    const [rep] = await db.insert(userReputation).values({ username }).returning();
    return rep;
  }
  async incrementReputationScore(username: string, amount: number): Promise<UserReputationRow> {
    const existing = await this.getUserReputation(username) ?? await this.createUserReputation(username);
    const [updated] = await db.update(userReputation)
      .set({ score: existing.score + amount, updatedAt: new Date() })
      .where(eq(userReputation.username, username)).returning();
    return updated;
  }
  async updateReputationLevel(username: string, level: number): Promise<void> {
    await db.update(userReputation).set({ level, updatedAt: new Date() }).where(eq(userReputation.username, username));
  }
  async updateReputationMetrics(username: string, metrics: Partial<Omit<UserReputationRow, "id" | "username" | "updatedAt">>): Promise<UserReputationRow> {
    const existing = await this.getUserReputation(username) ?? await this.createUserReputation(username);
    const updates: any = { updatedAt: new Date() };
    if (metrics.chatRoomMessagesSent) updates.chatRoomMessagesSent = existing.chatRoomMessagesSent + metrics.chatRoomMessagesSent;
    if (metrics.privateMessagesSent)  updates.privateMessagesSent  = existing.privateMessagesSent  + metrics.privateMessagesSent;
    if (metrics.totalTime)            updates.totalTime            = existing.totalTime            + metrics.totalTime;
    if (metrics.photosUploaded)       updates.photosUploaded       = existing.photosUploaded       + metrics.photosUploaded;
    if (metrics.kicksInitiated)       updates.kicksInitiated       = existing.kicksInitiated       + metrics.kicksInitiated;
    if (metrics.authenticatedReferrals) updates.authenticatedReferrals = existing.authenticatedReferrals + metrics.authenticatedReferrals;
    if (metrics.rechargedAmount)      updates.rechargedAmount      = existing.rechargedAmount      + metrics.rechargedAmount;
    if (metrics.phoneCallDuration)    updates.phoneCallDuration    = existing.phoneCallDuration    + metrics.phoneCallDuration;
    if (metrics.sessionCount)         updates.sessionCount         = existing.sessionCount         + metrics.sessionCount;
    if (metrics.virtualGiftsSent)     updates.virtualGiftsSent     = existing.virtualGiftsSent     + metrics.virtualGiftsSent;
    if (metrics.virtualGiftsReceived) updates.virtualGiftsReceived = existing.virtualGiftsReceived + metrics.virtualGiftsReceived;
    const [updated] = await db.update(userReputation).set(updates).where(eq(userReputation.username, username)).returning();
    return updated;
  }
  async getTopReputationUsers(limit: number, offset: number): Promise<UserReputationRow[]> {
    return db.select().from(userReputation).orderBy(desc(userReputation.score)).limit(limit).offset(offset);
  }

  // ── Reputation Level Table (mirrors ReputationScoreToLevel + LevelTable.java) ─
  // SELECT score, level FROM ReputationScoreToLevel ORDER BY score DESC
  async getLevelTable(): Promise<LevelThreshold[]> {
    const result = await db.execute(sql`
      SELECT level, score, name, image, chat_room_size AS "chatRoomSize",
             group_size AS "groupSize", num_group_chat_rooms AS "numGroupChatRooms",
             create_chat_room AS "createChatRoom", create_group AS "createGroup",
             publish_photo AS "publishPhoto",
             post_comment_like_user_wall AS "postCommentLikeUserWall",
             add_to_photo_wall AS "addToPhotoWall", enter_pot AS "enterPot",
             num_group_moderators AS "numGroupModerators"
      FROM reputation_score_to_level
      ORDER BY score DESC
    `);
    return result.rows as LevelThreshold[];
  }
  // Mirrors LevelTable.getLevelDataForScore(): floor lookup — highest level where score >= threshold
  async getLevelDataForScore(score: number): Promise<LevelThreshold | undefined> {
    const result = await db.execute(sql`
      SELECT level, score, name, image, chat_room_size AS "chatRoomSize",
             group_size AS "groupSize", num_group_chat_rooms AS "numGroupChatRooms",
             create_chat_room AS "createChatRoom", create_group AS "createGroup",
             publish_photo AS "publishPhoto",
             post_comment_like_user_wall AS "postCommentLikeUserWall",
             add_to_photo_wall AS "addToPhotoWall", enter_pot AS "enterPot",
             num_group_moderators AS "numGroupModerators"
      FROM reputation_score_to_level
      WHERE score <= ${score}
      ORDER BY score DESC
      LIMIT 1
    `);
    return result.rows[0] as LevelThreshold | undefined;
  }
  async upsertLevelThreshold(data: InsertLevelThreshold): Promise<LevelThreshold> {
    const [result] = await db.insert(reputationScoreToLevel)
      .values(data)
      .onConflictDoUpdate({ target: reputationScoreToLevel.level, set: data })
      .returning();
    return result;
  }
  async deleteLevelThreshold(level: number): Promise<void> {
    await db.delete(reputationScoreToLevel).where(eq(reputationScoreToLevel.level, level));
  }

  // ── Payment ───────────────────────────────────────────────────────────────────
  async createPayment(data: InsertPayment): Promise<Payment> {
    const [payment] = await db.insert(payments).values(data).returning();
    return payment;
  }
  async getPaymentById(id: number): Promise<Payment | undefined> {
    const [p] = await db.select().from(payments).where(eq(payments.id, id));
    return p;
  }
  async getPaymentsByUsername(username: string, limit: number, status?: number): Promise<Payment[]> {
    const conditions = status !== undefined
      ? and(eq(payments.username, username), eq(payments.status, status))
      : eq(payments.username, username);
    return db.select().from(payments).where(conditions).orderBy(desc(payments.createdAt)).limit(limit);
  }
  async updatePaymentStatus(id: number, status: number, vendorTransactionId?: string): Promise<Payment | undefined> {
    const updates: any = { status, updatedAt: new Date() };
    if (vendorTransactionId) updates.vendorTransactionId = vendorTransactionId;
    const [updated] = await db.update(payments).set(updates).where(eq(payments.id, id)).returning();
    return updated;
  }

  // ── Search extensions ──────────────────────────────────────────────────────────
  async searchChatrooms(query: string, limit = 20, offset = 0, categoryId?: number, language?: string): Promise<Chatroom[]> {
    const q = `%${query}%`;
    let cond = or(ilike(chatrooms.name, q), ilike(chatrooms.description, q));
    if (categoryId !== undefined) cond = and(cond, eq(chatrooms.categoryId, categoryId)) as any;
    if (language !== undefined) cond = and(cond, eq(chatrooms.language, language)) as any;
    return db.select().from(chatrooms).where(cond).limit(limit).offset(offset);
  }
  async searchGroups(query: string, limit: number): Promise<Group[]> {
    const q = `%${query}%`;
    return db.select().from(groups).where(ilike(groups.name, q)).limit(limit);
  }
  async searchMerchants(query: string, limit: number): Promise<Merchant[]> {
    const q = `%${query}%`;
    return db.select().from(merchants).where(or(ilike(merchants.displayName, q), ilike(merchants.username, q))).limit(limit);
  }
  async getAllChatroomsForIndex(): Promise<Chatroom[]> {
    return db.select().from(chatrooms).orderBy(asc(chatrooms.name));
  }

  // ── UserEvent ─────────────────────────────────────────────────────────────────
  async createUserEvent(data: InsertUserEvent): Promise<UserEvent> {
    const [event] = await db.insert(userEvents).values({ id: randomUUID(), ...data }).returning();
    return event;
  }
  async getUserEvents(username: string, limit: number, eventType?: string, since?: Date): Promise<UserEvent[]> {
    let cond = eq(userEvents.username, username) as any;
    if (eventType) cond = and(cond, eq(userEvents.eventType, eventType));
    if (since) cond = and(cond, gt(userEvents.createdAt, since));
    return db.select().from(userEvents).where(cond).orderBy(desc(userEvents.createdAt)).limit(limit);
  }
  async deleteUserEvents(username: string): Promise<number> {
    const deleted = await db.delete(userEvents).where(eq(userEvents.username, username)).returning();
    return deleted.length;
  }
  async deleteUserEventsByType(username: string, eventType: string): Promise<number> {
    const deleted = await db.delete(userEvents).where(and(eq(userEvents.username, username), eq(userEvents.eventType, eventType))).returning();
    return deleted.length;
  }
  async getUserEventStats(username: string): Promise<Record<string, number>> {
    const events = await db.select().from(userEvents).where(eq(userEvents.username, username));
    const stats: Record<string, number> = {};
    for (const e of events) stats[e.eventType] = (stats[e.eventType] ?? 0) + 1;
    return stats;
  }
  // ShowEventsGeneratedByUser.java: getUserEventsGeneratedByUser(username)
  async getUserEventsGeneratedByUser(generatingUsername: string, limit: number, eventType?: string, since?: Date): Promise<UserEvent[]> {
    let cond = eq(userEvents.generatingUsername, generatingUsername) as any;
    if (eventType) cond = and(cond, eq(userEvents.eventType, eventType));
    if (since) cond = and(cond, gt(userEvents.createdAt, since));
    return db.select().from(userEvents).where(cond).orderBy(desc(userEvents.createdAt)).limit(limit);
  }
  // DumpGeneratorEvents.java: dump(requestedCount) — most recent N generator events across all users
  async getGeneratorEvents(count: number): Promise<UserEvent[]> {
    return db.select().from(userEvents).orderBy(desc(userEvents.createdAt)).limit(count);
  }
  // ShowPrivacySettings.java / ModifyPrivacySettings.java — privacy mask CRUD
  // Default mask matches EventPrivacySetting Java defaults
  async getPrivacySettings(username: string): Promise<UserEventPrivacy> {
    const [row] = await db.select().from(userEventPrivacy).where(eq(userEventPrivacy.username, username));
    if (row) return row;
    const [created] = await db.insert(userEventPrivacy).values({ username }).returning();
    return created;
  }
  async setReceivingPrivacyMask(username: string, mask: Partial<import("./storage").ReceivingPrivacyMask>): Promise<UserEventPrivacy> {
    const updates: Record<string, boolean> = {};
    if (mask.statusUpdates !== undefined) updates.receivingStatusUpdates = mask.statusUpdates;
    if (mask.profileChanges !== undefined) updates.receivingProfileChanges = mask.profileChanges;
    if (mask.addFriends !== undefined) updates.receivingAddFriends = mask.addFriends;
    if (mask.photosPublished !== undefined) updates.receivingPhotosPublished = mask.photosPublished;
    if (mask.contentPurchased !== undefined) updates.receivingContentPurchased = mask.contentPurchased;
    if (mask.chatroomCreation !== undefined) updates.receivingChatroomCreation = mask.chatroomCreation;
    if (mask.virtualGifting !== undefined) updates.receivingVirtualGifting = mask.virtualGifting;
    await this.getPrivacySettings(username);
    const [row] = await db.update(userEventPrivacy).set({ ...updates, updatedAt: new Date() }).where(eq(userEventPrivacy.username, username)).returning();
    return row;
  }
  async setPublishingPrivacyMask(username: string, mask: Partial<import("./storage").PublishingPrivacyMask>): Promise<UserEventPrivacy> {
    const updates: Record<string, boolean> = {};
    if (mask.statusUpdates !== undefined) updates.publishingStatusUpdates = mask.statusUpdates;
    if (mask.profileChanges !== undefined) updates.publishingProfileChanges = mask.profileChanges;
    if (mask.addFriends !== undefined) updates.publishingAddFriends = mask.addFriends;
    if (mask.photosPublished !== undefined) updates.publishingPhotosPublished = mask.photosPublished;
    if (mask.contentPurchased !== undefined) updates.publishingContentPurchased = mask.contentPurchased;
    if (mask.chatroomCreation !== undefined) updates.publishingChatroomCreation = mask.chatroomCreation;
    if (mask.virtualGifting !== undefined) updates.publishingVirtualGifting = mask.virtualGifting;
    await this.getPrivacySettings(username);
    const [row] = await db.update(userEventPrivacy).set({ ...updates, updatedAt: new Date() }).where(eq(userEventPrivacy.username, username)).returning();
    return row;
  }

  // ── FashionShow ───────────────────────────────────────────────────────────────
  async getFashionShowCandidates(limit: number, offset: number): Promise<FashionShowSession[]> {
    return db.select().from(fashionShowSessions).where(eq(fashionShowSessions.status, 1)).orderBy(desc(fashionShowSessions.votes)).limit(limit).offset(offset);
  }
  async getFashionShowWinners(limit: number): Promise<FashionShowSession[]> {
    return db.select().from(fashionShowSessions).where(eq(fashionShowSessions.status, 2)).orderBy(desc(fashionShowSessions.votes)).limit(limit);
  }
  async getFashionShowByUsername(username: string): Promise<FashionShowSession | undefined> {
    const [s] = await db.select().from(fashionShowSessions).where(eq(fashionShowSessions.username, username));
    return s;
  }
  async getFashionShowById(id: string): Promise<FashionShowSession | undefined> {
    const [s] = await db.select().from(fashionShowSessions).where(eq(fashionShowSessions.id, id));
    return s;
  }
  async createFashionShowSession(data: InsertFashionShowSession): Promise<FashionShowSession> {
    const [s] = await db.insert(fashionShowSessions).values({ id: randomUUID(), ...data, votes: 0 }).returning();
    return s;
  }
  async incrementFashionShowVotes(id: string): Promise<FashionShowSession> {
    const [existing] = await db.select().from(fashionShowSessions).where(eq(fashionShowSessions.id, id));
    if (!existing) throw new Error("Session not found");
    const [updated] = await db.update(fashionShowSessions).set({ votes: existing.votes + 1 }).where(eq(fashionShowSessions.id, id)).returning();
    return updated;
  }

  // ── PaintWars ─────────────────────────────────────────────────────────────────
  async getPaintwarsStats(username: string): Promise<PaintwarsStatsType | undefined> {
    const [stats] = await db.select().from(paintwarsStats).where(eq(paintwarsStats.username, username));
    return stats;
  }
  async createPaintwarsStats(username: string): Promise<PaintwarsStatsType> {
    const [stats] = await db.insert(paintwarsStats).values({ username, paintsRemaining: 3, cleansRemaining: 2 }).returning();
    return stats;
  }
  async recordPaint(painterUsername: string, targetUsername: string, _paid: boolean): Promise<{ painter: PaintwarsStatsType; target: PaintwarsStatsType }> {
    const painter = await this.getPaintwarsStats(painterUsername) ?? await this.createPaintwarsStats(painterUsername);
    const target = await this.getPaintwarsStats(targetUsername) ?? await this.createPaintwarsStats(targetUsername);
    const [updatedPainter] = await db.update(paintwarsStats).set({
      totalPaintsSent: painter.totalPaintsSent + 1,
      totalPaintWarsPoints: painter.totalPaintWarsPoints + 1,
      paintsRemaining: _paid ? painter.paintsRemaining : Math.max(0, painter.paintsRemaining - 1),
      updatedAt: new Date(),
    }).where(eq(paintwarsStats.username, painterUsername)).returning();
    const [updatedTarget] = await db.update(paintwarsStats).set({
      totalPaintsReceived: target.totalPaintsReceived + 1,
      updatedAt: new Date(),
    }).where(eq(paintwarsStats.username, targetUsername)).returning();
    return { painter: updatedPainter, target: updatedTarget };
  }
  async recordClean(cleanerUsername: string, targetUsername: string, _paid: boolean): Promise<{ cleaner: PaintwarsStatsType; target: PaintwarsStatsType }> {
    const cleaner = await this.getPaintwarsStats(cleanerUsername) ?? await this.createPaintwarsStats(cleanerUsername);
    const target = await this.getPaintwarsStats(targetUsername) ?? await this.createPaintwarsStats(targetUsername);
    const [updatedCleaner] = await db.update(paintwarsStats).set({
      totalCleansSent: cleaner.totalCleansSent + 1,
      cleansRemaining: _paid ? cleaner.cleansRemaining : Math.max(0, cleaner.cleansRemaining - 1),
      updatedAt: new Date(),
    }).where(eq(paintwarsStats.username, cleanerUsername)).returning();
    const [updatedTarget] = await db.update(paintwarsStats).set({
      totalCleansReceived: target.totalCleansReceived + 1,
      updatedAt: new Date(),
    }).where(eq(paintwarsStats.username, targetUsername)).returning();
    return { cleaner: updatedCleaner, target: updatedTarget };
  }
  async resetDailyPaintwarsAllowances(paintsPerDay: number, cleansPerDay: number): Promise<number> {
    const updated = await db.update(paintwarsStats).set({ paintsRemaining: paintsPerDay, cleansRemaining: cleansPerDay, updatedAt: new Date() }).returning();
    return updated.length;
  }
  async getPaintwarsLeaderboard(limit: number): Promise<PaintwarsStatsType[]> {
    return db.select().from(paintwarsStats).orderBy(desc(paintwarsStats.totalPaintWarsPoints)).limit(limit);
  }

  // ── SMS Engine ─────────────────────────────────────────────────────────────────
  async createSmsMessage(data: InsertSmsMessage): Promise<SmsMessage> {
    const [sms] = await db.insert(smsMessages).values(data).returning();
    return sms;
  }
  async getSmsMessageById(id: number): Promise<SmsMessage | undefined> {
    const [sms] = await db.select().from(smsMessages).where(eq(smsMessages.id, id));
    return sms;
  }
  async getSmsHistory(phoneNumber?: string, username?: string, limit = 20): Promise<SmsMessage[]> {
    let cond: any = undefined;
    if (phoneNumber) cond = eq(smsMessages.phoneNumber, phoneNumber);
    if (username) cond = cond ? and(cond, eq(smsMessages.username, username)) : eq(smsMessages.username, username);
    const query = db.select().from(smsMessages).orderBy(desc(smsMessages.createdAt)).limit(limit);
    return cond ? query.where(cond) : query;
  }
  async updateSmsStatus(id: number, status: number): Promise<SmsMessage | undefined> {
    const [updated] = await db.update(smsMessages).set({ status }).where(eq(smsMessages.id, id)).returning();
    return updated;
  }
  async retryPendingSmsMessages(): Promise<number> {
    const updated = await db.update(smsMessages).set({ status: 1 }).where(eq(smsMessages.status, 3)).returning();
    return updated.length;
  }
  async getPendingSmsMessages(limit: number): Promise<SmsMessage[]> {
    return db.select().from(smsMessages).where(eq(smsMessages.status, 1)).limit(limit);
  }

  // ── Voice Engine ──────────────────────────────────────────────────────────────
  async createVoiceCall(data: InsertVoiceCall): Promise<VoiceCall> {
    const [call] = await db.insert(voiceCalls).values({ id: randomUUID(), ...data }).returning();
    return call;
  }
  async getVoiceCallById(id: string): Promise<VoiceCall | undefined> {
    const [call] = await db.select().from(voiceCalls).where(eq(voiceCalls.id, id));
    return call;
  }
  async updateVoiceCallStatus(id: string, status: number, duration?: number, endedAt?: Date): Promise<VoiceCall | undefined> {
    const updates: any = { status };
    if (duration !== undefined) updates.duration = duration;
    if (endedAt !== undefined) updates.endedAt = endedAt;
    const [updated] = await db.update(voiceCalls).set(updates).where(eq(voiceCalls.id, id)).returning();
    return updated;
  }
  async getVoiceCallHistory(username: string, limit: number, type: "caller" | "callee" | "all"): Promise<VoiceCall[]> {
    let cond: any;
    if (type === "caller") cond = eq(voiceCalls.callerUsername, username);
    else if (type === "callee") cond = eq(voiceCalls.calleeUsername, username);
    else cond = or(eq(voiceCalls.callerUsername, username), eq(voiceCalls.calleeUsername, username));
    return db.select().from(voiceCalls).where(cond).orderBy(desc(voiceCalls.createdAt)).limit(limit);
  }

  // ── Image Server ───────────────────────────────────────────────────────────────
  async storeImage(data: InsertServerImage): Promise<ServerImage> {
    const [image] = await db.insert(serverImages).values({ id: randomUUID(), ...data }).returning();
    return image;
  }
  async getImageById(id: string): Promise<ServerImage | undefined> {
    const [image] = await db.select().from(serverImages).where(eq(serverImages.id, id));
    return image;
  }
  async getImageByKey(imageKey: string): Promise<ServerImage | undefined> {
    const [image] = await db.select().from(serverImages).where(eq(serverImages.imageKey, imageKey));
    return image;
  }
  async deleteImage(id: string): Promise<boolean> {
    const deleted = await db.delete(serverImages).where(eq(serverImages.id, id)).returning();
    return deleted.length > 0;
  }
  async getImagesByUsername(username: string, limit: number): Promise<ServerImage[]> {
    return db.select().from(serverImages).where(eq(serverImages.username, username)).orderBy(desc(serverImages.createdAt)).limit(limit);
  }
  async getImageServerStats(): Promise<{ totalImages: number; totalSizeBytes: number }> {
    const result = await db.select({ count: sql<number>`count(*)`, totalSize: sql<number>`coalesce(sum(size_bytes), 0)` }).from(serverImages);
    return { totalImages: result[0]?.count ?? 0, totalSizeBytes: result[0]?.totalSize ?? 0 };
  }

  // ── Notifications / UNS ────────────────────────────────────────────────────────
  async createNotification(data: InsertNotification): Promise<Notification> {
    const [n] = await db.insert(notifications).values({ id: randomUUID(), ...data }).returning();
    return n;
  }
  async getNotifications(username: string, limit: number, type?: string, status?: number): Promise<Notification[]> {
    let cond = eq(notifications.username, username) as any;
    if (type) cond = and(cond, eq(notifications.type, type));
    if (status !== undefined) cond = and(cond, eq(notifications.status, status));
    return db.select().from(notifications).where(cond).orderBy(desc(notifications.createdAt)).limit(limit);
  }
  async updateNotificationStatus(id: string, status: number): Promise<Notification | undefined> {
    const [updated] = await db.update(notifications).set({ status }).where(eq(notifications.id, id)).returning();
    return updated;
  }
  async getPendingNotifications(limit: number): Promise<Notification[]> {
    return db.select().from(notifications).where(eq(notifications.status, 1)).limit(limit);
  }
  async getGroupMembersForEmailNotification(groupId: number): Promise<string[]> {
    const rows = await db.select({ username: groupMembers.username })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, 1), gt(groupMembers.emailNotification, 0)));
    return rows.map(r => r.username);
  }
  async getGroupMembersForSMSNotification(groupId: number): Promise<{ username: string; mobileNumber: string }[]> {
    const rows = await db.select({ username: groupMembers.username })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, 1), gt(groupMembers.smsNotification, 0)));
    const result: { username: string; mobileNumber: string }[] = [];
    for (const r of rows) {
      const phone = await this.getMobileNumberForUser(r.username);
      if (phone) result.push({ username: r.username, mobileNumber: phone });
    }
    return result;
  }
  async getGroupMembersForGroupEventSMSNotification(groupId: number): Promise<{ username: string; mobileNumber: string }[]> {
    const rows = await db.select({ username: groupMembers.username })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, 1), gt(groupMembers.eventNotification, 0)));
    const result: { username: string; mobileNumber: string }[] = [];
    for (const r of rows) {
      const phone = await this.getMobileNumberForUser(r.username);
      if (phone) result.push({ username: r.username, mobileNumber: phone });
    }
    return result;
  }
  async getGroupMembersForGroupEventAlertNotification(groupId: number): Promise<string[]> {
    const rows = await db.select({ username: groupMembers.username })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, 1), gt(groupMembers.eventNotification, 0)));
    return rows.map(r => r.username);
  }
  async getGroupPostSubscribersForEmail(_userPostId: number): Promise<string[]> {
    return [];
  }
  async getMobileNumberForUser(username: string): Promise<string | null> {
    const rows = await db.select({ mobilePhone: contacts.mobilePhone })
      .from(contacts)
      .where(and(eq(contacts.fusionUsername, username)))
      .limit(1);
    return rows[0]?.mobilePhone ?? null;
  }
  async getNotificationCountByType(username: string): Promise<Record<string, number>> {
    const rows = await db.select().from(notifications).where(and(eq(notifications.username, username), eq(notifications.status, 1)));
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
    return counts;
  }
  async deleteAllNotificationsByType(username: string, notfnType: string): Promise<Notification[]> {
    return db.delete(notifications).where(and(eq(notifications.username, username), eq(notifications.type, notfnType))).returning();
  }
  async deleteNotificationsByIds(ids: string[]): Promise<Notification[]> {
    if (ids.length === 0) return [];
    const deleted: Notification[] = [];
    for (const id of ids) {
      const rows = await db.delete(notifications).where(eq(notifications.id, id)).returning();
      deleted.push(...rows);
    }
    return deleted;
  }
  async purgeOldNotifications(username: string, maxCount: number, truncateTo: number): Promise<number> {
    const all = await db.select().from(notifications).where(eq(notifications.username, username)).orderBy(asc(notifications.createdAt));
    if (all.length <= maxCount) return 0;
    const toDelete = all.slice(0, all.length - truncateTo);
    let deleted = 0;
    for (const n of toDelete) {
      await db.delete(notifications).where(eq(notifications.id, n.id));
      deleted++;
    }
    return deleted;
  }

  // ── Message Switchboard ────────────────────────────────────────────────────────
  async createSwitchboardMessage(data: InsertSwitchboardMessage): Promise<SwitchboardMessage> {
    const [msg] = await db.insert(switchboardMessages).values({ id: randomUUID(), ...data }).returning();
    return msg;
  }
  async getPendingSwitchboardMessages(username: string, limit: number, messageType?: string): Promise<SwitchboardMessage[]> {
    let cond = and(eq(switchboardMessages.toUsername, username), eq(switchboardMessages.status, 1)) as any;
    if (messageType) cond = and(cond, eq(switchboardMessages.messageType, messageType));
    return db.select().from(switchboardMessages).where(cond).orderBy(asc(switchboardMessages.createdAt)).limit(limit);
  }
  async updateSwitchboardMessageStatus(id: string, status: number): Promise<SwitchboardMessage | undefined> {
    const [updated] = await db.update(switchboardMessages).set({ status }).where(eq(switchboardMessages.id, id)).returning();
    return updated;
  }
  async clearDeliveredSwitchboardMessages(username: string): Promise<number> {
    const deleted = await db.delete(switchboardMessages).where(and(eq(switchboardMessages.toUsername, username), eq(switchboardMessages.status, 2))).returning();
    return deleted.length;
  }
  async getSwitchboardStats(): Promise<{ queued: number; delivered: number; failed: number }> {
    const all = await db.select().from(switchboardMessages);
    return {
      queued: all.filter(m => m.status === 1).length,
      delivered: all.filter(m => m.status === 2).length,
      failed: all.filter(m => m.status === 3).length,
    };
  }
  async flushSwitchboardMessages(): Promise<number> {
    const deleted = await db.delete(switchboardMessages).where(eq(switchboardMessages.status, 1)).returning();
    return deleted.length;
  }

  // ── Privacy Settings ──────────────────────────────────────────────────────
  // Mirrors: SettingsProfileDetailsData + SettingsAccountCommunicationData + EventPrivacySetting
  async getUserPrivacySettings(username: string): Promise<UserPrivacySettings> {
    const [existing] = await db.select().from(userPrivacySettings).where(eq(userPrivacySettings.username, username));
    if (existing) return existing;
    // Auto-create with defaults (mirrors Java PRIVACY_DEFAULT_* constants)
    const [created] = await db.insert(userPrivacySettings).values({ username }).returning();
    return created;
  }

  async updateUserPrivacySettings(username: string, updates: Partial<Omit<UserPrivacySettings, 'id' | 'username' | 'updatedAt'>>): Promise<UserPrivacySettings> {
    const existing = await this.getUserPrivacySettings(username);
    const [updated] = await db.update(userPrivacySettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(userPrivacySettings.username, username))
      .returning();
    return updated ?? existing;
  }

  // ── User Settings (mirrors UserSettingData / SettingsResource.java) ─────────
  async getUserSettings(username: string): Promise<UserSetting[]> {
    return db.select().from(userSettings).where(eq(userSettings.username, username));
  }

  async getUserSetting(username: string, type: number): Promise<UserSetting | undefined> {
    const [row] = await db.select().from(userSettings)
      .where(and(eq(userSettings.username, username), eq(userSettings.type, type)));
    return row;
  }

  async upsertUserSetting(username: string, type: number, value: number): Promise<UserSetting> {
    const [row] = await db.insert(userSettings)
      .values({ username, type, value })
      .onConflictDoUpdate({
        target: [userSettings.username, userSettings.type],
        set: { value },
      })
      .returning();
    return row;
  }

  // ── Diamond Balance ────────────────────────────────────────────────────────

  async getDiamondBalance(username: string): Promise<number> {
    const result = await db.execute(
      sql`SELECT diamond_balance FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`
    );
    if (result.rows.length === 0) return 0;
    return Number(result.rows[0].diamond_balance ?? 0);
  }

  // Total yang pernah diterima dari gift (source of truth = diamond_transactions).
  // Angka ini TIDAK berkurang saat withdraw — sama persis dengan yang ditampilkan
  // di Agency Dashboard, Admin Panel, dan Leaderboard (ALL_TIME).
  async getDiamondTotalEarned(username: string): Promise<number> {
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS total_earned
      FROM diamond_transactions
      WHERE LOWER(username) = LOWER(${username})
        AND type = 'GIFT_RECEIVED'
    `);
    return Number(result.rows[0]?.total_earned ?? 0);
  }

  // Total yang sudah dicairkan/withdraw (dari transaksi nyata).
  // Withdraw amount tercatat sebagai negatif, jadi kita ambil ABS.
  async getDiamondTotalWithdrawn(username: string): Promise<number> {
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(ABS(amount)), 0) AS total_withdrawn
      FROM diamond_transactions
      WHERE LOWER(username) = LOWER(${username})
        AND type = 'WITHDRAW_REQUEST'
    `);
    return Number(result.rows[0]?.total_withdrawn ?? 0);
  }

  async adjustDiamondBalance(
    username: string,
    amount: number,
    type: string,
    description: string,
    reference?: string,
  ): Promise<number> {
    const amountInt = Math.floor(amount);
    if (amountInt === 0) return await this.getDiamondBalance(username);

    const result = await db.execute(sql`
      UPDATE users
      SET diamond_balance = GREATEST(0, diamond_balance + ${amountInt})
      WHERE LOWER(username) = LOWER(${username})
      RETURNING diamond_balance
    `);
    const newBalance = Number(result.rows[0]?.diamond_balance ?? 0);

    await db.execute(sql`
      INSERT INTO diamond_transactions (username, amount, type, reference, description, running_balance)
      VALUES (${username}, ${amountInt}, ${type}, ${reference ?? null}, ${description}, ${newBalance})
    `).catch((err) => console.error('[db-storage] diamond tx insert error:', err));

    return newBalance;
  }

  async getDiamondTransactions(
    username: string,
    limit = 50,
    offset = 0,
  ): Promise<{ id: string; amount: number; type: string; reference: string | null; description: string | null; runningBalance: number; createdAt: Date }[]> {
    const rows = await db.execute(sql`
      SELECT id, amount, type, reference, description, running_balance, created_at
      FROM diamond_transactions
      WHERE LOWER(username) = LOWER(${username})
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows.map((r: any) => ({
      id: r.id,
      amount: Number(r.amount),
      type: r.type,
      reference: r.reference ?? null,
      description: r.description ?? null,
      runningBalance: Number(r.running_balance),
      createdAt: new Date(r.created_at),
    }));
  }
}

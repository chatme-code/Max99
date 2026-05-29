import { sql } from "drizzle-orm";
import { boolean, doublePrecision, integer, pgTable, text, timestamp, varchar, jsonb, serial, smallint, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── AUTH ─────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  verifyToken: text("verify_token"),
  verifyTokenExpiry: timestamp("verify_token_expiry"),
  resetToken: text("reset_token"),
  resetTokenExpiry: timestamp("reset_token_expiry"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  isAdmin: boolean("is_admin").notNull().default(false),
  isSuspended: boolean("is_suspended").notNull().default(false),
  googleSub: text("google_sub").unique(),
  usernameChangedAt: timestamp("username_changed_at"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  displayName: true,
  email: true,
  password: true,
}).extend({
  username: z.string()
    .min(6, "Username minimal 6 karakter")
    .max(18, "Username maksimal 18 karakter")
    .regex(/^[a-z]/, "Username harus diawali dengan huruf kecil")
    .regex(/^[a-z][a-z0-9_]*$/, "Username harus huruf kecil semua (tidak boleh ada huruf besar). Hanya boleh huruf kecil, angka, dan underscore"),
});

export const loginSchema = z.object({
  username: z.string().min(1, "Username wajib diisi"),
  password: z.string().min(1, "Password wajib diisi"),
});

// ─── PROFILE ──────────────────────────────────────────────────────────────────
export const userProfiles = pgTable("user_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  gender: text("gender"),
  dateOfBirth: text("date_of_birth"),
  country: text("country"),
  city: text("city"),
  aboutMe: text("about_me"),
  likes: text("likes"),
  dislikes: text("dislikes"),
  relationshipStatus: integer("relationship_status").default(1),
  profileStatus: integer("profile_status").notNull().default(1),
  anonymousViewing: boolean("anonymous_viewing").notNull().default(false),
  displayPicture: text("display_picture"),
  migLevel: integer("mig_level").notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertUserProfileSchema = createInsertSchema(userProfiles).omit({ id: true, updatedAt: true });

export const PROFILE_STATUS = { PUBLIC: 1, CONTACTS_ONLY: 2, PRIVATE: 3 } as const;
export const RELATIONSHIP_STATUS = {
  SINGLE: 1, IN_A_RELATIONSHIP: 2, DOMESTIC_PARTNER: 3, MARRIED: 4, COMPLICATED: 5,
} as const;

// ─── HOME FEED (WALL POSTS) ────────────────────────────────────────────────────
export const wallPosts = pgTable("wall_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  authorUserId: varchar("author_user_id").notNull(),
  authorUsername: text("author_username").notNull(),
  comment: text("comment").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  mediaType: text("media_type").notNull().default("text"),
  type: integer("type").notNull().default(1),
  status: integer("status").notNull().default(1),
  numComments: integer("num_comments").notNull().default(0),
  numLikes: integer("num_likes").notNull().default(0),
  numDislikes: integer("num_dislikes").notNull().default(0),
  repostId: varchar("repost_id"),
  repostAuthorUsername: text("repost_author_username"),
  repostComment: text("repost_comment"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertWallPostSchema = createInsertSchema(wallPosts).pick({
  userId: true,
  comment: true,
  type: true,
});

export const WALL_POST_TYPE = { NORMAL: 1, STATUS_UPDATE: 2, REPOST: 3 } as const;
export const WALL_POST_STATUS = { ACTIVE: 1, REMOVED: 0 } as const;

// ─── POST COMMENTS ────────────────────────────────────────────────────────────
export const postComments = pgTable("post_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: varchar("post_id").notNull().references(() => wallPosts.id, { onDelete: "cascade" }),
  authorUserId: varchar("author_user_id").notNull(),
  authorUsername: text("author_username").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export type PostCommentRow    = typeof postComments.$inferSelect;
export type InsertPostComment = typeof postComments.$inferInsert;

// ─── CHATROOM ─────────────────────────────────────────────────────────────────
export const chatrooms = pgTable("chatrooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  description: text("description"),
  categoryId: integer("category_id").notNull(),
  currentParticipants: integer("current_participants").notNull().default(0),
  maxParticipants: integer("max_participants").notNull().default(25),
  color: text("color").notNull().default("#4CAF50"),
  language: text("language").notNull().default("id"),
  allowKick: boolean("allow_kick").notNull().default(true),
  isLocked: boolean("is_locked").notNull().default(false),
  adultOnly: boolean("adult_only").notNull().default(false),
  userOwned: boolean("user_owned").notNull().default(false),
  type: integer("type").notNull().default(1),
  status: integer("status").notNull().default(1),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertChatroomSchema = createInsertSchema(chatrooms).pick({
  name: true,
  description: true,
  categoryId: true,
  maxParticipants: true,
  language: true,
  allowKick: true,
  adultOnly: true,
});

// ─── CHATROOM FAVOURITES ───────────────────────────────────────────────────────
export const chatroomFavourites = pgTable("chatroom_favourites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  chatroomId: varchar("chatroom_id").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const chatroomMessages = pgTable("chatroom_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  chatroomId: varchar("chatroom_id").notNull(),
  senderId: varchar("sender_id"),
  senderUsername: text("sender_username").notNull(),
  senderColor: text("sender_color").notNull().default("#4CAF50"),
  text: text("text").notNull(),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertMessageSchema = createInsertSchema(chatroomMessages).pick({ text: true });

// ─── ROOM (user-owned rooms) ───────────────────────────────────────────────────
export const rooms = pgTable("rooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id").notNull(),
  ownerUsername: text("owner_username").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  theme: text("theme").default("default"),
  maxParticipants: integer("max_participants").notNull().default(20),
  status: integer("status").notNull().default(1),
  isLocked: boolean("is_locked").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertRoomSchema = createInsertSchema(rooms).pick({
  name: true,
  description: true,
  theme: true,
  maxParticipants: true,
  isLocked: true,
});

// ─── LOST CONTACTS ────────────────────────────────────────────────────────────
export const lostContacts = pgTable("lost_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  lostUsername: text("lost_username").notNull(),
  note: text("note"),
  status: integer("status").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertLostContactSchema = createInsertSchema(lostContacts).pick({
  lostUsername: true,
  note: true,
});

// ─── MERCHANT ─────────────────────────────────────────────────────────────────
// merchantType mirrors merchant hierarchy: MERCHANT=1, MENTOR=2, HEAD_MENTOR=3
// usernameColorType mirrors MerchantDetailsData.UserNameColorTypeEnum: DEFAULT=0, RED=1, PINK=2
export const merchants = pgTable("merchants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  category: text("category"),
  logoUrl: text("logo_url"),
  websiteUrl: text("website_url"),
  status: integer("status").notNull().default(1),
  usernameColor: text("username_color").default("#990099"),
  usernameColorType: integer("username_color_type").notNull().default(0),
  merchantType: integer("merchant_type").notNull().default(1),
  mentor: text("mentor"),
  referrer: text("referrer"),
  totalPoints: integer("total_points").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertMerchantSchema = createInsertSchema(merchants).pick({
  username: true,
  displayName: true,
  description: true,
  category: true,
  logoUrl: true,
  websiteUrl: true,
  usernameColor: true,
  usernameColorType: true,
  merchantType: true,
  mentor: true,
  referrer: true,
});

// Mirrors merchant hierarchy
export const MERCHANT_TYPE = { MERCHANT: 1, MENTOR: 2, HEAD_MENTOR: 3 } as const;

// Mirrors MerchantDetailsData.UserNameColorTypeEnum
export const MERCHANT_USERNAME_COLOR_TYPE = {
  DEFAULT: 0,
  RED: 1,
  PINK: 2,
} as const;

export const merchantLocations = pgTable("merchant_locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  merchantUsername: text("merchant_username").notNull(),
  locationId: integer("location_id"),
  name: text("name").notNull(),
  address: text("address"),
  phoneNumber: text("phone_number"),
  emailAddress: text("email_address"),
  notes: text("notes"),
  countryId: integer("country_id"),
  country: text("country"),
  status: integer("status").notNull().default(1),
  userData: jsonb("user_data"),
});

export const insertMerchantLocationSchema = createInsertSchema(merchantLocations).pick({
  merchantUsername: true,
  name: true,
  address: true,
  phoneNumber: true,
  emailAddress: true,
  notes: true,
  countryId: true,
  country: true,
});

// Mirrors MerchantPointsLogData.EntryTypeEnum
export const MERCHANT_POINTS_ENTRY_TYPE = {
  MANUAL_ADJUSTMENT: 1,
  MECHANIC_REWARD: 2,
} as const;

export const merchantPoints = pgTable("merchant_points", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  merchantUsername: text("merchant_username").notNull(),
  userId: varchar("user_id").notNull(),
  points: integer("points").notNull().default(0),
  type: integer("type").notNull().default(1),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

// ─── MERCHANT TAG ─────────────────────────────────────────────────────────────
// type mirrors MerchantTagData.TypeEnum: TOP_MERCHANT_TAG=1, NON_TOP_MERCHANT_TAG=2
// status mirrors MerchantTagData.StatusEnum: INACTIVE=0, ACTIVE=1, PENDING=2
// validity default = 43200 seconds = 12 hours (from SystemProperty TopMerchantTagValidPeriod)
export const merchantTags = pgTable("merchant_tags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  merchantUsername: text("merchant_username").notNull(),
  taggedUsername: text("tagged_username").notNull(),
  type: integer("type").notNull().default(2),
  expiry: timestamp("expiry"),
  status: integer("status").notNull().default(1),
  amount: doublePrecision("amount"),
  currency: text("currency"),
  accountEntryId: varchar("account_entry_id"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertMerchantTagSchema = createInsertSchema(merchantTags).pick({
  merchantUsername: true,
  taggedUsername: true,
  type: true,
  amount: true,
  currency: true,
  accountEntryId: true,
});

export const MERCHANT_TAG_TYPE = { TOP: 1, NON_TOP: 2 } as const;
export const MERCHANT_TAG_STATUS = { INACTIVE: 0, ACTIVE: 1, PENDING: 2 } as const;
// Default tag validity in seconds (matches Java SystemProperty TopMerchantTagValidPeriod = 43200 = 12h)
export const MERCHANT_TAG_VALIDITY_SECONDS = 43200;

// ─── CREDIT SYSTEM ────────────────────────────────────────────────────────────

// Account balance per user (one row per username)
export const creditAccounts = pgTable("credit_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  currency: text("currency").notNull().default("IDR"),
  balance: doublePrecision("balance").notNull().default(0),
  fundedBalance: doublePrecision("funded_balance").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertCreditAccountSchema = createInsertSchema(creditAccounts).omit({ id: true, updatedAt: true });

// Transaction log (AccountEntryData equivalent)
export const creditTransactions = pgTable("credit_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  type: integer("type").notNull(),
  reference: text("reference"),
  description: text("description"),
  currency: text("currency").notNull().default("IDR"),
  amount: doublePrecision("amount").notNull(),
  fundedAmount: doublePrecision("funded_amount").notNull().default(0),
  tax: doublePrecision("tax").notNull().default(0),
  runningBalance: doublePrecision("running_balance").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertCreditTransactionSchema = createInsertSchema(creditTransactions).omit({ id: true, createdAt: true });

// Transaction types (from AccountEntryData.TypeEnum)
export const CREDIT_TRANSACTION_TYPE = {
  CREDIT_CARD: 1,
  VOUCHER_RECHARGE: 2,
  SMS_CHARGE: 3,
  CALL_CHARGE: 4,
  SUBSCRIPTION: 5,
  PRODUCT_PURCHASE: 6,
  REFERRAL_CREDIT: 7,
  ACTIVATION_CREDIT: 8,
  BONUS_CREDIT: 9,
  REFUND: 10,
  PREMIUM_SMS_RECHARGE: 11,
  CREDIT_CARD_REFUND: 13,
  USER_TO_USER_TRANSFER: 14,
  TELEGRAPHIC_TRANSFER: 15,
  CREDIT_CARD_CHARGEBACK: 16,
  VOUCHERS_CREATED: 17,
  VOUCHERS_CANCELLED: 18,
  CURRENCY_CONVERSION: 19,
  BANK_TRANSFER: 21,
  CHATROOM_KICK_CHARGE: 23,
  CREDIT_EXPIRED: 24,
  EMOTICON_PURCHASE: 27,
  CONTENT_ITEM_PURCHASE: 28,
  AVATAR_PURCHASE: 32,
  GAME_BET: 33,
  GAME_REWARD: 34,
  GAME_REFUND: 36,
  MARKETING_REWARD: 35,
  VIRTUAL_GIFT_PURCHASE: 41,
  FRAME_PURCHASE: 42,
  TRANSFER_CREDIT_FEE: 58,
  CREDIT_WRITE_OFF: 52,
} as const;

// Voucher batches (VoucherBatchData)
export const voucherBatches = pgTable("voucher_batches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  createdByUsername: text("created_by_username").notNull(),
  currency: text("currency").notNull().default("IDR"),
  amount: doublePrecision("amount").notNull(),
  numVoucher: integer("num_voucher").notNull().default(1),
  notes: text("notes"),
  expiryDate: timestamp("expiry_date"),
  numActive: integer("num_active").notNull().default(0),
  numCancelled: integer("num_cancelled").notNull().default(0),
  numRedeemed: integer("num_redeemed").notNull().default(0),
  numExpired: integer("num_expired").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertVoucherBatchSchema = createInsertSchema(voucherBatches).pick({
  currency: true,
  amount: true,
  numVoucher: true,
  notes: true,
  expiryDate: true,
});

// Individual vouchers (VoucherData)
export const vouchers = pgTable("vouchers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  voucherBatchId: varchar("voucher_batch_id").notNull(),
  code: text("code").notNull().unique(),
  currency: text("currency").notNull().default("IDR"),
  amount: doublePrecision("amount").notNull(),
  status: integer("status").notNull().default(1),
  redeemedByUsername: text("redeemed_by_username"),
  notes: text("notes"),
  expiryDate: timestamp("expiry_date"),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

// Voucher status (VoucherData.StatusEnum)
export const VOUCHER_STATUS = {
  INACTIVE: 0,
  ACTIVE: 1,
  CANCELLED: 2,
  REDEEMED: 3,
  EXPIRED: 4,
  FAILED: 5,
} as const;

// Reward programs (RewardProgramData)
export const rewardPrograms = pgTable("reward_programs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  type: integer("type").notNull().default(1),
  category: integer("category").notNull().default(1),
  countryId: integer("country_id"),
  minMigLevel: integer("min_mig_level").notNull().default(1),
  maxMigLevel: integer("max_mig_level"),
  quantityRequired: integer("quantity_required"),
  amountRequired: doublePrecision("amount_required"),
  amountRequiredCurrency: text("amount_required_currency"),
  migCreditReward: doublePrecision("mig_credit_reward"),
  migCreditRewardCurrency: text("mig_credit_reward_currency").default("IDR"),
  scoreReward: integer("score_reward"),
  levelReward: integer("level_reward"),
  status: integer("status").notNull().default(1),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertRewardProgramSchema = createInsertSchema(rewardPrograms).omit({ id: true, createdAt: true });

export const REWARD_PROGRAM_TYPE = {
  QUANTITY_BASED: 1,
  AMOUNT_BASED: 2,
  ONE_TIME: 3,
} as const;

export const REWARD_PROGRAM_CATEGORY = {
  REFERRAL: 1,
  ACTIVITY: 2,
  PURCHASE: 3,
  ENGAGEMENT: 4,
  FIRST_TIME: 5,
} as const;

// User reward history
export const userRewardHistory = pgTable("user_reward_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  programId: varchar("program_id"),
  programName: text("program_name"),
  rewardType: text("reward_type").notNull(),
  migCreditAmount: doublePrecision("mig_credit_amount"),
  migCreditCurrency: text("mig_credit_currency"),
  scoreAmount: integer("score_amount"),
  levelAmount: integer("level_amount"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

// ─── CHATSYNC (Private & Group Chat Inbox) ────────────────────────────────────
export const conversations = pgTable("conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull().default("private"),
  name: text("name"),
  avatarColor: text("avatar_color").notNull().default("#4CAF50"),
  createdBy: varchar("created_by").notNull(),
  groupOwner: text("group_owner"),
  isClosed: boolean("is_closed").notNull().default(false),
  isPassivated: boolean("is_passivated").notNull().default(false),
  lastMessageText: text("last_message_text"),
  lastMessageType: text("last_message_type").notNull().default("text"),
  lastMessageAt: timestamp("last_message_at"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const conversationParticipants = pgTable("conversation_participants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  userId: varchar("user_id").notNull(),
  username: text("username").notNull(),
  displayName: text("display_name"),
  unreadCount: integer("unread_count").notNull().default(0),
  joinedAt: timestamp("joined_at").notNull().default(sql`now()`),
});

export const conversationMessages = pgTable("conversation_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  senderId: varchar("sender_id"),
  senderUsername: text("sender_username").notNull(),
  text: text("text").notNull(),
  type: text("type").notNull().default("text"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  // Mirrors FusionPktMessageStatusEvent (pkt 505) READ status — set when recipient reads the msg
  readAt: timestamp("read_at"),
  readBy: text("read_by"),   // username who read it (for private chats — single recipient)
});

// Per-user chat list version counter — mirrors fusion ChatListVersion (CurrentChatList)
// Increments each time a conversation is added/removed from the user's list.
export const userChatListVersions = pgTable("user_chat_list_versions", {
  userId: varchar("user_id").primaryKey(),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const CONVERSATION_TYPE = { PRIVATE: "private", GROUP: "group" } as const;

// Mirrors fusion ContentTypeEnum: TEXT=1, IMAGE=2, EMOTE/STICKER=6
export const MESSAGE_TYPE = {
  TEXT: "text",
  IMAGE: "image",
  STICKER: "sticker",
  SYSTEM: "system",
} as const;

export type Conversation = typeof conversations.$inferSelect;
export type ConversationParticipant = typeof conversationParticipants.$inferSelect;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type UserChatListVersion = typeof userChatListVersions.$inferSelect;

// ─── DISCOVERY ────────────────────────────────────────────────────────────────
export const userRecommendations = pgTable("user_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  recommendedUserId: varchar("recommended_user_id").notNull(),
  score: integer("score").notNull().default(0),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
export const CHATROOM_CATEGORIES = [
  { id: 1,  label: "Favorites",         icon: "/icons/icon_favourite.png",    key: "FAVORITES",     showInBrowser: false },
  { id: 2,  label: "Recent",            icon: "/icons/icon_recent.png",       key: "RECENT",        showInBrowser: false },
  { id: 8,  label: "Recommended",       icon: "/icons/icon_recommended.png",  key: "RECOMMENDED",   showInBrowser: true  },
  { id: 7,  label: "Games",             icon: "/icons/icon_games.png",        key: "GAMES",         showInBrowser: true  },
  { id: 4,  label: "Find Friends",      icon: "/icons/icon_friend_finder.png",key: "FRIEND_FINDER", showInBrowser: true  },
  { id: 5,  label: "Game Zone",         icon: "/icons/icon_games.png",        key: "GAME_ZONE",     showInBrowser: true  },
  { id: 6,  label: "Help",              icon: "/icons/icon_recommended.png",  key: "HELP",          showInBrowser: true  },
] as const;

export const CHATROOM_COLORS = ["#4CAF50", "#9C27B0", "#F44336", "#795548", "#FF9800"];

// ─── CONTACT / FRIENDS ────────────────────────────────────────────────────────
// Maps to old migme: contactgroup
export const contactGroups = pgTable("contact_groups", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  name: text("name").notNull().default(""),
});

export const insertContactGroupSchema = createInsertSchema(contactGroups).pick({ username: true, name: true });

// Maps to old migme: contact
export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull().default(""),
  firstName: text("first_name"),
  lastName: text("last_name"),
  fusionUsername: text("fusion_username"),
  emailAddress: text("email_address"),
  mobilePhone: text("mobile_phone"),
  contactGroupId: integer("contact_group_id"),
  shareMobilePhone: integer("share_mobile_phone"),
  displayOnPhone: integer("display_on_phone").notNull().default(0),
  status: integer("status").notNull().default(0),
});

export const insertContactSchema = createInsertSchema(contacts).pick({
  username: true, displayName: true, firstName: true, lastName: true,
  fusionUsername: true, emailAddress: true, mobilePhone: true,
  contactGroupId: true, displayOnPhone: true,
});

// ─── FRIEND REQUESTS ──────────────────────────────────────────────────────────
// Mirrors FusionPktContactRequest / FusionPktAcceptContactRequest / FusionPktRejectContactRequest
// Java backend: Contact EJB, contactEJB.addFusionUserAsContact() on accept
export const contactRequests = pgTable("contact_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUserId: varchar("from_user_id").notNull(),
  fromUsername: text("from_username").notNull(),
  fromDisplayName: text("from_display_name"),
  toUserId: varchar("to_user_id").notNull(),
  toUsername: text("to_username").notNull(),
  // status: pending → accepted → creates friendship; pending → rejected
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertContactRequestSchema = createInsertSchema(contactRequests).omit({ id: true, createdAt: true });
export type ContactRequest = typeof contactRequests.$inferSelect;
export type InsertContactRequest = z.infer<typeof insertContactRequestSchema>;

// ─── FRIENDSHIPS ──────────────────────────────────────────────────────────────
// Bidirectional — Java: contactEJB.addFusionUserAsContact() creates two records
// Both (A→B) and (B→A) stored so each user can query their own friends list easily
export const friendships = pgTable("friendships", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  friendUserId: varchar("friend_user_id").notNull(),
  friendUsername: text("friend_username").notNull(),
  friendDisplayName: text("friend_display_name"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertFriendshipSchema = createInsertSchema(friendships).omit({ id: true, createdAt: true });
export type Friendship = typeof friendships.$inferSelect;
export type InsertFriendship = z.infer<typeof insertFriendshipSchema>;

// ─── BLOCK LIST ───────────────────────────────────────────────────────────────
// Maps to old migme: blocklist
export const blockList = pgTable("block_list", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  blockUsername: text("block_username").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertBlockListSchema = createInsertSchema(blockList).pick({ username: true, blockUsername: true });

// ─── EMOTICONS ────────────────────────────────────────────────────────────────
// Maps to old migme: emoticonpack
export const emoticonPacks = pgTable("emoticon_packs", {
  id: serial("id").primaryKey(),
  type: integer("type").notNull().default(0),
  name: text("name").notNull().default(""),
  description: text("description"),
  price: doublePrecision("price").notNull().default(0),
  sortOrder: integer("sort_order"),
  forSale: integer("for_sale").notNull().default(1),
  status: integer("status").notNull().default(0),
  version: integer("version").notNull().default(1),
  groupId: integer("group_id"),
});

export const insertEmoticonPackSchema = createInsertSchema(emoticonPacks).omit({ id: true });

// Maps to old migme: emoticon
export const emoticons = pgTable("emoticons", {
  id: serial("id").primaryKey(),
  emoticonPackId: integer("emoticon_pack_id").notNull(),
  type: integer("type").notNull(),
  alias: text("alias").notNull().default(""),
  width: integer("width").notNull().default(0),
  height: integer("height").notNull().default(0),
  location: text("location").notNull().default(""),
  locationPng: text("location_png").notNull().default(""),
});

export const insertEmoticonSchema = createInsertSchema(emoticons).omit({ id: true });

// ─── VIRTUAL GIFTS ────────────────────────────────────────────────────────────
// Maps to old migme: virtualgift
export const virtualGifts = pgTable("virtual_gifts", {
  id: serial("id").primaryKey(),
  name: text("name"),
  hotKey: text("hot_key"),
  price: doublePrecision("price").notNull().default(0),
  currency: text("currency").notNull().default("IDR"),
  numAvailable: integer("num_available"),
  numSold: integer("num_sold").notNull().default(0),
  sortOrder: integer("sort_order"),
  groupId: integer("group_id"),
  groupVipOnly: boolean("group_vip_only").default(false),
  location64x64Png: text("location_64x64_png"),
  location16x16Png: text("location_16x16_png"),
  giftAllMessage: text("gift_all_message"),
  status: integer("status").notNull().default(1),
});

export const insertVirtualGiftSchema = createInsertSchema(virtualGifts).omit({ id: true });

// Maps to old migme: virtualgiftreceived
export const virtualGiftsReceived = pgTable("virtual_gifts_received", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  sender: text("sender").notNull(),
  virtualGiftId: integer("virtual_gift_id").notNull(),
  message: text("message"),
  purchaseLocation: integer("purchase_location"),
  isPrivate: integer("is_private").notNull().default(0),
  removed: integer("removed").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertVirtualGiftReceivedSchema = createInsertSchema(virtualGiftsReceived).pick({
  username: true, sender: true, virtualGiftId: true, message: true, isPrivate: true,
});

// ─── BADGES ───────────────────────────────────────────────────────────────────
// Maps to old migme: badge
export const badges = pgTable("badges", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  iconUrl: text("icon_url"),
  // Avatar frame — transparent PNG overlaid on every avatar of a user who holds this badge
  avatarFrameUrl: text("avatar_frame_url"),
  // Auto-assignment slot — when set, this badge is shown on the mini profile
  // of whoever currently occupies the (kind, game, rank, period) leaderboard slot.
  slotKind:     text("slot_kind"),       // "game_win" | "gift_sender" | "event_champion" | null
  slotGameType: text("slot_game_type"),  // e.g. "pelakor", "lowcard", "dice" — null for gift_sender
  slotRank:     integer("slot_rank"),    // 1, 2, or 3
  slotPeriod:   text("slot_period"),     // "DAILY" | "WEEKLY" | "ALL_TIME"
});

export const insertBadgeSchema = createInsertSchema(badges).omit({ id: true });

// Maps to old migme: badgerewarded
export const badgesRewarded = pgTable("badges_rewarded", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  badgeId: integer("badge_id").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertBadgeRewardedSchema = createInsertSchema(badgesRewarded).pick({ username: true, badgeId: true });

// ─── CHATROOM MODERATION ──────────────────────────────────────────────────────
// Maps to old migme: chatroombanneduser
export const chatroomBannedUsers = pgTable("chatroom_banned_users", {
  id: serial("id").primaryKey(),
  chatroomId: varchar("chatroom_id").notNull(),
  username: text("username").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertChatroomBannedUserSchema = createInsertSchema(chatroomBannedUsers).pick({ chatroomId: true, username: true });

// Maps to old migme: chatroommoderator
export const chatroomModerators = pgTable("chatroom_moderators", {
  id: serial("id").primaryKey(),
  chatroomId: varchar("chatroom_id").notNull(),
  username: text("username").notNull(),
  assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
});

export const insertChatroomModeratorSchema = createInsertSchema(chatroomModerators).pick({ chatroomId: true, username: true });

// Chatroom muted users — persists mute state across restarts
// mutedUntil = null means permanent mute; otherwise auto-unmute when expired (/silence)
export const chatroomMutedUsers = pgTable("chatroom_muted_users", {
  id: serial("id").primaryKey(),
  chatroomId: varchar("chatroom_id").notNull(),
  userId: varchar("user_id").notNull(),
  username: text("username").notNull(),
  mutedUntil: timestamp("muted_until"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

// Maps to old migme: chatroombookmark
export const chatroomBookmarks = pgTable("chatroom_bookmarks", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  chatroomName: text("chatroom_name").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertChatroomBookmarkSchema = createInsertSchema(chatroomBookmarks).pick({ username: true, chatroomName: true });

// ─── GROUPS ───────────────────────────────────────────────────────────────────
// Maps to old migme: groups
export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  type: smallint("type").notNull().default(0),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  about: text("about").notNull().default(""),
  createdBy: text("created_by").notNull(),
  picture: text("picture"),
  emailAddress: text("email_address"),
  countryId: integer("country_id"),
  premium: integer("premium").notNull().default(0),
  sortOrder: integer("sort_order"),
  numMembers: integer("num_members").notNull().default(0),
  numPhotos: integer("num_photos").notNull().default(0),
  numForumPosts: integer("num_forum_posts").notNull().default(0),
  featured: smallint("featured").notNull().default(0),
  official: smallint("official").notNull().default(0),
  status: integer("status").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertGroupSchema = createInsertSchema(groups).omit({ id: true, createdAt: true });

// Maps to old migme: groupmember
export const groupMembers = pgTable("group_members", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  groupId: integer("group_id").notNull(),
  type: integer("type").notNull().default(0),
  smsNotification: integer("sms_notification").notNull().default(0),
  emailNotification: integer("email_notification").notNull().default(0),
  eventNotification: integer("event_notification").notNull().default(0),
  status: integer("status").notNull().default(1),
  joinedAt: timestamp("joined_at").notNull().default(sql`now()`),
  leftAt: timestamp("left_at"),
  expirationDate: timestamp("expiration_date"),
});

export const insertGroupMemberSchema = createInsertSchema(groupMembers).pick({ username: true, groupId: true, type: true });

export const GROUP_MEMBER_TYPE = { MEMBER: 0, MODERATOR: 1, ADMIN: 2 } as const;
export const GROUP_MEMBER_STATUS = { ACTIVE: 1, INACTIVE: 0 } as const;

// ─── BOTS ─────────────────────────────────────────────────────────────────────
// Maps to old migme: bot
export const bots = pgTable("bots", {
  id: serial("id").primaryKey(),
  game: text("game").notNull().default(""),
  displayName: text("display_name").notNull(),
  description: text("description"),
  commandName: text("command_name"),
  executableFileName: text("executable_file_name"),
  libraryPaths: text("library_paths"),
  type: integer("type").notNull().default(1),
  leaderboards: boolean("leaderboards").notNull().default(false),
  emoticonKeyList: text("emoticon_key_list"),
  sortOrder: smallint("sort_order").notNull().default(0),
  groupId: integer("group_id").notNull().default(0),
  status: integer("status").notNull().default(0),
});

export const insertBotSchema = createInsertSchema(bots).omit({ id: true });

// Maps to old migme: botconfig
export const botConfigs = pgTable("bot_configs", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").notNull(),
  propertyName: text("property_name"),
  propertyValue: text("property_value"),
  description: text("description"),
});

export const insertBotConfigSchema = createInsertSchema(botConfigs).omit({ id: true });

// ─── USER SETTINGS ────────────────────────────────────────────────────────────
// Maps to old migme: usersetting
export const userSettings = pgTable("user_settings", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  type: integer("type").notNull(),
  value: integer("value").notNull().default(0),
}, (t) => [unique("user_settings_username_type_unique").on(t.username, t.type)]);

export const insertUserSettingSchema = createInsertSchema(userSettings).pick({ username: true, type: true, value: true });

// Mirrors UserSettingData.TypeEnum (com/projectgoth/fusion/data/UserSettingData.java)
export const USER_SETTING_TYPE = {
  ANONYMOUS_CALL:      1,  // AnonymousCallEnum: 0=DISABLED, 1=ENABLED
  MESSAGE:             2,  // MessageEnum: 0=DISABLED, 1=EVERYONE, 2=FRIENDS_ONLY
  SECURITY_QUESTION:   3,
  EMAIL_MENTION:       4,  // EmailSettingEnum: 0=DISABLED, 1=ENABLED
  EMAIL_REPLY_TO_POST: 5,
  EMAIL_RECEIVE_GIFT:  6,
  EMAIL_NEW_FOLLOWER:  7,
  EMAIL_ALL:           8,
} as const;

// Mirrors UserSettingData.MessageEnum
export const USER_MESSAGE_SETTING = { DISABLED: 0, EVERYONE: 1, FRIENDS_ONLY: 2 } as const;
// Mirrors UserSettingData.EmailSettingEnum
export const USER_EMAIL_SETTING = { DISABLED: 0, ENABLED: 1 } as const;
// Mirrors UserSettingData.AnonymousCallEnum
export const USER_CALL_SETTING = { DISABLED: 0, ENABLED: 1 } as const;

// ─── CLIENT TEXTS (mirrors MessageDAOChain.java / FusionDbMessageDAOChain.java) ─
// Maps to old migme: clienttext
// type: 1 = HelpText, 2 = InfoText
export const clientTexts = pgTable("client_texts", {
  id: serial("id").primaryKey(),
  type: integer("type").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});
export const insertClientTextSchema = createInsertSchema(clientTexts).omit({ id: true, createdAt: true });
export type ClientText = typeof clientTexts.$inferSelect;
export type InsertClientText = z.infer<typeof insertClientTextSchema>;
export const CLIENT_TEXT_TYPE = { HELP: 1, INFO: 2 } as const;

// Maps to old migme: alertmessage
export const alertMessages = pgTable("alert_messages", {
  id: serial("id").primaryKey(),
  type: integer("type").notNull().default(0),          // AlertMessageData.TypeEnum
  contentType: integer("content_type"),                 // AlertContentType enum
  clientType: integer("client_type").notNull().default(0),
  countryId: integer("country_id"),                     // null = all countries
  minMidletVersion: integer("min_midlet_version").notNull().default(0),
  maxMidletVersion: integer("max_midlet_version").notNull().default(9999),
  title: text("title"),
  content: text("content").notNull(),
  imageUrl: text("image_url"),
  actionUrl: text("action_url"),
  status: integer("status").notNull().default(1),       // 1 = ACTIVE
  startDate: timestamp("start_date").notNull().default(sql`now()`),
  expiryDate: timestamp("expiry_date").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});
export const insertAlertMessageSchema = createInsertSchema(alertMessages).omit({ id: true, createdAt: true });
export type AlertMessage = typeof alertMessages.$inferSelect;
export type InsertAlertMessage = z.infer<typeof insertAlertMessageSchema>;
export const ALERT_MESSAGE_STATUS = { ACTIVE: 1, INACTIVE: 0 } as const;

// ─── EMAIL BOUNCE (mirrors EmailDAOChain.java / FusionDbEmailDAOChain.java) ───
// Maps to old migme: bouncedb
// bounceType: 'Transient' (soft/temporary) | 'Permanent' (hard/blacklisted)
export const bounceEmails = pgTable("bounce_emails", {
  id: serial("id").primaryKey(),
  emailAddress: text("email_address").notNull().unique(),
  bounceType: text("bounce_type").notNull().default("Permanent"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertBounceEmailSchema = createInsertSchema(bounceEmails).omit({ id: true, createdAt: true });
export type BounceEmail = typeof bounceEmails.$inferSelect;
export type InsertBounceEmail = z.infer<typeof insertBounceEmailSchema>;

// ─── CAMPAIGN (mirrors CampaignDataDAOChain.java) ─────────────────────────────
// Maps to old migme: campaign
export const campaigns = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  type: integer("type").notNull().default(0),
  name: text("name").notNull(),
  description: text("description"),
  status: integer("status").notNull().default(1),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertCampaignSchema = createInsertSchema(campaigns).omit({ id: true, createdAt: true });

// Maps to old migme: campaignparticipant
export const campaignParticipants = pgTable("campaign_participants", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  userId: text("user_id").notNull(),
  mobilePhone: text("mobile_phone"),
  emailAddress: text("email_address"),
  reference: text("reference"),
  joinedAt: timestamp("joined_at").notNull().default(sql`now()`),
});

export const insertCampaignParticipantSchema = createInsertSchema(campaignParticipants).omit({ id: true, joinedAt: true });

export const CAMPAIGN_STATUS = { ACTIVE: 1, INACTIVE: 0 } as const;

// ─── GUARDSET ─────────────────────────────────────────────────────────────────
// Maps to old migme: guardcapability / guardsetcapability / guardsetmember / clientversion
// Simplified: one row per (clientType, guardCapability) → minVersion required
export const guardsetRules = pgTable("guardset_rules", {
  id: serial("id").primaryKey(),
  clientType: integer("client_type").notNull(),
  guardCapability: integer("guard_capability").notNull(),
  minVersion: smallint("min_version").notNull().default(0),
  description: text("description"),
});

export const insertGuardsetRuleSchema = createInsertSchema(guardsetRules).omit({ id: true });

// Client type constants (mirrors ClientType.java)
export const CLIENT_TYPE = { ANDROID: 1, IOS: 2, WEB: 3 } as const;

// Guard capability constants (mirrors GuardCapabilityEnum.java, simplified)
export const GUARD_CAPABILITY = {
  ENTER_CHATROOM: 1,
  SEND_MESSAGE: 2,
  CREATE_GROUP_CHAT: 3,
  VIEW_PROFILE: 4,
  SEND_GIFT: 5,
  USE_STICKER: 6,
  USE_BOT: 7,
} as const;

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/leaderboard/Leaderboard.java
// Types: SPENDING, GAMES_WON, CHATROOM_MSGS, PAINTWARS, CREDITS_RECEIVED
// Periods: DAILY, WEEKLY, MONTHLY, ALL_TIME, PREVIOUS_DAILY, PREVIOUS_WEEKLY, PREVIOUS_MONTHLY
export const leaderboardEntries = pgTable("leaderboard_entries", {
  id: serial("id").primaryKey(),
  leaderboardType: text("leaderboard_type").notNull(),
  period: text("period").notNull(),
  username: text("username").notNull(),
  score: doublePrecision("score").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertLeaderboardEntrySchema = createInsertSchema(leaderboardEntries).omit({ id: true, updatedAt: true });

// Mirrors Leaderboard.Type enum from com/projectgoth/fusion/leaderboard/Leaderboard.java
// Redis key prefix: e.g. "LB:GamesPlayed:LowCard:" + period
export const LEADERBOARD_TYPE = {
  LOW_CARD_GAMES_PLAYED:  "LB:GamesPlayed:LowCard:",
  DICE_GAMES_PLAYED:      "LB:GamesPlayed:Dice:",
  DANGER_GAMES_PLAYED:    "LB:GamesPlayed:Danger:",
  CRICKET_GAMES_PLAYED:   "LB:GamesPlayed:Cricket:",
  FOOTBALL_GAMES_PLAYED:  "LB:GamesPlayed:Football:",
  GUESS_GAMES_PLAYED:     "LB:GamesPlayed:Guess:",
  WARRIORS_GAMES_PLAYED:  "LB:GamesPlayed:Warriors:",
  LOW_CARD_MOST_WINS:     "LB:MostWins:LowCard:",
  DICE_MOST_WINS:         "LB:MostWins:Dice:",
  DANGER_MOST_WINS:       "LB:MostWins:Danger:",
  CRICKET_MOST_WINS:      "LB:MostWins:Cricket:",
  FOOTBALL_MOST_WINS:     "LB:MostWins:Football:",
  GUESS_MOST_WINS:        "LB:MostWins:Guess:",
  WARRIORS_MOST_WINS:     "LB:MostWins:Warriors:",
  WARRIORS_NUM_KILLS:     "LB:NumKills:Warriors:",
  USER_LIKES:             "LB:UserLikes:",
  MIG_LEVEL:              "LB:MigLevel:",
  REFERRER:               "LB:Referrer:",
  GIFT_SENT:              "LB:GiftSent:",
  GIFT_RECEIVED:          "LB:GiftReceived:",
  AVATAR_VOTES:           "LB:AvatarVotes:",
  PAINT_WARS_PAINT_POINTS:"LB:PaintPoints:",
  TOTAL_MOST_WINS:        "LB:MostWins:Total:",
  TOTAL_GAMES_PLAYED:     "LB:GamesPlayed:Total:",
  TEBAK_HATI_GAMES_PLAYED:"LB:GamesPlayed:TebakHati:",
  TEBAK_HATI_MOST_WINS:   "LB:MostWins:TebakHati:",
  ONE_GAMES_PLAYED:       "LB:GamesPlayed:One:",
  ONE_MOST_WINS:          "LB:MostWins:One:",
  PARTY_GIFT_SENT:        "LB:Party:GiftSent:",
  PARTY_GIFT_RECEIVED:    "LB:Party:GiftReceived:",
} as const;

export const LEADERBOARD_PERIOD = {
  DAILY: "DAILY",
  WEEKLY: "WEEKLY",
  MONTHLY: "MONTHLY",
  ALL_TIME: "ALL_TIME",
  PREVIOUS_DAILY: "PREVIOUS_DAILY",
  PREVIOUS_WEEKLY: "PREVIOUS_WEEKLY",
  PREVIOUS_MONTHLY: "PREVIOUS_MONTHLY",
} as const;

// ─── INVITATIONS ─────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/invitation/restapi/
// SendingInvitationData: type, channel, destinations, invitationMetadata
// InvitationDetailsData: createdTS, expiredTS
export const invitations = pgTable("invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  senderUsername: text("sender_username").notNull(),
  type: integer("type").notNull().default(1),
  channel: integer("channel").notNull().default(1),
  destination: text("destination").notNull(),
  status: integer("status").notNull().default(1),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  expiresAt: timestamp("expires_at"),
});

export const insertInvitationSchema = createInsertSchema(invitations).omit({ id: true, createdAt: true });

export const INVITATION_TYPE = { EMAIL: 1, SMS: 2, SOCIAL: 3 } as const;
export const INVITATION_CHANNEL = { EMAIL: 1, SMS: 2, FACEBOOK: 3, TWITTER: 4, WHATSAPP: 5 } as const;
export const INVITATION_STATUS = { PENDING: 1, ACCEPTED: 2, DECLINED: 3, EXPIRED: 4 } as const;

// ─── USER REPUTATION ─────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/reputation/domain/ metrics
// AccountEntryMetrics: kicks, referrals, recharged amount
// PhoneCallMetrics: call duration
// ScoreMetrics: total score and level
export const userReputation = pgTable("user_reputation", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  score: doublePrecision("score").notNull().default(0),
  level: integer("level").notNull().default(1),
  // ScoreMetrics (com/projectgoth/fusion/reputation/domain/ScoreMetrics.java)
  chatRoomMessagesSent: integer("chat_room_messages_sent").notNull().default(0),
  privateMessagesSent: integer("private_messages_sent").notNull().default(0),
  totalTime: integer("total_time").notNull().default(0),       // seconds online
  photosUploaded: integer("photos_uploaded").notNull().default(0),
  // AccountEntryMetrics (com/projectgoth/fusion/reputation/domain/AccountEntryMetrics.java)
  kicksInitiated: integer("kicks_initiated").notNull().default(0),
  authenticatedReferrals: integer("authenticated_referrals").notNull().default(0),
  rechargedAmount: doublePrecision("recharged_amount").notNull().default(0),
  // PhoneCallMetrics (com/projectgoth/fusion/reputation/domain/PhoneCallMetrics.java)
  phoneCallDuration: integer("phone_call_duration").notNull().default(0),
  // SessionArchiveMetrics
  sessionCount: integer("session_count").notNull().default(0),
  // VirtualGiftMetrics (com/projectgoth/fusion/reputation/domain/VirtualGiftMetrics.java)
  virtualGiftsSent: integer("virtual_gifts_sent").notNull().default(0),
  virtualGiftsReceived: integer("virtual_gifts_received").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertUserReputationSchema = createInsertSchema(userReputation).omit({ id: true, updatedAt: true });

// ─── REPUTATION SCORE TO LEVEL ───────────────────────────────────────────────
// Mirrors ReputationLevelData.java + ReputationScoreToLevel DB table
// SELECT score, level FROM ReputationScoreToLevel ORDER BY score DESC
// Fields map directly to com.projectgoth.fusion.data.ReputationLevelData
export const reputationScoreToLevel = pgTable("reputation_score_to_level", {
  level: integer("level").primaryKey(),
  score: integer("score").notNull().default(0),              // min cumulative score to reach this level
  name: text("name"),                                         // e.g. "Newbie", "Beginner", "Legend"
  image: text("image"),                                       // badge image URL
  chatRoomSize: integer("chat_room_size"),                    // max participants in owned chatroom
  groupSize: integer("group_size"),                           // max members in owned group
  numGroupChatRooms: integer("num_group_chat_rooms"),         // max chatrooms in owned group
  createChatRoom: boolean("create_chat_room").notNull().default(false),
  createGroup: boolean("create_group").notNull().default(false),
  publishPhoto: boolean("publish_photo").notNull().default(false),
  postCommentLikeUserWall: boolean("post_comment_like_user_wall").notNull().default(false),
  addToPhotoWall: boolean("add_to_photo_wall").notNull().default(false),
  enterPot: boolean("enter_pot").notNull().default(false),
  numGroupModerators: integer("num_group_moderators").notNull().default(0),
});

export const insertReputationScoreToLevelSchema = createInsertSchema(reputationScoreToLevel);
export type LevelThreshold = typeof reputationScoreToLevel.$inferSelect;
export type InsertLevelThreshold = z.infer<typeof insertReputationScoreToLevelSchema>;

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/payment/PaymentData.java + PaymentInterface.java
// VendorType: CREDITCARD, PAYPAL, MOL, MIMOPAY
// Status: PENDING, AUTHORIZED, COMPLETED, REJECTED, REFUNDED
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  vendorType: text("vendor_type").notNull(),
  vendorTransactionId: text("vendor_transaction_id"),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("IDR"),
  status: integer("status").notNull().default(1),
  description: text("description"),
  extraFields: jsonb("extra_fields"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertPaymentSchema = createInsertSchema(payments).omit({ id: true, createdAt: true, updatedAt: true });

export const PAYMENT_VENDOR_TYPE = {
  CREDITCARD: "CREDITCARD",
  PAYPAL: "PAYPAL",
  MOL: "MOL",
  MIMOPAY: "MIMOPAY",
} as const;

export const PAYMENT_STATUS = {
  PENDING: 1,
  AUTHORIZED: 2,
  COMPLETED: 3,
  REJECTED: 4,
  REFUNDED: 5,
} as const;

// ─── USER EVENTS ─────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/userevent/ domain classes
// UserEventType enum values (byte values match Java):
//   SHORT_TEXT_STATUS=1, PHOTO_UPLOAD_WITH_TITLE=2, PHOTO_UPLOAD_WITHOUT_TITLE=3
//   CREATE_PUBLIC_CHATROOM=4, ADDING_FRIEND=5, UPDATING_PROFILE=6, PURCHASED_GOODS=7
//   VIRTUAL_GIFT=8, GROUP_DONATION=9, GROUP_JOINED=10, GROUP_ANNOUNCEMENT=11
//   GROUP_USER_POST=12, USER_WALL_POST=13, GENERIC_APP_EVENT=14, GIFT_SHOWER_EVENT=15
export const userEvents = pgTable("user_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  generatingUsername: text("generating_username"),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertUserEventSchema = createInsertSchema(userEvents).omit({ id: true, createdAt: true });

// Mirrors com/projectgoth/fusion/userevent/domain/UserEventType.java
export const USER_EVENT_TYPE = {
  SHORT_TEXT_STATUS: "SHORT_TEXT_STATUS",
  PHOTO_UPLOAD_WITH_TITLE: "PHOTO_UPLOAD_WITH_TITLE",
  PHOTO_UPLOAD_WITHOUT_TITLE: "PHOTO_UPLOAD_WITHOUT_TITLE",
  CREATE_PUBLIC_CHATROOM: "CREATE_PUBLIC_CHATROOM",
  ADDING_FRIEND: "ADDING_FRIEND",
  UPDATING_PROFILE: "UPDATING_PROFILE",
  PURCHASED_GOODS: "PURCHASED_GOODS",
  VIRTUAL_GIFT: "VIRTUAL_GIFT",
  GROUP_DONATION: "GROUP_DONATION",
  GROUP_JOINED: "GROUP_JOINED",
  GROUP_ANNOUNCEMENT: "GROUP_ANNOUNCEMENT",
  GROUP_USER_POST: "GROUP_USER_POST",
  USER_WALL_POST: "USER_WALL_POST",
  GENERIC_APP_EVENT: "GENERIC_APP_EVENT",
  GIFT_SHOWER_EVENT: "GIFT_SHOWER_EVENT",
  CHATROOM_MESSAGE: "CHATROOM_MESSAGE",
  BOT_GAME_WON: "BOT_GAME_WON",
  CREDIT_RECHARGE: "CREDIT_RECHARGE",
  INVITATION_RESPONDED: "INVITATION_RESPONDED",
  PROFILE_UPDATED: "PROFILE_UPDATED",
  LOGIN: "LOGIN",
  LOGOUT: "LOGOUT",
  MADEGROUP_USER_POST: "MADEGROUP_USER_POST",
} as const;

// Mirrors com/projectgoth/fusion/userevent/domain/EventPrivacySetting.java
// Stores per-user receiving and publishing privacy masks
export const userEventPrivacy = pgTable("user_event_privacy", {
  username: text("username").primaryKey(),
  receivingStatusUpdates: boolean("receiving_status_updates").notNull().default(true),
  receivingProfileChanges: boolean("receiving_profile_changes").notNull().default(true),
  receivingAddFriends: boolean("receiving_add_friends").notNull().default(false),
  receivingPhotosPublished: boolean("receiving_photos_published").notNull().default(true),
  receivingContentPurchased: boolean("receiving_content_purchased").notNull().default(true),
  receivingChatroomCreation: boolean("receiving_chatroom_creation").notNull().default(true),
  receivingVirtualGifting: boolean("receiving_virtual_gifting").notNull().default(true),
  publishingStatusUpdates: boolean("publishing_status_updates").notNull().default(true),
  publishingProfileChanges: boolean("publishing_profile_changes").notNull().default(true),
  publishingAddFriends: boolean("publishing_add_friends").notNull().default(false),
  publishingPhotosPublished: boolean("publishing_photos_published").notNull().default(true),
  publishingContentPurchased: boolean("publishing_content_purchased").notNull().default(true),
  publishingChatroomCreation: boolean("publishing_chatroom_creation").notNull().default(true),
  publishingVirtualGifting: boolean("publishing_virtual_gifting").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertUserEventPrivacySchema = createInsertSchema(userEventPrivacy).omit({ updatedAt: true });
export type UserEventPrivacy = typeof userEventPrivacy.$inferSelect;
export type InsertUserEventPrivacy = z.infer<typeof insertUserEventPrivacySchema>;

// ─── FASHION SHOW ─────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/fashionshow/AvatarCandidates.java
// Candidates must meet level, active days, avatar items requirements
export const fashionShowSessions = pgTable("fashion_show_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  requiredLevel: integer("required_level").notNull().default(1),
  requiredActiveDays: integer("required_active_days").notNull().default(14),
  requiredAvatarItems: integer("required_avatar_items").notNull().default(2),
  status: integer("status").notNull().default(1),
  votes: integer("votes").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertFashionShowSessionSchema = createInsertSchema(fashionShowSessions).omit({ id: true, createdAt: true, votes: true });

export const FASHION_SHOW_STATUS = { ACTIVE: 1, INACTIVE: 0, WINNER: 2 } as const;

// ─── PAINTWARS ────────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/paintwars/Painter.java + PainterStats.java
// Free paints: 3/day, Free cleans: 2/day
// Pricing: paint = 100 IDR credit, clean = 200 IDR credit
export const paintwarsStats = pgTable("paintwars_stats", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  totalPaintWarsPoints: integer("total_paintwars_points").notNull().default(0),
  totalPaintsSent: integer("total_paints_sent").notNull().default(0),
  totalPaintsReceived: integer("total_paints_received").notNull().default(0),
  totalCleansSent: integer("total_cleans_sent").notNull().default(0),
  totalCleansReceived: integer("total_cleans_received").notNull().default(0),
  paintsRemaining: integer("paints_remaining").notNull().default(3),
  cleansRemaining: integer("cleans_remaining").notNull().default(2),
  identiconIndex: integer("identicon_index").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertPaintwarsStatsSchema = createInsertSchema(paintwarsStats).omit({ id: true, updatedAt: true });

// ─── SMS MESSAGES ─────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/smsengine/SMSMessage.java
// SubTypes: VERIFICATION=1, ALERT=2, MARKETING=3
// Gateways: SMPP, HTTP
export const smsMessages = pgTable("sms_messages", {
  id: serial("id").primaryKey(),
  username: text("username"),
  phoneNumber: text("phone_number").notNull(),
  message: text("message").notNull(),
  subType: integer("sub_type").notNull().default(1),
  status: integer("status").notNull().default(1),
  gateway: text("gateway"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertSmsMessageSchema = createInsertSchema(smsMessages).omit({ id: true, createdAt: true });

export const SMS_STATUS = { PENDING: 1, SENT: 2, FAILED: 3, RETRY: 4 } as const;
export const SMS_SUB_TYPE = { VERIFICATION: 1, ALERT: 2, MARKETING: 3 } as const;
export const SMS_GATEWAY = { SMPP: "SMPP", HTTP: "HTTP" } as const;

// ─── VOICE CALLS ─────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/voiceengine/CallingCard.java
// Status: INITIATED, ANSWERED, ENDED, MISSED, FAILED
export const voiceCalls = pgTable("voice_calls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  callerUsername: text("caller_username").notNull(),
  calleeUsername: text("callee_username").notNull(),
  status: integer("status").notNull().default(1),
  duration: integer("duration").notNull().default(0),
  callingCard: text("calling_card"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  endedAt: timestamp("ended_at"),
});

export const insertVoiceCallSchema = createInsertSchema(voiceCalls).omit({ id: true, createdAt: true });

export const VOICE_CALL_STATUS = {
  INITIATED: 1,
  ANSWERED: 2,
  ENDED: 3,
  MISSED: 4,
  FAILED: 5,
} as const;

// ─── NOTIFICATIONS (UNS) ──────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/uns/domain/Note.java subclasses:
// AlertNote (target users), SMSNote (phone + subtype), EmailNote (subject + recipients)
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  type: text("type").notNull(),
  subject: text("subject"),
  message: text("message").notNull(),
  status: integer("status").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({ id: true, createdAt: true });

export const NOTIFICATION_TYPE = { ALERT: "ALERT", EMAIL: "EMAIL", SMS: "SMS" } as const;
export const NOTIFICATION_STATUS = { PENDING: 1, SENT: 2, FAILED: 3 } as const;

// ─── MESSAGE SWITCHBOARD ──────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/messageswitchboard/MessageSwitchboard.java
// Dispatches messages between users with status tracking
export const switchboardMessages = pgTable("switchboard_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUsername: text("from_username").notNull(),
  toUsername: text("to_username").notNull(),
  messageType: text("message_type").notNull(),
  payload: jsonb("payload"),
  status: integer("status").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertSwitchboardMessageSchema = createInsertSchema(switchboardMessages).omit({ id: true, createdAt: true });

export const SWITCHBOARD_MSG_TYPE = { CHAT: "CHAT", SYSTEM: "SYSTEM", ALERT: "ALERT", GIFT: "GIFT" } as const;
export const SWITCHBOARD_STATUS = { QUEUED: 1, DELIVERED: 2, FAILED: 3 } as const;

// ─── IMAGE SERVER ─────────────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/imageserver/
// ImageItem.java: id, key, mimeType, size, base64Data
// ImageCache.java: caches by key
// Stores user-uploaded images with base64 content
export const serverImages = pgTable("server_images", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  imageKey: text("image_key").notNull().unique(),
  mimeType: text("mime_type").notNull().default("image/jpeg"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  base64Data: text("base64_data").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertServerImageSchema = createInsertSchema(serverImages).omit({ id: true, createdAt: true });

// ─── TYPES ────────────────────────────────────────────────────────────────────
export type LoginInput           = z.infer<typeof loginSchema>;
export type InsertUser           = z.infer<typeof insertUserSchema>;
export type User                 = typeof users.$inferSelect;
export type UserProfile          = typeof userProfiles.$inferSelect;
export type InsertUserProfile    = z.infer<typeof insertUserProfileSchema>;
export type WallPost             = typeof wallPosts.$inferSelect;
export type InsertWallPost       = z.infer<typeof insertWallPostSchema>;
export type Chatroom             = typeof chatrooms.$inferSelect;
export type InsertChatroom       = z.infer<typeof insertChatroomSchema>;
export type ChatroomMessage      = typeof chatroomMessages.$inferSelect;
export type InsertMessage        = z.infer<typeof insertMessageSchema>;
export type Room                 = typeof rooms.$inferSelect;
export type InsertRoom           = z.infer<typeof insertRoomSchema>;
export type LostContact          = typeof lostContacts.$inferSelect;
export type InsertLostContact    = z.infer<typeof insertLostContactSchema>;
export type Merchant             = typeof merchants.$inferSelect;
export type InsertMerchant       = z.infer<typeof insertMerchantSchema>;
export type MerchantLocation     = typeof merchantLocations.$inferSelect;
export type InsertMerchantLocation = z.infer<typeof insertMerchantLocationSchema>;
export type MerchantPoint        = typeof merchantPoints.$inferSelect;
export type MerchantTag          = typeof merchantTags.$inferSelect;
export type InsertMerchantTag    = z.infer<typeof insertMerchantTagSchema>;
export type UserRecommendation   = typeof userRecommendations.$inferSelect;
export type CreditAccount        = typeof creditAccounts.$inferSelect;
export type InsertCreditAccount  = z.infer<typeof insertCreditAccountSchema>;
export type CreditTransaction    = typeof creditTransactions.$inferSelect;
export type InsertCreditTransaction = z.infer<typeof insertCreditTransactionSchema>;
export type VoucherBatch         = typeof voucherBatches.$inferSelect;
export type InsertVoucherBatch   = z.infer<typeof insertVoucherBatchSchema>;
export type Voucher              = typeof vouchers.$inferSelect;
export type RewardProgram        = typeof rewardPrograms.$inferSelect;
export type InsertRewardProgram  = z.infer<typeof insertRewardProgramSchema>;
export type UserRewardHistory    = typeof userRewardHistory.$inferSelect;

// New migme-equivalent table types
export type ContactGroup         = typeof contactGroups.$inferSelect;
export type InsertContactGroup   = z.infer<typeof insertContactGroupSchema>;
export type Contact              = typeof contacts.$inferSelect;
export type InsertContact        = z.infer<typeof insertContactSchema>;
export type BlockList            = typeof blockList.$inferSelect;
export type InsertBlockList      = z.infer<typeof insertBlockListSchema>;
export type EmoticonPack         = typeof emoticonPacks.$inferSelect;
export type InsertEmoticonPack   = z.infer<typeof insertEmoticonPackSchema>;
export type Emoticon             = typeof emoticons.$inferSelect;
export type InsertEmoticon       = z.infer<typeof insertEmoticonSchema>;
export type VirtualGift          = typeof virtualGifts.$inferSelect;
export type InsertVirtualGift    = z.infer<typeof insertVirtualGiftSchema>;
export type VirtualGiftReceived  = typeof virtualGiftsReceived.$inferSelect;
export type InsertVirtualGiftReceived = z.infer<typeof insertVirtualGiftReceivedSchema>;
export type Badge                = typeof badges.$inferSelect;
export type InsertBadge          = z.infer<typeof insertBadgeSchema>;
export type BadgeRewarded        = typeof badgesRewarded.$inferSelect;
export type InsertBadgeRewarded  = z.infer<typeof insertBadgeRewardedSchema>;
export type ChatroomBannedUser   = typeof chatroomBannedUsers.$inferSelect;
export type ChatroomModerator    = typeof chatroomModerators.$inferSelect;
export type ChatroomMutedUser    = typeof chatroomMutedUsers.$inferSelect;
export type ChatroomBookmark     = typeof chatroomBookmarks.$inferSelect;
export type Group                = typeof groups.$inferSelect;
export type InsertGroup          = z.infer<typeof insertGroupSchema>;
export type GroupMember          = typeof groupMembers.$inferSelect;
export type InsertGroupMember    = z.infer<typeof insertGroupMemberSchema>;
export type Bot                  = typeof bots.$inferSelect;
export type InsertBot            = z.infer<typeof insertBotSchema>;
export type BotConfig            = typeof botConfigs.$inferSelect;
export type InsertBotConfig      = z.infer<typeof insertBotConfigSchema>;
export type UserSetting          = typeof userSettings.$inferSelect;
export type InsertUserSetting    = z.infer<typeof insertUserSettingSchema>;
export type GuardsetRule         = typeof guardsetRules.$inferSelect;
export type InsertGuardsetRule   = z.infer<typeof insertGuardsetRuleSchema>;
export type Campaign             = typeof campaigns.$inferSelect;
export type InsertCampaign       = z.infer<typeof insertCampaignSchema>;
export type CampaignParticipant  = typeof campaignParticipants.$inferSelect;
export type InsertCampaignParticipant = z.infer<typeof insertCampaignParticipantSchema>;

// New modules types
export type LeaderboardEntry     = typeof leaderboardEntries.$inferSelect;
export type InsertLeaderboardEntry = z.infer<typeof insertLeaderboardEntrySchema>;
export type Invitation           = typeof invitations.$inferSelect;
export type InsertInvitation     = z.infer<typeof insertInvitationSchema>;
export type UserReputationRow    = typeof userReputation.$inferSelect;
export type InsertUserReputation = z.infer<typeof insertUserReputationSchema>;
export type Payment              = typeof payments.$inferSelect;
export type InsertPayment        = z.infer<typeof insertPaymentSchema>;
export type UserEvent            = typeof userEvents.$inferSelect;
export type InsertUserEvent      = z.infer<typeof insertUserEventSchema>;
export type FashionShowSession   = typeof fashionShowSessions.$inferSelect;
export type InsertFashionShowSession = z.infer<typeof insertFashionShowSessionSchema>;
export type PaintwarsStats       = typeof paintwarsStats.$inferSelect;
export type InsertPaintwarsStats = z.infer<typeof insertPaintwarsStatsSchema>;
export type SmsMessage           = typeof smsMessages.$inferSelect;
export type InsertSmsMessage     = z.infer<typeof insertSmsMessageSchema>;
export type VoiceCall            = typeof voiceCalls.$inferSelect;
export type InsertVoiceCall      = z.infer<typeof insertVoiceCallSchema>;
export type Notification         = typeof notifications.$inferSelect;
export type InsertNotification   = z.infer<typeof insertNotificationSchema>;
export type SwitchboardMessage   = typeof switchboardMessages.$inferSelect;
export type InsertSwitchboardMessage = z.infer<typeof insertSwitchboardMessageSchema>;
export type ServerImage          = typeof serverImages.$inferSelect;
export type InsertServerImage    = z.infer<typeof insertServerImageSchema>;

export interface ChatParticipant {
  id: string;
  username: string;
  displayName: string;
  color: string;
  isOwner?: boolean;
  isMod?: boolean;
  isGlobalAdmin?: boolean;
  isMuted?: boolean;
  joinedAt: string;
  displayPicture?: string | null;
}

// ─── PRIVACY SETTINGS ─────────────────────────────────────────────────────────
// Mirrors: com/projectgoth/fusion/restapi/data/SettingsProfileDetailsData.java
//          com/projectgoth/fusion/restapi/data/SettingsAccountCommunicationData.java
//          com/projectgoth/fusion/userevent/domain/EventPrivacySetting.java
//          com/projectgoth/fusion/restapi/data/SettingsEnums.java

export const userPrivacySettings = pgTable("user_privacy_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  // Profile Details (SettingsProfileDetailsData)
  dobPrivacy: integer("dob_privacy").notNull().default(0),           // 0=HIDE 1=SHOW_FULL 2=SHOW_WITHOUT_YEAR
  firstLastNamePrivacy: integer("first_last_name_privacy").notNull().default(0), // 0=HIDE 1=SHOW
  mobilePhonePrivacy: integer("mobile_phone_privacy").notNull().default(0),      // 0=HIDE 1=EVERYONE 2=FRIEND_ONLY
  externalEmailPrivacy: integer("external_email_privacy").notNull().default(0),  // 0=HIDE 1=EVERYONE 2=FRIEND_ONLY 3=FOLLOWER_ONLY
  // Account Communication (SettingsAccountCommunicationData)
  chatPrivacy: integer("chat_privacy").notNull().default(1),         // 1=EVERYONE 2=FRIEND_ONLY 3=FOLLOWER_ONLY
  buzzPrivacy: integer("buzz_privacy").notNull().default(1),         // 1=ON 0=OFF
  lookoutPrivacy: integer("lookout_privacy").notNull().default(1),   // 1=ON 0=OFF
  footprintsPrivacy: integer("footprints_privacy").notNull().default(0), // 0=HIDE 1=EVERYONE 2=FRIEND_ONLY 3=FOLLOWER_ONLY
  feedPrivacy: integer("feed_privacy").notNull().default(1),         // 1=EVERYONE 2=FRIEND_OR_FOLLOWER
  // Activity/Event Privacy (EventPrivacySetting)
  activityStatusUpdates: boolean("activity_status_updates").notNull().default(true),
  activityProfileChanges: boolean("activity_profile_changes").notNull().default(true),
  activityAddFriends: boolean("activity_add_friends").notNull().default(false),
  activityPhotosPublished: boolean("activity_photos_published").notNull().default(true),
  activityContentPurchased: boolean("activity_content_purchased").notNull().default(true),
  activityChatroomCreation: boolean("activity_chatroom_creation").notNull().default(true),
  activityVirtualGifting: boolean("activity_virtual_gifting").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertUserPrivacySettingsSchema = createInsertSchema(userPrivacySettings).omit({ id: true, updatedAt: true });
export type UserPrivacySettings = typeof userPrivacySettings.$inferSelect;
export type InsertUserPrivacySettings = z.infer<typeof insertUserPrivacySettingsSchema>;

// Enum constants matching Java SettingsEnums
export const DOB_PRIVACY = { HIDE: 0, SHOW_FULL: 1, SHOW_WITHOUT_YEAR: 2 } as const;
export const SHOW_HIDE_PRIVACY = { HIDE: 0, SHOW: 1 } as const;
export const MOBILE_PRIVACY = { HIDE: 0, EVERYONE: 1, FRIEND_ONLY: 2 } as const;
export const EMAIL_PRIVACY = { HIDE: 0, EVERYONE: 1, FRIEND_ONLY: 2, FOLLOWER_ONLY: 3 } as const;
export const CHAT_PRIVACY = { EVERYONE: 1, FRIEND_ONLY: 2, FOLLOWER_ONLY: 3 } as const;
export const FEED_PRIVACY = { EVERYONE: 1, FRIEND_OR_FOLLOWER: 2 } as const;
export const FOOTPRINTS_PRIVACY = { HIDE: 0, EVERYONE: 1, FRIEND_ONLY: 2, FOLLOWER_ONLY: 3 } as const;

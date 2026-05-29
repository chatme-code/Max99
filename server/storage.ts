import {
  type User, type InsertUser,
  type UserProfile, type InsertUserProfile,
  type WallPost,
  type Chatroom, type InsertChatroom,
  type ChatroomMessage,
  type ChatParticipant,
  type Room, type InsertRoom,
  type LostContact, type InsertLostContact,
  type Merchant, type InsertMerchant,
  type MerchantLocation, type InsertMerchantLocation,
  type MerchantPoint,
  type MerchantTag, type InsertMerchantTag,
  type UserRecommendation,
  type CreditAccount,
  type CreditTransaction,
  type VoucherBatch, type InsertVoucherBatch,
  type Voucher,
  type RewardProgram, type InsertRewardProgram,
  type UserRewardHistory,
  type VirtualGift, type VirtualGiftReceived, type InsertVirtualGiftReceived,
  type Bot, type InsertBot,
  type BotConfig, type InsertBotConfig,
  type EmoticonPack, type InsertEmoticonPack,
  type Emoticon, type InsertEmoticon,
  type GuardsetRule, type InsertGuardsetRule,
  type Campaign, type InsertCampaign,
  type CampaignParticipant, type InsertCampaignParticipant,
  type BounceEmail, type InsertBounceEmail,
  type Group, type InsertGroup,
  type GroupMember, type InsertGroupMember,
  type ClientText, type InsertClientText,
  type AlertMessage, type InsertAlertMessage,
  GROUP_MEMBER_TYPE, GROUP_MEMBER_STATUS,
  CLIENT_TEXT_TYPE, ALERT_MESSAGE_STATUS,
  CHATROOM_COLORS,
  CREDIT_TRANSACTION_TYPE,
  VOUCHER_STATUS,
  type LeaderboardEntry, type InsertLeaderboardEntry,
  type Invitation, type InsertInvitation,
  type UserReputationRow, type InsertUserReputation,
  type LevelThreshold, type InsertLevelThreshold,
  type Payment, type InsertPayment,
  type UserEvent, type InsertUserEvent,
  type UserEventPrivacy,
  type FashionShowSession, type InsertFashionShowSession,
  type PaintwarsStats, type InsertPaintwarsStats,
  type SmsMessage, type InsertSmsMessage,
  type VoiceCall, type InsertVoiceCall,
  type Notification, type InsertNotification,
  type SwitchboardMessage, type InsertSwitchboardMessage,
  type ServerImage, type InsertServerImage,
  type UserPrivacySettings,
  type UserSetting,
  userSettings,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { buildDefaultReputationLevels } from "./modules/reputation/levelCurve";

// ─── LOCAL TYPES ──────────────────────────────────────────────────────────────
export interface PostComment {
  id: string;
  postId: string;
  authorUserId: string;
  authorUsername: string;
  text: string;
  createdAt: Date;
}

// Mirrors com/projectgoth/fusion/userevent/domain/EventPrivacySetting.java
// Receiving mask fields control which event types a user receives in their feed
export interface ReceivingPrivacyMask {
  statusUpdates: boolean;
  profileChanges: boolean;
  addFriends: boolean;
  photosPublished: boolean;
  contentPurchased: boolean;
  chatroomCreation: boolean;
  virtualGifting: boolean;
}

// Publishing mask fields control which event types a user publishes to others' feeds
export interface PublishingPrivacyMask {
  statusUpdates: boolean;
  profileChanges: boolean;
  addFriends: boolean;
  photosPublished: boolean;
  contentPurchased: boolean;
  chatroomCreation: boolean;
  virtualGifting: boolean;
}

// ─── INTERFACE ────────────────────────────────────────────────────────────────

export interface IStorage {
  // Auth / Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByVerifyToken(token: string): Promise<User | undefined>;
  getUserByResetToken(token: string): Promise<User | undefined>;
  createUser(user: InsertUser & { password: string; verifyToken?: string; verifyTokenExpiry?: Date }): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  searchUsers(query: string): Promise<Partial<User>[]>;

  // Profile
  getUserProfile(userId: string): Promise<UserProfile | undefined>;
  upsertUserProfile(userId: string, data: Partial<InsertUserProfile>): Promise<UserProfile>;

  // Social — Follow / Block / Report
  followUser(followerUsername: string, targetUsername: string): Promise<void>;
  unfollowUser(followerUsername: string, targetUsername: string): Promise<void>;
  isFollowing(followerUsername: string, targetUsername: string): Promise<boolean>;
  getFollowing(username: string): Promise<string[]>;
  getContacts(username: string): Promise<{ username: string; displayName: string; fusionUsername: string }[]>;
  blockUserGlobal(blockerUsername: string, targetUsername: string): Promise<void>;
  unblockUserGlobal(blockerUsername: string, targetUsername: string): Promise<void>;
  isBlockedGlobal(blockerUsername: string, targetUsername: string): Promise<boolean>;
  getBlockedUsers(blockerUsername: string): Promise<string[]>;
  isGlobalAdmin(userId: string): Promise<boolean>;
  setGlobalAdmin(userId: string, isAdmin: boolean): Promise<void>;
  setTransferPin(username: string, hashedPin: string): Promise<void>;
  getTransferPin(username: string): Promise<string | null>;

  // Feed / Wall Posts
  getFeedPosts(userId: string, limit?: number, offset?: number): Promise<{ posts: WallPost[]; hasMore: boolean }>;
  getWallPosts(userId: string, limit?: number, offset?: number): Promise<{ posts: WallPost[]; hasMore: boolean }>;
  getWallPost(id: string): Promise<WallPost | undefined>;
  createWallPost(data: { userId: string; authorUserId: string; authorUsername: string; comment: string; imageUrl?: string | null; videoUrl?: string | null; mediaType?: string; type?: number; repostId?: string | null; repostAuthorUsername?: string | null; repostComment?: string | null }): Promise<WallPost>;
  likeWallPost(id: string): Promise<WallPost | undefined>;
  dislikeWallPost(id: string): Promise<WallPost | undefined>;
  removeWallPost(id: string): Promise<void>;
  getPostComments(postId: string): Promise<PostComment[]>;
  createPostComment(data: { postId: string; authorUserId: string; authorUsername: string; text: string }): Promise<PostComment>;

  // Chatrooms
  getChatrooms(): Promise<Chatroom[]>;
  getChatroomsByCategory(categoryId: number): Promise<Chatroom[]>;
  getChatroom(id: string): Promise<Chatroom | undefined>;
  getChatroomByName(name: string): Promise<Chatroom | undefined>;
  createChatroom(data: InsertChatroom & { createdBy?: string }): Promise<Chatroom>;
  deleteChatroom(id: string): Promise<void>;
  updateChatroom(id: string, updates: Partial<Chatroom>): Promise<Chatroom | undefined>;
  getMessages(chatroomId: string, opts?: { after?: string; before?: string; limit?: number }): Promise<ChatroomMessage[]>;
  getMessagesSince(chatroomId: string, sinceMs: number): Promise<ChatroomMessage[]>;
  postMessage(chatroomId: string, msg: { senderId?: string; senderUsername: string; senderColor: string; text: string; isSystem?: boolean }): Promise<ChatroomMessage>;
  getParticipants(chatroomId: string): Promise<ChatParticipant[]>;
  getActiveRoomsByUser(userId: string): Promise<{ room: Chatroom; participantCount: number }[]>;
  joinChatroom(chatroomId: string, user: { id: string; username: string; displayName: string; color: string }): Promise<void>;
  leaveChatroom(chatroomId: string, userId: string): Promise<void>;
  banUser(chatroomId: string, userId: string): Promise<void>;
  unbanUser(chatroomId: string, userId: string): Promise<void>;
  isBanned(chatroomId: string, userId: string): Promise<boolean>;
  muteUser(chatroomId: string, userId: string): Promise<void>;
  silenceUser(chatroomId: string, userId: string, username: string, timeoutSecs: number): Promise<void>;
  unmuteUser(chatroomId: string, userId: string): Promise<void>;
  isMuted(chatroomId: string, userId: string): Promise<boolean>;
  modUser(chatroomId: string, userId: string): Promise<void>;
  unmodUser(chatroomId: string, userId: string): Promise<void>;
  isModUser(chatroomId: string, userId: string): Promise<boolean>;
  bumpUser(chatroomId: string, userId: string): Promise<void>;
  isSuspended(userId: string): Promise<boolean>;
  suspendUser(userId: string): Promise<void>;
  unsuspendUser(userId: string): Promise<void>;

  // Chatroom — Favourites (mirrors getFavouriteChatRooms in ChatRoomDAO.java)
  getFavouriteChatrooms(userId: string): Promise<Chatroom[]>;
  addFavouriteChatroom(userId: string, chatroomId: string): Promise<void>;
  removeFavouriteChatroom(userId: string, chatroomId: string): Promise<void>;
  isFavouriteChatroom(userId: string, chatroomId: string): Promise<boolean>;

  // Chatroom — Recent (mirrors getAllRecentChatRooms / getRecentChatRooms in ChatRoomDAO.java)
  getRecentChatrooms(userId: string): Promise<Chatroom[]>;
  addRecentChatroom(userId: string, chatroomId: string): Promise<void>;

  // Chatroom — Moderator & Banned lists (mirrors getChatRoomModerators / getChatRoomBannedUsers)
  getChatroomModerators(chatroomId: string): Promise<{ userId: string; username: string }[]>;
  getChatroomBannedUsers(chatroomId: string): Promise<{ userId: string; username: string }[]>;

  // Rooms (user-owned)
  getRooms(): Promise<Room[]>;
  getRoomsByOwner(ownerId: string): Promise<Room[]>;
  getRoom(id: string): Promise<Room | undefined>;
  createRoom(data: InsertRoom & { ownerId: string; ownerUsername: string }): Promise<Room>;
  updateRoom(id: string, updates: Partial<Room>): Promise<Room | undefined>;
  deleteRoom(id: string): Promise<void>;

  // Lost Contacts
  getLostContacts(userId: string): Promise<LostContact[]>;
  getLostContact(id: string): Promise<LostContact | undefined>;
  createLostContact(data: InsertLostContact & { userId: string }): Promise<LostContact>;
  updateLostContactStatus(id: string, status: number): Promise<LostContact | undefined>;
  deleteLostContact(id: string): Promise<void>;

  // Merchants
  getMerchants(): Promise<Merchant[]>;
  getMerchantByUsername(username: string): Promise<Merchant | undefined>;
  createMerchant(data: InsertMerchant): Promise<Merchant>;
  updateMerchant(username: string, updates: Partial<Merchant>): Promise<Merchant | undefined>;
  updateMerchantColorType(username: string, colorType: number): Promise<Merchant | undefined>;
  getMerchantLocations(merchantUsername: string): Promise<MerchantLocation[]>;
  getMerchantLocationsByCountryId(countryId: number, offset: number, limit: number): Promise<MerchantLocation[]>;
  getMerchantLocationsByCountryName(countryName: string, offset: number, limit: number): Promise<MerchantLocation[]>;
  getCountriesWithMerchants(): Promise<Array<{ countryId: number | null; country: string | null; count: number }>>;
  createMerchantLocation(data: InsertMerchantLocation): Promise<MerchantLocation>;
  addMerchantPoints(merchantUsername: string, userId: string, points: number, entryType?: number, reason?: string): Promise<{ merchantUsername: string; userId: string; points: number; reason?: string }>;
  getUserMerchantPoints(merchantUsername: string, userId: string): Promise<number>;
  getMerchantPointsHistory(merchantUsername: string, userId: string): Promise<MerchantPoint[]>;

  // Merchant Tags
  getMerchantTags(filter: { merchantUsername?: string; taggedUsername?: string; type?: number; page?: number; numRecords?: number }): Promise<MerchantTag[]>;
  getMerchantTag(id: string): Promise<MerchantTag | undefined>;
  getMerchantTagByUsername(taggedUsername: string): Promise<MerchantTag | undefined>;
  getExpiringMerchantTags(merchantUsername: string, daysAhead: number): Promise<MerchantTag[]>;
  createMerchantTag(data: InsertMerchantTag & { expiry?: Date }): Promise<MerchantTag>;
  removeMerchantTag(id: string): Promise<void>;

  // Discovery / Recommendations
  getRecommendedUsers(userId: string): Promise<Partial<User>[]>;

  // Credit — Account Balance
  getCreditAccount(username: string): Promise<CreditAccount>;
  adjustBalance(username: string, amount: number, currency?: string): Promise<CreditAccount>;
  setBalance(username: string, balance: number, currency?: string): Promise<CreditAccount>;
  listCreditAccounts(opts?: { search?: string; limit?: number }): Promise<CreditAccount[]>;

  // Credit — Transactions
  getCreditTransactions(username: string, limit?: number): Promise<CreditTransaction[]>;
  createCreditTransaction(data: Omit<CreditTransaction, "id" | "createdAt">): Promise<CreditTransaction>;
  getCreditTransaction(id: string): Promise<CreditTransaction | undefined>;

  // Credit — Transfer
  transferCredit(fromUsername: string, toUsername: string, amount: number, feeType?: number): Promise<{ from: CreditAccount; to: CreditAccount; fee: number }>;

  // Credit — Vouchers
  getVoucherBatches(username?: string): Promise<VoucherBatch[]>;
  getVoucherBatch(id: string): Promise<VoucherBatch | undefined>;
  createVoucherBatch(data: InsertVoucherBatch & { createdByUsername: string }): Promise<{ batch: VoucherBatch; vouchers: Voucher[] }>;
  getVouchers(batchId: string): Promise<Voucher[]>;
  redeemVoucher(code: string, username: string): Promise<Voucher>;
  cancelVoucher(id: string): Promise<Voucher | undefined>;

  // Credit — Reward Programs
  getRewardPrograms(): Promise<RewardProgram[]>;
  getRewardProgram(id: string): Promise<RewardProgram | undefined>;
  createRewardProgram(data: InsertRewardProgram): Promise<RewardProgram>;
  updateRewardProgram(id: string, updates: Partial<RewardProgram>): Promise<RewardProgram | undefined>;

  // Credit — User Reward History
  getUserRewardHistory(username: string): Promise<UserRewardHistory[]>;
  addUserReward(data: Omit<UserRewardHistory, "id" | "createdAt">): Promise<UserRewardHistory>;

  // Virtual Gifts catalog
  // Mirrors ContentBean.java: getVirtualGift(), searchVirtualGifts()
  getVirtualGifts(): Promise<VirtualGift[]>;
  getVirtualGiftByName(name: string): Promise<VirtualGift | undefined>;
  searchVirtualGifts(query: string, limit?: number): Promise<VirtualGift[]>;
  updateGiftImage(name: string, imageUrl: string | null): Promise<void>;
  // Mirrors ContentBean.java: buyVirtualGiftForMultipleUsers()
  createVirtualGiftReceived(data: InsertVirtualGiftReceived): Promise<VirtualGiftReceived>;

  // EmoAndSticker — sticker lookup by alias
  // Mirrors ContentBean.java: getStickerDataByNameForUser(username, stickerName)
  getEmoticonByAlias(alias: string): Promise<Emoticon | undefined>;

  // Bot (mirrors BotDAO.java / FusionDbBotDAOChain.java)
  getBot(id: number): Promise<Bot | undefined>;
  getBots(activeOnly?: boolean): Promise<Bot[]>;
  getBotConfigs(botId: number): Promise<BotConfig[]>;
  createBot(data: InsertBot): Promise<Bot>;
  updateBot(id: number, updates: Partial<Bot>): Promise<Bot | undefined>;
  deleteBot(id: number): Promise<void>;

  // EmoAndSticker (mirrors EmoAndStickerDAO.java / FusionDbEmoAndStickerDAOChain.java)
  getEmoticonPacks(activeOnly?: boolean): Promise<EmoticonPack[]>;
  getEmoticonPack(id: number): Promise<EmoticonPack | undefined>;
  getEmoticons(packId?: number): Promise<Emoticon[]>;
  getEmoticonHeights(): Promise<number[]>;
  getOptimalEmoticonHeight(fontHeight: number): Promise<number>;
  createEmoticonPack(data: InsertEmoticonPack): Promise<EmoticonPack>;
  updateEmoticonPack(id: number, updates: Partial<EmoticonPack>): Promise<EmoticonPack | undefined>;
  createEmoticon(data: InsertEmoticon): Promise<Emoticon>;
  updateEmoticon(id: number, updates: Partial<Emoticon>): Promise<Emoticon | undefined>;
  deleteEmoticon(id: number): Promise<void>;

  // Guardset (mirrors GuardsetDAO.java / FusionDbGuardsetDAOChain.java)
  getMinimumClientVersionForAccess(clientType: number, guardCapability: number): Promise<number | null>;
  setGuardsetRule(clientType: number, guardCapability: number, minVersion: number, description?: string): Promise<GuardsetRule>;
  getGuardsetRules(): Promise<GuardsetRule[]>;
  deleteGuardsetRule(id: number): Promise<void>;

  // Message (mirrors MessageDAOChain.java / FusionDbMessageDAOChain.java)
  // SQL: SELECT * FROM clienttext WHERE type = 1
  loadHelpTexts(): Promise<Record<number, string>>;
  // SQL: SELECT * FROM clienttext WHERE type = 2
  loadInfoTexts(): Promise<Record<number, string>>;
  // SQL: SELECT * FROM clienttext WHERE id = ?
  getInfoText(infoId: number): Promise<string | undefined>;
  // CRUD for client_texts
  createClientText(data: InsertClientText): Promise<ClientText>;
  updateClientText(id: number, updates: Partial<ClientText>): Promise<ClientText | undefined>;
  deleteClientText(id: number): Promise<void>;
  getClientTexts(): Promise<ClientText[]>;

  // SQL: SELECT * FROM alertmessage WHERE MinMidletVersion<=? AND MaxMidletVersion>=?
  //   AND Type=? AND (CountryID=? OR CountryID IS NULL) AND StartDate<=now() AND ExpiryDate>now()
  //   AND Status=? AND clientType=? [AND ContentType=?] ORDER BY CountryID
  getLatestAlertMessages(params: {
    midletVersion: number;
    type: number;
    countryId: number;
    contentType?: number;
    clientType: number;
  }): Promise<AlertMessage[]>;
  createAlertMessage(data: InsertAlertMessage): Promise<AlertMessage>;
  updateAlertMessage(id: number, updates: Partial<AlertMessage>): Promise<AlertMessage | undefined>;
  deleteAlertMessage(id: number): Promise<void>;
  getAlertMessages(status?: number): Promise<AlertMessage[]>;

  // Group (mirrors GroupDAOChain.java / FusionDbGroupDAOChain.java)
  // SQL: SELECT groups.* FROM groups LEFT JOIN service ... WHERE groups.id=? AND groups.status=1
  getGroup(groupId: number): Promise<Group | undefined>;
  getGroups(status?: number): Promise<Group[]>;
  createGroup(data: InsertGroup): Promise<Group>;
  updateGroup(id: number, updates: Partial<Group>): Promise<Group | undefined>;
  deleteGroup(id: number): Promise<void>;

  // SQL: SELECT gm.username FROM groupmember WHERE groupid=? AND status=ACTIVE AND type=MODERATOR
  getModeratorUserNames(groupId: number): Promise<string[]>;
  // Group members CRUD
  getGroupMembers(groupId: number, status?: number): Promise<GroupMember[]>;
  getGroupMembersByUsername(username: string): Promise<GroupMember[]>;
  addGroupMember(data: InsertGroupMember): Promise<GroupMember>;
  updateGroupMember(id: number, updates: Partial<GroupMember>): Promise<GroupMember | undefined>;
  removeGroupMember(id: number): Promise<void>;

  // Email Bounce (mirrors EmailDAOChain.java / FusionDbEmailDAOChain.java)
  // SQL: SELECT bounceType FROM bouncedb WHERE emailaddress = ? LIMIT 1
  // Returns true = email is bounced/blacklisted, false = email is safe to send
  isBounceEmailAddress(email: string): Promise<boolean>;
  addBounceEmail(email: string, bounceType?: string): Promise<void>;
  removeBounceEmail(email: string): Promise<void>;
  listBounceEmails(limit?: number, offset?: number): Promise<{ email: string; bounceType: string; createdAt: Date }[]>;

  // Campaign (mirrors CampaignDataDAOChain.java / FusionDbCampaignDataDAOChain.java)
  // SQL: SELECT * FROM campaign WHERE id = ?
  getCampaign(campaignId: number): Promise<Campaign | undefined>;
  getCampaigns(activeOnly?: boolean): Promise<Campaign[]>;
  createCampaign(data: InsertCampaign): Promise<Campaign>;
  updateCampaign(id: number, updates: Partial<Campaign>): Promise<Campaign | undefined>;
  deleteCampaign(id: number): Promise<void>;

  // SQL: SELECT * FROM campaignparticipant WHERE campaignid = ? AND userid = ?
  getCampaignParticipant(userId: string, campaignId: number): Promise<CampaignParticipant | undefined>;
  // SQL: SELECT cp.* FROM campaignparticipant cp JOIN campaign c ... WHERE c.type=? AND cp.userid=? AND c.status=1 AND now() BETWEEN startdate AND enddate
  getActiveCampaignParticipants(userId: string, type?: number): Promise<CampaignParticipant[]>;
  // SQL: SELECT * FROM campaignparticipant WHERE campaignid = ? AND mobilephone = ?
  getCampaignParticipantByMobile(mobilePhone: string, campaignId: number): Promise<CampaignParticipant | undefined>;
  // SQL: INSERT INTO campaignparticipant (campaignid, userid, mobilephone, emailaddress, reference)
  joinCampaign(data: InsertCampaignParticipant): Promise<CampaignParticipant>;
  getCampaignParticipants(campaignId: number): Promise<CampaignParticipant[]>;

  // ── Leaderboard (mirrors com/projectgoth/fusion/leaderboard/Leaderboard.java) ─
  getLeaderboard(type: string, period: string, limit: number, offset: number): Promise<LeaderboardEntry[]>;
  getLeaderboardRank(type: string, period: string, username: string): Promise<{ score: number; position: number } | null>;
  upsertLeaderboardEntry(type: string, period: string, username: string, score: number, increment: boolean): Promise<LeaderboardEntry>;
  resetLeaderboard(type: string, period: string, previousPeriod: string): Promise<void>;

  // ── Invitation (mirrors com/projectgoth/fusion/invitation/) ──────────────────
  createInvitation(data: InsertInvitation): Promise<Invitation>;
  getInvitationById(id: string): Promise<Invitation | undefined>;
  getInvitationsBySender(username: string, limit: number): Promise<Invitation[]>;
  getInvitationsByDestination(destination: string): Promise<Invitation[]>;
  updateInvitationStatus(id: string, status: number): Promise<Invitation | undefined>;
  expireOldInvitations(): Promise<number>;

  // ── Reputation (mirrors com/projectgoth/fusion/reputation/) ──────────────────
  getUserReputation(username: string): Promise<UserReputationRow | undefined>;
  createUserReputation(username: string): Promise<UserReputationRow>;
  incrementReputationScore(username: string, amount: number): Promise<UserReputationRow>;
  updateReputationLevel(username: string, level: number): Promise<void>;
  updateReputationMetrics(username: string, metrics: Partial<Omit<UserReputationRow, "id" | "username" | "updatedAt">>): Promise<UserReputationRow>;
  getTopReputationUsers(limit: number, offset: number): Promise<UserReputationRow[]>;

  // ── Reputation Level Table (mirrors ReputationScoreToLevel + LevelTable.java) ─
  // SELECT score, level FROM ReputationScoreToLevel ORDER BY score DESC
  getLevelTable(): Promise<LevelThreshold[]>;
  // Mirrors LevelTable.getLevelDataForScore() — floor lookup: highest level where score >= threshold
  getLevelDataForScore(score: number): Promise<LevelThreshold | undefined>;
  // Upsert a single level threshold entry (admin)
  upsertLevelThreshold(data: InsertLevelThreshold): Promise<LevelThreshold>;
  // Delete a level threshold entry (admin)
  deleteLevelThreshold(level: number): Promise<void>;

  // ── Payment (mirrors com/projectgoth/fusion/payment/) ────────────────────────
  createPayment(data: InsertPayment): Promise<Payment>;
  getPaymentById(id: number): Promise<Payment | undefined>;
  getPaymentsByUsername(username: string, limit: number, status?: number): Promise<Payment[]>;
  updatePaymentStatus(id: number, status: number, vendorTransactionId?: string): Promise<Payment | undefined>;

  // ── Search (mirrors com/projectgoth/fusion/search/) ───────────────────────────
  searchUsers(query: string, limit?: number, offset?: number): Promise<Partial<User>[]>;
  searchChatrooms(query: string, limit?: number, offset?: number, categoryId?: number, language?: string): Promise<Chatroom[]>;
  searchGroups(query: string, limit: number): Promise<Group[]>;
  searchMerchants(query: string, limit: number): Promise<Merchant[]>;
  getAllChatroomsForIndex(): Promise<Chatroom[]>;

  // ── UserEvent (mirrors com/projectgoth/fusion/userevent/) ─────────────────────
  // CreateEventForUser.java: create an event for a user
  createUserEvent(data: InsertUserEvent): Promise<UserEvent>;
  // DumpEvents.java / ShowEventsForUser.java: get events received by a user
  getUserEvents(username: string, limit: number, eventType?: string, since?: Date): Promise<UserEvent[]>;
  // ShowEventsGeneratedByUser.java: get events generated/sent by a user
  getUserEventsGeneratedByUser(generatingUsername: string, limit: number, eventType?: string, since?: Date): Promise<UserEvent[]>;
  // DumpGeneratorEvents.java: get generator events (most recent N)
  getGeneratorEvents(count: number): Promise<UserEvent[]>;
  // DeleteEventsForUser.java
  deleteUserEvents(username: string): Promise<number>;
  deleteUserEventsByType(username: string, eventType: string): Promise<number>;
  getUserEventStats(username: string): Promise<Record<string, number>>;
  // ShowPrivacySettings.java / ModifyPrivacySettings.java: privacy mask CRUD
  getPrivacySettings(username: string): Promise<UserEventPrivacy>;
  setReceivingPrivacyMask(username: string, mask: Partial<ReceivingPrivacyMask>): Promise<UserEventPrivacy>;
  setPublishingPrivacyMask(username: string, mask: Partial<PublishingPrivacyMask>): Promise<UserEventPrivacy>;

  // ── Full Privacy Settings (SettingsProfileDetailsData + SettingsAccountCommunicationData + EventPrivacySetting) ─
  getUserPrivacySettings(username: string): Promise<UserPrivacySettings>;
  updateUserPrivacySettings(username: string, updates: Partial<Omit<UserPrivacySettings, 'id' | 'username' | 'updatedAt'>>): Promise<UserPrivacySettings>;

  // ── User Settings (mirrors UserSettingData / SettingsResource.java) ──────────
  // SQL: SELECT * FROM usersetting WHERE username = ?
  getUserSettings(username: string): Promise<UserSetting[]>;
  // SQL: SELECT * FROM usersetting WHERE username = ? AND type = ?
  getUserSetting(username: string, type: number): Promise<UserSetting | undefined>;
  // SQL: INSERT INTO usersetting ... ON CONFLICT (username, type) DO UPDATE SET value = ?
  upsertUserSetting(username: string, type: number, value: number): Promise<UserSetting>;

  // ── Diamond Balance ────────────────────────────────────────────────────────
  getDiamondBalance(username: string): Promise<number>;
  getDiamondTotalEarned(username: string): Promise<number>;
  getDiamondTotalWithdrawn(username: string): Promise<number>;
  adjustDiamondBalance(username: string, amount: number, type: string, description: string, reference?: string): Promise<number>;
  getDiamondTransactions(username: string, limit?: number, offset?: number): Promise<{ id: string; amount: number; type: string; reference: string | null; description: string | null; runningBalance: number; createdAt: Date }[]>;

  // ── FashionShow (mirrors com/projectgoth/fusion/fashionshow/) ─────────────────
  getFashionShowCandidates(limit: number, offset: number): Promise<FashionShowSession[]>;
  getFashionShowWinners(limit: number): Promise<FashionShowSession[]>;
  getFashionShowByUsername(username: string): Promise<FashionShowSession | undefined>;
  getFashionShowById(id: string): Promise<FashionShowSession | undefined>;
  createFashionShowSession(data: InsertFashionShowSession): Promise<FashionShowSession>;
  incrementFashionShowVotes(id: string): Promise<FashionShowSession>;

  // ── PaintWars (mirrors com/projectgoth/fusion/paintwars/) ─────────────────────
  getPaintwarsStats(username: string): Promise<PaintwarsStats | undefined>;
  createPaintwarsStats(username: string): Promise<PaintwarsStats>;
  recordPaint(painterUsername: string, targetUsername: string, paid: boolean): Promise<{ painter: PaintwarsStats; target: PaintwarsStats }>;
  recordClean(cleanerUsername: string, targetUsername: string, paid: boolean): Promise<{ cleaner: PaintwarsStats; target: PaintwarsStats }>;
  resetDailyPaintwarsAllowances(paintsPerDay: number, cleansPerDay: number): Promise<number>;
  getPaintwarsLeaderboard(limit: number): Promise<PaintwarsStats[]>;

  // ── SMS Engine (mirrors com/projectgoth/fusion/smsengine/) ────────────────────
  createSmsMessage(data: InsertSmsMessage): Promise<SmsMessage>;
  getSmsMessageById(id: number): Promise<SmsMessage | undefined>;
  getSmsHistory(phoneNumber?: string, username?: string, limit?: number): Promise<SmsMessage[]>;
  updateSmsStatus(id: number, status: number): Promise<SmsMessage | undefined>;
  retryPendingSmsMessages(): Promise<number>;
  getPendingSmsMessages(limit: number): Promise<SmsMessage[]>;

  // ── Voice Engine (mirrors com/projectgoth/fusion/voiceengine/) ────────────────
  createVoiceCall(data: InsertVoiceCall): Promise<VoiceCall>;
  getVoiceCallById(id: string): Promise<VoiceCall | undefined>;
  updateVoiceCallStatus(id: string, status: number, duration?: number, endedAt?: Date): Promise<VoiceCall | undefined>;
  getVoiceCallHistory(username: string, limit: number, type: "caller" | "callee" | "all"): Promise<VoiceCall[]>;

  // ── Image Server (mirrors com/projectgoth/fusion/imageserver/) ────────────────
  storeImage(data: InsertServerImage): Promise<ServerImage>;
  getImageById(id: string): Promise<ServerImage | undefined>;
  getImageByKey(imageKey: string): Promise<ServerImage | undefined>;
  deleteImage(id: string): Promise<boolean>;
  getImagesByUsername(username: string, limit: number): Promise<ServerImage[]>;
  getImageServerStats(): Promise<{ totalImages: number; totalSizeBytes: number }>;

  // ── Notifications / UNS (mirrors com/projectgoth/fusion/uns/) ─────────────────
  createNotification(data: InsertNotification): Promise<Notification>;
  getNotifications(username: string, limit: number, type?: string, status?: number): Promise<Notification[]>;
  updateNotificationStatus(id: string, status: number): Promise<Notification | undefined>;
  getPendingNotifications(limit: number): Promise<Notification[]>;
  // Group member notification lookups — mirrors GroupMembershipDAO.java methods
  getGroupMembersForEmailNotification(groupId: number): Promise<string[]>;
  getGroupMembersForSMSNotification(groupId: number): Promise<{ username: string; mobileNumber: string }[]>;
  getGroupMembersForGroupEventSMSNotification(groupId: number): Promise<{ username: string; mobileNumber: string }[]>;
  getGroupMembersForGroupEventAlertNotification(groupId: number): Promise<string[]>;
  getGroupPostSubscribersForEmail(userPostId: number): Promise<string[]>;
  // User phone lookup — mirrors UserDAO.getMobileNumberForUser(username)
  getMobileNumberForUser(username: string): Promise<string | null>;
  // Notification bulk ops — mirror Redis hash ops in UserNotificationServiceI
  getNotificationCountByType(username: string): Promise<Record<string, number>>;
  deleteAllNotificationsByType(username: string, notfnType: string): Promise<Notification[]>;
  deleteNotificationsByIds(ids: string[]): Promise<Notification[]>;
  purgeOldNotifications(username: string, maxCount: number, truncateTo: number): Promise<number>;

  // ── Message Switchboard (mirrors com/projectgoth/fusion/messageswitchboard/) ──
  createSwitchboardMessage(data: InsertSwitchboardMessage): Promise<SwitchboardMessage>;
  getPendingSwitchboardMessages(username: string, limit: number, messageType?: string): Promise<SwitchboardMessage[]>;
  updateSwitchboardMessageStatus(id: string, status: number): Promise<SwitchboardMessage | undefined>;
  clearDeliveredSwitchboardMessages(username: string): Promise<number>;
  getSwitchboardStats(): Promise<{ queued: number; delivered: number; failed: number }>;
  flushSwitchboardMessages(): Promise<number>;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function pickColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return CHATROOM_COLORS[Math.abs(hash) % CHATROOM_COLORS.length];
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

// ─── SEED DATA ────────────────────────────────────────────────────────────────

const SEED_CHATROOMS: (Omit<Chatroom, "id" | "createdAt"> & { seedMessages: { user: string; color: string; text: string; ago: number }[] })[] = [
  {
    name: "Indonesia", description: "Obrolan umum Indonesia", categoryId: 8,
    currentParticipants: 18, maxParticipants: 25, color: "#4CAF50",
    language: "id", allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "budi123",  color: "#9C27B0", text: "Halo semua! Siapa yang online pagi ini?",       ago: 25 },
      { user: "siti_jkt", color: "#F44336", text: "Aku online nih, baru bangun 😄",                ago: 22 },
      { user: "andi_bdg", color: "#FF9800", text: "Selamat pagi teman-teman!",                    ago: 20 },
      { user: "rina99",   color: "#795548", text: "Pagi semua, cuaca hari ini cerah banget",      ago: 18 },
      { user: "budi123",  color: "#9C27B0", text: "Ada berita apa hari ini guys?",               ago: 15 },
      { user: "siti_jkt", color: "#F44336", text: "Udah pada sarapan belum?",                    ago: 12 },
      { user: "andi_bdg", color: "#FF9800", text: "Belum, masih nyari warung yang buka 😅",      ago: 10 },
      { user: "rina99",   color: "#795548", text: "Warung nasi uduk deket sini udah buka jam 5", ago: 8  },
      { user: "budi123",  color: "#9C27B0", text: "Wah jauh dari sini 😂",                       ago: 5  },
      { user: "siti_jkt", color: "#F44336", text: "Haha sama, tinggal order ojol aja",           ago: 2  },
    ],
  },
  {
    name: "Bandung Corner", description: "Komunitas Bandung", categoryId: 8,
    currentParticipants: 14, maxParticipants: 25, color: "#9C27B0",
    language: "id", allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "kang_asep", color: "#4CAF50", text: "Kumaha damang?",                    ago: 30 },
      { user: "teteh_uni", color: "#FF9800", text: "Alhamdulillah, sehat kang",          ago: 28 },
      { user: "kang_asep", color: "#4CAF50", text: "Malam minggu ieu rencananya kamana?",ago: 20 },
      { user: "teh_rina",  color: "#F44336", text: "Ka Dago tea walk gening",            ago: 15 },
      { user: "teteh_uni", color: "#FF9800", text: "Asiik, hayu atuh!",                  ago: 5  },
    ],
  },
  {
    name: "Jakarta Chat", description: "Obrolan warga Jakarta", categoryId: 8,
    currentParticipants: 23, maxParticipants: 25, color: "#F44336",
    language: "id", allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "jkt_boy",  color: "#4CAF50", text: "Macet banget hari ini di TB Simatupang",  ago: 40 },
      { user: "beti_jkt", color: "#9C27B0", text: "Biasalah, hari senin emang paling parah", ago: 35 },
      { user: "jkt_boy",  color: "#4CAF50", text: "Duh 2 jam di jalan buat 10km 😭",         ago: 30 },
      { user: "oman_dpk", color: "#FF9800", text: "Mending naik MRT aja bro",               ago: 20 },
      { user: "beti_jkt", color: "#9C27B0", text: "Setuju! Hemat waktu banget",             ago: 10 },
      { user: "jkt_boy",  color: "#4CAF50", text: "Iya sih, besok nyoba MRT deh",           ago: 3  },
    ],
  },
  {
    name: "Mig33 Global", description: "International chat", categoryId: 8,
    currentParticipants: 24, maxParticipants: 25, color: "#FF9800",
    language: "en", allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "user_pk",   color: "#4CAF50", text: "Hello everyone!",                           ago: 60 },
      { user: "migfan_my", color: "#9C27B0", text: "Hi! How is everyone doing today?",          ago: 55 },
      { user: "user_pk",   color: "#4CAF50", text: "Good! Enjoying the cool weather",           ago: 50 },
      { user: "migfan_my", color: "#9C27B0", text: "Nice! Wish we had cool weather here too 😄",ago: 40 },
      { user: "indo_guy",  color: "#F44336", text: "Same lol, too hot here",                   ago: 30 },
    ],
  },
  {
    name: "Game Talk", description: "Diskusi game seru", categoryId: 7,
    currentParticipants: 19, maxParticipants: 25, color: "#795548",
    language: "id", allowKick: false, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "gamer_pro", color: "#4CAF50", text: "Ada yang main Genshin Impact ga?",     ago: 45 },
      { user: "axel_ml",   color: "#9C27B0", text: "Aku main, rank berapa kamu?",          ago: 40 },
      { user: "gamer_pro", color: "#4CAF50", text: "AR 55 bro, udah end game",            ago: 35 },
      { user: "reza_ff",   color: "#FF9800", text: "Lebih seru FF lah hehe",              ago: 25 },
      { user: "axel_ml",   color: "#9C27B0", text: "Wkwk beda selera beda game",          ago: 10 },
    ],
  },
  {
    name: "Mobile Legends", description: "Komunitas MLBB", categoryId: 7,
    currentParticipants: 21, maxParticipants: 25, color: "#9C27B0",
    language: "id", allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "ml_legend", color: "#4CAF50", text: "Rank season berapa sekarang?",          ago: 50 },
      { user: "fanny_top", color: "#F44336", text: "Season 30 udah rilis belum?",           ago: 45 },
      { user: "ml_legend", color: "#4CAF50", text: "Belum, masih S29",                     ago: 40 },
      { user: "tank_hero", color: "#FF9800", text: "Siapa hero meta sekarang?",             ago: 30 },
      { user: "fanny_top", color: "#F44336", text: "Fanny sama Ling masih kuat",            ago: 20 },
      { user: "ml_legend", color: "#4CAF50", text: "Setuju, marksman juga Beatrix OP",     ago: 5  },
    ],
  },
  {
    name: "Free Fire", description: "FF squad wanted", categoryId: 7,
    currentParticipants: 22, maxParticipants: 25, color: "#F44336",
    language: "id", allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "ff_sultan", color: "#9C27B0", text: "LF squad ranked, min gold 3",         ago: 60 },
      { user: "booyah99",  color: "#4CAF50", text: "Aku join! Main apa karakter nya?",     ago: 50 },
      { user: "ff_sultan", color: "#9C27B0", text: "Aku Chrono, lu pake apa?",            ago: 40 },
      { user: "booyah99",  color: "#4CAF50", text: "K character + DJ Alok combo",         ago: 30 },
      { user: "sniper_ff", color: "#FF9800", text: "Auto booyah nih squad nya",           ago: 15 },
    ],
  },
  {
    name: "Find Friends", description: "Cari teman baru di sini!", categoryId: 4,
    currentParticipants: 11, maxParticipants: 25, color: "#4CAF50",
    language: "id", allowKick: false, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "lonelyboy",  color: "#9C27B0", text: "Halo, ada yang mau berteman?",               ago: 90 },
      { user: "friendly_g", color: "#FF9800", text: "Aku! Perkenalkan, aku Gita dari Surabaya",   ago: 80 },
      { user: "lonelyboy",  color: "#9C27B0", text: "Hai Gita! Aku Doni dari Medan",              ago: 75 },
      { user: "friendly_g", color: "#FF9800", text: "Wah jauh juga ya, hehe",                    ago: 60 },
      { user: "lonelyboy",  color: "#9C27B0", text: "Iya, tapi di mig33 kita bisa tetap terhubung 😊", ago: 45 },
    ],
  },
  {
    name: "Jodoh Indo", description: "Cari jodoh di sini", categoryId: 4,
    currentParticipants: 17, maxParticipants: 25, color: "#FF9800",
    language: "id", allowKick: true, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "cari_jodoh", color: "#4CAF50", text: "Halo, ada yang single disini?",   ago: 120 },
      { user: "bunga_sari",  color: "#9C27B0", text: "Aku single! Kamu dari mana?",   ago: 110 },
      { user: "cari_jodoh", color: "#4CAF50", text: "Dari Yogyakarta, kamu?",          ago: 100 },
      { user: "bunga_sari",  color: "#9C27B0", text: "Aku dari Solo! Deket dong",     ago: 90  },
    ],
  },
  {
    name: "Help Desk", description: "Ada masalah? Tanya di sini!", categoryId: 6,
    currentParticipants: 5, maxParticipants: 25, color: "#4CAF50",
    language: "id", allowKick: false, isLocked: false, adultOnly: false, userOwned: false, type: 1, status: 1, createdBy: null,
    seedMessages: [
      { user: "admin_mig", color: "#4CAF50", text: "Selamat datang di Help Desk! Ada yang butuh bantuan?", ago: 300 },
      { user: "user_baru", color: "#FF9800", text: "Kak, bagaimana cara ganti foto profil?",    ago: 280 },
      { user: "admin_mig", color: "#4CAF50", text: "Bisa lewat menu Profil > Edit Profil kak 😊",ago: 270 },
      { user: "user_baru", color: "#FF9800", text: "Oh oke, makasih kak!",                       ago: 265 },
      { user: "admin_mig", color: "#4CAF50", text: "Sama-sama! Ada yang lain?",                 ago: 260 },
    ],
  },
];

const SEED_MERCHANTS = [
  { username: "tokobaju_id",  displayName: "Toko Baju Indonesia",  category: "fashion",    description: "Pakaian berkualitas harga terjangkau",  usernameColor: "#4CAF50" },
  { username: "warungmakan",  displayName: "Warung Makan Enak",    category: "food",       description: "Masakan rumahan yang lezat",             usernameColor: "#FF9800" },
  { username: "gadget_store", displayName: "Gadget Store",         category: "electronics",description: "Gadget original harga terbaik",          usernameColor: "#9C27B0" },
];

// ─── MEMORY STORAGE ────────────────────────────────────────────────────────────


// Seed reward programs
const SEED_REWARD_PROGRAMS: Omit<RewardProgram, "id" | "createdAt">[] = [
  {
    name: "First Login Bonus",
    description: "Bonus Credits untuk login pertama kali",
    type: 3, category: 5, countryId: null, minMigLevel: 1, maxMigLevel: null,
    quantityRequired: 1, amountRequired: null, amountRequiredCurrency: null,
    migCreditReward: 10, migCreditRewardCurrency: "IDR",
    scoreReward: 5, levelReward: null, status: 1,
    startDate: null, endDate: null,
  },
  {
    name: "Referral Reward",
    description: "Dapat 20 Credits setiap berhasil referral user baru",
    type: 1, category: 1, countryId: null, minMigLevel: 1, maxMigLevel: null,
    quantityRequired: 1, amountRequired: null, amountRequiredCurrency: null,
    migCreditReward: 20, migCreditRewardCurrency: "IDR",
    scoreReward: 10, levelReward: null, status: 1,
    startDate: null, endDate: null,
  },
  {
    name: "Active Chatter",
    description: "Kirim 50 pesan di chatroom, dapat bonus credit",
    type: 1, category: 4, countryId: null, minMigLevel: 1, maxMigLevel: null,
    quantityRequired: 50, amountRequired: null, amountRequiredCurrency: null,
    migCreditReward: 15, migCreditRewardCurrency: "IDR",
    scoreReward: 20, levelReward: 1, status: 1,
    startDate: null, endDate: null,
  },
];

export class MemStorage implements IStorage {
  private users: Map<string, User> = new Map();
  private userProfiles: Map<string, UserProfile> = new Map();
  private wallPostsMap: Map<string, WallPost> = new Map();
  private postCommentsMap: Map<string, PostComment[]> = new Map();
  private chatroomMap: Map<string, Chatroom> = new Map();
  private messagesMap: Map<string, ChatroomMessage[]> = new Map();
  private participantsMap: Map<string, ChatParticipant[]> = new Map();
  private bannedMap: Map<string, Set<string>> = new Map();
  private bannedUsernamesMap: Map<string, Map<string, string>> = new Map();
  private mutedMap: Map<string, Set<string>> = new Map();
  private modsMap: Map<string, Set<string>> = new Map();
  private modsUsernamesMap: Map<string, Map<string, string>> = new Map();
  private favouritesMap: Map<string, Set<string>> = new Map();
  private recentMap: Map<string, string[]> = new Map();
  private roomMap: Map<string, Room> = new Map();
  private lostContactMap: Map<string, LostContact> = new Map();
  private merchantMap: Map<string, Merchant> = new Map();
  private merchantLocationMap: Map<string, MerchantLocation> = new Map();
  private merchantPointsMap: Map<string, number> = new Map();
  private merchantTagMap: Map<string, MerchantTag> = new Map();
  private creditAccountMap: Map<string, CreditAccount> = new Map();
  private creditTransactionList: CreditTransaction[] = [];
  private voucherBatchMap: Map<string, VoucherBatch> = new Map();
  private voucherMap: Map<string, Voucher> = new Map();
  private rewardProgramMap: Map<string, RewardProgram> = new Map();
  private userRewardHistoryList: UserRewardHistory[] = [];

  constructor() {
    for (const seed of SEED_CHATROOMS) {
      const id = randomUUID();
      const { seedMessages, ...chatroomData } = seed;
      this.chatroomMap.set(id, { id, ...chatroomData, createdAt: new Date() });
      const messages: ChatroomMessage[] = seedMessages.map((m) => ({
        id: randomUUID(), chatroomId: id, senderId: null,
        senderUsername: m.user, senderColor: m.color, text: m.text,
        isSystem: false, createdAt: minutesAgo(m.ago),
      }));
      this.messagesMap.set(id, messages);
      const participants: ChatParticipant[] = [
        ...new Map(seedMessages.map((m) => [
          m.user,
          { id: randomUUID(), username: m.user, displayName: m.user, color: m.color, joinedAt: minutesAgo(m.ago + 5).toISOString() },
        ])).values(),
      ];
      this.participantsMap.set(id, participants);
    }

    for (const m of SEED_MERCHANTS) {
      const merchant: Merchant = {
        id: randomUUID(), status: 1, totalPoints: 0, createdAt: new Date(),
        logoUrl: null, websiteUrl: null, ...m,
      };
      this.merchantMap.set(m.username, merchant);
    }

    for (const rp of SEED_REWARD_PROGRAMS) {
      const prog: RewardProgram = { id: randomUUID(), ...rp, createdAt: new Date() };
      this.rewardProgramMap.set(prog.id, prog);
    }
  }

  // ── Auth / Users ──────────────────────────────────────────────────────────
  async getUser(id: string) { return this.users.get(id); }
  async getUserByUsername(username: string) {
    return Array.from(this.users.values()).find((u) => u.username.toLowerCase() === username.toLowerCase());
  }
  async getUserByEmail(email: string) {
    const lower = email.trim().toLowerCase();
    const atIdx = lower.lastIndexOf("@");
    let normalized = lower;
    if (atIdx !== -1) {
      const local = lower.slice(0, atIdx);
      const domain = lower.slice(atIdx + 1);
      if (domain === "gmail.com" || domain === "googlemail.com") {
        normalized = `${local.replace(/\./g, "")}@${domain}`;
      }
    }
    return Array.from(this.users.values()).find((u) => {
      const stored = u.email.trim().toLowerCase();
      const storedAtIdx = stored.lastIndexOf("@");
      let storedNorm = stored;
      if (storedAtIdx !== -1) {
        const sLocal = stored.slice(0, storedAtIdx);
        const sDomain = stored.slice(storedAtIdx + 1);
        if (sDomain === "gmail.com" || sDomain === "googlemail.com") {
          storedNorm = `${sLocal.replace(/\./g, "")}@${sDomain}`;
        }
      }
      return storedNorm === normalized;
    });
  }
  async getUserByVerifyToken(token: string) {
    return Array.from(this.users.values()).find((u) => u.verifyToken === token);
  }
  async createUser(data: InsertUser & { password: string; verifyToken?: string; verifyTokenExpiry?: Date }): Promise<User> {
    const id = randomUUID();
    const user: User = {
      id, username: data.username, displayName: data.displayName ?? null,
      email: data.email, password: data.password, emailVerified: false,
      verifyToken: data.verifyToken ?? null, verifyTokenExpiry: data.verifyTokenExpiry ?? null,
      createdAt: new Date(),
    };
    this.users.set(id, user);
    return user;
  }
  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    const updated = { ...user, ...updates };
    this.users.set(id, updated);
    return updated;
  }
  async searchUsers(query: string, limit = 20, offset = 0): Promise<Partial<User>[]> {
    const q = query.toLowerCase();
    return Array.from(this.users.values())
      .filter((u) => u.username.toLowerCase().includes(q) || (u.displayName ?? "").toLowerCase().includes(q))
      .map(({ id, username, displayName }) => ({ id, username, displayName }))
      .slice(offset, offset + limit);
  }
  private transferPins: Map<string, string> = new Map();
  async setTransferPin(username: string, hashedPin: string): Promise<void> { this.transferPins.set(username, hashedPin); }
  async getTransferPin(username: string): Promise<string | null> { return this.transferPins.get(username) ?? null; }

  // ── Profile ───────────────────────────────────────────────────────────────
  async getUserProfile(userId: string) { return this.userProfiles.get(userId); }
  async upsertUserProfile(userId: string, data: Partial<InsertUserProfile>): Promise<UserProfile> {
    const existing = this.userProfiles.get(userId);
    const profile: UserProfile = {
      id: existing?.id ?? randomUUID(),
      userId,
      gender: data.gender ?? existing?.gender ?? null,
      dateOfBirth: data.dateOfBirth ?? existing?.dateOfBirth ?? null,
      country: data.country ?? existing?.country ?? null,
      city: data.city ?? existing?.city ?? null,
      aboutMe: data.aboutMe ?? existing?.aboutMe ?? null,
      likes: data.likes ?? existing?.likes ?? null,
      dislikes: data.dislikes ?? existing?.dislikes ?? null,
      relationshipStatus: data.relationshipStatus ?? existing?.relationshipStatus ?? 1,
      profileStatus: data.profileStatus ?? existing?.profileStatus ?? 1,
      anonymousViewing: data.anonymousViewing ?? existing?.anonymousViewing ?? false,
      displayPicture: data.displayPicture ?? existing?.displayPicture ?? null,
      migLevel: existing?.migLevel ?? 1,
      updatedAt: new Date(),
    };
    this.userProfiles.set(userId, profile);
    return profile;
  }

  // ── Feed / Wall Posts ─────────────────────────────────────────────────────
  async getFeedPosts(_userId: string, limit = 15, offset = 0): Promise<{ posts: WallPost[]; hasMore: boolean }> {
    const all = Array.from(this.wallPostsMap.values())
      .filter((p) => p.status === 1)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const posts = all.slice(offset, offset + limit);
    return { posts, hasMore: offset + limit < all.length };
  }
  async getWallPosts(userId: string, limit = 15, offset = 0): Promise<{ posts: WallPost[]; hasMore: boolean }> {
    const all = Array.from(this.wallPostsMap.values())
      .filter((p) => p.userId === userId && p.status === 1)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const posts = all.slice(offset, offset + limit);
    return { posts, hasMore: offset + limit < all.length };
  }
  async getWallPost(id: string) { return this.wallPostsMap.get(id); }
  async createWallPost(data: { userId: string; authorUserId: string; authorUsername: string; comment: string; imageUrl?: string | null; type?: number; repostId?: string | null; repostAuthorUsername?: string | null; repostComment?: string | null }): Promise<WallPost> {
    const post: WallPost = {
      id: randomUUID(), userId: data.userId, authorUserId: data.authorUserId,
      authorUsername: data.authorUsername, comment: data.comment,
      imageUrl: data.imageUrl ?? null, type: data.type ?? 1,
      status: 1, numComments: 0, numLikes: 0, numDislikes: 0,
      repostId: data.repostId ?? null,
      repostAuthorUsername: data.repostAuthorUsername ?? null,
      repostComment: data.repostComment ?? null,
      createdAt: new Date(),
    };
    this.wallPostsMap.set(post.id, post);
    return post;
  }
  async likeWallPost(id: string): Promise<WallPost | undefined> {
    const post = this.wallPostsMap.get(id);
    if (!post) return undefined;
    const updated = { ...post, numLikes: post.numLikes + 1 };
    this.wallPostsMap.set(id, updated);
    return updated;
  }
  async dislikeWallPost(id: string): Promise<WallPost | undefined> {
    const post = this.wallPostsMap.get(id);
    if (!post) return undefined;
    const updated = { ...post, numDislikes: post.numDislikes + 1 };
    this.wallPostsMap.set(id, updated);
    return updated;
  }
  async removeWallPost(id: string): Promise<void> {
    const post = this.wallPostsMap.get(id);
    if (post) this.wallPostsMap.set(id, { ...post, status: 0 });
  }
  async getPostComments(postId: string): Promise<PostComment[]> {
    return (this.postCommentsMap.get(postId) ?? []).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
  }
  async createPostComment(data: { postId: string; authorUserId: string; authorUsername: string; text: string }): Promise<PostComment> {
    const comment: PostComment = {
      id: randomUUID(), postId: data.postId, authorUserId: data.authorUserId,
      authorUsername: data.authorUsername, text: data.text, createdAt: new Date(),
    };
    const existing = this.postCommentsMap.get(data.postId) ?? [];
    this.postCommentsMap.set(data.postId, [...existing, comment]);
    const post = this.wallPostsMap.get(data.postId);
    if (post) this.wallPostsMap.set(data.postId, { ...post, numComments: post.numComments + 1 });
    return comment;
  }

  // ── Chatrooms ─────────────────────────────────────────────────────────────
  async getChatrooms() { return Array.from(this.chatroomMap.values()); }
  async getChatroomsByCategory(categoryId: number) {
    return Array.from(this.chatroomMap.values()).filter((r) => r.categoryId === categoryId);
  }
  async getChatroom(id: string) { return this.chatroomMap.get(id); }
  async getChatroomByName(name: string) {
    return Array.from(this.chatroomMap.values()).find((r) => r.name.toLowerCase() === name.toLowerCase());
  }
  async createChatroom(data: InsertChatroom & { createdBy?: string }): Promise<Chatroom> {
    const id = randomUUID();
    const chatroom: Chatroom = {
      id, name: data.name, description: data.description ?? null,
      categoryId: data.categoryId, currentParticipants: 1,
      maxParticipants: data.maxParticipants ?? 25, color: pickColor(data.name),
      language: data.language ?? "id", allowKick: data.allowKick ?? true,
      isLocked: false, adultOnly: data.adultOnly ?? false, userOwned: false,
      type: 1, status: 1, createdBy: data.createdBy ?? null, createdAt: new Date(),
    };
    this.chatroomMap.set(id, chatroom);
    this.messagesMap.set(id, []);
    this.participantsMap.set(id, []);
    return chatroom;
  }
  async deleteChatroom(id: string): Promise<void> { this.chatroomMap.delete(id); }
  async getMessages(chatroomId: string, opts?: { after?: string; before?: string; limit?: number }): Promise<ChatroomMessage[]> {
    let all = this.messagesMap.get(chatroomId) ?? [];
    if (opts?.after) {
      const afterDate = new Date(opts.after);
      all = all.filter((m) => m.createdAt > afterDate);
    }
    if (opts?.before) {
      const beforeDate = new Date(opts.before);
      all = all.filter((m) => m.createdAt < beforeDate);
    }
    const limit = opts?.limit ?? 50;
    return all.slice(-limit);
  }
  async getMessagesSince(chatroomId: string, sinceMs: number): Promise<ChatroomMessage[]> {
    const all = this.messagesMap.get(chatroomId) ?? [];
    const since = new Date(sinceMs);
    return all.filter((m) => m.createdAt > since);
  }
  async postMessage(chatroomId: string, msg: { id?: string; senderId?: string; senderUsername: string; senderColor: string; text: string; isSystem?: boolean }): Promise<ChatroomMessage> {
    const message: ChatroomMessage = {
      id: msg.id ?? randomUUID(), chatroomId, senderId: msg.senderId ?? null,
      senderUsername: msg.senderUsername, senderColor: msg.senderColor,
      text: msg.text, isSystem: msg.isSystem ?? false, createdAt: new Date(),
    };
    const list = this.messagesMap.get(chatroomId) ?? [];
    list.push(message);
    this.messagesMap.set(chatroomId, list);
    return message;
  }
  async getParticipants(chatroomId: string) { return this.participantsMap.get(chatroomId) ?? []; }
  async getActiveRoomsByUser(userId: string): Promise<{ room: Chatroom; participantCount: number }[]> {
    const results: { room: Chatroom; participantCount: number }[] = [];
    for (const [chatroomId, participants] of this.participantsMap.entries()) {
      if (participants.find((p) => p.id === userId)) {
        const room = this.chatroomMap.get(chatroomId);
        if (room) results.push({ room, participantCount: participants.length });
      }
    }
    return results;
  }
  async joinChatroom(chatroomId: string, user: { id: string; username: string; displayName: string; color: string }): Promise<void> {
    const list = this.participantsMap.get(chatroomId) ?? [];
    const room = this.chatroomMap.get(chatroomId);
    const isMod = this.modsMap.get(chatroomId)?.has(user.id) ?? false;
    const isMuted = this.mutedMap.get(chatroomId)?.has(user.id) ?? false;
    const isOwner = room?.createdBy === user.id;
    const isGlobalAdmin = await this.isGlobalAdmin(user.id);
    const profileEntry = this.userProfiles.get(user.id);
    const rawDp = profileEntry?.displayPicture ?? null;
    const displayPicture = rawDp && /\/api\/imageserver\/image\/[^/]+$/.test(rawDp) ? rawDp + '/data' : rawDp;
    const existingIndex = list.findIndex((p) => p.id === user.id);
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...user, isMod, isMuted, isOwner, isGlobalAdmin, displayPicture };
      this.participantsMap.set(chatroomId, list);
    } else {
      list.push({ ...user, joinedAt: new Date().toISOString(), isMod, isMuted, isOwner, isGlobalAdmin, displayPicture });
      this.participantsMap.set(chatroomId, list);
      if (room) this.chatroomMap.set(chatroomId, { ...room, currentParticipants: list.length });
    }
  }
  async leaveChatroom(chatroomId: string, userId: string): Promise<void> {
    const list = (this.participantsMap.get(chatroomId) ?? []).filter((p) => p.id !== userId);
    this.participantsMap.set(chatroomId, list);
    const room = this.chatroomMap.get(chatroomId);
    if (room) this.chatroomMap.set(chatroomId, { ...room, currentParticipants: list.length });
  }
  async updateChatroom(id: string, updates: Partial<Chatroom>): Promise<Chatroom | undefined> {
    const room = this.chatroomMap.get(id);
    if (!room) return undefined;
    const updated = { ...room, ...updates };
    this.chatroomMap.set(id, updated);
    return updated;
  }
  async banUser(chatroomId: string, userId: string): Promise<void> {
    const set = this.bannedMap.get(chatroomId) ?? new Set<string>();
    set.add(userId);
    this.bannedMap.set(chatroomId, set);
    const username = this.users.get(userId)?.username ?? userId;
    const umap = this.bannedUsernamesMap.get(chatroomId) ?? new Map<string, string>();
    umap.set(userId, username);
    this.bannedUsernamesMap.set(chatroomId, umap);
    await this.leaveChatroom(chatroomId, userId);
  }
  async unbanUser(chatroomId: string, userId: string): Promise<void> {
    const set = this.bannedMap.get(chatroomId);
    if (set) { set.delete(userId); this.bannedMap.set(chatroomId, set); }
    this.bannedUsernamesMap.get(chatroomId)?.delete(userId);
  }
  async isBanned(chatroomId: string, userId: string): Promise<boolean> {
    return this.bannedMap.get(chatroomId)?.has(userId) ?? false;
  }
  async muteUser(chatroomId: string, userId: string): Promise<void> {
    const set = this.mutedMap.get(chatroomId) ?? new Set<string>();
    set.add(userId);
    this.mutedMap.set(chatroomId, set);
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMuted: true } : p));
  }
  async silenceUser(chatroomId: string, userId: string, _username: string, timeoutSecs: number): Promise<void> {
    await this.muteUser(chatroomId, userId);
    setTimeout(() => this.unmuteUser(chatroomId, userId), timeoutSecs * 1000);
  }
  async unmuteUser(chatroomId: string, userId: string): Promise<void> {
    const set = this.mutedMap.get(chatroomId);
    if (set) { set.delete(userId); this.mutedMap.set(chatroomId, set); }
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMuted: false } : p));
  }
  async isMuted(chatroomId: string, userId: string): Promise<boolean> {
    return this.mutedMap.get(chatroomId)?.has(userId) ?? false;
  }
  async isSuspended(_userId: string): Promise<boolean> { return false; }
  async suspendUser(_userId: string): Promise<void> {}
  async unsuspendUser(_userId: string): Promise<void> {}
  async modUser(chatroomId: string, userId: string): Promise<void> {
    const set = this.modsMap.get(chatroomId) ?? new Set<string>();
    set.add(userId);
    this.modsMap.set(chatroomId, set);
    const username = this.users.get(userId)?.username ?? userId;
    const umap = this.modsUsernamesMap.get(chatroomId) ?? new Map<string, string>();
    umap.set(userId, username);
    this.modsUsernamesMap.set(chatroomId, umap);
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMod: true } : p));
  }
  async unmodUser(chatroomId: string, userId: string): Promise<void> {
    const set = this.modsMap.get(chatroomId);
    if (set) { set.delete(userId); this.modsMap.set(chatroomId, set); }
    this.modsUsernamesMap.get(chatroomId)?.delete(userId);
    const list = this.participantsMap.get(chatroomId) ?? [];
    this.participantsMap.set(chatroomId, list.map((p) => p.id === userId ? { ...p, isMod: false } : p));
  }
  async isModUser(chatroomId: string, userId: string): Promise<boolean> {
    return this.modsMap.get(chatroomId)?.has(userId) ?? false;
  }
  // Mirrors Bump.java chatRoomPrx.bumpUser(): force-disconnect target user from room.
  // "Bump" = soft kick — user is removed from the room but is free to rejoin.
  // No ban is applied, unlike banUser.
  async bumpUser(chatroomId: string, userId: string): Promise<void> {
    const list = (this.participantsMap.get(chatroomId) ?? []).filter((p) => p.id !== userId);
    this.participantsMap.set(chatroomId, list);
    const room = this.chatroomMap.get(chatroomId);
    if (room) this.chatroomMap.set(chatroomId, { ...room, currentParticipants: list.length });
  }

  // ── Chatroom Favourites ────────────────────────────────────────────────────
  async getFavouriteChatrooms(userId: string): Promise<Chatroom[]> {
    const ids = this.favouritesMap.get(userId);
    if (!ids) return [];
    const rooms: Chatroom[] = [];
    for (const id of ids) {
      const room = this.chatroomMap.get(id);
      if (room) rooms.push(room);
    }
    return rooms;
  }
  async addFavouriteChatroom(userId: string, chatroomId: string): Promise<void> {
    const set = this.favouritesMap.get(userId) ?? new Set<string>();
    set.add(chatroomId);
    this.favouritesMap.set(userId, set);
  }
  async removeFavouriteChatroom(userId: string, chatroomId: string): Promise<void> {
    const set = this.favouritesMap.get(userId);
    if (set) { set.delete(chatroomId); this.favouritesMap.set(userId, set); }
  }
  async isFavouriteChatroom(userId: string, chatroomId: string): Promise<boolean> {
    return this.favouritesMap.get(userId)?.has(chatroomId) ?? false;
  }

  // ── Chatroom Recent ────────────────────────────────────────────────────────
  async getRecentChatrooms(userId: string): Promise<Chatroom[]> {
    const ids = this.recentMap.get(userId) ?? [];
    const rooms: Chatroom[] = [];
    for (const id of ids) {
      const room = this.chatroomMap.get(id);
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
    const set = this.modsMap.get(chatroomId);
    if (!set) return [];
    const umap = this.modsUsernamesMap.get(chatroomId);
    return Array.from(set).map((uid) => ({
      userId: uid,
      username: umap?.get(uid) ?? uid,
    }));
  }
  async getChatroomBannedUsers(chatroomId: string): Promise<{ userId: string; username: string }[]> {
    const set = this.bannedMap.get(chatroomId);
    if (!set) return [];
    const umap = this.bannedUsernamesMap.get(chatroomId);
    return Array.from(set).map((uid) => ({
      userId: uid,
      username: umap?.get(uid) ?? uid,
    }));
  }

  // ── Rooms ─────────────────────────────────────────────────────────────────
  async getRooms() { return Array.from(this.roomMap.values()).filter((r) => r.status === 1); }
  async getRoomsByOwner(ownerId: string) {
    return Array.from(this.roomMap.values()).filter((r) => r.ownerId === ownerId && r.status === 1);
  }
  async getRoom(id: string) { return this.roomMap.get(id); }
  async createRoom(data: InsertRoom & { ownerId: string; ownerUsername: string }): Promise<Room> {
    const room: Room = {
      id: randomUUID(), ownerId: data.ownerId, ownerUsername: data.ownerUsername,
      name: data.name, description: data.description ?? null, theme: data.theme ?? "default",
      maxParticipants: data.maxParticipants ?? 20, status: 1,
      isLocked: data.isLocked ?? false, createdAt: new Date(),
    };
    this.roomMap.set(room.id, room);
    return room;
  }
  async updateRoom(id: string, updates: Partial<Room>): Promise<Room | undefined> {
    const room = this.roomMap.get(id);
    if (!room) return undefined;
    const updated = { ...room, ...updates };
    this.roomMap.set(id, updated);
    return updated;
  }
  async deleteRoom(id: string): Promise<void> {
    const room = this.roomMap.get(id);
    if (room) this.roomMap.set(id, { ...room, status: 0 });
  }

  // ── Lost Contacts ─────────────────────────────────────────────────────────
  async getLostContacts(userId: string) {
    return Array.from(this.lostContactMap.values()).filter((c) => c.userId === userId && c.status === 1);
  }
  async getLostContact(id: string) { return this.lostContactMap.get(id); }
  async createLostContact(data: InsertLostContact & { userId: string }): Promise<LostContact> {
    const contact: LostContact = {
      id: randomUUID(), userId: data.userId, lostUsername: data.lostUsername,
      note: data.note ?? null, status: 1, createdAt: new Date(),
    };
    this.lostContactMap.set(contact.id, contact);
    return contact;
  }
  async updateLostContactStatus(id: string, status: number): Promise<LostContact | undefined> {
    const contact = this.lostContactMap.get(id);
    if (!contact) return undefined;
    const updated = { ...contact, status };
    this.lostContactMap.set(id, updated);
    return updated;
  }
  async deleteLostContact(id: string): Promise<void> { this.lostContactMap.delete(id); }

  // ── Merchants ─────────────────────────────────────────────────────────────
  async getMerchants() { return Array.from(this.merchantMap.values()).filter((m) => m.status === 1); }
  async getMerchantByUsername(username: string) { return this.merchantMap.get(username); }
  async createMerchant(data: InsertMerchant): Promise<Merchant> {
    const merchant: Merchant = {
      id: randomUUID(), status: 1, totalPoints: 0, createdAt: new Date(),
      description: null, category: null, logoUrl: null, websiteUrl: null,
      usernameColor: "#990099", usernameColorType: 0, merchantType: 1,
      mentor: null, referrer: null,
      ...data,
    };
    this.merchantMap.set(data.username, merchant);
    return merchant;
  }
  async updateMerchant(username: string, updates: Partial<Merchant>): Promise<Merchant | undefined> {
    const merchant = this.merchantMap.get(username);
    if (!merchant) return undefined;
    const updated = { ...merchant, ...updates };
    this.merchantMap.set(username, updated);
    return updated;
  }
  async updateMerchantColorType(username: string, colorType: number): Promise<Merchant | undefined> {
    const colorHexMap: Record<number, string> = { 0: "#990099", 1: "#FF0000", 2: "#FF69B4" };
    return this.updateMerchant(username, { usernameColorType: colorType, usernameColor: colorHexMap[colorType] ?? "#990099" });
  }
  async getMerchantLocations(merchantUsername: string): Promise<MerchantLocation[]> {
    return Array.from(this.merchantLocationMap.values()).filter((l) => l.merchantUsername === merchantUsername && l.status === 1);
  }
  async getMerchantLocationsByCountryId(countryId: number, offset: number, limit: number): Promise<MerchantLocation[]> {
    return Array.from(this.merchantLocationMap.values())
      .filter((l) => l.countryId === countryId && l.status === 1)
      .slice(offset, offset + (limit > 0 ? limit : 20));
  }
  async getMerchantLocationsByCountryName(countryName: string, offset: number, limit: number): Promise<MerchantLocation[]> {
    const lower = countryName.toLowerCase();
    return Array.from(this.merchantLocationMap.values())
      .filter((l) => l.country?.toLowerCase() === lower && l.status === 1)
      .slice(offset, offset + (limit > 0 ? limit : 20));
  }
  async getCountriesWithMerchants(): Promise<Array<{ countryId: number | null; country: string | null; count: number }>> {
    const map = new Map<string, { countryId: number | null; country: string | null; count: number }>();
    for (const loc of this.merchantLocationMap.values()) {
      if (loc.status !== 1) continue;
      const key = `${loc.countryId}:${loc.country}`;
      const entry = map.get(key) ?? { countryId: loc.countryId ?? null, country: loc.country ?? null, count: 0 };
      entry.count++;
      map.set(key, entry);
    }
    return Array.from(map.values()).filter((e) => e.countryId !== null || e.country !== null);
  }
  async createMerchantLocation(data: InsertMerchantLocation): Promise<MerchantLocation> {
    const location: MerchantLocation = {
      id: randomUUID(), status: 1, locationId: null, userData: null,
      phoneNumber: null, emailAddress: null, notes: null, address: null,
      countryId: null, country: null,
      ...data,
    };
    this.merchantLocationMap.set(location.id, location);
    return location;
  }
  async addMerchantPoints(merchantUsername: string, userId: string, points: number, entryType?: number, reason?: string) {
    const key = `${merchantUsername}:${userId}`;
    const current = this.merchantPointsMap.get(key) ?? 0;
    this.merchantPointsMap.set(key, current + points);
    const merchant = this.merchantMap.get(merchantUsername);
    if (merchant) this.merchantMap.set(merchantUsername, { ...merchant, totalPoints: merchant.totalPoints + points });
    return { merchantUsername, userId, points, reason };
  }
  async getUserMerchantPoints(merchantUsername: string, userId: string): Promise<number> {
    return this.merchantPointsMap.get(`${merchantUsername}:${userId}`) ?? 0;
  }
  async getMerchantPointsHistory(_merchantUsername: string, _userId: string): Promise<MerchantPoint[]> {
    return [];
  }

  // ── Merchant Tags ─────────────────────────────────────────────────────────
  async getMerchantTags(filter: { merchantUsername?: string; taggedUsername?: string; type?: number; page?: number; numRecords?: number }): Promise<MerchantTag[]> {
    const page = filter.page ?? 1;
    const limit = filter.numRecords ?? 50;
    const offset = (page - 1) * limit;
    const now = new Date();
    const all = Array.from(this.merchantTagMap.values()).filter((t) => {
      if (t.status !== 1) return false;
      if (t.expiry && t.expiry < now) return false;
      if (filter.merchantUsername && t.merchantUsername !== filter.merchantUsername) return false;
      if (filter.taggedUsername && t.taggedUsername !== filter.taggedUsername) return false;
      if (filter.type !== undefined && t.type !== filter.type) return false;
      return true;
    });
    return all.slice(offset, offset + limit);
  }
  async getMerchantTag(id: string) { return this.merchantTagMap.get(id); }
  async getMerchantTagByUsername(taggedUsername: string): Promise<MerchantTag | undefined> {
    const now = new Date();
    return Array.from(this.merchantTagMap.values()).find((t) =>
      t.taggedUsername === taggedUsername && t.status === 1 && (!t.expiry || t.expiry > now)
    );
  }
  async getExpiringMerchantTags(merchantUsername: string, daysAhead: number): Promise<MerchantTag[]> {
    const now = new Date();
    const future = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    return Array.from(this.merchantTagMap.values()).filter((t) =>
      t.merchantUsername === merchantUsername && t.status === 1 &&
      t.expiry && t.expiry > now && t.expiry < future
    ).sort((a, b) => (a.expiry?.getTime() ?? 0) - (b.expiry?.getTime() ?? 0));
  }
  async createMerchantTag(data: InsertMerchantTag & { expiry?: Date }): Promise<MerchantTag> {
    const tag: MerchantTag = {
      id: randomUUID(), merchantUsername: data.merchantUsername, taggedUsername: data.taggedUsername,
      type: data.type ?? 2, expiry: data.expiry ?? null, status: 1, createdAt: new Date(),
      amount: (data as any).amount ?? null, currency: (data as any).currency ?? null,
      accountEntryId: (data as any).accountEntryId ?? null,
    };
    this.merchantTagMap.set(tag.id, tag);
    return tag;
  }
  async removeMerchantTag(id: string): Promise<void> {
    const tag = this.merchantTagMap.get(id);
    if (tag) this.merchantTagMap.set(id, { ...tag, status: 0 });
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  async getRecommendedUsers(userId: string): Promise<Partial<User>[]> {
    return Array.from(this.users.values())
      .filter((u) => u.id !== userId)
      .slice(0, 10)
      .map(({ id, username, displayName, country, displayPicture }) => ({ id, username, displayName, country, displayPicture }));
  }

  // ── Credit — Account Balance ──────────────────────────────────────────────
  async getCreditAccount(username: string): Promise<CreditAccount> {
    if (!this.creditAccountMap.has(username)) {
      const acct: CreditAccount = {
        id: randomUUID(), username, currency: "IDR", balance: 0, fundedBalance: 0, updatedAt: new Date(),
      };
      this.creditAccountMap.set(username, acct);
    }
    return this.creditAccountMap.get(username)!;
  }

  async adjustBalance(username: string, amount: number, currency?: string): Promise<CreditAccount> {
    const acct = await this.getCreditAccount(username);
    const resolvedCurrency = currency ?? acct.currency;
    const updated: CreditAccount = {
      ...acct, currency: resolvedCurrency, balance: Math.round((acct.balance + amount) * 100) / 100, updatedAt: new Date(),
    };
    this.creditAccountMap.set(username, updated);
    return updated;
  }

  async setBalance(username: string, balance: number, currency?: string): Promise<CreditAccount> {
    const acct = await this.getCreditAccount(username);
    const resolvedCurrency = currency ?? acct.currency;
    const updated: CreditAccount = {
      ...acct, currency: resolvedCurrency, balance: Math.round(balance * 100) / 100, updatedAt: new Date(),
    };
    this.creditAccountMap.set(username, updated);
    return updated;
  }

  async listCreditAccounts(opts: { search?: string; limit?: number } = {}): Promise<CreditAccount[]> {
    const { search, limit = 100 } = opts;
    const term = (search ?? "").trim().toLowerCase();
    const all = Array.from(this.creditAccountMap.values());
    const filtered = term ? all.filter((a) => a.username.toLowerCase().includes(term)) : all;
    return filtered.sort((a, b) => a.username.localeCompare(b.username)).slice(0, Math.max(1, Math.min(500, limit)));
  }

  // ── Credit — Transactions ─────────────────────────────────────────────────
  async getCreditTransactions(username: string, limit = 50): Promise<CreditTransaction[]> {
    return this.creditTransactionList
      .filter((t) => t.username === username)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async createCreditTransaction(data: Omit<CreditTransaction, "id" | "createdAt">): Promise<CreditTransaction> {
    const tx: CreditTransaction = { id: randomUUID(), ...data, createdAt: new Date() };
    this.creditTransactionList.push(tx);
    return tx;
  }

  async getCreditTransaction(id: string): Promise<CreditTransaction | undefined> {
    return this.creditTransactionList.find((t) => t.id === id);
  }

  // ── Credit — Transfer ─────────────────────────────────────────────────────
  async transferCredit(fromUsername: string, toUsername: string, amount: number, feeType = 1): Promise<{ from: CreditAccount; to: CreditAccount; fee: number }> {
    const rate = TRANSFER_FEE_RATES[feeType] ?? 0.02;
    const fee = Math.round(amount * rate * 100) / 100;
    const netAmount = Math.round((amount - fee) * 100) / 100;

    const fromAcct = await this.getCreditAccount(fromUsername);
    if (fromAcct.balance < amount) throw new Error("Insufficient balance");
    const toAcct = await this.getCreditAccount(toUsername);

    const fromUpdated = await this.adjustBalance(fromUsername, -amount);
    const toUpdated = await this.adjustBalance(toUsername, netAmount);

    const senderCurrency = fromAcct.currency;
    const receiverCurrency = toAcct.currency;
    const ref = `TRF-${Date.now()}`;
    const fromRunning = fromUpdated.balance;
    const toRunning = toUpdated.balance;

    await this.createCreditTransaction({
      username: fromUsername, type: CREDIT_TRANSACTION_TYPE.USER_TO_USER_TRANSFER,
      reference: ref, description: `Transfer to ${toUsername}`,
      currency: senderCurrency, amount: -amount, fundedAmount: 0, tax: 0, runningBalance: fromRunning,
    });
    if (fee > 0) {
      await this.createCreditTransaction({
        username: fromUsername, type: CREDIT_TRANSACTION_TYPE.TRANSFER_CREDIT_FEE,
        reference: ref, description: `Transfer fee (${(rate * 100).toFixed(1)}%)`,
        currency: senderCurrency, amount: -fee, fundedAmount: 0, tax: 0, runningBalance: fromRunning,
      });
    }
    await this.createCreditTransaction({
      username: toUsername, type: CREDIT_TRANSACTION_TYPE.USER_TO_USER_TRANSFER,
      reference: ref, description: `Received from ${fromUsername}`,
      currency: receiverCurrency, amount: netAmount, fundedAmount: 0, tax: 0, runningBalance: toRunning,
    });

    return { from: fromUpdated, to: toUpdated, fee };
  }

  // ── Credit — Vouchers ─────────────────────────────────────────────────────
  async getVoucherBatches(username?: string): Promise<VoucherBatch[]> {
    const batches = Array.from(this.voucherBatchMap.values());
    if (username) return batches.filter((b) => b.createdByUsername === username);
    return batches;
  }

  async getVoucherBatch(id: string): Promise<VoucherBatch | undefined> {
    return this.voucherBatchMap.get(id);
  }

  async createVoucherBatch(data: InsertVoucherBatch & { createdByUsername: string }): Promise<{ batch: VoucherBatch; vouchers: Voucher[] }> {
    const batchId = randomUUID();
    const count = data.numVoucher ?? 1;
    const batch: VoucherBatch = {
      id: batchId, createdByUsername: data.createdByUsername, currency: data.currency ?? "IDR",
      amount: data.amount, numVoucher: count, notes: data.notes ?? null,
      expiryDate: data.expiryDate ?? null, numActive: count,
      numCancelled: 0, numRedeemed: 0, numExpired: 0, createdAt: new Date(),
    };
    this.voucherBatchMap.set(batchId, batch);

    const created: Voucher[] = [];
    for (let i = 0; i < count; i++) {
      const code = `MIG-${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 12)}`;
      const voucher: Voucher = {
        id: randomUUID(), voucherBatchId: batchId, code,
        currency: data.currency ?? "IDR", amount: data.amount,
        status: VOUCHER_STATUS.ACTIVE, redeemedByUsername: null,
        notes: data.notes ?? null, expiryDate: data.expiryDate ?? null, updatedAt: new Date(),
      };
      this.voucherMap.set(voucher.id, voucher);
      created.push(voucher);
    }

    await this.createCreditTransaction({
      username: data.createdByUsername, type: CREDIT_TRANSACTION_TYPE.VOUCHERS_CREATED,
      reference: batchId, description: `Created ${count} voucher(s) of ${data.amount} ${data.currency ?? "IDR"}`,
      currency: data.currency ?? "IDR", amount: -(data.amount * count),
      fundedAmount: 0, tax: 0, runningBalance: (await this.getCreditAccount(data.createdByUsername)).balance,
    });

    return { batch, vouchers: created };
  }

  async getVouchers(batchId: string): Promise<Voucher[]> {
    return Array.from(this.voucherMap.values()).filter((v) => v.voucherBatchId === batchId);
  }

  async redeemVoucher(code: string, username: string): Promise<Voucher> {
    const voucher = Array.from(this.voucherMap.values()).find((v) => v.code === code);
    if (!voucher) throw new Error("Voucher not found");
    if (voucher.status !== VOUCHER_STATUS.ACTIVE) throw new Error("Voucher is not active");
    if (voucher.expiryDate && voucher.expiryDate < new Date()) throw new Error("Voucher has expired");

    const updated: Voucher = {
      ...voucher, status: VOUCHER_STATUS.REDEEMED, redeemedByUsername: username, updatedAt: new Date(),
    };
    this.voucherMap.set(voucher.id, updated);

    const batch = this.voucherBatchMap.get(voucher.voucherBatchId);
    if (batch) {
      this.voucherBatchMap.set(batch.id, {
        ...batch, numActive: batch.numActive - 1, numRedeemed: batch.numRedeemed + 1,
      });
    }

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
    const voucher = this.voucherMap.get(id);
    if (!voucher || voucher.status !== VOUCHER_STATUS.ACTIVE) return undefined;
    const updated: Voucher = { ...voucher, status: VOUCHER_STATUS.CANCELLED, updatedAt: new Date() };
    this.voucherMap.set(id, updated);
    const batch = this.voucherBatchMap.get(voucher.voucherBatchId);
    if (batch) {
      this.voucherBatchMap.set(batch.id, {
        ...batch, numActive: batch.numActive - 1, numCancelled: batch.numCancelled + 1,
      });
    }
    return updated;
  }

  // ── Credit — Reward Programs ──────────────────────────────────────────────
  async getRewardPrograms(): Promise<RewardProgram[]> {
    return Array.from(this.rewardProgramMap.values()).filter((p) => p.status === 1);
  }
  async getRewardProgram(id: string): Promise<RewardProgram | undefined> {
    return this.rewardProgramMap.get(id);
  }
  async createRewardProgram(data: InsertRewardProgram): Promise<RewardProgram> {
    const prog: RewardProgram = { id: randomUUID(), ...data, createdAt: new Date() };
    this.rewardProgramMap.set(prog.id, prog);
    return prog;
  }
  async updateRewardProgram(id: string, updates: Partial<RewardProgram>): Promise<RewardProgram | undefined> {
    const prog = this.rewardProgramMap.get(id);
    if (!prog) return undefined;
    const updated = { ...prog, ...updates };
    this.rewardProgramMap.set(id, updated);
    return updated;
  }

  // ── Credit — User Reward History ──────────────────────────────────────────
  async getUserRewardHistory(username: string): Promise<UserRewardHistory[]> {
    return this.userRewardHistoryList
      .filter((h) => h.username === username)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async addUserReward(data: Omit<UserRewardHistory, "id" | "createdAt">): Promise<UserRewardHistory> {
    const record: UserRewardHistory = { id: randomUUID(), ...data, createdAt: new Date() };
    this.userRewardHistoryList.push(record);
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

  // ── Message (mirrors MessageDAOChain.java / FusionDbMessageDAOChain.java) ─────
  private clientTextList: ClientText[] = [];
  private alertMessageList: AlertMessage[] = [];
  private nextClientTextId = 1;
  private nextAlertMessageId = 1;

  // SQL: SELECT * FROM clienttext WHERE type = 1
  async loadHelpTexts(): Promise<Record<number, string>> {
    const result: Record<number, string> = {};
    this.clientTextList.filter(t => t.type === CLIENT_TEXT_TYPE.HELP).forEach(t => { result[t.id] = t.text; });
    return result;
  }
  // SQL: SELECT * FROM clienttext WHERE type = 2
  async loadInfoTexts(): Promise<Record<number, string>> {
    const result: Record<number, string> = {};
    this.clientTextList.filter(t => t.type === CLIENT_TEXT_TYPE.INFO).forEach(t => { result[t.id] = t.text; });
    return result;
  }
  async getInfoText(infoId: number): Promise<string | undefined> {
    return this.clientTextList.find(t => t.id === infoId && t.type === CLIENT_TEXT_TYPE.INFO)?.text;
  }
  async createClientText(data: InsertClientText): Promise<ClientText> {
    const item: ClientText = { id: this.nextClientTextId++, createdAt: new Date(), ...data };
    this.clientTextList.push(item);
    return item;
  }
  async updateClientText(id: number, updates: Partial<ClientText>): Promise<ClientText | undefined> {
    const idx = this.clientTextList.findIndex(t => t.id === id);
    if (idx < 0) return undefined;
    this.clientTextList[idx] = { ...this.clientTextList[idx], ...updates };
    return this.clientTextList[idx];
  }
  async deleteClientText(id: number): Promise<void> { this.clientTextList = this.clientTextList.filter(t => t.id !== id); }
  async getClientTexts(): Promise<ClientText[]> { return [...this.clientTextList]; }

  // SQL: SELECT * FROM alertmessage WHERE MinMidletVersion<=? AND MaxMidletVersion>=?
  //   AND Type=? AND (CountryID=? OR CountryID IS NULL) AND StartDate<=now() AND ExpiryDate>now()
  //   AND Status=1 AND clientType=? [AND ContentType=?] ORDER BY CountryID
  async getLatestAlertMessages(params: { midletVersion: number; type: number; countryId: number; contentType?: number; clientType: number }): Promise<AlertMessage[]> {
    const now = new Date();
    return this.alertMessageList.filter(a => {
      if (a.status !== ALERT_MESSAGE_STATUS.ACTIVE) return false;
      if (a.minMidletVersion > params.midletVersion) return false;
      if (a.maxMidletVersion < params.midletVersion) return false;
      if (a.type !== params.type) return false;
      if (a.countryId !== null && a.countryId !== params.countryId) return false;
      if (a.startDate && a.startDate > now) return false;
      if (a.expiryDate && a.expiryDate <= now) return false;
      if (a.clientType !== params.clientType) return false;
      if (params.contentType !== undefined && a.contentType !== params.contentType) return false;
      return true;
    }).sort((a, b) => (a.countryId ?? -1) - (b.countryId ?? -1));
  }
  async createAlertMessage(data: InsertAlertMessage): Promise<AlertMessage> {
    const msg: AlertMessage = { id: this.nextAlertMessageId++, createdAt: new Date(), ...data } as AlertMessage;
    this.alertMessageList.push(msg);
    return msg;
  }
  async updateAlertMessage(id: number, updates: Partial<AlertMessage>): Promise<AlertMessage | undefined> {
    const idx = this.alertMessageList.findIndex(m => m.id === id);
    if (idx < 0) return undefined;
    this.alertMessageList[idx] = { ...this.alertMessageList[idx], ...updates };
    return this.alertMessageList[idx];
  }
  async deleteAlertMessage(id: number): Promise<void> { this.alertMessageList = this.alertMessageList.filter(m => m.id !== id); }
  async getAlertMessages(status?: number): Promise<AlertMessage[]> {
    return status === undefined ? [...this.alertMessageList] : this.alertMessageList.filter(m => m.status === status);
  }

  // ── Group (mirrors GroupDAOChain.java / FusionDbGroupDAOChain.java) ──────────
  private groupMap: Map<number, Group> = new Map();
  private groupMemberList: GroupMember[] = [];
  private nextGroupId = 1;
  private nextGroupMemberId = 1;

  async getGroup(groupId: number): Promise<Group | undefined> {
    const g = this.groupMap.get(groupId);
    return (g && g.status === 1) ? g : undefined;
  }
  async getGroups(status?: number): Promise<Group[]> {
    const all = Array.from(this.groupMap.values());
    if (status === undefined) return all;
    return all.filter(g => g.status === status);
  }
  async createGroup(data: InsertGroup): Promise<Group> {
    const group: Group = { id: this.nextGroupId++, createdAt: new Date(), ...data } as Group;
    this.groupMap.set(group.id, group);
    return group;
  }
  async updateGroup(id: number, updates: Partial<Group>): Promise<Group | undefined> {
    const group = this.groupMap.get(id);
    if (!group) return undefined;
    const updated = { ...group, ...updates };
    this.groupMap.set(id, updated);
    return updated;
  }
  async deleteGroup(id: number): Promise<void> { this.groupMap.delete(id); }

  // SQL: SELECT gm.username FROM groupmember WHERE groupid=? AND status=ACTIVE AND type=MODERATOR
  async getModeratorUserNames(groupId: number): Promise<string[]> {
    return this.groupMemberList
      .filter(m => m.groupId === groupId && m.status === GROUP_MEMBER_STATUS.ACTIVE && m.type === GROUP_MEMBER_TYPE.MODERATOR)
      .map(m => m.username);
  }
  async getGroupMembers(groupId: number, status?: number): Promise<GroupMember[]> {
    return this.groupMemberList.filter(m => m.groupId === groupId && (status === undefined || m.status === status));
  }
  async getGroupMembersByUsername(username: string): Promise<GroupMember[]> {
    return this.groupMemberList.filter(m => m.username === username);
  }
  async addGroupMember(data: InsertGroupMember): Promise<GroupMember> {
    const member: GroupMember = { id: this.nextGroupMemberId++, joinedAt: new Date(), leftAt: null, expirationDate: null, smsNotification: 0, emailNotification: 0, eventNotification: 0, status: GROUP_MEMBER_STATUS.ACTIVE, ...data } as GroupMember;
    this.groupMemberList.push(member);
    return member;
  }
  async updateGroupMember(id: number, updates: Partial<GroupMember>): Promise<GroupMember | undefined> {
    const idx = this.groupMemberList.findIndex(m => m.id === id);
    if (idx < 0) return undefined;
    this.groupMemberList[idx] = { ...this.groupMemberList[idx], ...updates };
    return this.groupMemberList[idx];
  }
  async removeGroupMember(id: number): Promise<void> {
    this.groupMemberList = this.groupMemberList.filter(m => m.id !== id);
  }

  // ── Email Bounce (mirrors EmailDAOChain.java / FusionDbEmailDAOChain.java) ──
  // ENABLE_SEND_TO_TRANSIENT: if true, transient bounces are not blocked
  private bounceEmailMap: Map<string, { bounceType: string; createdAt: Date }> = new Map();

  // SQL: SELECT bounceType FROM bouncedb WHERE emailaddress = ? LIMIT 1
  // 'Transient' = soft bounce (not blocked when ENABLE_SEND_TO_TRANSIENT=true)
  // 'Permanent' or any other = hard bounce (always blocked)
  async isBounceEmailAddress(email: string): Promise<boolean> {
    const record = this.bounceEmailMap.get(email.toLowerCase());
    if (!record) return false;
    const sendToTransient = process.env.ENABLE_SEND_TO_TRANSIENT_EMAIL === "true";
    if (sendToTransient && record.bounceType === "Transient") return false;
    return true;
  }
  async addBounceEmail(email: string, bounceType = "Permanent"): Promise<void> {
    this.bounceEmailMap.set(email.toLowerCase(), { bounceType, createdAt: new Date() });
  }
  async removeBounceEmail(email: string): Promise<void> {
    this.bounceEmailMap.delete(email.toLowerCase());
  }
  async listBounceEmails(limit = 100, offset = 0): Promise<{ email: string; bounceType: string; createdAt: Date }[]> {
    return Array.from(this.bounceEmailMap.entries())
      .map(([email, v]) => ({ email, bounceType: v.bounceType, createdAt: v.createdAt }))
      .slice(offset, offset + limit);
  }

  // ── Campaign (mirrors CampaignDataDAOChain.java) ──────────────────────────
  private campaignMap: Map<number, Campaign> = new Map();
  private campaignParticipantList: CampaignParticipant[] = [];
  private nextCampaignId = 1;
  private nextCampaignParticipantId = 1;

  async getCampaign(campaignId: number): Promise<Campaign | undefined> { return this.campaignMap.get(campaignId); }
  async getCampaigns(activeOnly = true): Promise<Campaign[]> {
    const all = Array.from(this.campaignMap.values());
    if (!activeOnly) return all;
    const now = new Date();
    return all.filter(c => c.status === 1 && (!c.startDate || c.startDate <= now) && (!c.endDate || c.endDate >= now));
  }
  async createCampaign(data: InsertCampaign): Promise<Campaign> {
    const campaign: Campaign = { id: this.nextCampaignId++, createdAt: new Date(), ...data } as Campaign;
    this.campaignMap.set(campaign.id, campaign);
    return campaign;
  }
  async updateCampaign(id: number, updates: Partial<Campaign>): Promise<Campaign | undefined> {
    const campaign = this.campaignMap.get(id);
    if (!campaign) return undefined;
    const updated = { ...campaign, ...updates };
    this.campaignMap.set(id, updated);
    return updated;
  }
  async deleteCampaign(id: number): Promise<void> { this.campaignMap.delete(id); }

  // SQL: SELECT * FROM campaignparticipant WHERE campaignid = ? AND userid = ?
  async getCampaignParticipant(userId: string, campaignId: number): Promise<CampaignParticipant | undefined> {
    return this.campaignParticipantList.find(p => p.userId === userId && p.campaignId === campaignId);
  }
  // SQL: SELECT cp.* FROM campaignparticipant cp JOIN campaign c ... WHERE c.type=? AND cp.userid=? AND c.status=1
  async getActiveCampaignParticipants(userId: string, type?: number): Promise<CampaignParticipant[]> {
    const now = new Date();
    return this.campaignParticipantList.filter(p => {
      if (p.userId !== userId) return false;
      const campaign = this.campaignMap.get(p.campaignId);
      if (!campaign || campaign.status !== 1) return false;
      if (campaign.startDate && campaign.startDate > now) return false;
      if (campaign.endDate && campaign.endDate < now) return false;
      if (type !== undefined && campaign.type !== type) return false;
      return true;
    });
  }
  // SQL: SELECT * FROM campaignparticipant WHERE campaignid = ? AND mobilephone = ?
  async getCampaignParticipantByMobile(mobilePhone: string, campaignId: number): Promise<CampaignParticipant | undefined> {
    return this.campaignParticipantList.find(p => p.campaignId === campaignId && p.mobilePhone === mobilePhone);
  }
  // SQL: INSERT INTO campaignparticipant (campaignid, userid, mobilephone, emailaddress, reference)
  async joinCampaign(data: InsertCampaignParticipant): Promise<CampaignParticipant> {
    const participant: CampaignParticipant = { id: this.nextCampaignParticipantId++, joinedAt: new Date(), ...data } as CampaignParticipant;
    this.campaignParticipantList.push(participant);
    return participant;
  }
  async getCampaignParticipants(campaignId: number): Promise<CampaignParticipant[]> {
    return this.campaignParticipantList.filter(p => p.campaignId === campaignId);
  }

  // ── Bot ───────────────────────────────────────────────────────────────────
  private botMap: Map<number, Bot> = new Map();
  private botConfigList: BotConfig[] = [];
  private nextBotId = 1;
  private nextBotConfigId = 1;

  async getBot(id: number): Promise<Bot | undefined> { return this.botMap.get(id); }
  async getBots(activeOnly = true): Promise<Bot[]> {
    const all = Array.from(this.botMap.values());
    return activeOnly ? all.filter(b => b.status === 1) : all;
  }
  async getBotConfigs(botId: number): Promise<BotConfig[]> {
    return this.botConfigList.filter(c => c.botId === botId);
  }
  async createBot(data: InsertBot): Promise<Bot> {
    const bot: Bot = { id: this.nextBotId++, ...data } as Bot;
    this.botMap.set(bot.id, bot);
    return bot;
  }
  async updateBot(id: number, updates: Partial<Bot>): Promise<Bot | undefined> {
    const bot = this.botMap.get(id);
    if (!bot) return undefined;
    const updated = { ...bot, ...updates };
    this.botMap.set(id, updated);
    return updated;
  }
  async deleteBot(id: number): Promise<void> { this.botMap.delete(id); }

  // ── EmoAndSticker ──────────────────────────────────────────────────────────
  private emoticonPackMap: Map<number, EmoticonPack> = new Map();
  private emoticonList: Emoticon[] = [];
  private nextPackId = 1;
  private nextEmoId = 1;

  async getEmoticonPacks(activeOnly = true): Promise<EmoticonPack[]> {
    const all = Array.from(this.emoticonPackMap.values());
    return activeOnly ? all.filter(p => p.status === 1) : all;
  }
  async getEmoticonPack(id: number): Promise<EmoticonPack | undefined> { return this.emoticonPackMap.get(id); }
  async getEmoticons(packId?: number): Promise<Emoticon[]> {
    return packId != null ? this.emoticonList.filter(e => e.emoticonPackId === packId) : [...this.emoticonList];
  }
  async getEmoticonHeights(): Promise<number[]> {
    const heights = new Set(this.emoticonList.map(e => e.height));
    return Array.from(heights).sort((a, b) => a - b);
  }
  async getOptimalEmoticonHeight(fontHeight: number): Promise<number> {
    const heights = await this.getEmoticonHeights();
    if (heights.length === 0) return fontHeight;
    let prev = heights[0];
    for (const h of heights) { if (h > fontHeight) return prev === 0 ? heights[0] : prev; prev = h; }
    return prev;
  }
  async createEmoticonPack(data: InsertEmoticonPack): Promise<EmoticonPack> {
    const pack: EmoticonPack = { id: this.nextPackId++, ...data } as EmoticonPack;
    this.emoticonPackMap.set(pack.id, pack);
    return pack;
  }
  async updateEmoticonPack(id: number, updates: Partial<EmoticonPack>): Promise<EmoticonPack | undefined> {
    const pack = this.emoticonPackMap.get(id);
    if (!pack) return undefined;
    const updated = { ...pack, ...updates };
    this.emoticonPackMap.set(id, updated);
    return updated;
  }
  async createEmoticon(data: InsertEmoticon): Promise<Emoticon> {
    const emo: Emoticon = { id: this.nextEmoId++, ...data } as Emoticon;
    this.emoticonList.push(emo);
    return emo;
  }
  async updateEmoticon(id: number, updates: Partial<Emoticon>): Promise<Emoticon | undefined> {
    const idx = this.emoticonList.findIndex(e => e.id === id);
    if (idx < 0) return undefined;
    this.emoticonList[idx] = { ...this.emoticonList[idx], ...updates };
    return this.emoticonList[idx];
  }
  async deleteEmoticon(id: number): Promise<void> {
    this.emoticonList = this.emoticonList.filter(e => e.id !== id);
  }

  // ── Guardset ──────────────────────────────────────────────────────────────
  private guardsetRuleList: GuardsetRule[] = [];
  private nextGuardId = 1;

  async getMinimumClientVersionForAccess(clientType: number, guardCapability: number): Promise<number | null> {
    const rule = this.guardsetRuleList.find(r => r.clientType === clientType && r.guardCapability === guardCapability);
    return rule ? rule.minVersion : null;
  }
  async setGuardsetRule(clientType: number, guardCapability: number, minVersion: number, description?: string): Promise<GuardsetRule> {
    const existing = this.guardsetRuleList.find(r => r.clientType === clientType && r.guardCapability === guardCapability);
    if (existing) {
      existing.minVersion = minVersion;
      if (description !== undefined) existing.description = description ?? null;
      return existing;
    }
    const rule: GuardsetRule = { id: this.nextGuardId++, clientType, guardCapability, minVersion, description: description ?? null };
    this.guardsetRuleList.push(rule);
    return rule;
  }
  async getGuardsetRules(): Promise<GuardsetRule[]> { return [...this.guardsetRuleList]; }
  async deleteGuardsetRule(id: number): Promise<void> {
    this.guardsetRuleList = this.guardsetRuleList.filter(r => r.id !== id);
  }

  // Virtual Gifts catalog — predefined list matching old migme gifts
  private GIFT_CATALOG: VirtualGift[] = [
    { id: 1,  name: "rose",        hotKey: "🌹", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 1,  groupId: 1, groupVipOnly: false, location64x64Png: "/gifts/rose.png", location16x16Png: "/gifts/rose.png", giftAllMessage: null, status: 1 },
    { id: 2,  name: "heart",       hotKey: "❤️", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 2,  groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 3,  name: "diamond",     hotKey: "💎", price: 50, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 3,  groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 4,  name: "star",        hotKey: "⭐", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 4,  groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 5,  name: "chocolate",   hotKey: "🍫", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 5,  groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 6,  name: "bear",        hotKey: "🧸", price: 20, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 6,  groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 7,  name: "cake",        hotKey: "🎂", price: 15, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 7,  groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 8,  name: "crown",       hotKey: "👑", price: 100, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 8, groupId: 2, groupVipOnly: true,  location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 9,  name: "flower",      hotKey: "🌸", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 9,  groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 10, name: "butterfly",   hotKey: "🦋", price: 15, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 10, groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 11, name: "music",       hotKey: "🎵", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 11, groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 12, name: "trophy",      hotKey: "🏆", price: 30, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 12, groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 13, name: "kiss",        hotKey: "💋", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 13, groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 14, name: "candy",       hotKey: "🍬", price: 5,  currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 14, groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
    { id: 15, name: "sunflower",   hotKey: "🌻", price: 10, currency: "IDR", numAvailable: null, numSold: 0, sortOrder: 15, groupId: 1, groupVipOnly: false, location64x64Png: null, location16x16Png: null, giftAllMessage: null, status: 1 },
  ];

  async getVirtualGifts(): Promise<VirtualGift[]> {
    return [...this.GIFT_CATALOG];
  }

  async getVirtualGiftByName(name: string): Promise<VirtualGift | undefined> {
    const lower = name.toLowerCase().trim();
    return this.GIFT_CATALOG.find(g => g.name?.toLowerCase() === lower);
  }

  // Mirrors ContentBean.java: searchVirtualGifts(username, offset, keyword, limit, activeOnly)
  async searchVirtualGifts(query: string, limit = 5): Promise<VirtualGift[]> {
    const lower = query.toLowerCase().trim();
    return this.GIFT_CATALOG.filter(g => g.name?.toLowerCase().includes(lower)).slice(0, limit);
  }

  async updateGiftImage(name: string, imageUrl: string | null): Promise<void> {
    const lower = name.toLowerCase().trim();
    const gift = this.GIFT_CATALOG.find(g => g.name?.toLowerCase() === lower);
    if (gift) {
      gift.location64x64Png = imageUrl;
      gift.location16x16Png = imageUrl;
    }
  }

  // Mirrors ContentBean.java: buyVirtualGiftForMultipleUsers()
  private virtualGiftsReceivedList: VirtualGiftReceived[] = [];
  async createVirtualGiftReceived(data: InsertVirtualGiftReceived): Promise<VirtualGiftReceived> {
    const record: VirtualGiftReceived = {
      id: Math.floor(Math.random() * 1_000_000),
      username: data.username,
      sender: data.sender,
      virtualGiftId: data.virtualGiftId,
      message: data.message ?? null,
      purchaseLocation: 1,
      isPrivate: data.isPrivate ?? 0,
      removed: 0,
      createdAt: new Date(),
    };
    this.virtualGiftsReceivedList.push(record);
    return record;
  }

  // Mirrors ContentBean.java: getStickerDataByNameForUser(senderUsername, stickerName)
  // sanitizeStickerName → trimmedLowerCase, then alias match
  async getEmoticonByAlias(alias: string): Promise<Emoticon | undefined> {
    const lower = alias.toLowerCase().trim();
    return this.emoticonList.find(e => e.alias?.toLowerCase() === lower);
  }

  // ── Leaderboard ──────────────────────────────────────────────────────────────
  private leaderboardMap: Map<string, LeaderboardEntry[]> = new Map();
  async getLeaderboard(type: string, period: string, limit: number, offset: number): Promise<LeaderboardEntry[]> {
    const key = `${type}:${period}`;
    const entries = this.leaderboardMap.get(key) ?? [];
    return [...entries].sort((a, b) => b.score - a.score).slice(offset, offset + limit);
  }
  async getLeaderboardRank(type: string, period: string, username: string): Promise<{ score: number; position: number } | null> {
    const key = `${type}:${period}`;
    const sorted = (this.leaderboardMap.get(key) ?? []).sort((a, b) => b.score - a.score);
    const idx = sorted.findIndex(e => e.username === username);
    if (idx === -1) return null;
    return { score: sorted[idx].score, position: idx + 1 };
  }
  async upsertLeaderboardEntry(type: string, period: string, username: string, score: number, increment: boolean): Promise<LeaderboardEntry> {
    const key = `${type}:${period}`;
    const entries = this.leaderboardMap.get(key) ?? [];
    const idx = entries.findIndex(e => e.username === username);
    const entry: LeaderboardEntry = idx >= 0
      ? { ...entries[idx], score: increment ? entries[idx].score + score : score, updatedAt: new Date() }
      : { id: entries.length + 1, leaderboardType: type, period, username, score, updatedAt: new Date() };
    if (idx >= 0) entries[idx] = entry; else entries.push(entry);
    this.leaderboardMap.set(key, entries);
    return entry;
  }
  async resetLeaderboard(type: string, period: string, previousPeriod: string): Promise<void> {
    const key = `${type}:${period}`;
    const prevKey = `${type}:${previousPeriod}`;
    const entries = this.leaderboardMap.get(key) ?? [];
    this.leaderboardMap.set(prevKey, entries.map(e => ({ ...e, period: previousPeriod })));
    this.leaderboardMap.set(key, []);
  }

  // ── Invitation ───────────────────────────────────────────────────────────────
  private invitationMap: Map<string, Invitation> = new Map();
  async createInvitation(data: InsertInvitation): Promise<Invitation> {
    const inv: Invitation = { id: randomUUID(), ...data, createdAt: new Date(), expiresAt: data.expiresAt ?? null, metadata: data.metadata ?? null };
    this.invitationMap.set(inv.id, inv);
    return inv;
  }
  async getInvitationById(id: string): Promise<Invitation | undefined> { return this.invitationMap.get(id); }
  async getInvitationsBySender(username: string, limit: number): Promise<Invitation[]> {
    return Array.from(this.invitationMap.values()).filter(i => i.senderUsername === username).slice(0, limit);
  }
  async getInvitationsByDestination(destination: string): Promise<Invitation[]> {
    return Array.from(this.invitationMap.values()).filter(i => i.destination === destination);
  }
  async updateInvitationStatus(id: string, status: number): Promise<Invitation | undefined> {
    const inv = this.invitationMap.get(id);
    if (!inv) return undefined;
    const updated = { ...inv, status };
    this.invitationMap.set(id, updated);
    return updated;
  }
  async expireOldInvitations(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, inv] of this.invitationMap) {
      if (inv.status === 1 && inv.expiresAt && inv.expiresAt < now) {
        this.invitationMap.set(id, { ...inv, status: 4 });
        count++;
      }
    }
    return count;
  }

  // ── Reputation ───────────────────────────────────────────────────────────────
  private reputationMap: Map<string, UserReputationRow> = new Map();
  async getUserReputation(username: string): Promise<UserReputationRow | undefined> { return this.reputationMap.get(username); }
  async createUserReputation(username: string): Promise<UserReputationRow> {
    const rep: UserReputationRow = {
      id: this.reputationMap.size + 1, username, score: 0, level: 1,
      chatRoomMessagesSent: 0, privateMessagesSent: 0, totalTime: 0, photosUploaded: 0,
      kicksInitiated: 0, authenticatedReferrals: 0, rechargedAmount: 0,
      phoneCallDuration: 0, sessionCount: 0, virtualGiftsSent: 0, virtualGiftsReceived: 0,
      updatedAt: new Date(),
    };
    this.reputationMap.set(username, rep);
    return rep;
  }
  async incrementReputationScore(username: string, amount: number): Promise<UserReputationRow> {
    const rep = this.reputationMap.get(username) ?? await this.createUserReputation(username);
    const updated = { ...rep, score: rep.score + amount, updatedAt: new Date() };
    this.reputationMap.set(username, updated);
    return updated;
  }
  async updateReputationLevel(username: string, level: number): Promise<void> {
    const rep = this.reputationMap.get(username);
    if (rep) this.reputationMap.set(username, { ...rep, level, updatedAt: new Date() });
  }
  async updateReputationMetrics(username: string, metrics: Partial<Omit<UserReputationRow, "id" | "username" | "updatedAt">>): Promise<UserReputationRow> {
    const rep = this.reputationMap.get(username) ?? await this.createUserReputation(username);
    const updated: UserReputationRow = {
      ...rep,
      chatRoomMessagesSent: rep.chatRoomMessagesSent + (metrics.chatRoomMessagesSent ?? 0),
      privateMessagesSent:  rep.privateMessagesSent  + (metrics.privateMessagesSent  ?? 0),
      totalTime:            rep.totalTime            + (metrics.totalTime            ?? 0),
      photosUploaded:       rep.photosUploaded       + (metrics.photosUploaded       ?? 0),
      kicksInitiated:       rep.kicksInitiated       + (metrics.kicksInitiated       ?? 0),
      authenticatedReferrals: rep.authenticatedReferrals + (metrics.authenticatedReferrals ?? 0),
      rechargedAmount:      rep.rechargedAmount      + (metrics.rechargedAmount      ?? 0),
      phoneCallDuration:    rep.phoneCallDuration    + (metrics.phoneCallDuration    ?? 0),
      sessionCount:         rep.sessionCount         + (metrics.sessionCount         ?? 0),
      virtualGiftsSent:     rep.virtualGiftsSent     + (metrics.virtualGiftsSent     ?? 0),
      virtualGiftsReceived: rep.virtualGiftsReceived + (metrics.virtualGiftsReceived ?? 0),
      updatedAt: new Date(),
    };
    this.reputationMap.set(username, updated);
    return updated;
  }
  async getTopReputationUsers(limit: number, offset: number): Promise<UserReputationRow[]> {
    return Array.from(this.reputationMap.values()).sort((a, b) => b.score - a.score).slice(offset, offset + limit);
  }

  private levelTableMap: Map<number, LevelThreshold> = new Map(
    buildDefaultReputationLevels().map((entry) => [entry.level, entry] as [number, LevelThreshold]),
  );
  async getLevelTable(): Promise<LevelThreshold[]> {
    return Array.from(this.levelTableMap.values()).sort((a, b) => b.score - a.score);
  }
  async getLevelDataForScore(score: number): Promise<LevelThreshold | undefined> {
    const sorted = await this.getLevelTable();
    return sorted.find(t => score >= t.score);
  }
  async upsertLevelThreshold(data: InsertLevelThreshold): Promise<LevelThreshold> {
    const entry: LevelThreshold = {
      name: null, image: null, chatRoomSize: null, groupSize: null,
      numGroupChatRooms: null, ...data,
    };
    this.levelTableMap.set(data.level, entry);
    return entry;
  }
  async deleteLevelThreshold(level: number): Promise<void> {
    this.levelTableMap.delete(level);
  }

  // ── Payment ──────────────────────────────────────────────────────────────────
  private paymentMap: Map<number, Payment> = new Map();
  private paymentIdCounter = 1;
  async createPayment(data: InsertPayment): Promise<Payment> {
    const payment: Payment = { id: this.paymentIdCounter++, ...data, vendorTransactionId: data.vendorTransactionId ?? null, description: data.description ?? null, extraFields: data.extraFields ?? null, createdAt: new Date(), updatedAt: new Date() };
    this.paymentMap.set(payment.id, payment);
    return payment;
  }
  async getPaymentById(id: number): Promise<Payment | undefined> { return this.paymentMap.get(id); }
  async getPaymentsByUsername(username: string, limit: number, status?: number): Promise<Payment[]> {
    return Array.from(this.paymentMap.values()).filter(p => p.username === username && (status === undefined || p.status === status)).slice(0, limit);
  }
  async updatePaymentStatus(id: number, status: number, vendorTransactionId?: string): Promise<Payment | undefined> {
    const p = this.paymentMap.get(id);
    if (!p) return undefined;
    const updated = { ...p, status, vendorTransactionId: vendorTransactionId ?? p.vendorTransactionId, updatedAt: new Date() };
    this.paymentMap.set(id, updated);
    return updated;
  }

  // ── Search extensions ─────────────────────────────────────────────────────────
  async searchChatrooms(query: string, limit = 20, offset = 0, categoryId?: number, language?: string): Promise<Chatroom[]> {
    const q = query.toLowerCase();
    return Array.from(this.chatroomMap.values())
      .filter(c => (c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q))
        && (categoryId === undefined || c.categoryId === categoryId)
        && (language === undefined || c.language === language))
      .slice(offset, offset + limit);
  }
  async searchGroups(query: string, limit: number): Promise<Group[]> {
    const q = query.toLowerCase();
    return Array.from(this.groupMap?.values() ?? []).filter((g: any) => g.name?.toLowerCase().includes(q)).slice(0, limit) as Group[];
  }
  async searchMerchants(query: string, limit: number): Promise<Merchant[]> {
    const q = query.toLowerCase();
    return Array.from(this.merchantMap?.values() ?? []).filter((m: any) => m.name?.toLowerCase().includes(q)).slice(0, limit) as Merchant[];
  }
  async getAllChatroomsForIndex(): Promise<Chatroom[]> {
    return Array.from(this.chatroomMap.values());
  }

  // ── UserEvent ─────────────────────────────────────────────────────────────────
  private userEventMap: Map<string, UserEvent> = new Map();
  async createUserEvent(data: InsertUserEvent): Promise<UserEvent> {
    const event: UserEvent = { id: randomUUID(), ...data, payload: data.payload ?? null, createdAt: new Date() };
    this.userEventMap.set(event.id, event);
    return event;
  }
  async getUserEvents(username: string, limit: number, eventType?: string, since?: Date): Promise<UserEvent[]> {
    return Array.from(this.userEventMap.values())
      .filter(e => e.username === username && (eventType === undefined || e.eventType === eventType) && (since === undefined || e.createdAt >= since))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
  async deleteUserEvents(username: string): Promise<number> {
    let count = 0;
    for (const [id, e] of this.userEventMap) { if (e.username === username) { this.userEventMap.delete(id); count++; } }
    return count;
  }
  async deleteUserEventsByType(username: string, eventType: string): Promise<number> {
    let count = 0;
    for (const [id, e] of this.userEventMap) { if (e.username === username && e.eventType === eventType) { this.userEventMap.delete(id); count++; } }
    return count;
  }
  async getUserEventStats(username: string): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};
    for (const e of this.userEventMap.values()) { if (e.username === username) { stats[e.eventType] = (stats[e.eventType] ?? 0) + 1; } }
    return stats;
  }

  // ── FashionShow ───────────────────────────────────────────────────────────────
  private fashionShowMap: Map<string, FashionShowSession> = new Map();
  async getFashionShowCandidates(limit: number, offset: number): Promise<FashionShowSession[]> {
    return Array.from(this.fashionShowMap.values()).filter(s => s.status === 1).sort((a, b) => b.votes - a.votes).slice(offset, offset + limit);
  }
  async getFashionShowWinners(limit: number): Promise<FashionShowSession[]> {
    return Array.from(this.fashionShowMap.values()).filter(s => s.status === 2).sort((a, b) => b.votes - a.votes).slice(0, limit);
  }
  async getFashionShowByUsername(username: string): Promise<FashionShowSession | undefined> {
    return Array.from(this.fashionShowMap.values()).find(s => s.username === username);
  }
  async getFashionShowById(id: string): Promise<FashionShowSession | undefined> { return this.fashionShowMap.get(id); }
  async createFashionShowSession(data: InsertFashionShowSession): Promise<FashionShowSession> {
    const session: FashionShowSession = { id: randomUUID(), votes: 0, ...data, createdAt: new Date() };
    this.fashionShowMap.set(session.id, session);
    return session;
  }
  async incrementFashionShowVotes(id: string): Promise<FashionShowSession> {
    const s = this.fashionShowMap.get(id);
    if (!s) throw new Error("Session not found");
    const updated = { ...s, votes: s.votes + 1 };
    this.fashionShowMap.set(id, updated);
    return updated;
  }

  // ── PaintWars ─────────────────────────────────────────────────────────────────
  private paintwarsMap: Map<string, PaintwarsStats> = new Map();
  private paintwarsIdCounter = 1;
  async getPaintwarsStats(username: string): Promise<PaintwarsStats | undefined> { return this.paintwarsMap.get(username); }
  async createPaintwarsStats(username: string): Promise<PaintwarsStats> {
    const stats: PaintwarsStats = { id: this.paintwarsIdCounter++, username, totalPaintWarsPoints: 0, totalPaintsSent: 0, totalPaintsReceived: 0, totalCleansSent: 0, totalCleansReceived: 0, paintsRemaining: 3, cleansRemaining: 2, identiconIndex: 0, updatedAt: new Date() };
    this.paintwarsMap.set(username, stats);
    return stats;
  }
  async recordPaint(painterUsername: string, targetUsername: string, paid: boolean): Promise<{ painter: PaintwarsStats; target: PaintwarsStats }> {
    const painter = this.paintwarsMap.get(painterUsername) ?? await this.createPaintwarsStats(painterUsername);
    const target = this.paintwarsMap.get(targetUsername) ?? await this.createPaintwarsStats(targetUsername);
    const updatedPainter = { ...painter, totalPaintsSent: painter.totalPaintsSent + 1, totalPaintWarsPoints: painter.totalPaintWarsPoints + 1, paintsRemaining: paid ? painter.paintsRemaining : painter.paintsRemaining - 1, updatedAt: new Date() };
    const updatedTarget = { ...target, totalPaintsReceived: target.totalPaintsReceived + 1, updatedAt: new Date() };
    this.paintwarsMap.set(painterUsername, updatedPainter);
    this.paintwarsMap.set(targetUsername, updatedTarget);
    return { painter: updatedPainter, target: updatedTarget };
  }
  async recordClean(cleanerUsername: string, targetUsername: string, paid: boolean): Promise<{ cleaner: PaintwarsStats; target: PaintwarsStats }> {
    const cleaner = this.paintwarsMap.get(cleanerUsername) ?? await this.createPaintwarsStats(cleanerUsername);
    const target = this.paintwarsMap.get(targetUsername) ?? await this.createPaintwarsStats(targetUsername);
    const updatedCleaner = { ...cleaner, totalCleansSent: cleaner.totalCleansSent + 1, cleansRemaining: paid ? cleaner.cleansRemaining : cleaner.cleansRemaining - 1, updatedAt: new Date() };
    const updatedTarget = { ...target, totalCleansReceived: target.totalCleansReceived + 1, updatedAt: new Date() };
    this.paintwarsMap.set(cleanerUsername, updatedCleaner);
    this.paintwarsMap.set(targetUsername, updatedTarget);
    return { cleaner: updatedCleaner, target: updatedTarget };
  }
  async resetDailyPaintwarsAllowances(paintsPerDay: number, cleansPerDay: number): Promise<number> {
    let count = 0;
    for (const [username, stats] of this.paintwarsMap) {
      this.paintwarsMap.set(username, { ...stats, paintsRemaining: paintsPerDay, cleansRemaining: cleansPerDay, updatedAt: new Date() });
      count++;
    }
    return count;
  }
  async getPaintwarsLeaderboard(limit: number): Promise<PaintwarsStats[]> {
    return Array.from(this.paintwarsMap.values()).sort((a, b) => b.totalPaintWarsPoints - a.totalPaintWarsPoints).slice(0, limit);
  }

  // ── SMS Engine ────────────────────────────────────────────────────────────────
  private smsMap: Map<number, SmsMessage> = new Map();
  private smsIdCounter = 1;
  async createSmsMessage(data: InsertSmsMessage): Promise<SmsMessage> {
    const sms: SmsMessage = { id: this.smsIdCounter++, ...data, username: data.username ?? null, gateway: data.gateway ?? null, createdAt: new Date() };
    this.smsMap.set(sms.id, sms);
    return sms;
  }
  async getSmsMessageById(id: number): Promise<SmsMessage | undefined> { return this.smsMap.get(id); }
  async getSmsHistory(phoneNumber?: string, username?: string, limit = 20): Promise<SmsMessage[]> {
    return Array.from(this.smsMap.values()).filter(s => (!phoneNumber || s.phoneNumber === phoneNumber) && (!username || s.username === username)).slice(0, limit);
  }
  async updateSmsStatus(id: number, status: number): Promise<SmsMessage | undefined> {
    const sms = this.smsMap.get(id);
    if (!sms) return undefined;
    const updated = { ...sms, status };
    this.smsMap.set(id, updated);
    return updated;
  }
  async retryPendingSmsMessages(): Promise<number> {
    let count = 0;
    for (const [id, sms] of this.smsMap) {
      if (sms.status === 3) { this.smsMap.set(id, { ...sms, status: 1, retryCount: sms.retryCount + 1 }); count++; }
    }
    return count;
  }
  async getPendingSmsMessages(limit: number): Promise<SmsMessage[]> {
    return Array.from(this.smsMap.values()).filter(s => s.status === 1).slice(0, limit);
  }

  // ── Voice Engine ──────────────────────────────────────────────────────────────
  private voiceCallMap: Map<string, VoiceCall> = new Map();
  async createVoiceCall(data: InsertVoiceCall): Promise<VoiceCall> {
    const call: VoiceCall = { id: randomUUID(), ...data, callingCard: data.callingCard ?? null, endedAt: data.endedAt ?? null, createdAt: new Date() };
    this.voiceCallMap.set(call.id, call);
    return call;
  }
  async getVoiceCallById(id: string): Promise<VoiceCall | undefined> { return this.voiceCallMap.get(id); }
  async updateVoiceCallStatus(id: string, status: number, duration?: number, endedAt?: Date): Promise<VoiceCall | undefined> {
    const call = this.voiceCallMap.get(id);
    if (!call) return undefined;
    const updated = { ...call, status, duration: duration ?? call.duration, endedAt: endedAt ?? call.endedAt };
    this.voiceCallMap.set(id, updated);
    return updated;
  }
  async getVoiceCallHistory(username: string, limit: number, type: "caller" | "callee" | "all"): Promise<VoiceCall[]> {
    return Array.from(this.voiceCallMap.values())
      .filter(c => (type === "all" && (c.callerUsername === username || c.calleeUsername === username)) || (type === "caller" && c.callerUsername === username) || (type === "callee" && c.calleeUsername === username))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  // ── Image Server ──────────────────────────────────────────────────────────────
  private imageMap: Map<string, ServerImage> = new Map();
  async storeImage(data: InsertServerImage): Promise<ServerImage> {
    const image: ServerImage = { id: randomUUID(), ...data, description: data.description ?? null, createdAt: new Date() };
    this.imageMap.set(image.id, image);
    return image;
  }
  async getImageById(id: string): Promise<ServerImage | undefined> { return this.imageMap.get(id); }
  async getImageByKey(imageKey: string): Promise<ServerImage | undefined> {
    return Array.from(this.imageMap.values()).find(i => i.imageKey === imageKey);
  }
  async deleteImage(id: string): Promise<boolean> {
    return this.imageMap.delete(id);
  }
  async getImagesByUsername(username: string, limit: number): Promise<ServerImage[]> {
    return Array.from(this.imageMap.values()).filter(i => i.username === username).slice(0, limit);
  }
  async getImageServerStats(): Promise<{ totalImages: number; totalSizeBytes: number }> {
    const images = Array.from(this.imageMap.values());
    return { totalImages: images.length, totalSizeBytes: images.reduce((sum, i) => sum + i.sizeBytes, 0) };
  }

  // ── Notifications / UNS ───────────────────────────────────────────────────────
  private notificationMap: Map<string, Notification> = new Map();
  async createNotification(data: InsertNotification): Promise<Notification> {
    const n: Notification = { id: randomUUID(), ...data, subject: data.subject ?? null, createdAt: new Date() };
    this.notificationMap.set(n.id, n);
    return n;
  }
  async getNotifications(username: string, limit: number, type?: string, status?: number): Promise<Notification[]> {
    return Array.from(this.notificationMap.values()).filter(n => n.username === username && (type === undefined || n.type === type) && (status === undefined || n.status === status)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }
  async updateNotificationStatus(id: string, status: number): Promise<Notification | undefined> {
    const n = this.notificationMap.get(id);
    if (!n) return undefined;
    const updated = { ...n, status };
    this.notificationMap.set(id, updated);
    return updated;
  }
  async getPendingNotifications(limit: number): Promise<Notification[]> {
    return Array.from(this.notificationMap.values()).filter(n => n.status === 1).slice(0, limit);
  }
  async getGroupMembersForEmailNotification(groupId: number): Promise<string[]> {
    return this.groupMemberList.filter(m => m.groupId === groupId && m.status === GROUP_MEMBER_STATUS.ACTIVE && m.emailNotification > 0).map(m => m.username);
  }
  async getGroupMembersForSMSNotification(groupId: number): Promise<{ username: string; mobileNumber: string }[]> {
    const members = this.groupMemberList.filter(m => m.groupId === groupId && m.status === GROUP_MEMBER_STATUS.ACTIVE && m.smsNotification > 0);
    return members.map(m => ({ username: m.username, mobileNumber: "" }));
  }
  async getGroupMembersForGroupEventSMSNotification(groupId: number): Promise<{ username: string; mobileNumber: string }[]> {
    const members = this.groupMemberList.filter(m => m.groupId === groupId && m.status === GROUP_MEMBER_STATUS.ACTIVE && m.eventNotification > 0);
    return members.map(m => ({ username: m.username, mobileNumber: "" }));
  }
  async getGroupMembersForGroupEventAlertNotification(groupId: number): Promise<string[]> {
    return this.groupMemberList.filter(m => m.groupId === groupId && m.status === GROUP_MEMBER_STATUS.ACTIVE && m.eventNotification > 0).map(m => m.username);
  }
  async getGroupPostSubscribersForEmail(userPostId: number): Promise<string[]> {
    return [];
  }
  async getMobileNumberForUser(username: string): Promise<string | null> {
    return null;
  }
  async getNotificationCountByType(username: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const n of this.notificationMap.values()) {
      if (n.username === username && n.status === 1) {
        counts[n.type] = (counts[n.type] ?? 0) + 1;
      }
    }
    return counts;
  }
  async deleteAllNotificationsByType(username: string, notfnType: string): Promise<Notification[]> {
    const deleted: Notification[] = [];
    for (const [id, n] of this.notificationMap) {
      if (n.username === username && n.type === notfnType) {
        deleted.push(n);
        this.notificationMap.delete(id);
      }
    }
    return deleted;
  }
  async deleteNotificationsByIds(ids: string[]): Promise<Notification[]> {
    const deleted: Notification[] = [];
    for (const id of ids) {
      const n = this.notificationMap.get(id);
      if (n) { deleted.push(n); this.notificationMap.delete(id); }
    }
    return deleted;
  }
  async purgeOldNotifications(username: string, maxCount: number, truncateTo: number): Promise<number> {
    const userNotifs = Array.from(this.notificationMap.values()).filter(n => n.username === username).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (userNotifs.length <= maxCount) return 0;
    const toDelete = userNotifs.slice(0, userNotifs.length - truncateTo);
    for (const n of toDelete) this.notificationMap.delete(n.id);
    return toDelete.length;
  }

  // ── Message Switchboard ───────────────────────────────────────────────────────
  private switchboardMap: Map<string, SwitchboardMessage> = new Map();
  async createSwitchboardMessage(data: InsertSwitchboardMessage): Promise<SwitchboardMessage> {
    const msg: SwitchboardMessage = { id: randomUUID(), ...data, payload: data.payload ?? null, createdAt: new Date() };
    this.switchboardMap.set(msg.id, msg);
    return msg;
  }
  async getPendingSwitchboardMessages(username: string, limit: number, messageType?: string): Promise<SwitchboardMessage[]> {
    return Array.from(this.switchboardMap.values()).filter(m => m.toUsername === username && m.status === 1 && (messageType === undefined || m.messageType === messageType)).slice(0, limit);
  }
  async updateSwitchboardMessageStatus(id: string, status: number): Promise<SwitchboardMessage | undefined> {
    const msg = this.switchboardMap.get(id);
    if (!msg) return undefined;
    const updated = { ...msg, status };
    this.switchboardMap.set(id, updated);
    return updated;
  }
  async clearDeliveredSwitchboardMessages(username: string): Promise<number> {
    let count = 0;
    for (const [id, m] of this.switchboardMap) { if (m.toUsername === username && m.status === 2) { this.switchboardMap.delete(id); count++; } }
    return count;
  }
  async getSwitchboardStats(): Promise<{ queued: number; delivered: number; failed: number }> {
    const all = Array.from(this.switchboardMap.values());
    return { queued: all.filter(m => m.status === 1).length, delivered: all.filter(m => m.status === 2).length, failed: all.filter(m => m.status === 3).length };
  }
  async flushSwitchboardMessages(): Promise<number> {
    const count = this.switchboardMap.size;
    this.switchboardMap.clear();
    return count;
  }

  async getUserPrivacySettings(username: string): Promise<UserPrivacySettings> {
    return {
      id: randomUUID(), username,
      dobPrivacy: 0, firstLastNamePrivacy: 0, mobilePhonePrivacy: 0, externalEmailPrivacy: 0,
      chatPrivacy: 1, buzzPrivacy: 1, lookoutPrivacy: 1, footprintsPrivacy: 0, feedPrivacy: 1,
      activityStatusUpdates: true, activityProfileChanges: true, activityAddFriends: false,
      activityPhotosPublished: true, activityContentPurchased: true, activityChatroomCreation: true,
      activityVirtualGifting: true, updatedAt: new Date(),
    };
  }
  async updateUserPrivacySettings(username: string, updates: Partial<Omit<UserPrivacySettings, 'id' | 'username' | 'updatedAt'>>): Promise<UserPrivacySettings> {
    return this.getUserPrivacySettings(username);
  }

  // ── User Settings ─────────────────────────────────────────────────────────
  private userSettingsMap: Map<string, Map<number, UserSetting>> = new Map();

  async getUserSettings(username: string): Promise<UserSetting[]> {
    const userMap = this.userSettingsMap.get(username);
    if (!userMap) return [];
    return Array.from(userMap.values());
  }

  async getUserSetting(username: string, type: number): Promise<UserSetting | undefined> {
    return this.userSettingsMap.get(username)?.get(type);
  }

  async upsertUserSetting(username: string, type: number, value: number): Promise<UserSetting> {
    if (!this.userSettingsMap.has(username)) {
      this.userSettingsMap.set(username, new Map());
    }
    const userMap = this.userSettingsMap.get(username)!;
    const existing = userMap.get(type);
    const setting: UserSetting = {
      id: existing?.id ?? Math.floor(Math.random() * 1000000),
      username,
      type,
      value,
    };
    userMap.set(type, setting);
    return setting;
  }

  // ── Diamond Balance (MemStorage stubs — dev only) ─────────────────────────
  private diamondBalances = new Map<string, number>();
  async getDiamondBalance(username: string): Promise<number> {
    return this.diamondBalances.get(username.toLowerCase()) ?? 0;
  }
  async getDiamondTotalEarned(username: string): Promise<number> {
    return this.diamondBalances.get(username.toLowerCase()) ?? 0;
  }
  async getDiamondTotalWithdrawn(_username: string): Promise<number> {
    return 0;
  }
  async adjustDiamondBalance(username: string, amount: number, _type: string, _description: string, _reference?: string): Promise<number> {
    const key = username.toLowerCase();
    const current = this.diamondBalances.get(key) ?? 0;
    const newBal = Math.max(0, current + Math.floor(amount));
    this.diamondBalances.set(key, newBal);
    return newBal;
  }
  async getDiamondTransactions(_username: string, _limit?: number, _offset?: number): Promise<{ id: string; amount: number; type: string; reference: string | null; description: string | null; runningBalance: number; createdAt: Date }[]> {
    return [];
  }
}

import { DatabaseStorage } from "./db-storage";

export const storage: IStorage = new DatabaseStorage();

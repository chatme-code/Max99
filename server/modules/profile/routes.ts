import type { Express, Request, Response } from "express";
import { requireVerified } from "../../middleware/accessControl";
import { db } from "../../db";
import { users, userProfiles, contacts, badgesRewarded, virtualGiftsReceived, contactRequests, friendships, badges, LEADERBOARD_TYPE, merchants } from "@shared/schema";
import { and, count, eq, ilike, ne, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { storage } from "../../storage";
import { PROFILE_STATUS } from "@shared/schema";
import { getUserPresence, getUserStatusMessage, setUserStatusMessage, setUserPresenceOverride, broadcastToUser, broadcastPresenceToFriends } from "../../gateway";
import { scoreToLevel } from "../reputation/routes";

// ─── Auto-assigned badges ───────────────────────────────────────────────────
// Compute which badges this user earns by virtue of their leaderboard rank
// (top 1/2/3 in a game's wins, or top 1/2/3 gift sender). Configured in admin.
function leaderboardKeyForBadge(slotKind: string, slotGameType: string | null): string | null {
  if (slotKind === "gift_sender") return LEADERBOARD_TYPE.GIFT_SENT;
  if (slotKind !== "game_win" || !slotGameType) return null;
  // Map admin's gameType string → MOST_WINS leaderboard key.
  const map: Record<string, string> = {
    lowcard:  LEADERBOARD_TYPE.LOW_CARD_MOST_WINS,
    dice:     LEADERBOARD_TYPE.DICE_MOST_WINS,
    cricket:  LEADERBOARD_TYPE.CRICKET_MOST_WINS,
    football: LEADERBOARD_TYPE.FOOTBALL_MOST_WINS,
    warriors: LEADERBOARD_TYPE.WARRIORS_MOST_WINS,
    pelakor:  LEADERBOARD_TYPE.TEBAK_HATI_MOST_WINS,
  };
  return map[slotGameType.toLowerCase()] ?? null;
}

interface AutoBadge {
  id: number;
  name: string;
  description: string;
  iconUrl: string | null;
  avatarFrameUrl: string | null;
  rank: number;
  source: string; // human label, e.g. "Top 1 Pelakor Wins (All-time)"
}

async function computeAutoBadges(username: string): Promise<AutoBadge[]> {
  // 1) Load every badge with a configured slot.
  const slotted = await db.select().from(badges).where(isNotNull(badges.slotKind));
  if (slotted.length === 0) return [];

  // 2) Group by (lbKey, period) so we only fetch each leaderboard top-3 once.
  const groups = new Map<string, { lbKey: string; period: string }>();
  for (const b of slotted) {
    const lbKey = leaderboardKeyForBadge(b.slotKind!, b.slotGameType ?? null);
    if (!lbKey || !b.slotPeriod || !b.slotRank) continue;
    groups.set(`${lbKey}|${b.slotPeriod}`, { lbKey, period: b.slotPeriod });
  }

  // 3) Find user's rank within each group's top 3.
  const topByGroup = new Map<string, string[]>(); // groupKey → [rank1, rank2, rank3] usernames (lowercased)
  await Promise.all(
    Array.from(groups.entries()).map(async ([gKey, { lbKey, period }]) => {
      const top = await storage.getLeaderboard(lbKey, period, 3, 0);
      topByGroup.set(gKey, top.map(t => (t.username || "").toLowerCase()));
    })
  );

  const lowerName = username.toLowerCase();
  const earned: AutoBadge[] = [];
  for (const b of slotted) {
    const lbKey = leaderboardKeyForBadge(b.slotKind!, b.slotGameType ?? null);
    if (!lbKey || !b.slotPeriod || !b.slotRank) continue;
    const tops = topByGroup.get(`${lbKey}|${b.slotPeriod}`);
    if (!tops) continue;
    const idx = tops.indexOf(lowerName);
    if (idx === -1 || idx + 1 !== b.slotRank) continue;

    const periodLabel = b.slotPeriod === "ALL_TIME" ? "All-time"
                      : b.slotPeriod === "WEEKLY"   ? "Weekly"
                      : b.slotPeriod === "DAILY"    ? "Daily"
                      : b.slotPeriod;
    const what = b.slotKind === "gift_sender"
      ? "Gift Sender"
      : `${(b.slotGameType ?? "").toUpperCase()} Wins`;
    earned.push({
      id:             b.id,
      name:           b.name,
      description:    b.description ?? "",
      iconUrl:        b.iconUrl ?? null,
      avatarFrameUrl: (b as any).avatarFrameUrl ?? null,
      rank:           b.slotRank,
      source:         `Top ${b.slotRank} ${what} (${periodLabel})`,
    });
  }
  // Sort: rank ascending, then by name
  earned.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return earned;
}

// Manually awarded badges (admin → "Berikan ke User"). Live in `badges_rewarded`
// and merge into the same autoBadges array so the mini profile shows them
// immediately (no extra UI needed on the client).
async function loadManualBadges(username: string, alreadyShownIds: Set<number>): Promise<AutoBadge[]> {
  const rows = await db
    .select({
      id:             badges.id,
      name:           badges.name,
      description:    badges.description,
      iconUrl:        badges.iconUrl,
      avatarFrameUrl: badges.avatarFrameUrl,
    })
    .from(badgesRewarded)
    .innerJoin(badges, eq(badges.id, badgesRewarded.badgeId))
    .where(ilike(badgesRewarded.username, username));

  const out: AutoBadge[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (alreadyShownIds.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id:             r.id,
      name:           r.name,
      description:    r.description ?? "",
      iconUrl:        r.iconUrl ?? null,
      avatarFrameUrl: r.avatarFrameUrl ?? null,
      rank:           99, // sorted to the end
      source:         "Awarded",
    });
  }
  return out;
}

// Normalize imageserver URLs: old uploads stored `/api/imageserver/image/{id}` (JSON endpoint)
// but should point to `/api/imageserver/image/{id}/data` (raw image endpoint).
function normalizeDisplayPicture(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  if (/\/api\/imageserver\/image\/[^/]+$/.test(url)) return url + '/data';
  return url;
}

// ─── System Avatars ────────────────────────────────────────────────────────────
// Mirrors Java: UserResource.updateUserDisplayPicture() / UserBean.updateDisplayPicture()
// displayPictureId stored in `displayPicture` column on `user_profiles` table
// Client uses these IDs to call POST /api/profile/me/display-picture
const SYSTEM_AVATARS = [
  { id: 'sys_av_01', name: 'Mia',     imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=mia&size=128&backgroundColor=b6e3f4' },
  { id: 'sys_av_02', name: 'Kai',     imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=kai&size=128&backgroundColor=ffd5dc' },
  { id: 'sys_av_03', name: 'Zara',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=zara&size=128&backgroundColor=d1f4e0' },
  { id: 'sys_av_04', name: 'Ryo',     imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=ryo&size=128&backgroundColor=ffdfbf' },
  { id: 'sys_av_05', name: 'Aiko',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=aiko&size=128&backgroundColor=c9f0ff' },
  { id: 'sys_av_06', name: 'Dani',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=dani&size=128&backgroundColor=fce4ec' },
  { id: 'sys_av_07', name: 'Suki',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=suki&size=128&backgroundColor=e8f5e9' },
  { id: 'sys_av_08', name: 'Max',     imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=max&size=128&backgroundColor=ede7f6' },
  { id: 'sys_av_09', name: 'Luna',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=luna&size=128&backgroundColor=fff3e0' },
  { id: 'sys_av_10', name: 'Taro',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=taro&size=128&backgroundColor=e3f2fd' },
  { id: 'sys_av_11', name: 'Hana',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=hana&size=128&backgroundColor=fce4ec' },
  { id: 'sys_av_12', name: 'Ren',     imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=ren&size=128&backgroundColor=e8eaf6' },
  { id: 'sys_av_13', name: 'Cleo',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=cleo&size=128&backgroundColor=f3e5f5' },
  { id: 'sys_av_14', name: 'Finn',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=finn&size=128&backgroundColor=e0f2f1' },
  { id: 'sys_av_15', name: 'Bea',     imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=bea&size=128&backgroundColor=fff9c4' },
  { id: 'sys_av_16', name: 'Kira',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=kira&size=128&backgroundColor=b2dfdb' },
  { id: 'sys_av_17', name: 'Juno',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=juno&size=128&backgroundColor=ffd180' },
  { id: 'sys_av_18', name: 'Nico',    imageUrl: 'https://api.dicebear.com/7.x/adventurer/png?seed=nico&size=128&backgroundColor=b3e5fc' },
];

export function registerProfileRoutes(app: Express): void {
  // ── GET /api/avatar/system-avatars — mirrors UserBean.getSystemDisplayPictures()
  // Returns the list of system (built-in) avatars the user can set as their display picture.
  app.get("/api/avatar/system-avatars", (_req: Request, res: Response) => {
    return res.status(200).json({ avatars: SYSTEM_AVATARS });
  });

  // ── POST /api/profile/me/display-picture — mirrors UserResource.updateUserDisplayPicture()
  // Sets displayPicture to a system avatar ID (no upload needed).
  // Body: { displayPictureId: string }
  app.post("/api/profile/me/display-picture", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const { displayPictureId } = req.body as { displayPictureId?: string };
    if (!displayPictureId) return res.status(400).json({ message: "displayPictureId wajib diisi" });

    // Validate: must be a known system avatar ID or a safe URL string
    const isSystemAvatar = SYSTEM_AVATARS.some(a => a.id === displayPictureId);
    const isSafeUrl = /^[0-9a-zA-Z._\-:/]+$/.test(displayPictureId);
    if (!isSystemAvatar && !isSafeUrl) {
      return res.status(400).json({ message: "displayPictureId tidak valid" });
    }

    const avatar = SYSTEM_AVATARS.find(a => a.id === displayPictureId);
    // Store the full imageUrl for system avatars, or the value as-is for custom URLs
    const displayPicture = avatar ? avatar.imageUrl : displayPictureId;

    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });

    await storage.upsertUserProfile(user.id, { userId: user.id, displayPicture });
    return res.status(200).json({ ok: true, message: "Display picture berhasil diubah", displayPicture });
  });

  // List all users (friend list / people discovery)
  app.get("/api/users", async (req: Request, res: Response) => {
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 100);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);
    const selfId = req.session.userId;

    const neFilter = selfId ? ne(users.id, selfId) : undefined;
    const qFilter  = q ? ilike(users.username, `%${q}%`) : undefined;
    const where = neFilter && qFilter ? and(neFilter, qFilter) : (neFilter ?? qFilter);

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        displayPicture: userProfiles.displayPicture,
        aboutMe: userProfiles.aboutMe,
        country: userProfiles.country,
      })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(where)
      .limit(limit)
      .offset(offset);
    return res.status(200).json({ users: rows, total: rows.length });
  });

  // Helper: fetch reputation score and compute real migLevel (always accurate)
  async function computedMigLevel(username: string): Promise<number> {
    const rep = await storage.getUserReputation(username);
    if (!rep) return 1;
    return scoreToLevel(rep.score);
  }

  // ── GET /api/profile/me — MUST be registered before /:username to avoid shadowing
  app.get("/api/profile/me", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });

    const [profile, migLevel, friendsRow, followingRow, giftsRow, googleRow] = await Promise.all([
      storage.getUserProfile(user.id),
      computedMigLevel(user.username),
      db.select({ total: count() }).from(friendships).where(eq(friendships.userId, user.id)),
      db.select({ total: count() }).from(contacts).where(and(eq(contacts.username, user.username), isNotNull(contacts.fusionUsername))),
      db.execute(sql`SELECT COUNT(*) AS total FROM virtual_gifts_received WHERE LOWER(username) = LOWER(${user.username}) AND removed = 0`),
      db.execute(sql`SELECT google_sub, username_changed_at FROM users WHERE id = ${user.id} LIMIT 1`).catch(() => ({ rows: [] as any[] })),
    ]);

    const normalizedProfile = profile
      ? { ...profile, displayPicture: normalizeDisplayPicture(profile.displayPicture), migLevel }
      : profile;

    // Keep stored migLevel in sync (background, non-blocking)
    if (profile && profile.migLevel !== migLevel) {
      storage.upsertUserProfile(user.id, { migLevel }).catch(() => {});
    }

    // Expose shop frame at top-level so client can read data.avatarFrameUrl directly
    const avatarFrameUrl = (normalizedProfile as any)?.avatarFrameUrl ?? null;

    // Expose Google account flags for username-change eligibility
    const gRow = (googleRow.rows as any[])[0];
    const isGoogleUser     = !!gRow?.google_sub;
    const canChangeUsername = isGoogleUser && !gRow?.username_changed_at;

    return res.status(200).json({
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email, isGoogleUser, canChangeUsername },
      profile: normalizedProfile,
      avatarFrameUrl,
      counts: {
        friends:       friendsRow[0]?.total  ?? 0,
        following:     followingRow[0]?.total ?? 0,
        giftsReceived: Number((giftsRow.rows[0] as any)?.total ?? 0),
      },
    });
  });

  app.get("/api/profile/:username", async (req: Request, res: Response) => {
    const user = await storage.getUserByUsername(req.params.username);
    if (!user) return res.status(404).json({ message: "User tidak ditemukan" });

    const [profile, migLevel, isOwner] = await Promise.all([
      storage.getUserProfile(user.id),
      computedMigLevel(user.username),
      Promise.resolve(req.session.userId === user.id),
    ]);

    if (profile && profile.profileStatus === PROFILE_STATUS.PRIVATE && !isOwner) {
      return res.status(200).json({
        user: { id: user.id, username: user.username, displayName: user.displayName },
        profile: null,
        isPrivate: true,
      });
    }

    const [followersRow, coinsRow, badgesRow, leaderboardBadges, mentorRow, friendsRow, followingRow, giftsRow] = await Promise.all([
      db.select({ total: count() }).from(contacts).where(ilike(contacts.fusionUsername, user.username)),
      db.execute(sql`SELECT COALESCE(SUM(amount), 0) AS total FROM diamond_transactions WHERE LOWER(username) = LOWER(${user.username}) AND type = 'GIFT_RECEIVED'`),
      db.select({ total: count() }).from(badgesRewarded).where(ilike(badgesRewarded.username, user.username)),
      computeAutoBadges(user.username),
      // Merchant lookup (any level) — recomputed every request, so the
      // badge auto-disappears the moment the merchant row is removed.
      db.select({ merchantType: merchants.merchantType })
        .from(merchants)
        .where(ilike(merchants.username, user.username))
        .limit(1),
      // Friends count (bidirectional friendships)
      db.select({ total: count() }).from(friendships).where(eq(friendships.userId, user.id)),
      // Following count (contacts this user has added)
      db.select({ total: count() }).from(contacts).where(and(eq(contacts.username, user.username), isNotNull(contacts.fusionUsername))),
      // Total gifts received count
      db.execute(sql`SELECT COUNT(*) AS total FROM virtual_gifts_received WHERE LOWER(username) = LOWER(${user.username}) AND removed = 0`),
    ]);

    // Live status flags — auto-show admin/merchant badges next to username.
    // Recomputed on each call, so when admin status or merchant role is
    // revoked the badge instantly stops appearing on the mini profile.
    //   merchantType: 1=MERCHANT (lvl 1), 2=MENTOR (lvl 2), 3=HEAD_MENTOR (lvl 3)
    const isAdmin = !!user.isAdmin;
    const merchantType = mentorRow[0]?.merchantType ?? null;

    // Merge manually awarded badges (admin → "Berikan ke User") into the
    // same array the mini profile already renders. Skip ids that the
    // leaderboard step already produced so we never show duplicates.
    const shownIds = new Set(leaderboardBadges.map(b => b.id));
    const manualBadges = await loadManualBadges(user.username, shownIds);
    const autoBadges = [...leaderboardBadges, ...manualBadges];

    const normalizedProfile = profile
      ? { ...profile, displayPicture: normalizeDisplayPicture(profile.displayPicture), migLevel }
      : profile;

    // Keep stored migLevel in sync (background, non-blocking)
    if (profile && profile.migLevel !== migLevel) {
      storage.upsertUserProfile(user.id, { migLevel }).catch(() => {});
    }

    // Pick avatar frame: shop frame (user_profiles) takes priority over badge frame
    let shopFrameUrl: string | null = null;
    try {
      const shopRow = await db.execute(sql`
        SELECT avatar_frame_url FROM user_profiles WHERE user_id = ${user.id} LIMIT 1
      `);
      shopFrameUrl = (shopRow.rows[0] as any)?.avatar_frame_url ?? null;
    } catch {}
    const avatarFrameUrl = shopFrameUrl ?? autoBadges.find(b => b.avatarFrameUrl)?.avatarFrameUrl ?? null;

    return res.status(200).json({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      profile: normalizedProfile,
      isOwner,
      isAdmin,
      merchantType, // 1=MERCHANT, 2=MENTOR, 3=HEAD_MENTOR, null=not a merchant
      counts: {
        followers:     followersRow[0]?.total ?? 0,
        coinsReceived: Number((coinsRow.rows[0] as any)?.total ?? 0),
        badges:        badgesRow[0]?.total ?? 0,
        friends:       friendsRow[0]?.total ?? 0,
        following:     followingRow[0]?.total ?? 0,
        giftsReceived: Number((giftsRow.rows[0] as any)?.total ?? 0),
      },
      autoBadges,
      avatarFrameUrl,
    });
  });

  // GET /api/profile/:username/gifts-received — list gifts received by a user (with images)
  app.get("/api/profile/:username/gifts-received", async (req: Request, res: Response) => {
    const { username } = req.params;
    const limit  = Math.min(60, Math.max(1, Number(req.query.limit)  || 40));
    const offset = Math.max(0,              Number(req.query.offset) || 0);

    try {
      const result = await db.execute(sql`
        SELECT
          r.id,
          r.sender,
          r.message,
          r.created_at,
          COALESCE(
            (SELECT pg.image_url FROM party_gifts pg
             WHERE (r.message ILIKE (pg.name || ' %') OR LOWER(r.message) = LOWER(pg.name))
               AND pg.is_active = true
             ORDER BY LENGTH(pg.name) DESC LIMIT 1),
            (SELECT vg.location_64x64_png FROM virtual_gifts vg
             WHERE vg.id = r.virtual_gift_id AND vg.status = 1 LIMIT 1)
          ) AS image_url,
          COALESCE(
            (SELECT pg.emoji FROM party_gifts pg
             WHERE (r.message ILIKE (pg.name || ' %') OR LOWER(r.message) = LOWER(pg.name))
               AND pg.is_active = true
             ORDER BY LENGTH(pg.name) DESC LIMIT 1),
            (SELECT vg.hot_key FROM virtual_gifts vg
             WHERE vg.id = r.virtual_gift_id AND vg.status = 1 LIMIT 1)
          ) AS emoji
        FROM virtual_gifts_received r
        WHERE LOWER(r.username) = LOWER(${username})
          AND r.removed = 0
        ORDER BY r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      return res.json({ gifts: result.rows });
    } catch (e) {
      console.error("[gifts-received]", e);
      return res.status(500).json({ message: "Gagal memuat hadiah" });
    }
  });

  // AccessControl: EDIT_PROFILE (emailVerified required)
  app.put("/api/profile/me", requireVerified("EDIT_PROFILE"), async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });

    const {
      displayName,
      gender,
      dateOfBirth,
      country,
      city,
      aboutMe,
      likes,
      dislikes,
      relationshipStatus,
      profileStatus,
      anonymousViewing,
      displayPicture,
    } = req.body;

    if (displayName) {
      await storage.updateUser(user.id, { displayName });
    }

    const profile = await storage.upsertUserProfile(user.id, {
      userId: user.id,
      gender,
      dateOfBirth,
      country,
      city,
      aboutMe,
      likes,
      dislikes,
      relationshipStatus,
      profileStatus,
      anonymousViewing,
      displayPicture,
    });

    return res.status(200).json({ message: "Profil berhasil diperbarui", profile });
  });

  app.get("/api/profile/:username/wall", async (req: Request, res: Response) => {
    const user = await storage.getUserByUsername(req.params.username);
    if (!user) return res.status(404).json({ message: "User tidak ditemukan" });
    const { posts } = await storage.getWallPosts(user.id);
    return res.status(200).json({ posts });
  });

  // ── My following list (contacts added via follow) ──────────────────────────
  // Mirrors FusionPktDataGetContacts / contactBean.getAllContacts in Android.
  // Returns the list of fusionUsernames the current user follows (contact list).
  app.get("/api/me/following", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "User tidak valid" });
    const following = await storage.getFollowing(me.username);
    return res.status(200).json({ following });
  });

  // ── My following list with profile details ─────────────────────────────────
  app.get("/api/me/following-detail", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "User tidak valid" });
    const usernames = await storage.getFollowing(me.username);
    const detail = await Promise.all(usernames.map(async (uname) => {
      const u = await storage.getUserByUsername(uname).catch(() => null);
      const p = u ? await storage.getUserProfile(u.id).catch(() => null) : null;
      return {
        username: uname,
        displayName: u?.displayName ?? uname,
        displayPicture: p?.displayPicture ?? null,
      };
    }));
    return res.status(200).json({ following: detail });
  });

  app.get("/api/me/contacts", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "User tidak valid" });
    const contactList = await storage.getContacts(me.username);
    // Enrich each contact with real-time presence and status message
    const enriched = await Promise.all(contactList.map(async (c) => {
      const targetUser = await storage.getUserByUsername(c.fusionUsername).catch(() => null);
      const userId = targetUser?.id ?? "";
      return {
        ...c,
        presence: userId ? getUserPresence(userId) : "offline" as const,
        statusMessage: userId ? getUserStatusMessage(userId) : "",
      };
    }));
    return res.status(200).json({ contacts: enriched });
  });

  // ── GET /api/me/status ─────────────────────────────────────────────────────
  // Returns current user's status message and presence
  app.get("/api/me/status", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    return res.status(200).json({
      statusMessage: getUserStatusMessage(req.session.userId),
      presence: getUserPresence(req.session.userId),
    });
  });

  // ── POST /api/me/status ────────────────────────────────────────────────────
  // Set current user's status message and/or presence
  // Body: { message?: string, presence?: "online" | "away" | "busy" | "offline" }
  app.post("/api/me/status", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const { message, presence } = req.body as { message?: string; presence?: string };
    if (typeof message === "string") {
      setUserStatusMessage(req.session.userId, message);
    }
    const validPresences = ["online", "away", "busy", "offline"] as const;
    if (typeof presence === "string" && (validPresences as readonly string[]).includes(presence)) {
      const presenceStatus = presence as "online" | "away" | "busy" | "offline";
      setUserPresenceOverride(req.session.userId, presenceStatus);
      const user = await storage.getUser(req.session.userId);
      if (user) {
        const myFriends = await db
          .select({ friendUserId: friendships.friendUserId })
          .from(friendships)
          .where(eq(friendships.userId, req.session.userId));
        const friendIds = myFriends.map((f) => f.friendUserId);
        broadcastPresenceToFriends(req.session.userId, user.username, presenceStatus, friendIds);
      }
    }
    return res.status(200).json({
      message: "Status diperbarui",
      statusMessage: getUserStatusMessage(req.session.userId),
      presence: getUserPresence(req.session.userId),
    });
  });

  // ── Follow ─────────────────────────────────────────────────────────────────
  // Follow = one-way subscribe (contacts table) AND send contact request so
  // the target gets notified and can accept → bidirectional friendship.
  app.post("/api/users/:username/follow", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "User tidak valid" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User tidak ditemukan" });
    if (me.username.toLowerCase() === req.params.username.toLowerCase()) {
      return res.status(400).json({ message: "Tidak bisa follow diri sendiri" });
    }

    // One-way follow (contacts table — legacy phone-book style)
    await storage.followUser(me.username, target.username);

    // Check if already friends — skip contact request if so
    const [alreadyFriend] = await db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userId, me.id), eq(friendships.friendUserId, target.id)));
    if (alreadyFriend) {
      return res.status(200).json({ ok: true, message: `Kamu sudah berteman dengan ${target.username}` });
    }

    // Check if target already sent us a request — auto-accept (mutual follow = instant friends)
    const [reverseRequest] = await db
      .select()
      .from(contactRequests)
      .where(and(
        eq(contactRequests.fromUserId, target.id),
        eq(contactRequests.toUserId, me.id),
        eq(contactRequests.status, "pending"),
      ));

    const meProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, me.id)).then(r => r[0]);
    const meDisplayName = me.displayName ?? meProfile?.aboutMe ?? me.username;
    const targetProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, target.id)).then(r => r[0]);
    const targetDisplayName = target.displayName ?? targetProfile?.aboutMe ?? target.username;

    if (reverseRequest) {
      // Auto-accept — mirrors Java contactEJB.addFusionUserAsContact() bidirectional
      await db.update(contactRequests)
        .set({ status: "accepted" })
        .where(eq(contactRequests.id, reverseRequest.id));

      const friendshipId = randomUUID();
      await db.insert(friendships).values([
        { id: friendshipId, userId: me.id, friendUserId: target.id, friendUsername: target.username, friendDisplayName: targetDisplayName },
        { id: randomUUID(), userId: target.id, friendUserId: me.id, friendUsername: me.username, friendDisplayName: meDisplayName },
      ]);

      broadcastToUser(me.id, { type: "CONTACT_ACCEPTED", byUsername: target.username, byDisplayName: targetDisplayName, friendshipId });
      broadcastToUser(target.id, { type: "CONTACT_ACCEPTED", byUsername: me.username, byDisplayName: meDisplayName, friendshipId });
      broadcastPresenceToFriends(me.id, me.username, getUserPresence(me.id), [target.id]);
      broadcastPresenceToFriends(target.id, target.username, getUserPresence(target.id), [me.id]);

      return res.status(200).json({ ok: true, message: `Kalian sekarang berteman dengan ${target.username}` });
    }

    // Check if a pending request from us already exists
    const [existing] = await db
      .select()
      .from(contactRequests)
      .where(and(
        eq(contactRequests.fromUserId, me.id),
        eq(contactRequests.toUserId, target.id),
        eq(contactRequests.status, "pending"),
      ));
    if (existing) {
      return res.status(200).json({ ok: true, message: `Permintaan pertemanan ke ${target.username} sudah dikirim` });
    }

    // Create contact request
    const [request] = await db
      .insert(contactRequests)
      .values({
        id: randomUUID(),
        fromUserId: me.id,
        fromUsername: me.username,
        fromDisplayName: meDisplayName,
        toUserId: target.id,
        toUsername: target.username,
        status: "pending",
      })
      .returning();

    // WS notification (real-time) + UNS ALERT (persistent for offline)
    broadcastToUser(target.id, {
      type: "CONTACT_REQUEST",
      requestId: request.id,
      fromUsername: me.username,
      fromDisplayName: meDisplayName,
    });
    try {
      await storage.createNotification({
        username: target.username,
        type: "ALERT",
        subject: "Permintaan Pertemanan",
        message: `${me.username} ingin berteman denganmu. Buka notifikasi untuk menerima atau menolak.`,
        status: 1,
      });
    } catch {}

    return res.status(200).json({ ok: true, message: `Permintaan pertemanan dikirim ke ${target.username}` });
  });

  app.delete("/api/users/:username/follow", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "User tidak valid" });
    await storage.unfollowUser(me.username, req.params.username);
    return res.status(200).json({ ok: true, message: `Unfollow ${req.params.username}` });
  });

  app.get("/api/users/:username/follow", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "User tidak valid" });
    const following = await storage.isFollowing(me.username, req.params.username);
    return res.status(200).json({ following });
  });

  // ── Block / Unblock ─────────────────────────────────────────────────────────
  // Mirrors Java: UserBean blockList (blocklist table) + MemCachedKeySpaces.BLOCK_LIST
  // Logic: loadBlockList() → set("blockUsername", ...) in blocklist table

  // POST /api/users/:username/block — block a user globally
  app.post("/api/users/:username/block", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "Invalid session. Please log in again." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });
    if (me.username === req.params.username) return res.status(400).json({ message: "You cannot block yourself." });
    const alreadyBlocked = await storage.isBlockedGlobal(me.username, target.username);
    if (alreadyBlocked) return res.status(409).json({ message: `You have already blocked ${target.username}.` });
    await storage.blockUserGlobal(me.username, target.username);
    return res.status(200).json({
      ok: true,
      message: `${target.username} has been blocked. They will no longer be able to contact you.`,
      username: target.username,
    });
  });

  // DELETE /api/users/:username/block — unblock a user globally
  app.delete("/api/users/:username/block", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "Invalid session. Please log in again." });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: `User '${req.params.username}' not found.` });
    const isBlocked = await storage.isBlockedGlobal(me.username, target.username);
    if (!isBlocked) return res.status(409).json({ message: `${req.params.username} is not currently blocked.` });
    await storage.unblockUserGlobal(me.username, req.params.username);
    return res.status(200).json({
      ok: true,
      message: `${req.params.username} has been unblocked.`,
      username: req.params.username,
    });
  });

  // GET /api/users/:username/block — check if a user is blocked
  app.get("/api/users/:username/block", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in." });
    const me = await storage.getUser(req.session.userId);
    if (!me) return res.status(401).json({ message: "Invalid session. Please log in again." });
    const blocked = await storage.isBlockedGlobal(me.username, req.params.username);
    return res.status(200).json({
      blocked,
      username: req.params.username,
      message: blocked
        ? `You have blocked ${req.params.username}.`
        : `${req.params.username} is not blocked.`,
    });
  });

  // ── GET /api/user/:username/avatar ─────────────────────────────────────────
  // Lightweight public endpoint: returns displayPicture + active frameUrl for
  // any user. Used by AvatarWithFrame auto-fetch cache on the client.
  app.get("/api/user/:username/avatar", async (req: Request, res: Response) => {
    try {
      const { username } = req.params;
      const result = await db.execute(sql`
        SELECT
          up.display_picture,
          COALESCE(up.avatar_frame_url, sf.image_url) AS avatar_frame_url
        FROM users u
        LEFT JOIN user_profiles up ON up.user_id = u.id
        LEFT JOIN user_frames uf
          ON uf.user_id = u.id
          AND uf.is_equipped = true
          AND uf.is_active = true
          AND uf.expires_at > NOW()
        LEFT JOIN shop_frames sf ON sf.id = uf.frame_id
        WHERE u.username = ${username}
        LIMIT 1
      `);
      const row = result.rows[0] as any;
      return res.json({
        displayPicture: normalizeDisplayPicture(row?.display_picture ?? null) ?? null,
        frameUrl: row?.avatar_frame_url ?? null,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/user/:userId/active-frame ──────────────────────────────────────
  // Returns the active frame for a user by their user_id.
  app.get("/api/user/:userId/active-frame", async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const result = await db.execute(sql`
        SELECT uf.frame_id, uf.frame_url, sf.image_url
        FROM user_frames uf
        JOIN shop_frames sf ON sf.id = uf.frame_id
        WHERE uf.user_id = ${userId}
          AND uf.is_active = true
          AND uf.expires_at > NOW()
        LIMIT 1
      `);
      const row = result.rows[0] as any;
      return res.json({
        frame_url: row?.frame_url ?? row?.image_url ?? null,
        frame_id: row?.frame_id ?? null,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── Report ─────────────────────────────────────────────────────────────────
  app.post("/api/users/:username/report", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const target = await storage.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ message: "User tidak ditemukan" });
    const reason = (req.body.reason as string | undefined) ?? "No reason provided";
    console.log(`[REPORT] User ${req.session.userId} reported ${req.params.username}: ${reason}`);
    return res.status(200).json({ ok: true, message: "Laporan kamu telah diterima" });
  });
}

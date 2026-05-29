import type { Express, Request, Response } from "express";
import { requireVerified } from "../../middleware/accessControl";
import { storage } from "../../storage";
import { insertWallPostSchema, WALL_POST_STATUS, NOTIFICATION_TYPE, NOTIFICATION_STATUS, badges, badgesRewarded } from "@shared/schema";
import { z } from "zod";
import { feedRateLimitIncr, isRedisAvailable } from "../../redis";
import { db } from "../../db";
import { ilike, eq, sql } from "drizzle-orm";

// ─── Rate limit config ────────────────────────────────────────────────────────
// Max posts per user within the window
const POST_LIMIT    = 5;   // max 5 posts per 60 seconds
const POST_WINDOW   = 60;  // seconds

// Max comments per user within the window
const COMMENT_LIMIT  = 10;  // max 10 comments per 60 seconds
const COMMENT_WINDOW = 60;  // seconds

// ─── In-memory fallback (used when Redis is unavailable) ──────────────────────
// Map: userId → { count, expiresAt (ms) }
const _memStore = new Map<string, { count: number; expiresAt: number }>();

function memRateLimit(
  userId: string,
  action: "post" | "comment",
  limit: number,
  windowSeconds: number,
): { allowed: boolean; count: number; retryAfter: number } {
  const key = `${userId}:${action}`;
  const now  = Date.now();
  const entry = _memStore.get(key);

  if (!entry || entry.expiresAt <= now) {
    _memStore.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return { allowed: true, count: 1, retryAfter: 0 };
  }

  entry.count += 1;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.expiresAt - now) / 1000);
    return { allowed: false, count: entry.count, retryAfter };
  }
  return { allowed: true, count: entry.count, retryAfter: 0 };
}

// Periodically purge expired in-memory entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _memStore) {
    if (v.expiresAt <= now) _memStore.delete(k);
  }
}, 5 * 60 * 1000);

// ─── Rate limit gate (Redis-first, in-memory fallback) ───────────────────────
async function checkFeedRateLimit(
  userId: string,
  action: "post" | "comment",
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  if (isRedisAvailable()) {
    const count = await feedRateLimitIncr(userId, action, windowSeconds);
    if (count > limit) {
      return { allowed: false, retryAfter: windowSeconds };
    }
    return { allowed: true, retryAfter: 0 };
  }
  // Fallback to in-memory store
  const result = memRateLimit(userId, action, limit, windowSeconds);
  return { allowed: result.allowed, retryAfter: result.retryAfter };
}

function extractMentions(text: string): string[] {
  const matches = text.match(/@([a-zA-Z0-9_]+)/g) ?? [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

async function sendMentionNotifications(mentionerUsername: string, text: string) {
  const mentions = extractMentions(text);
  for (const mentionedUsername of mentions) {
    if (mentionedUsername === mentionerUsername.toLowerCase()) continue;
    const mentionedUser = await storage.getUserByUsername(mentionedUsername).catch(() => null);
    if (!mentionedUser) continue;
    storage.createNotification({
      username: mentionedUser.username,
      type: NOTIFICATION_TYPE.ALERT,
      subject: "Mention",
      message: `${mentionerUsername} menyebut kamu dalam sebuah postingan`,
      status: NOTIFICATION_STATUS.PENDING,
    }).catch(() => {});
  }
}

function normalizeDisplayPicture(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/\/api\/imageserver\/image\/[^/]+$/.test(url)) return url + '/data';
  return url;
}

async function getAvatarFrameForUser(username: string): Promise<string | null> {
  try {
    // Shop frame (user_profiles) takes priority
    const user = await storage.getUserByUsername(username);
    if (user) {
      const shopRow = await db.execute(
        sql`SELECT avatar_frame_url FROM user_profiles WHERE user_id = ${user.id} LIMIT 1`
      );
      const shopFrame = (shopRow.rows[0] as any)?.avatar_frame_url ?? null;
      if (shopFrame) return shopFrame;
    }
    // Fallback: badge-awarded frame
    const rows = await db
      .select({ avatarFrameUrl: badges.avatarFrameUrl })
      .from(badgesRewarded)
      .innerJoin(badges, eq(badges.id, badgesRewarded.badgeId))
      .where(ilike(badgesRewarded.username, username))
      .limit(5);
    return rows.find(r => r.avatarFrameUrl)?.avatarFrameUrl ?? null;
  } catch { return null; }
}

async function enrichPosts(posts: import('@shared/schema').WallPost[], origin?: string) {
  return Promise.all(posts.map(async (post) => {
    const author = await storage.getUserByUsername(post.authorUsername);
    const profile = author ? await storage.getUserProfile(author.id) : null;
    // Lookup merchant info (returns undefined if user is not a merchant)
    const merchant = await storage.getMerchantByUsername(post.authorUsername).catch(() => undefined);

    // Normalize imageUrl: ensure it's an absolute URL (mirrors Android ImageHandler)
    let imageUrl = (post as any).imageUrl ?? null;
    if (imageUrl && !imageUrl.startsWith('http') && origin) {
      imageUrl = origin + imageUrl;
    }
    // Add /data suffix if the URL points to imageserver without it
    if (imageUrl && /\/api\/imageserver\/image\/[^/]+$/.test(imageUrl)) {
      imageUrl = imageUrl + '/data';
    }

    // Normalize videoUrl similarly
    let videoUrl = (post as any).videoUrl ?? null;
    if (videoUrl && !videoUrl.startsWith('http') && origin) {
      videoUrl = origin + videoUrl;
    }

    const authorAvatarFrameUrl = await getAvatarFrameForUser(post.authorUsername);

    return {
      ...post,
      imageUrl,
      videoUrl,
      mediaType: (post as any).mediaType ?? 'text',
      authorDisplayPicture: normalizeDisplayPicture(profile?.displayPicture),
      authorAvatarFrameUrl,
      // Role flags untuk styling username & badge di client
      authorIsAdmin: author?.isAdmin === true,
      // merchantType: 1=MERCHANT, 2=MENTOR, 3=HEAD_MENTOR (null bila bukan merchant)
      authorMerchantType: merchant?.merchantType ?? null,
    };
  }));
}

export function registerFeedRoutes(app: Express): void {
  app.get("/api/feed", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const origin = `${req.protocol}://${req.get('host')}`;
    const limit  = Math.min(parseInt(String(req.query.limit  ?? 15), 10) || 15, 50);
    const offset = parseInt(String(req.query.offset ?? 0),  10) || 0;
    const { posts, hasMore } = await storage.getFeedPosts(req.session.userId, limit, offset);
    return res.status(200).json({ posts: await enrichPosts(posts, origin), hasMore });
  });

  app.get("/api/feed/user/:userId", async (req: Request, res: Response) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    const limit  = Math.min(parseInt(String(req.query.limit  ?? 15), 10) || 15, 50);
    const offset = parseInt(String(req.query.offset ?? 0),  10) || 0;
    const { posts, hasMore } = await storage.getWallPosts(req.params.userId, limit, offset);
    return res.status(200).json({ posts: await enrichPosts(posts, origin), hasMore });
  });

  // AccessControl: CREATE_USER_POST_IN_GROUPS (emailVerified required)
  app.post("/api/feed/post", requireVerified("CREATE_USER_POST_IN_GROUPS"), async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });

    // ── Flood guard ─────────────────────────────────────────────────────────
    const rl = await checkFeedRateLimit(req.session.userId, "post", POST_LIMIT, POST_WINDOW);
    if (!rl.allowed) {
      return res.status(429).json({
        message: `Kamu terlalu banyak posting. Tunggu ${rl.retryAfter} detik sebelum posting lagi.`,
        retryAfter: rl.retryAfter,
        code: "FEED_RATE_LIMIT",
      });
    }

    const { comment, type, targetUserId, imageUrl, videoUrl, mediaType, repostId } = req.body;
    if ((!comment || comment.trim() === "") && !imageUrl && !videoUrl && !repostId) {
      return res.status(400).json({ message: "Komentar tidak boleh kosong" });
    }

    let repostAuthorUsername: string | undefined;
    let repostComment: string | undefined;
    if (repostId) {
      const original = await storage.getWallPost(repostId);
      if (original) {
        repostAuthorUsername = original.authorUsername;
        repostComment = original.comment;
      }
    }

    const resolvedMediaType = videoUrl ? 'video' : (imageUrl ? 'image' : (mediaType || 'text'));

    const post = await storage.createWallPost({
      userId: targetUserId || req.session.userId,
      authorUserId: req.session.userId,
      authorUsername: user.username,
      comment: (comment || "").trim(),
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
      mediaType: resolvedMediaType,
      type: repostId ? 3 : (type || 1),
      repostId: repostId || null,
      repostAuthorUsername: repostAuthorUsername || null,
      repostComment: repostComment || null,
    });

    if (comment) sendMentionNotifications(user.username, comment).catch(() => {});

    return res.status(201).json({ post });
  });

  app.post("/api/feed/post/:postId/like", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const post = await storage.likeWallPost(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post tidak ditemukan" });
    return res.status(200).json({ post });
  });

  app.post("/api/feed/post/:postId/dislike", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const post = await storage.dislikeWallPost(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post tidak ditemukan" });
    return res.status(200).json({ post });
  });

  app.delete("/api/feed/post/:postId", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const post = await storage.getWallPost(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post tidak ditemukan" });
    const requestingUser = await storage.getUser(req.session.userId);
    const isAdmin = requestingUser?.isAdmin === true;
    if (!isAdmin && post.authorUserId !== req.session.userId && post.userId !== req.session.userId) {
      return res.status(403).json({ message: "Tidak diizinkan menghapus post ini" });
    }
    await storage.removeWallPost(req.params.postId);
    return res.status(200).json({ message: "Post dihapus" });
  });

  app.get("/api/feed/post/:postId/comments", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const comments = await storage.getPostComments(req.params.postId);
    return res.status(200).json({ comments });
  });

  app.post("/api/feed/post/:postId/comment", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });

    // ── Flood guard ─────────────────────────────────────────────────────────
    const rl = await checkFeedRateLimit(req.session.userId, "comment", COMMENT_LIMIT, COMMENT_WINDOW);
    if (!rl.allowed) {
      return res.status(429).json({
        message: `Kamu terlalu banyak berkomentar. Tunggu ${rl.retryAfter} detik sebelum berkomentar lagi.`,
        retryAfter: rl.retryAfter,
        code: "COMMENT_RATE_LIMIT",
      });
    }

    const schema = z.object({ text: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Teks komentar tidak boleh kosong" });
    const text = parsed.data.text.trim();
    const comment = await storage.createPostComment({
      postId: req.params.postId,
      authorUserId: req.session.userId,
      authorUsername: user.username,
      text,
    });

    const post = await storage.getWallPost(req.params.postId).catch(() => null);
    if (post && post.authorUsername !== user.username) {
      storage.createNotification({
        username: post.authorUsername,
        type: NOTIFICATION_TYPE.ALERT,
        subject: "Comment",
        message: `${user.username} berkomentar di postinganmu: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
        status: NOTIFICATION_STATUS.PENDING,
      }).catch(() => {});
    }

    sendMentionNotifications(user.username, text).catch(() => {});

    return res.status(201).json({ comment });
  });
}

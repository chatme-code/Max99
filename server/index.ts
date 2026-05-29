import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import cors from "cors";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import { startTcpGateway } from "./gateway/tcp";
import { getRedisClient, closeRedis } from "./redis";
import { storage } from "./storage";
import { DatabaseStorage } from "./db-storage";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./db";
import { sql } from "drizzle-orm";
import path from "path";
import { botHunterMiddleware } from "./modules/bothunter/middleware";
import { botHunterEngine } from "./modules/bothunter/engine";
import { initFloodGuard } from "./floodGuard";
import { jwtAuthMiddleware } from "./middleware/jwtAuth";
import { logger, log, SKIP_LOG_PATHS, SKIP_LOG_PREFIXES } from "./logger";
import { maskSensitive, maskSensitiveStr } from "./utils/maskSensitive";
import { startFrameExpiryCleanup } from "./modules/shop/routes";
import { startWeeklyPayrollCron, runWeeklyPayroll } from "./modules/agency/weeklyPayroll";

process.on("unhandledRejection", (reason: unknown) => {
  const safeReason = reason instanceof Error
    ? maskSensitiveStr(reason.message)
    : maskSensitive(reason);
  console.error("[Server] Unhandled promise rejection:", safeReason);
});
process.on("uncaughtException", (err: Error) => {
  console.error("[Server] Uncaught exception:", maskSensitiveStr(err.message));
});

const app = express();
const httpServer = createServer(app);

app.set("trust proxy", 1);

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use('/gifts', express.static(path.join(process.cwd(), 'server/public/gifts')));
app.use('/slots', express.static(path.join(process.cwd(), 'server/public/slots')));
app.use('/games/grady/ferriswheel', express.static(path.join(process.cwd(), 'server/public/grady/ferriswheel')));
app.use('/games/grady/slot', express.static(path.join(process.cwd(), 'server/public/grady/slot')));
app.use('/games/grady/dragon', express.static(path.join(process.cwd(), 'server/public/grady/dragon')));
app.use('/games/grady/thumbnails', express.static(path.join(process.cwd(), 'server/public/grady/thumbnails')));
app.use('/games/grady', express.static(path.join(process.cwd(), 'server/public/grady')));

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "15mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "15mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "migxchat-secret-key-2024",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.COOKIE_SECURE === "true",
      sameSite: process.env.COOKIE_SECURE === "true" ? "none" : "lax",
    },
  })
);

app.use(jwtAuthMiddleware);
app.use(botHunterMiddleware);

app.use((req: Request, res: Response, next: NextFunction) => {
  const reqPath = req.path;
  if (!reqPath.startsWith("/api") || SKIP_LOG_PATHS.has(reqPath) || SKIP_LOG_PREFIXES.some(p => reqPath.startsWith(p))) {
    return next();
  }

  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const logData = { method: req.method, path: reqPath, status, responseTime: duration };
    if (status >= 500) {
      logger.error(logData);
    } else if (status >= 400) {
      logger.warn(logData);
    } else {
      logger.info(logData);
    }
  });

  next();
});

(async () => {
  // Initialize Redis (non-fatal — falls back to in-memory if unavailable)
  getRedisClient();

  // Run database migrations to ensure all tables exist.
  // If tables already exist (code 42P07), that is fine — schema is up to date
  // via db:push and the server will work correctly. Suppress the noisy error.
  try {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "migrations") });
    log("Database migrations applied", "db");
  } catch (err: any) {
    if (err?.code === "42P07") {
      log("Database schema already up to date", "db");
    } else {
      console.error("Database migration error:", err);
    }
  }

  // Ensure is_admin column exists (safe to run on every startup via IF NOT EXISTS)
  try {
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_pin text`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token text`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiry timestamp`);
    log("Column is_admin ensured on users table", "db");
  } catch (err) {
    console.error("Column ensure error:", err);
  }

  try {
    await db.execute(sql`ALTER TABLE chatrooms ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false`);
    log("Column is_locked ensured on chatrooms table", "db");
  } catch (err) {
    console.error("Chatroom column ensure error:", err);
  }

  // Ensure auto-assignment slot columns exist on badges table (mig 0022).
  // Used by the admin panel to attach a badge to a leaderboard slot
  // (top 1/2/3 game wins, or top 1/2/3 gift senders) so it auto-shows on
  // the mini profile of whoever currently occupies that rank.
  try {
    await db.execute(sql`ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_kind      text`);
    await db.execute(sql`ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_game_type text`);
    await db.execute(sql`ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_rank      integer`);
    await db.execute(sql`ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_period    text`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS badges_slot_unique
        ON badges (slot_kind, COALESCE(slot_game_type, ''), slot_rank, slot_period)
        WHERE slot_kind IS NOT NULL
    `);
    log("Badge slot columns ensured", "db");
  } catch (err) {
    console.error("Badge slot column ensure error:", err);
  }

  // Ensure post_comments table exists (may not exist if migration 0014 wasn't applied)
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "post_comments" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "post_id" varchar NOT NULL REFERENCES "wall_posts"("id") ON DELETE CASCADE,
        "author_user_id" varchar NOT NULL,
        "author_username" text NOT NULL,
        "text" text NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    log("Table post_comments ensured", "db");
  } catch (err) {
    console.error("post_comments table ensure error:", err);
  }

  // Ensure new merchant columns exist (mirrors Java MerchantDetailsData & MerchantTagData fields)
  try {
    await db.execute(sql`
      ALTER TABLE merchants
        ADD COLUMN IF NOT EXISTS username_color_type integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS merchant_type integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS mentor text,
        ADD COLUMN IF NOT EXISTS referrer text
    `);
    await db.execute(sql`
      ALTER TABLE merchant_locations
        ADD COLUMN IF NOT EXISTS country_id integer,
        ADD COLUMN IF NOT EXISTS country text
    `);
    await db.execute(sql`
      ALTER TABLE merchant_points
        ADD COLUMN IF NOT EXISTS type integer NOT NULL DEFAULT 1
    `);
    await db.execute(sql`
      ALTER TABLE merchant_tags
        ADD COLUMN IF NOT EXISTS amount double precision,
        ADD COLUMN IF NOT EXISTS currency text,
        ADD COLUMN IF NOT EXISTS account_entry_id varchar
    `);
    log("Merchant schema columns ensured", "db");
  } catch (err) {
    console.error("Merchant column ensure error:", err);
  }

  // Normalise all legacy USD rows to IDR (idempotent — runs on every start).
  // The platform uses a single currency (IDR) for all accounts and transactions.
  try {
    await db.execute(sql`UPDATE credit_accounts    SET currency = 'IDR' WHERE currency = 'USD'`);
    await db.execute(sql`UPDATE credit_transactions SET currency = 'IDR' WHERE currency = 'USD'`);
    await db.execute(sql`UPDATE voucher_batches    SET currency = 'IDR' WHERE currency = 'USD'`);
    await db.execute(sql`UPDATE vouchers           SET currency = 'IDR' WHERE currency = 'USD'`);
    await db.execute(sql`UPDATE virtual_gifts      SET currency = 'IDR' WHERE currency = 'USD'`);
    await db.execute(sql`UPDATE payments           SET currency = 'IDR' WHERE currency = 'USD'`);
    log("Legacy USD rows normalised to IDR", "db");
  } catch (err) {
    console.error("USD→IDR normalisation error:", err);
  }

  // Ensure avatar_frame_url column exists on badges table
  try {
    await db.execute(sql`ALTER TABLE badges ADD COLUMN IF NOT EXISTS avatar_frame_url text`);
    log("badges.avatar_frame_url ensured", "db");
  } catch (err) {
    console.error("badges avatar_frame_url migration error:", err);
  }

  // Ensure avatar_frame_url column exists on user_profiles table
  try {
    await db.execute(sql`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_frame_url text`);
    // Back-fill from user_frames for users who already have a frame equipped
    await db.execute(sql`
      UPDATE user_profiles up
      SET avatar_frame_url = uf.frame_url
      FROM user_frames uf
      WHERE uf.user_id = up.user_id
        AND uf.is_equipped = true
        AND uf.is_active = true
        AND uf.expires_at > NOW()
        AND up.avatar_frame_url IS NULL
    `);
    log("user_profiles.avatar_frame_url ensured + back-filled", "db");
  } catch (err) {
    console.error("user_profiles avatar_frame_url migration error:", err);
  }

  // Normalise all legacy MIG rows to IDR (idempotent — runs on every start).
  // Gift prices: 1 MIG = 100 IDR, so price is multiplied by 100.
  // Reward amounts: same 1 MIG = 100 IDR conversion.
  // User account balances (credit_accounts.balance) are NOT touched.
  try {
    await db.execute(sql`UPDATE virtual_gifts SET price = price * 100, currency = 'IDR' WHERE currency = 'MIG'`);
    await db.execute(sql`UPDATE credit_transactions SET currency = 'IDR' WHERE currency = 'MIG'`);
    await db.execute(sql`UPDATE voucher_batches SET currency = 'IDR' WHERE currency = 'MIG'`);
    await db.execute(sql`UPDATE vouchers        SET currency = 'IDR' WHERE currency = 'MIG'`);
    await db.execute(sql`UPDATE payments        SET currency = 'IDR' WHERE currency = 'MIG'`);
    await db.execute(sql`
      UPDATE reward_programs
      SET mig_credit_reward = mig_credit_reward * 100,
          mig_credit_reward_currency = 'IDR'
      WHERE mig_credit_reward_currency = 'MIG'
    `).catch(() => {});
    log("Legacy MIG rows normalised to IDR", "db");
  } catch (err) {
    console.error("MIG→IDR normalisation error:", err);
  }

  // Fix chatroom maxParticipants: update rooms still at 50 to level-based capacity
  try {
    await db.execute(sql`
      UPDATE chatrooms
      SET max_participants = CASE
        WHEN user_profiles.mig_level >= 50 THEN 40
        ELSE 25
      END
      FROM user_profiles
      WHERE chatrooms.created_by = user_profiles.user_id
        AND chatrooms.max_participants = 50
    `);
    log("Chatroom maxParticipants fixed based on creator level", "db");
  } catch (err) {
    console.error("Chatroom capacity migration error:", err);
  }

  // Update gift image URLs for existing gifts (idempotent)
  try {
    await db.execute(sql`
      UPDATE virtual_gifts
      SET location_64x64_png = '/gifts/rose.png',
          location_16x16_png = '/gifts/rose.png'
      WHERE name = 'rose' AND (location_64x64_png IS NULL OR location_64x64_png != '/gifts/rose.png')
    `);
    log("Gift image URLs updated", "db");
  } catch (err) {
    console.error("Gift image URL update error:", err);
  }

  // Ensure apk_releases table exists (created via manual migration, not drizzle journal)
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS apk_releases (
        id           SERIAL PRIMARY KEY,
        version_name TEXT    NOT NULL,
        version_code INTEGER NOT NULL DEFAULT 1,
        changelog    TEXT,
        file_name    TEXT    NOT NULL,
        file_size    BIGINT  DEFAULT 0,
        download_url TEXT    NOT NULL,
        min_android  INTEGER DEFAULT 7,
        is_active    BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_apk_releases_active ON apk_releases (is_active, created_at DESC)
    `);
    await db.execute(sql`
      ALTER TABLE apk_releases ADD COLUMN IF NOT EXISTS download_count BIGINT NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE apk_releases ADD COLUMN IF NOT EXISTS force_update BOOLEAN NOT NULL DEFAULT false
    `);
    await db.execute(sql`
      ALTER TABLE apk_releases ADD COLUMN IF NOT EXISTS store_url TEXT
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS apk_download_logs (
        id          BIGSERIAL PRIMARY KEY,
        release_id  INTEGER NOT NULL REFERENCES apk_releases(id) ON DELETE CASCADE,
        ip          TEXT,
        user_agent  TEXT,
        logged_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_apk_dl_logs_release ON apk_download_logs(release_id, logged_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_apk_dl_logs_time ON apk_download_logs(logged_at DESC)
    `);
    log("APK releases table ensured", "db");
  } catch (err) {
    console.error("APK releases table ensure error:", err);
  }

  // Ensure user_privacy_settings table exists (not in drizzle journal)
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_privacy_settings (
        id                          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        username                    TEXT NOT NULL UNIQUE,
        dob_privacy                 INTEGER NOT NULL DEFAULT 0,
        first_last_name_privacy     INTEGER NOT NULL DEFAULT 0,
        mobile_phone_privacy        INTEGER NOT NULL DEFAULT 0,
        external_email_privacy      INTEGER NOT NULL DEFAULT 0,
        chat_privacy                INTEGER NOT NULL DEFAULT 1,
        buzz_privacy                INTEGER NOT NULL DEFAULT 1,
        lookout_privacy             INTEGER NOT NULL DEFAULT 1,
        footprints_privacy          INTEGER NOT NULL DEFAULT 0,
        feed_privacy                INTEGER NOT NULL DEFAULT 1,
        activity_status_updates     BOOLEAN NOT NULL DEFAULT TRUE,
        activity_profile_changes    BOOLEAN NOT NULL DEFAULT TRUE,
        activity_add_friends        BOOLEAN NOT NULL DEFAULT FALSE,
        activity_photos_published   BOOLEAN NOT NULL DEFAULT TRUE,
        activity_content_purchased  BOOLEAN NOT NULL DEFAULT TRUE,
        activity_chatroom_creation  BOOLEAN NOT NULL DEFAULT TRUE,
        activity_virtual_gifting    BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_privacy_settings_username ON user_privacy_settings(username)`);
    log("user_privacy_settings table ensured", "db");
  } catch (err) {
    console.error("user_privacy_settings table ensure error:", err);
  }

  // Ensure device_registrations table exists
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS device_registrations (
        id            BIGSERIAL PRIMARY KEY,
        device_id     TEXT NOT NULL,
        username      TEXT NOT NULL,
        registered_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_device_reg_device ON device_registrations(device_id)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_reg_unique ON device_registrations(device_id, username)`);
    log("device_registrations table ensured", "db");
  } catch (err) {
    console.error("device_registrations table ensure error:", err);
  }

  // Ensure chatroom_muted_users table exists (not in drizzle journal — created inline)
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chatroom_muted_users (
        id          SERIAL PRIMARY KEY,
        chatroom_id VARCHAR NOT NULL,
        user_id     VARCHAR NOT NULL,
        username    TEXT    NOT NULL,
        muted_until TIMESTAMP,
        created_at  TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended boolean NOT NULL DEFAULT false`);
    log("chatroom_muted_users table ensured", "db");
  } catch (err) {
    console.error("chatroom_muted_users table ensure error:", err);
  }

  // Ensure voice room is per-chatroom (not global). Adds chatroom_id to
  // voice_seats, replaces the global UNIQUE (seat_index) with composite
  // UNIQUE (chatroom_id, seat_index), and creates chatroom_voice_state for
  // the per-room enable flag. Seats are lazily inserted on first toggle.
  //
  // IMPORTANT: every step is wrapped individually so one failure (e.g. table
  // missing) does NOT skip the rest. Drizzle's _journal.json on this project
  // does not include 0024_voice_seats.sql or 0025_voice_seat_requests.sql,
  // so on a fresh deployment those SQL migrations never run — we therefore
  // CREATE TABLE IF NOT EXISTS the base tables here as well. On an existing
  // production database both `IF NOT EXISTS` clauses are no-ops (the tables
  // are kept exactly as-is), so this is safe to run on every boot.
  try {
    // 0a) Make sure the base voice_seats table exists. This mirrors the
    //     schema produced by 0024_voice_seats.sql plus the chatroom_id
    //     column we add below — production rows are untouched.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS voice_seats (
        id           SERIAL PRIMARY KEY,
        seat_index   SMALLINT NOT NULL CHECK (seat_index IN (1, 2)),
        user_id      VARCHAR(255) NULL,
        username     VARCHAR(255) NULL,
        display_name VARCHAR(255) NULL,
        avatar_url   TEXT NULL,
        is_muted     BOOLEAN NOT NULL DEFAULT false,
        agora_uid    INTEGER NULL,
        joined_at    TIMESTAMPTZ NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        chatroom_id  VARCHAR
      )
    `);
    // 0b) Per-room seat-request queue (mirrors 0025_voice_seat_requests.sql).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS voice_seat_requests (
        id           SERIAL PRIMARY KEY,
        chatroom_id  VARCHAR(255) NOT NULL,
        seat_index   SMALLINT NOT NULL CHECK (seat_index IN (1, 2)),
        user_id      VARCHAR(255) NOT NULL,
        username     VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NULL,
        avatar_url   TEXT NULL,
        status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at  TIMESTAMPTZ NULL,
        resolved_by  VARCHAR(255) NULL
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_voice_seat_request_pending
        ON voice_seat_requests (chatroom_id, user_id)
        WHERE status = 'pending'
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_voice_seat_requests_room_pending
        ON voice_seat_requests (chatroom_id, status)
        WHERE status = 'pending'
    `);
    // 1) Add chatroom_id column if missing (existing prod rows: no-op)
    await db.execute(sql`
      ALTER TABLE voice_seats ADD COLUMN IF NOT EXISTS chatroom_id VARCHAR
    `);
    // 2) Drop old global unique on seat_index (named voice_seats_seat_index_key)
    await db.execute(sql`
      ALTER TABLE voice_seats DROP CONSTRAINT IF EXISTS voice_seats_seat_index_key
    `);
    // 3) Delete any leftover global rows that have no chatroom_id (these
    //    were the pre-seeded global seats from migration 0024 and would
    //    otherwise block the new composite unique).
    await db.execute(sql`DELETE FROM voice_seats WHERE chatroom_id IS NULL`);
    // 4) Add composite unique (chatroom_id, seat_index)
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'voice_seats_chatroom_seat_unique'
        ) THEN
          ALTER TABLE voice_seats
            ADD CONSTRAINT voice_seats_chatroom_seat_unique
            UNIQUE (chatroom_id, seat_index);
        END IF;
      END $$;
    `);
    // 5) Helpful index for per-room queries
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_voice_seats_chatroom
      ON voice_seats (chatroom_id)
    `);
    // 6) Per-room enable flag — moved here so it ALWAYS runs even if any
    //    earlier step were to throw on a weird DB.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chatroom_voice_state (
        chatroom_id VARCHAR PRIMARY KEY,
        enabled     BOOLEAN NOT NULL DEFAULT false,
        channel     TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    log("voice_seats per-room schema ensured", "db");
  } catch (err) {
    console.error("voice_seats per-room ensure error:", err);
  }

  // Drop CHECK (seat_index IN (1,2)) so party rooms can use seats 1-8.
  // We replace it with a flexible range check (1-8). Safe to run every boot.
  try {
    await db.execute(sql`
      ALTER TABLE voice_seats
        DROP CONSTRAINT IF EXISTS voice_seats_seat_index_check
    `);
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'voice_seats_seat_index_range'
        ) THEN
          ALTER TABLE voice_seats
            ADD CONSTRAINT voice_seats_seat_index_range
            CHECK (seat_index >= 1 AND seat_index <= 8);
        END IF;
      END $$
    `);
    await db.execute(sql`
      ALTER TABLE voice_seat_requests
        DROP CONSTRAINT IF EXISTS voice_seat_requests_seat_index_check
    `);
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'voice_seat_requests_seat_index_range'
        ) THEN
          ALTER TABLE voice_seat_requests
            ADD CONSTRAINT voice_seat_requests_seat_index_range
            CHECK (seat_index >= 1 AND seat_index <= 8);
        END IF;
      END $$
    `);
    log("voice_seats seat_index range constraint updated (1-8)", "db");
  } catch (err) {
    console.error("voice_seats seat_index range update error:", err);
  }

  // Ensure avatar_frame_url column exists on voice_seats (must run after table is created above)
  try {
    await db.execute(sql`ALTER TABLE voice_seats ADD COLUMN IF NOT EXISTS avatar_frame_url text`);
    log("voice_seats.avatar_frame_url ensured", "db");
  } catch (err) {
    console.error("voice_seats avatar_frame_url migration error:", err);
  }

  // Belt-and-braces: even if the block above failed at some step, make sure
  // chatroom_voice_state still gets created so /toggle and /token can work.
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS chatroom_voice_state (
        chatroom_id VARCHAR PRIMARY KEY,
        enabled     BOOLEAN NOT NULL DEFAULT false,
        channel     TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error("chatroom_voice_state ensure error:", err);
  }

  // Ensure reputation_score_to_level table exists (migration 0010 may not be
  // registered in the drizzle journal on existing databases). Safe on every
  // startup — does NOT touch existing user level data, only the threshold table.
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "reputation_score_to_level" (
        "level"                       integer PRIMARY KEY,
        "score"                       integer NOT NULL DEFAULT 0,
        "name"                        text,
        "image"                       text,
        "chat_room_size"              integer,
        "group_size"                  integer,
        "num_group_chat_rooms"        integer,
        "create_chat_room"            boolean NOT NULL DEFAULT false,
        "create_group"                boolean NOT NULL DEFAULT false,
        "publish_photo"               boolean NOT NULL DEFAULT false,
        "post_comment_like_user_wall" boolean NOT NULL DEFAULT false,
        "add_to_photo_wall"           boolean NOT NULL DEFAULT false,
        "enter_pot"                   boolean NOT NULL DEFAULT false,
        "num_group_moderators"        integer NOT NULL DEFAULT 0
      )
    `);
    log("reputation_score_to_level table ensured", "db");
  } catch (err) {
    console.error("reputation_score_to_level table ensure error:", err);
  }

  // Ensure all later-added columns exist on wall_posts
  try {
    await db.execute(sql`
      ALTER TABLE wall_posts
        ADD COLUMN IF NOT EXISTS image_url              text,
        ADD COLUMN IF NOT EXISTS repost_id              varchar,
        ADD COLUMN IF NOT EXISTS repost_author_username text,
        ADD COLUMN IF NOT EXISTS repost_comment         text,
        ADD COLUMN IF NOT EXISTS num_comments           integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS num_likes              integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS num_dislikes           integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS video_url              text,
        ADD COLUMN IF NOT EXISTS media_type             text NOT NULL DEFAULT 'text'
    `);
    log("wall_posts columns ensured", "db");
  } catch (err) {
    console.error("wall_posts columns migration error:", err);
  }

  // Ensure reputation metric columns exist on user_reputation (migration 0009)
  try {
    await db.execute(sql`
      ALTER TABLE user_reputation
        ADD COLUMN IF NOT EXISTS chat_room_messages_sent integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS private_messages_sent   integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_time              integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS photos_uploaded         integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS kicks_initiated         integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS authenticated_referrals integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS recharged_amount        double precision NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS phone_call_duration     integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS session_count           integer NOT NULL DEFAULT 0
    `);
    log("user_reputation metric columns ensured", "db");
  } catch (err) {
    console.error("user_reputation metrics migration error:", err);
  }

  // ── Live Party tables (party_rooms, party_seats) ─────────────────────────
  // Terpisah total dari classic chatroom. Dikelola oleh /api/party/* endpoints.
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_rooms (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name             TEXT NOT NULL,
        description      TEXT,
        color            TEXT NOT NULL DEFAULT '#7C3AED',
        creator_id       VARCHAR NOT NULL,
        creator_username TEXT NOT NULL,
        max_seats        SMALLINT NOT NULL DEFAULT 8,
        is_active        BOOLEAN NOT NULL DEFAULT true,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_party_rooms_active
        ON party_rooms (is_active, created_at DESC)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_seats (
        id               SERIAL PRIMARY KEY,
        party_room_id    VARCHAR NOT NULL REFERENCES party_rooms(id) ON DELETE CASCADE,
        seat_index       SMALLINT NOT NULL CHECK (seat_index >= 1 AND seat_index <= 8),
        user_id          VARCHAR,
        username         TEXT,
        display_name     TEXT,
        avatar_url       TEXT,
        is_muted         BOOLEAN NOT NULL DEFAULT false,
        livekit_identity TEXT,
        joined_at        TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (party_room_id, seat_index)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_party_seats_room
        ON party_seats (party_room_id)
    `);
    await db.execute(sql`
      ALTER TABLE party_seats ADD COLUMN IF NOT EXISTS is_hand_raised BOOLEAN NOT NULL DEFAULT false
    `);
    await db.execute(sql`
      ALTER TABLE party_seats ADD COLUMN IF NOT EXISTS avatar_frame_url TEXT
    `);
    await db.execute(sql`
      ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS free_seat BOOLEAN NOT NULL DEFAULT true
    `);
    await db.execute(sql`
      ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false
    `);
    await db.execute(sql`
      ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS room_password VARCHAR(10)
    `);
    await db.execute(sql`
      ALTER TABLE party_seats ADD COLUMN IF NOT EXISTS seat_diamonds BIGINT NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE party_seats ADD COLUMN IF NOT EXISTS seat_coins BIGINT NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE party_seats ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false
    `);
    await db.execute(sql`
      ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS background_image VARCHAR
    `);
    // Perluas constraint seat_index dari 1-8 → 1-12 agar room bisa punya hingga 12 kursi
    try {
      await db.execute(sql`
        ALTER TABLE party_seats DROP CONSTRAINT IF EXISTS party_seats_seat_index_check
      `);
      await db.execute(sql`
        ALTER TABLE party_seats ADD CONSTRAINT party_seats_seat_index_check
          CHECK (seat_index >= 1 AND seat_index <= 12)
      `);
    } catch {}
    log("party_rooms + party_seats tables ensured", "db");
  } catch (err) {
    console.error("party tables ensure error:", err);
  }

  // ── Party Live Sessions — track durasi live per seat session ──────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_live_sessions (
        id               SERIAL PRIMARY KEY,
        room_id          TEXT NOT NULL,
        room_name        TEXT NOT NULL DEFAULT '',
        user_id          TEXT NOT NULL,
        username         TEXT NOT NULL,
        seat_index       SMALLINT,
        started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at         TIMESTAMPTZ,
        duration_seconds INTEGER
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_pls_username ON party_live_sessions (username, started_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_pls_started ON party_live_sessions (started_at DESC)
    `);
    log("party_live_sessions table ensured", "db");
    // ── Tutup sesi yang masih terbuka saat server restart ─────────────────
    // Setiap restart, sesi dengan ended_at IS NULL dianggap selesai
    await db.execute(sql`
      UPDATE party_live_sessions
      SET ended_at = NOW(),
          duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER)
      WHERE ended_at IS NULL
        AND started_at < NOW() - INTERVAL '5 minutes'
    `);
    log("orphaned live sessions closed on startup", "db");
  } catch (err) {
    console.error("party_live_sessions table ensure error:", err);
  }

  // ── Party member management tables ───────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_muted_users (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        party_room_id    VARCHAR NOT NULL REFERENCES party_rooms(id) ON DELETE CASCADE,
        user_id          VARCHAR NOT NULL,
        username         TEXT,
        avatar_url       TEXT,
        muted_by         VARCHAR,
        muted_by_username TEXT,
        muted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(party_room_id, user_id)
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_kicked_users (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        party_room_id    VARCHAR NOT NULL REFERENCES party_rooms(id) ON DELETE CASCADE,
        user_id          VARCHAR NOT NULL,
        username         TEXT,
        avatar_url       TEXT,
        kicked_by        VARCHAR,
        kicked_by_username TEXT,
        kicked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(party_room_id, user_id)
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_room_admins (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        party_room_id    VARCHAR NOT NULL REFERENCES party_rooms(id) ON DELETE CASCADE,
        user_id          VARCHAR NOT NULL,
        username         TEXT,
        avatar_url       TEXT,
        added_by         VARCHAR,
        added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(party_room_id, user_id)
      )
    `);
    log("party member management tables ensured", "db");
  } catch (err) {
    console.error("party member tables ensure error:", err);
  }

  // ── Party Gifts table ────────────────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_gifts (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT NOT NULL,
        emoji        TEXT NOT NULL DEFAULT '🎁',
        price        INTEGER NOT NULL DEFAULT 1000,
        category     TEXT NOT NULL DEFAULT 'Populer',
        image_url    TEXT,
        lottie_url   TEXT,
        is_active    BOOLEAN NOT NULL DEFAULT true,
        is_premium   BOOLEAN NOT NULL DEFAULT false,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_party_gifts_name ON party_gifts (name)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_party_gifts_active ON party_gifts (is_active, sort_order)`);
    await db.execute(sql`ALTER TABLE party_gifts ADD COLUMN IF NOT EXISTS video_url TEXT`);
    // Rename legacy "Bangsa" category → "Luxury"
    await db.execute(sql`UPDATE party_gifts SET category = 'Luxury' WHERE category = 'Bangsa'`);
    log("party_gifts table ensured", "db");
  } catch (err) {
    console.error("party_gifts table ensure error:", err);
  }

  // ── Lucky Gift JP tables (legacy, kept for backward compat) ─────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_counter (
        party_room_id  VARCHAR PRIMARY KEY,
        total_count    BIGINT NOT NULL DEFAULT 0,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_participants (
        id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        party_room_id  VARCHAR NOT NULL,
        username       TEXT NOT NULL,
        send_count     BIGINT NOT NULL DEFAULT 0,
        last_sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(party_room_id, username)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_plp_room ON party_lucky_participants (party_room_id)`);
    log("party_lucky_counter + party_lucky_participants tables ensured", "db");
  } catch (err) {
    console.error("party_lucky tables ensure error:", err);
  }

  // ── Party Income Log — per-room & per-day income tracking ───────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_income_log (
        id              SERIAL PRIMARY KEY,
        room_id         TEXT NOT NULL,
        room_name       TEXT NOT NULL DEFAULT '',
        sender_username TEXT NOT NULL,
        gift_name       TEXT NOT NULL,
        coin_amount     BIGINT NOT NULL DEFAULT 0,
        diamond_amount  BIGINT NOT NULL DEFAULT 0,
        gift_qty        INT NOT NULL DEFAULT 1,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pil_room ON party_income_log (room_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pil_date ON party_income_log (created_at DESC)`);
    log("party_income_log table ensured", "db");
  } catch (err) {
    console.error("party_income_log table ensure error:", err);
  }

  // ── Party Stickers table ──────────────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_stickers (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(60)  NOT NULL,
        lottie_url  TEXT,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        sort_order  INT     NOT NULL DEFAULT 99,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_party_stickers_name ON party_stickers (name)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_party_stickers_active ON party_stickers (is_active, sort_order)`);
    log("party_stickers table ensured", "db");
  } catch (err) {
    console.error("party_stickers table ensure error:", err);
  }

  // ── Party Lucky Bag tables ────────────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_bags (
        id               SERIAL PRIMARY KEY,
        room_id          TEXT NOT NULL,
        sender_username  TEXT NOT NULL,
        total_coins      BIGINT NOT NULL,
        bag_count        INT NOT NULL,
        bags_remaining   INT NOT NULL,
        expires_at       TIMESTAMPTZ NOT NULL,
        is_active        BOOLEAN NOT NULL DEFAULT true,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_plb_room ON party_lucky_bags (room_id, is_active, created_at DESC)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_bag_slots (
        id               SERIAL PRIMARY KEY,
        bag_id           INT NOT NULL,
        slot_index       INT NOT NULL,
        coin_amount      BIGINT NOT NULL,
        claimer_username TEXT,
        claimed_at       TIMESTAMPTZ
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_plbs_bag ON party_lucky_bag_slots (bag_id, claimer_username)`);
    log("party_lucky_bags tables ensured", "db");
  } catch (err) {
    console.error("party_lucky_bags table ensure error:", err);
  }

  // ── Party Lucky Bag GLOBAL tables ────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_bags_global (
        id               SERIAL PRIMARY KEY,
        sender_username  TEXT NOT NULL,
        sender_room_id   TEXT NOT NULL DEFAULT '',
        sender_room_name TEXT NOT NULL DEFAULT '',
        total_coins      BIGINT NOT NULL,
        bag_count        INT NOT NULL,
        bags_remaining   INT NOT NULL,
        claimable_at     TIMESTAMPTZ NOT NULL,
        expires_at       TIMESTAMPTZ NOT NULL,
        is_active        BOOLEAN NOT NULL DEFAULT true,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS party_lucky_bag_global_slots (
        id               SERIAL PRIMARY KEY,
        bag_id           INT NOT NULL,
        slot_index       INT NOT NULL,
        coin_amount      BIGINT NOT NULL,
        claimer_username TEXT,
        claimed_at       TIMESTAMPTZ
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_plbg_active ON party_lucky_bags_global (is_active, claimable_at, expires_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_plbgs_bag ON party_lucky_bag_global_slots (bag_id, claimer_username)`);
    log("party_lucky_bags_global tables ensured", "db");
  } catch (err) {
    console.error("party_lucky_bags_global table ensure error:", err);
  }

  // ── Lucky Gift JP2 tables (global milestone system) ───────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_jp2_counter (
        id              INT PRIMARY KEY DEFAULT 1,
        total_coin      BIGINT NOT NULL DEFAULT 0,
        cumulative_coin BIGINT NOT NULL DEFAULT 0,
        siklus_id       INT NOT NULL DEFAULT 1,
        last_reset      TIMESTAMPTZ,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`ALTER TABLE lucky_jp2_counter ADD COLUMN IF NOT EXISTS cumulative_coin BIGINT NOT NULL DEFAULT 0`);
    await db.execute(sql`
      INSERT INTO lucky_jp2_counter (id, total_coin, cumulative_coin, siklus_id)
      VALUES (1, 0, 0, 1)
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_jp2_milestone_log (
        id                     SERIAL PRIMARY KEY,
        milestone              VARCHAR(10) NOT NULL,
        triggered_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        total_coin_saat_trigger BIGINT NOT NULL DEFAULT 0,
        jumlah_pemenang        INT NOT NULL DEFAULT 0,
        siklus_id              INT NOT NULL DEFAULT 1
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_jp2_mlog_milestone ON lucky_jp2_milestone_log (milestone, triggered_at DESC)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_jp2_winners (
        id          SERIAL PRIMARY KEY,
        username    TEXT NOT NULL,
        milestone   VARCHAR(10) NOT NULL,
        coin_reward INT NOT NULL DEFAULT 0,
        won_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        siklus_id   INT NOT NULL DEFAULT 1
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_jp2_winners_user ON lucky_jp2_winners (username, won_at DESC)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_jp2_participants (
        id              SERIAL PRIMARY KEY,
        username        TEXT NOT NULL,
        total_gift_sent INT NOT NULL DEFAULT 0,
        last_gift_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        siklus_id       INT NOT NULL DEFAULT 1,
        UNIQUE(username, siklus_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_jp2_participants_siklus ON lucky_jp2_participants (siklus_id)`);
    log("lucky_jp2_* global milestone tables ensured", "db");
  } catch (err) {
    console.error("lucky_jp2 tables ensure error:", err);
  }

  // ── Lucky Gift Per-Room tables (X3/X9/X99/X199 tier) ────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_room_counter (
        room_id     TEXT PRIMARY KEY,
        total_coin  BIGINT NOT NULL DEFAULT 0,
        siklus_id   INT NOT NULL DEFAULT 1,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_room_participants (
        id               SERIAL PRIMARY KEY,
        room_id          TEXT NOT NULL,
        username         TEXT NOT NULL,
        total_gift_sent  INT NOT NULL DEFAULT 0,
        last_gift_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        siklus_id        INT NOT NULL DEFAULT 1,
        UNIQUE(room_id, username, siklus_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lrp_room_siklus ON lucky_room_participants (room_id, siklus_id)`);
    log("lucky_room_counter + lucky_room_participants tables ensured", "db");
  } catch (err) {
    console.error("lucky_room tables ensure error:", err);
  }

  // ── Lucky Gift Per-Room 50x tables ────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_room_counter_50x (
        room_id     TEXT PRIMARY KEY,
        total_coin  BIGINT NOT NULL DEFAULT 0,
        siklus_id   INT NOT NULL DEFAULT 1,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_room_participants_50x (
        id               SERIAL PRIMARY KEY,
        room_id          TEXT NOT NULL,
        username         TEXT NOT NULL,
        total_gift_sent  BIGINT NOT NULL DEFAULT 0,
        last_gift_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        siklus_id        INT NOT NULL DEFAULT 1,
        UNIQUE(room_id, username, siklus_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lrp50x_room_siklus ON lucky_room_participants_50x (room_id, siklus_id)`);
    log("lucky_room_counter_50x + lucky_room_participants_50x tables ensured", "db");
  } catch (err) {
    console.error("lucky_room_50x tables ensure error:", err);
  }

  // ── Lucky Gift Per-Room 100x tables ───────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_room_counter_100x (
        room_id     TEXT PRIMARY KEY,
        total_coin  BIGINT NOT NULL DEFAULT 0,
        siklus_id   INT NOT NULL DEFAULT 1,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lucky_room_participants_100x (
        id               SERIAL PRIMARY KEY,
        room_id          TEXT NOT NULL,
        username         TEXT NOT NULL,
        total_gift_sent  BIGINT NOT NULL DEFAULT 0,
        last_gift_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        siklus_id        INT NOT NULL DEFAULT 1,
        UNIQUE(room_id, username, siklus_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lrp100x_room_siklus ON lucky_room_participants_100x (room_id, siklus_id)`);
    log("lucky_room_counter_100x + lucky_room_participants_100x tables ensured", "db");
  } catch (err) {
    console.error("lucky_room_100x tables ensure error:", err);
  }

  // ── Diamond balance + transaction tables ─────────────────────────────────
  try {
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS diamond_balance BIGINT NOT NULL DEFAULT 0`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS diamond_transactions (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        username     TEXT NOT NULL,
        amount       BIGINT NOT NULL,
        type         TEXT NOT NULL,
        reference    TEXT,
        description  TEXT,
        running_balance BIGINT NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_diamond_tx_username ON diamond_transactions (username, created_at DESC)`);
    log("diamond_balance column + diamond_transactions table ensured", "db");
  } catch (err) {
    console.error("diamond tables ensure error:", err);
  }

  // ── Withdraw Requests table ───────────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS withdraw_requests (
        id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        ref_id         TEXT NOT NULL UNIQUE,
        username       TEXT NOT NULL,
        agent_name     TEXT,
        amount         BIGINT NOT NULL,
        idr_value      BIGINT NOT NULL,
        method         TEXT NOT NULL DEFAULT 'bank',
        bank_name      TEXT NOT NULL,
        account_number TEXT NOT NULL,
        account_name   TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        notes          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at   TIMESTAMPTZ,
        processed_by   TEXT
      )
    `);
    await db.execute(sql`ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'bank'`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_wr_status ON withdraw_requests (status, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_wr_username ON withdraw_requests (username, created_at DESC)`);
    log("withdraw_requests table ensured", "db");
  } catch (err) {
    console.error("withdraw_requests table ensure error:", err);
  }

  // ── User Saved Accounts (for withdraw form autofill) ─────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_saved_accounts (
        id          SERIAL PRIMARY KEY,
        username    TEXT NOT NULL,
        method      TEXT NOT NULL DEFAULT 'bank',
        label       TEXT NOT NULL,
        bank_name   TEXT NOT NULL,
        account_number TEXT NOT NULL,
        account_name   TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_usa_username ON user_saved_accounts (username, created_at DESC)`);
    log("user_saved_accounts table ensured", "db");
  } catch (err) {
    console.error("user_saved_accounts table ensure error:", err);
  }

  // ── Shop Frames + User Frames tables ─────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS shop_frames (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT NOT NULL,
        image_url    TEXT NOT NULL,
        category     TEXT NOT NULL DEFAULT 'Bingkai',
        price_1d     BIGINT NOT NULL DEFAULT 880000,
        price_7d     BIGINT NOT NULL DEFAULT 5544000,
        price_30d    BIGINT NOT NULL DEFAULT 21120000,
        is_active    BOOLEAN NOT NULL DEFAULT true,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_shop_frames_active ON shop_frames (is_active, sort_order)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_frames (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      VARCHAR NOT NULL,
        username     TEXT NOT NULL,
        frame_id     VARCHAR NOT NULL REFERENCES shop_frames(id) ON DELETE CASCADE,
        expires_at   TIMESTAMPTZ NOT NULL,
        is_equipped  BOOLEAN NOT NULL DEFAULT false,
        purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_frames_user ON user_frames (user_id, is_equipped)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_frames_expires ON user_frames (expires_at)`);
    // Lottie support columns
    await db.execute(sql`ALTER TABLE shop_frames ADD COLUMN IF NOT EXISTS frame_type VARCHAR NOT NULL DEFAULT 'image'`);
    await db.execute(sql`ALTER TABLE shop_frames ADD COLUMN IF NOT EXISTS lottie_json TEXT`);
    // frame_url and is_active columns (requested schema fields)
    await db.execute(sql`ALTER TABLE user_frames ADD COLUMN IF NOT EXISTS frame_url TEXT`);
    await db.execute(sql`ALTER TABLE user_frames ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false`);
    // Back-fill frame_url for existing rows that don't have it yet
    await db.execute(sql`
      UPDATE user_frames uf
      SET frame_url = sf.image_url
      FROM shop_frames sf
      WHERE sf.id = uf.frame_id AND uf.frame_url IS NULL
    `);
    // Sync is_active with is_equipped for existing rows
    await db.execute(sql`UPDATE user_frames SET is_active = is_equipped WHERE is_active IS DISTINCT FROM is_equipped`);
    log("shop_frames + user_frames tables ensured", "db");
  } catch (err) {
    console.error("shop_frames tables ensure error:", err);
  }

  // ── Shop Entry Effects + User Entry Effects tables ────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS shop_entry_effects (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT NOT NULL,
        lottie_url   TEXT NOT NULL DEFAULT '',
        lottie_json  TEXT,
        price_1d     BIGINT NOT NULL DEFAULT 880000,
        price_7d     BIGINT NOT NULL DEFAULT 5544000,
        price_30d    BIGINT NOT NULL DEFAULT 21120000,
        is_active    BOOLEAN NOT NULL DEFAULT true,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_shop_entry_effects_active ON shop_entry_effects (is_active, sort_order)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_entry_effects (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      VARCHAR NOT NULL,
        username     TEXT NOT NULL,
        effect_id    VARCHAR NOT NULL REFERENCES shop_entry_effects(id) ON DELETE CASCADE,
        expires_at   TIMESTAMPTZ NOT NULL,
        is_equipped  BOOLEAN NOT NULL DEFAULT false,
        is_active    BOOLEAN NOT NULL DEFAULT false,
        purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_entry_effects_user ON user_entry_effects (user_id, is_equipped)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_entry_effects_expires ON user_entry_effects (expires_at)`);
    log("shop_entry_effects + user_entry_effects tables ensured", "db");
  } catch (err) {
    console.error("shop_entry_effects tables ensure error:", err);
  }

  // ── Live Solo tables ────────────────────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS live_streams (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        host_user_id     VARCHAR NOT NULL,
        host_username    TEXT    NOT NULL,
        host_display_name TEXT,
        host_avatar_url  TEXT,
        title            TEXT    NOT NULL,
        category         TEXT    NOT NULL DEFAULT 'general',
        thumbnail_url    TEXT,
        status           TEXT    NOT NULL DEFAULT 'live',
        viewer_count     INTEGER NOT NULL DEFAULT 0,
        total_gifts      BIGINT  NOT NULL DEFAULT 0,
        started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at         TIMESTAMPTZ
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_live_streams_status   ON live_streams (status, started_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_live_streams_host     ON live_streams (host_user_id, status)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS stream_gifts (
        id               BIGSERIAL PRIMARY KEY,
        stream_id        VARCHAR NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
        sender_user_id   VARCHAR NOT NULL,
        sender_username  TEXT    NOT NULL,
        host_user_id     VARCHAR NOT NULL,
        gift_name        TEXT    NOT NULL DEFAULT 'Gift',
        amount_coins     BIGINT  NOT NULL DEFAULT 0,
        sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stream_gifts_stream   ON stream_gifts (stream_id, sent_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stream_gifts_host     ON stream_gifts (host_user_id, sent_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stream_gifts_sender   ON stream_gifts (sender_user_id, sent_at DESC)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS stream_viewers (
        id          BIGSERIAL PRIMARY KEY,
        stream_id   VARCHAR NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
        user_id     VARCHAR NOT NULL,
        username    TEXT    NOT NULL,
        joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        left_at     TIMESTAMPTZ,
        UNIQUE (stream_id, user_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stream_viewers_stream ON stream_viewers (stream_id, left_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stream_viewers_user   ON stream_viewers (user_id)`);

    log("live_streams, stream_gifts, stream_viewers tables ensured", "db");
  } catch (err) {
    console.error("Live Solo tables ensure error:", err);
  }

  // Seed default data to database on first boot
  if (storage instanceof DatabaseStorage) {
    try {
      await storage.seed();
      log("Database seeded successfully", "db");
    } catch (err) {
      console.error("Database seed error:", err);
    }
  }

  await registerRoutes(httpServer, app);

  botHunterEngine.start();
  await initFloodGuard();

  // Start frame expiry cleanup job (runs every hour)
  startFrameExpiryCleanup();

  // Start agency payroll system: setup schema + daily earnings snapshot (00:01 WIB)
  // NOTE: Diamond payroll is MANUAL ONLY — no automatic diamond sending here.
  startWeeklyPayrollCron();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    logger.error({ err, status }, "Internal Server Error");
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    { port, host: "0.0.0.0", reusePort: true },
    () => { log(`serving on port ${port}`); }
  );

  startTcpGateway();

  // Graceful shutdown — matches RedisConnectionManager.shutdown() in backend app
  process.on("SIGTERM", async () => {
    botHunterEngine.stop();
    await closeRedis();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    botHunterEngine.stop();
    await closeRedis();
    process.exit(0);
  });
})();

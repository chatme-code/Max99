CREATE TABLE "badges" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon_url" text
);
--> statement-breakpoint
CREATE TABLE "badges_rewarded" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"badge_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "block_list" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"block_username" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"property_name" text,
	"property_value" text,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" serial PRIMARY KEY NOT NULL,
	"game" text DEFAULT '' NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"command_name" text,
	"executable_file_name" text,
	"library_paths" text,
	"type" integer DEFAULT 1 NOT NULL,
	"leaderboards" boolean DEFAULT false NOT NULL,
	"emoticon_key_list" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"group_id" integer DEFAULT 0 NOT NULL,
	"status" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatroom_banned_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"chatroom_id" varchar NOT NULL,
	"username" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatroom_bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"chatroom_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatroom_moderators" (
	"id" serial PRIMARY KEY NOT NULL,
	"chatroom_id" varchar NOT NULL,
	"username" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"name" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"first_name" text,
	"last_name" text,
	"fusion_username" text,
	"email_address" text,
	"mobile_phone" text,
	"contact_group_id" integer,
	"share_mobile_phone" integer,
	"display_on_phone" integer DEFAULT 0 NOT NULL,
	"status" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emoticon_packs" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" integer DEFAULT 0 NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text,
	"price" double precision DEFAULT 0 NOT NULL,
	"sort_order" integer,
	"for_sale" integer DEFAULT 1 NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"group_id" integer
);
--> statement-breakpoint
CREATE TABLE "emoticons" (
	"id" serial PRIMARY KEY NOT NULL,
	"emoticon_pack_id" integer NOT NULL,
	"type" integer NOT NULL,
	"alias" text DEFAULT '' NOT NULL,
	"width" integer DEFAULT 0 NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"location_png" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"group_id" integer NOT NULL,
	"type" integer DEFAULT 0 NOT NULL,
	"sms_notification" integer DEFAULT 0 NOT NULL,
	"email_notification" integer DEFAULT 0 NOT NULL,
	"event_notification" integer DEFAULT 0 NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"expiration_date" timestamp
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" smallint DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"picture" text,
	"email_address" text,
	"country_id" integer,
	"premium" integer DEFAULT 0 NOT NULL,
	"sort_order" integer,
	"num_members" integer DEFAULT 0 NOT NULL,
	"num_photos" integer DEFAULT 0 NOT NULL,
	"num_forum_posts" integer DEFAULT 0 NOT NULL,
	"featured" smallint DEFAULT 0 NOT NULL,
	"official" smallint DEFAULT 0 NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"type" integer NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_gifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"hot_key" text,
	"price" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'MIG' NOT NULL,
	"num_available" integer,
	"num_sold" integer DEFAULT 0 NOT NULL,
	"sort_order" integer,
	"group_id" integer,
	"group_vip_only" boolean DEFAULT false,
	"location_64x64_png" text,
	"location_16x16_png" text,
	"gift_all_message" text,
	"status" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_gifts_received" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"sender" text NOT NULL,
	"virtual_gift_id" integer NOT NULL,
	"message" text,
	"purchase_location" integer,
	"is_private" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

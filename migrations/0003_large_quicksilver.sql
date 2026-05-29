CREATE TABLE "alert_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" integer DEFAULT 0 NOT NULL,
	"content_type" integer,
	"client_type" integer DEFAULT 0 NOT NULL,
	"country_id" integer,
	"min_midlet_version" integer DEFAULT 0 NOT NULL,
	"max_midlet_version" integer DEFAULT 9999 NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"image_url" text,
	"action_url" text,
	"status" integer DEFAULT 1 NOT NULL,
	"start_date" timestamp DEFAULT now() NOT NULL,
	"expiry_date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bounce_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_address" text NOT NULL,
	"bounce_type" text DEFAULT 'Permanent' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bounce_emails_email_address_unique" UNIQUE("email_address")
);
--> statement-breakpoint
CREATE TABLE "campaign_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"mobile_phone" text,
	"email_address" text,
	"reference" text,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" integer DEFAULT 1 NOT NULL,
	"start_date" timestamp,
	"end_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatroom_favourites" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"chatroom_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_texts" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" varchar NOT NULL,
	"from_username" text NOT NULL,
	"from_display_name" text,
	"to_user_id" varchar NOT NULL,
	"to_username" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fashion_show_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"required_level" integer DEFAULT 1 NOT NULL,
	"required_active_days" integer DEFAULT 14 NOT NULL,
	"required_avatar_items" integer DEFAULT 2 NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"votes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"friend_user_id" varchar NOT NULL,
	"friend_username" text NOT NULL,
	"friend_display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardset_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_type" integer NOT NULL,
	"guard_capability" integer NOT NULL,
	"min_version" smallint DEFAULT 0 NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_username" text NOT NULL,
	"type" integer DEFAULT 1 NOT NULL,
	"channel" integer DEFAULT 1 NOT NULL,
	"destination" text NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "leaderboard_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"leaderboard_type" text NOT NULL,
	"period" text NOT NULL,
	"username" text NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"type" text NOT NULL,
	"subject" text,
	"message" text NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paintwars_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"total_paintwars_points" integer DEFAULT 0 NOT NULL,
	"total_paints_sent" integer DEFAULT 0 NOT NULL,
	"total_paints_received" integer DEFAULT 0 NOT NULL,
	"total_cleans_sent" integer DEFAULT 0 NOT NULL,
	"total_cleans_received" integer DEFAULT 0 NOT NULL,
	"paints_remaining" integer DEFAULT 3 NOT NULL,
	"cleans_remaining" integer DEFAULT 2 NOT NULL,
	"identicon_index" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "paintwars_stats_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"vendor_type" text NOT NULL,
	"vendor_transaction_id" text,
	"amount" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"description" text,
	"extra_fields" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_images" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"image_key" text NOT NULL,
	"mime_type" text DEFAULT 'image/jpeg' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"base64_data" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "server_images_image_key_unique" UNIQUE("image_key")
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text,
	"phone_number" text NOT NULL,
	"message" text NOT NULL,
	"sub_type" integer DEFAULT 1 NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"gateway" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "switchboard_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_username" text NOT NULL,
	"to_username" text NOT NULL,
	"message_type" text NOT NULL,
	"payload" jsonb,
	"status" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_event_privacy" (
	"username" text PRIMARY KEY NOT NULL,
	"receiving_status_updates" boolean DEFAULT true NOT NULL,
	"receiving_profile_changes" boolean DEFAULT true NOT NULL,
	"receiving_add_friends" boolean DEFAULT false NOT NULL,
	"receiving_photos_published" boolean DEFAULT true NOT NULL,
	"receiving_content_purchased" boolean DEFAULT true NOT NULL,
	"receiving_chatroom_creation" boolean DEFAULT true NOT NULL,
	"receiving_virtual_gifting" boolean DEFAULT true NOT NULL,
	"publishing_status_updates" boolean DEFAULT true NOT NULL,
	"publishing_profile_changes" boolean DEFAULT true NOT NULL,
	"publishing_add_friends" boolean DEFAULT false NOT NULL,
	"publishing_photos_published" boolean DEFAULT true NOT NULL,
	"publishing_content_purchased" boolean DEFAULT true NOT NULL,
	"publishing_chatroom_creation" boolean DEFAULT true NOT NULL,
	"publishing_virtual_gifting" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"generating_username" text,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_reputation" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"kicks_initiated" integer DEFAULT 0 NOT NULL,
	"authenticated_referrals" integer DEFAULT 0 NOT NULL,
	"recharged_amount" double precision DEFAULT 0 NOT NULL,
	"phone_call_duration" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"virtual_gifts_sent" integer DEFAULT 0 NOT NULL,
	"virtual_gifts_received" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_reputation_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "voice_calls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_username" text NOT NULL,
	"callee_username" text NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"duration" integer DEFAULT 0 NOT NULL,
	"calling_card" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "username_color" SET DEFAULT '#990099';--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "read_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "read_by" text;
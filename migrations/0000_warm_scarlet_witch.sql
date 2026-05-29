CREATE TABLE "chatroom_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chatroom_id" varchar NOT NULL,
	"sender_id" varchar,
	"sender_username" text NOT NULL,
	"sender_color" text DEFAULT '#4CAF50' NOT NULL,
	"text" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatrooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" integer NOT NULL,
	"current_participants" integer DEFAULT 0 NOT NULL,
	"max_participants" integer DEFAULT 50 NOT NULL,
	"color" text DEFAULT '#4CAF50' NOT NULL,
	"language" text DEFAULT 'id' NOT NULL,
	"allow_kick" boolean DEFAULT true NOT NULL,
	"adult_only" boolean DEFAULT false NOT NULL,
	"user_owned" boolean DEFAULT false NOT NULL,
	"type" integer DEFAULT 1 NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chatrooms_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar NOT NULL,
	"sender_id" varchar,
	"sender_username" text NOT NULL,
	"text" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text DEFAULT 'private' NOT NULL,
	"name" text,
	"avatar_color" text DEFAULT '#4CAF50' NOT NULL,
	"created_by" varchar NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"last_message_text" text,
	"last_message_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"currency" text DEFAULT 'MIG' NOT NULL,
	"balance" double precision DEFAULT 0 NOT NULL,
	"funded_balance" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_accounts_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"type" integer NOT NULL,
	"reference" text,
	"description" text,
	"currency" text DEFAULT 'MIG' NOT NULL,
	"amount" double precision NOT NULL,
	"funded_amount" double precision DEFAULT 0 NOT NULL,
	"tax" double precision DEFAULT 0 NOT NULL,
	"running_balance" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lost_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"lost_username" text NOT NULL,
	"note" text,
	"status" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_username" text NOT NULL,
	"location_id" integer,
	"name" text NOT NULL,
	"address" text,
	"phone_number" text,
	"email_address" text,
	"notes" text,
	"status" integer DEFAULT 1 NOT NULL,
	"user_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "merchant_points" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_username" text NOT NULL,
	"user_id" varchar NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_tags" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_username" text NOT NULL,
	"tagged_username" text NOT NULL,
	"type" integer DEFAULT 2 NOT NULL,
	"expiry" timestamp,
	"status" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"category" text,
	"logo_url" text,
	"website_url" text,
	"status" integer DEFAULT 1 NOT NULL,
	"username_color" text DEFAULT '#4CAF50',
	"total_points" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "reward_programs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" integer DEFAULT 1 NOT NULL,
	"category" integer DEFAULT 1 NOT NULL,
	"country_id" integer,
	"min_mig_level" integer DEFAULT 1 NOT NULL,
	"max_mig_level" integer,
	"quantity_required" integer,
	"amount_required" double precision,
	"amount_required_currency" text,
	"mig_credit_reward" double precision,
	"mig_credit_reward_currency" text DEFAULT 'MIG',
	"score_reward" integer,
	"level_reward" integer,
	"status" integer DEFAULT 1 NOT NULL,
	"start_date" timestamp,
	"end_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" varchar NOT NULL,
	"owner_username" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"theme" text DEFAULT 'default',
	"max_participants" integer DEFAULT 20 NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"gender" text,
	"date_of_birth" text,
	"country" text,
	"city" text,
	"about_me" text,
	"likes" text,
	"dislikes" text,
	"relationship_status" integer DEFAULT 1,
	"profile_status" integer DEFAULT 1 NOT NULL,
	"anonymous_viewing" boolean DEFAULT false NOT NULL,
	"display_picture" text,
	"mig_level" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_recommendations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"recommended_user_id" varchar NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_reward_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"program_id" varchar,
	"program_name" text,
	"reward_type" text NOT NULL,
	"mig_credit_amount" double precision,
	"mig_credit_currency" text,
	"score_amount" integer,
	"level_amount" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"verify_token" text,
	"verify_token_expiry" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "voucher_batches" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_username" text NOT NULL,
	"currency" text DEFAULT 'MIG' NOT NULL,
	"amount" double precision NOT NULL,
	"num_voucher" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"expiry_date" timestamp,
	"num_active" integer DEFAULT 0 NOT NULL,
	"num_cancelled" integer DEFAULT 0 NOT NULL,
	"num_redeemed" integer DEFAULT 0 NOT NULL,
	"num_expired" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_batch_id" varchar NOT NULL,
	"code" text NOT NULL,
	"currency" text DEFAULT 'MIG' NOT NULL,
	"amount" double precision NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"redeemed_by_username" text,
	"notes" text,
	"expiry_date" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "wall_posts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"author_user_id" varchar NOT NULL,
	"author_username" text NOT NULL,
	"comment" text NOT NULL,
	"type" integer DEFAULT 1 NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"num_comments" integer DEFAULT 0 NOT NULL,
	"num_likes" integer DEFAULT 0 NOT NULL,
	"num_dislikes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

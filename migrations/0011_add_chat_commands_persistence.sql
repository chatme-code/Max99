ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_suspended" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatroom_muted_users" (
  "id" serial PRIMARY KEY NOT NULL,
  "chatroom_id" varchar NOT NULL,
  "user_id" varchar NOT NULL,
  "username" text NOT NULL,
  "muted_until" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

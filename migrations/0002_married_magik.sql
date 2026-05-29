CREATE TABLE "user_chat_list_versions" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "group_owner" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "is_passivated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_message_type" text DEFAULT 'text' NOT NULL;
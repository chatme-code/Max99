CREATE TABLE IF NOT EXISTS "post_comments" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id" varchar NOT NULL REFERENCES "wall_posts"("id") ON DELETE CASCADE,
  "author_user_id" varchar NOT NULL,
  "author_username" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

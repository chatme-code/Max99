ALTER TABLE "wall_posts" ADD COLUMN IF NOT EXISTS "repost_id" varchar;
ALTER TABLE "wall_posts" ADD COLUMN IF NOT EXISTS "repost_author_username" text;
ALTER TABLE "wall_posts" ADD COLUMN IF NOT EXISTS "repost_comment" text;

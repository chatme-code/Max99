ALTER TABLE user_reputation
  ADD COLUMN IF NOT EXISTS chat_room_messages_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS private_messages_sent   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_time              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS photos_uploaded         integer NOT NULL DEFAULT 0;

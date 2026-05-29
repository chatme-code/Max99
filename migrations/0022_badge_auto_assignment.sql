-- Add auto-assignment slot columns to badges table.
-- A badge can be assigned to a leaderboard slot (top N of a game's wins, or
-- top N gift senders) so it shows up automatically on the user's mini profile.
ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_kind      TEXT;
ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_game_type TEXT;
ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_rank      INTEGER;
ALTER TABLE badges ADD COLUMN IF NOT EXISTS slot_period    TEXT;

-- Each (kind, game, rank, period) tuple can only be filled by one badge.
CREATE UNIQUE INDEX IF NOT EXISTS badges_slot_unique
  ON badges (slot_kind, COALESCE(slot_game_type, ''), slot_rank, slot_period)
  WHERE slot_kind IS NOT NULL;

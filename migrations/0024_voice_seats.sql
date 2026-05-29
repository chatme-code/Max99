-- Voice Room (Agora-based, global, 2 seats, admin-controlled)
-- Migration: 0024
-- Created: 2026-04-27

-- Global setting: apakah voice room aktif atau tidak (di-toggle global admin)
-- Disimpan di system_settings (key/value store) untuk konsisten dengan pattern lain
INSERT INTO system_settings (key, value)
VALUES ('voiceroom.enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- Channel name untuk Agora (1 voice room global = 1 channel)
INSERT INTO system_settings (key, value)
VALUES ('voiceroom.channel', 'max99-global-voice')
ON CONFLICT (key) DO NOTHING;

-- Tabel kursi voice (cuma 2 baris max — global, bukan per room)
CREATE TABLE IF NOT EXISTS voice_seats (
  id          SERIAL PRIMARY KEY,
  seat_index  SMALLINT NOT NULL UNIQUE CHECK (seat_index IN (1, 2)),
  user_id     VARCHAR(255) NULL,
  username    VARCHAR(255) NULL,
  display_name VARCHAR(255) NULL,
  avatar_url  TEXT NULL,
  is_muted    BOOLEAN NOT NULL DEFAULT false,
  agora_uid   INTEGER NULL,
  joined_at   TIMESTAMPTZ NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pre-seed 2 kursi kosong (kursi 1 dan 2)
INSERT INTO voice_seats (seat_index) VALUES (1) ON CONFLICT (seat_index) DO NOTHING;
INSERT INTO voice_seats (seat_index) VALUES (2) ON CONFLICT (seat_index) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_voice_seats_user ON voice_seats (user_id) WHERE user_id IS NOT NULL;

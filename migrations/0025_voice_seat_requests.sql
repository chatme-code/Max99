-- Voice Seat Request Flow (per chatroom)
-- Migration: 0025
-- Created: 2026-04-29
--
-- User non-admin tap kursi kosong → request masuk antrean.
-- Admin lihat badge di voice room admin modal → approve / reject.
-- Approve = panggil flow assignSeat existing.

CREATE TABLE IF NOT EXISTS voice_seat_requests (
  id            SERIAL PRIMARY KEY,
  chatroom_id   VARCHAR(255) NOT NULL,
  seat_index    SMALLINT NOT NULL CHECK (seat_index IN (1, 2)),
  user_id       VARCHAR(255) NOT NULL,
  username      VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255) NULL,
  avatar_url    TEXT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ NULL,
  resolved_by   VARCHAR(255) NULL
);

-- Hanya boleh ada 1 request 'pending' per (chatroom, user) agar tidak double.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_voice_seat_request_pending
  ON voice_seat_requests (chatroom_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_voice_seat_requests_room_pending
  ON voice_seat_requests (chatroom_id, status)
  WHERE status = 'pending';

ALTER TABLE apk_releases ADD COLUMN IF NOT EXISTS download_count BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS apk_download_logs (
  id          BIGSERIAL PRIMARY KEY,
  release_id  INTEGER NOT NULL REFERENCES apk_releases(id) ON DELETE CASCADE,
  ip          TEXT,
  user_agent  TEXT,
  logged_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apk_dl_logs_release ON apk_download_logs(release_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_apk_dl_logs_time ON apk_download_logs(logged_at DESC);

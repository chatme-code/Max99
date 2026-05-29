CREATE TABLE IF NOT EXISTS apk_releases (
  id               SERIAL PRIMARY KEY,
  version_name     TEXT    NOT NULL,
  version_code     INTEGER NOT NULL DEFAULT 1,
  changelog        TEXT,
  file_name        TEXT    NOT NULL,
  file_size        BIGINT  DEFAULT 0,
  download_url     TEXT    NOT NULL,
  min_android      INTEGER DEFAULT 7,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apk_releases_active ON apk_releases (is_active, created_at DESC);

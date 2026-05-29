CREATE TABLE IF NOT EXISTS device_registrations (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL,
  username    TEXT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_reg_device ON device_registrations(device_id);
CREATE INDEX IF NOT EXISTS idx_device_reg_username ON device_registrations(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_reg_unique ON device_registrations(device_id, username);

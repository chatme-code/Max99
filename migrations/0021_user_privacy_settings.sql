CREATE TABLE IF NOT EXISTS user_privacy_settings (
  id                          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  username                    TEXT NOT NULL UNIQUE,
  -- Profile Details
  dob_privacy                 INTEGER NOT NULL DEFAULT 0,
  first_last_name_privacy     INTEGER NOT NULL DEFAULT 0,
  mobile_phone_privacy        INTEGER NOT NULL DEFAULT 0,
  external_email_privacy      INTEGER NOT NULL DEFAULT 0,
  -- Account Communication
  chat_privacy                INTEGER NOT NULL DEFAULT 1,
  buzz_privacy                INTEGER NOT NULL DEFAULT 1,
  lookout_privacy             INTEGER NOT NULL DEFAULT 1,
  footprints_privacy          INTEGER NOT NULL DEFAULT 0,
  feed_privacy                INTEGER NOT NULL DEFAULT 1,
  -- Activity / Event Privacy
  activity_status_updates     BOOLEAN NOT NULL DEFAULT TRUE,
  activity_profile_changes    BOOLEAN NOT NULL DEFAULT TRUE,
  activity_add_friends        BOOLEAN NOT NULL DEFAULT FALSE,
  activity_photos_published   BOOLEAN NOT NULL DEFAULT TRUE,
  activity_content_purchased  BOOLEAN NOT NULL DEFAULT TRUE,
  activity_chatroom_creation  BOOLEAN NOT NULL DEFAULT TRUE,
  activity_virtual_gifting    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_privacy_settings_username
  ON user_privacy_settings(username);

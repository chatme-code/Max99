-- Migration: 0007_add_message_tables
-- Mirrors Java: MessageDAOChain.java / FusionDbMessageDAOChain.java
-- Original tables: clienttext, alertmessage

-- client_texts (was: clienttext)
-- type: 1 = HelpText, 2 = InfoText
CREATE TABLE IF NOT EXISTS "client_texts" (
  "id"         SERIAL PRIMARY KEY,
  "type"       INTEGER NOT NULL,
  "text"       TEXT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_client_texts_type" ON "client_texts"("type");

-- alert_messages (was: alertmessage)
-- status: 1 = ACTIVE, 0 = INACTIVE
CREATE TABLE IF NOT EXISTS "alert_messages" (
  "id"                 SERIAL PRIMARY KEY,
  "type"               INTEGER NOT NULL DEFAULT 0,
  "content_type"       INTEGER,
  "client_type"        INTEGER NOT NULL DEFAULT 0,
  "country_id"         INTEGER,
  "min_midlet_version" INTEGER NOT NULL DEFAULT 0,
  "max_midlet_version" INTEGER NOT NULL DEFAULT 9999,
  "title"              TEXT,
  "content"            TEXT NOT NULL,
  "image_url"          TEXT,
  "action_url"         TEXT,
  "status"             INTEGER NOT NULL DEFAULT 1,
  "start_date"         TIMESTAMP NOT NULL DEFAULT now(),
  "expiry_date"        TIMESTAMP NOT NULL,
  "created_at"         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_alert_messages_status"      ON "alert_messages"("status");
CREATE INDEX IF NOT EXISTS "idx_alert_messages_client_type" ON "alert_messages"("client_type");

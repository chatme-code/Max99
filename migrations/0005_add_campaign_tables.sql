-- Migration: 0005_add_campaign_tables
-- Mirrors Java: CampaignDataDAOChain.java / FusionDbCampaignDataDAOChain.java
-- Original tables: campaign, campaignparticipant

-- campaigns (was: campaign)
CREATE TABLE IF NOT EXISTS "campaigns" (
  "id"          SERIAL PRIMARY KEY,
  "type"        INTEGER NOT NULL DEFAULT 0,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "status"      INTEGER NOT NULL DEFAULT 1,
  "start_date"  TIMESTAMP,
  "end_date"    TIMESTAMP,
  "created_at"  TIMESTAMP NOT NULL DEFAULT now()
);

-- campaign_participants (was: campaignparticipant)
CREATE TABLE IF NOT EXISTS "campaign_participants" (
  "id"            SERIAL PRIMARY KEY,
  "campaign_id"   INTEGER NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "user_id"       TEXT NOT NULL,
  "mobile_phone"  TEXT,
  "email_address" TEXT,
  "reference"     TEXT,
  "joined_at"     TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_campaign_participants_campaign_id" ON "campaign_participants"("campaign_id");
CREATE INDEX IF NOT EXISTS "idx_campaign_participants_user_id"     ON "campaign_participants"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_campaign_participants_user_campaign"
  ON "campaign_participants"("campaign_id", "user_id");

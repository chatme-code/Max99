-- Migration: 0006_add_bounce_emails
-- Mirrors Java: EmailDAOChain.java / FusionDbEmailDAOChain.java
-- Original table: bouncedb

-- bounce_emails (was: bouncedb)
-- bounceType: 'Transient' = soft bounce (temporary, may succeed later)
--             'Permanent' = hard bounce (always blocked)
CREATE TABLE IF NOT EXISTS "bounce_emails" (
  "id"            SERIAL PRIMARY KEY,
  "email_address" TEXT NOT NULL UNIQUE,
  "bounce_type"   TEXT NOT NULL DEFAULT 'Permanent',
  "created_at"    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_bounce_emails_email_address" ON "bounce_emails"("email_address");

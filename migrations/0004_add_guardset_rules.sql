CREATE TABLE IF NOT EXISTS guardset_rules (
  id SERIAL PRIMARY KEY,
  client_type INTEGER NOT NULL,
  guard_capability INTEGER NOT NULL,
  min_version SMALLINT NOT NULL DEFAULT 0,
  description TEXT
);

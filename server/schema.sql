CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_enc  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  last_used_at  INTEGER
);
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER
);
CREATE TABLE IF NOT EXISTS leases (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  expires_at    INTEGER NOT NULL,
  released_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leases_active ON leases(account_id, released_at, expires_at);

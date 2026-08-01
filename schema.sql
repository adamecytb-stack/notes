-- Dream Journal schema.
--
-- Note what is NOT here: there is no column anywhere that holds dream text.
-- Entry content lives only in `entries.ciphertext`, which is AES-GCM output
-- produced on the phone with a key the server never receives.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  -- Client-generated random salt for PBKDF2. Public by design.
  kdf_salt      TEXT NOT NULL,
  -- PBKDF2(auth_proof) — a hash of a hash. A stolen DB does not yield a login.
  verifier      TEXT NOT NULL,
  verifier_salt TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- ECDH P-256 keypair for sharing. The public half is public by definition;
  -- the private half is stored wrapped with the owner's vault key, so it can
  -- follow them to a new phone without the server ever holding it usably.
  public_key      TEXT,
  wrapped_private TEXT,
  wrapped_iv      TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256 of the cookie token; the raw token exists only in the browser.
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  iv         TEXT NOT NULL,          -- base64, 12 bytes, unique per write
  ciphertext TEXT NOT NULL,          -- base64 AES-GCM blob
  dreamed_at INTEGER NOT NULL,       -- ms epoch, cleartext so we can sort/group
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                 -- soft delete, so other devices can sync it
);
CREATE INDEX IF NOT EXISTS idx_entries_user_dreamed ON entries(user_id, dreamed_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_updated ON entries(user_id, updated_at);

-- A dream one person has shared with the other.
--
-- The owner's own copy stays in `entries`, encrypted to their vault key and
-- untouched. A share is a second, separately encrypted copy: the payload under
-- a fresh random content key, and that content key wrapped to the ECDH secret
-- the two of them share. The server holds both halves and can open neither.
CREATE TABLE IF NOT EXISTS shares (
  entry_id     TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  iv           TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  wrapped_key  TEXT NOT NULL,   -- content key, wrapped to ECDH(owner, recipient)
  wrap_iv      TEXT NOT NULL,
  dreamed_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_recipient ON shares(recipient_id, dreamed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);

-- Web push registrations. Reminders fire from a cron trigger, so the phone does
-- not need the app open. Payloads are never sent — the notification text lives
-- in the service worker — which keeps this table free of anything personal.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  timezone     TEXT NOT NULL DEFAULT 'UTC',
  morning_time TEXT NOT NULL DEFAULT '',   -- 'HH:MM' local, '' = off
  check_times  TEXT NOT NULL DEFAULT '',   -- comma-separated 'HH:MM' local
  bedtime_time TEXT NOT NULL DEFAULT '',   -- 'HH:MM' local — the intention nudge
  wbtb_time    TEXT NOT NULL DEFAULT '',   -- 'HH:MM' local — the wake-back-to-bed alarm
  last_fired   TEXT NOT NULL DEFAULT '',   -- 'YYYY-MM-DD HH:MM' of the last slot
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Caps how much the AI can be called. The free Gemini tier allows roughly 15
-- requests a minute and 1,500 a day across the whole key, so both people share
-- one budget and a runaway client must not burn it.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,               -- YYYY-MM-DD, UTC
  count    INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER NOT NULL DEFAULT 0   -- ms epoch, for the per-request gap
);

-- Login throttling. Keyed by username so a locked account cannot be bypassed
-- by rotating source IPs.
CREATE TABLE IF NOT EXISTS login_attempts (
  username     TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

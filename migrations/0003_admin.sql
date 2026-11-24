-- The operator (admin) interface: suspension, the audit log, and when the cron jobs last ran.
-- Additive only: existing rows stay valid (a NULL suspended_at means the account is active).

ALTER TABLE users ADD COLUMN suspended_at INTEGER;

-- What the operator did, newest first. Never holds a sign-in code or a credential.
-- No user_id column on purpose: an entry outlives the account it is about.
CREATE TABLE admin_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'core'
);

-- Small facts about the core itself (for example when each cron job last finished).
CREATE TABLE core_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- So that the operator's counts read an index instead of whole tables.
CREATE INDEX items_created ON items (created_at);
CREATE INDEX items_live ON items (user_id) WHERE archived_at IS NULL;
CREATE INDEX analyses_created ON analyses (created_at);
CREATE INDEX usage_created ON usage_records (created_at);

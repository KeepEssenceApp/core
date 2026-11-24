-- Every table that holds user data has user_id, and every query filters by it.
-- Times are integers: milliseconds since the epoch (UTC).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  lang TEXT NOT NULL DEFAULT 'en',
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  notify INTEGER NOT NULL DEFAULT 1,
  rules TEXT NOT NULL DEFAULT '',
  preference TEXT,
  expiry_options TEXT NOT NULL DEFAULT '[7,30,90,365]',
  role_analysis TEXT,
  role_digest TEXT,
  role_deep_read TEXT,
  role_deep_dive TEXT,
  calendar_enabled INTEGER NOT NULL DEFAULT 0,
  calendar_secret TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE invites (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  client TEXT NOT NULL,
  tier TEXT NOT NULL,
  credential_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE device_codes (
  code_hash TEXT PRIMARY KEY,
  poll_secret_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  client TEXT NOT NULL,
  requested_tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  device_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX device_codes_expiry ON device_codes (expires_at);

CREATE TABLE push_targets (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_targets_user ON push_targets (user_id);

CREATE TABLE notify_batches (
  user_id TEXT PRIMARY KEY,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  events TEXT NOT NULL
);

CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  steps TEXT NOT NULL,
  built_in TEXT,
  client_id TEXT,
  runs_at TEXT,
  connected_at INTEGER,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX assistants_user ON assistants (user_id);
CREATE UNIQUE INDEX assistants_name ON assistants (user_id, name) WHERE revoked_at IS NULL;

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  client_uri TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_uri TEXT,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  steps TEXT NOT NULL,
  resource TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE oauth_access (
  credential_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_access_assistant ON oauth_access (assistant_id);

CREATE TABLE oauth_refresh (
  credential_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX oauth_refresh_assistant ON oauth_refresh (assistant_id);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT,
  url_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  title_from TEXT NOT NULL DEFAULT 'none',
  site TEXT,
  opening TEXT NOT NULL DEFAULT '',
  body TEXT,
  asset_id TEXT,
  source TEXT NOT NULL DEFAULT '',
  content_unavailable INTEGER NOT NULL DEFAULT 0,
  fetch_state TEXT NOT NULL DEFAULT 'none',
  fetch_attempts INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  expiry_days INTEGER NOT NULL DEFAULT 30,
  expires_at INTEGER NOT NULL,
  hard_expires_at INTEGER NOT NULL,
  queue_holds INTEGER NOT NULL DEFAULT 0,
  dispatch_to TEXT,
  triaged_at INTEGER,
  analysed_at INTEGER,
  digest_day TEXT,
  signal TEXT,
  viewed_at INTEGER,
  claim_id TEXT,
  claim_expires_at INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX items_user_created ON items (user_id, created_at);
CREATE INDEX items_expiry ON items (expires_at) WHERE pinned = 0 AND archived_at IS NULL;
-- A link that is still there cannot be saved a second time.
CREATE UNIQUE INDEX items_url ON items (user_id, url_key) WHERE archived_at IS NULL AND url_key IS NOT NULL;
CREATE INDEX items_untriaged ON items (created_at) WHERE triaged_at IS NULL AND archived_at IS NULL;
CREATE INDEX items_unanalysed ON items (dispatch_to) WHERE analysed_at IS NULL AND archived_at IS NULL;

CREATE TABLE item_tags (
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  set_by TEXT NOT NULL,
  PRIMARY KEY (item_id, kind)
);

CREATE TABLE analyses (
  item_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  unavailable INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  key_fact TEXT,
  points TEXT NOT NULL DEFAULT '[]',
  verdict TEXT,
  related_hint TEXT,
  assistant_id TEXT NOT NULL,
  claim_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX analyses_user ON analyses (user_id);

CREATE TABLE digests (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due',
  summary TEXT,
  question TEXT,
  worth TEXT,
  entries TEXT,
  covers TEXT,
  assistant_id TEXT,
  due_at INTEGER,
  created_at INTEGER,
  read_at INTEGER,
  claim_id TEXT,
  claim_expires_at INTEGER,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE deep_read_queue (
  item_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  report TEXT,
  assistant_id TEXT,
  entry TEXT,
  went_at INTEGER,
  fetched_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  claim_id TEXT,
  claim_expires_at INTEGER
);
CREATE INDEX deep_read_queue_user ON deep_read_queue (user_id);

CREATE TABLE deep_dive_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  opening_line TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  UNIQUE (user_id, item_id, assistant_id)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  item_id TEXT,
  item_title TEXT,
  item_url TEXT,
  digest_day TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  asset_ids TEXT NOT NULL DEFAULT '[]',
  assistant_id TEXT,
  assistant_name TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL DEFAULT 'assistant',
  created_at INTEGER NOT NULL
);
CREATE INDEX notes_user ON notes (user_id, created_at);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  refs INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, sha256)
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  refs TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX claims_assistant ON claims (assistant_id, status);

-- Which claim handed in each piece of work (one row per piece and kind).
CREATE TABLE submissions (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref)
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  claim_id TEXT,
  kind TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  self_reported INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX usage_user ON usage_records (user_id, created_at);

CREATE TABLE daily_counts (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  saved INTEGER NOT NULL DEFAULT 0,
  analysed INTEGER NOT NULL DEFAULT 0,
  digests INTEGER NOT NULL DEFAULT 0,
  notes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, source)
);

-- Per-user daily counters for the caps on built-in work (triage, analysis, digest).
CREATE TABLE daily_caps (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

CREATE TABLE idempotency (
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope, key_hash)
);
CREATE INDEX idempotency_created ON idempotency (created_at);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  win INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);

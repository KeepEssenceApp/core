-- Feedback a user sent to the operator of this deployment. Not an item: never analysed, never
-- shown to an assistant. Additive only.
-- It has a user_id, so deleting the account deletes its feedback here too; what the operator
-- already passed on elsewhere (issue_url) is the operator's own record.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  doing TEXT NOT NULL DEFAULT '',
  wrong TEXT NOT NULL,
  wish TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL,
  -- Where it was passed on to (an issue's address), when forwarding is configured.
  issue_url TEXT,
  forward_attempts INTEGER NOT NULL DEFAULT 0,
  forward_error TEXT
);
CREATE INDEX feedback_user ON feedback (user_id, created_at);
CREATE INDEX feedback_unsent ON feedback (created_at) WHERE issue_url IS NULL;

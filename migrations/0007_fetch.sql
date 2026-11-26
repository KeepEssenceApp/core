-- Which way a saved link's content came in, as counts. No address and no user: only the day, a
-- platform label from a short fixed list ("wechat", "xiaohongshu", "other") and the path
-- ("direct", "jina", "firecrawl", or "none" when nothing could read it). Additive only.
CREATE TABLE fetch_stats (
  day TEXT NOT NULL,
  platform TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, platform, path)
);

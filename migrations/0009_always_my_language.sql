-- QA #18 (Cheney, 2026-11-26, option 2): an account switch "always use my language". Off by default: an analysis
-- and a daily digest follow the language of the item itself. Additive only: every existing account gets 0 (off).
ALTER TABLE users ADD COLUMN always_my_language INTEGER NOT NULL DEFAULT 0;

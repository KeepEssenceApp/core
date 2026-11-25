-- QA #20: how often the built-in assistant failed to analyse an item. After three failures it
-- hands the item in as "content could not be read" instead of trying again every minute.
-- Additive only: existing rows stay valid (0 attempts).

ALTER TABLE items ADD COLUMN analysis_attempts INTEGER NOT NULL DEFAULT 0;

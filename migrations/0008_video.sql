-- #103: the words of a video. A video is read by the reader service in the background: the item is
-- saved at once and waits (fetch_state 'video_wait') until the words are there or given up on.
--   fetch_job        the reader service's id for the job; cleared when the item stops waiting
--   fetch_deadline   when the core gives up waiting (ms); cleared with the job
--   video_state      reading | recognized | no_speech | too_long | unavailable; NULL: no video found
--   recognized_text  what was recognized from the sound, at most 30000 characters; NULL: none
--   video_done_at    when the item stopped waiting (ms): the core's default triage counts its 10
--                    minutes from here, not from the save, so the sorting step still gets its turn
-- Additive only: existing rows stay valid (no video).

ALTER TABLE items ADD COLUMN fetch_job TEXT;
ALTER TABLE items ADD COLUMN fetch_deadline INTEGER;
ALTER TABLE items ADD COLUMN video_state TEXT;
ALTER TABLE items ADD COLUMN recognized_text TEXT;
ALTER TABLE items ADD COLUMN video_done_at INTEGER;

-- The minute job asks about the oldest waiting items, and cancels the jobs of items that were archived.
CREATE INDEX items_video_wait ON items (created_at) WHERE fetch_state = 'video_wait' AND archived_at IS NULL;
CREATE INDEX items_fetch_job ON items (archived_at) WHERE fetch_job IS NOT NULL;

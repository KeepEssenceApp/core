-- Quick find over notes (title and body). Trigram so that any three characters match,
-- including text without spaces. Shorter queries fall back to LIKE in the core.
CREATE VIRTUAL TABLE notes_fts USING fts5(note_id UNINDEXED, user_id UNINDEXED, title, body, tokenize = 'trigram');

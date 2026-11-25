-- QA #18: the language of the sign-in page that asked for a code; a new account starts with it.
-- Additive only: existing rows stay valid (NULL means "not known": the sign-in request's own language is used).

ALTER TABLE login_codes ADD COLUMN lang TEXT DEFAULT NULL;

-- #106: the invitation notice mail (spec product/mail.md).
-- Additive only: five nullable columns on `invites` and one partial index. Invitations that already
-- exist keep NULL in all of them, which means "no mail was sent for this one and none will be".
--   invite_id            this invitation's own identity (inv_ + random). A withdrawn and re-issued
--                        invitation is a new row with a new id. The mail's claim and its result are
--                        written by this id (and the state), never by the address alone.
--   lang                 the language of the sign-in page the person signed up from (NULL: the core's default, English)
--   invite_mail_state    queued | sending | accepted | failed | not_sent
--   invite_mail_at       when the state last changed
--   invite_mail_reason   a fixed machine value, never text from a provider, never an address or a code:
--                        for failed: refused | error | unconfirmed; for not_sent: no_mail_service

ALTER TABLE invites ADD COLUMN invite_id TEXT DEFAULT NULL;
ALTER TABLE invites ADD COLUMN lang TEXT DEFAULT NULL;
ALTER TABLE invites ADD COLUMN invite_mail_state TEXT DEFAULT NULL;
ALTER TABLE invites ADD COLUMN invite_mail_at INTEGER DEFAULT NULL;
ALTER TABLE invites ADD COLUMN invite_mail_reason TEXT DEFAULT NULL;

CREATE INDEX invites_mail_queue ON invites (created_at) WHERE invite_mail_state = 'queued';
CREATE UNIQUE INDEX invites_invite_id ON invites (invite_id) WHERE invite_id IS NOT NULL;

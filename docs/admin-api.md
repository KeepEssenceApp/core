# Operator (admin) interface

Not part of the contract: the contract covers clients and assistants only. These routes serve the
management portal (see `product/admin.md` in the spec repo). Every route is under `/admin/`,
needs `Authorization: Bearer <ADMIN_SECRET>` (compared in constant time), and answers 404 when
`ADMIN_SECRET` is not set. Errors use the usual body `{ "error": { "code", "message" } }`.

**No content.** No route returns a title, a body, an address or any text of an item, analysis,
daily digest or note. Only counts, times, and the names of devices and assistants.

Times are ISO 8601 UTC strings. Lists take `limit` (default 50, max 200) and an opaque `cursor`.
A `limit` above 200 is read as 200; a `limit` that is not a positive integer, or a `cursor` the
core did not hand out, answers 400.

The code is in `src/handlers/admin.ts`; the tests are in `test/admin.test.ts`.

## Overview

`GET /admin/overview`

```json
{
  "users": { "total": 0, "active_7d": 0, "suspended": 0 },
  "invites": { "total": 0, "pending": 0 },
  "items": { "today": 0, "last_7d": 0, "live": 0 },
  "analyses": { "today": 0, "last_7d": 0 },
  "digests": { "last_7d": 0 },
  "notes": { "total": 0 },
  "waiting": { "triage": 0, "analysis": 0 },
  "usage": {
    "today": { "calls": 0, "input_tokens": 0, "output_tokens": 0 },
    "last_7d": { "calls": 0, "input_tokens": 0, "output_tokens": 0 }
  },
  "cron": { "minute_ran_at": null, "hourly_ran_at": null },
  "config": { "model": "…", "model_configured": true, "mail_configured": false, "push_configured": true, "version": "…" }
}
```

"today" is the current UTC day; "last_7d" is the last 7 × 24 hours. `usage` counts the built-in
assistants only. `active_7d` is users with any device used in the last 7 days. `items.live` is
items that are not archived. `waiting` leaves out the items of suspended accounts (nobody works on
them). `cron` is when each job last finished (`null`: never since this was deployed).

`config`: `model` is `LLM_MODEL`; `model_configured` is true when `LLM_API_KEY` is set,
`mail_configured` when both `RESEND_API_KEY` and `EMAIL_FROM` are, `push_configured` when both
VAPID keys are. `version` is the variable `CORE_VERSION` when it is set, otherwise the version in
`package.json`. No secret is ever returned.

## Invitations

- `GET /admin/invites` → `{ "invites": [{ "email", "invited_at", "joined_at": null, "user_id": null }] }`,
  newest first. `joined_at` / `user_id` are set once an account exists for that email.
- `POST /admin/invites` with `{ "email": "…" }` or `{ "emails": ["…"] }` → 201
  `{ "added": ["…"], "already": ["…"], "invalid": ["…"] }`. Emails are trimmed and lower-cased.
  At most 1000 at a time. 400 only when the body names no address at all. With the single form
  and a valid address the answer also carries `"email"`, as it did before the lists were added.
- `DELETE /admin/invites` with `{ "email": "…" }` → 204. Does not touch an existing account.
- `POST /admin/login-codes` with `{ "email": "…" }` → 201 `{ "email": "…", "code": "123456", "expires_at": "…" }`;
  404 `not_invited` when the email is not on the list; 409 when the account is suspended.

## Users

- `GET /admin/users?q=&status=active|suspended&cursor=&limit=` →
  `{ "users": [UserRow], "next_cursor": null }`, newest first. `q` matches part of the email.
- `GET /admin/users/{id}` → `UserDetail`; 404 when unknown.

```json
// UserRow
{ "id": "usr_…", "email": "…", "created_at": "…", "last_active_at": null, "status": "active",
  "lang": "zh", "timezone": "…", "devices": 0, "assistants": 0, "items_live": 0, "notes": 0,
  "storage_bytes": 0 }

// UserDetail = UserRow plus
{ "suspended_at": null,
  "devices": [{ "id": "…", "name": "…", "client": "web", "tier": "manage", "created_at": "…", "last_used_at": null, "notifications": false }],
  "assistants": [{ "id": "…", "name": "…", "kind": "scheduled", "built_in": true, "steps": ["analysis"], "connected_at": null, "last_seen_at": null }],
  "days": [{ "day": "2026-11-25", "saved": 0, "analysed": 0, "digests": 0, "notes": 0 }],
  "usage": [{ "assistant_id": "…", "name": "…", "built_in": true, "calls": 0, "input_tokens": 0, "output_tokens": 0, "items": 0 }] }
```

`devices` lists client devices that are not revoked. `assistants` leaves out the hidden dispatch
assistant from the list but its usage appears in `usage`. `days` and `usage` cover the last 30 days.
In `UserRow`, `devices` and `assistants` are the counts of those same lists; `items_live` is items
that are not archived; `last_active_at` is the last time any of its devices was used. `days` is
always 30 entries, oldest first, in the user's time zone, with zeros for days without anything.
`usage` holds every assistant that handed work in, connected ones (their own figures) included.

Actions, each recorded in the audit log:

- `POST /admin/users/{id}/suspend` → 200 `UserRow`. From this moment every credential of the
  account (client devices and assistants) is refused with 401, sign-in and sign-in codes are
  refused, and the built-in assistants skip the account. Data is kept. Claims held by its
  assistants are released.
  Nothing is revoked or deleted, so restoring brings every device and assistant back as it was.
  While suspended, `POST /v1/auth/email-codes` still answers 202 and sends nothing;
  `POST /v1/auth/sessions` answers 401; `POST /oauth/token` answers 401
  `{ "error": "access_denied" }` without using up the refresh credential; signed upload and
  download addresses answer 401 and the calendar image 404. The hourly expiry of items goes on.
- `POST /admin/users/{id}/restore` → 200 `UserRow`.
- `POST /admin/users/{id}/sign-out` → 200 `{ "revoked": 3 }`. Revokes every client device.
- `DELETE /admin/users/{id}/devices/{device_id}` → 204. Revokes one client device. 404 when the
  account has no such device.
- `DELETE /admin/users/{id}` with `{ "confirm_email": "…" }` → 204; 400 when the email does not
  match. Deletes the account and all its data (rows in every table and its files in R2) and
  removes its invitation. Cannot be undone. The account is suspended first and removed last, so a
  request that was cut short can simply be sent again. Audit entries about the account stay.

Every action on an unknown `{id}` answers 404. Suspending a suspended account or restoring an
active one answers 200 and records nothing.

## Usage

`GET /admin/usage?days=30` (1–90) →

```json
{ "days": [{ "day": "…", "calls": 0, "input_tokens": 0, "output_tokens": 0, "items": 0 }],
  "top_users": [{ "user_id": "…", "email": "…", "calls": 0, "input_tokens": 0, "output_tokens": 0 }] }
```

Built-in assistants only; `top_users` holds at most 20, by total tokens. `days` is one entry per
UTC day, oldest first, ending today, with zeros for days without usage. 400 when `days` is not an
integer from 1 to 90.

## Audit log

- `GET /admin/audit?cursor=&limit=` → `{ "entries": [{ "id", "at", "action", "target", "detail", "source" }], "next_cursor": null }`, newest first.
- `POST /admin/audit` with `{ "action": "…", "target": "…", "detail": "…" }` → 201 with the entry. For
  actions the portal performs itself (signing in, inviting from the waitlist). `source` is `portal`
  for these and `core` for the ones the core records. `action` is required: lower-case letters,
  digits and `. _ : -`, at most 64 characters. `target` (at most 320) and `detail` (at most 1000)
  are optional. An entry that holds something shaped like one of the core's credentials is
  refused with 400.

Actions recorded by the core: `invite.add`, `invite.remove`, `login_code.mint`, `user.suspend`,
`user.restore`, `user.sign_out`, `user.device_revoke`, `user.delete`, `user.delete_self`. `target` is an email or a
user id; `detail` never holds a sign-in code or a credential. For the `invite.*` and
`login_code.mint` entries `target` is the email; for the `user.*` entries `target` is the user id
and `detail` starts with the account's email, so the entry still says who it was after a deletion.
`user.delete_self` is the one exception: a user deleted their own account (`DELETE /v1/account`,
through the same deletion as the operator's), and the entry holds the user id and an empty `detail`.
Only actions that changed something are recorded.

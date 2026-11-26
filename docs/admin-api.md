# Operator (admin) interface

Not part of the contract: the contract covers clients and assistants only. These routes serve the
management portal (see `product/admin.md` in the spec repo). Every route is under `/admin/`,
needs `Authorization: Bearer <ADMIN_SECRET>` (compared in constant time), and answers 404 when
`ADMIN_SECRET` is not set. Errors use the usual body `{ "error": { "code", "message" } }`.

**No content.** No route returns a title, a body, an address or any text of an item, analysis,
daily digest or note. Only counts, times, and the names of devices and assistants. The one list
that holds words a user typed is feedback, which the user addressed to the operator.

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

## Reading saved links

How the content of a saved link is read. The ways are tried in `order`; the first that brings back
real content (at least 60 characters of text) is used. `direct` is the core fetching the page
itself and cannot be turned off. `jina` (Jina Reader, or a self-hosted reader with the same
interface) and `firecrawl` (Firecrawl, or a self-hosted one) are off until turned on here; turning
one on sends the address of every link a user saves to that service. A page that is only a shell
keeps its title and is marked "content could not be fetched", so its few words are never analysed.

What `direct` does (rules in `src/services/pagerules.ts`; nothing is sent to anyone but the address
the user saved):

- It asks as a desktop browser, then as an iPhone; the apps that want a phone (Xiaohongshu, Douyin,
  Bilibili, Weibo, Zhihu, Kuaishou and their short-link hosts, matched on the domain, not as a
  substring of the address) get the iPhone first. The request carries `Accept-Language: zh-CN,zh;q=0.9,en;q=0.8`.
  The first answer that is not a refusal or a verification wall ends it, so an ordinary page costs one
  request; at most two User-Agents are tried, under the one 8-second deadline, and the address is checked
  before each attempt and on every redirect (at most 3 per attempt).
- A refusal (status 401, 403, 406, 429, 503) or a wall (a verification wall's words in the title,
  the description, the first lines or, for a short page, the first markup) goes on to the next
  User-Agent. When all of them were walls the page is "blocked": it has no title and no text, and
  the item keeps the title it had. A test read from this page says so.
- A page that is only a shell is "thin": less than 60 characters of text; a WeChat article without
  its body (under 200 characters); or a column of buttons and menu lines. Its title is kept when it
  names the page, and its words are not content. One exception to the 60 characters: on a site of
  short posts (Xiaohongshu, Weibo, Douyin, Bilibili, X, Instagram ...) a description of 40 characters or
  more is the post, and is what is stored as its text.
- A title is not used when it is an address, a wall's, a login, error or verification page's, or only the
  site's name. A title the client sent is always kept; a page title that is only a small piece (under
  half, contained in it) of the title the item already has does not replace it.

- `GET /admin/fetch` →

```json
{ "order": ["direct", "jina", "firecrawl"],
  "jina": { "enabled": false, "endpoint": "", "key_set": false, "key_hint": "" },
  "firecrawl": { "enabled": false, "endpoint": "", "key_set": false, "key_hint": "" },
  "tests": { "direct": null, "jina": null, "firecrawl": { "at": "…", "url_host": "…", "ok": false, "chars": 0, "ms": 0, "error": "…" } },
  "stats": { "days": 7, "rows": [{ "platform": "wechat", "path": "none", "n": 3 }] } }
```

- `PUT /admin/fetch` with any of `order` (all three ways, each once), `jina`, `firecrawl`
  (`enabled`, `endpoint`, `key`) → 200 with the same body as the GET. An `endpoint` is empty (the
  public service) or an `https://` address without credentials or a query. A `key` is write-only:
  send it to set it, `""` to remove it, leave it out to keep it. It is never returned (only
  `key_set` and its last four characters) and never written to the audit log. Changes apply to the
  next link that is read; nothing is redeployed. Recorded as `fetch.settings`.
- `POST /admin/fetch/test` with `{ "provider": "direct|jina|firecrawl", "url": "https://…" }` →
  200 `{ "provider", "ok", "chars", "ms", "error", "title" }`. Reads the address once with that
  way, on or off. Only how it went is kept (in `tests`), never what was read. 400 for an address
  that is not public.

`stats` are counts over the last 7 days by `platform` (`wechat`, `xiaohongshu`, `other`: a short
fixed list, never an address) and by the way that read it (`none`: no way could). Videos are counted
apart, in the same rows: `video` when the words of a video were recognized, `video_failed` when they
were not (no speech, too long, not to be had, the runner did not know the job, or the wait ran out).
The way that read the page (`jina`, …) is counted as before, so one saved video post is in two rows.
The settings, keys included, are stored in D1 (`core_state`, key `fetch.settings`).

### Videos (#103)

The words of a video are read by the runner, in the `jina` slot (the other ways never see a video:
the direct read and Firecrawl cannot answer 202). So that a video post reaches the runner, put `jina`
before `direct` in `order`: a page that the direct read gets in full is not asked of the runner
again, and its video is not read.

What the core asks of the reader service, at the address and with the key of the `jina` slot:

- `GET {endpoint}/{address}` as for any page. `202 { data: { title, url, content }, video: { state: "reading", job, seconds } }`:
  a video is being read; `content` is the author's own text and may be empty. `200` with
  `video: { state: "too_long" | "unavailable", seconds }`: the video will not be read. No `video`: as before.
  A `job` is letters, digits, `-` and `_`, 100 characters at most; anything else is an error of that way.
- `GET {endpoint}/jobs/{job}`: `{ state: "reading" }`, `{ state: "done", video_state: "recognized", recognized_text }`,
  `{ state: "done", video_state: "no_speech" | "too_long" | "unavailable" }`, or 404 (the job is unknown, expired, or
  the runner restarted). Any other answer, an error, or no answer at all is asked again next minute.
- `DELETE {endpoint}/jobs/{job}`: the job is no longer wanted. Best effort, one try.

How an item waits. A post whose video is being read is saved as it is (title, the author's text as
`body`, `video_state: "reading"`) with `fetch_state = 'video_wait'` and `fetch_deadline` = now +
`limits.video_wait_minutes`. It is shown and counted as waiting, but it is not triaged (by the sorting
step or by the core's default after 10 minutes) and not analysed, and the minute job does not read its
page again (that is only for `pending`). Once per minute the core asks about the oldest 5 waiting
items (live ones only), all at once, each with one request of at most 8 seconds. The runner is meant to
hold one job at a time and four queued, and to refuse the rest (the core then gets `unavailable`), so
there are not more than five to ask about.

How it ends, once and for good (every write names the item, its owner, and the job it still holds, so a
repeated answer, a late one, or a job offered for another item or user changes nothing):

- `recognized`: `recognized_text` (30000 characters at most), `video_state: "recognized"`. An answer with no
  words in it is `no_speech`; nothing is stored, and no word is made up.
- `no_speech`, `too_long`, `unavailable`: `video_state` says so; the author's text stays.
- 404, or `fetch_deadline` passed (including a runner that did not answer all the while): `unavailable`.

The item then has content when it has the words, or an author's text of at least 60 characters (the
same length rule as for a reader service's page): `fetch_state = 'done'`, `content_unavailable = 0`, and
the analysis follows. With neither it is `failed` and `content_unavailable = 1`, "content could not be
fetched". The core then sends `DELETE` for the job. The core's default triage counts its 10 minutes from
the moment the item stopped waiting (`video_done_at`), so the sorting step still has its turn.

Deleting the item, or its expiry, while it waits: a deleted item is cancelled at once by the request
that deletes it; an archived one (expired, or deleted with the copy kept) by the minute job, 5 a run. No
late result is written to it. Deleting the account removes the rows and tells no one: the runner forgets
a job by its own deadline. A test read of a video address in the portal cancels the job it started.

## Feedback

`GET /admin/feedback?cursor=&limit=` →

```json
{ "forwarding": null,
  "feedback": [{ "id": "fb_…", "at": "…", "user_id": "usr_…", "email": "…", "client": "web", "where": "web",
                 "doing": "", "wrong": "…", "wish": "", "issue_url": null, "forward_error": null }],
  "next_cursor": null }
```

What users sent with `POST /v1/feedback`, newest first. `forwarding` is the repository
(`owner/name`) each entry is also filed in as an issue, or `null` when `FEEDBACK_GITHUB_REPO` and
`FEEDBACK_GITHUB_TOKEN` are not both set. `issue_url` is the issue once it exists; until then
`forward_error` says why the last attempt failed. An entry is tried when it arrives and then by the
minute job, five times at most. The issue carries the sender's email, so the repository should be
private. Deleting an account deletes its feedback here; an issue already filed stays where it is.
`config.feedback_forwarding` in the overview says whether forwarding is on.

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

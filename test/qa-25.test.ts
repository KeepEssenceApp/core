// Internal QA #25: the account's owner can take their data with them (GET /v1/export) and can
// delete the account (DELETE /v1/account), both for the manage tier only.
import { describe, expect, it } from "vitest";
import { advance, HOUR, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";
import {
  ADMIN,
  builtinModel,
  call,
  connectAssistant,
  connectDevice,
  db,
  fillEmptyTables,
  filledUser,
  idem,
  LLM,
  loginCode,
  makeEnv,
  MARKER,
  PNG,
  refresh,
  rpc,
  saveImage,
  saveText,
  signIn,
  tablesWithUserId,
} from "./helpers";

const builtinEnv = () => makeEnv({ ...LLM, OUTBOUND: builtinModel() });
const OTHER = "PURPLEHERON";

describe("QA #25 export", () => {
  it("QA #25: the export holds the account's settings, daily digests, notes with sources and origin, and the items that exist with analyses and tags", async () => {
    const env = builtinEnv();
    const { user: ann, itemIds } = await filledUser(env, "ann@example.com");
    const assetId = await saveImage(env, ann.token, PNG([1, 2, 3]));
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { rules: "Long reads are kept 90 days.", expiry_options: [7, 90] } });
    await call(env, "PUT", `/v1/items/${itemIds[1]}/pin`, { token: ann.token });
    const helper = await connectAssistant(env, ann, { name: "Helper", kind: "chat", steps: ["deep_dive"] });
    const written = await rpc(env, helper.access, "tools/call", {
      name: "save_note",
      arguments: { title: "Tea, in short", body: "Cooler water.", item_id: itemIds[0], sources: [{ title: "A tea page", url: "https://tea.example/green" }], idempotency_key: idem() },
    });
    expect(written.json.result.isError).toBe(false);

    const r = await call(env, "GET", "/v1/export", { token: ann.token });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="export-2026-11-24.json"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    const doc = r.json;
    expect(Object.keys(doc)).toEqual(["version", "exported_at", "contents", "account", "settings", "digests", "notes", "items", "files"]);
    expect(doc.version).toBe(1);
    expect(doc.account).toEqual({ id: ann.userId, email: "ann@example.com", created_at: "2026-11-24T04:00:00.000Z" });

    // Settings, with the assistants named.
    expect(doc.settings.rules).toBe("Long reads are kept 90 days.");
    expect(doc.settings.expiry_options).toEqual([7, 90]);
    expect(doc.settings.timezone).toBe("Asia/Shanghai");
    expect(doc.settings.lang).toBe("en");
    expect(doc.settings.roles.analysis.name).toBe("Built-in assistant");
    expect(doc.settings.roles.deep_read).toBeNull();

    // The daily digest of the day, as it was handed in.
    expect(doc.digests).toHaveLength(1);
    const digest = doc.digests[0];
    expect(digest.day).toBe("2026-11-24");
    expect(digest.read).toBe(false);
    expect(digest.summary).toBe("You saved 2 things today.");
    expect(digest.question).toBe("What would you brew tomorrow?");
    expect(digest.entries.map((e: any) => e.item_id).sort()).toEqual([...itemIds].sort());
    expect(digest.worth).toHaveLength(2);
    expect(digest.assistant.name).toBe("Built-in assistant");

    // Notes, oldest first, each with its sources and where it came from.
    expect(doc.notes.map((n: any) => n.title)).toEqual([`${MARKER} note`, "Tea, in short"]);
    expect(doc.notes[0].body).toBe(`What I learnt: ${MARKER}.`);
    expect(doc.notes[0].origin).toMatchObject({ item_id: itemIds[0], item_title: `${MARKER} tea`, digest_day: "2026-11-24" });
    expect(doc.notes[0].assistant.submitted_by_user).toBe(true);
    expect(doc.notes[1].sources).toEqual([{ title: "A tea page", url: "https://tea.example/green" }]);
    expect(doc.notes[1].assistant.name).toBe("Helper");

    // Items that exist: the text, the analysis, the tags, how long they are kept.
    expect(doc.items).toHaveLength(3);
    const tea = doc.items.find((i: any) => i.id === itemIds[0]);
    expect(tea.title).toBe(`${MARKER} tea`);
    expect(tea.body).toBe(`${MARKER} green tea wants cooler water.`);
    expect(tea.stage).toBe("analysed");
    expect(tea.analysis).toMatchObject({ unavailable: false, verdict: "worth_deep_dive", points: ["First point.", "Second point."] });
    expect(tea.analysis.assistant.name).toBe("Built-in assistant");
    expect(tea.tags).toContain("source:web");
    expect(tea.tags).toContain("assistant:Built-in assistant");
    expect(tea.expires_at).toMatch(/^2026-12-/);
    expect(tea.file).toBeNull();
    const kept = doc.items.find((i: any) => i.id === itemIds[1]);
    expect(kept.pinned).toBe(true);
    expect(kept.expires_at).toBeNull();
    expect(kept.tags.some((t: string) => t.startsWith("expiry:"))).toBe(false);
    // The same view of an item as GET /v1/items/{id} gives, plus its file.
    const { file, ...asExported } = tea;
    expect(asExported).toEqual((await call(env, "GET", `/v1/items/${tea.id}`, { token: ann.token })).json);

    // Files: named, typed, sized; never their bytes; and the document says how to get them.
    const picture = doc.items.find((i: any) => i.kind === "image");
    expect(picture.file).toEqual({ id: assetId, name: "Image", type: "image/png", size: 11 });
    expect(doc.files).toEqual([{ id: assetId, name: "Image", type: "image/png", size: 11 }]);
    expect(doc.contents.files).toContain("downloaded separately");
    expect(doc.contents.files).toContain("GET /v1/assets/{id}");
    expect(doc.contents.included.length).toBeGreaterThanOrEqual(4);
    expect(doc.contents.not_included.join(" ")).toContain("contents of files");
    // No credential and no hash of one anywhere in the document.
    expect(r.text).not.toContain(ann.token);
    expect(r.text).not.toMatch(/credential_hash|code_hash|r2_key|sha256|"u\//);
    for (const row of await db(env, "SELECT credential_hash AS h FROM devices WHERE user_id = ?", ann.userId)) expect(r.text).not.toContain(row.h);
  });

  it("QA #25: the export holds nothing of another user and no item that was deleted or whose time ran out", async () => {
    const env = builtinEnv();
    const { user: ann, itemIds } = await filledUser(env, "ann@example.com");
    const bob = await signIn(env, "bob@example.com");
    await saveText(env, bob.token, `${OTHER} is Bob's.`, `${OTHER} title`);
    await call(env, "POST", "/v1/notes", { token: bob.token, body: { title: `${OTHER} note`, body: `${OTHER} body` }, idem: idem() });
    await saveImage(env, bob.token, PNG([9, 9, 9]));
    await runMinute(env);
    await call(env, "PATCH", "/v1/settings", { token: bob.token, body: { rules: `${OTHER} rules` } });

    // Ann deletes one item herself; another one's time runs out (the core keeps its row, marked, for a while).
    const gone = await saveText(env, ann.token, "GONEFOX is deleted by the user.", "GONEFOX");
    const lapsed = await saveText(env, ann.token, "LAPSEDOWL ran out of time.", "LAPSEDOWL");
    const lapsedFile = await saveImage(env, ann.token, PNG([4, 4, 4]));
    expect((await call(env, "DELETE", `/v1/items/${gone}`, { token: ann.token })).status).toBe(204);
    await db(env, "UPDATE items SET archived_at = ? WHERE user_id = ? AND (id = ? OR asset_id = ?)", Date.now(), ann.userId, lapsed, lapsedFile);
    await db(env, "UPDATE assets SET refs = 0 WHERE user_id = ? AND id = ?", ann.userId, lapsedFile);
    expect((await db(env, "SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND archived_at IS NOT NULL", ann.userId))[0].n).toBe(2);

    const r = await call(env, "GET", "/v1/export", { token: ann.token });
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: any) => i.id).sort()).toEqual([...itemIds].sort());
    expect(r.json.files).toEqual([]);
    expect(r.text).not.toContain("GONEFOX");
    expect(r.text).not.toContain("LAPSEDOWL");
    expect(r.text).not.toContain(OTHER);
    expect(r.text).not.toContain("bob@example.com");
    expect(r.text).not.toContain(bob.userId);
    expect(r.text).toContain(MARKER);

    // And the other way round.
    const b = await call(env, "GET", "/v1/export", { token: bob.token });
    expect(b.json.account.email).toBe("bob@example.com");
    expect(b.json.items).toHaveLength(2);
    expect(b.json.notes).toHaveLength(1);
    expect(b.json.files).toHaveLength(1);
    expect(b.json.settings.rules).toBe(`${OTHER} rules`);
    expect(b.text).not.toContain(MARKER);
    expect(b.text).not.toContain(ann.userId);
  });

  it("QA #25: a large account is exported whole, page by page, as one valid document; an empty one has empty lists", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const empty = await call(env, "GET", "/v1/export", { token: ann.token });
    expect(empty.json).toMatchObject({ digests: [], notes: [], items: [], files: [] });

    // More rows than one page of each list (40 items, 100 of the others), some with the same moment of creation.
    const t = Date.now();
    await db(
      env,
      `INSERT INTO items (id, user_id, kind, title, body, source, expires_at, hard_expires_at, created_at)
       SELECT 'itm_bulk' || key, ?1, 'text', 'Bulk ' || key, 'Text ' || key, 'web', ?2, ?2, ?3 + (key / 3) FROM json_each(?4)`,
      ann.userId,
      t + 86400000,
      t,
      JSON.stringify(Array.from({ length: 205 }, () => 0)),
    );
    await db(env, "INSERT INTO item_tags (item_id, user_id, kind, value, set_by) SELECT id, user_id, 'source', 'web', 'core' FROM items WHERE user_id = ?", ann.userId);
    await db(
      env,
      "INSERT INTO notes (id, user_id, title, body, created_at) SELECT 'note_bulk' || key, ?1, 'Note ' || key, 'Body', ?2 + (key / 4) FROM json_each(?3)",
      ann.userId,
      t,
      JSON.stringify(Array.from({ length: 230 }, () => 0)),
    );
    await db(
      env,
      "INSERT INTO digests (user_id, day, status, summary, question, worth, entries) SELECT ?1, date('2025-01-01', '+' || key || ' days'), 'done', 'S', 'Q', '[]', '[]' FROM json_each(?2)",
      ann.userId,
      JSON.stringify(Array.from({ length: 120 }, () => 0)),
    );
    await db(
      env,
      "INSERT INTO assets (id, user_id, sha256, r2_key, bytes, content_type, refs, status, created_at) SELECT 'ast_bulk' || key, ?1, printf('%064d', key), 'k', 10, 'application/pdf', 1, 'stored', ?2 FROM json_each(?3)",
      ann.userId,
      t,
      JSON.stringify(Array.from({ length: 130 }, () => 0)),
    );
    const r = await call(env, "GET", "/v1/export", { token: ann.token });
    expect(r.status).toBe(200);
    const ids = (list: any[], key = "id") => new Set(list.map((x) => x[key]));
    expect(r.json.items).toHaveLength(205);
    expect(ids(r.json.items).size).toBe(205);
    expect(r.json.items.every((i: any) => i.tags.length === 1 && i.tags[0] === "source:web")).toBe(true);
    expect(r.json.notes).toHaveLength(230);
    expect(ids(r.json.notes).size).toBe(230);
    expect(r.json.digests).toHaveLength(120);
    expect(ids(r.json.digests, "day").size).toBe(120);
    expect(r.json.files).toHaveLength(130);
    expect(r.json.files[0]).toEqual({ id: "ast_bulk0", name: "ast_bulk0.pdf", type: "application/pdf", size: 10 });
    // Oldest first.
    const days = r.json.digests.map((d: any) => d.day);
    expect(days).toEqual([...days].sort());
  });

  it("QA #25: a device with the read tier gets 403 on the export and on deleting the account; without a credential both are 401", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    const saver = await connectDevice(env, ann, "save");
    for (const token of [reader.token, saver.token]) {
      const ex = await call(env, "GET", "/v1/export", { token });
      expect(`${ex.status} ${ex.json.error.code}`).toBe("403 forbidden");
      const del = await call(env, "DELETE", "/v1/account", { token, body: { confirm_email: ann.email } });
      expect(`${del.status} ${del.json.error.code}`).toBe("403 forbidden");
    }
    expect((await call(env, "GET", "/v1/export")).status).toBe(401);
    expect((await call(env, "DELETE", "/v1/account", { body: { confirm_email: ann.email } })).status).toBe(401);
    // Nothing happened to the account.
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(200);
    expect((await call(env, "GET", "/admin/audit", { token: ADMIN })).json.entries.some((e: any) => e.action.startsWith("user.delete"))).toBe(false);
  });

  it("QA #25: the settings give the account's email to the manage tier only", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    expect((await call(env, "GET", "/v1/settings", { token: ann.token })).json.email).toBe("ann@example.com");
    expect((await call(env, "GET", "/v1/settings", { token: reader.token })).json.email).toBeUndefined();
  });
});

describe("QA #25 deleting the account", () => {
  it("QA #25: deleting needs the account's own email; a wrong one, an empty one or none is 400 and deletes nothing", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    await signIn(env, "bob@example.com");
    await saveText(env, ann.token, "Still here.");
    for (const body of [{ confirm_email: "bob@example.com" }, { confirm_email: "" }, { confirm_email: "ann@example.co" }, {}, { confirm_email: 7 }, { confirm_email: ann.email, extra: true }]) {
      const refused = await call(env, "DELETE", "/v1/account", { token: ann.token, body });
      expect(`${JSON.stringify(body)} ${refused.status} ${refused.json.error.code}`).toBe(`${JSON.stringify(body)} 400 bad_request`);
    }
    expect((await call(env, "DELETE", "/v1/account", { token: ann.token })).status).toBe(400);
    expect((await call(env, "GET", "/v1/items?state=today", { token: ann.token })).json.items).toHaveLength(1);
    expect(await db(env, "SELECT suspended_at FROM users WHERE id = ?", ann.userId)).toEqual([{ suspended_at: null }]);
    expect((await call(env, "GET", "/admin/audit", { token: ADMIN })).json.entries.some((e: any) => e.action.startsWith("user.delete"))).toBe(false);
  });

  it("QA #25: nothing with that user_id is left in any table, its files and its invitation are gone, and other accounts are untouched", async () => {
    const env = builtinEnv();
    const { user: ann } = await filledUser(env, "ann@example.com");
    await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps: ["analysis"] });
    await connectDevice(env, ann, "read");
    await saveImage(env, ann.token, PNG([1, 2, 3]));
    await saveImage(env, ann.token, PNG([4, 5, 6]));
    await loginCode(env, ann.email);
    const bob = await signIn(env, "bob@example.com");
    await saveText(env, bob.token, "Bob keeps this.");
    await saveImage(env, bob.token, PNG([9, 9, 9]));

    const tables = await tablesWithUserId(env);
    await fillEmptyTables(env, tables, ann.userId);
    await fillEmptyTables(env, tables, bob.userId);
    await db(env, "INSERT INTO daily_caps (user_id, day, kind, n) SELECT ?, '2026-01-01', 'bulk-' || key, 1 FROM json_each(?)", ann.userId, JSON.stringify(Array.from({ length: 1234 }, () => 0)));
    const count = async (table: string, userId: string) => (await db(env, `SELECT COUNT(*) AS n FROM "${table}" WHERE user_id = ?`, userId))[0].n as number;
    const before: Record<string, number> = {};
    for (const table of tables) {
      expect(await count(table, ann.userId), `${table} has a row of the user before`).toBeGreaterThan(0);
      before[table] = await count(table, bob.userId);
      expect(before[table], `${table} has a row of the other user`).toBeGreaterThan(0);
    }
    expect((await env.FILES.list({ prefix: `u/${ann.userId}/` })).objects).toHaveLength(2);

    // The email is compared without regard to case or surrounding spaces, as the operator's is.
    const r = await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: " Ann@Example.com " } });
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    for (const table of tables) {
      expect(await count(table, ann.userId), `${table} holds nothing of the user after`).toBe(0);
      expect(await count(table, bob.userId), `${table} still holds the other user's rows`).toBe(before[table]);
    }
    expect(await db(env, "SELECT id FROM users WHERE id = ? OR email = ?", ann.userId, ann.email)).toEqual([]);
    expect(await db(env, "SELECT email FROM invites WHERE email = ?", ann.email)).toEqual([]);
    expect(await db(env, "SELECT email FROM login_codes WHERE email = ?", ann.email)).toEqual([]);
    expect((await env.FILES.list({ prefix: `u/${ann.userId}/` })).objects).toEqual([]);
    expect((await env.FILES.list({ prefix: `u/${bob.userId}/` })).objects).toHaveLength(1);
    expect(await db(env, "SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?", MARKER)).toEqual([]);
    // Gone for the operator too, and the other account works as before.
    expect((await call(env, "GET", `/admin/users/${ann.userId}`, { token: ADMIN })).status).toBe(404);
    expect((await call(env, "GET", "/admin/users", { token: ADMIN })).json.users.map((u: any) => u.id)).toEqual([bob.userId]);
    expect((await call(env, "GET", "/v1/items?state=today", { token: bob.token })).json.items).toHaveLength(2);
  });

  it("QA #25: every credential of the account stops working at once — this device, other devices, assistants and their renewal", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    const reader = await connectDevice(env, ann, "read");
    const saver = await connectDevice(env, ann, "save");
    const helper = await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps: ["analysis"] });
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { calendar_image_enabled: true } });
    const calendar = (await call(env, "GET", "/v1/settings", { token: ann.token })).json.calendar_image.url as string;
    expect((await call(env, "GET", calendar)).status).toBe(200);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(200);

    expect((await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: ann.email } })).status).toBe(204);

    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(401);
    expect((await call(env, "GET", "/v1/items?state=today", { token: reader.token })).status).toBe(401);
    expect((await call(env, "POST", "/v1/items", { token: saver.token, body: { kind: "text", text: "Late." }, idem: idem() })).status).toBe(401);
    expect((await call(env, "GET", "/v1/export", { token: ann.token })).status).toBe(401);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(401);
    expect((await rpc(env, helper.access, "tools/list")).status).toBe(401);
    await expect(refresh(env, helper)).rejects.toThrow(/refresh failed/);
    expect((await call(env, "GET", calendar)).status).toBe(404);
    // Sending it again changes nothing: there is no such account any more.
    expect((await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: ann.email } })).status).toBe(401);
  });

  it("QA #25: the audit log records user.delete_self with the user id and nothing else", async () => {
    const env = builtinEnv();
    const { user: ann } = await filledUser(env, "ann@example.com");
    expect((await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: ann.email } })).status).toBe(204);
    const log = (await call(env, "GET", "/admin/audit", { token: ADMIN })).json.entries;
    expect(log[0]).toMatchObject({ action: "user.delete_self", target: ann.userId, detail: "", source: "core" });
    expect(log.filter((e: any) => e.action.startsWith("user.delete"))).toHaveLength(1);
    // No content and no email of the deleted account in the entry.
    expect(JSON.stringify(log[0])).not.toContain(MARKER);
    expect(JSON.stringify(log[0])).not.toContain("ann@example.com");
    // The operator's own deletion is still recorded as before, with the email.
    const bob = await signIn(env, "bob@example.com");
    await call(env, "DELETE", `/admin/users/${bob.userId}`, { token: ADMIN, body: { confirm_email: bob.email } });
    expect((await call(env, "GET", "/admin/audit", { token: ADMIN })).json.entries[0]).toMatchObject({ action: "user.delete", target: bob.userId, detail: "bob@example.com" });
  });

  it("QA #25: a deleted email is not invited any more, and can be invited again and join as a new, empty account", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    await saveText(env, ann.token, "Old.");
    expect((await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: ann.email } })).status).toBe(204);
    // Not on the list: asking for a code sends nothing, and the operator cannot mint one.
    expect((await call(env, "POST", "/admin/login-codes", { token: ADMIN, body: { email: ann.email } })).status).toBe(404);
    advance(HOUR + MINUTE);
    const again = await signIn(env, ann.email); // invites, then signs in
    expect(again.userId).not.toBe(ann.userId);
    expect((await call(env, "GET", "/v1/items?state=today", { token: again.token })).json.items).toEqual([]);
    expect((await call(env, "GET", "/v1/export", { token: again.token })).json).toMatchObject({ items: [], notes: [], digests: [] });
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(401);
  });
});

import { describe, expect, it } from "vitest";
import { advance, DAY, MINUTE } from "../src/clock";
import { runHourly, runMinute } from "../src/cron";
import { analysed, analysis, builtinModel, call, claim, connectAssistant, connectDevice, coreTriage, db, HOUR_MS, idem, leap, LLM, makeEnv, refresh, saveText, signIn, submit, withHelper } from "./helpers";

const get = async (env: any, token: string, path: string) => (await call(env, "GET", path, { token })).json;

/** Ann, her helper, some analysed items and the day's digest written by the helper. */
async function withDigest(env: any, texts: string[]) {
  const { ann, helper } = await withHelper(env);
  const ids = await analysed(env, ann, helper, texts);
  advance(9 * HOUR_MS); // 21:10
  await refresh(env, helper);
  const c = await claim(env, helper.access, "digest");
  await submit(env, helper.access, c.claim_id, [{ kind: "digest", day: "2026-11-24", summary: "A day about tea.", question: "Why tea?", worth: ids.map((id) => ({ item_id: id, line: `Line for ${id}` })) }]);
  return { ann, helper, ids };
}

describe("K13 user actions", () => {
  it("K13 actions: pin keeps an item without expiry; unpin gives it a term again", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    const id = await saveText(env, ann.token, "Keep me.");
    expect((await call(env, "PUT", `/v1/items/${id}/pin`, { token: reader.token })).status).toBe(204);
    expect(await get(env, ann.token, `/v1/items/${id}`)).toMatchObject({ pinned: true, days_left: null, expiry_days: null });
    expect((await get(env, ann.token, "/v1/items?state=pinned")).items.map((i: any) => i.id)).toEqual([id]);
    await leap(env, ann, 400 * DAY);
    await runHourly(env);
    expect((await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).status).toBe(200);
    expect((await call(env, "DELETE", `/v1/items/${id}/pin`, { token: ann.token })).status).toBe(204);
    expect(await get(env, ann.token, `/v1/items/${id}`)).toMatchObject({ pinned: false, days_left: 30 });
    expect((await get(env, ann.token, "/v1/items?state=pinned")).items).toEqual([]);
  });

  it("K13 actions: not interested and seen move a digest line to the rest; restoring brings it back", async () => {
    const env = makeEnv();
    const { ann, ids } = await withDigest(env, ["First thought.", "Second thought.", "Third thought."]);
    const [a, b, c] = ids;
    let d = await get(env, ann.token, "/v1/digests/latest");
    expect(d.worth).toHaveLength(3);
    expect(d.rest).toEqual([]);
    await call(env, "PUT", `/v1/items/${a}/signal`, { token: ann.token, body: { signal: "not_interested" } });
    await call(env, "PUT", `/v1/items/${b}/signal`, { token: ann.token, body: { signal: "seen" } });
    d = await get(env, ann.token, "/v1/digests/latest");
    expect(d.worth.map((w: any) => w.item_id)).toEqual([c]);
    expect(d.counts).toEqual({ saved: 3, worth: 1 });
    const rest = Object.fromEntries(d.rest.map((r: any) => [r.item_id, r]));
    expect(rest[a]).toMatchObject({ signal: "not_interested", can_restore: true, available: true });
    expect(rest[b]).toMatchObject({ signal: "seen", can_restore: true });
    expect((await get(env, ann.token, `/v1/items/${a}`)).signal).toBe("not_interested");
    // Restore.
    expect((await call(env, "DELETE", `/v1/items/${a}/signal`, { token: ann.token })).status).toBe(204);
    d = await get(env, ann.token, "/v1/digests/latest");
    expect(d.worth.map((w: any) => w.item_id).sort()).toEqual([a, c].sort());
    expect((await call(env, "PUT", `/v1/items/${a}/signal`, { token: ann.token, body: { signal: "liked" } })).status).toBe(400);
  });

  it("K13 actions: adding to the deep-read queue moves the line to the rest; taking it out brings it back", async () => {
    const env = makeEnv();
    const { ann, ids } = await withDigest(env, ["First thought.", "Second thought."]);
    const added = await call(env, "PUT", `/v1/deep-read-queue/${ids[0]}`, { token: ann.token });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ item_id: ids[0], title: "First thought.", deep_read: "waiting", report: null, went_at: null, went_to: null, fetched_at: null });
    let d = await get(env, ann.token, "/v1/digests/latest");
    expect(d.worth.map((w: any) => w.item_id)).toEqual([ids[1]]);
    expect(d.rest[0]).toMatchObject({ item_id: ids[0], in_queue: true, can_restore: true });
    expect((await get(env, ann.token, `/v1/items/${ids[0]}`)).in_queue).toBe(true);
    expect((await get(env, ann.token, "/v1/deep-read-queue")).entries).toHaveLength(1);
    expect((await call(env, "DELETE", `/v1/deep-read-queue/${ids[0]}`, { token: ann.token })).status).toBe(204);
    d = await get(env, ann.token, "/v1/digests/latest");
    expect(d.worth).toHaveLength(2);
    expect((await get(env, ann.token, "/v1/deep-read-queue")).entries).toEqual([]);
  });

  it("K13 actions: going to deep dive returns the opening line, which carries the title and no content", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "The body of the thought stays in the core.", "Tea and water");
    const none = await call(env, "POST", "/v1/deep-dive-requests", { token: ann.token, body: { item_id: id } });
    expect(none.status).toBe(409);
    const chat = await connectAssistant(env, ann, { name: "Talker", kind: "chat", scope: "deep_dive" });
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { roles: { deep_dive: chat.assistantId } } });
    const r = await call(env, "POST", "/v1/deep-dive-requests", { token: ann.token, body: { item_id: id } });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ assistant: { id: chat.assistantId, name: "Talker" }, opening_line: "Deep dive into this item: Tea and water", open_url: null, entry: null });
    expect(r.text).not.toContain("stays in the core");
    const zh = await call(env, "POST", "/v1/deep-dive-requests", { token: ann.token, body: { item_id: id, assistant_id: chat.assistantId }, headers: { "accept-language": "zh" } });
    expect(zh.json.opening_line).toBe("Deep dive into this item: Tea and water"); // the line follows the user's language setting
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "zh" } });
    expect((await call(env, "POST", "/v1/deep-dive-requests", { token: ann.token, body: { item_id: id } })).json.opening_line).toBe("深挖这一条：Tea and water");
  });

  it("K13 actions: pasting the result back makes a note signed by the assistant, marked as handed in by the user, and the item leaves the queue", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const chat = await connectAssistant(env, ann, { name: "Talker", kind: "chat", scope: "deep_dive" });
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { roles: { deep_dive: chat.assistantId } } });
    const id = await saveText(env, ann.token, "A thought to dig into.", "Tea and water");
    await call(env, "PUT", `/v1/deep-read-queue/${id}`, { token: ann.token });
    await call(env, "POST", "/v1/deep-dive-requests", { token: ann.token, body: { item_id: id } });
    const went = (await get(env, ann.token, "/v1/deep-read-queue")).entries[0];
    expect(went.went_at).not.toBeNull();
    expect(went.went_to).toEqual({ id: chat.assistantId, name: "Talker" });
    const key = idem();
    const body = { title: "What I learnt about tea", body: "Cooler water. Shorter steeping.", item_id: id };
    const note = await call(env, "POST", "/v1/notes", { token: ann.token, body, idem: key });
    expect(note.status).toBe(201);
    expect(note.json).toMatchObject({ title: "What I learnt about tea", assistant: { id: chat.assistantId, name: "Talker", submitted_by_user: true }, origin: { item_id: id, item_title: "Tea and water" } });
    expect((await call(env, "POST", "/v1/notes", { token: ann.token, body, idem: key })).json.id).toBe(note.json.id);
    expect((await get(env, ann.token, "/v1/notes")).notes).toHaveLength(1);
    expect((await get(env, ann.token, "/v1/deep-read-queue")).entries).toEqual([]);
    expect((await call(env, "POST", "/v1/notes", { token: ann.token, body })).json.error.code).toBe("idempotency_key_required");
  });
});

describe("K14 deep read", () => {
  it("K14 deep read: a scheduled assistant claims a queued item and hands back a report; the states are waiting, reading, ready", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const [id] = await analysed(env, ann, helper, ["A long text worth reading closely."]);
    await call(env, "PUT", `/v1/deep-read-queue/${id}`, { token: ann.token });
    const state = async () => (await get(env, ann.token, "/v1/deep-read-queue")).entries[0];
    expect((await state()).deep_read).toBe("waiting");
    expect((await get(env, helper.access, "/v1/assistant/work")).work).toEqual([expect.objectContaining({ kind: "deep_read", count: 1 })]);
    const c = await claim(env, helper.access, "deep_read");
    expect(c.work).toEqual([{ ref: id, title: "A long text worth reading closely." }]);
    expect((await state()).deep_read).toBe("reading");
    const ctx = await get(env, helper.access, `/v1/assistant/items/${id}/context?for=deep_read`);
    expect(ctx.item.body).toBe("A long text worth reading closely.");
    expect(ctx.analysis.verdict).toBe("worth_deep_dive");
    expect((await state()).fetched_at).not.toBeNull();
    const report = { kind: "deep_read", item_id: id, read: "It says water matters.", found: "Two other sources agree.", questions: ["Which water?"], entry: "https://assistant.example/chat/42" };
    expect((await submit(env, helper.access, c.claim_id, [{ ...report, verdict: "x" }])).json.error.code).toBe("invalid_result");
    expect((await submit(env, helper.access, c.claim_id, [{ ...report, questions: Array(9).fill("q") }])).status).toBe(400);
    expect((await submit(env, helper.access, c.claim_id, [report])).json.outcomes).toEqual([{ ref: id, accepted: true }]);
    const ready = await state();
    expect(ready).toMatchObject({ deep_read: "ready", entry: "https://assistant.example/chat/42", report: { read: "It says water matters.", found: "Two other sources agree.", questions: ["Which water?"], assistant: { id: helper.assistantId, name: "Helper" } } });
    expect(["waiting", "reading", "ready", "none"]).toContain(ready.deep_read);
    // Going to deep dive with that assistant: its entry opens the conversation.
    const go = await call(env, "POST", "/v1/deep-dive-requests", { token: ann.token, body: { item_id: id } });
    expect(go.json).toMatchObject({ open_url: "https://assistant.example/chat/42", entry: "https://assistant.example/chat/42" });
    // The report travels with the queue entry: a deep-dive context gets it, and it goes when the entry goes.
    expect((await get(env, helper.access, `/v1/assistant/items/${id}/context?for=deep_dive`)).deep_read.read).toBe("It says water matters.");
    await call(env, "DELETE", `/v1/deep-read-queue/${id}`, { token: ann.token });
    expect((await get(env, helper.access, `/v1/assistant/items/${id}/context?for=deep_dive`)).deep_read).toBeNull();
  });

  it("K14 deep read: a claim that runs out puts the item back to waiting", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const id = await saveText(env, ann.token, "Read me closely.");
    await call(env, "PUT", `/v1/deep-read-queue/${id}`, { token: ann.token });
    await claim(env, helper.access, "deep_read");
    advance(31 * MINUTE);
    expect((await get(env, ann.token, "/v1/deep-read-queue")).entries[0].deep_read).toBe("waiting");
    expect((await claim(env, helper.access, "deep_read")).work).toHaveLength(1);
  });

  it("K14 deep read: with no deep-read assistant the state is 'none'; a chat assistant cannot be given the job", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const chat = await connectAssistant(env, ann, { name: "Talker", kind: "chat", scope: "deep_dive" });
    const id = await saveText(env, ann.token, "Nobody reads me.");
    expect((await call(env, "PUT", `/v1/deep-read-queue/${id}`, { token: ann.token })).json.deep_read).toBe("none");
    const r = await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { roles: { deep_read: chat.assistantId } } });
    expect(r.status).toBe(400);
    expect((await call(env, "POST", "/v1/assistant/claims", { token: chat.access, body: { kind: "deep_read" } })).status).toBe(403);
  });

  it("K14 deep read: an entry with no activity for 7 days is removed by itself; activity keeps it", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const quiet = await saveText(env, ann.token, "Quiet one.");
    const busy = await saveText(env, ann.token, "Busy one.");
    await call(env, "PUT", `/v1/deep-read-queue/${quiet}`, { token: ann.token });
    await call(env, "PUT", `/v1/deep-read-queue/${busy}`, { token: ann.token });
    advance(5 * DAY);
    await call(env, "POST", "/v1/deep-dive-requests", { token: ann.token, body: { item_id: busy } }); // the user went
    advance(2 * DAY + MINUTE);
    await runHourly(env);
    expect((await get(env, ann.token, "/v1/deep-read-queue")).entries.map((e: any) => e.item_id)).toEqual([busy]);
    expect((await get(env, ann.token, `/v1/items/${quiet}`)).in_queue).toBe(false);
    advance(7 * DAY + MINUTE);
    await runHourly(env);
    expect((await get(env, ann.token, "/v1/deep-read-queue")).entries).toEqual([]);
    expect(helper.assistantId).toBeTruthy();
  });

  it("K14 deep read: an item in the queue does not expire, but never lives past 365 days", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const queued = await saveText(env, ann.token, "Held by the queue.");
    const plain = await saveText(env, ann.token, "Not held.");
    await call(env, "PUT", `/v1/deep-read-queue/${queued}`, { token: ann.token });
    // Keep the entry active (the user keeps going back) while the item's own 30 days pass.
    for (let d = 0; d < 36; d += 6) {
      advance(6 * DAY);
      await env.DB.prepare("UPDATE deep_read_queue SET last_activity_at = ?").bind((await import("../src/clock")).now()).run();
      await runHourly(env);
    }
    expect((await call(env, "GET", `/v1/items/${plain}`, { token: ann.token })).status).toBe(404);
    expect(await get(env, ann.token, `/v1/items/${queued}`)).toMatchObject({ in_queue: true, days_left: 0 });
    // Out of the queue the hold ends, and the item goes at the next expiry run.
    await call(env, "DELETE", `/v1/deep-read-queue/${queued}`, { token: ann.token });
    await runHourly(env);
    expect((await call(env, "GET", `/v1/items/${queued}`, { token: ann.token })).status).toBe(404);
    // The hard limit: even held, nothing lives past a year.
    const old = await saveText(env, ann.token, "Held for a year.");
    await call(env, "PUT", `/v1/deep-read-queue/${old}`, { token: ann.token });
    await env.DB.prepare("UPDATE deep_read_queue SET last_activity_at = ?").bind((await import("../src/clock")).now() + 400 * DAY).run();
    await leap(env, ann, 365 * DAY + MINUTE);
    await runHourly(env);
    expect((await call(env, "GET", `/v1/items/${old}`, { token: ann.token })).status).toBe(404);
  });
});

describe("K15 notes and lookup", () => {
  it("K15 notes: notes do not expire, and quick find looks only at note titles and bodies", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await saveText(env, ann.token, "An item that mentions oolong but is not a note.", "Oolong item");
    const n1 = await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "Brewing oolong", body: "Use water at 90 degrees.\n\n乌龙茶要用九十度的水。" }, idem: idem() });
    await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "Bread", body: "Flour, water, salt, time." }, idem: idem() });
    const find = async (q: string) => (await get(env, ann.token, `/v1/notes?q=${encodeURIComponent(q)}`)).notes.map((n: any) => n.title);
    expect(await find("oolong")).toEqual(["Brewing oolong"]); // title
    expect(await find("90 degrees")).toEqual(["Brewing oolong"]); // body
    expect(await find("water")).toEqual(expect.arrayContaining(["Brewing oolong", "Bread"]));
    expect(await find("乌龙")).toEqual(["Brewing oolong"]); // two characters: plain matching
    expect(await find("九十度的水")).toEqual(["Brewing oolong"]);
    expect(await find("OOLONG")).toEqual(["Brewing oolong"]);
    expect(await find("Oolong item")).toEqual([]); // items are never found here
    expect(await find("100%")).toEqual([]);
    await leap(env, ann, 800 * DAY);
    await runHourly(env);
    expect((await get(env, ann.token, "/v1/notes")).notes).toHaveLength(2);
    const note = await get(env, ann.token, `/v1/notes/${n1.json.id}`);
    expect(note.body).toContain("90 degrees");
    const md = await call(env, "GET", `/v1/notes/${n1.json.id}`, { token: ann.token, headers: { accept: "text/markdown" } });
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(md.text.startsWith("# Brewing oolong\n\nUse water at 90 degrees.")).toBe(true);
  });

  it("K15 notes: quick find still works when the index is not there (falls back to plain matching)", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "Brewing oolong", body: "Use water at 90 degrees." }, idem: idem() });
    await env.DB.exec("DROP TABLE notes_fts");
    expect((await get(env, ann.token, "/v1/notes?q=oolong")).notes).toHaveLength(1);
    expect((await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "Second", body: "Still saved without the index." }, idem: idem() })).status).toBe(201);
    expect((await get(env, ann.token, "/v1/notes?q=index")).notes).toHaveLength(1);
  });

  it("K15 lookup: the keyword lookup over items never matches archived items", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const old = await saveText(env, ann.token, "An old thought about oolong.");
    advance(31 * DAY);
    await runHourly(env);
    const fresh = await saveText(env, ann.token, "A fresh thought about oolong.");
    const found = (await get(env, ann.token, "/v1/items/search?q=oolong")).items.map((i: any) => i.id);
    expect(found).toEqual([fresh]);
    expect(found).not.toContain(old);
    expect((await call(env, "GET", "/v1/items/search", { token: ann.token })).status).toBe(400);
    // The row is still there, archived: only hidden.
    expect((await db(env, "SELECT archived_at FROM items WHERE id = ?", old))[0].archived_at).not.toBeNull();
  });

  it("K15 lookup: the contract offers no lookup over digests or analyses to reading clients", async () => {
    const { CONTRACT } = await import("../src/generated/contract");
    const lookups = CONTRACT.operations.filter((o) => o.auth === "device" && o.params.some((p) => p.name === "q")).map((o) => o.operationId);
    expect(lookups.sort()).toEqual(["listNotes", "searchItems"]);
  });
});

describe("K16 expiry", () => {
  it("K16 expiry: 30 days by default, 365 at most, pinned never", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const normal = await saveText(env, ann.token, "Thirty days.");
    const long = await saveText(env, ann.token, "A year.");
    const pinned = await saveText(env, ann.token, "For ever.");
    await call(env, "PATCH", `/v1/items/${long}`, { token: ann.token, body: { expiry_days: 365 } });
    await call(env, "PUT", `/v1/items/${pinned}/pin`, { token: ann.token });
    expect((await get(env, ann.token, `/v1/items/${normal}`)).days_left).toBe(30);
    advance(29 * DAY);
    await runHourly(env);
    expect((await get(env, ann.token, `/v1/items/${normal}`)).days_left).toBe(1);
    advance(DAY + MINUTE);
    await runHourly(env);
    const alive = async () => (await get(env, ann.token, "/v1/items?state=today")).items.map((i: any) => i.id).sort();
    expect(await alive()).toEqual([long, pinned].sort());
    await leap(env, ann, 334 * DAY);
    await runHourly(env);
    expect(await alive()).toEqual([long, pinned].sort());
    advance(DAY);
    await runHourly(env);
    expect(await alive()).toEqual([pinned]);
    await leap(env, ann, 1000 * DAY);
    await runHourly(env);
    expect(await alive()).toEqual([pinned]);
  });

  it("K16 expiry: an expired item disappears from every list, lookup, context and from triage; its digest line stays", async () => {
    const env = makeEnv();
    const { ann, helper, ids } = await withDigest(env, ["A thought that will expire.", "Another thought."]);
    const [gone, kept] = ids;
    await call(env, "PATCH", `/v1/items/${kept}`, { token: ann.token, body: { expiry_days: 90 } });
    const waiting = await saveText(env, ann.token, "Never triaged, will expire too."); // stays untriaged below
    await env.DB.prepare("UPDATE items SET created_at = created_at + 0 WHERE id = ?").bind(waiting).run();
    advance(31 * DAY);
    await runHourly(env);
    await refresh(env, helper);
    expect((await call(env, "GET", `/v1/items/${gone}`, { token: ann.token })).status).toBe(404);
    for (const path of ["/v1/items?state=today", "/v1/items?state=digested", "/v1/items?state=pinned", "/v1/items/search?q=thought", "/v1/deep-read-queue"]) {
      const text = (await call(env, "GET", path, { token: ann.token })).text;
      expect(text).not.toContain(gone);
      expect(text).not.toContain(waiting);
    }
    expect((await call(env, "PUT", `/v1/items/${gone}/pin`, { token: ann.token })).status).toBe(404);
    expect((await call(env, "PUT", `/v1/deep-read-queue/${gone}`, { token: ann.token })).status).toBe(404);
    expect((await call(env, "GET", `/v1/assistant/items/${gone}/context?for=deep_dive`, { token: helper.access })).status).toBe(404);
    expect((await get(env, helper.access, "/v1/assistant/deep-dive-candidates")).candidates.map((c: any) => c.item_id)).toEqual([kept]);
    // Not in triage either: the expired, never-triaged item is not offered and gets no defaults.
    await runMinute(env);
    expect((await db(env, "SELECT triaged_at FROM items WHERE id = ?", waiting))[0].triaged_at).toBeNull();
    expect((await get(env, ann.token, "/v1/status")).waiting).toBe(0);
    // The digest keeps its sentence about it.
    const d = await get(env, ann.token, "/v1/digests/latest");
    expect(d.worth.find((w: any) => w.item_id === gone)).toMatchObject({ line: `Line for ${gone}`, title: "A thought that will expire.", available: false });
    expect(d.worth.find((w: any) => w.item_id === kept).available).toBe(true);
  });

  it("K16 expiry: an item that expires unanalysed is not offered as work, and the next digest does not cover expired items", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const [a] = await analysed(env, ann, helper, ["Analysed, never digested."]);
    await saveText(env, ann.token, "Triaged, never analysed.");
    await coreTriage(env);
    advance(31 * DAY);
    await runHourly(env);
    await refresh(env, helper);
    expect((await get(env, helper.access, "/v1/assistant/work")).work).toEqual([]);
    expect((await claim(env, helper.access, "analysis")).work).toEqual([]);
    expect((await claim(env, helper.access, "digest")).work).toEqual([]);
    expect((await get(env, helper.access, "/v1/assistant/digests/latest/context")).analyses).toEqual([]);
    expect(a).toBeTruthy();
  });

  it("K16 expiry: deleting takes effect at once and removes the item with its analysis and tags", async () => {
    const env = makeEnv();
    const { ann, helper, ids } = await withDigest(env, ["Delete me.", "Keep me."]);
    const reader = await connectDevice(env, ann, "read");
    expect((await call(env, "DELETE", `/v1/items/${ids[0]}`, { token: reader.token })).status).toBe(403);
    expect((await call(env, "DELETE", `/v1/items/${ids[0]}`, { token: ann.token })).status).toBe(204);
    expect((await call(env, "GET", `/v1/items/${ids[0]}`, { token: ann.token })).status).toBe(404);
    expect((await call(env, "DELETE", `/v1/items/${ids[0]}`, { token: ann.token })).status).toBe(404);
    for (const table of ["items", "analyses", "item_tags"]) {
      expect(await db(env, `SELECT * FROM ${table} WHERE ${table === "items" ? "id" : "item_id"} = ?`, ids[0])).toEqual([]);
    }
    const d = await get(env, ann.token, "/v1/digests/latest");
    expect(d.worth.find((w: any) => w.item_id === ids[0])).toMatchObject({ available: false, line: `Line for ${ids[0]}` });
    expect(helper.assistantId).toBeTruthy();
  });

  it("K16 expiry: the two retention settings — keep the copy on delete, and clean archived items after N days", async () => {
    const keep = makeEnv({ DELETE_COPIES_ON_USER_DELETE: "false" });
    const ann = await signIn(keep);
    const id = await saveText(keep, ann.token, "Deleted by the user, copy kept.");
    await call(keep, "DELETE", `/v1/items/${id}`, { token: ann.token });
    expect((await call(keep, "GET", `/v1/items/${id}`, { token: ann.token })).status).toBe(404);
    expect((await db(keep, "SELECT archived_at FROM items WHERE id = ?", id))[0].archived_at).not.toBeNull();
    // Default: archived items are kept. With archive_retention_days they are cleaned after that long.
    advance(40 * DAY);
    await runHourly(keep);
    expect(await db(keep, "SELECT id FROM items")).toHaveLength(1);
    const clean = makeEnv({ ARCHIVE_RETENTION_DAYS: "30" });
    await runHourly(clean);
    expect(await db(clean, "SELECT id FROM items")).toHaveLength(0);
  });
});

describe("K17 calendar", () => {
  it("K17 calendar: the five marks and the month's counts", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel() });
    const ann = await signIn(env);
    const day = async () => {
      const cal = await get(env, ann.token, "/v1/calendar?month=2026-11");
      return Object.fromEntries(cal.days.map((d: any) => [d.day, d]));
    };
    // 20th: saved only. 21st: digest, unread. 22nd: digest, read. 23rd: a note. 24th: nothing.
    advance(-4 * DAY); // the 20th, 12:00
    await env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind(Date.UTC(2026, 9, 3), ann.userId).run();
    await saveText(env, ann.token, "Saved on the 20th, never analysed.");
    advance(DAY);
    await saveText(env, ann.token, "Saved on the 21st.");
    await runMinute(env);
    advance(9 * HOUR_MS + 5 * MINUTE);
    await runMinute(env); // digest of the 21st
    advance(15 * HOUR_MS - 5 * MINUTE); // the 22nd, 12:00
    await saveText(env, ann.token, "Saved on the 22nd.");
    await runMinute(env);
    advance(9 * HOUR_MS + 5 * MINUTE);
    await runMinute(env);
    await call(env, "POST", "/v1/digests/2026-11-22/read", { token: ann.token });
    advance(15 * HOUR_MS - 5 * MINUTE); // the 23rd
    await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "A note", body: "Kept." }, idem: idem() });
    advance(DAY); // the 24th

    const cal = await get(env, ann.token, "/v1/calendar?month=2026-11");
    expect(cal.days).toHaveLength(30);
    expect(cal.today).toBe("2026-11-24");
    const d = await day();
    expect(d["2026-11-19"]).toEqual({ day: "2026-11-19", mark: "empty", has_digest: false });
    expect(d["2026-11-20"].mark).toBe("saved");
    expect(d["2026-11-21"]).toMatchObject({ mark: "digest_unread", has_digest: true });
    expect(d["2026-11-22"]).toMatchObject({ mark: "digest_read", has_digest: true });
    expect(d["2026-11-23"].mark).toBe("note");
    expect(d["2026-11-24"].mark).toBe("empty");
    expect(d["2026-11-25"].mark).toBe("future");
    expect(cal.counts).toEqual({ saved: 3, digests: 2, read: 1, notes: 1 });
    expect(cal).toMatchObject({ previous_month: "2026-10", next_month: null });
    expect((await get(env, ann.token, "/v1/calendar")).month).toBe("2026-11");
    expect((await get(env, ann.token, "/v1/calendar?month=2026-10")).next_month).toBe("2026-11");
    expect((await call(env, "GET", "/v1/calendar?month=2026-13", { token: ann.token })).status).toBe(400);
    // It records what happened: deleting the item later does not change the mark.
    const items = (await get(env, ann.token, "/v1/items?state=today")).items;
    for (const i of items) await call(env, "DELETE", `/v1/items/${i.id}`, { token: ann.token });
    expect((await day())["2026-11-20"].mark).toBe("saved");
    // Counts by day and by source, numbers only.
    const stats = await get(env, ann.token, "/v1/stats?days=5");
    expect(stats.days.map((x: any) => x.saved)).toEqual([0, 0, 1, 1, 1]);
    expect(stats.days[2].by_source).toEqual({ web: 1 });
    expect(JSON.stringify(stats)).not.toContain("Saved on");
  });

  it("K17 calendar image: off by default, unguessable, can be rotated and turned off", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    expect((await get(env, ann.token, "/v1/settings")).calendar_image).toEqual({ enabled: false, url: null });
    expect((await call(env, "GET", "/c/anything-at-all-0000.svg")).status).toBe(404);
    const on = await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { calendar_image_enabled: true } });
    const url: string = on.json.calendar_image.url;
    const secret = url.match(/\/c\/([\w-]+)\.svg$/)![1];
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret).not.toContain(ann.userId.slice(4));
    const img = await call(env, "GET", url); // no credential
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toContain("image/svg+xml");
    const rotated = await call(env, "POST", "/v1/settings/calendar-image/rotate", { token: ann.token });
    expect(rotated.json.calendar_image.url).not.toBe(url);
    expect((await call(env, "GET", url)).status).toBe(404);
    expect((await call(env, "GET", rotated.json.calendar_image.url)).status).toBe(200);
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { calendar_image_enabled: false } });
    expect((await call(env, "GET", rotated.json.calendar_image.url)).status).toBe(404);
    expect((await call(env, "GET", "/c/" + secret + ".png")).status).toBe(404);
  });

  it("K17 calendar image: dots and numbers only — no titles, no text, no identity", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann.secret.name@example.com");
    await saveText(env, ann.token, "A very private title about tea.", "PrivateTitleMarker");
    await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "NoteTitleMarker", body: "NoteBodyMarker" }, idem: idem() });
    const url = (await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { calendar_image_enabled: true } })).json.calendar_image.url;
    for (const q of ["", "?theme=dark", "?theme=clear&counts=0", "?range=year", "?range=year&theme=dark&counts=1"]) {
      const svg = (await call(env, "GET", url + q)).text;
      expect(svg.startsWith("<svg")).toBe(true);
      for (const marker of ["PrivateTitleMarker", "NoteTitleMarker", "NoteBodyMarker", "ann.secret", "example.com", ann.userId, "tea"]) expect(svg).not.toContain(marker);
      // Every piece of text in the image is a number.
      const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
      expect(texts.every((t) => /^\d+$/.test(t))).toBe(true);
      expect(svg.replace(/<[^>]+>/g, "").replace(/\d/g, "").trim()).toBe("");
      expect(svg).not.toMatch(/<(title|desc|image|a|script|foreignObject)\b/);
      expect(texts.length).toBe(q.includes("counts=0") ? 0 : 4);
    }
    const month = (await call(env, "GET", url)).text;
    const year = (await call(env, "GET", url + "?range=year")).text;
    expect((year.match(/<circle/g) ?? []).length).toBeGreaterThan((month.match(/<circle/g) ?? []).length * 5);
    expect(month).toContain("#b8892b"); // the gold dot for the day with a note
    expect((await call(env, "GET", url + "?theme=clear")).text).not.toContain("<rect width");
  });
});

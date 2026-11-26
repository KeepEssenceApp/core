// QA #7: a retention the user set stays as set, and the header, the days and the tag agree.
import { describe, expect, it } from "vitest";
import { advance, DAY, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";
import { call, connectAssistant, LLM, makeEnv, modelStub, saveText, signIn, T0, withHelper } from "./helpers";

const item = async (env: any, token: string, id: string) => (await call(env, "GET", `/v1/items/${id}`, { token })).json;
const expiryTags = (it: any) => (it.tags as string[]).filter((t) => t.startsWith("expiry:"));

describe("QA #7 retention", () => {
  it("QA #7: choosing days on a kept item gives it an end date, counted from now", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Kept, then given an end date.");
    expect((await call(env, "PUT", `/v1/items/${id}/pin`, { token: ann.token })).status).toBe(204);
    advance(10 * DAY);

    const patched = await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { expiry_days: 90 } });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ pinned: false, expiry_days: 90, days_left: 90 });
    expect(patched.json.expires_at).toBe(new Date(T0 + 100 * DAY).toISOString());
    expect(expiryTags(patched.json)).toEqual(["expiry:90"]);
    // It is no longer among the kept items, and reading it again says the same.
    expect((await call(env, "GET", "/v1/items?state=pinned", { token: ann.token })).json.items).toEqual([]);
    expect(await item(env, ann.token, id)).toMatchObject({ pinned: false, expiry_days: 90, days_left: 90 });
  });

  it("QA #7: a kept item lists no expiry tag, and gets it back with its end date", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "The tag follows the header.");
    await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { expiry_days: 90 } });
    expect(expiryTags(await item(env, ann.token, id))).toEqual(["expiry:90"]);

    await call(env, "PUT", `/v1/items/${id}/pin`, { token: ann.token });
    const kept = await item(env, ann.token, id);
    expect(kept).toMatchObject({ pinned: true, days_left: null, expiry_days: null, expires_at: null });
    expect(expiryTags(kept)).toEqual([]);

    await call(env, "DELETE", `/v1/items/${id}/pin`, { token: ann.token });
    const back = await item(env, ann.token, id);
    expect(back).toMatchObject({ pinned: false, expiry_days: 90, days_left: 90 });
    expect(expiryTags(back)).toEqual(["expiry:90"]);
  });

  it("QA #7: days the user chooses count from the moment they are chosen, also on an older item", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Saved two days ago.");
    advance(2 * DAY);
    const patched = await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { expiry_days: 90 } });
    expect(patched.json).toMatchObject({ pinned: false, expiry_days: 90, days_left: 90 });
    expect(patched.json.expires_at).toBe(new Date(T0 + 92 * DAY).toISOString());
    // Seven days on a ten-day-old item must not delete it within the hour.
    advance(8 * DAY);
    const short = await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { expiry_days: 7 } });
    expect(short.json).toMatchObject({ expiry_days: 7, days_left: 7 });
  });

  it("QA #7: setting only the assistant before triage keeps the retention; triage cannot change it", async () => {
    const base = makeEnv();
    const { ann } = await withHelper(base);
    const other = await connectAssistant(base, ann, { name: "Second", kind: "scheduled", steps: ["analysis"] });
    const id = await saveText(base, ann.token, "The user only chose who analyses it.");
    const patched = await call(base, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { dispatch_to: other.assistantId } });
    expect(patched.json).toMatchObject({ expiry_days: 30, dispatch_to: { id: other.assistantId } });
    expect(patched.json.tags).toEqual(expect.arrayContaining(["assistant:Second", "expiry:30"]));

    // The dispatch assistant would have said 7 days and another assistant.
    const env = makeEnv({ ...LLM, OUTBOUND: modelStub(() => [{ item_id: id, assistant: "Helper", expiry_days: 7 }]) });
    await runMinute(env);
    const got = await item(env, ann.token, id);
    expect(got).toMatchObject({ stage: "triaged", expiry_days: 30, days_left: 30, dispatch_to: { id: other.assistantId, name: "Second" } });
    expect(got.tags).toEqual(expect.arrayContaining(["assistant:Second", "expiry:30"]));
  });

  it("QA #7: the core's own defaults do not change an item the user touched either", async () => {
    const env = makeEnv();
    const { ann } = await withHelper(env);
    const other = await connectAssistant(env, ann, { name: "Second", kind: "scheduled", steps: ["analysis"] });
    const id = await saveText(env, ann.token, "Touched, then left to the defaults.");
    await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { expiry_days: 7 } });
    await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { dispatch_to: other.assistantId } });
    advance(10 * MINUTE + 1000);
    await runMinute(env);
    expect(await item(env, ann.token, id)).toMatchObject({ stage: "triaged", expiry_days: 7, dispatch_to: { id: other.assistantId } });
  });

  it("QA #7: keeping an item before triage protects the term it returns to", async () => {
    const base = makeEnv();
    const ann = await signIn(base);
    const id = await saveText(base, ann.token, "Kept before anyone triaged it.");
    await call(base, "PUT", `/v1/items/${id}/pin`, { token: ann.token });
    const env = makeEnv({ ...LLM, OUTBOUND: modelStub(() => [{ item_id: id, expiry_days: 7 }]) });
    await runMinute(env);
    const kept = await item(env, ann.token, id);
    expect(kept).toMatchObject({ stage: "triaged", pinned: true, days_left: null });
    expect(expiryTags(kept)).toEqual([]);
    await call(env, "DELETE", `/v1/items/${id}/pin`, { token: ann.token });
    expect(await item(env, ann.token, id)).toMatchObject({ pinned: false, expiry_days: 30, days_left: 30 });
  });
});

describe("QA #83: days left are counted on the calendar", () => {
  it("reads the full term on the day of saving and one less the next day, whatever the hour", async () => {
    const { advance, HOUR } = await import("../src/clock");
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Kept for a week.");
    expect((await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { expiry_days: 7 } })).json.days_left).toBe(7);
    // T0 is 12:00 in Shanghai. Eleven hours on it is still the same day there.
    advance(11 * HOUR);
    expect((await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json.days_left).toBe(7);
    // Two more hours: the next day, 23 hours short of... still 6 days and 11 hours to go, and it reads 6.
    advance(2 * HOUR);
    expect((await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json.days_left).toBe(6);
    advance(5 * 24 * HOUR);
    expect((await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json.days_left).toBe(1);
    // The day it ends on: 0, until the hour it goes.
    advance(24 * HOUR);
    expect((await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json.days_left).toBe(0);
  });
});

describe("QA #88: the choices for how long items are kept", () => {
  it("the core refuses days outside 1 to 365, none at all, more than six, and anything that is not a whole number", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const patch = (expiry_options: unknown) => call(env, "PATCH", "/v1/settings", { token: ann.token, body: { expiry_options } });
    for (const wrong of [[0], [400], [7, 0], [7, 30, 400], [1.5], [-3], [], [1, 2, 3, 4, 5, 6, 7], ["7"], "7"]) expect((await patch(wrong)).status, JSON.stringify(wrong)).toBe(400);
    expect((await call(env, "GET", "/v1/settings", { token: ann.token })).json.expiry_options).toEqual([7, 30, 90, 365]);
    for (const right of [[1], [365], [7, 30]]) expect((await patch(right)).status, JSON.stringify(right)).toBe(200);
  });
});

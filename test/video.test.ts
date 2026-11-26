// #103: the words of a video. The reader service (the runner, in the `jina` slot) answers 202 with a
// job; the item is saved at once, waits, and the minute job asks about it. Everything here is made
// up: the runner is a stand-in, the addresses and texts belong to nobody.
import { describe, expect, it } from "vitest";
import { advance, DAY, HOUR, MINUTE } from "../src/clock";
import { composeNotification } from "../src/services/notify";
import { expireItems, pollVideos, runMinute } from "../src/cron";
import type { Env } from "../src/env";
import { cancelJob, fetchContent, loadFetchSettings, usable } from "../src/services/fetchers";
import { fetchItemContent } from "../src/services/items";
import { finishVideo, pollVideo } from "../src/services/video";
import { shownText } from "../src/builtin";
import { ADMIN, builtinModel, call, connectAssistant, db, idem, LLM, makeEnv, saveText, signIn, signInMine, T0, tool, type Outbound, type Session } from "./helpers";

const RUNNER = "https://runner.example.net";
const KEY = "runner-key-0123456789";
const ADDR = "https://www.xiaohongshu.com/explore/v1";
const CAPTION = "周末在家做了一个松木置物架，从裁板到上漆花了一个下午，下面是用到的工具和每一步要注意的地方，视频里有完整的过程。";
const LONG_CAPTION = CAPTION.repeat(2);
const SHORT_CAPTION = "松木置物架 #手作";
const SPOKEN = "QUOKKAMARKER 先把板子按尺寸锯开，再用砂纸打磨边角，最后刷两遍清漆，晾一晚就可以用了。";

/** A stand-in for the runner: what it is asked for is written down, what it answers is set by the test. */
function runnerStub(env: () => Env) {
  const calls: { method: string; path: string; auth?: string; accept?: string }[] = [];
  const pages = new Map<string, () => Response | Promise<Response>>();
  const jobs = new Map<string, () => Response>();
  const state = { down: false };
  const answer = {
    page: (address: string, body: unknown, status = 200) => pages.set(address, () => Response.json(body, { status })),
    reading: (address: string, job: string, content: string, seconds = 111) =>
      pages.set(address, () => Response.json({ code: 202, data: { title: "松木置物架", url: address, content }, video: { state: "reading", job, seconds } }, { status: 202 })),
    job: (job: string, body: unknown, status = 200) => jobs.set(job, () => Response.json(body, { status })),
  };
  const outbound: Outbound = async (url, init) => {
    if (state.down) throw new Error("connection refused");
    const path = url.slice(RUNNER.length);
    const h = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    calls.push({ method, path, auth: h.authorization, accept: h.accept });
    if (path.startsWith("/jobs/")) {
      const job = path.slice("/jobs/".length);
      if (method === "DELETE") {
        jobs.delete(job);
        return new Response(null, { status: 204 });
      }
      return jobs.get(job)?.() ?? new Response("{}", { status: 404 });
    }
    return (await pages.get(path.slice(1))?.()) ?? new Response("nope", { status: 404 });
  };
  void env;
  const asked = (job: string, method = "GET") => calls.filter((c) => c.path === `/jobs/${job}` && c.method === method).length;
  return { calls, pages, jobs, state, outbound, asked, ...answer };
}

/** The core with a runner in the `jina` slot, put first in the order, and the built-in assistants on a model stand-in. */
async function world(extra: Partial<Env> = {}) {
  let env!: Env;
  const runner = runnerStub(() => env);
  const modelCalls: any[] = [];
  // The stand-in's usual answer ("About: <title>") puts a Chinese title in an English sentence, which the
  // language check rightly asks about again. These tests count calls, so the answer here is plainly the account's own language.
  const model = builtinModel(modelCalls, {
    analysis: () => ({ summary: "A pine shelf built in a weekend.", key_fact: "Video, short", points: ["Saw the boards, sand the edges, varnish twice."], verdict: "worth_deep_dive" }),
  });
  const outbound: Outbound = async (url, init) => {
    if (url.startsWith("https://model.test/")) return model(url, init);
    if (url.startsWith(RUNNER + "/")) return runner.outbound(url, init);
    return new Response("no", { status: 404 }); // the direct read finds nothing
  };
  env = makeEnv({ ...LLM, OUTBOUND: outbound, ...extra });
  const set = await call(env, "PUT", "/admin/fetch", { token: ADMIN, body: { order: ["jina", "direct", "firecrawl"], jina: { enabled: true, endpoint: RUNNER, key: KEY } } });
  expect(set.status).toBe(200);
  // These tests are about videos, not about the language of an analysis: the account always wants its own language, and the stand-in answers in it.
  return { env, runner, modelCalls, ann: await signInMine(env) };
}

const kinds = (calls: any[]) => calls.map((c) => (c.request.system.startsWith("You sort") ? "triage" : c.request.system.startsWith("You analyse") ? "analysis" : "digest"));
const inputOf = (c: any) => JSON.parse(typeof c.request.messages[0].content === "string" ? c.request.messages[0].content : c.request.messages[0].content.find((b: any) => b.type === "text").text);

async function save(env: Env, who: Session, url: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call(env, "POST", "/v1/items", { token: who.token, body: { kind: "link", url, ...extra }, idem: idem() });
  expect(r.status).toBe(201);
  return r.json.item_id;
}
const detail = async (env: Env, who: Session, id: string) => (await call(env, "GET", `/v1/items/${id}`, { token: who.token })).json;
const row = async (env: Env, id: string) =>
  (await db(env, "SELECT fetch_state, fetch_job, fetch_deadline, video_state, recognized_text, content_unavailable, triaged_at, analysed_at, body, archived_at FROM items WHERE id = ?", id))[0];
const statsOf = async (env: Env) => (await db(env, "SELECT platform, path, n FROM fetch_stats ORDER BY platform, path")) as { platform: string; path: string; n: number }[];
const done = (text: string) => ({ state: "done", video_state: "recognized", recognized_text: text });

describe("K23 the runner is asked first for the links that have videos", () => {
  it("WeChat and Xiaohongshu links go to the runner first even when the direct read comes first and would read them; other links keep the order", async () => {
    let env!: Env;
    const runner = runnerStub(() => env);
    const direct: string[] = [];
    const outbound: Outbound = async (url, init) => {
      if (url.startsWith(RUNNER + "/")) return runner.outbound(url, init);
      direct.push(url);
      return new Response(`<html><head><title>松木置物架</title></head><body><article><p>${LONG_CAPTION}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
    };
    env = makeEnv({ OUTBOUND: outbound });
    const set = await call(env, "PUT", "/admin/fetch", { token: ADMIN, body: { order: ["direct", "jina", "firecrawl"], jina: { enabled: true, endpoint: RUNNER, key: KEY } } });
    expect(set.json.order).toEqual(["direct", "jina", "firecrawl"]);
    const ann = await signIn(env);
    runner.reading(ADDR, "job-first", LONG_CAPTION);
    runner.job("job-first", { state: "reading" });
    const id = await save(env, ann, ADDR);
    expect(await detail(env, ann, id)).toMatchObject({ video_state: "reading", body: LONG_CAPTION });
    expect(direct).toEqual([]);
    // Another site: the direct read first, as the operator ordered; the runner is not asked.
    const other = "https://blog.example.org/tea";
    await save(env, ann, other);
    expect(direct).toEqual([other]);
    expect(runner.calls.some((c) => c.path.includes("blog.example.org"))).toBe(false);
    // The runner off: the order is the operator's, and the direct read reads the Xiaohongshu link.
    await call(env, "PUT", "/admin/fetch", { token: ADMIN, body: { jina: { enabled: false } } });
    const plain = await save(env, ann, "https://www.xiaohongshu.com/explore/plain");
    expect(direct).toContain("https://www.xiaohongshu.com/explore/plain");
    expect((await detail(env, ann, plain)).video_state ?? null).toBeNull();
  });
});

describe("K23 a video is saved at once, read in the background, and analysed when its words are there", () => {
  it("K23: saved → reading → neither triaged nor analysed → still reading → done → analysed exactly once", async () => {
    const { env, runner, modelCalls, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    const id = await save(env, ann, ADDR);

    // The runner was asked as the reader service is: the address, JSON, the key.
    expect(runner.calls[0]).toEqual({ method: "GET", path: `/${ADDR}`, auth: `Bearer ${KEY}`, accept: "application/json" });
    const waiting = await detail(env, ann, id);
    expect(waiting).toMatchObject({ title: "松木置物架", stage: "saved", content_unavailable: false, video_state: "reading", recognized_text: null, body: LONG_CAPTION });
    expect(await row(env, id)).toMatchObject({ fetch_state: "video_wait", fetch_job: "job-1", fetch_deadline: T0 + 60 * MINUTE, content_unavailable: 0, analysed_at: null, triaged_at: null });
    // It is shown and counted as waiting.
    const listed = (await call(env, "GET", "/v1/items?state=today", { token: ann.token })).json.items;
    expect(listed.map((i: any) => i.id)).toEqual([id]);
    expect(listed[0]).toMatchObject({ video_state: "reading", content_unavailable: false });
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json.waiting).toBe(1);

    // Minutes pass, ten of them too: nothing triages it, not the model and not the core's default.
    await runMinute(env);
    await runMinute(env);
    advance(11 * MINUTE);
    await runMinute(env);
    expect(modelCalls).toEqual([]);
    expect(await row(env, id)).toMatchObject({ fetch_state: "video_wait", triaged_at: null, video_state: "reading" });
    // The runner was asked about the job each minute, and the page was not read again.
    expect(runner.asked("job-1")).toBe(3);
    expect(runner.calls.filter((c) => c.path.startsWith("/jobs/")).every((c) => c.auth === `Bearer ${KEY}` && c.accept === "application/json")).toBe(true);
    expect(runner.calls.filter((c) => c.path === `/${ADDR}`)).toHaveLength(1);

    // The words are there: the item stops waiting, and the sorting step still gets its turn
    // (the core's 10 minutes count from now, not from the save), then the analysis.
    runner.job("job-1", done(SPOKEN));
    await runMinute(env);
    expect(kinds(modelCalls)).toEqual(["triage", "analysis"]);
    // Triage sees the opening of the author's text only; the analysis sees both, apart, with the caveat.
    expect(JSON.stringify(inputOf(modelCalls[0]))).not.toContain("QUOKKAMARKER");
    expect(inputOf(modelCalls[0]).items[0].opening).toBe(LONG_CAPTION.slice(0, 500));
    expect(inputOf(modelCalls[1])).toMatchObject({ content: LONG_CAPTION, recognized_text: SPOKEN });
    expect(modelCalls[1].request.system).toMatch(/recognized from the sound of the item's video/);
    expect(modelCalls[1].request.system).toContain("the video says");
    expect(modelCalls[1].request.system).toMatch(/not .*a name or a number .* as fact/);
    const analysed = await detail(env, ann, id);
    expect(analysed).toMatchObject({ stage: "analysed", video_state: "recognized", recognized_text: SPOKEN, body: LONG_CAPTION, content_unavailable: false });
    expect(analysed.body).not.toContain("QUOKKAMARKER");
    expect(await row(env, id)).toMatchObject({ fetch_state: "done", fetch_job: null, fetch_deadline: null, recognized_text: SPOKEN });
    expect(runner.asked("job-1", "DELETE")).toBe(1);

    // Nothing happens a second time: one analysis, one cancel, no more questions.
    await runMinute(env);
    await runMinute(env);
    expect(kinds(modelCalls)).toEqual(["triage", "analysis"]);
    expect(runner.asked("job-1")).toBe(4);
    expect(runner.asked("job-1", "DELETE")).toBe(1);
    expect(await db(env, "SELECT COUNT(*) AS n FROM analyses")).toEqual([{ n: 1 }]);
    // Counted by how it went, without an address or an account.
    expect(await statsOf(env)).toEqual([
      { platform: "xiaohongshu", path: "jina", n: 1 },
      { platform: "xiaohongshu", path: "video", n: 1 },
    ]);
    const view = (await call(env, "GET", "/admin/fetch", { token: ADMIN })).json;
    expect(view.stats.rows).toEqual(expect.arrayContaining([{ platform: "xiaohongshu", path: "video", n: 1 }]));
  });

  it("K23: an assistant of the user's own is not offered a waiting item, and gets it with both texts when it is its turn", async () => {
    const { env, runner, ann } = await world({ LLM_API_KEY: undefined });
    const helper = await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps: ["analysis"] });
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { roles: { analysis: helper.assistantId } } })).status).toBe(200);
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    const id = await save(env, ann, ADDR);
    const work = async () => (await call(env, "GET", "/v1/assistant/work", { token: helper.access })).json.work;
    const claim = async () => (await call(env, "POST", "/v1/assistant/claims", { token: helper.access, body: { kind: "analysis" } })).json;
    // The core's own sorting would take an item that waited 10 minutes: not one that waits for a video.
    advance(11 * MINUTE);
    await runMinute(env);
    expect(await work()).toEqual([]);
    expect((await claim()).claim_id).toBeNull();
    expect((await row(env, id)).triaged_at).toBeNull();
    // Done: its 10 minutes begin now, so whoever sorts items has them.
    runner.job("job-1", done(SPOKEN));
    await runMinute(env);
    expect((await row(env, id)).triaged_at).toBeNull();
    advance(10 * MINUTE + 1000);
    await runMinute(env);
    expect((await row(env, id)).triaged_at).not.toBeNull();
    const claimed = await claim();
    expect(claimed.work.map((w: any) => w.ref)).toEqual([id]);
    const ctx = (await call(env, "GET", `/v1/assistant/items/${id}/context?for=analysis`, { token: helper.access })).json;
    expect(ctx.item).toMatchObject({ body: LONG_CAPTION, recognized_text: SPOKEN, video_state: "recognized", content_unavailable: false });
    const submitted = await call(env, "POST", `/v1/assistant/claims/${claimed.claim_id}/submit`, {
      token: helper.access,
      idem: idem(),
      body: { results: [{ kind: "analysis", item_id: id, summary: "A pine shelf.", key_fact: "Video", points: ["Saw, sand, varnish."], verdict: "good_to_know" }] },
    });
    expect(submitted.json.outcomes).toEqual([{ ref: id, accepted: true }]);
  });

  it("K23: the minute job does not read the page of a waiting item again", async () => {
    const { env, runner, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    await save(env, ann, ADDR);
    for (let i = 0; i < 4; i++) {
      advance(2 * MINUTE);
      await runMinute(env);
    }
    expect(runner.calls.filter((c) => c.path === `/${ADDR}`)).toHaveLength(1);
    expect((await db(env, "SELECT fetch_attempts FROM items"))[0].fetch_attempts).toBe(0);
  });

  it("K23: a second read of the page that gets a job of its own does not replace the first, and its job is cancelled", async () => {
    const { env, runner, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    const id = await save(env, ann, ADDR);
    runner.reading(ADDR, "job-2", LONG_CAPTION);
    const [item] = await db(env, "SELECT id, user_id, url, title, title_from, body FROM items WHERE id = ?", id);
    await fetchItemContent(env, item);
    expect((await row(env, id)).fetch_job).toBe("job-1");
    expect(runner.asked("job-2", "DELETE")).toBe(1);
    expect(runner.asked("job-1", "DELETE")).toBe(0);
  });

  it("K23: an item deleted while the runner was still answering the page read leaves no job behind", async () => {
    const { env, runner, ann } = await world();
    runner.pages.set(ADDR, async () => {
      await env.DB.prepare("DELETE FROM items").run();
      return Response.json({ data: { title: "松木置物架", content: LONG_CAPTION }, video: { state: "reading", job: "job-late", seconds: 90 } }, { status: 202 });
    });
    await save(env, ann, ADDR);
    expect(await db(env, "SELECT id FROM items")).toEqual([]);
    expect(runner.asked("job-late", "DELETE")).toBe(1);
  });

  it("K23: the runner not answering does not stop the save, or any other item", async () => {
    const { env, runner, modelCalls, ann } = await world();
    runner.state.down = true;
    const id = await save(env, ann, ADDR);
    expect(await detail(env, ann, id)).toMatchObject({ video_state: null, content_unavailable: true });
    const text = await saveText(env, ann.token, "Green tea likes cooler water. Steep it for two minutes.", "Brewing green tea");
    await runMinute(env);
    expect(kinds(modelCalls)).toEqual(["triage", "analysis"]);
    expect((await detail(env, ann, text)).stage).toBe("analysed");
  });

  it("K23: a runner that does not answer for the whole wait: the item keeps waiting, then gives up, and what the author wrote is analysed", async () => {
    const { env, runner, modelCalls, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    const id = await save(env, ann, ADDR);
    runner.state.down = true;
    for (let i = 0; i < 5; i++) {
      advance(10 * MINUTE);
      await runMinute(env);
      expect((await row(env, id)).fetch_state).toBe("video_wait");
    }
    // A runner that answers with errors is the same as one that does not answer.
    runner.state.down = false;
    runner.job("job-1", { oops: true }, 500);
    advance(9 * MINUTE);
    await runMinute(env);
    expect((await row(env, id)).fetch_state).toBe("video_wait");
    expect(modelCalls).toEqual([]);
    // 60 minutes after the save, 61 now: it gives up.
    advance(2 * MINUTE);
    await runMinute(env);
    expect(await row(env, id)).toMatchObject({ fetch_state: "done", video_state: "unavailable", recognized_text: null, content_unavailable: 0, fetch_job: null });
    expect(kinds(modelCalls)).toEqual(["triage", "analysis"]);
    expect(await detail(env, ann, id)).toMatchObject({ stage: "analysed", video_state: "unavailable", recognized_text: null, content_unavailable: false });
    expect((await statsOf(env)).find((s) => s.path === "video_failed")).toMatchObject({ n: 1 });
  });
});

describe("K24 the text and the video are counted apart", () => {
  const ENDS: [string, unknown, string | null][] = [
    ["no_speech", { state: "done", video_state: "no_speech" }, "no_speech"],
    ["too_long", { state: "done", video_state: "too_long" }, "too_long"],
    ["unavailable", { state: "done", video_state: "unavailable" }, "unavailable"],
    ["recognized without a word in it", done("   "), "no_speech"],
    ["a state nobody knows", { state: "done", video_state: "exploded" }, "unavailable"],
  ];

  it("K24: a video that was not read leaves the text usable and analysed, and no word is made up", async () => {
    const { env, runner, modelCalls, ann } = await world();
    for (const [n, [name, answer, state]] of ENDS.entries()) {
      runner.page(`${ADDR}-${n}`, { code: 202, data: { title: name, url: `${ADDR}-${n}`, content: LONG_CAPTION }, video: { state: "reading", job: `job-${n}`, seconds: 111 } }, 202);
      runner.job(`job-${n}`, answer);
      const id = await save(env, ann, `${ADDR}-${n}`);
      await runMinute(env);
      expect(await row(env, id), name).toMatchObject({ fetch_state: "done", video_state: state, recognized_text: null, content_unavailable: 0, fetch_job: null });
      expect(await detail(env, ann, id), name).toMatchObject({ stage: "analysed", video_state: state, recognized_text: null, content_unavailable: false, body: LONG_CAPTION });
      const asked = modelCalls.filter((c) => kinds([c])[0] === "analysis").at(-1);
      expect(inputOf(asked), name).toMatchObject({ title: name, content: LONG_CAPTION });
      expect(inputOf(asked), name).not.toHaveProperty("recognized_text");
      expect(runner.asked(`job-${n}`, "DELETE"), name).toBe(1);
    }
    expect((await statsOf(env)).filter((s) => s.path === "video_failed")).toEqual([{ platform: "xiaohongshu", path: "video_failed", n: ENDS.length }]);
  });

  it("K24: a runner that no longer knows the job is a video that was not read", async () => {
    const { env, runner, ann } = await world();
    runner.reading(ADDR, "job-gone", LONG_CAPTION); // no answer for the job: the stand-in says 404
    const id = await save(env, ann, ADDR);
    await runMinute(env);
    expect(await row(env, id)).toMatchObject({ fetch_state: "done", video_state: "unavailable", content_unavailable: 0 });
  });

  it("K24: a short caption and a video that was not read is 'content could not be fetched'; a short caption while it is read is not", async () => {
    const { env, runner, modelCalls, ann } = await world();
    const urls = [1, 2, 3].map((n) => `${ADDR}-${n}`);
    runner.reading(urls[0], "job-a", SHORT_CAPTION);
    runner.reading(urls[1], "job-b", SHORT_CAPTION);
    runner.reading(urls[2], "job-c", SHORT_CAPTION);
    runner.job("job-a", { state: "reading" });
    runner.job("job-b", { state: "done", video_state: "no_speech" });
    runner.job("job-c", done(SPOKEN));
    const [a, b, c] = [await save(env, ann, urls[0]), await save(env, ann, urls[1]), await save(env, ann, urls[2])];
    // Right after the save, all three wait and none is "not fetched".
    for (const id of [a, b, c]) expect(await detail(env, ann, id)).toMatchObject({ content_unavailable: false, video_state: "reading", title: "松木置物架", body: SHORT_CAPTION });
    expect(usable({ title: "", site: "", text: SHORT_CAPTION })).toBe(false);
    expect(usable({ title: "", site: "", text: SHORT_CAPTION, video: { state: "reading", job: "x", seconds: 5 } })).toBe(true);
    expect(usable({ title: "", site: "", text: "", video: { state: "unavailable", seconds: 5 } })).toBe(false);

    await runMinute(env);
    expect(await detail(env, ann, a)).toMatchObject({ video_state: "reading", content_unavailable: false });
    // No speech and nothing but a short caption: nothing at all was read. The caption is still the author's.
    expect(await detail(env, ann, b)).toMatchObject({ video_state: "no_speech", content_unavailable: true, recognized_text: null, body: SHORT_CAPTION, title: "松木置物架" });
    expect((await row(env, b)).fetch_state).toBe("failed");
    // The words alone are content.
    expect(await detail(env, ann, c)).toMatchObject({ video_state: "recognized", content_unavailable: false, recognized_text: SPOKEN, body: SHORT_CAPTION });
    expect((await row(env, c)).fetch_state).toBe("done");
    // The one that failed is handed to the analysis as unreadable, and the one that has words is read.
    const analyses = modelCalls.filter((m) => kinds([m])[0] === "analysis");
    expect(analyses).toHaveLength(1);
    expect(inputOf(analyses[0])).toMatchObject({ recognized_text: SPOKEN });
    expect((await detail(env, ann, b)).analysis).toMatchObject({ unavailable: true });
  });

  it("K24: a long article and its video are both kept, each in its own place; the recognized text is cut at 30000 characters", async () => {
    const { env, runner, ann } = await world();
    const ARTICLE = "Steep green tea for two minutes in water of about eighty degrees, and taste it before the second cup. ".repeat(60);
    runner.reading(ADDR, "job-1", ARTICLE);
    runner.job("job-1", done(`${SPOKEN}${"。再说一遍".repeat(8000)}`));
    const id = await save(env, ann, ADDR);
    expect((await detail(env, ann, id)).body).toBe(ARTICLE.trim());
    await runMinute(env);
    const item = await detail(env, ann, id);
    expect(item.video_state).toBe("recognized");
    expect(item.body).toBe(ARTICLE.trim());
    expect(item.recognized_text).toHaveLength(30000);
    expect(item.recognized_text.startsWith("QUOKKAMARKER")).toBe(true);
    expect(item.body).not.toContain("QUOKKAMARKER");
    expect(item.recognized_text).not.toContain("Steep green tea");
  });

  it("K24: a video the runner says at once will not be read (too long, not to be had): the text is stored as for any page, and the item does not wait", async () => {
    const { env, runner, modelCalls, ann } = await world();
    runner.page(`${ADDR}-long`, { data: { title: "一篇有视频的文章", content: LONG_CAPTION }, video: { state: "too_long", seconds: 5400 } });
    runner.page(`${ADDR}-gone`, { data: { title: "只有一句话", content: SHORT_CAPTION }, video: { state: "unavailable", seconds: null } });
    runner.page(`${ADDR}-bare`, { data: { title: "", content: "" }, video: { state: "unavailable", seconds: null } });
    const long = await save(env, ann, `${ADDR}-long`);
    const gone = await save(env, ann, `${ADDR}-gone`);
    const bare = await save(env, ann, `${ADDR}-bare`);
    expect(await row(env, long)).toMatchObject({ fetch_state: "done", video_state: "too_long", fetch_job: null, body: LONG_CAPTION, content_unavailable: 0 });
    // Not enough text and no video: "content could not be fetched", and the video says why it was not read.
    expect(await row(env, gone)).toMatchObject({ fetch_state: "failed", video_state: "unavailable", content_unavailable: 1 });
    expect(await row(env, bare)).toMatchObject({ fetch_state: "failed", video_state: "unavailable", content_unavailable: 1 });
    await runMinute(env);
    await runMinute(env);
    // Only the one with text is read by the model; the other two are handed in as "could not be fetched".
    expect(kinds(modelCalls).filter((k) => k === "analysis")).toHaveLength(1);
    expect((await detail(env, ann, long)).analysis).toMatchObject({ unavailable: false });
    expect((await detail(env, ann, gone)).analysis).toMatchObject({ unavailable: true });
    expect((await detail(env, ann, bare)).analysis).toMatchObject({ unavailable: true });
    expect(runner.calls.filter((c) => c.path.startsWith("/jobs/"))).toEqual([]);
    expect((await statsOf(env)).filter((s) => s.path === "video_failed")).toEqual([{ platform: "xiaohongshu", path: "video_failed", n: 3 }]);
  });

  it("K24: a 202 that names no usable job is an error of that way, and the next way reads the page", async () => {
    const { env, runner, ann } = await world();
    runner.page(ADDR, { video: { state: "reading", job: "../escape", seconds: 3 }, data: { content: LONG_CAPTION } }, 202);
    const id = await save(env, ann, ADDR);
    expect(await row(env, id)).toMatchObject({ fetch_state: "failed", fetch_job: null, video_state: null });
    expect(runner.calls.some((c) => c.path.startsWith("/jobs/"))).toBe(false);
  });
});

describe("K25 an item that is gone while its video is read, a late or repeated result, and whose job it is", () => {
  it("K25: deleted while it waits: the runner is told, nothing is written back, nobody is asked again", async () => {
    const { env, runner, modelCalls, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    const id = await save(env, ann, ADDR);
    expect((await call(env, "DELETE", `/v1/items/${id}`, { token: ann.token })).status).toBe(204);
    expect(runner.asked("job-1", "DELETE")).toBe(1);
    // Even if the runner had a result by now: the item is not there to receive it.
    runner.job("job-1", done(SPOKEN));
    await runMinute(env);
    await runMinute(env);
    expect(runner.asked("job-1")).toBe(0);
    expect(await db(env, "SELECT id FROM items")).toEqual([]);
    expect(modelCalls).toEqual([]);
  });

  it("K25: expired (or deleted with the copy kept) while it waits: the job is cancelled by the minute job, nothing is asked or written back", async () => {
    const { env, runner, modelCalls, ann } = await world({ DELETE_COPIES_ON_USER_DELETE: "false" });
    runner.reading(`${ADDR}-1`, "job-1", LONG_CAPTION);
    runner.reading(`${ADDR}-2`, "job-2", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    runner.job("job-2", { state: "reading" });
    const expiring = await save(env, ann, `${ADDR}-1`);
    const deleted = await save(env, ann, `${ADDR}-2`);
    expect((await call(env, "DELETE", `/v1/items/${deleted}`, { token: ann.token })).status).toBe(204);
    advance(31 * DAY);
    expect(await expireItems(env)).toBeGreaterThanOrEqual(1);
    runner.job("job-1", done(SPOKEN));
    runner.job("job-2", done(SPOKEN));
    await runMinute(env);
    await runMinute(env);
    for (const [id, job] of [[expiring, "job-1"], [deleted, "job-2"]] as const) {
      expect(runner.asked(job, "DELETE")).toBe(1);
      expect(runner.asked(job)).toBe(0);
      const r = await row(env, id);
      expect(r).toMatchObject({ recognized_text: null, video_state: "reading", fetch_job: null });
      expect(r.archived_at).not.toBeNull();
    }
    expect(modelCalls).toEqual([]);
  });

  it("K25: account deletion removes the rows; no job is asked about afterwards", async () => {
    const { env, runner, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    await save(env, ann, ADDR);
    expect((await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: ann.email } })).status).toBe(204);
    expect(await db(env, "SELECT id FROM items")).toEqual([]);
    await runMinute(env);
    expect(runner.asked("job-1")).toBe(0);
  });

  it("K25: a result is written once, and only to the item that holds the job; a late or repeated one changes nothing", async () => {
    const { env, runner, modelCalls, ann } = await world();
    const bob = await signIn(env, "bob@example.com");
    runner.reading(`${ADDR}-ann`, "job-ann", LONG_CAPTION);
    runner.reading(`${ADDR}-bob`, "job-bob", LONG_CAPTION);
    runner.job("job-ann", done(SPOKEN));
    runner.job("job-bob", { state: "reading" });
    const a = await save(env, ann, `${ADDR}-ann`);
    const b = await save(env, bob, `${ADDR}-bob`);
    await runMinute(env);
    expect(await row(env, a)).toMatchObject({ video_state: "recognized", recognized_text: SPOKEN });
    expect(await row(env, b)).toMatchObject({ video_state: "reading", recognized_text: null, fetch_job: "job-bob" });
    expect(runner.asked("job-ann", "DELETE")).toBe(1);

    // The same result again, and the same job offered for another item or user, change nothing.
    const s = await loadFetchSettings(env);
    const [bobItem] = await db(env, "SELECT id, user_id, url, body, fetch_job, fetch_deadline FROM items WHERE id = ?", b);
    expect(await finishVideo(env, s, { ...bobItem, fetch_job: "job-ann" }, "recognized", "words that belong to the other item")).toBe(false);
    expect(await finishVideo(env, s, { ...bobItem, user_id: ann.userId }, "recognized", "words that belong to another account")).toBe(false);
    const [annItem] = await db(env, "SELECT id, user_id, url, body, fetch_job, fetch_deadline FROM items WHERE id = ?", a);
    expect(await finishVideo(env, s, { ...annItem, fetch_job: "job-ann" }, "recognized", "a second answer")).toBe(false);
    // An item that is archived is not written to, even by the right job.
    await db(env, "UPDATE items SET archived_at = ? WHERE id = ?", T0, b);
    expect(await finishVideo(env, s, bobItem, "recognized", "too late")).toBe(false);
    await db(env, "UPDATE items SET archived_at = NULL WHERE id = ?", b);
    await pollVideo(env, s, { ...annItem, fetch_job: "job-ann", fetch_deadline: T0 + HOUR });
    await Promise.all([pollVideos(env), pollVideos(env)]);
    expect(await row(env, a)).toMatchObject({ recognized_text: SPOKEN, video_state: "recognized" });
    expect(await row(env, b)).toMatchObject({ recognized_text: null, video_state: "reading" });
    // One analysis for the one item whose words arrived; the other is still waiting.
    await runMinute(env);
    await runMinute(env);
    expect(kinds(modelCalls).filter((k) => k === "analysis")).toHaveLength(1);
    expect(await db(env, "SELECT COUNT(*) AS n FROM analyses")).toEqual([{ n: 1 }]);
    expect(runner.asked("job-ann", "DELETE")).toBe(1);
  });

  it("K25: two minute jobs at once end the wait once, and the runner is told once", async () => {
    const { env, runner, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", done(SPOKEN));
    const id = await save(env, ann, ADDR);
    await Promise.all([pollVideos(env), pollVideos(env)]);
    expect(await row(env, id)).toMatchObject({ fetch_state: "done", recognized_text: SPOKEN });
    expect(runner.asked("job-1", "DELETE")).toBe(1);
    expect(await statsOf(env)).toEqual(expect.arrayContaining([{ platform: "xiaohongshu", path: "video", n: 1 }]));
  });

  it("K25: the runner no longer knows the job (it restarted): the wait ends at once, with nothing to cancel", async () => {
    const { env, runner, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    const id = await save(env, ann, ADDR); // no answer for job-1: the stand-in says 404
    await runMinute(env);
    expect(await row(env, id)).toMatchObject({ fetch_state: "done", video_state: "unavailable", recognized_text: null, fetch_job: null });
    expect(runner.asked("job-1", "DELETE")).toBe(0);
  });

  it("K25: at most five items are asked about in a minute, the oldest first", async () => {
    const { env, runner, ann } = await world();
    const ids: string[] = [];
    for (let n = 1; n <= 6; n++) {
      runner.reading(`${ADDR}-${n}`, `job-${n}`, LONG_CAPTION);
      runner.job(`job-${n}`, { state: "reading" });
      ids.push(await save(env, ann, `${ADDR}-${n}`));
      advance(1000);
    }
    await runMinute(env);
    expect([1, 2, 3, 4, 5, 6].map((n) => runner.asked(`job-${n}`))).toEqual([1, 1, 1, 1, 1, 0]);
    // The oldest one finishes: the sixth is asked about next.
    runner.job("job-1", done(SPOKEN));
    await runMinute(env);
    expect([1, 2, 3, 4, 5, 6].map((n) => runner.asked(`job-${n}`))).toEqual([2, 2, 2, 2, 2, 0]);
    await runMinute(env);
    expect([1, 2, 3, 4, 5, 6].map((n) => runner.asked(`job-${n}`))).toEqual([2, 3, 3, 3, 3, 1]);
  });

  it("K25: a job asked about goes to the address of the reader service, and nothing but the job id is sent", async () => {
    const { env, runner, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", { state: "reading" });
    await save(env, ann, ADDR);
    await runMinute(env);
    const questions = runner.calls.filter((c) => c.path.startsWith("/jobs/"));
    expect(questions).toEqual([{ method: "GET", path: "/jobs/job-1", auth: `Bearer ${KEY}`, accept: "application/json" }]);
    // The reader service turned off: no question goes out, and the wait ends at its deadline.
    await call(env, "PUT", "/admin/fetch", { token: ADMIN, body: { jina: { enabled: false } } });
    await runMinute(env);
    expect(runner.asked("job-1")).toBe(1);
    await cancelJob(env, "job-1"); // a cancel still goes out: the job exists
    expect(runner.asked("job-1", "DELETE")).toBe(1);
    expect(await fetchContent(env, ADDR)).toMatchObject({ path: "none" });
  });

  it("an admin's test read starts no wait: a job the runner began is cancelled", async () => {
    const { env, runner } = await world();
    runner.reading(ADDR, "job-test", SHORT_CAPTION);
    const r = await call(env, "POST", "/admin/fetch/test", { token: ADMIN, body: { provider: "jina", url: ADDR } });
    expect(r.json).toMatchObject({ provider: "jina", ok: true, title: "松木置物架" });
    expect(runner.asked("job-test", "DELETE")).toBe(1);
    expect(await db(env, "SELECT id FROM items")).toEqual([]);
  });
});

describe("K25 what the words of a video are, and where they are not", () => {
  it("the recognized text is in the item, the export and the context of an assistant; not in lists, search, digests or notifications", async () => {
    const { env, runner, modelCalls, ann } = await world();
    runner.reading(ADDR, "job-1", LONG_CAPTION);
    runner.job("job-1", done(SPOKEN));
    const id = await save(env, ann, ADDR);
    await runMinute(env);
    expect((await detail(env, ann, id)).recognized_text).toBe(SPOKEN);

    // The export.
    const exported = (await call(env, "GET", "/v1/export", { token: ann.token })).json;
    expect(exported.items).toHaveLength(1);
    expect(exported.items[0]).toMatchObject({ id, video_state: "recognized", recognized_text: SPOKEN, body: LONG_CAPTION });
    expect(exported.contents.included.join(" ")).toContain("recognized text");

    // The context of an assistant, through the tool and through REST; and the same two words for an item that has no video.
    const chat = await connectAssistant(env, ann, { name: "Talker", kind: "chat", scope: "deep_dive" });
    const ctx = await tool(env, chat.access, "get_context", { id, for: "deep_dive" });
    expect(ctx.data.item).toMatchObject({ id, body: LONG_CAPTION, recognized_text: SPOKEN, video_state: "recognized" });
    expect((await call(env, "GET", `/v1/assistant/items/${id}/context?for=deep_dive`, { token: chat.access })).json).toEqual(ctx.data);
    const plain = await saveText(env, ann.token, "Green tea likes cooler water.", "Brewing green tea");
    expect((await tool(env, chat.access, "get_context", { id: plain, for: "deep_dive" })).data.item).toMatchObject({ recognized_text: null, video_state: null });

    // Lists and search carry the state of the video, never its words.
    for (const path of ["/v1/items?state=today", "/v1/items?state=pinned", "/v1/items/search?q=%E7%BD%AE%E7%89%A9%E6%9E%B6"]) {
      const r = await call(env, "GET", path, { token: ann.token });
      expect(r.text, path).not.toContain("QUOKKAMARKER");
      expect(r.text, path).not.toContain("recognized_text");
    }
    expect((await call(env, "GET", "/v1/items/search?q=%E7%BD%AE%E7%89%A9%E6%9E%B6", { token: ann.token })).json.items[0]).toMatchObject({ id, video_state: "recognized" });

    // The daily digest, from the model's input to what the user reads; and the notification.
    advance(9 * HOUR);
    await runMinute(env);
    const digestCall = modelCalls.find((c) => kinds([c])[0] === "digest");
    expect(digestCall).toBeDefined();
    expect(JSON.stringify(digestCall.request)).not.toContain("QUOKKAMARKER");
    const digest = await call(env, "GET", "/v1/digests/latest", { token: ann.token });
    expect(digest.status).toBe(200);
    expect(digest.text).not.toContain("QUOKKAMARKER");
    const [user] = await db(env, "SELECT * FROM users WHERE id = ?", ann.userId);
    await db(env, "UPDATE items SET viewed_at = NULL WHERE id = ?", id); // opening the item above counted as seeing it
    const note = await composeNotification(env, user, [{ item_id: id, step: "analysis" }]);
    expect(note?.body).toContain("松木置物架");
    expect(note?.body).not.toContain("QUOKKAMARKER");
  });

  it("the analysis is shown the author's text first and the beginning of the recognized text", () => {
    expect(shownText("short", null)).toEqual({ content: "short" });
    expect(shownText(null, SPOKEN)).toEqual({ content: "", recognized_text: SPOKEN });
    const big = shownText("a".repeat(30_000), "b".repeat(30_000));
    expect(big.content).toHaveLength(16_000);
    expect(big.recognized_text).toHaveLength(8_000);
    const small = shownText("a".repeat(2_000), "b".repeat(30_000));
    expect(small.content).toHaveLength(2_000);
    expect(small.recognized_text).toHaveLength(22_000);
    expect(shownText("a".repeat(30_000), "b".repeat(100))).toEqual({ content: "a".repeat(23_900), recognized_text: "b".repeat(100) });
  });

  it("the limits and the words the clients show are served from the contract", async () => {
    const meta = (await call(makeEnv(), "GET", "/v1/meta")).json;
    expect(meta.limits).toMatchObject({ video_max_minutes: 15, video_wait_minutes: 60 });
    expect(meta.shared_rules.video.reading.en).toBe("Reading what is said in the video. The analysis follows when it is done.");
    expect(meta.shared_rules.video.too_long.zh).toContain("{minutes}");
    expect(Object.keys(meta.shared_rules.video).sort()).toEqual(["description", "no_speech", "reading", "recognized_text_label", "recognized_text_note", "too_long", "unavailable"]);
  });
});

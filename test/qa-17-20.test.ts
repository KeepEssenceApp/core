// Internal QA round of 2026-11-25: #18 (language of analyses), #19 (titles cut without an
// ellipsis), #20 (uploaded text files never analysed; retries without end).
import { describe, expect, it } from "vitest";
import { runMinute } from "../src/cron";
import { fileBlock } from "../src/builtin";
import { decodeText } from "../src/services/assets";
import { firstSentence } from "../src/util";
import { builtinModel, call, db, idem, invite, LLM, loginCode, makeEnv, saveText, signIn, TZ, type Outbound } from "./helpers";

const enc = new TextEncoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = enc.encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

async function sha(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uploads a file the way a client does and saves it as an item. */
async function saveFile(env: any, token: string, bytes: Uint8Array, type: string, kind: "image" | "file", title: string): Promise<string> {
  const up = await call(env, "POST", "/v1/assets", { token, body: { sha256: await sha(bytes), bytes: bytes.byteLength, content_type: type } });
  await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": type } });
  const done = await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token });
  if (done.status !== 204) throw new Error("upload failed " + done.text);
  const saved = await call(env, "POST", "/v1/items", { token, body: { kind, asset_id: up.json.asset_id, title }, idem: idem() });
  if (saved.status !== 201) throw new Error("save failed " + saved.text);
  return saved.json.item_id;
}

const item = async (env: any, token: string, id: string) => (await call(env, "GET", `/v1/items/${id}`, { token })).json;
const analyses = (calls: any[]) => calls.filter((c) => c.request.system.startsWith("You analyse"));

describe("QA #20: uploaded files are read, and a failing analysis stops after three attempts", () => {
  it("QA #20: a text file gets its content as the body when it is saved, and is analysed", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    // A byte-order mark in front, Windows line ends, Chinese text.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("Upload test line one.\r\n第二行是中文。\r\n")]);
    const id = await saveFile(env, ann.token, bytes, "text/plain", "file", "test-upload.txt");
    const saved = await item(env, ann.token, id);
    expect(saved.body).toBe("Upload test line one.\n第二行是中文。");
    expect(saved.asset_id).toBeTruthy();
    expect(saved.title).toBe("test-upload.txt");

    await runMinute(env);
    const [request] = analyses(calls).map((c) => c.request);
    // The text itself goes to the model; no file block that the model would have to fetch.
    expect(typeof request.messages[0].content).toBe("string");
    expect(JSON.parse(request.messages[0].content).content).toBe("Upload test line one.\n第二行是中文。");
    const got = await item(env, ann.token, id);
    expect(got.stage).toBe("analysed");
    expect(got.analysis).toMatchObject({ unavailable: false, summary: "About: test-upload.txt" });
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json.waiting).toBe(0);
  });

  it("QA #20: a Markdown file without a title is named after its first sentence, and every assistant gets the text in the item context", async () => {
    const off = makeEnv();
    const ann = await signIn(off);
    const bytes = enc.encode("# Notes on tea\n\nGreen tea likes cooler water. Steep it for two minutes.\n");
    const up = await call(off, "POST", "/v1/assets", { token: ann.token, body: { sha256: await sha(bytes), bytes: bytes.byteLength, content_type: "text/markdown" } });
    await call(off, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": "text/markdown" } });
    await call(off, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token: ann.token });
    const saved = await call(off, "POST", "/v1/items", { token: ann.token, body: { kind: "file", asset_id: up.json.asset_id }, idem: idem() });
    const got = await item(off, ann.token, saved.json.item_id);
    expect(got.title).toBe("# Notes on tea Green tea likes cooler water.");
    expect(got.body).toContain("Steep it for two minutes.");
    const [row] = await db(off, "SELECT opening FROM items WHERE id = ?", saved.json.item_id);
    expect(row.opening).toContain("Green tea likes cooler water");
  });

  it("QA #20: a text file saved before the fix gets its body the first time an assistant asks for it", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    const id = await saveFile(env, ann.token, enc.encode("An older upload, never read."), "text/plain", "file", "older.txt");
    await env.DB.prepare("UPDATE items SET body = NULL, opening = '' WHERE id = ?").bind(id).run();
    await runMinute(env);
    expect(JSON.parse(analyses(calls)[0].request.messages[0].content).content).toBe("An older upload, never read.");
    expect((await item(env, ann.token, id)).body).toBe("An older upload, never read.");
    expect((await item(env, ann.token, id)).stage).toBe("analysed");
  });

  it("QA #20: invalid bytes and a byte-order mark do not stop a text file from being read", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("good "), 0xff, 0xfe, ...enc.encode(" still good"), 0]);
    expect(decodeText(bytes, 1000)).toBe("good �� still good");
    expect(decodeText(enc.encode("abcdef"), 3)).toBe("abc");
    expect(decodeText(new Uint8Array([]), 10)).toBe("");
  });

  it("QA #20: an image and a PDF go to the model as blocks that point at the core's signed https download address", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    const image = await saveFile(env, ann.token, PNG, "image/png", "image", "Screenshot");
    // A PDF saved as kind "file"; and an image saved as kind "file" still goes as an image.
    const pdf = await saveFile(env, ann.token, PDF, "application/pdf", "file", "Paper.pdf");
    const jpeg = await saveFile(env, ann.token, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]), "image/jpeg", "file", "Photo");
    await runMinute(env);

    const byTitle = new Map(analyses(calls).map((c) => [JSON.parse(c.request.messages[0].content[1].text).title, c.request.messages[0].content]));
    expect([...byTitle.keys()].sort()).toEqual(["Paper.pdf", "Photo", "Screenshot"]);
    const shot = byTitle.get("Screenshot");
    expect(shot).toHaveLength(2);
    expect(shot[0]).toEqual({ type: "image", source: { type: "url", url: expect.stringMatching(/^https:\/\/app\.test\/v1\/downloads\/fil_[\w-]+\?u=usr_[\w-]+&exp=\d+&sig=[0-9a-f]{64}$/) } });
    expect(shot[1].type).toBe("text");
    const paper = byTitle.get("Paper.pdf");
    expect(paper[0]).toEqual({ type: "document", source: { type: "url", url: expect.stringMatching(/^https:\/\/app\.test\/v1\/downloads\/fil_/) } });
    expect(paper[1].type).toBe("text");
    expect(byTitle.get("Photo")[0].type).toBe("image");
    // The address needs no credential, so the model can fetch it, and it serves the file with its type.
    const fetched = await call(env, "GET", paper[0].source.url, { token: null });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("application/pdf");
    for (const id of [image, pdf, jpeg]) expect((await item(env, ann.token, id)).stage).toBe("analysed");

    // Only an https address is handed to the model, and only for a type it can look at.
    expect(fileBlock("image/webp", "https://core.example/v1/downloads/x")).toEqual({ type: "image", source: { type: "url", url: "https://core.example/v1/downloads/x" } });
    expect(fileBlock("application/pdf", "http://localhost:8801/v1/downloads/x")).toBeNull();
    expect(fileBlock("text/plain", "https://core.example/v1/downloads/x")).toBeNull();
    expect(fileBlock("image/png", null)).toBeNull();
  });

  it("QA #20: a model that always fails is asked three times, then the item ends as 'content could not be read' and the queue moves on", async () => {
    const calls: any[] = [];
    const model = builtinModel(calls);
    let analysisCalls = 0;
    const outbound: Outbound = async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.system.startsWith("You analyse")) {
        analysisCalls++;
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "boom" } }, { status: 422 });
      }
      return model(url, init);
    };
    const env = makeEnv({ ...LLM, OUTBOUND: outbound });
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "A text the model chokes on.");

    await runMinute(env);
    expect(analysisCalls).toBe(1);
    expect((await item(env, ann.token, id)).analysis).toBeNull();
    expect(await db(env, "SELECT analysis_attempts FROM items WHERE id = ?", id)).toEqual([{ analysis_attempts: 1 }]);
    await runMinute(env);
    expect(analysisCalls).toBe(2);
    expect((await item(env, ann.token, id)).analysis).toBeNull();
    await runMinute(env);
    expect(analysisCalls).toBe(3);
    // The third failure is handed in through the normal submit path, signed by the built-in assistant.
    const got = await item(env, ann.token, id);
    expect(got.stage).toBe("analysed");
    expect(got.analysis).toMatchObject({ unavailable: true, summary: "Content could not be read" });
    expect(got.analysis.assistant.name).toBe("Built-in assistant");
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json.waiting).toBe(0);
    expect(await db(env, "SELECT id FROM items WHERE claim_id IS NOT NULL")).toHaveLength(0);
    // It is never asked about again.
    for (let i = 0; i < 4; i++) await runMinute(env);
    expect(analysisCalls).toBe(3);

    // An item saved later is still worked on: the queue moved on.
    const next = await saveText(env, ann.token, "Another text.");
    await runMinute(env);
    expect(analysisCalls).toBe(4);
    expect(await db(env, "SELECT analysis_attempts FROM items WHERE id = ?", next)).toEqual([{ analysis_attempts: 1 }]);
  });

  it("QA #20: an answer that never fits the four fields also stops after three attempts, in the user's language", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: () => "I would rather write an essay." }) });
    const li = await signIn(env, "li@example.com", "zh");
    const id = await saveText(env, li.token, "一段模型总是答不好的文字。");
    for (let i = 0; i < 6; i++) await runMinute(env);
    expect(analyses(calls)).toHaveLength(3);
    expect((await item(env, li.token, id)).analysis).toMatchObject({ unavailable: true, summary: "内容读不出来" });
  });

  it("QA #20: a file with nothing to read is reported as unavailable at once, without asking the model", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    const id = await saveFile(env, ann.token, enc.encode("   \n\n  "), "text/plain", "file", "blank.txt");
    await runMinute(env);
    await runMinute(env);
    expect(analyses(calls)).toHaveLength(0);
    expect((await item(env, ann.token, id)).analysis).toMatchObject({ unavailable: true });
  });
});

describe("QA #18: analyses and digests are written in the account's language", () => {
  it("QA #18: (a) PATCH /v1/settings writes the language, and (b) the built-in assistant reads it at analysis time", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env); // an English account
    await saveText(env, ann.token, "中文测试笔记 — 明天上午十点和产品团队开会。");
    await runMinute(env);
    // The account's language decides, not the language of the content.
    expect(analyses(calls)[0].request.system).toContain("Write in English");

    const patched = await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "zh" } });
    expect(patched.status).toBe(200);
    expect(patched.json.lang).toBe("zh");
    expect((await call(env, "GET", "/v1/settings", { token: ann.token })).json.lang).toBe("zh");
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).json.user.lang).toBe("zh");

    // The next analysis is written in Chinese, although this English text is saved with an
    // English Accept-Language: neither the content nor the request decides.
    await saveText(env, ann.token, "An English note saved after the switch.");
    await runMinute(env);
    expect(analyses(calls)).toHaveLength(2);
    expect(analyses(calls)[1].request.system).toContain("Write in 简体中文");
    expect(analyses(calls)[1].request.system).not.toContain("English");
    // The earlier analysis is not rewritten.
    expect((await db(env, "SELECT COUNT(*) AS n FROM analyses"))[0].n).toBe(2);
  });

  it("QA #18: (b) the daily digest follows the language the account has when it is written", async () => {
    const { advance, MINUTE } = await import("../src/clock");
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    await saveText(env, ann.token, "A thought before the switch.");
    await runMinute(env);
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "zh" } });
    advance(9 * 60 * MINUTE + 5 * MINUTE); // 21:05
    await runMinute(env);
    const digest = calls.find((c) => c.request.system.startsWith("You write"));
    expect(digest.request.system).toContain("Write in 简体中文");
  });

  it("QA #18: (c) a new account gets the language of the sign-in page that asked for the code, whatever the browser's Accept-Language says", async () => {
    const env = makeEnv();
    await invite(env, "li@example.com");
    // The web app sends its interface language with the code request.
    const asked = await call(env, "POST", "/v1/auth/email-codes", { body: { email: "li@example.com", lang: "zh" }, headers: { "accept-language": "en-US,en;q=0.9" } });
    expect(asked.status).toBe(202);
    expect(await db(env, "SELECT lang FROM login_codes WHERE email = 'li@example.com'")).toEqual([{ lang: "zh" }]);
    // The operator hands the code out (no mail provider): the fresh code keeps the page's language.
    const code = await loginCode(env, "li@example.com");
    expect(await db(env, "SELECT lang FROM login_codes WHERE email = 'li@example.com'")).toEqual([{ lang: "zh" }]);
    const r = await call(env, "POST", "/v1/auth/sessions", {
      body: { email: "li@example.com", code, device_name: "Laptop", client: "web", timezone: TZ },
      headers: { "accept-language": "en-US,en;q=0.9" },
    });
    expect(r.status).toBe(201);
    expect(r.json.user.lang).toBe("zh");
    expect((await call(env, "GET", "/v1/settings", { token: r.json.credential })).json.lang).toBe("zh");
    expect((await call(env, "GET", "/v1/assistants", { token: r.json.credential })).json.assistants[0].name).toBe("内置助手");
  });

  it("QA #18: (c) without a language in the code request the sign-in request's own language is used, and an existing account keeps its language", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const code = await loginCode(env, "ann@example.com");
    const first = await call(env, "POST", "/v1/auth/sessions", { body: { email: "ann@example.com", code, device_name: "Laptop", client: "web", timezone: TZ }, headers: { "accept-language": "zh-CN" } });
    expect(first.json.user.lang).toBe("zh");
    // Signing in again from an English page does not change the account.
    await call(env, "POST", "/v1/auth/email-codes", { body: { email: "ann@example.com", lang: "en" } });
    const again = await loginCode(env, "ann@example.com");
    const second = await call(env, "POST", "/v1/auth/sessions", { body: { email: "ann@example.com", code: again, device_name: "Phone", client: "web", timezone: TZ }, headers: { "accept-language": "en" } });
    expect(second.status).toBe(201);
    expect(second.json.user.lang).toBe("zh");
  });
});

describe("QA #19: a title made from the first sentence ends with an ellipsis when it is cut", () => {
  const QA = "Mixed language test 混合语言测试 — Please review the Q3 report 第三季度报告 before Friday 周五之前。";

  it("QA #19: the first sentence is cut at a word or clause boundary and marked with …", () => {
    expect([...QA].length).toBeGreaterThan(80);
    const title = firstSentence(QA);
    expect([...title].length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    // Everything before the mark is the start of the text, and it stops after a whole word.
    const kept = title.slice(0, -1);
    expect(QA.startsWith(kept)).toBe(true);
    expect(/\s$/.test(kept)).toBe(false);
    expect(QA[kept.length]).toBe(" ");
    expect(title).toBe("Mixed language test 混合语言测试 — Please review the Q3 report 第三季度报告 before Friday…");
    // A sentence that fits is left as it is, with no mark.
    expect(firstSentence("Short enough。 And more.")).toBe("Short enough。");
    expect(firstSentence("绿茶要用低一点的水温。泡两分钟。")).toBe("绿茶要用低一点的水温。");
    // Chinese without spaces is cut at a clause mark when one is near.
    const zh = "卡片盒是用编号、标签和交叉引用连接小卡片的个人知识管理与写作方法，历史可追溯到十六至十七世纪的学者，后来影响了超文本软件和许多现代笔记工具的设计思路与使用方式，至今仍被研究者使用。";
    const cut = firstSentence(zh);
    expect([...cut].length).toBeLessThanOrEqual(80);
    expect(cut.endsWith("…")).toBe(true);
    expect(/[，、]…$/.test(cut)).toBe(false);
  });

  it("QA #19: a saved text without a title gets the marked title in the list and on the item, and keeps its full text", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, QA);
    const got = (await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json;
    expect(got.title).toBe("Mixed language test 混合语言测试 — Please review the Q3 report 第三季度报告 before Friday…");
    expect(got.body).toBe(QA);
    const list = (await call(env, "GET", "/v1/items?state=today", { token: ann.token })).json.items;
    expect(list[0].title).toBe(got.title);
    // A title the client gives is kept whole.
    const titled = await saveText(env, ann.token, "Body.", QA);
    expect((await call(env, "GET", `/v1/items/${titled}`, { token: ann.token })).json.title).toBe(QA);
  });
});

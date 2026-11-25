import { describe, expect, it } from "vitest";
import { advance, MINUTE, SECOND } from "../src/clock";
import { runMinute } from "../src/cron";
import { builtinActor } from "../src/services/accounts";
import { claimWork, submitResults } from "../src/services/work";
import { b64url, fromB64url } from "../src/util";
import { analysed, builtinModel, call, connectDevice, db, LLM, makeEnv, saveText, signIn, withHelper, type Outbound, type Session } from "./helpers";

const enc = new TextEncoder();

async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { VAPID_PRIVATE_KEY: jwk.d!, VAPID_PUBLIC_KEY: b64url(raw), publicKey: pair.publicKey };
}

/** A browser's push subscription: its key pair, its auth secret, and how to read what arrives. */
async function subscriber(name: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bits: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bits));
  const cat = (...p: Uint8Array[]) => {
    const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of p) (out.set(x, at), (at += x.length));
    return out;
  };
  return {
    target: { kind: "webpush", endpoint: `https://push.example.net/send/${name}`, keys: { p256dh: b64url(pub), auth: b64url(auth) } },
    async read(body: Uint8Array): Promise<any> {
      const salt = body.slice(0, 16);
      const idLen = body[20];
      const asPub = body.slice(21, 21 + idLen);
      const cipher = body.slice(21 + idLen);
      const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, pair.privateKey, 256));
      const ikm = await hkdf(auth, secret, cat(enc.encode("WebPush: info\0"), pub, asPub), 256);
      const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 128);
      const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 96);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), cipher));
      return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
    },
  };
}

interface Push {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

async function setup(pushStatus: (url: string, n: number) => number = () => 201) {
  const keys = await vapidKeys();
  const pushes: Push[] = [];
  const model = builtinModel();
  const outbound: Outbound = async (url, init) => {
    if (url.includes("model.test")) return model(url, init);
    pushes.push({ url, headers: init!.headers as Record<string, string>, body: new Uint8Array(init!.body as ArrayBuffer) });
    return new Response(null, { status: pushStatus(url, pushes.length) });
  };
  const env = makeEnv({ ...LLM, VAPID_PRIVATE_KEY: keys.VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY: keys.VAPID_PUBLIC_KEY, OUTBOUND: outbound });
  const ann = await signIn(env);
  const sub = await subscriber("ann-browser");
  expect((await call(env, "PUT", "/v1/devices/me/push", { token: ann.token, body: sub.target })).status).toBe(204);
  return { env, ann, sub, pushes, keys };
}

async function later(env: any, ms: number) {
  advance(ms);
  await runMinute(env);
}

describe("K18 notifications", () => {
  it("K18 notify: one sentence two minutes after the built-in assistant finished an analysis, encrypted for the device", async () => {
    const { env, ann, sub, pushes, keys } = await setup();
    expect((await call(env, "GET", "/v1/push/key", { token: ann.token })).json.public_key).toBe(keys.VAPID_PUBLIC_KEY);
    const id = await saveText(env, ann.token, "Green tea likes cooler water.", "Brewing green tea");
    await runMinute(env); // triage, analysis; the batch starts waiting
    expect(pushes).toHaveLength(0);
    await later(env, 119 * SECOND);
    expect(pushes).toHaveLength(0);
    await later(env, 2 * SECOND);
    expect(pushes).toHaveLength(1);
    const p = pushes[0];
    expect(p.url).toBe("https://push.example.net/send/ann-browser");
    expect(p.headers["content-encoding"]).toBe("aes128gcm");
    expect(p.headers.ttl).toBe("86400");
    // The payload can be read with the subscription's keys, and only says the one thing.
    expect(await sub.read(p.body)).toEqual({ body: "The analysis of “Brewing green tea” is ready. You can see the verdict.", count: 1, item_id: id, kind: "analysis" });
    expect(new TextDecoder().decode(p.body)).not.toContain("Brewing");
    // VAPID: an ES256 JWT for the push service's origin, signed with the server key.
    const m = p.headers.authorization.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/)!;
    expect(m[4]).toBe(keys.VAPID_PUBLIC_KEY);
    expect(JSON.parse(new TextDecoder().decode(fromB64url(m[1])))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2])));
    expect(claims.aud).toBe("https://push.example.net");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey, fromB64url(m[3]), enc.encode(`${m[1]}.${m[2]}`))).toBe(true);
    // Said once, never repeated.
    await later(env, 10 * MINUTE);
    expect(pushes).toHaveLength(1);
    expect(await db(env, "SELECT * FROM notify_batches")).toEqual([]);
  });

  it("K18 notify: results that arrive close together are merged; each new one extends the wait by two minutes", async () => {
    const { env, ann, sub, pushes } = await setup();
    await saveText(env, ann.token, "First.");
    await runMinute(env); // t = 0
    advance(90 * SECOND);
    await saveText(env, ann.token, "Second.");
    await runMinute(env); // t = 90 s: second analysis
    await later(env, 60 * SECOND); // t = 150 s: more than 2 minutes after the first, less after the second
    expect(pushes).toHaveLength(0);
    await later(env, 61 * SECOND); // t = 211 s
    expect(pushes).toHaveLength(1);
    expect(await sub.read(pushes[0].body)).toEqual({ body: "2 analyses are ready.", count: 2, item_id: null, kind: "analysis" });
  });

  it("K18 notify: the wait never exceeds ten minutes from the first result", async () => {
    const { env, ann, sub, pushes } = await setup();
    for (let i = 0; i < 6; i++) {
      await saveText(env, ann.token, `Thought ${i}.`);
      await runMinute(env); // a new analysis every 100 seconds keeps extending the wait
      advance(100 * SECOND);
    }
    expect(pushes).toHaveLength(0); // t = 600 s exactly at the end of the loop
    await runMinute(env);
    expect(pushes).toHaveLength(1);
    expect((await sub.read(pushes[0].body)).count).toBe(6);
  });

  it("K18 notify: only the built-in assistants trigger it — the user's own assistant never does, and triage never does", async () => {
    const { env, ann, pushes } = await setup();
    const { connectAssistant, claim, submit, analysis, coreTriage } = await import("./helpers");
    const helper = await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps: ["analysis"] });
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { roles: { analysis: helper.assistantId } } });
    const id = await saveText(env, ann.token, "For my own assistant.");
    await runMinute(env); // the built-in dispatch assistant triages it
    const c = await claim(env, helper.access, "analysis");
    await submit(env, helper.access, c.claim_id, [analysis(id)]);
    expect(await db(env, "SELECT * FROM notify_batches")).toEqual([]);
    await later(env, 11 * MINUTE);
    expect(pushes).toHaveLength(0);
    expect(coreTriage).toBeTruthy();
  });

  it("K18 notify: what the user already opened, marked or queued is left out; if nothing is left, nothing is sent", async () => {
    const { env, ann, sub, pushes } = await setup();
    const opened = await saveText(env, ann.token, "Opened.");
    const marked = await saveText(env, ann.token, "Marked.");
    const queued = await saveText(env, ann.token, "Queued.");
    const deleted = await saveText(env, ann.token, "Deleted.");
    await runMinute(env);
    await runMinute(env); // two per run
    await call(env, "GET", `/v1/items/${opened}`, { token: ann.token });
    await call(env, "PUT", `/v1/items/${marked}/signal`, { token: ann.token, body: { signal: "seen" } });
    await call(env, "PUT", `/v1/deep-read-queue/${queued}`, { token: ann.token });
    await call(env, "DELETE", `/v1/items/${deleted}`, { token: ann.token });
    await later(env, 3 * MINUTE);
    expect(pushes).toHaveLength(0);
    expect(await db(env, "SELECT * FROM notify_batches")).toEqual([]);
    // With one left untouched, the sentence is about that one only.
    const a = await saveText(env, ann.token, "Left alone.", "Left alone");
    const b = await saveText(env, ann.token, "Looked at.");
    await runMinute(env);
    await call(env, "GET", `/v1/items/${b}`, { token: ann.token });
    await later(env, 3 * MINUTE);
    expect(pushes).toHaveLength(1);
    expect(await sub.read(pushes[0].body)).toMatchObject({ count: 1, item_id: a });
  });

  it("K18 notify: it goes to read and manage devices that registered, each once; not to save-only devices or devices that did not register", async () => {
    const { env, ann, pushes } = await setup();
    const reader = await connectDevice(env, ann, "read");
    const silent = await connectDevice(env, ann, "read");
    const saver = await connectDevice(env, ann, "save");
    const readerSub = await subscriber("reader");
    expect((await call(env, "PUT", "/v1/devices/me/push", { token: reader.token, body: readerSub.target })).status).toBe(204);
    expect((await call(env, "PUT", "/v1/devices/me/push", { token: saver.token, body: (await subscriber("saver")).target })).status).toBe(403);
    expect((await call(env, "PUT", "/v1/devices/me/push", { token: reader.token, body: { ...readerSub.target, endpoint: "http://127.0.0.1/push" } })).status).toBe(400);
    const list = (await call(env, "GET", "/v1/devices", { token: ann.token })).json.devices;
    expect(Object.fromEntries(list.map((d: any) => [d.id, d.notifications]))).toEqual({ [ann.deviceId]: true, [reader.deviceId]: true, [silent.deviceId]: false, [saver.deviceId]: false });
    await saveText(env, ann.token, "A thought.");
    await runMinute(env);
    await later(env, 3 * MINUTE);
    expect(pushes.map((p) => p.url).sort()).toEqual(["https://push.example.net/send/ann-browser", "https://push.example.net/send/reader"]);
    // A device lowered to save-only, one that unregistered, and a revoked one get nothing any more.
    await call(env, "PATCH", `/v1/devices/${reader.deviceId}`, { token: ann.token, body: { tier: "save" } });
    await call(env, "DELETE", "/v1/devices/me/push", { token: ann.token });
    await saveText(env, ann.token, "Another thought.");
    await runMinute(env);
    await later(env, 3 * MINUTE);
    expect(pushes).toHaveLength(2);
  });

  it("K18 notify: the user's switch — off means nothing is collected and what was waiting is dropped", async () => {
    const { env, ann, pushes } = await setup();
    await saveText(env, ann.token, "Before switching off.");
    await runMinute(env);
    expect(await db(env, "SELECT user_id FROM notify_batches")).toHaveLength(1);
    const reader = await connectDevice(env, ann, "read");
    expect((await call(env, "PATCH", "/v1/settings", { token: reader.token, body: { notify: false } })).status).toBe(403);
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { notify: false } })).json.notify).toBe(false);
    expect(await db(env, "SELECT user_id FROM notify_batches")).toEqual([]);
    await saveText(env, ann.token, "While off.");
    await runMinute(env);
    await later(env, 11 * MINUTE);
    expect(pushes).toHaveLength(0);
  });

  it("K18 notify: a target the push service reports gone is deleted; a failed send is retried once", async () => {
    const gone = await setup(() => 410);
    await saveText(gone.env, gone.ann.token, "A thought.");
    await runMinute(gone.env);
    await later(gone.env, 3 * MINUTE);
    expect(gone.pushes).toHaveLength(1);
    expect(await db(gone.env, "SELECT device_id FROM push_targets")).toEqual([]);

    const flaky = await setup((_, n) => (n === 1 ? 503 : 201));
    await saveText(flaky.env, flaky.ann.token, "Another thought.");
    await runMinute(flaky.env);
    await later(flaky.env, 3 * MINUTE);
    expect(flaky.pushes).toHaveLength(2);
    expect(await db(flaky.env, "SELECT device_id FROM push_targets")).toHaveLength(1);
  });

  it("K18 notify: a deep read finished by a built-in assistant is announced too, and merged with analyses as 'items'", async () => {
    const { env, ann, sub, pushes } = await setup();
    // Give the built-in assistant the deep-read step for this test (in production it has analysis and digest).
    const worker = (await builtinActor(env, ann.userId, "worker"))!;
    await env.DB.prepare("UPDATE assistants SET steps = '[\"analysis\",\"digest\",\"deep_read\"]' WHERE id = ?").bind(worker.assistantId).run();
    await env.DB.prepare("UPDATE users SET role_deep_read = ? WHERE id = ?").bind(worker.assistantId, ann.userId).run();
    const actor = (await builtinActor(env, ann.userId, "worker"))!;
    const id = await saveText(env, ann.token, "Read me closely.", "A long read");
    await runMinute(env);
    await call(env, "PUT", `/v1/deep-read-queue/${id}`, { token: ann.token });
    const c = await claimWork(env, actor, "deep_read");
    await submitResults(env, actor, c.claim_id!, [{ kind: "deep_read", item_id: id, read: "It says…", found: "Also…", questions: [] }], undefined, "en");
    await later(env, 3 * MINUTE);
    expect(await sub.read(pushes[0].body)).toEqual({ body: "The deep read of “A long read” is ready. See it in the deep-dive queue.", count: 1, item_id: id, kind: "deep_read" });
    // Taken out of the queue before the notification is due: not announced.
    const id2 = await saveText(env, ann.token, "Another.", "Another read");
    await runMinute(env);
    await call(env, "GET", `/v1/items/${id2}`, { token: ann.token });
    await call(env, "PUT", `/v1/deep-read-queue/${id2}`, { token: ann.token });
    const c2 = await claimWork(env, actor, "deep_read");
    await submitResults(env, actor, c2.claim_id!, [{ kind: "deep_read", item_id: id2, read: "r", found: "f", questions: [] }], undefined, "en");
    await call(env, "DELETE", `/v1/deep-read-queue/${id2}`, { token: ann.token });
    await later(env, 3 * MINUTE);
    expect(pushes).toHaveLength(1);
  });

  it("K18 notify: the sentences come from the contract, in the user's language", async () => {
    const keys = await vapidKeys();
    const pushes: Push[] = [];
    const model = builtinModel();
    const env = makeEnv({
      ...LLM,
      VAPID_PRIVATE_KEY: keys.VAPID_PRIVATE_KEY,
      VAPID_PUBLIC_KEY: keys.VAPID_PUBLIC_KEY,
      OUTBOUND: async (url, init) => {
        if (url.includes("model.test")) return model(url, init);
        pushes.push({ url, headers: init!.headers as any, body: new Uint8Array(init!.body as ArrayBuffer) });
        return new Response(null, { status: 201 });
      },
    });
    const li: Session = await signIn(env, "li@example.com", "zh");
    const sub = await subscriber("li");
    await call(env, "PUT", "/v1/devices/me/push", { token: li.token, body: sub.target });
    await saveText(env, li.token, "绿茶要用低一点的水温。", "泡绿茶");
    await runMinute(env);
    await later(env, 3 * MINUTE);
    expect((await sub.read(pushes[0].body)).body).toBe("「泡绿茶」的解读好了，可以看判定。");
    expect(withHelper).toBeTruthy();
    expect(analysed).toBeTruthy();
  });
});

describe("K18 notify payload", () => {
  it("K18 notify: the payload has exactly the fields the contract names", async () => {
    const { CONTRACT } = await import("../src/generated/contract");
    expect(CONTRACT.sharedRules.push_payload.fields).toEqual(["body", "count", "item_id", "kind"]);
  });
});

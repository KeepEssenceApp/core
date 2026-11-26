import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followRedirects, guardedLookup, request, type NetRequest, type NetResponse } from "../src/net.ts";

const lookup = (name: string) => new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => guardedLookup(name, { all: true }, (err) => resolve({ err })));
const never = () => new AbortController().signal;

describe("the connect-time check", () => {
  it("a name that leads to this machine is refused at the lookup", async () => {
    const r = await lookup("localhost");
    assert.equal(r.err?.code, "EBLOCKED");
  });

  it("an address that is not public is refused before any lookup, in every spelling", async () => {
    for (const url of ["http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.1.1/", "http://169.254.169.254/", "http://100.64.0.1/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f000001/", "http://localhost/", "http://db.internal/", "file:///etc/passwd", "http://user:pw@example.org/"]) {
      await assert.rejects(request({ url, signal: never(), maxBytes: 1000 }), /not a public address/, url);
    }
  });
});

describe("redirects, followed here", () => {
  const answer = (status: number, location?: string): NetResponse => ({ status, headers: location ? { location } : {}, body: Buffer.from("x") });
  const seen = (table: Record<string, NetResponse>, asked: NetRequest[]) => async (r: NetRequest) => {
    asked.push(r);
    return table[r.url] ?? answer(404);
  };

  it("follows each hop, relative ones too, and says where it ended", async () => {
    const asked: NetRequest[] = [];
    const res = await followRedirects(seen({ "https://a.example.org/1": answer(301, "/2"), "https://a.example.org/2": answer(302, "https://b.example.org/3"), "https://b.example.org/3": answer(200) }, asked), { url: "https://a.example.org/1", signal: never(), maxBytes: 10 });
    assert.equal(res.status, 200);
    assert.equal(res.url, "https://b.example.org/3");
    assert.deepEqual(asked.map((r) => r.url), ["https://a.example.org/1", "https://a.example.org/2", "https://b.example.org/3"]);
  });

  it("asks nothing of a hop that is not public, and stops at the limit", async () => {
    const asked: NetRequest[] = [];
    await assert.rejects(followRedirects(seen({ "https://a.example.org/1": answer(302, "http://169.254.169.254/x") }, asked), { url: "https://a.example.org/1", signal: never(), maxBytes: 10 }), /not a public address/);
    assert.deepEqual(asked.map((r) => r.url), ["https://a.example.org/1"]);
    const loop: Record<string, NetResponse> = { "https://a.example.org/a": answer(302, "/b"), "https://a.example.org/b": answer(302, "/a") };
    await assert.rejects(followRedirects(seen(loop, []), { url: "https://a.example.org/a", signal: never(), maxBytes: 10 }, 3), /too many redirects/);
  });

  it("a POST becomes a GET after a 302 or 303 and stays a POST after a 307", async () => {
    const asked: NetRequest[] = [];
    await followRedirects(seen({ "https://a.example.org/p": answer(302, "/q"), "https://a.example.org/q": answer(307, "/r"), "https://a.example.org/r": answer(200) }, asked), { url: "https://a.example.org/p", method: "POST", body: Buffer.from("k=v"), signal: never(), maxBytes: 10 });
    assert.deepEqual(asked.map((r) => [r.method, r.body ? "body" : "none"]), [["POST", "body"], ["GET", "none"], ["GET", "none"]]);
  });
});

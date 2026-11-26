// QA #101: the proxy on its own, spoken to with raw sockets: who may use it, where it will connect, what it counts.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, it } from "node:test";
import { FilteringProxy, type Resolved } from "../src/proxy.ts";

const PUBLIC: Resolved[] = [{ address: "93.184.216.34", family: 4 }];
let proxy: FilteringProxy | null = null;
const servers: net.Server[] = [];
afterEach(async () => {
  await proxy?.close();
  proxy = null;
  for (const s of servers.splice(0)) s.close();
});

/** A server that echoes, standing in for a public host. */
async function echo(): Promise<number> {
  const s = net.createServer((c) => c.pipe(c).on("error", () => {}));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as net.AddressInfo).port;
}

async function make(over: { lookup?: (h: string) => Promise<Resolved[]>; echoPort?: number; connected?: string[] } = {}) {
  proxy = new FilteringProxy({
    lookup: over.lookup ?? (async () => PUBLIC),
    connect: (ip, port) => {
      over.connected?.push(`${ip}:${port}`);
      return net.connect({ host: "127.0.0.1", port: over.echoPort ?? 1 });
    },
    idleMs: 3000,
  });
  return proxy.listen();
}

/** Sends CONNECT and returns the status line and the socket. */
function connect(port: number, target: string, auth?: { username: string; password: string } | string): Promise<{ status: string; socket: net.Socket }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    const header = auth === undefined ? "" : `Proxy-Authorization: Basic ${Buffer.from(typeof auth === "string" ? auth : `${auth.username}:${auth.password}`).toString("base64")}\r\n`;
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${header}\r\n`);
    socket.once("data", (d) => resolve({ status: d.toString().split("\r\n")[0], socket }));
  });
}

describe("who may use the proxy", () => {
  it("only a read that is open, with its own password", async () => {
    const port = await make({ echoPort: await echo() });
    const read = proxy!.open(1000);
    assert.match((await connect(port, "example.org:443")).status, /407/);
    assert.match((await connect(port, "example.org:443", { username: read.username, password: "wrong" })).status, /407/);
    assert.match((await connect(port, "example.org:443", { username: "nobody", password: read.password })).status, /407/);
    assert.match((await connect(port, "example.org:443", "not:base64:basic")).status, /407/);
    const ok = await connect(port, "example.org:443", read);
    assert.match(ok.status, /200/);
    ok.socket.destroy();
    read.close();
    assert.match((await connect(port, "example.org:443", read)).status, /407/);
    assert.equal(proxy!.openReads(), 0);
  });
});

describe("where it will connect", () => {
  it("not to a private address, in any spelling, a port that is not a web port, or a name that has one private answer among its public ones", async () => {
    const connected: string[] = [];
    const port = await make({
      connected,
      echoPort: await echo(),
      lookup: async (h) => (h === "mixed.example.org" ? [...PUBLIC, { address: "192.168.1.5", family: 4 }] : h === "lan.example.org" ? [{ address: "10.0.0.7", family: 4 }] : h === "v6.example.org" ? [{ address: "fd00::1", family: 6 }] : PUBLIC),
    });
    const read = proxy!.open(1000);
    for (const target of ["127.0.0.1:443", "10.1.2.3:80", "192.168.1.1:443", "169.254.169.254:80", "100.64.0.1:443", "[::1]:443", "[fd00::1]:443", "[fe80::1]:443", "[::ffff:127.0.0.1]:443", "localhost:443", "db.internal:443", "intranet:80", "2130706433:80", "0x7f000001:80", "lan.example.org:443", "v6.example.org:443", "mixed.example.org:443", "example.org:22", "example.org:6379", "example.org:8080", "example.org:0"]) {
      const r = await connect(port, target, read);
      assert.match(r.status, /403/, target);
      r.socket.destroy();
    }
    assert.deepEqual(connected, []);
    // A public name on an ordinary port is let through, and is connected to by the address that was checked.
    const ok = await connect(port, "example.org:443", read);
    assert.match(ok.status, /200/);
    ok.socket.destroy();
    assert.deepEqual(connected, ["93.184.216.34:443"]);
  });

  it("a name is looked up once and the address that was checked is the one connected to", async () => {
    let looked = 0;
    const connected: string[] = [];
    const port = await make({ connected, echoPort: await echo(), lookup: async () => (++looked === 1 ? PUBLIC : [{ address: "127.0.0.1", family: 4 }]) });
    const read = proxy!.open(1000);
    const ok = await connect(port, "flip.example.org:443", read);
    assert.match(ok.status, /200/);
    assert.equal(looked, 1);
    assert.deepEqual(connected, ["93.184.216.34:443"]);
    ok.socket.destroy();
  });

  it("a name that cannot be looked up is refused, not an error that crashes it", async () => {
    const port = await make({
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    const read = proxy!.open(1000);
    assert.match((await connect(port, "nowhere.example.org:443", read)).status, /403/);
  });
});

describe("a read's own tunnels", () => {
  it("carry bytes both ways", async () => {
    const port = await make({ echoPort: await echo() });
    const read = proxy!.open(100000);
    const { socket } = await connect(port, "example.org:443", read);
    const back = new Promise<string>((r) => socket.once("data", (d) => r(d.toString())));
    socket.write("hello through the tunnel");
    assert.equal(await back, "hello through the tunnel");
    assert.ok(read.bytes() >= 2 * "hello through the tunnel".length);
    socket.destroy();
  });

  it("are cut when the read has used its bytes", async () => {
    const port = await make({ echoPort: await echo() });
    const read = proxy!.open(2000);
    const { socket } = await connect(port, "example.org:443", read);
    const closed = new Promise<void>((r) => socket.on("close", () => r()));
    for (let i = 0; i < 20 && !socket.destroyed; i++) {
      socket.write(Buffer.alloc(500, 1));
      await new Promise((r) => setTimeout(r, 20));
    }
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("not cut")), 3000))]);
  });

  it("are all closed when the read is closed, and the read is forgotten", async () => {
    const port = await make({ echoPort: await echo() });
    const read = proxy!.open(100000);
    const a = await connect(port, "a.example.org:443", read);
    const b = await connect(port, "b.example.org:443", read);
    const closed = Promise.all([a, b].map((x) => new Promise<void>((r) => x.socket.on("close", () => r()))));
    assert.equal(proxy!.openReads(), 1);
    read.close();
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("not closed")), 3000))]);
    assert.equal(proxy!.openReads(), 0);
  });
});

describe("plain http:// addresses, which the browser sends whole to the proxy", () => {
  /** A raw `GET http://…` to the proxy, and the whole answer. */
  const get = (port: number, url: string, auth?: { username: string; password: string }): Promise<string> =>
    new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.on("error", () => {});
      let all = "";
      socket.on("data", (d) => (all += d.toString()));
      socket.on("close", () => resolve(all));
      const header = auth ? `Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}\r\n` : "";
      socket.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${header}Connection: close\r\n\r\n`);
    });

  async function web(): Promise<number> {
    const s = http.createServer((req, res) => res.end(`you asked ${req.headers.host}${req.url}`));
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as net.AddressInfo).port;
  }

  it("are asked for by the address that was checked, and the name is never resolved by anything else", async () => {
    const connected: string[] = [];
    // This name is in nobody's DNS: if anything but the proxy's own lookup were asked for it, the request would fail.
    const port = await make({ connected, echoPort: await web() });
    const read = proxy!.open(100000);
    const answer = await get(port, "http://not-in-any-dns.example.org/a/b?c=d", read);
    assert.match(answer, /^HTTP\/1\.1 200/);
    assert.match(answer, /you asked not-in-any-dns\.example\.org\/a\/b\?c=d/);
    assert.deepEqual(connected, ["93.184.216.34:80"]);
  });

  it("are refused without the read's password, to a private address or name, and on a port that is not a web port", async () => {
    const connected: string[] = [];
    const port = await make({ connected, echoPort: await web(), lookup: async (h) => (h === "lan.example.org" ? [{ address: "10.0.0.7", family: 4 }] : PUBLIC) });
    const read = proxy!.open(100000);
    assert.match(await get(port, "http://example.org/"), /^HTTP\/1\.1 407/);
    assert.match(await get(port, "http://example.org/", { username: read.username, password: "wrong" }), /^HTTP\/1\.1 407/);
    for (const url of ["http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://lan.example.org/", "http://example.org:22/", "http://example.org:8080/", "ftp://example.org/"]) {
      assert.match(await get(port, url, read), /^HTTP\/1\.1 (400|403)/, url);
    }
    assert.deepEqual(connected, []);
  });
});

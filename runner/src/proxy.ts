// The only way Chromium reaches anything: through this proxy, on the loopback, with a password of its own.
// Chromium keeps its own network stack (so its TLS and HTTP/2 look like Chrome's, which is what sites that
// turn automation away look at); this proxy decides *where* it may connect.
//
// For every connection it asks: is the host a public one, is the port an ordinary web port, and is every
// address the name resolves to public? It then connects to the address it checked (not to the name again), so a
// name that points into this machine's network, or whose answer changes between two lookups, cannot get through.
// Each read gets its own credentials: the proxy counts the bytes of that read, and closing the read closes every
// connection it opened.
import { randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import { isPublicIp, isPublicUrl } from "../../src/services/publicurl.ts";

export interface Resolved {
  address: string;
  family: number;
}
export type LookupAll = (host: string) => Promise<Resolved[]>;
export type Connect = (ip: string, port: number) => net.Socket;

export interface ProxyOptions {
  /** Names to addresses. Only a test replaces it. */
  lookup?: LookupAll;
  /** The connection to an address already checked. Only a test replaces it. */
  connect?: Connect;
  /** The ports a page may reach: an ordinary web server's. */
  ports?: number[];
  /** A connection with nothing said on it for this long is closed. */
  idleMs?: number;
}

export interface Read {
  username: string;
  password: string;
  /** Bytes that went either way so far. */
  bytes(): number;
  /** Closes every connection of the read, and the read. */
  close(): void;
}

interface State {
  password: string;
  left: number;
  used: number;
  sockets: Set<net.Socket>;
}

const defaultLookup: LookupAll = async (host) => {
  const family = net.isIP(host);
  if (family) return [{ address: host, family }];
  return (await dns.promises.lookup(host, { all: true })) as Resolved[];
};
const defaultConnect: Connect = (ip, port) => net.connect({ host: ip, port });

/** Set on a plain http:// answer the proxy refused to fetch, so that what the proxy refused is told from what a site said. */
export const REFUSED = "x-runner-refused";

const HOP_BY_HOP = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);
const clean = (h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
  return out;
};
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** An agent whose every connection is made by `open`: it never resolves a name or chooses an address. */
class PinnedAgent extends http.Agent {
  private open: () => net.Socket;
  constructor(open: () => net.Socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.open = open;
  }
  override createConnection(_options: unknown, callback?: (err: Error | null, socket: net.Socket) => void): net.Socket {
    const socket = this.open();
    if (callback) callback(null, socket);
    return socket;
  }
}

export class FilteringProxy {
  readonly server: http.Server;
  private reads = new Map<string, State>();
  private lookup: LookupAll;
  private connect: Connect;
  private ports: number[];
  private idleMs: number;

  constructor(opts: ProxyOptions = {}) {
    this.lookup = opts.lookup ?? defaultLookup;
    this.connect = opts.connect ?? defaultConnect;
    this.ports = opts.ports ?? [80, 443];
    this.idleMs = opts.idleMs ?? 20000;
    this.server = http.createServer((req, res) => void this.forward(req, res));
    this.server.on("connect", (req, socket, head) => void this.tunnel(req, socket as net.Socket, head));
    this.server.on("clientError", (_e, socket) => socket.destroy());
  }

  listen(): Promise<number> {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as net.AddressInfo).port)));
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  /** How many reads are open (a test asks, to be sure that nothing is left over). */
  openReads(): number {
    return this.reads.size;
  }

  open(maxBytes: number): Read {
    const username = randomBytes(9).toString("hex");
    const state: State = { password: randomBytes(18).toString("hex"), left: maxBytes, used: 0, sockets: new Set() };
    this.reads.set(username, state);
    return {
      username,
      password: state.password,
      bytes: () => state.used,
      close: () => {
        this.reads.delete(username);
        for (const s of state.sockets) s.destroy();
        state.sockets.clear();
      },
    };
  }

  close(): Promise<void> {
    for (const id of [...this.reads.keys()]) this.reads.get(id)!.sockets.forEach((s) => s.destroy());
    this.reads.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private auth(header: string | undefined): State | null {
    const m = /^Basic (.+)$/i.exec(header ?? "");
    if (!m) return null;
    const [user, ...rest] = Buffer.from(m[1], "base64").toString().split(":");
    const state = this.reads.get(user);
    return state && same(state.password, rest.join(":")) ? state : null;
  }

  /** The address to connect to for this host and port, or null when the page may not go there. */
  private async allowed(host: string, port: number): Promise<Resolved | null> {
    if (!this.ports.includes(port)) return null;
    if (!isPublicUrl(`http://${host.includes(":") ? `[${host}]` : host}/`)) return null;
    let found: Resolved[];
    try {
      found = await this.lookup(host);
    } catch {
      return null;
    }
    if (found.length === 0 || found.some((a) => !isPublicIp(a.address))) return null;
    return found[0];
  }

  private watch(state: State, s: net.Socket): void {
    state.sockets.add(s);
    s.setTimeout(this.idleMs, () => s.destroy());
    s.on("error", () => {});
    s.on("close", () => state.sockets.delete(s));
    s.on("data", (chunk: Buffer) => {
      state.used += chunk.length;
      state.left -= chunk.length;
      if (state.left < 0) for (const x of state.sockets) x.destroy();
    });
  }

  private async tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    const refuse = (line: string) => {
      client.end(`HTTP/1.1 ${line}\r\nProxy-Authenticate: Basic realm="runner"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    client.on("error", () => {});
    const state = this.auth(req.headers["proxy-authorization"]);
    if (!state) return refuse("407 Proxy Authentication Required");
    const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d+)$/.exec(req.url ?? "");
    if (!m) return refuse("400 Bad Request");
    const target = await this.allowed(m[1] ?? m[2], Number(m[3]));
    if (!target) return refuse("403 Forbidden");
    const upstream = this.connect(target.address, Number(m[3]));
    this.watch(state, client);
    this.watch(state, upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("error", () => {
      if (!client.destroyed && !client.writableEnded) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }

  /** A plain http:// address: the browser sends the whole address to the proxy and the proxy asks for it. */
  private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fail = (status: number) => {
      res.writeHead(status, { "content-length": 0, connection: "close", ...(status === 407 ? { "proxy-authenticate": 'Basic realm="runner"' } : {}) });
      res.end();
    };
    const state = this.auth(req.headers["proxy-authorization"]);
    if (!state) return fail(407);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return fail(400);
    }
    if (url.protocol !== "http:") return fail(400);
    const port = Number(url.port || 80);
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const target = await this.allowed(host, port);
    if (!target) {
      // Said in a header too: the browser shows a plain http:// refusal as if it were the site's own 403.
      res.writeHead(403, { "content-length": 0, connection: "close", [REFUSED]: "1" });
      res.end();
      return;
    }
    // The connection is the one to the address that was checked. (Giving http.request a `createConnection` is not
    // enough: without an agent of its own it looks the name up itself. This agent never does.)
    const agent = new PinnedAgent(() => this.connect(target.address, port));
    const up = http.request(
      { agent, host: url.hostname, port, path: url.pathname + url.search, method: req.method, headers: { ...clean(req.headers), host: url.host } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, clean(answer.headers));
        answer.pipe(res);
      },
    );
    up.setTimeout(this.idleMs, () => up.destroy());
    up.on("socket", (s) => this.watch(state, s));
    up.on("error", () => {
      if (!res.headersSent) fail(502);
      else res.destroy();
    });
    req.pipe(up);
  }
}

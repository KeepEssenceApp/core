# The page runner

A small server that reads the pages the core's direct read cannot: it opens the address in a headless
Chromium and answers in the interface of **Jina Reader**. In the portal's System page it goes in the
`jina` slot (endpoint = the runner's address, key = `RUNNER_KEY`); the core needs no change, and the
public Jina service is then not used. It is the last way in the reading chain (direct → readers → runner,
QA #101, D45/D46). **This is a first version that works, not a finished one** (see the end).

```
core (Cloudflare Worker) ──https, Bearer key──▶ Cloudflare Tunnel ──▶ runner (127.0.0.1)
                                                                          │
                                  Chromium ──all its traffic──▶ proxy.ts ─┴─▶ public addresses only
```

## The interface

`GET /<address>` with `Authorization: Bearer <RUNNER_KEY>` (and `Accept: application/json`):

| Answer | When |
|---|---|
| `200 { code, status, data: { title, url, content } }` | content was read |
| `400` | not a public http(s) address |
| `401` | no key, or the wrong one |
| `422 { error: "wall" \| "thin" }` | a verification wall or a refusal answered both times; or only a page shell came back (no content, A13) |
| `502` | the page could not be opened, an error status, not a page |
| `503` | all the pages are busy and the queue is full (answered at once) |
| `504` | no answer within the one deadline |

`GET /healthz` is `200 ok` without a key and says nothing else. The core treats every non-200 as "this way
did not read it" and goes on; nothing here can stop a save, an analysis or a daily digest.

## What it does with a page

- Asks as a desktop browser, then as an iPhone (the phone first for the apps that want it), with the
  `Accept-Language` of the direct read. A refusal, a verification wall or a shell makes the next one go.
- Judges the result with **the core's own rules**: `src/services/pagerules.ts` (walls, shells, short
  posts, titles) and `src/services/publicurl.ts` (addresses) are imported, not copied. A change there is a
  change here.
- Returns only what a reader would show: the text of the page's main part, and a title only when it names
  the page (not a wall's, a login's or the site's name).

## What it will not do

- **Reach the machine's network.** Chromium does its own networking (so its TLS handshake, HTTP/2 and
  headers are Chrome's own, which is what sites that turn automation away look at), but only through
  `proxy.ts`, a proxy on the loopback with a password for each read. For every connection the proxy asks:
  is the host a public one, is the port 80 or 443, and is **every address the name resolves to** public? It
  then connects to the address it checked (not to the name again), so a name that points into the LAN or the
  tailnet, or that changes its answer between two lookups, is refused. The loopback is not exempt: a page that
  asks for `localhost` is sent to the proxy too, and refused there. Redirects, scripts, frames, XHR and
  WebSockets all go the same way; the browser's own WebRTC is limited to the proxy as well.
- **Load pictures, sound or fonts**, or keep cookies. One visit in a fresh context, closed at the end or at
  once when the deadline passes. What a page's own scripts and styles ask of its own hosts still goes out (that
  is how a page is drawn); nothing is sent to a reader or search service.
- **Log what was read.** A line says when, how it went (`ok`, `wall`, `thin`, `error`, `timeout`, `busy`),
  which of `wechat` / `xiaohongshu` / `other`, and how long. Never an address, a name, a word of the page or the key.
- **Run forever.** One deadline for all the attempts (17 s: the core gives a reader service 20), at most
  `RUNNER_CONCURRENCY` pages at once, a queue of `RUNNER_QUEUE`, and a cap on the bytes a read may add up to, counted at the proxy (a read that passes it has every connection cut).

## Run it

Node 22.18 or later (it runs the `.ts` files as they are). Once:

```
npm ci
npx playwright-core install chromium      # on Linux: add --with-deps (needs sudo, once)
```

| Variable | Default | |
|---|---|---|
| `RUNNER_KEY` | — (required, 24+ characters) | the shared secret the core sends; keep it in a file that only you can read |
| `RUNNER_HOST` / `RUNNER_PORT` | `127.0.0.1` / `8820` | listen on the loopback only; the tunnel connects here |
| `RUNNER_DEADLINE_MS` | `17000` | all attempts for one address together |
| `RUNNER_CONCURRENCY` / `RUNNER_QUEUE` | `2` / `4` | pages at once / waiting |
| `RUNNER_MAX_BYTES` / `RUNNER_MAX_CHARS` | 8 MiB / 100000 | what one read may add up to, both ways / the longest text returned |
| `RUNNER_NO_SANDBOX` | — | `1` only where Chromium's sandbox cannot start (a container) |
| `RUNNER_CHROMIUM_PATH` / `RUNNER_CHROMIUM_ARGS` | — | another Chromium / extra flags |

```
RUNNER_KEY=… npm start
```

### Updating it

The runner machine holds a copy of this folder and of the two files it imports from the core, not a checkout.
To move it to a newer commit, from a checkout of `main`:

```
HOST=<the runner machine>
VERSION=$(git rev-parse --short HEAD)
ssh $HOST 'cp -a ~/ke-runner ~/ke-runner.prev'             # the way back
rsync -a --delete --exclude node_modules runner/ $HOST:ke-runner/runner/
rsync -a src/services/pagerules.ts src/services/publicurl.ts $HOST:ke-runner/src/services/
ssh $HOST "cd ~/ke-runner/runner && npm ci && echo $VERSION > ../VERSION && systemctl --user restart ke-runner"
```

Then check it the way the first time was checked: no key → 401, the key on a public page → 200, an internal
address → 400. To go back: put `~/ke-runner.prev` back and restart. The tunnel (`ke-runner-tunnel`) needs no
restart.

### Behind a Cloudflare Tunnel

The core runs on Cloudflare and cannot reach a tailnet, so the runner is exposed with `cloudflared`
(not Tailscale Funnel). The core can only send `Authorization: Bearer`, so the runner checks the shared
secret itself (a Cloudflare Access service token would need headers the core does not send).

```
cloudflared tunnel login                              # once, in a browser
cloudflared tunnel create ke-runner
cloudflared tunnel route dns ke-runner <hostname>     # a hostname in one of your Cloudflare zones
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: ke-runner
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: <hostname>
    service: http://127.0.0.1:8820
  - service: http_status:404
```

Then in the portal's System page: `jina` → endpoint `https://<hostname>`, key = `RUNNER_KEY`, on; try it with
"test read"; put it where you want it in the order. Leave `firecrawl` off.

A user-level systemd service for each (`~/.config/systemd/user/ke-runner.service`, with
`EnvironmentFile=%h/.config/ke-runner/env` at mode 0600) keeps it up; when the machine sleeps or is off the
chain falls back to "content could not be fetched".

## Tests

```
npm run typecheck
npm test            # a real headless Chromium against a made-up network: no real address is asked for
```

`test/proxy.test.ts` speaks to the proxy with raw sockets: who may use it, where it will connect (private
addresses in every spelling, other ports, a name with one private answer, a name that changes its answer),
what it counts, and that closing a read closes its connections. `test/runner.test.ts` runs the whole runner:
the interface and the key, the rules (walls, shells, short posts, titles, User-Agent order), https through a
tunnel with the browser's own HTTP/2, that a page asking for localhost, the LAN or a WebSocket on this machine
reaches nothing (a canary server counts), the deadline, the queue, the byte cap, the restart of a dead
Chromium, and what is logged. The only two seams are the proxy's name lookup and its final connection.

## A first version

Not done: a plain request before the browser (a page that needs no scripts costs a whole Chromium visit);
a pool of warm contexts; Xiaohongshu short links (`xhslink.com`) are followed like any redirect, nothing more;
a Channels page (`weixin.qq.com/sph/`) cannot be read; and nothing here claims that a given WeChat or
Xiaohongshu page can be read: that is shown by a test read on a real, authorised address, and a verification
wall is not a success. Cloudflare shows its own page for a 502 or 504 the runner answers, so the core sees the
status but not the message; the log on the runner holds the result.

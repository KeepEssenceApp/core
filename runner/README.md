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
| `202 { code, status, data, video: { state: "reading", job, seconds } }` | the page is a **video post** and its video is being read (see [Video posts](#video-posts)) |
| `200 { code, status, data, video: { state: "too_long" \| "unavailable", seconds } }` | a video post whose video is not read; `data` is still the page's own words |
| `400` | not a public http(s) address |
| `401` | no key, or the wrong one |
| `422 { error: "wall" \| "thin" }` | a verification wall or a refusal answered both times; or only a page shell came back (no content, A13) |
| `502` | the page could not be opened, an error status, not a page |
| `503` | all the pages are busy and the queue is full (answered at once) |
| `504` | no answer within the one deadline |

`GET /healthz` is `200 ok` without a key and says nothing else. The core treats every non-200 (and non-202) as
"this way did not read it" and goes on; nothing here can stop a save, an analysis or a daily digest.

A page that is not a video post is answered exactly as above, with no `video` field.

## Video posts

For a video post the runner also reads **what is said in the video**: it downloads the media (through the same
filtering proxy, so only public addresses), takes the sound out with ffmpeg, sends it to a **transcription
worker on another machine** (ms), and gives the text back. The page read does not wait for that: it answers at
once with the page's own words and a job to ask about, and the core asks from time to time.

```
core ──GET /<address>──▶ runner ──202 { data: the author's words, video: { state: "reading", job, seconds } }
core ──GET /jobs/<job>─▶ runner      { "state": "reading" }  …  { "state": "done", "video_state": "recognized", "recognized_text": "…" }
                                      │ yt-dlp (through proxy.ts) ─▶ ffmpeg ─▶ POST {RUNNER_TRANSCRIBE_URL}/transcribe ─▶ the worker
```

**Which pages are video posts** (`src/detect.ts`):

| Platform | How it is told | The media |
|---|---|---|
| Xiaohongshu / rednote note | the page's own data, `window.__INITIAL_STATE__.noteData.data.noteData`, has `type: "video"` | the length (`video.capa.duration`, else `video.media.video.duration`, in seconds) and the addresses (`video.media.stream.h264[].masterUrl`) are in the same data; downloaded with the note's site as `Referer` |
| Bilibili (`/video/BV…`, `/video/av…`, `b23.tv`), a Weibo video (`video.weibo.com/show`, `weibo.com/tv/show/`), Tencent Video (`v.qq.com/x/page/`, `/x/cover/`) | the address (a short link is followed first, and the page it ends on is judged) | `yt-dlp --dump-json --no-download --no-playlist` for the length, and yt-dlp for the download |
| a WeChat article (`mp.weixin.qq.com`) with a Tencent video | an `iframe` (its `src` or lazy `data-src`) on `v.qq.com` with a `vid=`; the media page is `https://v.qq.com/x/page/<vid>.html` (the first such iframe) | as above. The article's own text is returned as it always was, **and a long article with a video is read for both** |
| WeChat Channels (`weixin.qq.com/sph/`, `channels.weixin.qq.com`), Douyin | the address | **not read**: the file needs a temporary credential and is encrypted (Channels), or a login (Douyin). Always `unavailable` |

**The words of the page** are the author's own and are returned as they are: no "thin" or "shell" verdict is
made on a video post's caption, it may be short or empty, and a video post is never `422` for that. (A page
whose text is only its buttons gives an empty `content`, not the buttons.) What is said in the video is kept
apart: it is only ever in the job's result, as `recognized_text`.

**`video.state` in the page answer**

| `state` | Meaning |
|---|---|
| `reading` | (answer `202`) a job was made; `job` is an opaque id of 32 random hex characters, `seconds` the length |
| `too_long` | longer than `RUNNER_VIDEO_MAX_MINUTES`; asked **before** anything is downloaded; `seconds` is the length |
| `unavailable` | video reading is not set up (`RUNNER_TRANSCRIBE_URL` unset), the queue is full, the platform is not read (Channels, Douyin), or the length or the media address could not be found; `seconds` is the length when it is known, else `null` |

**The job**

- `GET /jobs/<id>` with the key: `200 { "state": "reading" }`, or `200 { "state": "done", "video_state": "recognized", "recognized_text": "…" }`,
  or `200 { "state": "done", "video_state": "no_speech" | "too_long" | "unavailable" }`. Nothing said (music, burnt-in captions, silence) is
  `no_speech` and is never turned into guessed words; the worker's `413` is `too_long`; any other failure of any step is `unavailable`.
  `404 { "error": "unknown" }` for an id that was never made, was cancelled, was forgotten, or belonged to a runner that has since restarted.
- `DELETE /jobs/<id>` with the key: `204`, always. Stops a job that is running or waiting (the download, ffmpeg and the call to the worker are
  aborted, the files are removed) and forgets a result.
- Jobs are in memory. One runs at a time (`RUNNER_VIDEO_CONCURRENCY`), `RUNNER_VIDEO_QUEUE` wait, and when both are full a new video is
  `unavailable` at once. A job has 20 minutes for all its steps from the moment it runs. A result is kept 30 minutes after it is done, then forgotten.
- **A site that refuses the download is left alone for a while.** When yt-dlp's download (or its question about the length) is answered
  `567` (Bilibili's word for "not you, not now"), `412` or `429`, every video of that site (by its name: `bilibili.com`, which `b23.tv` and
  `m.bilibili.com` are too) is `unavailable` at once for `RUNNER_VIDEO_COOLDOWN_HOURS` (6 by default; `0` for none): nothing is probed, nothing
  is downloaded, and a job that was already waiting for that site never downloads. The page's own words still come back, as for any
  `unavailable` video. The runner only reads the number out of yt-dlp's message (`HTTP Error 567`) and throws the rest away. It is kept in
  memory by the site's name alone, so a runner that restarts forgets it (the first video afterwards asks once, is refused once, and the
  cool-down starts again). A line in the log says that a cool-down began (`video_cooldown`, the platform class), never for which site.
- Each job has a directory of its own under `<tmpdir>/ke-runner-jobs/<id>`, **removed in a `finally`** whatever happened; the video file is
  removed as soon as the sound is out; what an earlier run left behind is removed at start-up. Nothing keeps the address after the job is over.
- Download: yt-dlp through a read opened on the filtering proxy (a cap of 150 MB at the proxy, `--max-filesize 150M`, 3 minutes, 15 s socket
  timeout, `--no-playlist`, its own HLS and DASH downloaders). Then `ffmpeg -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k` to an `.ogg`,
  which may open the local file only (`-protocol_whitelist file`). Both are run with argument lists, never a shell, and are given only an address
  from `detect.ts` or a path in the job's directory. Then `POST {RUNNER_TRANSCRIBE_URL}/transcribe?lang=auto` with the worker's key (a trusted
  internal call: it does not go through the proxy), 5 minutes at the most: `200 { text, speech, seconds }` is the words (`speech: false` is
  `no_speech`); `413` is `too_long`; `503`, `401`, `500` and the rest are `unavailable`. The text is cut at 30000 characters.

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
  which of `wechat` / `xiaohongshu` / `bilibili` / `weibo` / `tencent` / `douyin` / `other`, and how long. Never an address, a name, a word of
  the page or the key. For a video post the read's line also says what became of the video (`video`: `reading`, `too_long`, `unavailable`), and a
  job's end is a line of its own (`video_done` with `video_state`, and `stage` where it failed: `download`, `extract`, `transcribe`, `deadline`;
  or `video_cancelled`). Never an address, a job id, what the program printed, the programs' arguments (they hold the proxy's password for that
  read), a word of what was said, or the worker's key.
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
| `RUNNER_TRANSCRIBE_URL` | — | the transcription worker on ms, an `http(s)` address on the tailnet, no trailing slash. **Unset: video reading is off** and every video post is `unavailable` (its words are still returned). A value that is not an address stops the start |
| `RUNNER_TRANSCRIBE_KEY` | — (required with the address) | the secret the worker wants as `Authorization: Bearer`; keep it in the same mode-0600 file as `RUNNER_KEY` |
| `RUNNER_VIDEO_MAX_MINUTES` | `15` | a longer video is `too_long` and is not downloaded |
| `RUNNER_VIDEO_QUEUE` / `RUNNER_VIDEO_CONCURRENCY` | `4` / `1` | video jobs waiting / running at once; when both are full the answer is `unavailable` at once |
| `RUNNER_VIDEO_COOLDOWN_HOURS` | `6` | after a site answers a download 567, 412 or 429, its videos are `unavailable` at once for this many hours (`0`: no cool-down) |
| `RUNNER_YTDLP` / `RUNNER_FFMPEG` | `yt-dlp` / `ffmpeg` | the two programs, by name (on the service's search path) or by path |

```
RUNNER_KEY=… npm start
```

Video reading needs **`ffmpeg` (with `libopus`) and `yt-dlp`** on the machine that runs the runner: both are already installed on think.
yt-dlp's extractors follow the sites and break now and then; keep it up to date there (`yt-dlp -U`, or however it was installed). Nothing
else is new: no npm package, and from the core still only `pagerules.ts` and `publicurl.ts` are imported.

### Changing the settings on think (video reading)

The service reads `~/.config/ke-runner/env` (mode 0600). To turn video reading on, or to change the worker's address or key (these commands are
here to copy; nothing has run them):

```
ssh think
${EDITOR:-nano} ~/.config/ke-runner/env      # add or change, one per line, no quotes:
#   RUNNER_TRANSCRIBE_URL=http://<ms's tailnet name>:<the worker's port>
#   RUNNER_TRANSCRIBE_KEY=<the worker's key>
#   (optional) RUNNER_VIDEO_MAX_MINUTES=15  RUNNER_VIDEO_QUEUE=4  RUNNER_VIDEO_CONCURRENCY=1  RUNNER_VIDEO_COOLDOWN_HOURS=6
chmod 600 ~/.config/ke-runner/env
systemctl --user restart ke-runner
systemctl --user is-active ke-runner         # active
journalctl --user -u ke-runner -n 5 --no-pager   # the "listening" line says "video": "on"
```

To turn it off: delete the two `RUNNER_TRANSCRIBE_` lines and restart; video posts are then answered `200` with `video.state: "unavailable"`.
A restart forgets the jobs that were running or waiting (the core's question about one is then a `404`, which it takes as "not read") and
removes their files. Check the worker from think before the first real video: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $KEY" "$URL/transcribe?lang=auto" --data-binary @some.ogg`
(with the two values set in that shell, not typed into the history).

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

The test files run one after the other (`--test-concurrency=1`): two files each starting a Chromium at once, on a busy machine, made
reads time out that had nothing wrong.

`test/proxy.test.ts` speaks to the proxy with raw sockets: who may use it, where it will connect (private
addresses in every spelling, other ports, a name with one private answer, a name that changes its answer),
what it counts, and that closing a read closes its connections. `test/runner.test.ts` runs the whole runner:
the interface and the key, the rules (walls, shells, short posts, titles, User-Agent order), https through a
tunnel with the browser's own HTTP/2, that a page asking for localhost, the LAN or a WebSocket on this machine
reaches nothing (a canary server counts), the deadline, the queue, the byte cap, the restart of a dead
Chromium, and what is logged. The only two seams are the proxy's name lookup and its final connection.

The video part (#103) is made so that the media steps can be stood in for: `createJobs({ probe, download, extractAudio, transcribe, … })`
takes them as parameters, and the tests give it fakes (no network, no yt-dlp, no ffmpeg needed). `test/jobs.test.ts` is the jobs alone
(lifecycle, the queue of one running and four waiting, too long is not downloaded, cancel while running and while waiting, the deadline, a
step that throws, leftovers removed at start-up, results forgotten after 30 minutes with a clock of the test's, no address kept, the log).
`test/video.test.ts` is the whole runner with a real browser: which pages are video posts (a Xiaohongshu video note, an image note, an
empty caption, a long WeChat article with a Tencent iframe, Bilibili, Weibo, Tencent Video, Channels, Douyin), the `202`, `/jobs/<id>`
and its key, `DELETE`, and the log. `test/media.test.ts` is the pure parts (which addresses are video posts, the yt-dlp and ffmpeg argument
lists), running a program (no shell, no secrets in its environment, killed with what it started, no argument in an error), the call to the
worker against one made up there, the settings, and one smoke test with the real `yt-dlp` and `ffmpeg` through the real proxy over the
made-up network (skipped where they are not installed).

## A first version

Not done: a plain request before the browser (a page that needs no scripts costs a whole Chromium visit);
a pool of warm contexts; Xiaohongshu short links (`xhslink.com`) are followed like any redirect, nothing more;
a Channels page (`weixin.qq.com/sph/`) cannot be read; and nothing here claims that a given WeChat or
Xiaohongshu page can be read: that is shown by a test read on a real, authorised address, and a verification
wall is not a success.

For video (v1): the Xiaohongshu fields are the ones the brief named and are shown by a made-up page, not by the real site; yt-dlp has
not been run here against a real Bilibili, Weibo or Tencent address, nor the worker's real answer read; only the first Tencent video of an
article is read; a Weibo post is a video post only when its address is a video page (`video.weibo.com/show`, `/tv/show/`), since the
address of an ordinary post does not say; Tencent Video's own description is not taken as the author's words (it is not on the core's list
of short-post sites); no text on the picture is read (burnt-in captions are not speech). Cloudflare shows its own page for a 502 or 504 the runner answers, so the core sees the
status but not the message; the log on the runner holds the result.

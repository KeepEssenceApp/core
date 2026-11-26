# The transcription worker

A small server that turns the speech in a video into text. The page runner (on **think**) extracts the audio
of a video post with `ffmpeg` and sends it here; this runs on **ms** (a Mac Studio, Apple silicon) and uses
its GPU through [`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper) with the model
`mlx-community/whisper-large-v3-turbo`. It is issue #103. **Nothing leaves the tailnet**: no third-party
service, no file or address kept (decisions of 2026-11-27: on ms, 15-minute videos, one at a time).

```
runner (think) ──audio bytes, Bearer key, tailnet──▶ transcriber (ms, the tailnet address)
                                                         │ ffprobe → Whisper on the GPU → quality filter
                                                         ▼
                                              { text, seconds, language, speech }
```

Python 3 and its standard library only (3.9 or later); `mlx_whisper` is imported the first time a request
needs it, so the tests run anywhere without it.

## The interface

`POST /transcribe[?lang=zh|en|auto]` with `Authorization: Bearer <TRANSCRIBER_KEY>`. The body is the audio
bytes, `Content-Type` `audio/ogg`, `audio/mp4`, `audio/wav` (any `audio/*`) or `application/octet-stream`.
`lang` defaults to `auto`; pass `zh` when the post is known to be Chinese (it saves a second pass, see below).

| Answer | When |
|---|---|
| `200 {"text", "seconds", "language", "speech": true}` | speech was recognized. `text` is simplified Chinese when the speech is Mandarin; `seconds` is the audio's length |
| `200 {"text": "", "seconds", "language", "speech": false}` | nothing credible was recognized (music, silence, noise, a stock phrase, under 5 Chinese characters or 3 words). Never a guess |
| `400 {"error": "bad_audio"}` | empty, not a known audio container, or `ffprobe` cannot read it |
| `400 {"error": "bad_lang"}` / `{"error": "bad_request"}` | `lang` is not `zh`, `en` or `auto`; the body stopped short or stalled |
| `401 {"error": "unauthorized"}` | no key or a wrong one |
| `411 {"error": "length_required"}` | no `Content-Length` (chunked bodies are not read: send the bytes from a Buffer or file, as `curl --data-binary` does) |
| `413 {"error": "too_large"}` | body over 40 MiB (41 943 040 bytes) |
| `413 {"error": "too_long"}` | audio over 20 minutes (measured with `ffprobe`) |
| `415 {"error": "unsupported_type"}` | a `Content-Type` that is not audio (a plain `curl -d` sends a form type: add `-H 'Content-Type: audio/wav'`) |
| `500 {"error": "failed"}` | the engine or `ffprobe` failed. The log has the exception's class name, nothing else |
| `503 {"error": "busy"}` | a transcription is running. Answered at once, nothing is queued: the caller retries later |

`GET /healthz` is `200 ok` without a key and says nothing else.

For the client: the answer comes when the transcription is done, so wait for it (allow 10 minutes; on this
GPU a 15-minute video should take far less, but that is not measured yet). 16 kHz mono 16-bit WAV is about
1.9 MB a minute, so 20 minutes fits in the size limit; Ogg/Opus is much smaller. `ffmpeg -vn -ac 1 -ar 16000`
gives the right thing from a video.

## Environment

| Variable | Default | |
|---|---|---|
| `TRANSCRIBER_KEY` | none (required, 24+ characters) | the shared secret. The server **refuses to start** without it (exit 2). Compared with `hmac.compare_digest` |
| `TRANSCRIBER_HOST` | `127.0.0.1` | on ms: the tailnet address (`tailscale ip -4`), so only the tailnet can reach it |
| `TRANSCRIBER_PORT` | `8830` | |
| `TRANSCRIBER_MODEL` | `mlx-community/whisper-large-v3-turbo` | a Hugging Face repo of an MLX Whisper model, or a local folder |

Other exit codes at start-up: 3 `ffprobe`/`ffmpeg` not on `PATH`, 4 cannot listen on that address. The key is
removed from the process's own environment once read, so `ffprobe` and `ffmpeg` do not inherit it.

## What it does with a request, and what it will not do

1. Key check, `lang`, size and type checks, **before** the body is read. One transcription at a time: a
   non-blocking lock, so a second request is `503 busy` at once (the rest of its body is read off and thrown
   away so the answer is not lost to a connection reset).
2. The body goes to a temp file (`ke-transcriber-*.audio`, mode 600). The first bytes must be a known audio
   container (Ogg, WAV, AIFF, MP4/M4A, FLAC, MP3, AAC, WebM). Anything else (a playlist, a script) is refused
   before `ffprobe` or `ffmpeg` sees it: they can be made to open other files or addresses.
3. `ffprobe` (argument list, no shell, 15 s timeout, local files only) gives the length.
4. The engine runs on one dedicated thread (MLX keeps its GPU stream per thread; the server makes a thread per
   request). A transcription that takes over 45 minutes is taken as hung: the process exits and launchd starts
   a clean one.
5. The quality filter (below). The temp file is removed **before** the answer is sent, in a `finally`, whatever
   happened; files in use are removed on SIGTERM, and a file left by a killed process is removed at the next start.

It does not keep or log what it hears: **no body, text, file name or key is ever logged**. A log line is one
JSON object per `/transcribe` request, nothing else (health checks are not logged; the HTTP server's own request
lines are switched off):

```
{"at": "2026-11-27T10:15:02+00:00", "result": "ok", "seconds": 311.4, "ms": 18230}
```

`result` is one of `ok`, `no_speech`, `busy`, `too_long`, `too_large`, `unauthorized`, `bad_audio`, `bad_request`,
`failed` (with `"err": "<exception class>"`). With launchd the lines go to `~/Library/Logs/ke-transcriber.log`.
At run time the model is read from disk only (`HF_HUB_OFFLINE=1` in the wrapper): nothing is downloaded or reported.

### The quality filter (`ke_transcriber/quality.py`, pure functions, each rule tested)

Whisper writes sentences for music and silence. Per segment, dropped: `no_speech_prob > 0.6` **and**
`avg_logprob < -1.0` (Whisper's own silence test, both at once); `compression_ratio > 2.4` (a loop or
gibberish); empty or punctuation-only text; a bracketed sound label (`[Music]`, `(音乐)`). The same line 3 or
more times in a row is kept once. Known stock lines (`字幕由…提供`, `谢谢观看`, `请不要忘记订阅`, `Thanks for
watching`, `Thank you.`, `Please subscribe`, `Subtitles by…`, Japanese outros, and the like) are dropped
**only when they are the last speech or the only speech**, and only as a whole short line. If fewer than 5
characters of Chinese or Japanese (or 3 words of another language) are left: `speech: false`, `text: ""`. The
text is capped at 30000 characters.

### Simplified or traditional

There is no traditional-to-simplified conversion (it is not in the standard library, and a mapping table is not
carried here). The engine is given the prompt `以下是普通话的句子。` for Mandarin, which makes Whisper write
simplified characters; with `lang=auto`, when Whisper hears Chinese the engine runs a second time with that
prompt (so a caller that knows the post is Chinese should send `lang=zh` and save the pass). If traditional
characters still turn up in real use, the fix to consider is the optional `opencc` package after the engine
call. It is not installed or used.

## Installing it on ms

What follows is the whole list of what will be installed or changed on ms. **No `sudo` is needed** on macOS when
Homebrew is already there. Run the steps on ms in a normal login shell (Terminal, or an interactive `ssh ms`; a
non-interactive `ssh ms '…'` has no Homebrew on its `PATH`). Use `/bin/cp -f` and `/bin/rm -f` if `cp` and `rm`
are aliased to ask first. Stop at the first step that does not give the result shown.

| Step | Installs or changes | Needs | Network |
|---|---|---|---|
| 1 | Homebrew packages `ffmpeg`, `uv` | the logged-in user; no sudo | Homebrew's bottles |
| 2 | folders `~/ke-transcriber`, `~/.config/ke-transcriber` | nothing | none |
| 3 | a Python venv in `~/ke-transcriber/venv` with `mlx-whisper` (and what it pulls in, torch among them as far as I know: look at the dry run) | nothing | PyPI (and, only if no Python 3.12 is installed, one Python build from GitHub through `uv`) |
| 4 | the model in `~/.cache/huggingface` (about 1.6 GB) | about 5 GB free in all | Hugging Face, once; model weights, not user data |
| 5 | the code in `~/ke-transcriber/app` | nothing | none |
| 6 | `~/.config/ke-transcriber/env` (mode 600) | `tailscale` running | none |
| 7 | `~/Library/LaunchAgents/app.keepessence.transcriber.plist`, `~/Library/Logs/ke-transcriber.log` | the user logged in at the console | none |

### 0. Look first (changes nothing)

```sh
uname -m                                   # arm64
sw_vers -productVersion
command -v brew ffmpeg ffprobe uv tailscale openssl
df -h ~ | tail -1                          # about 5 GB free
lsof -nP -iTCP:8830 -sTCP:LISTEN           # prints nothing: the port is free
```

### 1. Homebrew packages

```sh
brew install ffmpeg uv                     # skip what `command -v` found; no sudo
ffprobe -version | head -1; uv --version
```

`brew install` may update Homebrew itself and upgrade out-of-date dependencies of these two packages; it does not
upgrade other packages. **If `brew` is missing**: stop and ask the owner. Installing Homebrew needs an administrator
password (its installer creates `/opt/homebrew`), which is not part of this plan; `uv` can be had without it
(`pip install --user uv` with any Python), but a static `ffmpeg` would be a different, unplanned install.

### 2. Folders

```sh
mkdir -p ~/ke-transcriber/app ~/.config/ke-transcriber ~/Library/LaunchAgents
chmod 700 ~/.config/ke-transcriber
```

### 3. The Python environment

```sh
uv venv --python 3.12 ~/ke-transcriber/venv
uv pip install --dry-run --python ~/ke-transcriber/venv/bin/python mlx-whisper     # lists what would be installed; changes nothing
uv pip install --python ~/ke-transcriber/venv/bin/python mlx-whisper
uv pip freeze --python ~/ke-transcriber/venv/bin/python > ~/ke-transcriber/requirements.lock   # the way back
```

### 4. The model, once

Downloads about **1.6 GB from huggingface.co, once**. It is the model's weights, not anyone's data. It is the only
download of this kind; after it the service runs with the network switched off for Hugging Face.

```sh
HF_HUB_DISABLE_TELEMETRY=1 ~/ke-transcriber/venv/bin/python -c \
  "from huggingface_hub import snapshot_download; print(snapshot_download('mlx-community/whisper-large-v3-turbo'))"
```

It prints the folder in `~/.cache/huggingface/hub`.

### 5. The code

From a checkout of `main` (on whichever machine has one; leave out `ms:` if it is ms itself), at the repository root:

```sh
rsync -a --delete --exclude __pycache__ transcriber/ ms:ke-transcriber/app/
```

Then on ms, the two checks that need no key and no network:

```sh
~/ke-transcriber/venv/bin/python -m unittest discover -s ~/ke-transcriber/app      # OK (about 2 seconds)
cd ~/ke-transcriber/app && PATH=/opt/homebrew/bin:$PATH HF_HUB_OFFLINE=1 \
  ~/ke-transcriber/venv/bin/python -m ke_transcriber --check                        # engine ok (… ms)
```

`--check` loads the model and listens to one second of silence: it is the first time the real engine runs, so if
anything about MLX is wrong it shows here, before there is a service.

### 6. The key and the address

The key is made on ms, written straight into a file only you can read, and never printed:

```sh
( umask 077
  printf 'TRANSCRIBER_KEY=%s\nTRANSCRIBER_HOST=%s\n' "$(openssl rand -hex 32)" "$(tailscale ip -4 | head -n 1)" \
    > ~/.config/ke-transcriber/env )
chmod 600 ~/.config/ke-transcriber/env
ls -l ~/.config/ke-transcriber/env                      # -rw-------
grep '^TRANSCRIBER_HOST=' ~/.config/ke-transcriber/env  # TRANSCRIBER_HOST=100.x.y.z (the tailnet address; not secret)
```

If `tailscale` is not on `PATH` (the App Store build), use `/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4`
and fix the second line of the file by hand. The service binds to that address only. The same key value goes to
think for the runner (the runner's own change decides the variable names): copy it without showing it, for example
`ssh ms "grep '^TRANSCRIBER_KEY=' ~/.config/ke-transcriber/env" | ssh think 'umask 077; cat >> ~/.config/ke-runner/env'`.

### 7. The launchd agent

```sh
chmod +x ~/ke-transcriber/app/deploy/run.sh
sed "s|__HOME__|$HOME|g" ~/ke-transcriber/app/deploy/app.keepessence.transcriber.plist \
  > ~/Library/LaunchAgents/app.keepessence.transcriber.plist
plutil -lint ~/Library/LaunchAgents/app.keepessence.transcriber.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.keepessence.transcriber.plist
sleep 3
launchctl print gui/$(id -u)/app.keepessence.transcriber | grep -E 'state|pid|last exit'
tail -n 3 ~/Library/Logs/ke-transcriber.log             # ke-transcriber: listening on 100.x.y.z:8830
```

`RunAtLoad` and `KeepAlive` are set: it starts now, at every login, and again within 10 seconds if it exits.
Restart: `launchctl kickstart -k gui/$(id -u)/app.keepessence.transcriber`. Stop and remove from launchd:
`launchctl bootout gui/$(id -u)/app.keepessence.transcriber`.

Things that can get in the way (none needs `sudo`; none has been run on ms yet):

- A **user agent runs while that user is logged in at the console** (auto-login is enough). After a reboot with
  nobody logged in it does not start. A launch daemon would start at boot but needs `sudo`; that is not planned.
- If `gui/$(id -u)` does not exist (nobody logged in, you are on `ssh` only), log in once at ms.
- If Tailscale is not up yet when the agent starts, it cannot bind, exits with code 4 and is started again every
  10 seconds until it can.
- The macOS firewall may ask once, on screen, whether `python` may accept incoming connections. Allow it.
- If ms sleeps, requests fail: "Prevent automatic sleeping when the display is off" is the setting, if it is not already on.
- The tailnet's access rules must let think reach `ms:8830`.

### 8. Check it from think

First a short real sample of speech (synthetic, so no one's data): on ms,

```sh
say -v "Flo (Chinese (China mainland))" -o /tmp/ke-sample.aiff "今天天气很好，我们一起去公园散步，然后在湖边喝一杯茶。"
ffmpeg -loglevel error -y -i /tmp/ke-sample.aiff -ac 1 -ar 16000 /tmp/ke-sample.wav
ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 5 /tmp/ke-silence.wav
scp /tmp/ke-sample.wav /tmp/ke-silence.wav think:/tmp/
```

(`say -v '?' | grep zh_CN` lists the Mandarin voices if that one is not there.) Then on think:

```sh
MS=$(ssh ms "sed -n 's/^TRANSCRIBER_HOST=//p' ~/.config/ke-transcriber/env")
curl -sS -m 5 -o /dev/null -w 'healthz  %{http_code}\n' "http://$MS:8830/healthz"                  # 200
curl -sS -m 5 -o /dev/null -w 'no key   %{http_code}\n' -X POST -H 'Content-Type: audio/wav' \
  --data-binary @/tmp/ke-sample.wav "http://$MS:8830/transcribe"                                   # 401
KEY=$(ssh ms "sed -n 's/^TRANSCRIBER_KEY=//p' ~/.config/ke-transcriber/env")   # in a variable, never printed
for f in ke-sample ke-silence; do                                              # the key goes in on stdin, not in the command line
  printf 'Authorization: Bearer %s\n' "$KEY" | curl -sS -m 600 -H @- -H 'Content-Type: audio/wav' \
    --data-binary @/tmp/$f.wav "http://$MS:8830/transcribe?lang=zh"; echo
done
unset KEY
```

Expected: `healthz 200`, `no key 401`, for the sample a `200` with `"speech": true` and the sentence (the words may differ
a little), `"seconds": 5.8`; for the silence a `200` with `"text": ""` and `"speech": false`. `/tmp/ke-*.wav` can be deleted.
Then `tail -n 5 ~/Library/Logs/ke-transcriber.log` on ms shows two lines with `ok` and `no_speech`, and no text.

## Updating

```sh
# from a checkout of main, at the repository root
ssh ms '/bin/rm -rf ~/ke-transcriber/app.prev && /bin/cp -a ~/ke-transcriber/app ~/ke-transcriber/app.prev'   # the way back
rsync -a --delete --exclude __pycache__ transcriber/ ms:ke-transcriber/app/
ssh ms 'launchctl kickstart -k gui/$(id -u)/app.keepessence.transcriber'
```

Then the checks of steps 5 (the tests) and 8. A new `mlx-whisper`: first
`uv pip freeze --python ~/ke-transcriber/venv/bin/python > ~/ke-transcriber/requirements.lock`, then
`uv pip install --upgrade --python ~/ke-transcriber/venv/bin/python mlx-whisper`, restart, and `--check`. A new model: change
`TRANSCRIBER_MODEL` in the env file, run step 4 for it, restart. A change to the plist: redo the `sed` in step 7, then
`launchctl bootout …` and `launchctl bootstrap …`.

## Rolling back

```sh
ssh ms 'launchctl bootout gui/$(id -u)/app.keepessence.transcriber; /bin/rm -rf ~/ke-transcriber/app.bad; mv ~/ke-transcriber/app ~/ke-transcriber/app.bad; mv ~/ke-transcriber/app.prev ~/ke-transcriber/app; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.keepessence.transcriber.plist'
# the Python packages, if the upgrade was the problem:
ssh ms 'uv pip sync --python ~/ke-transcriber/venv/bin/python ~/ke-transcriber/requirements.lock'
```

To take it all away: `launchctl bootout gui/$(id -u)/app.keepessence.transcriber`, then remove
`~/Library/LaunchAgents/app.keepessence.transcriber.plist`, `~/Library/Logs/ke-transcriber.log`, `~/ke-transcriber`,
`~/.config/ke-transcriber`, and the model folder `~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo`.
The Homebrew packages stay (other things may use them). Remove the key from think's runner file too.

## Tests

```sh
python3 -m unittest discover -s transcriber        # from the repository root; no network, nothing to install
```

About 120 tests, 2 seconds. A fake engine and a fake `ffprobe` stand in (the one test that runs the real `ffprobe`
is skipped where it is not installed). They cover: the key (none, wrong, near-misses), health, size and duration limits,
busy (the engine held with an `Event`: the second request is `503` at once, also with a 1 MB body), bad audio, no
speech, a normal answer, `lang`, the temp file removed when the engine raises (and before the answer is sent), logs
that hold no text, key or file name, each rule of the quality filter, start-up refusals, the real engine's arguments
(with a fake `mlx_whisper` module), and the launchd files.

**Not shown by any test:** that the real `mlx_whisper` on ms accepts these arguments, runs on the GPU from another
thread, how fast it is, and how good its Chinese is. `--check` (step 5) and the sample (step 8) are how that is
first seen.

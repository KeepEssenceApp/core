"""The HTTP side: POST /transcribe, GET /healthz, and the process around them.

What a request leaves behind: one JSON line (when, how it went, audio seconds, milliseconds) and nothing else. The
audio goes to a temp file that is removed in a `finally`; the text, the file's name and the key are never logged.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import socket
import sys
import tempfile
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import IO, Any, Callable, Dict, Mapping, Optional, Sequence, Set, Tuple
from urllib.parse import parse_qs, urlsplit

from . import quality
from .audio import BadAudio, ProbeUnavailable, looks_like_audio, probe_duration
from .config import Config, ConfigError
from .engine import DEFAULT_MODEL, Engine, MlxEngine, Transcription

TMP_PREFIX = "ke-transcriber-"
TMP_SUFFIX = ".audio"
LANGS: Dict[str, Optional[str]] = {"auto": None, "zh": "zh", "en": "en"}
CHUNK = 64 * 1024
BODY_DEADLINE = 120.0  # seconds to receive a whole body, however slowly it comes
DRAIN_LIMIT = 1024 * 1024  # what is read and thrown away after an early refusal, so the answer is not lost to a reset
LINGER_SECONDS = 2.0  # how long a connection that sent a body of unknown length is listened to after the answer


def stdout_log(line: str) -> None:
    print(line, flush=True)


def sweep_stale(tmp_dir: Optional[str] = None) -> int:
    """Remove audio files an earlier process left (killed in the middle of a request). Only at start-up."""
    folder = tmp_dir or tempfile.gettempdir()
    removed = 0
    for name in os.listdir(folder):
        if name.startswith(TMP_PREFIX) and name.endswith(TMP_SUFFIX):
            try:
                os.unlink(os.path.join(folder, name))
                removed += 1
            except OSError:
                pass
    return removed


class App:
    def __init__(
        self,
        cfg: Config,
        engine: Engine,
        probe: Callable[[str], float] = probe_duration,
        log: Callable[[str], None] = stdout_log,
        on_hang: Optional[Callable[[], None]] = None,
    ) -> None:
        self.cfg = cfg
        self.engine = engine
        self.probe = probe
        self.log = log
        self.on_hang = on_hang or self._exit_hung
        self._busy = threading.Lock()
        self._files: Set[str] = set()
        self._files_lock = threading.Lock()
        # Every engine call runs on this one thread. MLX keeps its GPU stream per thread, and the server makes a new
        # thread per request: a model loaded on one and used on another can fail. It also makes "one at a time" literal.
        self._engine_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="engine")
        self._key_digest = hashlib.sha256(cfg.key.encode("utf-8")).digest()

    # -- the key
    def authorized(self, header: Optional[str]) -> bool:
        m = re.fullmatch(r"Bearer (.+)", header or "")
        if not m:
            return False
        # Both sides are hashed first so the comparison takes the same time whatever the length of what was sent.
        given = hashlib.sha256(m.group(1).encode("utf-8", "replace")).digest()
        return hmac.compare_digest(given, self._key_digest)

    # -- one at a time
    def try_begin(self) -> bool:
        return self._busy.acquire(blocking=False)

    def end(self) -> None:
        self._busy.release()

    # -- temp files: created here, removed here
    def new_temp(self) -> Tuple[int, str]:
        fd, path = tempfile.mkstemp(prefix=TMP_PREFIX, suffix=TMP_SUFFIX, dir=self.cfg.tmp_dir)  # mode 0600
        with self._files_lock:
            self._files.add(path)
        return fd, path

    def forget(self, path: str) -> None:
        try:
            os.unlink(path)
        except OSError:  # already gone
            pass
        with self._files_lock:
            self._files.discard(path)

    def cleanup(self) -> None:
        """Remove every audio file still in use (the process is stopping)."""
        with self._files_lock:
            paths = list(self._files)
        for path in paths:
            self.forget(path)

    # -- the engine
    def run_engine(self, path: str, language: Optional[str]) -> Transcription:
        future = self._engine_thread.submit(self.engine.transcribe, path, language)
        watchdog = threading.Timer(self.cfg.engine_timeout, self.on_hang)
        watchdog.daemon = True
        watchdog.start()
        try:
            return future.result()
        finally:
            watchdog.cancel()

    def close(self) -> None:
        self._engine_thread.shutdown(wait=False)

    def _exit_hung(self) -> None:
        # A transcription cannot be interrupted from outside, and while it holds the engine every request would be "busy"
        # for good. Leave; launchd (KeepAlive) starts a clean process.
        self.cleanup()
        self.log(json.dumps({"at": now_iso(), "result": "failed", "seconds": None, "ms": None, "err": "EngineHung"}))
        os._exit(70)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class _BadBody(Exception):
    """The body did not arrive as announced."""


# status, JSON body, result for the log, audio seconds (if known), exception class name (if failed)
Outcome = Tuple[int, Dict[str, Any], str, Optional[float], Optional[str]]


def make_handler(app: App) -> type:
    cfg = app.cfg

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 30  # seconds without a byte from the client

        def version_string(self) -> str:
            return "ke-transcriber"

        def log_message(self, format: str, *args: Any) -> None:  # the one log line is ours (see _answer)
            pass

        # -- answering
        def _send(self, status: int, body: bytes, ctype: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            self.close_connection = True

        def _json(self, status: int, payload: Dict[str, Any]) -> None:
            self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _answer(
            self, status: int, payload: Dict[str, Any], result: str, started: float,
            seconds: Optional[float] = None, err: Optional[str] = None, drain: int = DRAIN_LIMIT,
        ) -> None:
            line: Dict[str, Any] = {
                "at": now_iso(),
                "result": result,
                "seconds": None if seconds is None else round(seconds, 1),
                "ms": int((time.monotonic() - started) * 1000),
            }
            if err:
                line["err"] = err  # an exception's class name, never its message (that may hold a file name)
            app.log(json.dumps(line))
            try:
                self._json(status, payload)
                if self._unread == 0 and "Transfer-Encoding" in self.headers:
                    self._linger(drain)
                else:
                    self._drain(drain)
            except OSError:
                pass  # the client went away

        def _drain(self, limit: int) -> None:
            """Read and throw away what the client is still sending. Closing with unread data resets the connection,
            and a reset can reach the client before it has read our answer."""
            remaining = min(self._unread, limit)
            deadline = time.monotonic() + 10
            while remaining > 0 and time.monotonic() < deadline:
                chunk = self.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                self._unread -= len(chunk)

        def _linger(self, limit: int) -> None:
            """A body whose length is not known (chunked) cannot be drained by its length. Say that nothing more is coming
            from us, then read and throw away what the client is still sending, until it has read the answer and closes, goes
            quiet for LINGER_SECONDS, or has sent `limit` bytes. Closing at once would reset the connection under the body on
            its way, and the reset can take the answer with it."""
            self.connection.shutdown(socket.SHUT_WR)
            self.connection.settimeout(LINGER_SECONDS)
            remaining = limit
            deadline = time.monotonic() + 10
            try:
                while remaining > 0 and time.monotonic() < deadline:
                    chunk = self.rfile.read1(min(CHUNK, remaining))
                    if not chunk:
                        break  # the client has closed: it has the answer
                    remaining -= len(chunk)
            except socket.timeout:
                pass  # it went quiet: it is waiting for us, and has had the answer for a while

        # -- routes
        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/healthz":
                self._send(200, b"ok", "text/plain")
            elif path == "/transcribe":
                self._json(405, {"error": "method"})
            else:
                self._json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            url = urlsplit(self.path)
            self._unread = 0
            if url.path != "/transcribe":
                self._json(404, {"error": "not_found"})
                return
            started = time.monotonic()
            declared = self.headers.get("Content-Length", "")
            self._unread = int(declared) if declared.isdigit() else 0

            if not app.authorized(self.headers.get("Authorization")):
                return self._answer(401, {"error": "unauthorized"}, "unauthorized", started)
            lang_values = parse_qs(url.query, keep_blank_values=True).get("lang", ["auto"])
            if len(lang_values) != 1 or lang_values[0] not in LANGS:
                return self._answer(400, {"error": "bad_lang"}, "bad_request", started)
            language = LANGS[lang_values[0]]
            ctype = (self.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip().lower()
            if not (ctype.startswith("audio/") or ctype == "application/octet-stream"):
                return self._answer(415, {"error": "unsupported_type"}, "bad_request", started)
            if "Transfer-Encoding" in self.headers or not declared:
                return self._answer(411, {"error": "length_required"}, "bad_request", started)
            if not declared.isdigit():
                return self._answer(400, {"error": "bad_request"}, "bad_request", started)
            length = int(declared)
            if length == 0:
                return self._answer(400, {"error": "bad_audio"}, "bad_audio", started)
            if length > cfg.max_body:
                return self._answer(413, {"error": "too_large"}, "too_large", started)
            if not app.try_begin():
                # Answered before the body is read; the body is drained (all of it, up to the limit) so the answer arrives.
                return self._answer(503, {"error": "busy"}, "busy", started, drain=cfg.max_body)
            # The file is gone and the engine is free before the answer goes out: whoever gets the answer can ask again at once.
            try:
                status, payload, result, seconds, err = self._process(language, length)
            finally:
                app.end()
            self._answer(status, payload, result, started, seconds=seconds, err=err)

        def _process(self, language: Optional[str], length: int) -> Outcome:
            """Receive, check, transcribe, filter. Never raises; removes the audio file whatever happens."""
            seconds: Optional[float] = None
            path: Optional[str] = None
            try:
                fd, path = app.new_temp()
                try:
                    with os.fdopen(fd, "wb") as out:  # takes the descriptor and closes it
                        head = self._receive(out, length)
                except _BadBody:
                    return 400, {"error": "bad_request"}, "bad_request", None, None
                if not looks_like_audio(head):
                    return 400, {"error": "bad_audio"}, "bad_audio", None, None
                try:
                    seconds = float(app.probe(path))
                except BadAudio:
                    return 400, {"error": "bad_audio"}, "bad_audio", None, None
                except ProbeUnavailable as e:
                    return 500, {"error": "failed"}, "failed", None, type(e).__name__
                if seconds > cfg.max_seconds:
                    return 413, {"error": "too_long"}, "too_long", seconds, None
                heard = app.run_engine(path, language)
                spoken = heard.language or language or ""
                cleaned = quality.clean(heard.segments, spoken, cfg.max_chars)
                payload = {"text": cleaned.text, "seconds": round(seconds, 1), "language": spoken, "speech": cleaned.speech}
                return 200, payload, ("ok" if cleaned.speech else "no_speech"), seconds, None
            except Exception as e:  # the engine, the filter, the disk: the answer is "failed", the log has only the class
                return 500, {"error": "failed"}, "failed", seconds, type(e).__name__
            finally:
                if path is not None:
                    app.forget(path)

        def _receive(self, out: IO[bytes], length: int) -> bytes:
            """Write the body to `out`; return its first bytes. A body that stops short, stalls or fails is _BadBody."""
            deadline = time.monotonic() + BODY_DEADLINE
            head = b""
            remaining = length
            while remaining > 0:
                if time.monotonic() > deadline:
                    raise _BadBody()
                try:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                except OSError:
                    raise _BadBody()
                if not chunk:
                    raise _BadBody()
                if len(head) < 16:
                    head = (head + chunk)[:16]
                out.write(chunk)
                remaining -= len(chunk)
                self._unread -= len(chunk)
            return head

    return Handler


class _Server(ThreadingHTTPServer):
    daemon_threads = True  # a request thread must not keep the process from stopping

    def handle_error(self, request: Any, client_address: Any) -> None:
        pass  # what is left here is a client that went away; a traceback would only be noise (and could name a file)


class _Server6(_Server):
    address_family = socket.AF_INET6


def make_server(app: App, host: str, port: int) -> ThreadingHTTPServer:
    return (_Server6 if ":" in host else _Server)((host, port), make_handler(app))


def run_check(engine: Engine, tmp_dir: Optional[str] = None) -> int:
    """`--check`: load the model and listen to one second of silence. Proves the engine works; no user data involved."""
    fd, path = tempfile.mkstemp(prefix=TMP_PREFIX, suffix=".wav", dir=tmp_dir)
    os.close(fd)
    try:
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 16000)
        t0 = time.monotonic()
        engine.transcribe(path, "zh")
        print("engine ok (%d ms)" % int((time.monotonic() - t0) * 1000))
        return 0
    except Exception as e:
        print("engine failed: %s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 1
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main(argv: Optional[Sequence[str]] = None, env: Optional[Mapping[str, str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    real_env = env is None
    env = os.environ if env is None else env
    if argv == ["--check"]:
        return run_check(MlxEngine(env.get("TRANSCRIBER_MODEL") or DEFAULT_MODEL))
    if argv:
        print("usage: python -m ke_transcriber [--check]", file=sys.stderr)
        return 2
    try:
        cfg = Config.from_env(env)
    except ConfigError as e:
        print("ke-transcriber: %s" % e, file=sys.stderr)
        return 2
    if real_env:
        os.environ.pop("TRANSCRIBER_KEY", None)  # ffprobe and ffmpeg, started later, do not inherit it
    missing = [tool for tool in ("ffprobe", "ffmpeg") if shutil.which(tool) is None]
    if missing:
        print("ke-transcriber: not on PATH: %s (with launchd, PATH must include /opt/homebrew/bin)" % ", ".join(missing), file=sys.stderr)
        return 3
    app = App(cfg, MlxEngine(cfg.model))
    try:
        server = make_server(app, cfg.host, cfg.port)
    except OSError as e:
        print("ke-transcriber: cannot listen on %s:%d: %s" % (cfg.host, cfg.port, e.strerror or type(e).__name__), file=sys.stderr)
        return 4
    sweep_stale(cfg.tmp_dir)  # after the bind: a second copy that cannot listen must not delete the first one's files

    def stop(signum: int, frame: Any) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("ke-transcriber: listening on %s:%d" % (cfg.host, cfg.port), flush=True)
    try:
        server.serve_forever()
    except SystemExit:
        pass
    finally:
        app.cleanup()
    sys.stdout.flush()
    os._exit(0)  # an engine thread may still be running; waiting for it is not wanted

"""What the server tests share: a fake engine, a fake ffprobe, tiny WAV bytes, and a server on a random local port."""
from __future__ import annotations

import http.client
import io
import json
import os
import tempfile
import threading
import unittest
import wave
from typing import Any, Callable, List, Optional, Tuple

from ke_transcriber.config import Config
from ke_transcriber.engine import Engine, Segment, Transcription
from ke_transcriber.server import App, make_server

# A made-up key, built from pieces so that no scanner takes it for a real one.
SECRET = "unit-test-" + "x" * 20  # 30 characters


def make_wav(frames: int = 1600) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * frames)
    return buf.getvalue()


def seg(text: str, start: float = 0.0, end: float = 1.0, avg_logprob: float = -0.3,
        no_speech_prob: float = 0.01, compression_ratio: float = 1.2) -> Segment:
    return Segment(text=text, start=start, end=end, avg_logprob=avg_logprob,
                   no_speech_prob=no_speech_prob, compression_ratio=compression_ratio)


class FakeEngine(Engine):
    """Answers with the segments it was given. Can be held (to look at a busy server) or made to raise."""

    def __init__(self, segments: Optional[List[Segment]] = None, language: str = "zh") -> None:
        self.segments = segments if segments is not None else [seg("今天天气很好，我们一起去公园散步。")]
        self.language = language
        self.calls: List[Tuple[Optional[str], bytes, str]] = []  # language, the file's bytes, the file's path
        self.entered = threading.Event()
        self.hold: Optional[threading.Event] = None
        self.raises: Optional[BaseException] = None

    def transcribe(self, path: str, language: Optional[str]) -> Transcription:
        with open(path, "rb") as f:
            self.calls.append((language, f.read(), path))
        self.entered.set()
        if self.hold is not None:
            self.hold.wait(10)
        if self.raises is not None:
            raise self.raises
        return Transcription(segments=list(self.segments), language=self.language)


class Harness:
    def __init__(self, engine: Engine, probe: Callable[[str], float], overrides: dict, on_hang: Optional[Callable[[], None]]) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.logs: List[str] = []
        cfg = Config(key=SECRET, tmp_dir=self.tmp.name, **overrides)
        self.app = App(cfg, engine, probe, log=self.logs.append, on_hang=on_hang)
        self.server = make_server(self.app, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        # A short poll interval, or every `shutdown()` waits half a second for the loop to notice it.
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()

    def request(self, method: str, path: str, body: Optional[bytes] = None, headers: Optional[dict] = None,
                key: Optional[str] = SECRET, ctype: Optional[str] = "audio/wav") -> Tuple[int, Any]:
        h = dict(headers or {})
        if key is not None:
            h.setdefault("Authorization", "Bearer " + key)
        if ctype is not None and body is not None:
            h.setdefault("Content-Type", ctype)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.request(method, path, body=body, headers=h)
            res = conn.getresponse()
            raw = res.read()
            self.last_headers = dict(res.getheaders())
        finally:
            conn.close()
        if res.getheader("Content-Type", "").startswith("application/json"):
            return res.status, json.loads(raw.decode("utf-8"))
        return res.status, raw

    def post(self, body: Optional[bytes] = None, query: str = "", **kw: Any) -> Tuple[int, Any]:
        return self.request("POST", "/transcribe" + query, make_wav() if body is None else body, **kw)

    def files_left(self) -> List[str]:
        return os.listdir(self.tmp.name)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.tmp.cleanup()


class ServerCase(unittest.TestCase):
    def start(self, engine: Optional[FakeEngine] = None, probe: Optional[Callable[[str], float]] = None,
              on_hang: Optional[Callable[[], None]] = None, **overrides: Any) -> Harness:
        self.engine = engine if engine is not None else FakeEngine()
        h = Harness(self.engine, probe or (lambda path: 2.0), overrides, on_hang)
        self.addCleanup(h.close)
        return h

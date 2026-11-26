from __future__ import annotations

import http.client
import json
import os
import threading
import time

from ke_transcriber.audio import BadAudio, ProbeUnavailable

from .helpers import SECRET, FakeEngine, ServerCase, make_wav, seg


class AuthTests(ServerCase):
    def test_no_key_is_401_and_nothing_runs(self) -> None:
        h = self.start()
        status, body = h.post(key=None)
        self.assertEqual((status, body), (401, {"error": "unauthorized"}))
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(h.files_left(), [])

    def test_wrong_and_near_miss_keys_are_401(self) -> None:
        h = self.start()
        wrong = [
            "a-completely-different-key-of-some-length",
            SECRET[:-1],  # one short
            SECRET + "x",  # one long
            SECRET[:-1] + "y",  # last character changed
            SECRET.upper(),
            SECRET + " ",
            "",
        ]
        for key in wrong:
            with self.subTest(key_length=len(key)):
                self.assertEqual(h.post(key=key)[0], 401)
        for header in ("bearer " + SECRET, "Basic " + SECRET, "Bearer  " + SECRET, SECRET, "Bearer"):
            with self.subTest(header=header.split(" ")[0]):
                self.assertEqual(h.post(key=None, headers={"Authorization": header})[0], 401)
        # The key in the address is not a way in.
        self.assertEqual(h.post(query="?key=" + SECRET, key=None)[0], 401)
        self.assertEqual(self.engine.calls, [])

    def test_the_right_key_is_200(self) -> None:
        self.assertEqual(self.start().post()[0], 200)

    def test_a_refused_upload_is_still_answered_when_the_body_is_large(self) -> None:
        # Closing a socket with unread data resets it, and the reset can eat the answer: the server reads the body off first.
        h = self.start(max_body=3 * 1024 * 1024)
        status, body = h.post(body=make_wav(500_000), key="nope")  # about 1 MB
        self.assertEqual((status, body), (401, {"error": "unauthorized"}))


class HealthAndRoutesTests(ServerCase):
    def test_healthz_is_ok_without_a_key_and_says_nothing_else(self) -> None:
        h = self.start()
        status, body = h.request("GET", "/healthz", key=None)
        self.assertEqual((status, body), (200, b"ok"))
        self.assertEqual(h.last_headers["Content-Type"], "text/plain")
        self.assertNotIn("Python", h.last_headers.get("Server", ""))
        self.assertEqual(h.logs, [])  # health checks are not logged

    def test_other_routes(self) -> None:
        h = self.start()
        self.assertEqual(h.request("GET", "/", key=None)[0], 404)
        self.assertEqual(h.request("POST", "/elsewhere", b"x")[0], 404)
        self.assertEqual(h.request("GET", "/transcribe")[0], 405)
        self.assertEqual(self.engine.calls, [])


class LimitTests(ServerCase):
    def test_body_over_the_size_limit_is_413(self) -> None:
        wav = make_wav(1000)
        h = self.start(max_body=len(wav) - 1)
        status, body = h.post(body=wav)
        self.assertEqual((status, body), (413, {"error": "too_large"}))
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(h.files_left(), [])

    def test_body_exactly_at_the_limit_is_taken(self) -> None:
        wav = make_wav(1000)
        h = self.start(max_body=len(wav))
        self.assertEqual(h.post(body=wav)[0], 200)

    def test_a_huge_announced_length_is_refused_without_waiting_for_the_body(self) -> None:
        h = self.start()
        conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=10)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Authorization", "Bearer " + SECRET)
        conn.putheader("Content-Type", "audio/wav")
        conn.putheader("Content-Length", str(10 ** 10))
        conn.endheaders()  # and no body at all
        res = conn.getresponse()
        self.assertEqual((res.status, json.loads(res.read())), (413, {"error": "too_large"}))
        conn.close()

    def test_audio_over_the_duration_limit_is_413_too_long(self) -> None:
        h = self.start(probe=lambda path: 20 * 60 + 1)
        status, body = h.post()
        self.assertEqual((status, body), (413, {"error": "too_long"}))
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(h.files_left(), [])
        self.assertEqual(json.loads(h.logs[-1])["result"], "too_long")
        self.assertEqual(json.loads(h.logs[-1])["seconds"], 1201.0)

    def test_audio_exactly_twenty_minutes_is_taken(self) -> None:
        self.assertEqual(self.start(probe=lambda path: 20 * 60.0).post()[0], 200)

    def test_text_is_capped_at_30000_characters(self) -> None:
        engine = FakeEngine([seg("字" * 40000)])
        status, body = self.start(engine).post()
        self.assertEqual(status, 200)
        self.assertEqual(len(body["text"]), 30000)


class BusyTests(ServerCase):
    def test_a_second_request_while_one_runs_is_503_at_once(self) -> None:
        engine = FakeEngine()
        engine.hold = threading.Event()
        h = self.start(engine)
        first = {}

        def run_first() -> None:
            first["answer"] = h.post()

        t = threading.Thread(target=run_first)
        t.start()
        self.assertTrue(engine.entered.wait(10), "the first request never reached the engine")

        began = time.monotonic()
        # A body of about 1 MB: the busy answer must also arrive when there is something to read off first.
        status, body = h.post(body=make_wav(500_000))
        self.assertEqual((status, body), (503, {"error": "busy"}))
        self.assertLess(time.monotonic() - began, 2.0)
        self.assertEqual(len(engine.calls), 1)  # the second never reached the engine

        engine.hold.set()
        t.join(10)
        self.assertEqual(first["answer"][0], 200)
        self.assertEqual(h.post()[0], 200)  # and when it is over, the next one is taken
        self.assertEqual([json.loads(l)["result"] for l in h.logs], ["busy", "ok", "ok"])

    def test_requests_one_after_another_are_never_busy(self) -> None:
        # The engine is free (and the file gone) before the answer goes out, so the next request can follow at once.
        h = self.start()
        for _ in range(30):
            self.assertEqual(h.post()[0], 200)

    def test_the_engine_is_free_and_the_file_gone_before_the_answer_goes_out(self) -> None:
        # The log line is written just before the answer is sent: look at the lock and the folder at that moment.
        h = self.start()
        seen = []
        log = h.app.log
        h.app.log = lambda line: (seen.append((h.app._busy.locked(), os.listdir(h.tmp.name))), log(line))  # type: ignore[assignment]
        engine = self.engine
        for outcome, setup in (("ok", None), ("failed", RuntimeError("boom"))):
            engine.raises = setup
            seen.clear()
            h.post()
            self.assertEqual(seen, [(False, [])], outcome)

    def test_a_failed_request_frees_the_engine(self) -> None:
        engine = FakeEngine()
        engine.raises = RuntimeError("boom")
        h = self.start(engine)
        self.assertEqual(h.post()[0], 500)
        engine.raises = None
        self.assertEqual(h.post()[0], 200)


class BadInputTests(ServerCase):
    def test_not_audio_is_400_bad_audio(self) -> None:
        h = self.start()
        status, body = h.post(body=b"this is not audio, it is a sentence of text")
        self.assertEqual((status, body), (400, {"error": "bad_audio"}))
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(h.files_left(), [])

    def test_a_playlist_that_ffmpeg_would_follow_is_refused_before_ffprobe(self) -> None:
        probed = []
        h = self.start(probe=lambda path: probed.append(path) or 1.0)
        status, _ = h.post(body=b"#EXTM3U\n#EXTINF:1,\nfile:///etc/hosts\n")
        self.assertEqual(status, 400)
        self.assertEqual(probed, [])

    def test_empty_body_is_400_bad_audio(self) -> None:
        h = self.start()
        self.assertEqual(h.post(body=b"")[1], {"error": "bad_audio"})

    def test_audio_that_ffprobe_cannot_read_is_400(self) -> None:
        def unreadable(path: str) -> float:
            raise BadAudio("no")

        h = self.start(probe=unreadable)
        self.assertEqual(h.post(), (400, {"error": "bad_audio"}))
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(h.files_left(), [])
        self.assertEqual(json.loads(h.logs[-1])["result"], "bad_audio")

    def test_a_missing_ffprobe_is_our_failure_not_the_senders(self) -> None:
        def missing(path: str) -> float:
            raise ProbeUnavailable("not installed")

        h = self.start(probe=missing)
        self.assertEqual(h.post(), (500, {"error": "failed"}))
        self.assertEqual(h.files_left(), [])

    def test_content_types(self) -> None:
        h = self.start()
        for ctype in ("audio/ogg", "audio/mp4", "audio/wav", "application/octet-stream", "audio/wav; codecs=1", None):
            with self.subTest(ctype=ctype):
                self.assertEqual(h.post(ctype=ctype)[0], 200)
        for ctype in ("application/json", "application/x-www-form-urlencoded", "text/plain", "multipart/form-data"):
            with self.subTest(ctype=ctype):
                self.assertEqual(h.post(ctype=ctype), (415, {"error": "unsupported_type"}))

    def test_a_body_without_a_length_is_411(self) -> None:
        h = self.start()
        conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=10)
        conn.request("POST", "/transcribe", body=iter([make_wav()]), encode_chunked=True,
                     headers={"Authorization": "Bearer " + SECRET, "Content-Type": "audio/wav"})
        res = conn.getresponse()
        self.assertEqual((res.status, json.loads(res.read())), (411, {"error": "length_required"}))
        conn.close()

    def test_a_body_that_stops_short_is_400_and_leaves_no_file(self) -> None:
        h = self.start()
        wav = make_wav()
        conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=10)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Authorization", "Bearer " + SECRET)
        conn.putheader("Content-Type", "audio/wav")
        conn.putheader("Content-Length", str(len(wav) + 500))
        conn.endheaders(wav)
        conn.sock.shutdown(1)  # SHUT_WR: the server is waiting for 500 more bytes, and now knows none are coming
        res = conn.getresponse()
        self.assertEqual((res.status, json.loads(res.read())), (400, {"error": "bad_request"}))
        conn.close()
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(h.files_left(), [])


class LanguageTests(ServerCase):
    def test_lang_is_passed_on(self) -> None:
        h = self.start()
        for query, expected in (("", None), ("?lang=auto", None), ("?lang=zh", "zh"), ("?lang=en", "en")):
            with self.subTest(query=query):
                self.engine.calls.clear()
                self.assertEqual(h.post(query=query)[0], 200)
                self.assertEqual(self.engine.calls[0][0], expected)

    def test_a_language_that_is_not_offered_is_400(self) -> None:
        h = self.start()
        for query in ("?lang=fr", "?lang=", "?lang=ZH", "?lang=zh&lang=en"):
            with self.subTest(query=query):
                self.assertEqual(h.post(query=query), (400, {"error": "bad_lang"}))
        self.assertEqual(self.engine.calls, [])


class AnswerTests(ServerCase):
    def test_a_normal_answer(self) -> None:
        engine = FakeEngine([seg("大家好，", 0, 2), seg("今天我们来聊聊茶。", 2, 5)], language="zh")
        h = self.start(engine, probe=lambda path: 12.34)
        status, body = h.post(query="?lang=zh")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"text": "大家好，今天我们来聊聊茶。", "seconds": 12.3, "language": "zh", "speech": True})
        self.assertEqual(engine.calls[0][1], make_wav())  # what the engine heard is what was sent
        self.assertEqual(h.last_headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(h.last_headers["Cache-Control"], "no-store")

    def test_english(self) -> None:
        engine = FakeEngine([seg(" Hello and welcome to the show."), seg(" Today we talk about tea.")], language="en")
        body = self.start(engine).post(query="?lang=en")[1]
        self.assertEqual(body["text"], "Hello and welcome to the show. Today we talk about tea.")
        self.assertEqual(body["language"], "en")

    def test_nothing_credible_is_no_speech_with_empty_text(self) -> None:
        engine = FakeEngine([
            seg("字幕由Amara.org社区提供", avg_logprob=-0.4),
            seg("你好吗", no_speech_prob=0.9, avg_logprob=-1.5),
            seg("啊啊啊啊啊啊啊啊啊啊", compression_ratio=3.1),
        ])
        h = self.start(engine)
        status, body = h.post()
        self.assertEqual(status, 200)
        self.assertEqual(body, {"text": "", "seconds": 2.0, "language": "zh", "speech": False})
        self.assertEqual(json.loads(h.logs[-1])["result"], "no_speech")

    def test_an_engine_that_hears_nothing_at_all(self) -> None:
        body = self.start(FakeEngine([])).post()[1]
        self.assertEqual((body["text"], body["speech"]), ("", False))

    def test_the_engine_failing_is_500_failed(self) -> None:
        engine = FakeEngine()
        engine.raises = RuntimeError("the model fell over")
        status, body = self.start(engine).post()
        self.assertEqual((status, body), (500, {"error": "failed"}))


class TempFileTests(ServerCase):
    def test_the_audio_is_a_file_while_the_engine_works_and_gone_after(self) -> None:
        h = self.start()
        seen = []
        original = self.engine.transcribe

        def looking(path, language):
            seen.append(os.listdir(h.tmp.name))
            return original(path, language)

        self.engine.transcribe = looking  # type: ignore[method-assign]
        self.assertEqual(h.post()[0], 200)
        self.assertEqual(len(seen[0]), 1)  # it was there
        # and it is gone by the time the answer is in our hands (it is removed before the answer is sent)
        self.assertEqual(h.files_left(), [])

    def test_removed_even_when_the_engine_raises(self) -> None:
        engine = FakeEngine()
        engine.raises = RuntimeError("boom")
        h = self.start(engine)
        self.assertEqual(h.post()[0], 500)
        self.assertEqual(len(engine.calls), 1)  # it did run
        self.assertEqual(h.files_left(), [])

    def test_removed_even_when_the_filter_raises(self) -> None:
        h = self.start(FakeEngine([None]))  # type: ignore[list-item]  # not a segment: the filter fails on it
        self.assertEqual(h.post()[0], 500)
        self.assertEqual(h.files_left(), [])

    def test_stopping_removes_files_in_use(self) -> None:
        engine = FakeEngine()
        engine.hold = threading.Event()
        h = self.start(engine)
        t = threading.Thread(target=h.post)
        t.start()
        self.assertTrue(engine.entered.wait(10))
        self.assertEqual(len(h.files_left()), 1)
        h.app.cleanup()  # what the SIGTERM handler's `finally` does
        self.assertEqual(h.files_left(), [])
        engine.hold.set()
        t.join(10)


class LogTests(ServerCase):
    def lines(self, h):
        return [json.loads(l) for l in h.logs]

    def test_one_json_line_per_request_with_only_the_allowed_fields(self) -> None:
        h = self.start(probe=lambda path: 7.0)
        h.post()  # ok
        h.post(key="wrong-key-of-a-fair-length-xxxx")  # unauthorized
        h.post(body=b"not audio at all, just text here")  # bad_audio
        h.post(query="?lang=xx")  # bad_request
        lines = self.lines(h)
        self.assertEqual([l["result"] for l in lines], ["ok", "unauthorized", "bad_audio", "bad_request"])
        for line in lines:
            self.assertLessEqual(set(line), {"at", "result", "seconds", "ms", "err"})
            self.assertIsInstance(line["ms"], int)
            self.assertRegex(line["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$")
        self.assertEqual(lines[0]["seconds"], 7.0)
        self.assertIsNone(lines[1]["seconds"])

    def test_no_text_no_key_no_file_name_in_any_line(self) -> None:
        spoken = "这是视频里说的一句很特别的话"
        engine = FakeEngine([seg(spoken)])
        h = self.start(engine)
        h.post()
        h.post(key="x" * 30)
        engine.raises = RuntimeError("could not read " + spoken + " from the file")
        h.post()
        # What the engine's exception says may hold the text or the file name: only its class is logged.
        engine.raises = ValueError(engine.calls[0][2])
        h.post()
        engine.raises = None
        h.post(body=b"not audio at all, just text here")
        everything = "\n".join(h.logs)
        self.assertGreaterEqual(len(h.logs), 5)
        self.assertNotIn(spoken, everything)
        self.assertNotIn(SECRET, everything)
        self.assertNotIn("x" * 30, everything)
        for path in {c[2] for c in engine.calls}:
            self.assertNotIn(os.path.basename(path), everything)
            self.assertNotIn(os.path.dirname(path), everything)
        self.assertIn('"err": "RuntimeError"', everything)

    def test_the_log_is_not_where_the_http_server_prints_requests(self) -> None:
        # BaseHTTPRequestHandler would write 'POST /transcribe?lang=zh HTTP/1.1' lines to stderr; ours are the only ones.
        import contextlib
        import io

        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            h = self.start()
            h.post(query="?lang=zh")
            h.request("GET", "/healthz", key=None)
        self.assertEqual(err.getvalue(), "")


class WatchdogTests(ServerCase):
    def test_a_transcription_that_never_ends_calls_on_hang(self) -> None:
        engine = FakeEngine()
        engine.hold = threading.Event()
        hung = threading.Event()

        def on_hang() -> None:
            hung.set()
            engine.hold.set()  # a real one exits the process; here it lets the fake engine go

        h = self.start(engine, on_hang=on_hang, engine_timeout=0.3)
        h.post()
        self.assertTrue(hung.is_set())

    def test_a_normal_transcription_does_not(self) -> None:
        hung = threading.Event()
        h = self.start(on_hang=hung.set, engine_timeout=0.3)
        h.post()
        time.sleep(0.5)
        self.assertFalse(hung.is_set())

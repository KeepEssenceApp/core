from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from ke_transcriber import audio

from .helpers import make_wav


class LooksLikeAudioTests(unittest.TestCase):
    def test_accepted_containers(self) -> None:
        heads = {
            "ogg": b"OggS\x00\x02" + b"\x00" * 10,
            "wav": make_wav(10)[:16],
            "aiff": b"FORM\x00\x00\x00\x00AIFF" + b"\x00" * 4,
            "m4a": b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 4,
            "mp4": b"\x00\x00\x00\x20ftypisom" + b"\x00" * 4,
            "flac": b"fLaC" + b"\x00" * 12,
            "mp3 with a tag": b"ID3\x04" + b"\x00" * 12,
            "mp3 frame": b"\xff\xfb\x90\x00" + b"\x00" * 12,
            "aac adts": b"\xff\xf1\x50\x80" + b"\x00" * 12,
            "webm": b"\x1aE\xdf\xa3" + b"\x00" * 12,
        }
        for name, head in heads.items():
            with self.subTest(name):
                self.assertTrue(audio.looks_like_audio(head))

    def test_everything_else_is_refused(self) -> None:
        for head in (b"", b"#EXTM3U\n#EXTINF", b"<?xml version", b"#!/bin/sh\necho", b"RIFF\x00\x00\x00\x00AVI LIST", b"MZ\x90\x00", b"\x00" * 16, b"ffconcat version 1.0"):
            with self.subTest(head[:8]):
                self.assertFalse(audio.looks_like_audio(head))


class ParseProbeTests(unittest.TestCase):
    def out(self, duration, streams=({"codec_type": "audio"},)) -> str:
        return json.dumps({"streams": list(streams), "format": {"duration": duration}})

    def test_seconds(self) -> None:
        self.assertAlmostEqual(audio.parse_probe(self.out("12.345000")), 12.345)

    def test_unreadable_answers(self) -> None:
        cases = {
            "not json": "no good",
            "empty": "",
            "no format": json.dumps({"streams": [{"codec_type": "audio"}]}),
            "N/A": self.out("N/A"),
            "zero": self.out("0.000000"),
            "negative": self.out("-3"),
            "nan": self.out("nan"),
            "inf": self.out("inf"),
            "no audio stream": self.out("5.0", streams=({"codec_type": "video"},)),
            "no streams at all": self.out("5.0", streams=()),
            "a list": "[]",
        }
        for name, text in cases.items():
            with self.subTest(name):
                with self.assertRaises(audio.BadAudio):
                    audio.parse_probe(text)


class ProbeDurationTests(unittest.TestCase):
    def test_argument_list_without_a_shell_and_with_a_timeout(self) -> None:
        done = subprocess.CompletedProcess([], 0, stdout=b'{"streams":[{"codec_type":"audio"}],"format":{"duration":"3.0"}}', stderr=b"")
        with mock.patch.object(audio.subprocess, "run", return_value=done) as run:
            self.assertEqual(audio.probe_duration("/tmp/some file; rm -rf x.audio", timeout=7), 3.0)
        argv = run.call_args[0][0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[0], "ffprobe")
        self.assertEqual(argv[-1], "/tmp/some file; rm -rf x.audio")  # one argument, whatever is in it
        self.assertIn("file", argv[argv.index("-protocol_whitelist") + 1 :][:1])  # local files only
        self.assertEqual(run.call_args[1]["timeout"], 7)
        self.assertFalse(run.call_args[1].get("shell"))

    def test_timeout_is_bad_audio(self) -> None:
        with mock.patch.object(audio.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffprobe", 1)):
            with self.assertRaises(audio.BadAudio):
                audio.probe_duration("x")

    def test_nonzero_exit_is_bad_audio(self) -> None:
        with mock.patch.object(audio.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"x")):
            with self.assertRaises(audio.BadAudio):
                audio.probe_duration("x")

    def test_no_ffprobe_is_unavailable(self) -> None:
        with mock.patch.dict(os.environ, {"PATH": ""}):
            with self.assertRaises(audio.ProbeUnavailable):
                audio.probe_duration("x")


@unittest.skipUnless(shutil.which("ffprobe"), "ffprobe is not installed here")
class RealFfprobeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def write(self, name: str, data: bytes) -> str:
        path = os.path.join(self.dir.name, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def test_a_wav_has_its_duration(self) -> None:
        path = self.write("a.audio", make_wav(16000 * 3))
        self.assertAlmostEqual(audio.probe_duration(path), 3.0, places=2)

    def test_garbage_is_bad_audio(self) -> None:
        with self.assertRaises(audio.BadAudio):
            audio.probe_duration(self.write("b.audio", b"RIFF" + b"\x00" * 100))
        with self.assertRaises(audio.BadAudio):
            audio.probe_duration(self.write("c.audio", b"this is not audio" * 20))

    def test_a_playlist_does_not_make_ffprobe_open_what_it_names(self) -> None:
        target = self.write("secret.txt", b"not audio")
        path = self.write("p.audio", ("#EXTM3U\n#EXTINF:1,\nfile://%s\n" % target).encode())
        with self.assertRaises(audio.BadAudio):
            audio.probe_duration(path)

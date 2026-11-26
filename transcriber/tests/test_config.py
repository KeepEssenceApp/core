from __future__ import annotations

import contextlib
import io
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from ke_transcriber import server
from ke_transcriber.config import Config, ConfigError
from ke_transcriber.engine import DEFAULT_MODEL

from .helpers import SECRET, FakeEngine

PACKAGE_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the `transcriber` folder


class ConfigTests(unittest.TestCase):
    def test_the_key_is_required(self) -> None:
        with self.assertRaises(ConfigError):
            Config.from_env({})
        with self.assertRaises(ConfigError):
            Config.from_env({"TRANSCRIBER_KEY": ""})

    def test_the_key_must_be_24_characters(self) -> None:
        with self.assertRaises(ConfigError):
            Config.from_env({"TRANSCRIBER_KEY": "k" * 23})
        self.assertEqual(Config.from_env({"TRANSCRIBER_KEY": "k" * 24}).key, "k" * 24)
        with self.assertRaises(ConfigError):
            Config.from_env({"TRANSCRIBER_KEY": " " * 30})
        with self.assertRaises(ConfigError):
            Config.from_env({"TRANSCRIBER_KEY": "k" * 30 + "\n"})  # a newline from a badly written env file

    def test_defaults(self) -> None:
        cfg = Config.from_env({"TRANSCRIBER_KEY": SECRET})
        self.assertEqual((cfg.host, cfg.port, cfg.model), ("127.0.0.1", 8830, "mlx-community/whisper-large-v3-turbo"))
        self.assertEqual(cfg.model, DEFAULT_MODEL)
        self.assertEqual((cfg.max_body, cfg.max_seconds, cfg.max_chars), (40 * 1024 * 1024, 1200, 30000))

    def test_overrides(self) -> None:
        cfg = Config.from_env({"TRANSCRIBER_KEY": SECRET, "TRANSCRIBER_HOST": "100.64.0.9", "TRANSCRIBER_PORT": "9001", "TRANSCRIBER_MODEL": "a/b"})
        self.assertEqual((cfg.host, cfg.port, cfg.model), ("100.64.0.9", 9001, "a/b"))

    def test_empty_values_mean_the_default(self) -> None:
        cfg = Config.from_env({"TRANSCRIBER_KEY": SECRET, "TRANSCRIBER_HOST": "", "TRANSCRIBER_PORT": "", "TRANSCRIBER_MODEL": ""})
        self.assertEqual((cfg.host, cfg.port, cfg.model), ("127.0.0.1", 8830, DEFAULT_MODEL))

    def test_bad_port(self) -> None:
        for port in ("abc", "0", "70000", "-1"):
            with self.subTest(port=port):
                with self.assertRaises(ConfigError):
                    Config.from_env({"TRANSCRIBER_KEY": SECRET, "TRANSCRIBER_PORT": port})

    def test_the_key_is_not_in_the_repr_or_in_an_error(self) -> None:
        self.assertNotIn(SECRET, repr(Config.from_env({"TRANSCRIBER_KEY": SECRET})))
        short = "short-" + "z" * 10
        with self.assertRaises(ConfigError) as caught:
            Config.from_env({"TRANSCRIBER_KEY": short})
        self.assertNotIn(short, str(caught.exception))


class StartUpTests(unittest.TestCase):
    def run_main(self, argv, env):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = server.main(argv, env)
        return code, out.getvalue(), err.getvalue()

    def test_refuses_to_start_without_a_key(self) -> None:
        code, _, err = self.run_main([], {})
        self.assertEqual(code, 2)
        self.assertIn("TRANSCRIBER_KEY", err)

    def test_refuses_a_short_key_and_does_not_print_it(self) -> None:
        short = "short-" + "z" * 10
        code, out, err = self.run_main([], {"TRANSCRIBER_KEY": short})
        self.assertEqual(code, 2)
        self.assertNotIn(short, out + err)

    def test_the_real_command_refuses_too(self) -> None:
        # The way launchd starts it: a fresh process, an environment without the key.
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": PACKAGE_PARENT}
        with tempfile.TemporaryDirectory() as cwd:
            done = subprocess.run([sys.executable, "-m", "ke_transcriber"], env=env, cwd=cwd, capture_output=True, timeout=30)
        self.assertEqual(done.returncode, 2)
        self.assertIn(b"TRANSCRIBER_KEY", done.stderr)
        self.assertEqual(done.stdout, b"")

    def test_unknown_arguments(self) -> None:
        self.assertEqual(self.run_main(["--serve-everything"], {"TRANSCRIBER_KEY": SECRET})[0], 2)

    def test_refuses_when_ffprobe_is_not_on_the_path(self) -> None:
        with mock.patch.object(server.shutil, "which", return_value=None):
            code, _, err = self.run_main([], {"TRANSCRIBER_KEY": SECRET})
        self.assertEqual(code, 3)
        self.assertIn("ffprobe", err)
        self.assertIn("/opt/homebrew/bin", err)
        self.assertNotIn(SECRET, err)

    def test_says_so_when_the_address_cannot_be_used(self) -> None:
        taken = socket.socket()
        self.addCleanup(taken.close)
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        env = {"TRANSCRIBER_KEY": SECRET, "TRANSCRIBER_PORT": str(taken.getsockname()[1])}
        with mock.patch.object(server.shutil, "which", return_value="/usr/bin/true"):
            code, _, err = self.run_main([], env)
        self.assertEqual(code, 4)
        self.assertIn("cannot listen", err)
        self.assertNotIn(SECRET, err)


class SweepTests(unittest.TestCase):
    def test_stale_audio_files_are_removed_and_nothing_else(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            for name in ("ke-transcriber-abc.audio", "ke-transcriber-def.audio", "ke-transcriber-x.wav", "other.audio", "notes.txt"):
                open(os.path.join(d, name), "wb").close()
            self.assertEqual(server.sweep_stale(d), 2)
            self.assertEqual(sorted(os.listdir(d)), ["ke-transcriber-x.wav", "notes.txt", "other.audio"])


class CheckTests(unittest.TestCase):
    def test_check_listens_to_a_second_of_silence_and_cleans_up(self) -> None:
        engine = FakeEngine([])
        with tempfile.TemporaryDirectory() as d:
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(server.run_check(engine, d), 0)
            self.assertEqual(os.listdir(d), [])
        self.assertIn("engine ok", out.getvalue())
        language, data, _ = engine.calls[0]
        self.assertEqual(language, "zh")
        self.assertEqual(len(data), 44 + 32000)  # a WAV header and one second of 16 kHz, 16-bit silence

    def test_check_reports_a_failing_engine(self) -> None:
        engine = FakeEngine()
        engine.raises = RuntimeError("no model on disk")
        with tempfile.TemporaryDirectory() as d:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(server.run_check(engine, d), 1)
            self.assertEqual(os.listdir(d), [])
        self.assertIn("RuntimeError", err.getvalue())

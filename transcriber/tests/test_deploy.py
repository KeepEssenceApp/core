"""The files that go to the machine: the launchd agent and the wrapper it starts."""
from __future__ import annotations

import os
import plistlib
import stat
import subprocess
import tempfile
import unittest

DEPLOY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "deploy")
RUN_SH = os.path.join(DEPLOY, "run.sh")
PLIST = os.path.join(DEPLOY, "app.keepessence.transcriber.plist")


class PlistTests(unittest.TestCase):
    def setUp(self) -> None:
        with open(PLIST, "rb") as f:
            self.plist = plistlib.load(f)

    def test_it_is_kept_alive_and_started_at_login(self) -> None:
        self.assertEqual(self.plist["Label"], "app.keepessence.transcriber")
        self.assertIs(self.plist["RunAtLoad"], True)
        self.assertIs(self.plist["KeepAlive"], True)
        self.assertGreaterEqual(self.plist["ThrottleInterval"], 5)

    def test_it_starts_the_wrapper_from_the_installed_folder(self) -> None:
        self.assertEqual(self.plist["ProgramArguments"], ["__HOME__/ke-transcriber/app/deploy/run.sh"])
        self.assertEqual(self.plist["WorkingDirectory"], "__HOME__/ke-transcriber/app")

    def test_homebrew_is_on_the_path_and_no_secret_is_in_the_file(self) -> None:
        self.assertIn("/opt/homebrew/bin", self.plist["EnvironmentVariables"]["PATH"].split(":"))
        with open(PLIST, encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn("TRANSCRIBER_KEY", text)

    def test_only_home_is_left_to_fill_in(self) -> None:
        with open(PLIST, encoding="utf-8") as f:
            text = f.read()
        filled = plistlib.loads(text.replace("__HOME__", "/Users/someone").encode())
        self.assertNotIn("__", repr(filled))


class WrapperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        root = os.path.join(self.home.name, "ke-transcriber")
        os.makedirs(os.path.join(root, "app"))
        os.makedirs(os.path.join(root, "venv", "bin"))
        # A stand-in for the venv's Python that says what it was started with.
        fake_python = os.path.join(root, "venv", "bin", "python")
        with open(fake_python, "w") as f:
            f.write('#!/bin/sh\necho "args=$* key=$TRANSCRIBER_KEY offline=$HF_HUB_OFFLINE cwd=$(pwd) path=$PATH"\n')
        os.chmod(fake_python, 0o755)
        self.env_file = os.path.join(self.home.name, "env")

    def write_env(self, mode: int, text: str = "TRANSCRIBER_KEY=fake-key-for-the-wrapper-test-0123\nTRANSCRIBER_HOST=100.64.0.9\n") -> None:
        with open(self.env_file, "w") as f:
            f.write(text)
        os.chmod(self.env_file, mode)

    def run_wrapper(self):
        env = {"HOME": self.home.name, "PATH": "/usr/bin:/bin", "TRANSCRIBER_ENV_FILE": self.env_file}
        return subprocess.run([RUN_SH], env=env, capture_output=True, text=True, timeout=30)

    def test_the_file_is_executable(self) -> None:
        self.assertTrue(os.stat(RUN_SH).st_mode & stat.S_IXUSR)

    def test_it_reads_the_env_file_and_becomes_python(self) -> None:
        self.write_env(0o600)
        done = self.run_wrapper()
        self.assertEqual(done.returncode, 0, done.stderr)
        out = done.stdout
        self.assertIn("args=-m ke_transcriber", out)
        self.assertIn("key=fake-key-for-the-wrapper-test-0123", out)  # the server gets it, in its environment
        self.assertIn("offline=1", out)
        self.assertTrue(os.path.realpath(out.split("cwd=")[1].split(" path=")[0]).endswith("ke-transcriber/app"))
        self.assertIn("/opt/homebrew/bin", out.split("path=")[1])
        self.assertEqual(done.stderr, "")

    def test_a_read_only_env_file_is_fine(self) -> None:
        self.write_env(0o400)
        self.assertEqual(self.run_wrapper().returncode, 0)

    def test_it_refuses_an_env_file_others_can_read_and_does_not_print_the_key(self) -> None:
        for mode in (0o644, 0o640, 0o660, 0o666, 0o604):
            with self.subTest(mode=oct(mode)):
                self.write_env(mode)
                done = self.run_wrapper()
                self.assertEqual(done.returncode, 78)
                self.assertNotIn("fake-key", done.stdout + done.stderr)
                self.assertIn("mode 600", done.stderr)

    def test_it_refuses_a_missing_env_file(self) -> None:
        done = self.run_wrapper()
        self.assertEqual(done.returncode, 78)
        self.assertIn("cannot read", done.stderr)

    def test_the_script_never_echoes_the_key(self) -> None:
        with open(RUN_SH) as f:
            text = f.read()
        self.assertNotIn("echo $TRANSCRIBER_KEY", text)
        self.assertNotIn('echo "$TRANSCRIBER_KEY"', text)
        self.assertNotIn("set -x", text)

"""Looking at the bytes before anything decodes them: is it audio, and how long.

Run on bytes a stranger could have sent, so: ffprobe is started from an argument list (no shell), with a timeout,
restricted to local files, and only containers that start with a known audio signature get that far (a playlist
or script that makes ffmpeg open other files or addresses does not).
"""
from __future__ import annotations

import json
import math
import subprocess


class BadAudio(Exception):
    """The bytes are not audio ffprobe can read."""


class ProbeUnavailable(Exception):
    """ffprobe itself is not there or cannot run: the machine's problem, not the sender's."""


def looks_like_audio(head: bytes) -> bool:
    """The first bytes name a container we accept: Ogg (Opus, Vorbis), WAV, AIFF, MP4/M4A, FLAC, MP3, AAC, WebM/Matroska."""
    return (
        head[:4] == b"OggS"
        or (head[:4] == b"RIFF" and head[8:12] == b"WAVE")
        or (head[:4] == b"FORM" and head[8:12] in (b"AIFF", b"AIFC"))
        or head[4:8] == b"ftyp"
        or head[:4] == b"fLaC"
        or head[:3] == b"ID3"
        or head[:4] == b"\x1aE\xdf\xa3"
        or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0)  # MPEG audio / ADTS frame sync
    )


def parse_probe(stdout: str) -> float:
    """Seconds from ffprobe's JSON (`-show_entries format=duration:stream=codec_type -of json`)."""
    try:
        data = json.loads(stdout)
        streams = data.get("streams") or []
        seconds = float(data["format"]["duration"])
    except (ValueError, KeyError, TypeError, AttributeError):
        raise BadAudio("no duration")
    if not any(isinstance(s, dict) and s.get("codec_type") == "audio" for s in streams):
        raise BadAudio("no audio stream")
    if not math.isfinite(seconds) or seconds <= 0:
        raise BadAudio("no duration")
    return seconds


def probe_duration(path: str, timeout: float = 15.0) -> float:
    argv = [
        "ffprobe", "-v", "error",
        "-protocol_whitelist", "file",
        "-show_entries", "format=duration:stream=codec_type",
        "-of", "json",
        path,
    ]
    try:
        done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError:
        raise ProbeUnavailable("ffprobe is not installed")
    except subprocess.TimeoutExpired:
        raise BadAudio("ffprobe did not finish")  # the child is killed by subprocess.run
    if done.returncode != 0:
        raise BadAudio("ffprobe cannot read it")
    return parse_probe(done.stdout.decode("utf-8", "replace"))

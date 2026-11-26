from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Optional

from .engine import DEFAULT_MODEL

MIN_KEY_CHARS = 24


class ConfigError(Exception):
    """The environment is not enough to start with. The message never contains the key."""


@dataclass(frozen=True)
class Config:
    key: str = field(repr=False)
    host: str = "127.0.0.1"
    port: int = 8830
    model: str = DEFAULT_MODEL
    # Limits (fixed by the interface; fields so the tests can use small ones).
    max_body: int = 40 * 1024 * 1024  # bytes
    max_seconds: float = 20 * 60  # audio
    max_chars: int = 30000  # of the answer's text
    probe_timeout: float = 15.0  # ffprobe
    engine_timeout: float = 45 * 60  # a transcription that takes longer is hung: the process exits and launchd restarts it
    tmp_dir: Optional[str] = None  # None: the system's

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Config":
        key = env.get("TRANSCRIBER_KEY", "")
        if len(key.strip()) < MIN_KEY_CHARS or key != key.strip():
            raise ConfigError("TRANSCRIBER_KEY is required: at least %d characters, no spaces around it" % MIN_KEY_CHARS)
        port_text = env.get("TRANSCRIBER_PORT") or "8830"
        try:
            port = int(port_text)
        except ValueError:
            raise ConfigError("TRANSCRIBER_PORT must be a number")
        if not 1 <= port <= 65535:
            raise ConfigError("TRANSCRIBER_PORT must be between 1 and 65535")
        return Config(
            key=key,
            host=env.get("TRANSCRIBER_HOST") or "127.0.0.1",
            port=port,
            model=env.get("TRANSCRIBER_MODEL") or DEFAULT_MODEL,
        )

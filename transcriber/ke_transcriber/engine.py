"""The speech engine behind a small interface.

An engine turns an audio file into timed segments (with the scores the quality filter looks at) and the
language it heard. `MlxEngine` is the one real engine (Whisper on Apple silicon through `mlx_whisper`);
the tests use a fake one. `mlx_whisper` is imported when the first request comes, so everything else
here (and the whole test suite) works without it installed.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"

# A plain Mandarin sentence as the prompt: it makes Whisper write simplified characters (without it the same
# speech often comes out in traditional ones). Only used when the speech is Chinese.
ZH_PROMPT = "以下是普通话的句子。"

# Whisper's own fallback: a window that decodes badly is decoded again, hotter.
TEMPERATURES = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


@dataclass(frozen=True)
class Segment:
    text: str
    start: float
    end: float
    avg_logprob: float
    no_speech_prob: float
    compression_ratio: float


@dataclass(frozen=True)
class Transcription:
    segments: List[Segment]
    language: str  # what the engine heard (or was told), e.g. "zh", "en"


class Engine:
    """What the server needs from an engine. `language` is "zh", "en" or None (detect it)."""

    def transcribe(self, path: str, language: Optional[str]) -> Transcription:  # pragma: no cover - interface
        raise NotImplementedError


class MlxEngine(Engine):
    def __init__(self, model: str = DEFAULT_MODEL) -> None:
        self.model = model
        self._mlx: Any = None

    def _module(self) -> Any:
        if self._mlx is None:
            import mlx_whisper  # lazily: not installed where the tests run

            self._mlx = mlx_whisper
        return self._mlx

    def _run(self, path: str, language: Optional[str]) -> Any:
        options: dict = dict(
            path_or_hf_repo=self.model,
            # None, not False or True: True prints every recognized sentence to stdout, and nothing said in a video may reach a log.
            verbose=None,
            temperature=TEMPERATURES,
            compression_ratio_threshold=2.4,
            logprob_threshold=-1.0,
            no_speech_threshold=0.6,
            # One window's mistake or loop must not carry into the next one.
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        if language is not None:
            options["language"] = language
        if language == "zh":
            options["initial_prompt"] = ZH_PROMPT
        return self._module().transcribe(path, **options)

    def transcribe(self, path: str, language: Optional[str]) -> Transcription:
        result = self._run(path, language)
        if language is None and result.get("language") == "zh":
            # Detected Mandarin without the prompt: do it again with the prompt, so the characters are simplified.
            # (A caller that already knows it is Chinese passes lang=zh and saves this second pass.)
            result = self._run(path, "zh")
        segments = [
            Segment(
                text=str(s["text"]),
                start=float(s["start"]),
                end=float(s["end"]),
                avg_logprob=float(s["avg_logprob"]),
                no_speech_prob=float(s["no_speech_prob"]),
                compression_ratio=float(s["compression_ratio"]),
            )
            for s in result["segments"]
        ]
        return Transcription(segments=segments, language=str(result.get("language") or language or ""))

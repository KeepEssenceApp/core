"""The real engine, with a fake `mlx_whisper` module in its place: what is asked of Whisper, and what is read of its answer.

(That the real library, on the real GPU, accepts these arguments is not shown here: it cannot be installed where these
tests run. See the README for the check to run on the machine.)
"""
from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

from ke_transcriber.engine import DEFAULT_MODEL, ZH_PROMPT, MlxEngine


def whisper_segment(text: str = "今天天气很好。", **kw) -> dict:
    base = {"id": 0, "seek": 0, "start": 0.0, "end": 2.5, "text": text, "tokens": [1, 2], "temperature": 0.0,
            "avg_logprob": -0.31, "compression_ratio": 1.4, "no_speech_prob": 0.02}
    base.update(kw)
    return base


class FakeMlx(types.ModuleType):
    def __init__(self, *answers: dict) -> None:
        super().__init__("mlx_whisper")
        self.answers = list(answers)
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        return self.answers.pop(0)


def answer(language: str, *segments: dict) -> dict:
    return {"text": "".join(s["text"] for s in segments), "segments": list(segments), "language": language}


class MlxEngineTests(unittest.TestCase):
    def run_engine(self, fake: FakeMlx, language, model: str = DEFAULT_MODEL):
        with mock.patch.dict(sys.modules, {"mlx_whisper": fake}):
            return MlxEngine(model).transcribe("/tmp/x.audio", language)

    def test_not_imported_until_used(self) -> None:
        sys.modules.pop("mlx_whisper", None)
        MlxEngine()  # no import, no error
        self.assertNotIn("mlx_whisper", sys.modules)

    def test_chinese_gets_the_prompt_and_the_safe_options(self) -> None:
        fake = FakeMlx(answer("zh", whisper_segment()))
        result = self.run_engine(fake, "zh", model="some/model")
        (audio, kw), = fake.calls
        self.assertEqual(audio, "/tmp/x.audio")
        self.assertEqual(kw["path_or_hf_repo"], "some/model")
        self.assertEqual(kw["language"], "zh")
        self.assertEqual(kw["initial_prompt"], ZH_PROMPT)
        self.assertIs(kw["condition_on_previous_text"], False)
        self.assertIs(kw["word_timestamps"], False)
        self.assertIsNone(kw["verbose"])  # True would print what was said to stdout, which ends in a log
        self.assertGreater(len(kw["temperature"]), 1)  # the fallback ladder
        self.assertEqual((kw["compression_ratio_threshold"], kw["logprob_threshold"], kw["no_speech_threshold"]), (2.4, -1.0, 0.6))
        self.assertEqual(result.language, "zh")

    def test_english_has_no_chinese_prompt(self) -> None:
        fake = FakeMlx(answer("en", whisper_segment(" Hello there.")))
        self.run_engine(fake, "en")
        (_, kw), = fake.calls
        self.assertEqual(kw["language"], "en")
        self.assertNotIn("initial_prompt", kw)

    def test_auto_detecting_something_else_is_one_pass(self) -> None:
        fake = FakeMlx(answer("de", whisper_segment(" Guten Tag.")))
        result = self.run_engine(fake, None)
        self.assertEqual(len(fake.calls), 1)
        self.assertNotIn("language", fake.calls[0][1])  # left to the model
        self.assertNotIn("initial_prompt", fake.calls[0][1])
        self.assertEqual(result.language, "de")

    def test_auto_detecting_chinese_goes_again_with_the_prompt(self) -> None:
        traditional = answer("zh", whisper_segment("今天天氣很好。"))
        simplified = answer("zh", whisper_segment("今天天气很好。"))
        fake = FakeMlx(traditional, simplified)
        result = self.run_engine(fake, None)
        self.assertEqual(len(fake.calls), 2)
        self.assertNotIn("initial_prompt", fake.calls[0][1])
        self.assertEqual(fake.calls[1][1]["language"], "zh")
        self.assertEqual(fake.calls[1][1]["initial_prompt"], ZH_PROMPT)
        self.assertEqual(result.segments[0].text, "今天天气很好。")  # the second pass is what is used

    def test_segments_carry_the_scores(self) -> None:
        fake = FakeMlx(answer("zh", whisper_segment("一", start=1.0, end=2.0, avg_logprob=-0.9, no_speech_prob=0.4, compression_ratio=1.9)))
        s = self.run_engine(fake, "zh").segments[0]
        self.assertEqual((s.text, s.start, s.end, s.avg_logprob, s.no_speech_prob, s.compression_ratio), ("一", 1.0, 2.0, -0.9, 0.4, 1.9))

    def test_a_segment_without_its_scores_is_an_error_not_a_pass(self) -> None:
        bad = whisper_segment()
        del bad["no_speech_prob"]
        with self.assertRaises(KeyError):
            self.run_engine(FakeMlx(answer("zh", bad)), "zh")

    def test_the_asked_language_stands_in_when_the_answer_has_none(self) -> None:
        fake = FakeMlx({"text": "", "segments": []})
        self.assertEqual(self.run_engine(fake, "en").language, "en")

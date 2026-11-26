"""What is kept of what the engine heard.

Whisper, given music, silence or noise, writes sentences anyway: stock outros ("谢谢观看"), subtitle credits,
the same line over and over. The product rule is that when nobody said anything, nothing is shown, and a guessed
sentence is worse than none. Everything here is a pure function of segments and text, so each rule has its own test.

The pipeline (`clean`): drop the bad segments, keep one of a loop, drop a stock outro when it is the last (or only)
speech, join, cap, and decide whether anything credible is left.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Sequence

from .engine import Segment

# Whisper's own silence test is "no_speech_prob over 0.6 AND avg_logprob under -1.0" (both); a high compression ratio
# means the text is a loop or gibberish. The numbers are Whisper's defaults.
NO_SPEECH_PROB_MAX = 0.6
AVG_LOGPROB_MIN = -1.0
COMPRESSION_RATIO_MAX = 2.4
# The same line this many times in a row is a loop: one of them is kept.
REPEAT_RUN = 3
# Less than this is not speech: 5 characters of Chinese (or Japanese), 3 words of anything else.
MIN_CJK_CHARS = 5
MIN_WORDS = 3
CJK_LANGUAGES = frozenset({"zh", "yue", "ja"})


def fold(text: str) -> str:
    """Letters and digits only, case-folded: what two spellings of the same line share."""
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def is_blank(text: str) -> bool:
    """Empty, or nothing but punctuation, symbols and spaces."""
    return fold(text) == ""


_TAG = re.compile(r"\s*[\[(（【].{0,30}[\])）】]\s*")


def is_sound_tag(text: str) -> bool:
    """`[Music]`, `(音乐)`, `[BLANK_AUDIO]`: a label for a sound, not something said."""
    return _TAG.fullmatch(text) is not None


# Stock lines Whisper makes up for silence and music, matched against `fold(text)` (so no spaces or punctuation:
# "Don't forget to subscribe!" is "dontforgettosubscribe"). Each is a whole short line, never part of a long one.
_STOCK = [
    # Chinese
    r"字幕(由|志愿者|组|制作|提供|翻译|校对).{0,40}",
    r"(中文|中英|简体|繁体|双语)字幕.{0,40}",
    r"(谢谢|感谢)(大家|您|你们)?(的)?(观看|收看|收听|关注|支持)(本期)?(视频|节目)?(再见)?",
    r"(请)?(大家)?(不要忘记|别忘了|记得|不吝)?(点赞|订阅|关注|转发|打赏)(订阅|关注|转发|打赏|点赞|支持)*(我的|本|我们的)?(频道|节目|栏目)?",
    r".{0,20}明镜与点点.{0,20}",
    r"(我们)?下(一)?期(视频)?(再见|见)",
    # English
    r"thank(s|you)forwatching(this|the)?(video)?(guys|everyone|folks)?",
    r"thank(s|you)(verymuch|somuch)?(guys|everyone)?",
    r"(please)?(like)?(and)?(dontforgetto)?subscribe(tomychannel|tothechannel|formore)?",
    r"(subtitles?|captions?|transcribed)(by|provided|made).{0,40}",
    r"seeyou(next|in(the)?next)?(time|video|soon|later|again)?",
    r"(good)?bye(bye)?",
    # Japanese
    r"(最後まで)?ご視聴(いただき)?ありがとうござい(ました|ます)",
    r"チャンネル登録.{0,20}",
]
_STOCK_RE = [re.compile(p) for p in _STOCK]


def is_stock_phrase(text: str) -> bool:
    folded = fold(text)
    return folded != "" and any(p.fullmatch(folded) for p in _STOCK_RE)


def drop_reason(seg: Segment) -> Optional[str]:
    """Why this segment is not speech (or None when it may be)."""
    if seg.no_speech_prob > NO_SPEECH_PROB_MAX and seg.avg_logprob < AVG_LOGPROB_MIN:
        return "silence"
    if seg.compression_ratio > COMPRESSION_RATIO_MAX:
        return "gibberish"
    if is_blank(seg.text):
        return "blank"
    if is_sound_tag(seg.text):
        return "tag"
    return None


def collapse_repeats(segments: Sequence[Segment], run: int = REPEAT_RUN) -> List[Segment]:
    """The same line `run` or more times in a row is a loop and is kept once; twice is someone repeating themselves."""
    out: List[Segment] = []
    i = 0
    while i < len(segments):
        key = fold(segments[i].text)
        j = i
        while j + 1 < len(segments) and fold(segments[j + 1].text) == key:
            j += 1
        out.extend(segments[i : i + 1] if j - i + 1 >= run else segments[i : j + 1])
        i = j + 1
    return out


def drop_trailing_stock(segments: Sequence[Segment]) -> List[Segment]:
    """A stock outro is dropped when it is the last speech, or the only speech (then nothing is left)."""
    out = list(segments)
    while out and is_stock_phrase(out[-1].text):
        out.pop()
    return out


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF  # Han
        or 0x3400 <= cp <= 0x4DBF
        or 0xF900 <= cp <= 0xFAFF
        or 0x20000 <= cp <= 0x2FA1F
        or 0x3040 <= cp <= 0x30FF  # kana
    )


def _is_cjk_punctuation(ch: str) -> bool:
    cp = ord(ch)
    return 0x3000 <= cp <= 0x303F or 0xFF00 <= cp <= 0xFFEF


def join_texts(parts: Sequence[str]) -> str:
    """Segments as one text: a space only between two stretches of a spaced script ("Hello." "World"), none next to Chinese."""
    out = ""
    for part in parts:
        part = re.sub(r"\s+", " ", part).strip()
        if not part:
            continue
        if out:
            a, b = out[-1], part[0]
            spaced = not (_is_cjk(a) or _is_cjk_punctuation(a) or _is_cjk(b) or _is_cjk_punctuation(b))
            out += (" " if spaced else "") + part
        else:
            out = part
    return out


def has_speech(text: str, language: str = "") -> bool:
    """At least 5 characters of Chinese or Japanese, or 3 words of anything else. A guess of a word or two is not speech."""
    alnum = [ch for ch in text if ch.isalnum()]
    cjk = sum(1 for ch in alnum if _is_cjk(ch))
    if language in CJK_LANGUAGES or cjk * 2 >= len(alnum):
        return len(alnum) >= MIN_CJK_CHARS
    return sum(1 for word in text.split() if any(ch.isalnum() for ch in word)) >= MIN_WORDS


@dataclass(frozen=True)
class Cleaned:
    text: str  # "" when speech is False
    speech: bool


def clean(segments: Sequence[Segment], language: str, max_chars: int) -> Cleaned:
    kept = [s for s in segments if drop_reason(s) is None]
    kept = drop_trailing_stock(collapse_repeats(kept))
    # The music-note marks Whisper puts round sung words say nothing.
    text = join_texts([s.text.replace("♪", " ").replace("♫", " ") for s in kept])
    if not has_speech(text, language):
        return Cleaned(text="", speech=False)
    return Cleaned(text=text[:max_chars].rstrip(), speech=True)

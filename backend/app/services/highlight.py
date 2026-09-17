"""Highlight picking for poster copy (HIG-50, contract §3 ``POST /api/highlight``).

A provider hands back short phrases copied verbatim from the text; the helpers here turn
them into non-overlapping ``[start, end)`` ranges in UTF-16 code units — the index space
the frontend's text spans use — so an emoji before a phrase does not shift the colouring.
``RuleHighlight`` is the ``LOCALIZE_PROVIDER = fake`` implementation (dates, quantities,
amounts, percentages); the DashScope one lives in ``dashscope_providers``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Protocol


class HighlightProvider(Protocol):
    def pick(self, text: str, max_phrases: int) -> list[str]: ...


# ---------------------------------------------------------------------------
# pure helpers
# ---------------------------------------------------------------------------


def utf16_offset(text: str, index: int) -> int:
    """Code-point index → UTF-16 code-unit offset (astral characters count twice)."""
    return len(text[:index].encode("utf-16-le")) // 2


def phrases_to_ranges(text: str, phrases: list[str], max_n: int) -> list[tuple[str, int, int]]:
    """``(phrase, start, end)`` for the first occurrence of each phrase, UTF-16 offsets.

    Phrases not found in the text, or whose first occurrence overlaps one already accepted,
    are dropped; the rest come back in text order, at most ``max_n`` of them.
    """
    accepted: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for raw in phrases:
        phrase = str(raw or "").strip()
        if not phrase or phrase in seen:
            continue
        seen.add(phrase)
        start = text.find(phrase)
        if start < 0:
            continue
        end = start + len(phrase)
        if any(start < e and s < end for s, e, _ in accepted):
            continue
        accepted.append((start, end, phrase))
    accepted.sort()
    return [(phrase, utf16_offset(text, s), utf16_offset(text, e)) for s, e, phrase in accepted[: max(0, max_n)]]


def parse_phrase_json(raw: str) -> list[str]:
    """The string list out of a model reply: a bare JSON array, fenced, or wrapped in prose.

    Anything unparsable gives ``[]`` rather than an error — the caller then simply has no
    highlights. Objects with a ``text`` key are tolerated (models sometimes return those).
    """
    raw = (raw or "").strip()
    if not raw:
        return []
    candidates = [raw]
    start, end = raw.find("["), raw.rfind("]")
    if start >= 0 and end > start:
        candidates.append(raw[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data, list):
            return _strings(data)
    return []


def _strings(items: list[Any]) -> list[str]:
    out: list[str] = []
    for item in items:
        if isinstance(item, dict):
            item = item.get("text")
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
    return out


def pick_highlights(text: str, max_phrases: int, provider: HighlightProvider) -> list[dict[str, Any]]:
    """Ask the provider, then resolve its phrases into ``{text, start, end}`` dicts (contract §3)."""
    phrases = provider.pick(text, max_phrases)
    return [{"text": phrase, "start": s, "end": e} for phrase, s, e in phrases_to_ranges(text, phrases, max_phrases)]


# ---------------------------------------------------------------------------
# rule-based provider (fake / demo)
# ---------------------------------------------------------------------------

_NUM = r"(?:[0-9０-９][0-9０-９,.]*|[零一二两三四五六七八九十百千万亿]+|半)"
_DATE = r"(?:\d{2,4}年)?(?:\d{1,2}月)?\d{1,2}[日号]|\d{2,4}年\d{1,2}月|\d{2,4}年|\d{1,2}月"
_WEEKDAY = r"(?:周|星期|礼拜)[一二三四五六日天]"
# Count units that read as a fact on their own ("3天", "100元"); 倍 also takes the noun it
# multiplies ("三倍工资"). 个 only after 第 ("第一个") — "一个" is too common to be a highlight.
_UNIT = r"(?:公斤|千克|公里|小时|分钟|天|元|块|年|周|次|件|人|份|场|台|位|名|种|项|折|成|克|米|秒|万|亿)"
_PATTERNS = [
    re.compile(rf"(?:{_DATE})(?:\s*(?:至|到|~|～|-|—|－)\s*(?:{_DATE}))?"),
    re.compile(_WEEKDAY),
    re.compile(r"[¥￥$€£]\s?\d[\d,]*(?:\.\d+)?(?:万|亿|k|K)?"),
    re.compile(r"\d[\d,]*(?:\.\d+)?\s?[%％]"),
    re.compile(rf"{_NUM}倍(?:[一-鿿]{{2}})?"),
    re.compile(rf"第{_NUM}[个名位天次]"),
    re.compile(rf"{_NUM}{_UNIT}"),
]


class RuleHighlight:
    """Regex picks for tests and demos: dates, weekdays, amounts, percentages, counts."""

    def pick(self, text: str, max_phrases: int) -> list[str]:
        found: list[tuple[int, int, str]] = []
        for pattern in _PATTERNS:
            for m in pattern.finditer(text):
                if m.end() > m.start():
                    found.append((m.start(), m.end(), m.group(0)))
        # Earliest first, longest on a tie: a date range beats the month inside it.
        found.sort(key=lambda f: (f[0], -f[1]))
        chosen: list[tuple[int, int, str]] = []
        for start, end, phrase in found:
            if any(start < e and s < end for s, e, _ in chosen):
                continue
            chosen.append((start, end, phrase))
        out: list[str] = []
        for _s, _e, phrase in chosen:
            if phrase not in out:
                out.append(phrase)
        return out[: max(0, max_phrases)]

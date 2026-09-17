"""Highlight picking (HIG-50): UTF-16 ranges, model-reply parsing, the rule-based fallback provider."""

from __future__ import annotations

from app.services import highlight
from app.services.highlight import RuleHighlight, parse_phrase_json, phrases_to_ranges, pick_highlights

SAMPLE = (
    "已经出来了 有三个好消息 和两个坏消息 尤其是最后一个消息 非常的重要 第一个好消息 今年中秋节放假时间为 "
    "9月25日至9月27日 连休三天不调休 第二个好消息 根据规定 中秋节当天加班的 用人单位需要发放三倍工资"
)


def test_phrases_to_ranges_uses_utf16_offsets_like_js_strings():
    text = "🎉中秋节放假3天"
    assert phrases_to_ranges(text, ["3天"], 8) == [("3天", 7, 9)]  # the emoji is two UTF-16 units
    assert len("🎉中秋节放假") == 6 and len(text[:6].encode("utf-16-le")) // 2 == 7


def test_phrases_to_ranges_skips_missing_and_overlapping_and_sorts_and_caps():
    text = "9月25日至9月27日连休三天，三倍工资"
    ranges = phrases_to_ranges(text, ["三倍工资", "9月27日", "9月25日至9月27日", "不存在", "三天", "", "三天"], 8)
    # "9月27日" is inside the range accepted first? No: it was accepted first, so the longer one is skipped.
    assert ranges == [("9月27日", 6, 11), ("三天", 13, 15), ("三倍工资", 16, 20)]
    assert phrases_to_ranges(text, ["9月25日至9月27日", "9月27日", "三天"], 8) == [("9月25日至9月27日", 0, 11), ("三天", 13, 15)]
    assert phrases_to_ranges(text, ["三倍工资", "三天", "9月25日"], 2) == [("9月25日", 0, 5), ("三天", 13, 15)]
    assert phrases_to_ranges(text, [], 8) == []


def test_parse_phrase_json_accepts_bare_fenced_and_prose_wrapped_arrays():
    assert parse_phrase_json('["9月25日", "三倍工资"]') == ["9月25日", "三倍工资"]
    assert parse_phrase_json('```json\n["9月25日", "三倍工资"]\n```') == ["9月25日", "三倍工资"]
    assert parse_phrase_json('挑出的重点词如下：\n["9月25日","三倍工资"]\n希望有帮助。') == ["9月25日", "三倍工资"]
    assert parse_phrase_json('[{"text": "三天"}, 12, "", " 三倍工资 "]') == ["三天", "三倍工资"]
    assert parse_phrase_json("完全不是 JSON") == []
    assert parse_phrase_json('{"phrases": "x"}') == []
    assert parse_phrase_json("") == []
    assert parse_phrase_json("[1, 2") == []


def test_rule_highlight_picks_dates_and_quantities_from_the_sample_copy():
    picked = RuleHighlight().pick(SAMPLE, 8)
    assert "9月25日至9月27日" in picked and "三倍工资" in picked
    assert picked.index("9月25日至9月27日") < picked.index("三倍工资")  # text order
    assert len(picked) <= 8 and len(set(picked)) == len(picked)
    assert RuleHighlight().pick(SAMPLE, 1) == picked[:1]


def test_rule_highlight_covers_years_weekdays_amounts_and_percentages():
    picked = RuleHighlight().pick("2026年周一起 ¥199 立减50% 满100元送3天 第一个下单的 三倍工资", 20)
    assert picked == ["2026年", "周一", "¥199", "50%", "100元", "3天", "第一个", "三倍工资"]
    assert RuleHighlight().pick("没有任何数字的一段话", 8) == []


def test_pick_highlights_returns_contract_dicts():
    class Fixed:
        def pick(self, text: str, max_phrases: int) -> list[str]:
            return ["三倍工资", "9月25日至9月27日", "不在文中"]

    assert pick_highlights(SAMPLE, 8, Fixed()) == [
        {"text": "9月25日至9月27日", "start": SAMPLE.index("9月25日至9月27日"), "end": SAMPLE.index("9月25日至9月27日") + 11},
        {"text": "三倍工资", "start": SAMPLE.index("三倍工资"), "end": SAMPLE.index("三倍工资") + 4},
    ]
    assert highlight.utf16_offset("a😀b", 3) == 4

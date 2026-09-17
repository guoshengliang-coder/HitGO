"""Regenerate the text animation golden cases shared with the frontend (HIG-40 / 44 / 45).

Run from ``backend/``:  ``uv run python scripts/gen_animation_cases.py``

- ``textAnimationCases.json``: the cases already in the file are kept (their expectations are
  recomputed, so a curve change shows up in the diff) and the HIG-44 cases below are added.
- ``textRevealCases.json``: rewritten from the HIG-45 cases below.

Both are read by ``backend/tests`` and ``frontend/src/lib/*.test.ts``; neither side computes
the expectations it is checked against.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.schemas import GlyphLayout, TextAnimation, TextReveal  # noqa: E402
from app.services.animation import sample  # noqa: E402
from app.services.reveal import sample_alpha  # noqa: E402

FIXTURES = ROOT.parent / "frontend" / "src" / "lib" / "fixtures"
ANIM_PATH = FIXTURES / "textAnimationCases.json"
REVEAL_PATH = FIXTURES / "textRevealCases.json"

HIG44_PREFIX = "hig44 "


def r(v: float) -> float:
    return round(v, 6)


def anim_expect(animation: dict, window: float, u: float) -> dict:
    f = sample(TextAnimation.model_validate(animation), u, window)
    return {"opacity": r(f.opacity), "dx": r(f.dx), "dy": r(f.dy), "scale": r(f.scale)}


def hig44_cases() -> list[dict]:
    out = []

    def add(name: str, animation: dict, window: float, us: list[float]) -> None:
        for u in us:
            out.append({"name": HIG44_PREFIX + name, "animation": animation, "window": window, "u": u, "expect": anim_expect(animation, window, u)})

    enter_us = [0, 0.1, 0.25, 0.4, 0.5, 0.7]
    exit_us = [3.3, 3.5, 3.65, 3.8, 4]
    for easing in ("linear", "ease_in", "ease_out", "ease_in_out", "back", "elastic", "bounce"):
        add(f"in slide_up {easing}", {"in": {"preset": "slide_up", "duration": 0.5, "easing": easing, "distance": 0.12}}, 4, enter_us)
        add(f"out slide_left {easing}", {"out": {"preset": "slide_left", "duration": 0.5, "easing": easing, "distance": 0.1}}, 4, exit_us)
    add("in pop scale 0.2 overshoot 3", {"in": {"preset": "pop", "duration": 0.5, "scale": 0.2, "overshoot": 3}}, 4, enter_us)
    add("in pop grows down from 2", {"in": {"preset": "pop", "duration": 0.5, "scale": 2, "easing": "ease_out"}}, 4, enter_us)
    add("out pop grows to 1.8", {"out": {"preset": "pop", "duration": 0.5, "scale": 1.8}}, 4, exit_us)
    add("in slide_right without fade", {"in": {"preset": "slide_right", "duration": 0.5, "fade": False}}, 4, enter_us)
    add("out slide_down without fade", {"out": {"preset": "slide_down", "duration": 0.5, "fade": False, "distance": 0.2}}, 4, exit_us)
    add("in fade with delay, loop after it", {"in": {"preset": "fade", "duration": 0.5, "delay": 0.8}, "loop": {"preset": "float", "period": 1}}, 4, [0, 0.5, 0.8, 1.0, 1.3, 1.55, 2.2])
    add("delay squeezes enter and exit", {"in": {"preset": "fade", "duration": 2, "delay": 1.5}, "out": {"preset": "fade", "duration": 2}}, 3, [1, 1.5, 2.5, 2.9, 3])
    add("loop breathe amount 3", {"loop": {"preset": "breathe", "period": 1, "amount": 3}}, 4, [0, 0.25, 0.5, 0.9])
    add("loop float amount 0.5", {"loop": {"preset": "float", "period": 1, "amount": 0.5}}, 4, [0, 0.25, 0.75])
    add("loop blink amount 2 floors at 0", {"loop": {"preset": "blink", "period": 1, "amount": 2}}, 4, [0, 0.25, 0.5, 0.75])
    return out


def two_line_layout() -> dict:
    # "ABCD" over "EFG"; the second line is right-to-left to cover rtl wipes and cursors.
    return {
        "lines": [
            {"top": 0.05, "bottom": 0.45, "units": [[0.1, 0.25], [0.25, 0.4], [0.42, 0.6], [0.6, 0.75]]},
            {"top": 0.55, "bottom": 0.95, "rtl": True, "units": [[0.55, 0.7], [0.35, 0.55], [0.2, 0.35]]},
        ]
    }


def reveal_cases() -> list[dict]:
    layout = two_line_layout()
    points = [(0.05, 0.2), (0.18, 0.25), (0.33, 0.3), (0.51, 0.2), (0.7, 0.3), (0.95, 0.1), (0.6, 0.7), (0.45, 0.8), (0.27, 0.9), (0.05, 0.75)]
    out = []
    for preset in ("typewriter", "fade_chars", "wipe"):
        for easing in ("linear", "ease_out", "ease_in_out"):
            reveal = {"preset": preset, "duration": 1.4, "easing": easing}
            for delay, window, us in ((0.0, 4, [0, 0.1, 0.3, 0.55, 0.8, 1.05, 1.3, 1.4, 2]), (0.5, 1.5, [0.4, 0.6, 1.0, 1.5])):
                for u in us:
                    expect = [r(sample_alpha(GlyphLayout.model_validate(layout), TextReveal.model_validate(reveal), window, delay, u, x, y)) for x, y in points]
                    out.append({"name": f"{preset} {easing} delay {delay}", "layout": layout, "reveal": reveal, "window": window, "delay": delay, "u": u, "points": points, "expect": expect})
    single = {"lines": [{"top": 0, "bottom": 1, "units": [[0.2, 0.8]]}]}
    for preset in ("typewriter", "fade_chars", "wipe"):
        reveal = {"preset": preset, "duration": 1}
        pts = [(0.1, 0.5), (0.5, 0.5), (0.9, 0.5)]
        for u in (0, 0.2, 0.5, 1):
            expect = [r(sample_alpha(GlyphLayout.model_validate(single), TextReveal.model_validate(reveal), 3, 0, u, x, y)) for x, y in pts]
            out.append({"name": f"{preset} single unit", "layout": single, "reveal": reveal, "window": 3, "delay": 0, "u": u, "points": pts, "expect": expect})
    return out


def main() -> None:
    data = json.loads(ANIM_PATH.read_text())
    kept = [c for c in data["cases"] if not c["name"].startswith(HIG44_PREFIX)]
    for c in kept:
        c["expect"] = anim_expect(c["animation"], c["window"], c["u"])
    data["_note"] = (
        "HIG-40 / HIG-44 文字动画采样 golden：由 backend/scripts/gen_animation_cases.py 从 services/animation.py 生成，"
        "前端 lib/textAnimation.ts 与后端各自对照。window = 出现时段长度（秒），u = 时段内的本地时间；dx / dy 相对画布高。"
    )
    data["cases"] = kept + hig44_cases()
    ANIM_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")

    REVEAL_PATH.write_text(
        json.dumps(
            {
                "_note": (
                    "HIG-45 逐字显现遮罩 golden：由 backend/scripts/gen_animation_cases.py 从 services/reveal.py 生成，"
                    "前端 lib/textReveal.ts 与后端各自对照。layout 为 glyph_layout，points 为 PNG 内的 [x, y] 比例，"
                    "expect 为对应点的透明度倍数；window = 出现时段长度，delay = 入场延迟，u = 时段内的本地时间。"
                ),
                "cases": reveal_cases(),
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n"
    )
    print(f"{len(data['cases'])} animation cases, {len(reveal_cases())} reveal cases")


if __name__ == "__main__":
    main()

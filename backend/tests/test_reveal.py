"""Glyph-by-glyph reveal (HIG-45): shared golden cases with the frontend, the filter graph it
builds, and the real ffmpeg against the same numbers."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas import EditSpec, GlyphLayout, TextReveal
from app.services.filtergraph import ImageSource, build_render_command
from app.services.reveal import cursor, inverse_ease, mask_expression, sample_alpha, timing
from tests.test_animation import TEXT_PNG, graph, plan_for, text_only_spec

CASES_PATH = Path(__file__).resolve().parents[2] / "frontend/src/lib/fixtures/textRevealCases.json"
CASES = json.loads(CASES_PATH.read_text())["cases"]

LAYOUT = {"lines": [{"top": 0.1, "bottom": 0.9, "units": [[0.05, 0.3], [0.35, 0.6], [0.65, 0.95]]}]}


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['name']}@{c['u']}")
def test_golden_cases(case):
    layout = GlyphLayout.model_validate(case["layout"])
    reveal = TextReveal.model_validate(case["reveal"])
    for (x, y), want in zip(case["points"], case["expect"]):
        got = sample_alpha(layout, reveal, case["window"], case["delay"], case["u"], x, y)
        assert got == pytest.approx(want, abs=1e-5), (x, y)


def test_golden_cases_cover_every_preset():
    assert {c["reveal"]["preset"] for c in CASES} == {"typewriter", "fade_chars", "wipe"}


def test_inverse_ease_undoes_the_curves():
    from app.services.animation import ease, evaluate

    for name in ("linear", "ease_in", "ease_out", "ease_in_out"):
        for y in (0, 0.1, 0.37, 0.5, 0.8, 1):
            p = inverse_ease(name, y)
            assert evaluate(ease(name, "P", settle=True), P=p) == pytest.approx(y, abs=1e-9), (name, y)


def test_timing_spreads_units_over_the_duration():
    t = timing(TextReveal(preset="typewriter", duration=1), 3, 4, 0.5)
    assert t.times == pytest.approx([0.5, 1.0, 1.5]) and t.end == 1.5
    t = timing(TextReveal(preset="fade_chars", duration=1), 3, 4, 0)
    assert t.times == pytest.approx([0, 0.35, 0.7])  # the last fade (0.3 s) ends with the reveal
    t = timing(TextReveal(preset="wipe", duration=1.5), 3, 4, 0)
    assert t.times == pytest.approx([0, 0.5, 1, 1.5])
    t = timing(TextReveal(preset="typewriter", duration=5), 2, 2, 0.5)  # cut to the window
    assert t.duration == 1.5
    assert timing(TextReveal(preset="wipe"), 3, 2, 2) is None


def test_mask_is_a_binary_search_that_ends_in_one():
    layout = GlyphLayout.model_validate({"lines": [{"top": 0, "bottom": 1, "units": [[i / 40, (i + 1) / 40] for i in range(40)]}]})
    expr = mask_expression(layout, TextReveal(preset="typewriter", duration=2), 5, 0)
    assert expr.startswith("if(gte(U,2),1,")
    # 40 leaves in a balanced tree: never more than ~6 comparisons deep
    depth = max(expr[:i].count("if(") - expr[:i].count("),") for i in range(len(expr)))
    assert depth < 12
    assert sample_alpha(layout, TextReveal(preset="typewriter", duration=2), 5, 0, 1.03, 0.51, 0.5) == 1  # unit 20 appears at 2 · 20/39 s
    assert sample_alpha(layout, TextReveal(preset="typewriter", duration=2), 5, 0, 1.02, 0.51, 0.5) == 0


def test_wipe_moves_the_other_way_on_rtl_lines():
    rtl = GlyphLayout.model_validate({"lines": [{"top": 0, "bottom": 1, "rtl": True, "units": [[0.5, 0.9], [0.1, 0.5]]}]})
    reveal = TextReveal(preset="wipe", duration=2)
    assert sample_alpha(rtl, reveal, 3, 0, 0.5, 0.85, 0.5) == 1  # halfway through the first unit, from the right
    assert sample_alpha(rtl, reveal, 3, 0, 0.5, 0.6, 0.5) == 0
    assert sample_alpha(rtl, reveal, 3, 0, 0.5, 0.4, 0.5) == 0  # the second unit waits


def test_cursor_follows_the_newest_unit_and_blinks_after():
    layout = GlyphLayout.model_validate(LAYOUT)
    c = cursor(layout, TextReveal(preset="typewriter", duration=1.5, cursor=True), 4, 0, 400, 100)
    assert (c.width, c.height) == (5, 64)
    from app.services.animation import evaluate

    xs = [evaluate(c.x, U=u) for u in (0.2, 0.9, 1.6)]
    assert xs == [123, 243, 383]  # after unit 0, unit 1, and unit 2 (clamped into the frame)
    assert evaluate(c.y, U=0.2) == 18
    assert evaluate(c.enable, U=1.0) and evaluate(c.enable, U=1.7) and not evaluate(c.enable, U=2.1)
    assert cursor(layout, TextReveal(preset="typewriter", cursor=False), 4, 0, 400, 100) is None
    assert cursor(layout, TextReveal(preset="wipe", cursor=True), 4, 0, 400, 100) is None


def test_schema_rules():
    EditSpec.model_validate(text_only_spec({"reveal": {"preset": "wipe"}}, glyph_layout=LAYOUT))
    bad_layouts = [
        {"lines": []},
        {"lines": [{"top": 0.5, "bottom": 0.4, "units": [[0, 1]]}]},
        {"lines": [{"top": 0, "bottom": 1, "units": [[0.6, 0.4]]}]},
        {"lines": [{"top": 0, "bottom": 1, "units": []}]},
        {"lines": [{"top": 0.5, "bottom": 1, "units": [[0, 1]]}, {"top": 0, "bottom": 0.4, "units": [[0, 1]]}]},
        {"lines": [{"top": 0, "bottom": 1, "units": [[0, 0.001]] * 1001}]},
    ]
    for layout in bad_layouts:
        with pytest.raises(ValidationError):
            EditSpec.model_validate(text_only_spec({"reveal": {"preset": "wipe"}}, glyph_layout=layout))
    for reveal in ({"preset": "scatter"}, {"preset": "wipe", "duration": 31}, {"preset": "wipe", "easing": "bounce"}):
        with pytest.raises(ValidationError):
            EditSpec.model_validate(text_only_spec({"reveal": reveal}, glyph_layout=LAYOUT))
    with pytest.raises(ValidationError, match="/media/"):
        EditSpec.model_validate(text_only_spec({"reveal": {"preset": "wipe"}}, glyph_layout=LAYOUT, background_image="https://x/y.png"))


# --- filtergraph -----------------------------------------------------------------------

BG_PNG = ImageSource("/data/uploads/u_bg000001.png", 540, 130)


def plan_with_background(spec_dict):
    spec = EditSpec.model_validate(spec_dict)
    urls = {"/media/uploads/u_text00001.png": TEXT_PNG, "/media/uploads/u_bg000001.png": BG_PNG}
    return build_render_command(
        spec, {"duration": 24.6, "has_audio": True, "width": 1080, "height": 1920, "fps": 25}, {}, spec.outputs[0],
        source_path="/data/src.mp4", output_path="/data/tmp/j.mp4", resolve_image_url=lambda url: urls.get(url, TEXT_PNG),
    )  # fmt: skip


def test_reveal_masks_the_png_plane_before_anything_moves_it():
    spec = text_only_spec({"reveal": {"preset": "typewriter", "duration": 1}, "in": {"preset": "pop"}}, glyph_layout=LAYOUT, t=[2, 6], rotate=10)
    plan = plan_for(spec)
    g = graph(plan)
    assert "-loop" in plan.argv
    i = g.index("scale=540:130,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*if(gte((T-2),1),1,")
    assert i < g.index(",pad=") < g.index("perspective=") < g.index("rotate=")


def test_reveal_without_layout_is_skipped_with_a_warning():
    plan = plan_for(text_only_spec({"reveal": {"preset": "typewriter"}}))
    assert "geq" not in graph(plan) and "-loop" not in plan.argv
    assert any("glyph_layout" in w for w in plan.warnings)


def test_background_block_and_cursor_are_laid_under_and_over_the_masked_text():
    spec = text_only_spec(
        {"reveal": {"preset": "typewriter", "duration": 1, "cursor": True}},
        glyph_layout=LAYOUT, background_image="/media/uploads/u_bg000001.png", t=[1, 4],
        style={"color": "#FFCC00"},
    )  # fmt: skip
    plan = plan_with_background(spec)
    argv, g = plan.argv, graph(plan)
    assert argv.count("-loop") == 2 and BG_PNG.path in argv
    assert "[rv1];[2:v]format=rgba,scale=540:130[rb1];[rb1][rv1]overlay=0:0:format=auto,format=rgba[rt1]" in g
    assert "color=c=0xFFCC00:s=6x83:r=25,format=rgba[rc1];[rt1][rc1]overlay=x='" in g
    assert ":shortest=1:format=auto,format=rgba[l1]" in g and "(t-1)" in g


def test_variant_background_wins_for_its_output():
    spec = text_only_spec(
        {"reveal": {"preset": "wipe"}}, glyph_layout=LAYOUT, background_image="/media/uploads/u_text00001.png",
        variant_images={"9x16": {"url": "/media/uploads/u_text00001.png", "size": [540, 130], "background_url": "/media/uploads/u_bg000001.png"}},
    )  # fmt: skip
    assert BG_PNG.path in plan_with_background(spec).argv


# --- real ffmpeg -------------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_reveals_units_on_time_over_a_full_background(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:size=540x960:rate=25:duration=3",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    # "text": red over the whole PNG; background: blue; both 540×130 → 540 px wide at width 0.5
    png = tmp_path / "text.png"
    bg = tmp_path / "bg.png"
    for path, color in ((png, "red"), (bg, "blue")):
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c={color}:size=540x130,format=rgba", "-frames:v", "1", str(path)],
            check=True, capture_output=True,
        )  # fmt: skip
    out = tmp_path / "out.mp4"
    animation = {"reveal": {"preset": "typewriter", "duration": 1.2, "cursor": True}}
    spec = text_only_spec(
        animation, glyph_layout=LAYOUT, background_image="/media/uploads/bg.png", t=[0.4, 3],
        anchor="center", margin=[0, 0], width=0.5, style={"color": "#00FF00"},
    )  # fmt: skip
    spec["outputs"] = [{"variant_key": "9x16", "aspect": "9:16", "fill": "color", "color": "#000000", "quality": "high"}]
    spec = EditSpec.model_validate(spec)
    urls = {"/media/uploads/bg.png": ImageSource(str(bg), 540, 130)}
    plan = build_render_command(
        spec, {"duration": 3.0, "has_audio": False, "fps": 25}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out), resolve_image_url=lambda url: urls.get(url, ImageSource(str(png), 540, 130)),
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    layout = GlyphLayout.model_validate(LAYOUT)
    reveal = TextReveal.model_validate(animation["reveal"])
    left, top = 540 - 270, 960 - 65
    samples = [(0.2, 0.5), (0.47, 0.5), (0.8, 0.5)]  # inside unit 0, 1, 2
    for n in (15, 22, 30, 40, 60):  # t = 0.6 … 2.4
        u = n / 25 - 0.4
        row = _row(out, n, top + 65)
        for x, y in samples:
            px = row[left + round(x * 540)]
            want_red = sample_alpha(layout, reveal, 2.6, 0, u, x, y) > 0.5
            assert (px[0] > 150 and px[2] < 100) == want_red, (n, x, px)
            assert (px[2] > 150 and px[0] < 100) == (not want_red), (n, x, px)  # the background shows through
    # the green cursor right after unit 0 while unit 1 is still hidden (u = 0.2)
    row = _row(out, 15, top + 65)
    assert any(p[1] > 150 and p[0] < 100 for p in row[left + 160 : left + 185])


def _row(path, n, y):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{n})", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True, timeout=60,
    ).stdout  # fmt: skip
    line = raw[y * 1080 * 3 : (y + 1) * 1080 * 3]
    return [tuple(line[i * 3 : i * 3 + 3]) for i in range(1080)]

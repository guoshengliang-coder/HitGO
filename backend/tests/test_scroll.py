"""Scrolling text (HIG-50): golden cases shared with the frontend, the ffmpeg crop chain,
the looped source behind trim.duration, and both checked against the real ffmpeg."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.schemas import EditSpec, TextScroll
from app.services.filtergraph import ImageSource, build_render_command
from app.services.scroll import sample_y, scroll_path, y_expression
from tests.conftest import valid_spec
from tests.test_animation import _bbox_full

CASES_PATH = Path(__file__).resolve().parents[2] / "frontend/src/lib/fixtures/scrollCases.json"
CASES = json.loads(CASES_PATH.read_text())["cases"]

TEXT_PNG = ImageSource("/data/uploads/u_text00001.png", 950, 2400)  # a tall baked copy
META = {"duration": 24.6, "has_audio": True, "width": 1080, "height": 1920, "fps": 25}
BOX = {"x": 0.06, "y": 0.14, "w": 0.88, "h": 0.6}


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['name']}@{c['u']}")
def test_golden_cases(case):
    path = scroll_path(TextScroll.model_validate(case["scroll"]), case["png_h"])
    want = case["expect"]
    assert path.y0 == pytest.approx(want["y0"], abs=1e-6)
    assert path.y1 == pytest.approx(want["y1"], abs=1e-6)
    assert path.duration == pytest.approx(want["duration"], abs=1e-6)
    assert sample_y(path, case["u"]) == pytest.approx(want["y"], abs=1e-6)


def test_golden_cases_cover_every_start_end_combination():
    seen = {(c["scroll"].get("start", "enter"), c["scroll"].get("end", "exit")) for c in CASES}
    assert seen == {("enter", "exit"), ("visible", "exit"), ("enter", "stay"), ("visible", "stay")}


def test_holds_only_count_when_the_copy_is_on_screen():
    s = TextScroll.model_validate({"speed": 0.1, "box": BOX, "hold_start": 3, "hold_end": 3})
    p = scroll_path(s, 0.5)
    assert p.hold_start == 0 and p.hold_end == 0 and p.duration == pytest.approx(11.0)
    s = TextScroll.model_validate({"speed": 0.1, "box": BOX, "start": "visible", "end": "stay", "hold_start": 3, "hold_end": 3})
    p = scroll_path(s, 0.5)
    assert p.hold_start == 3 and p.hold_end == 3 and p.travel == pytest.approx(0)  # shorter than the box: no travel


def test_y_expression_in_pixels_with_the_layer_start_and_hold():
    p = scroll_path(TextScroll.model_validate({"speed": 0.1, "box": BOX, "start": "visible", "hold_start": 1.5}), 1.2)
    assert y_expression(p, 1920, "t", 0.0) == "clip(1152+(t-1.5)*192,1152,3456)"
    assert y_expression(p, 1920, "t", 2.0) == "clip(1152+((t-2)-1.5)*192,1152,3456)"
    p = scroll_path(TextScroll.model_validate({"speed": 0.1, "box": BOX}), 1.2)
    assert y_expression(p, 1920) == "clip(0+t*192,0,3456)"


def test_clause_cues_drive_piecewise_scroll_in_preview_and_ffmpeg():
    scroll = TextScroll.model_validate({
        "speed": 0.1, "box": BOX,
        "cues": [{"at": 0, "progress": 0}, {"at": 1, "progress": 0.25}, {"at": 3, "progress": 1}],
    })
    path = scroll_path(scroll, 1.2)
    assert path.duration == 3
    assert sample_y(path, 0.5) == pytest.approx(path.y0 + (path.y1 - path.y0) * 0.125)
    expression = y_expression(path, 1920)
    assert "if(lte(t,1)" in expression
    assert "864+(t-1)*1296" in expression


# --- filtergraph -----------------------------------------------------------------


def scroll_spec(scroll=None, **layer):
    spec = valid_spec(trim={"remove": []})
    # image_size wins over the resolved file: give the layer the tall copy's size.
    text = dict(spec["layers"][1], anchor="top-center", margin=[0, 0], width=0.88, image_size=[950, 2400])
    text.update(layer)
    text["scroll"] = {"speed": 0.1, "box": BOX, **(scroll or {})}
    spec["layers"] = [text]
    return spec


def plan_for(spec_dict, meta=META, png=TEXT_PNG):
    spec = EditSpec.model_validate(spec_dict)
    return build_render_command(
        spec, meta, {}, spec.outputs[0], source_path="/data/src.mp4", output_path="/data/tmp/j.mp4",
        resolve_image_url=lambda url: png,
    )  # fmt: skip


def graph(plan) -> str:
    return plan.argv[plan.argv.index("-filter_complex") + 1]


def test_scroll_layer_is_padded_cropped_and_overlaid_in_the_box():
    plan = plan_for(scroll_spec())
    g = graph(plan)
    # PNG: width 0.88 × 1080 = 950 px, height scales with it; box 0.6 × 1920 = 1152 px high.
    assert "[1:v]format=rgba,scale=950:2400,pad=950:4704:0:1152:color=0x00000000,crop=950:1152:0:'clip(0+t*192,0,3552)'[l1]" in g
    # Centred in the box (x = 65 + (950 − 950) / 2), top at the box top (0.14 × 1920 = 269).
    assert "[c0][l1]overlay=65:269:eof_action=repeat[c1]" in g
    assert "enable" not in g and "rotate" not in g
    i = plan.argv.index("-i", plan.argv.index("-i") + 1)
    assert plan.argv[i - 6 : i] == ["-loop", "1", "-framerate", "25", "-t", "24.6"]


def test_scroll_layer_wider_than_the_box_is_shrunk_and_a_window_gets_enable():
    plan = plan_for(scroll_spec({"box": {"x": 0.2, "y": 0.1, "w": 0.5, "h": 0.5}}, width=1.0, t=[1, 6], opacity=0.5))
    g = graph(plan)
    # box 540 px wide → the 1080 px copy is scaled to 540 (height keeps the PNG ratio).
    assert "scale=540:1364,colorchannelmixer=aa=0.5,pad=540:3284:0:960" in g
    assert "crop=540:960:0:'clip(0+(t-1)*192,0,2324)'" in g
    assert "overlay=216:192:eof_action=repeat:enable='between(t,1,6)'" in g


def test_scroll_layer_ignores_rotate_and_animation_is_refused_by_the_schema():
    plan = plan_for(scroll_spec(rotate=45))
    assert "rotate" not in graph(plan)


# --- trim.duration ------------------------------------------------------------------


def test_short_target_only_adds_the_output_t():
    spec = valid_spec(trim={"remove": [], "duration": 10}, layers=[])
    plan = plan_for(spec)
    assert plan.expected_duration == 10
    assert "trim=" not in graph(plan) and "-stream_loop" not in plan.argv
    assert plan.argv[plan.argv.index("-t") + 1] == "10"


def test_long_target_loops_the_source_through_shifted_trim_windows():
    spec = valid_spec(trim={"remove": [[20, 24.6]], "duration": 45}, layers=[])
    plan = plan_for(spec)
    g = graph(plan)
    assert plan.expected_duration == 45
    assert plan.argv[:5] == ["ffmpeg", "-hide_banner", "-y", "-nostats", "-stream_loop"]
    assert plan.argv[5:8] == ["-1", "-i", "/data/src.mp4"]
    # 20 s kept per pass → 3 passes for 45 s, each shifted by one source length (24.6 s).
    assert "[0:v]trim=start=0:end=20,setpts=PTS-STARTPTS[v0]" in g
    assert "[0:v]trim=start=24.6:end=44.6,setpts=PTS-STARTPTS[v1]" in g
    assert "[0:v]trim=start=49.2:end=69.2,setpts=PTS-STARTPTS[v2]" in g
    assert "[0:a]atrim=start=49.2:end=69.2,asetpts=PTS-STARTPTS[a2]" in g
    assert "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vt][at]" in g
    assert plan.argv[plan.argv.index("-t") + 1] == "45"


def test_long_target_without_trim_still_loops():
    spec = valid_spec(trim={"remove": [], "duration": 30}, layers=[])
    plan = plan_for(spec, meta={**META, "has_audio": False})
    g = graph(plan)
    assert "-stream_loop" in plan.argv
    assert "[0:v]trim=start=0:end=24.6,setpts=PTS-STARTPTS[v0]" in g
    assert "[0:v]trim=start=24.6:end=49.2,setpts=PTS-STARTPTS[v1]" in g
    assert "[v0][v1]concat=n=2:v=1:a=0[vt]" in g
    assert plan.expected_duration == 30


def test_long_target_layers_and_tracks_span_the_whole_output():
    spec = valid_spec(trim={"remove": [], "duration": 30})
    spec["layers"][1]["t"] = [0, 28]  # the text layer (the sticker asset is not resolved here)
    plan = plan_for(spec)
    assert "enable='between(t,0,28)'" in graph(plan)
    # A source-aligned track follows the source once, not its loops.
    spec["audio"] = {"tracks": [{"id": "k1", "asset_id": "a_voice", "role": "voice", "align": "source", "t": "all"}]}
    from app.services.filtergraph import AudioSource

    s = EditSpec.model_validate(spec)
    plan = build_render_command(
        s, META, {}, s.outputs[0], source_path="/data/src.mp4", output_path="/data/tmp/j.mp4",
        resolve_image_url=lambda url: TEXT_PNG, audio_assets={"a_voice": AudioSource("/data/assets/a_voice.m4a", 24.6, "v.m4a")},
    )  # fmt: skip
    g = graph(plan)
    assert "[2:a]atrim=start=0:end=24.6,asetpts=PTS-STARTPTS[tk1s0]" in g
    assert "[tk1s1]" not in g


def test_no_target_keeps_the_old_argv():
    a = plan_for(valid_spec(layers=[]))
    b = plan_for(valid_spec(trim={"remove": [[3.2, 5.8], [17.0, 18.4]], "duration": None}, layers=[]))
    assert a.argv == b.argv


# --- real ffmpeg -------------------------------------------------------------------


def _make_source(path, seconds, size="540x960", rate=25):
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate={rate}:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)],
        check=True, capture_output=True,
    )  # fmt: skip


def _probe_duration(path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout  # fmt: skip
    return float(out.strip())


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_loops_a_short_source_to_the_target_length(tmp_path):
    src = tmp_path / "src.mp4"
    _make_source(src, 2)
    out = tmp_path / "out.mp4"
    spec = EditSpec.model_validate(valid_spec(trim={"remove": [[1.5, 2]], "duration": 5}, layers=[]))
    plan = build_render_command(
        spec, {"duration": 2.0, "has_audio": True, "fps": 25}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out),
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)
    assert _probe_duration(out) == pytest.approx(5.0, abs=0.15)
    # The looped passes carry picture: frame 100 (t = 4 s, third pass) is not black.
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(out), "-vf", "select=eq(n\\,100)", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True, capture_output=True, timeout=60,
    ).stdout  # fmt: skip
    assert max(raw) > 100


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_scroll_stays_inside_the_box_and_moves_up(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:size=540x960:rate=25:duration=4",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    png = tmp_path / "copy.png"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:size=400x1600,format=rgba", "-frames:v", "1", str(png)],
        check=True, capture_output=True,
    )  # fmt: skip
    out = tmp_path / "out.mp4"
    box = {"x": 0.1, "y": 0.2, "w": 0.8, "h": 0.5}  # px: x 108, y 384, w 864, h 960
    spec = scroll_spec({"speed": 0.5, "box": box}, width=0.5, image_size=[400, 1600])  # 540 px wide → 2160 px tall; 960 px/s
    spec["outputs"] = [{"variant_key": "9x16", "aspect": "9:16", "fill": "color", "color": "#000000"}]
    s = EditSpec.model_validate(spec)
    plan = build_render_command(
        s, {"duration": 4.0, "has_audio": False, "fps": 25}, {}, s.outputs[0],
        source_path=str(src), output_path=str(out), resolve_image_url=lambda url: ImageSource(str(png), 400, 1600),
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    # t = 0.48 s (frame 12): window top y = 461 px into the padded image (pad = 960), so the
    # window [461, 1421) overlaps the copy's rows [960, 3120) by 461 px: the copy shows in the
    # bottom 461 px of the box, centred (108 + (864 − 540) / 2 = 270).
    x0, y0, x1, y1, _ = _bbox_full(out, 12)
    assert (x0, x1) == pytest.approx((270, 809), abs=2)
    assert y0 == pytest.approx(384 + 960 - 461, abs=25) and y1 == pytest.approx(384 + 960 - 1, abs=3)
    # t = 1.48 s: y = 1421 → the copy fills the whole box and nothing leaks outside it.
    x0, y0, x1, y1, _ = _bbox_full(out, 37)
    assert y0 == pytest.approx(384, abs=3) and y1 == pytest.approx(384 + 960 - 1, abs=3)
    assert _bbox_full(out, 37, 0, 380) is None and _bbox_full(out, 37, 384 + 962, 1920) is None
    # t = 3 s: y = 2880 → only the copy's last 240 px remain, at the top of the box.
    x0, y0, x1, y1, _ = _bbox_full(out, 75)
    assert y0 == pytest.approx(384, abs=3) and y1 == pytest.approx(384 + 240 - 1, abs=25)

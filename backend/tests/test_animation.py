"""Text layer animation curves (HIG-40): shared golden cases with the frontend, and the
ffmpeg expressions evaluated by the real ffmpeg against the same numbers."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.schemas import EditSpec, TextAnimation
from app.services.animation import SCALE_HEADROOM, expressions, phase_lengths, sample, scale_headroom, with_time
from app.services.filtergraph import ImageSource, build_render_command
from tests.conftest import valid_spec

CASES_PATH = Path(__file__).resolve().parents[2] / "frontend/src/lib/fixtures/textAnimationCases.json"
CASES = json.loads(CASES_PATH.read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['name']}@{c['u']}")
def test_golden_cases(case):
    f = sample(TextAnimation.model_validate(case["animation"]), case["u"], case["window"])
    for key, want in case["expect"].items():
        assert getattr(f, key) == pytest.approx(want, abs=1e-5), key


def test_golden_cases_cover_every_preset():
    seen = {(k, c["animation"][k]["preset"]) for c in CASES for k in ("in", "out", "loop") if k in c["animation"]}
    for preset in ("fade", "slide_up", "slide_down", "slide_left", "slide_right", "pop"):
        assert ("in", preset) in seen and ("out", preset) in seen
    for preset in ("breathe", "float", "blink"):
        assert ("loop", preset) in seen


def anim(**kw) -> TextAnimation:
    return TextAnimation.model_validate(kw)


def test_no_animation_has_no_expressions():
    assert expressions(None, 3) == expressions(anim(), 3)
    e = expressions(anim(), 3)
    assert (e.opacity, e.dx, e.dy, e.scale) == (None, None, None, None)


def test_only_the_channels_a_preset_moves_get_an_expression():
    e = expressions(anim(**{"in": {"preset": "fade"}}), 3)
    assert e.opacity and not (e.dx or e.dy or e.scale)
    e = expressions(anim(**{"out": {"preset": "slide_left"}}), 3)
    assert e.opacity and e.dx and not (e.dy or e.scale)
    e = expressions(anim(loop={"preset": "breathe"}), 3)
    assert e.scale and not (e.opacity or e.dx or e.dy)


def test_phases_are_clamped_into_the_window():
    a = anim(**{"in": {"preset": "fade", "duration": 2}, "out": {"preset": "fade", "duration": 2}})
    assert phase_lengths(a, 3) == (2, 1)
    assert phase_lengths(a, 1.5) == (1.5, 0)


def test_every_phase_starts_at_rest():
    """Enter ends, loop starts and exit starts without a jump."""
    a = anim(**{"in": {"preset": "pop", "duration": 0.5}, "out": {"preset": "slide_down", "duration": 0.5}, "loop": {"preset": "float", "period": 0.9}})
    for u in (0.5, 2.5):
        before, after = sample(a, u - 1e-4, 3), sample(a, u + 1e-4, 3)
        assert before.opacity == pytest.approx(after.opacity, abs=2e-3)
        assert before.dy == pytest.approx(after.dy, abs=2e-3)
        assert before.scale == pytest.approx(after.scale, abs=2e-3)


def test_golden_cases_cover_every_easing():
    seen = {c["animation"][k].get("easing") for c in CASES for k in ("in", "out") if k in c["animation"]}
    assert {"linear", "ease_in", "ease_out", "ease_in_out", "back", "elastic", "bounce"} <= seen


def test_hig44_defaults_write_the_v016_expressions():
    """Spelling out every default must not change a single character of the ffmpeg expression."""
    plain = anim(**{"in": {"preset": "pop"}, "out": {"preset": "slide_up"}, "loop": {"preset": "blink"}})
    spelled = anim(
        **{
            "in": {"preset": "pop", "easing": "back", "scale": 0.5, "overshoot": 1.70158, "delay": 0, "distance": 0.05, "fade": True},
            "out": {"preset": "slide_up", "easing": "ease_in", "distance": 0.05, "fade": True},
            "loop": {"preset": "blink", "amount": 1},
        }
    )
    assert expressions(plain, 4) == expressions(spelled, 4)


def test_every_easing_starts_and_ends_at_rest():
    for easing in ("linear", "ease_in", "ease_out", "ease_in_out", "back", "elastic", "bounce"):
        a = anim(**{"in": {"preset": "slide_left", "easing": easing, "distance": 0.2}, "out": {"preset": "slide_up", "easing": easing}})
        assert sample(a, 0, 4).dx == pytest.approx(0.2, abs=1e-6), easing
        assert sample(a, 0.5, 4).dx == pytest.approx(0, abs=2e-3), easing
        assert sample(a, 3.5, 4).dy == pytest.approx(0, abs=2e-3), easing
        assert sample(a, 4, 4).dy == pytest.approx(-0.05, abs=2e-3), easing


def test_delay_holds_the_enter_and_moves_the_loop():
    a = anim(**{"in": {"preset": "fade", "duration": 0.5, "delay": 1}, "loop": {"preset": "breathe", "period": 1}})
    assert sample(a, 0.9, 4).opacity == 0
    assert sample(a, 1.5, 4).opacity == pytest.approx(1)
    assert sample(a, 1.4, 4).scale == 1  # the loop waits for the enter
    assert sample(a, 2.0, 4).scale > 1
    assert phase_lengths(anim(**{"in": {"preset": "fade", "duration": 2, "delay": 3}}), 4) == (1, 0)


def test_fade_false_keeps_slides_opaque():
    a = anim(**{"in": {"preset": "slide_up", "fade": False}, "out": {"preset": "slide_down", "fade": False}})
    assert expressions(a, 3).opacity is None
    assert sample(a, 0, 3).dy == pytest.approx(0.05)


def test_scale_headroom_grows_with_big_scales_only():
    assert scale_headroom(anim(**{"in": {"preset": "pop"}}), 3) == SCALE_HEADROOM
    assert scale_headroom(anim(loop={"preset": "breathe"}), 3) == SCALE_HEADROOM
    grow = scale_headroom(anim(**{"in": {"preset": "pop", "scale": 2.5, "easing": "ease_out"}}), 3)
    assert grow >= 2.5
    assert scale_headroom(anim(loop={"preset": "breathe", "amount": 3}), 3) >= 1.18


def test_with_time_shifts_the_local_clock():
    assert with_time("clip(U/0.5,0,1)", "t", 2) == "clip((t-2)/0.5,0,1)"
    assert with_time("clip(U/0.5,0,1)", "T", 0) == "clip(T/0.5,0,1)"


# --- filtergraph -----------------------------------------------------------------------

TEXT_PNG = ImageSource("/data/uploads/u_text00001.png", 540, 130)
META = {"duration": 24.6, "has_audio": True, "width": 1080, "height": 1920, "fps": 25}


def text_only_spec(animation=None, **layer):
    spec = valid_spec(trim={"remove": []})
    text = dict(spec["layers"][1], **layer)
    if animation is not None:
        text["animation"] = animation
    spec["layers"] = [text]
    return spec


def plan_for(spec_dict, meta=META):
    spec = EditSpec.model_validate(spec_dict)
    return build_render_command(
        spec, meta, {}, spec.outputs[0], source_path="/data/src.mp4", output_path="/data/tmp/j.mp4",
        resolve_image_url=lambda url: TEXT_PNG,
    )  # fmt: skip


def graph(plan) -> str:
    return plan.argv[plan.argv.index("-filter_complex") + 1]


def test_static_text_keeps_the_old_argv():
    assert plan_for(text_only_spec()).argv == plan_for(text_only_spec(animation={})).argv
    assert "-loop" not in plan_for(text_only_spec()).argv


def test_animated_text_loops_its_png_and_uses_frame_expressions():
    spec = text_only_spec(
        {"in": {"preset": "pop", "duration": 0.5}, "out": {"preset": "slide_up", "duration": 0.5}},
        t=[2, 5], opacity=0.8,
    )
    plan = plan_for(spec)
    argv, g = plan.argv, graph(plan)
    i = argv.index(TEXT_PNG.path)
    assert argv[i - 7 : i + 1] == ["-loop", "1", "-framerate", "25", "-t", "5", "-i", TEXT_PNG.path]
    # 540×130 layer at width 0.5 → 540 px; padded by the scale headroom, scaled by perspective
    assert "scale=540:130,pad=594:144:27:7:color=0x00000000,perspective=" in g
    assert "((in-1)/25-2)" in g and ":sense=destination:eval=frame" in g
    # opacity: the layer's own 0.8 times the fade, on the output clock shifted to the window
    # evaluated once per row: the gain only depends on time
    assert "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*if(eq(X,0),st(0,0.8*" in g and "(T-2)" in g and "),ld(0))'" in g
    # slide_up exit moves y; x is static; the window still gates the overlay
    assert "overlay=243:" in g and "'+1920*(" not in g
    assert "enable='between(t,2,5)'" in g and "(t-2)" in g


def test_loop_only_float_moves_y_without_touching_alpha_or_size():
    g = graph(plan_for(text_only_spec({"loop": {"preset": "float", "period": 1}})))
    assert "perspective" not in g and "geq" not in g
    assert "1920*(-between(t,0,24.6)*0.008*sin" in g


def test_animation_must_fit_the_window():
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="入场加出场动画时长不能超过出现时段长度"):
        EditSpec.model_validate(text_only_spec({"in": {"preset": "fade", "duration": 1}, "out": {"preset": "fade", "duration": 1}}, t=[0, 1.5]))
    EditSpec.model_validate(text_only_spec({"in": {"preset": "fade", "duration": 5}}))  # "all": clamped at render time
    with pytest.raises(ValidationError):
        EditSpec.model_validate(text_only_spec({"in": {"preset": "spin"}}))
    with pytest.raises(ValidationError):
        EditSpec.model_validate(text_only_spec({"loop": {"preset": "blink", "period": 0.05}}))
    with pytest.raises(ValidationError, match="入场延迟"):
        EditSpec.model_validate(text_only_spec({"in": {"preset": "fade", "duration": 1, "delay": 1}}, t=[0, 1.5]))
    for bad in ({"easing": "spring"}, {"distance": 0.8}, {"scale": 0}, {"overshoot": 9}, {"delay": -1}):
        with pytest.raises(ValidationError):
            EditSpec.model_validate(text_only_spec({"in": {"preset": "slide_up", **bad}}))
    with pytest.raises(ValidationError):
        EditSpec.model_validate(text_only_spec({"loop": {"preset": "blink", "amount": 4}}))


def test_big_pop_scale_pads_the_frame_enough():
    g = graph(plan_for(text_only_spec({"in": {"preset": "pop", "duration": 0.5, "scale": 2, "easing": "ease_out"}}, t=[2, 5])))
    # 540×130 layer; the frame holds the 2× start (headroom = 2.04)
    assert "scale=540:130,pad=1102:266:" in g


# --- real ffmpeg -------------------------------------------------------------------------

@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_follows_the_sampled_curves(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:size=540x960:rate=25:duration=3",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    png = tmp_path / "text.png"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:size=540x130,format=rgba", "-frames:v", "1", str(png)],
        check=True, capture_output=True,
    )  # fmt: skip
    out = tmp_path / "out.mp4"
    animation = {"in": {"preset": "pop", "duration": 0.8}, "out": {"preset": "slide_down", "duration": 0.8}}
    spec = text_only_spec(animation, t=[0.4, 2.8], anchor="center", margin=[0, 0], width=0.5)
    spec["outputs"] = [{"variant_key": "9x16", "aspect": "9:16", "fill": "color", "color": "#000000", "quality": "high"}]
    spec = EditSpec.model_validate(spec)
    plan = build_render_command(
        spec, {"duration": 3.0, "has_audio": False, "fps": 25}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out), resolve_image_url=lambda url: ImageSource(str(png), 540, 130),
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    a = TextAnimation.model_validate(animation)
    base_w = 540  # width 0.5 of the 1080 canvas
    # mid pop-in (overshooting), plain middle, mid slide-down exit; frames picked by number
    for n in (14, 18, 40, 62):
        t = n / 25
        f = sample(a, t - 0.4, 2.4)
        box = _bbox_full(out, n)
        assert box is not None, n
        x0, y0, x1, y1, peak = box
        assert (x1 - x0 + 1) == pytest.approx(base_w * f.scale, abs=8), (t, f)
        cy = (y0 + y1) / 2
        assert cy == pytest.approx(960 + 1920 * f.dy, abs=6), (t, f)
        assert peak == pytest.approx(255 * f.opacity, abs=25), (t, f)
    assert _bbox_full(out, 5) is None  # before the window


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_rotated_breathing_text_stays_centred_and_blinks(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:size=540x960:rate=25:duration=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    png = tmp_path / "text.png"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:size=540x130,format=rgba", "-frames:v", "1", str(png)],
        check=True, capture_output=True,
    )  # fmt: skip
    out = tmp_path / "out.mp4"
    spec = text_only_spec({"loop": {"preset": "breathe", "period": 1.0}}, anchor="center", margin=[0, 0], width=0.5, rotate=90)
    spec["layers"].append(dict(spec["layers"][0], id="l_blink", rotate=0, anchor="top-center", margin=[0, 0.05], animation={"loop": {"preset": "blink", "period": 1.0}}))
    spec["outputs"] = [{"variant_key": "9x16", "aspect": "9:16", "fill": "color", "color": "#000000"}]
    spec = EditSpec.model_validate(spec)
    plan = build_render_command(
        spec, {"duration": 2.0, "has_audio": False, "fps": 25}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out), resolve_image_url=lambda url: ImageSource(str(png), 540, 130),
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)
    a = TextAnimation.model_validate({"loop": {"preset": "breathe", "period": 1.0}})
    n = 12  # t = 0.48: close to the breathe peak
    f = sample(a, n / 25, 2.0)
    x0, y0, x1, y1, _ = _bbox_full(out, n, top=300)
    assert ((x0 + x1) / 2, (y0 + y1) / 2) == (pytest.approx(540, abs=3), pytest.approx(960, abs=3))
    assert (y1 - y0 + 1) == pytest.approx(540 * f.scale, abs=8)  # rotated 90°: the long side is vertical
    blink = sample(TextAnimation.model_validate({"loop": {"preset": "blink", "period": 1.0}}), n / 25, 2.0)
    *_, peak = _bbox_full(out, n, bottom=300)
    assert peak == pytest.approx(255 * blink.opacity, abs=25)


def _bbox_full(path, n, top=0, bottom=1920):
    """Bounding box and peak red of the red text on the black 1080×1920 output, frame number n,
    looking only at rows [top, bottom)."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{n})", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True, timeout=60,
    ).stdout  # fmt: skip
    fw, fh = 1080, 1920
    xs, ys, peak = [], [], 0
    for yy in range(top, min(bottom, fh)):
        row = raw[yy * fw * 3 : (yy + 1) * fw * 3]
        reds = [xx for xx in range(fw) if row[xx * 3] > 60]
        if reds:
            xs += (reds[0], reds[-1])
            ys.append(yy)
            peak = max(peak, max(row[xx * 3] for xx in reds))
    return (min(xs), min(ys), max(xs), max(ys), peak) if xs else None

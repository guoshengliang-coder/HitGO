import math
import re
import shutil
import subprocess

import pytest

from app.schemas import EditSpec
from app.services.filtergraph import (
    ENCODE_ARGS,
    ENCODE_PRESETS,
    ImageSource,
    apply_overrides,
    build_render_command,
    encode_args,
    ffmpeg_color,
    keep_segments,
)
from tests.conftest import valid_spec

STICKER = ImageSource("/data/assets/a_sticker001.png", 600, 240)
TEXT_PNG = ImageSource("/data/uploads/u_text00001.png", 540, 130)
META = {"duration": 24.6, "has_audio": True, "width": 1080, "height": 1920}


def resolver(url: str):
    return TEXT_PNG if url == "/media/uploads/u_text00001.png" else None


def build(spec_dict=None, meta=META, variant_key="9x16", assets=None, resolve=resolver):
    spec = EditSpec.model_validate(spec_dict or valid_spec())
    variant = next(o for o in spec.outputs if o.variant_key == variant_key)
    return build_render_command(
        spec,
        meta,
        {"a_sticker001": STICKER} if assets is None else assets,
        variant,
        source_path="/data/src.mp4",
        output_path="/data/tmp/j.mp4",
        resolve_image_url=resolve,
        ffmpeg_bin="ffmpeg",
    )


def fc(plan) -> str:
    return plan.argv[plan.argv.index("-filter_complex") + 1]


# --- keep segments -------------------------------------------------------------


def test_keep_segments_complement():
    assert keep_segments([(3.2, 5.8), (17.0, 18.4)], 24.6) == [(0.0, 3.2), (5.8, 17.0), (18.4, 24.6)]
    assert keep_segments([], 10) == [(0.0, 10)]
    assert keep_segments([(0, 2)], 10) == [(2, 10)]
    assert keep_segments([(8, 10)], 10) == [(0.0, 8)]
    assert keep_segments([(8, 99)], 10) == [(0.0, 8)]  # clamped


def test_ffmpeg_color():
    assert ffmpeg_color("#FF00aa") == "0xFF00aa"
    assert ffmpeg_color("#00000099") == "0x00000099"


# --- trim / concat -------------------------------------------------------------


def test_no_trim_maps_audio_directly():
    plan = build(valid_spec(trim={"remove": []}, layers=[]))
    assert "trim=" not in fc(plan)
    assert "concat" not in fc(plan)
    assert plan.argv[plan.argv.index("-map") + 1] == "[vout]"
    assert "0:a:0" in plan.argv
    assert plan.expected_duration == pytest.approx(24.6)


def test_multiple_trims_with_audio():
    plan = build(valid_spec(layers=[]))
    graph = fc(plan)
    assert "[0:v]trim=start=0:end=3.2,setpts=PTS-STARTPTS[v0]" in graph
    assert "[0:a]atrim=start=5.8:end=17,asetpts=PTS-STARTPTS[a1]" in graph
    assert "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vt][at]" in graph
    assert "[at]" in plan.argv
    assert plan.expected_duration == pytest.approx(24.6 - 2.6 - 1.4)


def test_trims_without_audio():
    plan = build(valid_spec(layers=[]), meta={**META, "has_audio": False})
    graph = fc(plan)
    assert "atrim" not in graph
    assert "concat=n=3:v=1:a=0[vt]" in graph
    assert "-an" in plan.argv
    assert "0:a:0" not in plan.argv


def test_single_keep_segment_has_no_concat():
    plan = build(valid_spec(trim={"remove": [[0, 4]]}, layers=[]))
    graph = fc(plan)
    assert "concat" not in graph
    assert "[0:v]trim=start=4:end=24.6,setpts=PTS-STARTPTS[v0]" in graph
    assert "[v0]split=2[bg][fg]" in graph
    assert "[a0]" in plan.argv


# --- fill modes -----------------------------------------------------------------


def test_fill_blur_9x16():
    plan = build(valid_spec(trim={"remove": []}, layers=[]))
    graph = fc(plan)
    assert plan.canvas == (1080, 1920)
    assert "[0:v]split=2[bg][fg]" in graph
    assert "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[bgb]" in graph
    assert "[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs]" in graph
    assert "[bgb][fgs]overlay=(W-w)/2:(H-h)/2[c0]" in graph
    assert graph.endswith("[c0]format=yuv420p[vout]")


def test_fill_color_1x1():
    spec = valid_spec(
        trim={"remove": []},
        layers=[],
        outputs=[{"variant_key": "sq", "aspect": "1:1", "fill": "color", "color": "#112233"}],
    )
    plan = build(spec, variant_key="sq")
    assert plan.canvas == (1080, 1080)
    assert (
        "[0:v]scale=1080:1080:force_original_aspect_ratio=decrease,"
        "pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=0x112233[c0]" in fc(plan)
    )


def test_fill_crop_16x9_and_4x5():
    for key, aspect, size in (("w", "16:9", "1920:1080"), ("p", "4:5", "1080:1350")):
        spec = valid_spec(
            trim={"remove": []}, layers=[], outputs=[{"variant_key": key, "aspect": aspect, "fill": "crop"}]
        )
        plan = build(spec, variant_key=key)
        assert f"[0:v]scale={size}:force_original_aspect_ratio=increase,crop={size}[c0]" in fc(plan)


def test_fill_crop_with_source_window():
    # 横屏源里只取正中的竖条：先按窗口裁源，再 cover 居中到画幅
    spec = valid_spec(
        trim={"remove": []},
        layers=[],
        outputs=[{"variant_key": "9x16", "aspect": "9:16", "fill": "crop", "crop": {"x": 0.3418, "y": 0, "w": 0.3164, "h": 1}}],
    )
    graph = fc(build(spec, meta={**META, "width": 1920, "height": 1080}))
    assert "[0:v]crop=w='iw*0.3164':h='ih*1':x='iw*0.3418':y='ih*0'[cs]" in graph
    assert "[cs]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[c0]" in graph
    assert graph.endswith("[c0]format=yuv420p[vout]")


def test_fill_crop_window_after_trim_uses_concat_label():
    spec = valid_spec(
        layers=[],
        outputs=[{"variant_key": "9x16", "aspect": "9:16", "fill": "crop", "crop": {"x": 0.25, "y": 0.1, "w": 0.5, "h": 0.8}}],
    )
    graph = fc(build(spec))
    assert "[vt]crop=w='iw*0.5':h='ih*0.8':x='iw*0.25':y='ih*0.1'[cs]" in graph
    assert "[cs]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[c0]" in graph


def test_crop_window_ignored_unless_fill_is_crop():
    window = {"x": 0.25, "y": 0, "w": 0.5, "h": 1}
    for fill in ("blur", "color"):
        spec = valid_spec(
            trim={"remove": []}, layers=[], outputs=[{"variant_key": "k", "aspect": "9:16", "fill": fill, "crop": window}]
        )
        assert "[cs]" not in fc(build(spec, variant_key="k"))
    # 没有窗口时输出与以前完全一致
    spec = valid_spec(trim={"remove": []}, layers=[], outputs=[{"variant_key": "k", "aspect": "9:16", "fill": "crop"}])
    graph = fc(build(spec, variant_key="k"))
    assert "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[c0]" in graph
    assert "[cs]" not in graph


# --- layers -----------------------------------------------------------------------


def test_sticker_with_time_window_and_text_layer():
    plan = build()
    graph = fc(plan)
    argv = plan.argv
    # inputs: source, sticker, text png
    assert argv.count("-i") == 3
    assert argv[argv.index("-i") + 1] == "/data/src.mp4"
    assert STICKER.path in argv and TEXT_PNG.path in argv
    # sticker: width 0.35*1080=378, height 378*240/600=151.2→151, at (86, 230)
    assert "[1:v]format=rgba,scale=378:151[l1]" in graph
    assert "[c0][l1]overlay=86:230:eof_action=repeat:enable='between(t,0,6)'[c1]" in graph
    # text: 0.5*1080=540 wide, 130 high, top-center margin y 0.06 → x=270 y=115
    assert "[2:v]format=rgba,scale=540:130[l2]" in graph
    assert "[c1][l2]overlay=270:115:eof_action=repeat[c2]" in graph
    assert "enable" not in graph.split("[c1][l2]")[1]
    assert graph.endswith("[c2]format=yuv420p[vout]")
    assert plan.warnings == []


def test_layer_overrides_apply_per_variant():
    plan = build(variant_key="1x1")
    graph = fc(plan)
    # l_1 override: margin 0.05 width 0.3 → w=324 h=130, x=54 y=54
    assert "scale=324:130[l1]" in graph
    assert "overlay=54:54:eof_action=repeat:enable='between(t,0,6)'[c1]" in graph
    spec = EditSpec.model_validate(valid_spec())
    geo = apply_overrides(spec.layers[0], spec.outputs[1])
    assert geo["margin"] == (0.05, 0.05) and geo["width"] == 0.3 and geo["anchor"] == "top-left"


def test_rotation_and_opacity():
    spec = valid_spec(trim={"remove": []})
    spec["layers"] = [{**spec["layers"][0], "rotate": 30, "opacity": 0.5, "t": "all"}]
    plan = build(spec)
    graph = fc(plan)
    rad = f"{math.radians(30):.6f}"
    assert f"rotate={rad}:c=none:ow='rotw({rad})':oh='roth({rad})'" in graph
    assert "colorchannelmixer=aa=0.5[l1]" in graph
    # centre preserved: un-rotated box (86.4, 230.4, 378, 151.2)
    m = re.search(r"\[c0\]\[l1\]overlay=(-?\d+):(-?\d+):eof_action=repeat\[c1\]", graph)
    assert m
    x, y = int(m.group(1)), int(m.group(2))
    rw = 378 * math.cos(math.radians(30)) + 151.2 * math.sin(math.radians(30))
    rh = 378 * math.sin(math.radians(30)) + 151.2 * math.cos(math.radians(30))
    assert x + rw / 2 == pytest.approx(86.4 + 189, abs=1)
    assert y + rh / 2 == pytest.approx(230.4 + 75.6, abs=1)


def test_missing_text_image_is_skipped_with_warning():
    spec = valid_spec()
    spec["layers"][1].pop("image_url")
    plan = build(spec)
    assert plan.argv.count("-i") == 2
    assert any("l_2" in w and "image_url" in w for w in plan.warnings)
    assert "[c1]format=yuv420p[vout]" in fc(plan)


def test_unresolvable_text_png_is_skipped_with_warning():
    plan = build(resolve=lambda _url: None)
    assert plan.argv.count("-i") == 2
    assert any("l_2" in w and "不存在" in w for w in plan.warnings)


def test_missing_sticker_asset_is_skipped_with_warning():
    plan = build(assets={})
    assert plan.argv.count("-i") == 2
    assert any("l_1" in w and "a_sticker001" in w for w in plan.warnings)
    assert "[2:v]" not in fc(plan)
    assert "[1:v]format=rgba,scale=540:130[l1]" in fc(plan)


def test_text_layer_prefers_spec_image_size_but_falls_back_to_png():
    spec = valid_spec(layers=[valid_spec()["layers"][1]])
    spec["layers"][0].pop("image_size")
    plan = build(spec, resolve=lambda _u: ImageSource("/x.png", 1000, 1000))
    assert "scale=540:540[l1]" in fc(plan)


# --- argv shape --------------------------------------------------------------------


def test_argv_encoding_flags_and_progress():
    plan = build()
    argv = plan.argv
    assert argv[0] == "ffmpeg" and "-y" in argv
    for flag in ("libx264", "veryfast", "20", "8M", "16M", "aac", "128k", "+faststart"):
        assert flag in argv
    assert argv[argv.index("-progress") + 1] == "pipe:1"
    assert "-nostats" in argv
    assert argv[-1] == "/data/tmp/j.mp4"
    assert "medium" not in argv and "10M" not in argv


def test_high_quality_tier_uses_slower_preset_and_higher_bitrate():
    spec = valid_spec()
    spec["outputs"][0]["quality"] = "high"
    argv = build(spec).argv
    assert argv[argv.index("-preset") + 1] == "medium"
    assert argv[argv.index("-crf") + 1] == "19"
    assert argv[argv.index("-maxrate") + 1] == "10M"
    assert argv[argv.index("-bufsize") + 1] == "20M"
    for flag in ("libx264", "aac", "128k", "+faststart"):
        assert flag in argv
    assert "veryfast" not in argv and "8M" not in argv
    # the other variant in the same spec keeps its own (standard) tier
    std = build(spec, variant_key="1x1").argv
    assert std[std.index("-preset") + 1] == "veryfast"


def test_encode_presets_and_alias():
    assert ENCODE_ARGS == ENCODE_PRESETS["standard"]
    assert encode_args() == ENCODE_PRESETS["standard"]
    assert encode_args("high") == ENCODE_PRESETS["high"]
    assert encode_args("bogus") == ENCODE_PRESETS["standard"]
    assert encode_args("high") is not ENCODE_PRESETS["high"]  # fresh list each call


def test_everything_removed_raises():
    spec = EditSpec.model_validate(valid_spec(trim={"remove": [[0, 30]]}, layers=[]))
    with pytest.raises(ValueError):
        build_render_command(
            spec, META, {}, spec.outputs[0], source_path="s", output_path="o", ffmpeg_bin="ffmpeg"
        )


# --- integration (needs ffmpeg) ------------------------------------------------------


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_renders(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=3",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    from tests.conftest import make_png

    sticker = make_png(tmp_path / "s.png")
    text = make_png(tmp_path / "t.png", (540, 130))
    spec = EditSpec.model_validate(valid_spec(trim={"remove": [[1, 2]]}))
    plan = build_render_command(
        spec,
        {"duration": 3.0, "has_audio": True},
        {"a_sticker001": ImageSource(str(sticker), 600, 240)},
        spec.outputs[0],
        source_path=str(src),
        output_path=str(tmp_path / "out.mp4"),
        resolve_image_url=lambda _u: ImageSource(str(text), 540, 130),
    )
    subprocess.run(plan.argv, check=True, capture_output=True)
    assert (tmp_path / "out.mp4").stat().st_size > 0

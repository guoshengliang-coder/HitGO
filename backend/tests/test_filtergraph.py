import math
import re
import shutil
import subprocess

import pytest

from app.schemas import EditSpec
from app.services.filtergraph import (
    CoverSource,
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


# --- video stickers ---------------------------------------------------------------

# 3s sticker; the spec's l_1 window is [0, 6] and the post-trim duration is 20.6s.
VIDEO_STICKER = ImageSource("/data/assets/a_sticker001.webm", 600, 240, duration=3.0)
ALPHA_WEBM = ImageSource(
    "/data/assets/a_sticker001.webm", 600, 240, duration=3.0, decoder="libvpx-vp9", has_alpha=True
)


def video_build(spec_dict=None, source=VIDEO_STICKER, **kw):
    return build(spec_dict, assets={"a_sticker001": source}, **kw)


def test_video_sticker_loops_and_is_time_aligned():
    plan = video_build()
    graph, argv = fc(plan), plan.argv
    i = argv.index(VIDEO_STICKER.path)
    # -stream_loop belongs to this input, immediately before its -i
    assert argv[i - 3:i + 1] == ["-stream_loop", "-1", "-i", VIDEO_STICKER.path]
    # Sticker starts at its own frame 0 when the window opens, and is bounded by it.
    assert "[1:v]format=rgba,scale=378:151,setpts=PTS-STARTPTS,trim=end=6[l1]" in graph
    assert "[c0][l1]overlay=86:230:eof_action=repeat:enable='between(t,0,6)'[c1]" in graph
    # Output duration is pinned to the post-trim length (overlay takes the longest input)
    assert argv[argv.index("-t") + 1] == "20.6"


def test_video_sticker_offset_window_shifts_pts():
    spec = valid_spec()
    spec["layers"][0]["t"] = [4, 9]
    graph = fc(video_build(spec))
    assert "setpts=PTS-STARTPTS+4/TB,trim=end=9[l1]" in graph
    assert "enable='between(t,4,9)'" in graph


def test_video_sticker_all_window_is_bounded_by_post_trim_duration():
    spec = valid_spec()
    spec["layers"][0]["t"] = "all"
    graph = fc(video_build(spec))
    # trim keeps a long sticker from stretching the output; no enable for "all"
    assert "setpts=PTS-STARTPTS,trim=end=20.6[l1]" in graph
    assert "[c0][l1]overlay=86:230:eof_action=repeat[c1]" in graph


def test_video_sticker_playback_modes():
    spec = valid_spec()
    spec["layers"][0]["playback"] = "freeze"
    plan = video_build(spec)
    assert "-stream_loop" not in plan.argv  # freeze holds the last frame instead
    assert "eof_action=repeat" in fc(plan)

    spec["layers"][0]["playback"] = "once"
    plan = video_build(spec)
    assert "-stream_loop" not in plan.argv
    assert "[c0][l1]overlay=86:230:eof_action=pass" in fc(plan)


def test_alpha_webm_forces_its_decoder():
    argv = video_build(source=ALPHA_WEBM).argv
    i = argv.index(ALPHA_WEBM.path)
    # Without this the VP9 alpha channel is silently dropped (opaque black block).
    assert argv[i - 5:i + 1] == ["-stream_loop", "-1", "-c:v", "libvpx-vp9", "-i", ALPHA_WEBM.path]


def test_video_sticker_starting_past_the_end_is_skipped_with_warning():
    spec = valid_spec()
    spec["layers"][0]["t"] = [30, 40]
    plan = video_build(spec)
    assert VIDEO_STICKER.path not in plan.argv  # not even added as an input
    assert any("出现时段起点超出剪后时长" in w for w in plan.warnings)


def test_still_image_argv_is_unchanged_by_the_video_support():
    """Still-image renders must keep their exact command line (no -t, no -stream_loop)."""
    argv = build().argv
    assert "-t" not in argv and "-stream_loop" not in argv
    assert "-c:v" not in argv[: argv.index("-filter_complex")]
    # the layer chains carry no timing steps (trim/concat still uses setpts, as before)
    for chain in fc(build()).split(";"):
        if chain.startswith("[1:v]") or chain.startswith("[2:v]"):
            assert "setpts" not in chain and "trim=" not in chain


def test_video_sticker_rotation_and_opacity_still_apply():
    spec = valid_spec()
    spec["layers"][0]["rotate"] = 30
    spec["layers"][0]["opacity"] = 0.5
    graph = fc(video_build(spec))
    chain = next(c for c in graph.split(";") if c.startswith("[1:v]"))
    # rotate/opacity come before the timing steps, exactly as for still images
    assert chain.index("rotate=") < chain.index("colorchannelmixer") < chain.index("setpts")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_video_sticker_does_not_stretch_the_output(tmp_path):
    """A sticker longer than the clip must not extend it (overlay takes the longest input)."""
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=3",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    sticker = tmp_path / "sticker.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=8",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(sticker)],
        check=True, capture_output=True,
    )  # fmt: skip

    out = tmp_path / "out.mp4"
    spec = EditSpec.model_validate(
        valid_spec(trim={"remove": []}, layers=[dict(valid_spec()["layers"][0], t="all")])
    )
    plan = build_render_command(
        spec,
        {"duration": 3.0, "has_audio": False},
        {"a_sticker001": ImageSource(str(sticker), 160, 120, duration=8.0)},
        spec.outputs[0],
        source_path=str(src),
        output_path=str(out),
    )
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", str(out)],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    assert abs(float(probe.stdout.strip()) - plan.expected_duration) < 0.15


# --- sticker audio (mix_audio) ------------------------------------------------------

VOCAL_STICKER = ImageSource("/data/assets/a_sticker001.mp4", 600, 240, duration=3.0, has_audio=True)
AFMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


def mixing_spec(**layer):
    spec = valid_spec()
    spec["layers"][0].update({"mix_audio": True, **layer})
    return spec


def test_sticker_audio_is_left_out_unless_the_layer_mixes_it():
    """Default (no mix_audio): the argv is exactly what it was before audio mixing existed."""
    vocal = video_build(source=VOCAL_STICKER)
    mute = video_build(source=ImageSource(VOCAL_STICKER.path, 600, 240, duration=3.0))
    assert vocal.argv == mute.argv
    assert "[aout]" not in fc(vocal) and "amix" not in fc(vocal)


def test_mixed_sticker_audio_is_windowed_delayed_and_mixed_over_the_trimmed_source():
    plan = video_build(mixing_spec(t=[4, 9]), source=VOCAL_STICKER)
    graph, argv = fc(plan), plan.argv
    # Same timing as the picture: starts at its own 0 s at t=4, cut after the 5 s window.
    assert f"[1:a]asetpts=PTS-STARTPTS,atrim=end=5,adelay=4000:all=1,{AFMT}[sa1]" in graph
    # valid_spec removes two ranges, so the source audio is the concat output [at].
    assert f"[at]{AFMT}[abase]" in graph
    assert "[abase][sa1]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[aout]" in graph
    assert argv[argv.index("[vout]") + 1 : argv.index("[vout]") + 3] == ["-map", "[aout]"]
    assert "-an" not in argv and argv.count("-map") == 2


def test_mixed_sticker_audio_at_time_zero_needs_no_delay_and_loops_with_the_input():
    plan = video_build(mixing_spec(), source=VOCAL_STICKER)
    assert f"[1:a]asetpts=PTS-STARTPTS,atrim=end=6,{AFMT}[sa1]" in fc(plan)
    i = plan.argv.index(VOCAL_STICKER.path)
    assert plan.argv[i - 3 : i - 1] == ["-stream_loop", "-1"]  # audio repeats with the picture


def test_mixed_sticker_audio_over_an_untrimmed_source_uses_its_first_audio_stream():
    spec = mixing_spec()
    spec["trim"] = {"remove": []}
    assert f"[0:a:0]{AFMT}[abase]" in fc(video_build(spec, source=VOCAL_STICKER))


def test_mixed_sticker_audio_over_a_silent_source_gets_a_silent_bed():
    plan = video_build(mixing_spec(), source=VOCAL_STICKER, meta={**META, "has_audio": False})
    graph = fc(plan)
    assert "anullsrc=r=48000:cl=stereo,atrim=end=20.6[abase]" in graph
    assert "[abase][sa1]amix=inputs=2" in graph
    assert "-an" not in plan.argv and "[aout]" in plan.argv


def test_mix_audio_is_ignored_for_stickers_without_audio_and_for_still_images():
    silent = video_build(mixing_spec())  # VIDEO_STICKER has no audio
    assert "amix" not in fc(silent) and "[1:a]" not in fc(silent)
    still = build(mixing_spec())
    assert "amix" not in fc(still) and still.argv == build().argv


def test_several_mixed_stickers_all_join_the_mix():
    spec = mixing_spec()
    spec["layers"].append(dict(spec["layers"][0], id="l_3", t=[10, 12], playback="once"))
    graph = fc(video_build(spec, source=VOCAL_STICKER))
    assert "[sa1]" in graph and "adelay=10000:all=1" in graph
    assert "[abase][sa1][sa2]amix=inputs=3" in graph


def _mean_volume(path, start, duration) -> float:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-ss", str(start), "-t", str(duration), "-i", str(path),
         "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    match = re.search(r"mean_volume: (-?[\d.]+|-inf) dB", proc.stderr)
    assert match, proc.stderr[-500:]
    return float("-inf") if match.group(1) == "-inf" else float(match.group(1))


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_mixes_sticker_audio_only_inside_its_window(tmp_path):
    """Silent 4 s source + 1 s beeping sticker looped over [1.5, 3.5]: sound only in the window."""
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=4",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    sticker = tmp_path / "sticker.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=1",
         "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(sticker)],
        check=True, capture_output=True,
    )  # fmt: skip

    out = tmp_path / "out.mp4"
    layer = dict(valid_spec()["layers"][0], t=[1.5, 3.5], mix_audio=True)
    spec = EditSpec.model_validate(valid_spec(trim={"remove": []}, layers=[layer]))
    plan = build_render_command(
        spec,
        {"duration": 4.0, "has_audio": False},
        {"a_sticker001": ImageSource(str(sticker), 160, 120, duration=1.0, has_audio=True)},
        spec.outputs[0],
        source_path=str(src),
        output_path=str(out),
    )
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,duration", "-of", "default=nw=1:nk=1", str(out)],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    codec, duration = probe.stdout.split()
    assert codec == "aac"
    assert abs(float(duration) - plan.expected_duration) < 0.15
    assert _mean_volume(out, 0.1, 1.2) < -60  # before the window: silence
    assert _mean_volume(out, 1.7, 1.6) > -30  # inside (spans the loop point): the beep


# --- audio tracks (contract §2 audio) ----------------------------------------------

from app.services.filtergraph import AudioSource  # noqa: E402

BGM = AudioSource("/data/assets/a_bgm00001.mp3", 30.0)
VOICE = AudioSource("/data/assets/a_voice0001.wav", 4.0)
AUDIO_ASSETS = {"a_bgm00001": BGM, "a_voice0001": VOICE}


def audio_spec(source_volume=1.0, tracks=(), **spec_overrides):
    spec = valid_spec(**spec_overrides)
    spec["audio"] = {"source_volume": source_volume, "tracks": list(tracks)}
    return spec


def audio_build(spec_dict, audio_assets=AUDIO_ASSETS, **kw):
    spec = EditSpec.model_validate(spec_dict)
    variant = spec.outputs[0]
    return build_render_command(
        spec,
        kw.pop("meta", META),
        {"a_sticker001": STICKER},
        variant,
        source_path="/data/src.mp4",
        output_path="/data/tmp/j.mp4",
        resolve_image_url=resolver,
        ffmpeg_bin="ffmpeg",
        audio_assets=audio_assets,
        **kw,
    )


def test_spec_without_audio_block_keeps_the_exact_old_argv():
    assert audio_build(valid_spec()).argv == build().argv
    # An audio block with defaults and no tracks is the same as none at all.
    assert audio_build(audio_spec()).argv == build().argv


def test_muted_source_with_a_looping_bgm_mixes_over_a_silent_bed():
    track = {"id": "au_1", "asset_id": "a_bgm00001", "t": "all", "loop": True, "volume": 0.6, "fade_out": 1}
    plan = audio_build(audio_spec(source_volume=0, tracks=[track]))
    graph, argv = fc(plan), plan.argv
    i = argv.index(BGM.path)
    assert argv[i - 3 : i + 1] == ["-stream_loop", "-1", "-i", BGM.path]
    # Whole post-trim timeline (20.6 s), looped, so the fade-out sits at the window end.
    assert f"[3:a]asetpts=PTS-STARTPTS,atrim=end=20.6,volume=0.6,afade=t=out:st=19.6:d=1,{AFMT}[tk1]" in graph
    assert "anullsrc=r=48000:cl=stereo,atrim=end=20.6[abase]" in graph
    assert "[abase][tk1]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[aout]" in graph
    assert argv[argv.index("[vout]") + 1 : argv.index("[vout]") + 3] == ["-map", "[aout]"]
    # Muted source: its audio is not decoded at all — no atrim / concat audio leg, so no
    # dangling [at] output for ffmpeg to reject ("Filter 'concat' has output 0 unconnected").
    assert "concat=n=3:v=1:a=0[vt]" in graph
    assert "[at]" not in graph and "[0:a]" not in graph
    assert argv[argv.index("-t") + 1] == "20.6"


def test_muted_trimmed_source_without_tracks_has_no_audio_leg_at_all():
    plan = audio_build(audio_spec(source_volume=0))
    graph, argv = fc(plan), plan.argv
    assert "concat=n=3:v=1:a=0[vt]" in graph
    assert "[at]" not in graph and "[0:a]" not in graph and "anullsrc" not in graph
    assert "-an" in argv


def test_single_kept_segment_with_muted_source_skips_the_source_audio_trim():
    track = {"id": "au_1", "asset_id": "a_bgm00001", "t": "all", "loop": True}
    plan = audio_build(audio_spec(source_volume=0, tracks=[track], trim={"remove": [[0, 4.0]]}))
    graph = fc(plan)
    assert "[0:a]atrim" not in graph and "[a0]" not in graph
    assert "anullsrc=r=48000:cl=stereo,atrim=end=20.6[abase]" in graph


def test_voice_track_is_windowed_offset_delayed_and_faded_against_its_real_end():
    track = {"id": "au_v", "asset_id": "a_voice0001", "role": "voice", "t": [2, 12], "offset": 1, "volume": 0.8, "fade_in": 0.2, "fade_out": 0.5}
    plan = audio_build(audio_spec(source_volume=0.3, tracks=[track]))
    graph = fc(plan)
    # 4 s file from 1 s in = 3 s of sound inside a 10 s window: the fade-out ends at 3 s, not 10 s.
    assert (
        f"[3:a]atrim=start=1,asetpts=PTS-STARTPTS,atrim=end=10,volume=0.8,"
        f"afade=t=in:st=0:d=0.2,afade=t=out:st=2.5:d=0.5,adelay=2000:all=1,{AFMT}[tk1]"
    ) in graph
    assert f"[at]{AFMT},volume=0.3[abase]" in graph  # trimmed source, lowered
    assert "[abase][tk1]amix=inputs=2" in graph
    assert "-stream_loop" not in plan.argv


def test_source_gain_alone_maps_the_base_without_amix():
    plan = audio_build(audio_spec(source_volume=0.5))
    graph, argv = fc(plan), plan.argv
    assert f"[at]{AFMT},volume=0.5[abase]" in graph
    assert "amix" not in graph and "anullsrc" not in graph
    assert argv[argv.index("[vout]") + 1 : argv.index("[vout]") + 3] == ["-map", "[abase]"]
    assert "-t" not in argv  # no looped input: the old belt-and-braces stays off


def test_source_gain_on_an_untrimmed_source_uses_its_first_audio_stream():
    plan = audio_build(audio_spec(source_volume=0.5, trim={"remove": []}))
    assert f"[0:a:0]{AFMT},volume=0.5[abase]" in fc(plan)


def test_muted_source_with_nothing_mixed_in_drops_the_audio_stream():
    plan = audio_build(audio_spec(source_volume=0))
    assert "-an" in plan.argv and "-map" not in plan.argv[plan.argv.index("[vout]") + 1 :]
    assert "abase" not in fc(plan)


def test_silent_source_with_a_track_still_gets_a_bed_and_a_gain_is_ignored():
    track = {"id": "au_1", "asset_id": "a_voice0001", "t": [0, 3]}
    plan = audio_build(audio_spec(source_volume=0.5, tracks=[track]), meta={**META, "has_audio": False})
    graph = fc(plan)
    assert "anullsrc=r=48000:cl=stereo,atrim=end=20.6[abase]" in graph and "volume=0.5" not in graph
    assert f"[3:a]asetpts=PTS-STARTPTS,atrim=end=3,{AFMT}[tk1]" in graph


def test_tracks_join_the_sticker_audio_mix():
    spec = audio_spec(tracks=[{"id": "au_1", "asset_id": "a_bgm00001", "t": [1, 5]}])
    spec["layers"][0]["mix_audio"] = True
    spec = EditSpec.model_validate(spec)
    plan = build_render_command(
        spec, META, {"a_sticker001": VOCAL_STICKER}, spec.outputs[0],
        source_path="/data/src.mp4", output_path="/data/tmp/j.mp4", resolve_image_url=resolver,
        audio_assets=AUDIO_ASSETS,
    )  # fmt: skip
    graph = fc(plan)
    assert "[sa1]" in graph and f"[3:a]asetpts=PTS-STARTPTS,atrim=end=4,adelay=1000:all=1,{AFMT}[tk1]" in graph
    assert "[abase][sa1][tk1]amix=inputs=3" in graph


def test_unresolved_or_out_of_range_tracks_are_skipped_with_a_warning():
    tracks = [
        {"id": "au_missing", "asset_id": "a_nope", "t": "all"},
        {"id": "au_late", "asset_id": "a_bgm00001", "t": [30, 40]},  # after the 20.6 s post-trim end
        {"id": "au_past", "asset_id": "a_voice0001", "t": "all", "offset": 4.5},  # beyond the 4 s file
        {"id": "au_ok", "asset_id": "a_voice0001", "t": "all"},
    ]
    plan = audio_build(audio_spec(tracks=tracks))
    assert [w.split("：")[0] for w in plan.warnings] == ["音轨 au_missing", "音轨 au_late", "音轨 au_past"]
    assert "不存在" in plan.warnings[0] and "超出剪后时长" in plan.warnings[1] and "起始偏移" in plan.warnings[2]
    graph = fc(plan)
    assert "[3:a]" in graph and "[tk1]" in graph and "[tk2]" not in graph
    assert plan.argv.count("-i") == 4  # source, sticker, text PNG, the one usable track


def test_track_window_is_clamped_to_the_post_trim_duration():
    plan = audio_build(audio_spec(tracks=[{"id": "au_1", "asset_id": "a_bgm00001", "t": [18, 40], "loop": True}]))
    assert "atrim=end=2.6" in fc(plan) and "adelay=18000:all=1" in fc(plan)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_replaces_the_source_audio_with_a_windowed_bgm(tmp_path):
    """Beeping 4 s source, muted; 1 s beep looped over [1.5, 3.5] as BGM: sound only in the window."""
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=4",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=4",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    bgm = tmp_path / "bgm.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=1", str(bgm)],
        check=True, capture_output=True,
    )  # fmt: skip

    out = tmp_path / "out.mp4"
    # A real cut inside the clip: the trimmed video goes through concat while the muted
    # source audio must be left out of the graph entirely (this used to fail with exit 234).
    spec = valid_spec(trim={"remove": [[0.5, 1.0]]}, layers=[])  # post-trim length: 3.5 s
    spec["audio"] = {"source_volume": 0, "tracks": [{"id": "au_1", "asset_id": "a_bgm", "t": [1.5, 3.0], "loop": True}]}
    spec = EditSpec.model_validate(spec)
    plan = build_render_command(
        spec, {"duration": 4.0, "has_audio": True}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out),
        audio_assets={"a_bgm": AudioSource(str(bgm), 1.0)},
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,duration", "-of", "default=nw=1:nk=1", str(out)],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    codec, duration = probe.stdout.split()
    assert codec == "aac"
    assert abs(float(duration) - plan.expected_duration) < 0.15
    assert _mean_volume(out, 0.1, 1.2) < -60  # source muted: silence before the window
    assert _mean_volume(out, 1.7, 1.2) > -30  # inside (spans the loop point): the beep
    assert _mean_volume(out, 3.1, 0.3) < -60  # after the window: silence again


# --- source_mute / split tracks (HIG-25) and the audio mix record (HIG-26) -------------


def test_source_mute_silences_spans_of_the_trimmed_source_track():
    spec = audio_spec(source_volume=0.5)
    spec["audio"]["source_mute"] = [[2, 3.5], [19, 40]]  # the second is clamped to 20.6
    graph = fc(audio_build(spec))
    assert (
        f"[at]{AFMT},volume=0.5,asetpts=PTS-STARTPTS,"
        "volume=0:enable='between(t,2,3.5)',volume=0:enable='between(t,19,20.6)'[abase]"
    ) in graph
    argv = audio_build(spec).argv
    assert argv[argv.index("[vout]") + 1 : argv.index("[vout]") + 3] == ["-map", "[abase]"]


def test_source_mute_alone_is_enough_to_route_the_untrimmed_source_through_the_graph():
    spec = audio_spec(trim={"remove": []})
    spec["audio"]["source_mute"] = [[1, 2]]
    plan = audio_build(spec)
    assert f"[0:a:0]{AFMT},asetpts=PTS-STARTPTS,volume=0:enable='between(t,1,2)'[abase]" in fc(plan)
    assert plan.audio == {"source_volume": 1.0, "source_mute": 1, "tracks": [], "skipped": []}


def test_source_mute_is_ignored_when_the_source_is_not_heard():
    spec = audio_spec(source_volume=0)
    spec["audio"]["source_mute"] = [[1, 2]]
    plan = audio_build(spec)
    assert "volume=0:enable" not in fc(plan) and "-an" in plan.argv
    spec = audio_spec()
    spec["audio"]["source_mute"] = [[30, 40]]  # entirely after the 20.6 s output
    assert audio_build(spec).argv == build().argv


def test_looping_track_with_an_offset_starts_mid_file():
    track = {"id": "au_1", "asset_id": "a_bgm00001", "t": [4, 10], "loop": True, "offset": 12.5}
    plan = audio_build(audio_spec(source_volume=0, tracks=[track]))
    i = plan.argv.index(BGM.path)
    assert plan.argv[i - 3 : i + 1] == ["-stream_loop", "-1", "-i", BGM.path]
    assert f"[3:a]atrim=start=12.5,asetpts=PTS-STARTPTS,atrim=end=6,adelay=4000:all=1,{AFMT}[tk1]" in fc(plan)


def test_plan_records_which_tracks_were_mixed_and_which_were_skipped():
    bgm = AudioSource(BGM.path, BGM.duration, name="TikTok Original.m4a")
    tracks = [
        {"id": "au_b", "asset_id": "a_bgm00001", "t": "all", "loop": True},
        {"id": "au_gone", "asset_id": "a_deleted", "role": "voice"},
        {"id": "au_v", "asset_id": "a_voice0001", "role": "voice", "t": [1, 3]},
    ]
    plan = audio_build(audio_spec(source_volume=0, tracks=tracks), audio_assets={"a_bgm00001": bgm, "a_voice0001": VOICE})
    assert plan.audio == {
        "source_volume": 0.0,
        "source_mute": 0,
        "tracks": [
            {"id": "au_b", "asset_id": "a_bgm00001", "name": "TikTok Original.m4a", "role": "bgm"},
            {"id": "au_v", "asset_id": "a_voice0001", "name": "", "role": "voice"},
        ],
        "skipped": ["au_gone"],
    }
    assert any("au_gone" in w for w in plan.warnings)
    assert audio_build(valid_spec()).audio is None
    # A source without audio is reported as silent, whatever source_volume says.
    no_audio = audio_build(audio_spec(tracks=tracks[:1]), meta={**META, "has_audio": False})
    assert no_audio.audio["source_volume"] == 0.0


def _tone(path, freq, duration):
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=48000:duration={duration}", str(path)],
        check=True, capture_output=True,
    )  # fmt: skip


def _band_volume(path, freq, start, duration) -> float:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-ss", str(start), "-t", str(duration), "-i", str(path),
         "-af", f"bandpass=f={freq}:w=60,volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    match = re.search(r"mean_volume: (-?[\d.]+|-inf) dB", proc.stderr)
    assert match, proc.stderr[-500:]
    return float("-inf") if match.group(1) == "-inf" else float(match.group(1))


def _src_with_tone(tmp_path, duration=6):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=size=540x960:rate=30:duration={duration}",
         "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=44100:duration={duration}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    return src


def _render(tmp_path, src, spec_dict, audio_assets, meta):
    out = tmp_path / "out.mp4"
    spec = EditSpec.model_validate(spec_dict)
    plan = build_render_command(
        spec, meta, {}, spec.outputs[0], source_path=str(src), output_path=str(out), audio_assets=audio_assets,
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)
    return out, plan


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_source_mute_silences_only_its_span(tmp_path):
    src = _src_with_tone(tmp_path, 5)
    spec = valid_spec(trim={"remove": [[0, 1]]}, layers=[])  # post-trim: 4 s
    spec["audio"] = {"source_volume": 1, "source_mute": [[1, 2]], "tracks": []}
    out, _ = _render(tmp_path, src, spec, {}, {"duration": 5.0, "has_audio": True})
    assert abs(_probe_duration(out, "v:0") - 4.0) < 0.15  # picture untouched
    assert _mean_volume(out, 0.2, 0.6) > -30
    assert _mean_volume(out, 1.15, 0.7) < -60  # the muted span
    assert _mean_volume(out, 2.2, 1.0) > -30  # sound resumes in place, not shifted


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_split_track_halves_play_like_the_whole_track(tmp_path):
    """A 1.5 s looping chirp over [0, 4] split at 1.7 s: the halves must reproduce the unsplit mix.

    Thresholds are relative: two separate AAC encodes leave a codec-dependent floor (−91 dB on
    ffmpeg 8, about −37 dB on CI's apt ffmpeg), while a wrong split (second half restarting the
    file) is only a few dB below the signal itself.
    """
    src = _src_with_tone(tmp_path, 4)
    chirp = tmp_path / "chirp.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "aevalsrc='sin(2*PI*(300+400*t)*t)':s=48000:d=1.5", str(chirp)],
        check=True, capture_output=True,
    )  # fmt: skip
    assets = {"a_chirp": AudioSource(str(chirp), 1.5)}
    meta = {"duration": 4.0, "has_audio": True}

    def render(name, tracks):
        spec = valid_spec(trim={"remove": []}, layers=[])
        spec["audio"] = {"source_volume": 0, "tracks": tracks}
        (tmp_path / name).mkdir()
        return _render(tmp_path / name, src, spec, assets, meta)[0]

    whole = render("whole", [{"id": "au_1", "asset_id": "a_chirp", "t": [0, 4], "loop": True}])
    first = {"id": "au_1", "asset_id": "a_chirp", "t": [0, 1.7], "loop": True}
    split = render("split", [first, {"id": "au_2", "asset_id": "a_chirp", "t": [1.7, 4], "loop": True, "offset": 0.2}])  # 1.7 mod 1.5
    wrong = render("wrong", [first, {"id": "au_2", "asset_id": "a_chirp", "t": [1.7, 4], "loop": True}])

    def residual(a, b):
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-i", str(a), "-i", str(b), "-filter_complex",
             "[1:a]volume=-1[neg];[0:a][neg]amix=inputs=2:normalize=0,atrim=start=0.1:end=3.8,volumedetect",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=60,
        )  # fmt: skip
        return float(re.search(r"mean_volume: (-?[\d.]+|-inf) dB", proc.stderr).group(1))

    level = _mean_volume(whole, 0.1, 3.7)
    good, bad = residual(whole, split), residual(whole, wrong)
    assert level > -30
    assert good < level - 25, (level, good)
    assert bad > good + 20, (good, bad)  # the check can tell a continued loop from a restarted one


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_stem_plus_new_bgm_and_voice_are_all_in_the_output(tmp_path):
    """HIG-26 scenario: muted source, separated stem kept, a new BGM and a new voice-over added."""
    src = _src_with_tone(tmp_path, 6)
    stem = tmp_path / "stem.m4a"
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vn", "-c:a", "aac", str(stem)], check=True, capture_output=True)
    bgm, voice = tmp_path / "bgm.wav", tmp_path / "voice.wav"
    _tone(bgm, 880, 2)
    _tone(voice, 1500, 1)
    assets = {
        "a_stem": AudioSource(str(stem), 6.0, name="stem"),
        "a_bgm": AudioSource(str(bgm), 2.0, name="bgm.wav"),
        "a_voice": AudioSource(str(voice), 1.0, name="voice.wav"),
    }
    spec = valid_spec(trim={"remove": [[1, 1.5]]}, layers=[])
    spec["audio"] = {"source_volume": 0, "tracks": [
        {"id": "au_s", "asset_id": "a_stem", "role": "voice", "align": "source", "t": "all"},
        {"id": "au_b", "asset_id": "a_bgm", "t": "all", "loop": True, "volume": 0.6, "fade_out": 1},
        {"id": "au_v", "asset_id": "a_voice", "role": "voice", "t": [3, 4]},
    ]}  # fmt: skip
    out, plan = _render(tmp_path, src, spec, assets, {"duration": 6.0, "has_audio": True})
    assert plan.warnings == [] and [t["id"] for t in plan.audio["tracks"]] == ["au_s", "au_b", "au_v"]
    assert _band_volume(out, 440, 3.2, 0.5) > -40  # stem
    assert _band_volume(out, 880, 3.2, 0.5) > -40  # new BGM (looped past its 2 s)
    assert _band_volume(out, 1500, 3.2, 0.5) > -40  # new voice inside its window
    assert _band_volume(out, 1500, 1.0, 0.5) < -55  # …and not outside it


# --- cover (contract §2 cover, HIG-9) ----------------------------------------------

COVER_IMAGE = ImageSource("/data/assets/a_cover0001.jpg", 1080, 1920)
COVER_VIDEO = ImageSource("/data/assets/a_cover0002.mp4", 1920, 1080, duration=2.5, has_audio=True)


def cover_build(spec_dict, cover, meta=META, **kw):
    spec = EditSpec.model_validate(spec_dict)
    return build_render_command(
        spec,
        meta,
        {"a_sticker001": STICKER},
        spec.outputs[0],
        source_path="/data/src.mp4",
        output_path="/data/tmp/j.mp4",
        resolve_image_url=resolver,
        ffmpeg_bin="ffmpeg",
        cover=cover,
        **kw,
    )


def cover_spec(asset_id="a_cover0001", duration=1.0, **overrides):
    return valid_spec(cover={"asset_id": asset_id, "duration": duration}, **overrides)


def test_spec_without_cover_keeps_the_exact_old_argv():
    assert cover_build(valid_spec(), None).argv == build().argv


def test_image_cover_is_looped_filled_and_concatenated_before_the_main_part():
    plan = cover_build(cover_spec(duration=1.5), CoverSource(COVER_IMAGE, 1.5), meta={**META, "fps": 25})
    graph = fc(plan)
    # The main part keeps its chains; only its tail is renamed and pinned to the post-trim length.
    assert "format=yuv420p,setsar=1,trim=end=20.6[vmain]" in graph
    assert "[vout]" not in graph
    # Source audio went through trim/concat as [at]; it is padded to the same length.
    assert f"[at]{AFMT},apad,atrim=end=20.6[amain]" in graph
    i = plan.argv.index("/data/assets/a_cover0001.jpg")
    assert plan.argv[i - 7 : i + 1] == ["-loop", "1", "-framerate", "25", "-t", "1.5", "-i", "/data/assets/a_cover0001.jpg"]
    idx = plan.argv.count("-i") - 1
    assert f"[{idx}:v]split=2[bg_cv][fg_cv]" in graph
    assert "[bgb_cv][fgs_cv]overlay=(W-w)/2:(H-h)/2[cvf]" in graph
    assert "[cvf]fps=25,setsar=1,format=yuv420p,trim=end=1.5,setpts=PTS-STARTPTS[cv]" in graph
    assert "anullsrc=r=48000:cl=stereo,atrim=end=1.5[ca]" in graph
    assert graph.endswith("[cv][ca][vmain][amain]concat=n=2:v=1:a=1[vfinal][afinal]")
    assert plan.argv[plan.argv.index("[vfinal]") - 1] == "-map"
    assert ["-map", "[afinal]"] == plan.argv[plan.argv.index("[afinal]") - 1 : plan.argv.index("[afinal]") + 1]
    assert plan.expected_duration == pytest.approx(22.1)


def test_video_cover_keeps_its_own_sound_and_length_and_ignores_the_crop_window():
    spec = cover_spec(asset_id="a_cover0002", duration=9)
    spec["outputs"] = [{"variant_key": "9x16", "aspect": "9:16", "fill": "crop", "crop": {"x": 0.25, "y": 0, "w": 0.5, "h": 1}}]
    plan = cover_build(spec, CoverSource(COVER_VIDEO, 9))
    graph = fc(plan)
    idx = plan.argv.count("-i") - 1
    assert plan.argv[plan.argv.index("/data/assets/a_cover0002.mp4") - 1] == "-i"
    assert "-loop" not in plan.argv
    # Main part honours the window, the cover is a plain cover-crop (default 30 fps without meta).
    assert "[0:v]trim=start=0:end=3.2" in graph and "crop=w='iw*0.5'" in graph
    assert f"[{idx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[cvf]" in graph
    assert "[cvf]fps=30,setsar=1,format=yuv420p,trim=end=2.5,setpts=PTS-STARTPTS[cv]" in graph
    assert f"[{idx}:a]asetpts=PTS-STARTPTS,{AFMT},apad,atrim=end=2.5[ca]" in graph
    assert plan.expected_duration == pytest.approx(23.1)


def test_cover_over_an_untrimmed_source_takes_its_first_audio_stream():
    plan = cover_build(cover_spec(trim={"remove": []}), CoverSource(COVER_IMAGE))
    assert f"[0:a:0]{AFMT},apad,atrim=end=24.6[amain]" in fc(plan)


def test_cover_over_a_muted_or_silent_main_part_gets_a_silent_leg():
    spec = cover_spec()
    spec["audio"] = {"source_volume": 0, "tracks": []}
    graph = fc(cover_build(spec, CoverSource(COVER_IMAGE)))
    assert "anullsrc=r=48000:cl=stereo,atrim=end=20.6[amain]" in graph
    graph = fc(cover_build(cover_spec(), CoverSource(COVER_IMAGE), meta={**META, "has_audio": False}))
    assert "anullsrc=r=48000:cl=stereo,atrim=end=20.6[amain]" in graph


def test_cover_follows_an_audio_mix_and_extends_the_output_limit():
    spec = cover_spec()
    spec["audio"] = {"source_volume": 1, "tracks": [{"id": "au_1", "asset_id": "a_bgm00001", "t": "all", "loop": True}]}
    plan = cover_build(spec, CoverSource(COVER_IMAGE, 2.0), audio_assets=AUDIO_ASSETS)
    graph = fc(plan)
    assert f"[aout]{AFMT},apad,atrim=end=20.6[amain]" in graph
    # BGM timing is untouched: still relative to the main part.
    assert "atrim=end=20.6" in graph and "adelay" not in graph
    assert plan.argv[plan.argv.index("-t", plan.argv.index("-filter_complex")) + 1] == "22.6"


def test_unresolved_cover_renders_without_it_and_warns():
    plan = cover_build(cover_spec(), None)
    assert plan.argv == build().argv
    assert plan.warnings == ["封面素材 a_cover0001 不存在或未就绪，已跳过封面"]


def _probe_duration(path, stream):
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream,
         "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    return float(probe.stdout.strip())


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_image_cover_is_silent_and_precedes_the_trimmed_main_part(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=960x540:rate=30:duration=3",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    cover = tmp_path / "cover.jpg"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:size=720x1280", "-frames:v", "1", str(cover)],
        check=True, capture_output=True,
    )  # fmt: skip
    out = tmp_path / "out.mp4"
    spec = EditSpec.model_validate(cover_spec(duration=1.2, trim={"remove": [[1, 1.5]]}, layers=[]))
    plan = build_render_command(
        spec, {"duration": 3.0, "has_audio": True, "fps": 30}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out),
        cover=CoverSource(ImageSource(str(cover), 720, 1280), 1.2),
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    assert plan.expected_duration == pytest.approx(3.7)
    assert abs(_probe_duration(out, "v:0") - 3.7) < 0.15
    assert abs(_probe_duration(out, "a:0") - 3.7) < 0.15
    assert _mean_volume(out, 0.1, 0.9) < -60  # image cover: silence
    assert _mean_volume(out, 1.5, 1.5) > -30  # main part: the source beep
    # The picture really is the red cover first and the test pattern afterwards.
    r, g, b = _centre_pixel(out, 0.5)
    assert r > 180 and g < 60 and b < 60
    assert _centre_pixel(out, 2.5) != (r, g, b)


def _centre_pixel(path, at):
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1",
         "-vf", "crop=8:8:iw/2-4:ih/2-4,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True, timeout=60,
    )  # fmt: skip
    return tuple(proc.stdout[:3])


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_video_cover_keeps_its_sound_before_a_muted_untrimmed_source(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=25:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    cover = tmp_path / "cover.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=1.5",
         "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=1.5",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(cover)],
        check=True, capture_output=True,
    )  # fmt: skip
    out = tmp_path / "out.mp4"
    spec = cover_spec(asset_id="a_cover", trim={"remove": []}, layers=[])
    spec["outputs"] = [{"variant_key": "9x16", "aspect": "9:16", "fill": "color", "color": "#000000"}]
    spec["audio"] = {"source_volume": 0, "tracks": []}
    spec = EditSpec.model_validate(spec)
    plan = build_render_command(
        spec, {"duration": 2.0, "has_audio": True, "fps": 25}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out),
        cover=CoverSource(ImageSource(str(cover), 640, 360, duration=1.5, has_audio=True)),
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)

    assert plan.expected_duration == pytest.approx(3.5)
    assert abs(_probe_duration(out, "v:0") - 3.5) < 0.15
    assert abs(_probe_duration(out, "a:0") - 3.5) < 0.15
    assert _mean_volume(out, 0.1, 1.2) > -30  # the cover's own beep
    assert _mean_volume(out, 1.8, 1.5) < -60  # muted source


# --- align = source (separated stems, contract §2) -----------------------------------

STEM = AudioSource("/data/assets/a_stem0001.m4a", 24.6)


def test_source_aligned_track_is_cut_like_the_source_audio_then_windowed():
    """valid_spec removes [3.2,5.8] and [17,18.4]: three kept segments, concat, then the [4, 9] window."""
    track = {"id": "au_v", "asset_id": "a_stem0001", "role": "voice", "align": "source", "t": [4, 9], "volume": 0.8, "fade_out": 0.5}
    plan = audio_build(audio_spec(source_volume=0, tracks=[track]), audio_assets={"a_stem0001": STEM})
    graph, argv = fc(plan), plan.argv
    assert "[3:a]atrim=start=0:end=3.2,asetpts=PTS-STARTPTS[tk1s0]" in graph
    assert "[3:a]atrim=start=5.8:end=17,asetpts=PTS-STARTPTS[tk1s1]" in graph
    assert "[3:a]atrim=start=18.4:end=24.6,asetpts=PTS-STARTPTS[tk1s2]" in graph
    assert "[tk1s0][tk1s1][tk1s2]concat=n=3:v=0:a=1[tk1c]" in graph
    # Window on the post-trim result; the fade-out sits at the window end (E = 5).
    assert f"[tk1c]atrim=start=4:end=9,asetpts=PTS-STARTPTS,volume=0.8,afade=t=out:st=4.5:d=0.5,adelay=4000:all=1,{AFMT}[tk1]" in graph
    assert "-stream_loop" not in argv and "[abase][tk1]amix=inputs=2" in graph
    assert argv[argv.index("-t") + 1] == "20.6"


def test_source_aligned_track_over_an_untrimmed_source_needs_no_concat():
    track = {"id": "au_v", "asset_id": "a_stem0001", "align": "source", "t": "all"}
    plan = audio_build(audio_spec(source_volume=0, tracks=[track], trim={"remove": []}), audio_assets={"a_stem0001": STEM})
    graph = fc(plan)
    assert "concat=n=" not in graph.split("[tk1]")[0].rsplit(";", 2)[-1] or "[tk1s" not in graph
    assert f"[3:a]atrim=end=24.6,{AFMT}[tk1]" in graph


def test_source_aligned_track_with_a_single_kept_segment_skips_concat():
    track = {"id": "au_v", "asset_id": "a_stem0001", "align": "source", "t": "all"}
    plan = audio_build(audio_spec(source_volume=0, tracks=[track], trim={"remove": [[0, 4]]}), audio_assets={"a_stem0001": STEM})
    graph = fc(plan)
    assert "[3:a]atrim=start=4:end=24.6,asetpts=PTS-STARTPTS[tk1s0]" in graph
    assert "concat=n=1" not in graph
    assert f"[tk1s0]atrim=end=20.6,{AFMT}[tk1]" in graph


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_source_aligned_stem_follows_the_cut(tmp_path):
    """4 s source with a beep only in [2, 3]; the 'stem' is that same audio. Removing [0, 1.5]
    must shift the beep to [0.5, 1.5] of the output — i.e. the stem is cut like the source."""
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=4",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=4",
         "-af", "volume='if(between(t,2,3),1,0)':eval=frame",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    stem = tmp_path / "stem.m4a"
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vn", "-c:a", "aac", str(stem)], check=True, capture_output=True)

    out = tmp_path / "out.mp4"
    spec = valid_spec(trim={"remove": [[0, 1.5]]}, layers=[])
    spec["audio"] = {"source_volume": 0, "tracks": [{"id": "au_1", "asset_id": "a_stem", "align": "source", "t": "all"}]}
    spec = EditSpec.model_validate(spec)
    plan = build_render_command(
        spec, {"duration": 4.0, "has_audio": True}, {}, spec.outputs[0],
        source_path=str(src), output_path=str(out),
        audio_assets={"a_stem": AudioSource(str(stem), 4.0)},
    )  # fmt: skip
    subprocess.run(plan.argv, check=True, capture_output=True, timeout=180)
    assert abs(_probe_duration(out, "a:0") - 2.5) < 0.15
    assert _mean_volume(out, 0.0, 0.4) < -60  # before the (shifted) beep
    assert _mean_volume(out, 0.6, 0.8) > -30  # the beep now sits at [0.5, 1.5]
    assert _mean_volume(out, 1.7, 0.7) < -60  # after it



# --- mask layers (contract §2 type = "mask") ------------------------------------------------


def mask_layer(**extra):
    """Default contract mask: a full-width band 12% high, 10% above the bottom edge, shown 0–6 s."""
    return {"id": "l_m", "type": "mask", "anchor": "bottom-center", "margin": [0, 0.10], "width": 1.0,
            "height": 0.12, "rotate": 0, "opacity": 1, "t": [0, 6], **extra}


def mask_build(layers, **kw):
    return build(valid_spec(trim={"remove": []}, layers=layers), **kw)


def test_blur_mask_splits_crops_blurs_and_overlays_without_an_input():
    plan = mask_build([mask_layer()])
    graph = fc(plan)
    # 9:16 canvas: 1080 wide, 0.12·1920 = 230.4 → 230 high, y = 1920 − 230.4 − 192 = 1497.6 → 1498
    assert "[c0]split=2[m1s][m1b]" in graph
    assert "[m1b]format=rgba,crop=1080:230:0:1498,boxblur=lr=20:lp=2:enable='between(t,0,6)'[m1x]" in graph
    assert "[m1s][m1x]overlay=0:1498:enable='between(t,0,6)'[c1]" in graph
    assert graph.endswith("[c1]format=yuv420p[vout]")
    assert plan.argv.count("-i") == 1  # no media behind a mask
    assert "-t" not in plan.argv  # not a video layer: the still-image argv shape is kept
    assert plan.warnings == []


def test_blur_levels_and_opacity_and_all_window():
    graph = fc(mask_build([mask_layer(blur=1, t="all")]))
    assert "boxblur=lr=10:lp=1[m1x]" in graph and "enable" not in graph
    graph = fc(mask_build([mask_layer(blur=3, opacity=0.5, t="all")]))
    assert "boxblur=lr=40:lp=3,colorchannelmixer=aa=0.5[m1x]" in graph
    assert "[m1s][m1x]overlay=0:1498[c1]" in graph


def test_solid_mask_is_a_drawbox_with_the_alpha_from_opacity():
    graph = fc(mask_build([mask_layer(mode="solid", color="#112233", opacity=0.8, t="all")]))
    assert "[c0]drawbox=x=0:y=1498:w=1080:h=230:color=0x112233@0.8:t=fill[c1]" in graph
    assert "split" not in graph.split("[c0]", 1)[1] and "boxblur=lr" not in graph
    graph = fc(mask_build([mask_layer(mode="solid", color="#FF0000")]))
    assert "[c0]drawbox=x=0:y=1498:w=1080:h=230:color=0xFF0000:t=fill:enable='between(t,0,6)'[c1]" in graph


def test_mask_window_is_clamped_to_the_post_trim_duration():
    spec = valid_spec(layers=[mask_layer(t=[3, 30])])  # 20.6 s post-trim
    graph = fc(build(spec))
    assert "boxblur=lr=20:lp=2:enable='between(t,3,20.6)'[m1x]" in graph
    assert "overlay=0:1498:enable='between(t,3,20.6)'[c1]" in graph


def test_mask_between_sticker_and_text_keeps_the_canvas_numbering():
    spec = valid_spec()
    spec["layers"] = [spec["layers"][0], mask_layer(), spec["layers"][1]]
    plan = build(spec)
    graph = fc(plan)
    assert plan.argv.count("-i") == 3
    assert "[c0][l1]overlay=86:230:eof_action=repeat:enable='between(t,0,6)'[c1]" in graph
    assert "[c1]split=2[m2s][m2b]" in graph
    assert "[m2s][m2x]overlay=0:1498:enable='between(t,0,6)'[c2]" in graph
    assert "[2:v]format=rgba,scale=540:130[l3]" in graph
    assert "[c2][l3]overlay=270:115:eof_action=repeat[c3]" in graph
    assert graph.endswith("[c3]format=yuv420p[vout]")


def test_mask_region_is_clamped_to_the_canvas():
    # top-left, pushed half off the left edge and a bit above the top: only the visible part is blurred
    graph = fc(mask_build([mask_layer(anchor="top-left", margin=[-0.5, -0.05], t="all")]))
    assert "crop=540:134:0:0,boxblur=lr=20:lp=2[m1x]" in graph
    assert "[m1s][m1x]overlay=0:0[c1]" in graph


def test_mask_off_canvas_is_skipped_without_consuming_a_canvas_label():
    spec = valid_spec(trim={"remove": []})
    spec["layers"] = [mask_layer(anchor="top-left", margin=[0, -0.2], height=0.1), spec["layers"][1]]
    plan = build(spec)
    graph = fc(plan)
    assert any("l_m" in w and "不在画布内" in w for w in plan.warnings)
    assert "split" not in graph.split("[c0]", 1)[1] and "boxblur=lr" not in graph
    assert "[c0][l1]overlay=270:115:eof_action=repeat[c1]" in graph  # the text still lands on [c1]
    assert graph.endswith("[c1]format=yuv420p[vout]")


def test_mask_blur_radius_shrinks_to_fit_a_small_region_or_skips_it():
    # 0.03·1080 = 32 wide, 0.01·1920 = 19 high → radius must be < 19 // 2 → 8
    graph = fc(mask_build([mask_layer(anchor="top-left", margin=[0, 0], width=0.03, height=0.01, t="all")]))
    assert "crop=32:19:0:0,boxblur=lr=8:lp=2[m1x]" in graph
    # 2×4 px: nothing left to blur → skipped with a warning; a solid box of that size is still drawn
    plan = mask_build([mask_layer(anchor="top-left", margin=[0, 0], width=0.002, height=0.002, t="all")])
    assert any("l_m" in w and "太小" in w for w in plan.warnings)
    assert fc(plan).endswith("[c0]format=yuv420p[vout]")
    plan = mask_build([mask_layer(anchor="top-left", margin=[0, 0], width=0.002, height=0.002, t="all", mode="solid")])
    assert plan.warnings == [] and "drawbox=x=0:y=0:w=2:h=4:color=0x000000:t=fill[c1]" in fc(plan)


def test_mask_ignores_rotate():
    plain = fc(mask_build([mask_layer(t="all")]))
    rotated = fc(mask_build([mask_layer(t="all", rotate=45)]))
    assert rotated == plain and "rotate=" not in rotated


def test_mask_override_height_and_width_apply_per_variant():
    spec = valid_spec(layers=[mask_layer(t="all")])
    spec["outputs"][1]["layer_overrides"]["l_m"] = {"height": 0.2, "width": 0.5}
    graph = fc(build(spec, variant_key="1x1"))
    # 1:1 canvas: w = 540, h = 216, x = 270, y = 1080 − 216 − 108 = 756
    assert "crop=540:216:270:756,boxblur=lr=20:lp=2[m1x]" in graph
    assert "[m1s][m1x]overlay=270:756[c1]" in graph
    mask = EditSpec.model_validate(spec).layers[0]
    geo = apply_overrides(mask, EditSpec.model_validate(spec).outputs[1])
    assert geo["height"] == 0.2 and geo["width"] == 0.5
    # a height override on a sticker is accepted by the schema but means nothing to the layout
    sticker_spec = valid_spec()
    sticker_spec["outputs"][1]["layer_overrides"]["l_1"]["height"] = 0.5
    parsed = EditSpec.model_validate(sticker_spec)
    assert "height" not in apply_overrides(parsed.layers[0], parsed.outputs[1])
    assert "scale=324:130[l1]" in fc(build(sticker_spec, variant_key="1x1"))


def test_mask_never_resolves_an_image(monkeypatch):
    import app.services.filtergraph as fg

    def boom(*_a, **_k):
        raise AssertionError("_resolve_layer_image must not be called for masks")

    monkeypatch.setattr(fg, "_resolve_layer_image", boom)
    plan = mask_build([mask_layer(), mask_layer(id="l_m2", mode="solid")], assets={})
    assert plan.warnings == [] and "[c2]format=yuv420p[vout]" in fc(plan)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_renders_blur_and_solid_masks(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=3",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    layers = [
        mask_layer(t=[0.5, 1.5]),  # timed blur band at the bottom
        mask_layer(id="l_m2", mode="solid", color="#112233", opacity=0.8, anchor="top-right",
                   margin=[0.03, 0.03], width=0.3, height=0.08, t="all"),
        # odd geometry + partly off-canvas + opacity: the crop / overlay must still be accepted
        mask_layer(id="l_m3", anchor="center-left", margin=[-0.1, 0.017], width=0.4, height=0.093, blur=3, opacity=0.6),
    ]
    spec = EditSpec.model_validate(valid_spec(trim={"remove": [[1, 2]]}, layers=layers))
    plan = build_render_command(
        spec,
        {"duration": 3.0, "has_audio": True},
        {},
        spec.outputs[0],
        source_path=str(src),
        output_path=str(tmp_path / "out.mp4"),
    )
    assert plan.warnings == []
    subprocess.run(plan.argv, check=True, capture_output=True)
    out = tmp_path / "out.mp4"
    assert out.stat().st_size > 0
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True,
    )  # fmt: skip
    if probe.returncode == 0:
        assert probe.stdout.strip() == "1080,1920"


# --- layer_fit = "video"（HIG-29）---------------------------------------------


def follow_spec(layers, target, **extra):
    spec = valid_spec(trim={"remove": []}, layers=layers)
    spec["outputs"] = [{"variant_key": "9x16", "aspect": "9:16", "fill": "blur"}, {"variant_key": "out", "layer_fit": "video", **target}]
    spec.update(extra)
    return spec


def test_layer_fit_defaults_to_canvas_and_keeps_existing_argv():
    parsed = EditSpec.model_validate(valid_spec())
    assert [o.layer_fit for o in parsed.outputs] == ["canvas", "canvas"]
    with pytest.raises(Exception):
        EditSpec.model_validate(follow_spec([], {"aspect": "1:1", "layer_fit": "nope"}))


def test_follow_video_maps_mask_and_text_onto_1x1_blur():
    layers = [mask_layer(t="all", mode="solid", width=0.9, height=0.08), valid_spec()["layers"][1]]
    plan = build(follow_spec(layers, {"aspect": "1:1", "fill": "blur"}), variant_key="out")
    graph = fc(plan)
    # 9:16 box (54, 1574.4, 972, 153.6) × 0.5625 + x offset 236.25 → (266.6, 885.6, 546.75, 86.4)
    assert "drawbox=x=267:y=886:w=547:h=86" in graph
    # text 540·0.5 = 540 wide on 9:16 → 303.75 → 304; top-center y = 0.06·1920·0.5625 = 64.8
    assert "scale=304:73[l2]" in graph
    assert "overlay=388:65" in graph
    assert plan.warnings == []


def test_follow_video_mask_cropped_out_of_16x9_is_skipped_quietly():
    plan = build(follow_spec([mask_layer(t="all")], {"aspect": "16:9", "fill": "crop"}), variant_key="out")
    assert "drawbox" not in fc(plan) and "[m1s]" not in fc(plan)
    assert plan.warnings == []


def test_geometry_override_detaches_a_layer_but_rotate_does_not():
    layers = [mask_layer(t="all", mode="solid", width=0.9, height=0.08)]
    spec = follow_spec(layers, {"aspect": "1:1", "fill": "blur", "layer_overrides": {"l_m": {"opacity": 0.5}}})
    assert "drawbox=x=267:y=886:w=547:h=86" in fc(build(spec, variant_key="out"))
    spec["outputs"][1]["layer_overrides"]["l_m"]["margin"] = [0, 0]
    # detached: canvas-relative on 1080×1080 → w 972, h 86.4, bottom edge
    assert "drawbox=x=54:y=994:w=972:h=86" in fc(build(spec, variant_key="out"))


def test_follow_video_needs_the_source_size():
    layers = [mask_layer(t="all", mode="solid", width=0.9, height=0.08)]
    spec = follow_spec(layers, {"aspect": "1:1", "fill": "blur"})
    graph = fc(build(spec, meta={"duration": 24.6, "has_audio": True}, variant_key="out"))
    assert "drawbox=x=54:y=886:w=972:h=86" in graph  # canvas-relative fallback


def test_follow_video_ignored_on_the_reference_output():
    layers = [mask_layer(t="all", mode="solid", width=0.9, height=0.08)]
    spec = follow_spec(layers, {"aspect": "1:1", "fill": "blur"})
    spec["outputs"][0]["layer_fit"] = "video"
    assert "drawbox=x=54:y=1574:w=972:h=154" in fc(build(spec, variant_key="9x16"))


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_follow_video_puts_the_mask_on_the_mapped_pixels(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:size=540x960:rate=30:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True,
    )  # fmt: skip
    layers = [mask_layer(t="all", mode="solid", color="#FF0000", anchor="center", margin=[0.2, 0.02], width=0.3, height=0.1)]
    for target, canvas in (({"aspect": "1:1", "fill": "blur"}, (1080, 1080)), ({"aspect": "16:9", "fill": "crop"}, (1920, 1080))):
        spec = EditSpec.model_validate(follow_spec(layers, target))
        variant = spec.outputs[1]
        out = tmp_path / f"out_{variant.aspect.replace(':', 'x')}.mp4"
        plan = build_render_command(
            spec, {"duration": 1.0, "has_audio": False, "width": 540, "height": 960}, {}, variant,
            source_path=str(src), output_path=str(out),
        )  # fmt: skip
        subprocess.run(plan.argv, check=True, capture_output=True)
        from app.services.filtergraph import mask_layer_box, variant_fit_map

        box = mask_layer_box(spec, spec.layers[0], variant, variant_fit_map(spec, variant, 540, 960))
        cx, cy = round(box.cx), round(box.cy)
        assert 0 < cx < canvas[0] and 0 < cy < canvas[1]
        pixel = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(out), "-frames:v", "1", "-vf", f"format=rgb24,crop=1:1:{cx}:{cy}",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            check=True, capture_output=True,
        ).stdout  # fmt: skip
        r, g, b = pixel[0], pixel[1], pixel[2]
        assert r > 180 and g < 70 and b < 70, (variant.aspect, r, g, b)

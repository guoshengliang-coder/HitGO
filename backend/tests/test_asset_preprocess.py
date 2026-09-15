"""Video sticker probing and derived-file commands (contract §6, 素材预处理)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.services import asset_preprocess, ffprobe

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


# --- alpha detection (pure) -------------------------------------------------------


def test_alpha_from_prefers_the_decoded_frame_over_the_container():
    # HEVC-with-alpha reports yuv420p at container level and yuva420p once decoded.
    meta = {"codec": "hevc", "pix_fmt": "yuv420p", "alpha_mode": None}
    assert ffprobe.alpha_from(meta, "yuva420p") == (True, None)
    assert ffprobe.alpha_from(meta, "yuv420p") == (False, None)


def test_alpha_from_maps_vpx_alpha_mode_to_a_forced_decoder():
    # VP8/VP9 keep alpha in a side channel; the default decoder drops it silently.
    assert ffprobe.alpha_from({"codec": "vp9", "alpha_mode": "1"}, "yuv420p") == (
        True,
        "libvpx-vp9",
    )
    assert ffprobe.alpha_from({"codec": "vp8", "alpha_mode": "1"}, "yuv420p") == (True, "libvpx")
    # Wrong decoder is a hard failure, so never force one without the tag.
    assert ffprobe.alpha_from({"codec": "vp9", "alpha_mode": None}, "yuv420p") == (False, None)


def test_alpha_from_recognises_plain_alpha_pixel_formats():
    for fmt in ("rgba", "argb", "yuva444p12le"):
        assert ffprobe.alpha_from({"codec": "prores"}, fmt)[0] is True
    assert ffprobe.alpha_from({"codec": "h264"}, "yuv420p")[0] is False


# --- command builders (pure) ------------------------------------------------------


def test_preview_ext_follows_alpha():
    assert asset_preprocess.preview_ext(True) == "webm"
    assert asset_preprocess.preview_ext(False) == "mp4"


def test_preview_args_keep_alpha_and_carry_the_forced_decoder():
    argv = asset_preprocess.preview_args(
        Path("/data/assets/a.webm"), Path("/data/assets/a.preview.webm"), True, "libvpx-vp9"
    )
    assert argv[argv.index("-c:v") + 1] == "libvpx-vp9"  # input decoder, before -i
    assert argv.index("-c:v") < argv.index("-i")
    assert "yuva420p" in argv and argv[-1].endswith(".preview.webm")

    opaque = asset_preprocess.preview_args(
        Path("/data/assets/a.mp4"), Path("/data/assets/a.preview.mp4"), False
    )
    assert "libx264" in opaque and "yuv420p" in opaque and "libvpx-vp9" not in opaque


def test_poster_args_take_a_single_frame():
    argv = asset_preprocess.poster_args(Path("/data/assets/a.mov"), Path("/data/assets/a.poster.jpg"))
    assert argv[argv.index("-frames:v") + 1] == "1"
    assert "-an" in argv and argv[-1].endswith(".poster.jpg")


# --- integration (needs ffmpeg) ---------------------------------------------------


@needs_ffmpeg
def test_probe_layer_asset_detects_alpha_webm(tmp_path):
    src = tmp_path / "alpha.webm"
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
         "-vf", "format=rgba,scale=80:60,pad=160:120:40:30:color=0x00000000",
         "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "300k", str(src)],
        check=True, capture_output=True, timeout=180,
    )  # fmt: skip
    meta = ffprobe.probe_layer_asset(src)
    assert meta["has_alpha"] is True
    assert meta["decoder"] == "libvpx-vp9"
    assert meta["duration"] == pytest.approx(1.0, abs=0.2)


@needs_ffmpeg
def test_probe_layer_asset_reports_opaque_mp4(tmp_path):
    src = tmp_path / "opaque.mp4"
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True, timeout=180,
    )  # fmt: skip
    meta = ffprobe.probe_layer_asset(src)
    assert meta["has_alpha"] is False and meta["decoder"] is None


def test_preview_args_carry_the_first_audio_track_when_there_is_one():
    for has_alpha, audio_codec in ((True, "libopus"), (False, "aac")):
        argv = asset_preprocess.preview_args(Path("/a.mov"), Path("/a.preview"), has_alpha)
        assert "-an" not in argv
        # "?" keeps gif/webp and silent clips working: no audio stream, no error.
        assert ["-map", "0:v:0", "-map", "0:a:0?"] == argv[argv.index("-map") : argv.index("-map") + 4]
        assert argv[argv.index("-c:a") + 1] == audio_codec


@needs_ffmpeg
@pytest.mark.parametrize("has_alpha", [True, False])
def test_preview_keeps_audio_and_probe_reports_it(tmp_path, has_alpha):
    src = tmp_path / "vocal.mp4"
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True, timeout=180,
    )  # fmt: skip
    assert ffprobe.probe_layer_asset(src)["has_audio"] is True
    ext = asset_preprocess.preview_ext(has_alpha)
    preview = tmp_path / f"vocal.preview.{ext}"
    subprocess.run(
        asset_preprocess.preview_args(src, preview, has_alpha), check=True, capture_output=True, timeout=180
    )
    assert ffprobe.probe(preview)["has_audio"] is True


@needs_ffmpeg
def test_preview_of_a_silent_clip_still_succeeds(tmp_path):
    src = tmp_path / "silent.mp4"
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
        check=True, capture_output=True, timeout=180,
    )  # fmt: skip
    preview = tmp_path / "silent.preview.mp4"
    subprocess.run(asset_preprocess.preview_args(src, preview, False), check=True, capture_output=True, timeout=180)
    assert ffprobe.probe(preview)["has_audio"] is False

"""Video preprocess step 0 (contract §6, HIG-50): still / blank → source.mp4, run through real ffmpeg."""

from __future__ import annotations

import shutil
import subprocess

import pytest

from app.services import ffprobe, preprocess
from tests.conftest import make_png

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


@needs_ffmpeg
def test_blank_args_produce_a_clip_of_the_requested_size_and_duration(tmp_path):
    dst = tmp_path / "source.mp4"
    subprocess.run(preprocess.blank_args(dst, "#FF8800", 1.0, (64, 64)), check=True, capture_output=True, timeout=180)
    meta = ffprobe.probe(dst)
    assert (meta["width"], meta["height"]) == (64, 64) and meta["has_audio"] is False
    assert meta["duration"] == pytest.approx(1.0, abs=0.05)


@needs_ffmpeg
def test_still_args_loop_an_odd_sized_image_into_five_seconds(tmp_path):
    # 65×33: the scale filter must round down to even dimensions for yuv420p.
    still = make_png(tmp_path / "still.png", (65, 33))
    dst = tmp_path / "source.mp4"
    subprocess.run(preprocess.still_args(still, dst), check=True, capture_output=True, timeout=180)
    meta = ffprobe.probe(dst)
    assert (meta["width"], meta["height"]) == (64, 32)
    assert meta["duration"] == pytest.approx(5.0, abs=0.05)


@needs_ffmpeg
def test_run_preprocess_generates_the_source_first(tmp_path):
    source = tmp_path / "source.mp4"
    meta = preprocess.run_preprocess(
        source=source,
        proxy=tmp_path / "proxy.mp4",
        sprite=tmp_path / "sprite.jpg",
        poster=tmp_path / "poster.jpg",
        sprite_url="/media/x/sprite.jpg",
        source_gen=preprocess.blank_args(source, "#000000", 1.0, (64, 64)),
    )
    assert source.is_file() and (tmp_path / "proxy.mp4").is_file() and (tmp_path / "poster.jpg").is_file()
    assert meta["duration"] == pytest.approx(1.0, abs=0.05) and meta["sprite"]["count"] == 1


def test_run_preprocess_reports_a_failed_source_generation(tmp_path):
    with pytest.raises(preprocess.PreprocessError, match="生成源片"):
        preprocess.run_preprocess(
            source=tmp_path / "source.mp4",
            proxy=tmp_path / "proxy.mp4",
            sprite=tmp_path / "sprite.jpg",
            poster=tmp_path / "poster.jpg",
            sprite_url="/media/x/sprite.jpg",
            source_gen=[FFMPEG or "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(tmp_path / "missing.png")],
        )

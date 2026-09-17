"""Preprocessing (contract §6): [step 0: generate source.mp4] → probe → proxy.mp4 + sprite.jpg + poster.jpg.

Command builders are pure (unit-testable without ffmpeg); ``run_preprocess``
executes them and returns the metadata to store on the Video row.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image

from app.config import settings
from app.services import ffprobe
from app.services.filtergraph import ffmpeg_color

SPRITE_COLUMNS = 10
SPRITE_INTERVAL = 1.0  # seconds per tile (fps=1)
SPRITE_TILE_SHORT_SIDE = 90  # vertical: width 90 (→ 90×160 for 9:16); horizontal: width 160

PROXY_SCALE = "scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)'"

# Step 0 sources (contract §6, HIG-50): a still image or a blank clip becomes a real
# source.mp4 first, so the rest of the pipeline (and the renderer) never special-cases them.
STILL_SECONDS = 5.0
SOURCE_FPS = 30
# libx264 yuv420p needs even dimensions; uploaded stills can be anything.
STILL_SCALE = "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"


class PreprocessError(RuntimeError):
    pass


def _bin() -> str:
    return settings.ffmpeg_bin


def proxy_args(src: Path, dst: Path) -> list[str]:
    return [
        _bin(), "-hide_banner", "-y", "-nostats", "-loglevel", "error",
        "-i", str(src),
        "-vf", PROXY_SCALE,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        str(dst),
    ]  # fmt: skip


def still_args(src: Path, dst: Path, seconds: float = STILL_SECONDS, fps: int = SOURCE_FPS) -> list[str]:
    """Loop one image into a silent H.264 clip of ``seconds`` at native resolution."""
    return [
        _bin(), "-hide_banner", "-y", "-nostats", "-loglevel", "error",
        "-loop", "1", "-framerate", str(fps), "-t", f"{seconds:g}",
        "-i", str(src),
        "-vf", STILL_SCALE,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart",
        str(dst),
    ]  # fmt: skip


def blank_args(
    dst: Path, color: str, duration: float, size: tuple[int, int], fps: int = SOURCE_FPS
) -> list[str]:
    """Solid-colour silent H.264 clip from lavfi (``color`` is '#RRGGBB')."""
    w, h = size
    return [
        _bin(), "-hide_banner", "-y", "-nostats", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c={ffmpeg_color(color)}:s={w}x{h}:r={fps}:d={duration:g}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(dst),
    ]  # fmt: skip


def sprite_rows(duration: float) -> int:
    return max(1, math.ceil(duration / SPRITE_COLUMNS))


def sprite_count(duration: float, interval: float = SPRITE_INTERVAL) -> int:
    return max(1, math.ceil(duration / interval))


def sprite_args(src: Path, dst: Path, duration: float, horizontal: bool) -> list[str]:
    rows = sprite_rows(duration)
    # 9:16 sources get 90-wide tiles (90×160); horizontal ones 160-wide (160×90).
    tile_width = 160 if horizontal else SPRITE_TILE_SHORT_SIDE
    vf = f"fps=1,scale={tile_width}:-2,tile={SPRITE_COLUMNS}x{rows}"
    return [
        _bin(), "-hide_banner", "-y", "-nostats", "-loglevel", "error",
        "-i", str(src),
        "-an", "-vf", vf, "-frames:v", "1", "-q:v", "4",
        str(dst),
    ]  # fmt: skip


def poster_time(duration: float) -> float:
    return round(min(0.5, duration / 2), 3)


def poster_args(src: Path, dst: Path, duration: float) -> list[str]:
    return [
        _bin(), "-hide_banner", "-y", "-nostats", "-loglevel", "error",
        "-ss", f"{poster_time(duration):.3f}",
        "-i", str(src),
        "-an", "-frames:v", "1", "-q:v", "3",
        str(dst),
    ]  # fmt: skip


def _run(argv: list[str], what: str) -> None:
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=3600, check=False)
    except FileNotFoundError as exc:
        raise PreprocessError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise PreprocessError(f"{what}超时") from exc
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-10:])
        raise PreprocessError(f"{what}失败（exit {proc.returncode}）：{tail}")


def sprite_meta(sprite_file: Path, sprite_url: str, duration: float) -> dict[str, Any]:
    """Read the rendered sprite with Pillow and derive the tile size (contract §1 sprite)."""
    rows = sprite_rows(duration)
    with Image.open(sprite_file) as img:
        img_w, img_h = img.size
    return {
        "url": sprite_url,
        "interval": SPRITE_INTERVAL,
        "tile_width": img_w // SPRITE_COLUMNS,
        "tile_height": img_h // rows,
        "columns": SPRITE_COLUMNS,
        "count": sprite_count(duration),
    }


def run_preprocess(
    source: Path,
    proxy: Path,
    sprite: Path,
    poster: Path,
    sprite_url: str,
    source_gen: list[str] | None = None,
) -> dict[str, Any]:
    """Probe + generate derived files. Returns video metadata incl. the sprite dict.

    ``source_gen`` (``still_args`` / ``blank_args`` writing to ``source``) runs first for
    kind=image / kind=blank videos, which have no uploaded source.mp4 of their own.
    """
    if source_gen is not None:
        # A blank clip has no upload that created its video dir; ffmpeg won't create it either.
        source.parent.mkdir(parents=True, exist_ok=True)
        _run(source_gen, "生成源片")
    try:
        meta = ffprobe.probe(source)
    except ffprobe.ProbeError as exc:
        raise PreprocessError(str(exc)) from exc

    duration = meta["duration"]
    horizontal = meta["width"] > meta["height"]

    _run(proxy_args(source, proxy), "生成代理视频")
    _run(sprite_args(source, sprite, duration, horizontal), "生成时间轴缩略图")
    _run(poster_args(source, poster, duration), "生成封面")

    meta["sprite"] = sprite_meta(sprite, sprite_url, duration)
    return meta

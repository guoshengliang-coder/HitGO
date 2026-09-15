"""Video sticker preprocessing (contract §6, "素材预处理").

Probe the uploaded file, then derive the two things the editor needs but the
renderer does not: a first-frame poster and a browser-playable preview proxy.
Rendering always uses the original file — the proxy only exists because ProRes /
QuickTime RLE MOVs cannot be played by any browser.

Command builders are pure so they can be unit-tested without ffmpeg;
``run_asset_preprocess`` executes them.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import ffprobe

# Preview proxies keep alpha when the source has it, so the editor shows the same
# transparency the render will produce.
PREVIEW_ALPHA_EXT = "webm"
PREVIEW_OPAQUE_EXT = "mp4"
PREVIEW_MAX_SHORT_SIDE = 480


class AssetPreprocessError(RuntimeError):
    pass


def _bin() -> str:
    return settings.ffmpeg_bin


def preview_ext(has_alpha: bool) -> str:
    return PREVIEW_ALPHA_EXT if has_alpha else PREVIEW_OPAQUE_EXT


def poster_args(src: Path, dst: Path, decoder: str | None = None) -> list[str]:
    """First frame as a JPEG (flattened onto white, so alpha stickers stay legible)."""
    argv = [_bin(), "-hide_banner", "-y", "-nostats", "-loglevel", "error"]
    if decoder:
        argv += ["-c:v", decoder]
    argv += [
        "-i", str(src),
        "-an", "-frames:v", "1", "-q:v", "3",
        "-vf", "scale='min(480,iw)':-2",
        str(dst),
    ]  # fmt: skip
    return argv


def preview_args(src: Path, dst: Path, has_alpha: bool, decoder: str | None = None) -> list[str]:
    """Browser-playable proxy: VP9/yuva420p keeps alpha, H.264 otherwise."""
    argv = [_bin(), "-hide_banner", "-y", "-nostats", "-loglevel", "error"]
    if decoder:
        argv += ["-c:v", decoder]
    argv += ["-i", str(src), "-an", "-vf", f"scale='min({PREVIEW_MAX_SHORT_SIDE},iw)':-2"]
    if has_alpha:
        argv += [
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
            "-b:v", "1M", "-auto-alt-ref", "0",
        ]  # fmt: skip
    else:
        argv += [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        ]  # fmt: skip
    argv.append(str(dst))
    return argv


def _run(argv: list[str], what: str) -> None:
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=900, check=False)
    except FileNotFoundError as exc:
        raise AssetPreprocessError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise AssetPreprocessError(f"{what}超时") from exc
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-10:])
        raise AssetPreprocessError(f"{what}失败（exit {proc.returncode}）：{tail}")


def run_asset_preprocess(source: Path, poster: Path, preview_for_ext) -> dict[str, Any]:
    """Probe + generate poster and preview. Returns the metadata for the Asset row.

    ``preview_for_ext(ext)`` maps the chosen preview extension to its destination path
    (the caller owns the storage layout).
    """
    try:
        meta = ffprobe.probe_layer_asset(source)
    except ffprobe.ProbeError as exc:
        raise AssetPreprocessError(str(exc)) from exc

    has_alpha = bool(meta.get("has_alpha"))
    decoder = meta.get("decoder")
    ext = preview_ext(has_alpha)
    preview = preview_for_ext(ext)

    _run(poster_args(source, poster, decoder), "生成素材封面")
    _run(preview_args(source, preview, has_alpha, decoder), "生成素材预览")

    meta["preview_ext"] = ext
    return meta

"""ffprobe wrapper.

``probe`` → {width, height, duration, fps, has_audio, codec, size} for source videos.
``probe_layer_asset`` additionally answers the two questions a sticker layer needs:
how long is it, and does it carry an alpha channel (see ALPHA_PIX_FMTS / alpha_from).
"""

from __future__ import annotations

import json
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

from app.config import settings


class ProbeError(RuntimeError):
    pass


def probe_args(path: str | Path, ffprobe_bin: str | None = None) -> list[str]:
    return [
        ffprobe_bin or settings.ffprobe_bin,
        "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        str(path),
    ]  # fmt: skip


def _parse_rate(value: str | None) -> float | None:
    if not value or value in ("0/0", "N/A"):
        return None
    try:
        return round(float(Fraction(value)), 3)
    except (ValueError, ZeroDivisionError):
        return None


def _rotation(stream: dict[str, Any]) -> int:
    """Rotation metadata in degrees (0/90/180/270) from tags or side data."""
    raw: Any = (stream.get("tags") or {}).get("rotate")
    if raw is None:
        for sd in stream.get("side_data_list") or []:
            if "rotation" in sd:
                raw = sd["rotation"]
                break
    try:
        return int(round(float(raw))) % 360 if raw is not None else 0
    except (TypeError, ValueError):
        return 0


def parse_probe(raw: dict[str, Any]) -> dict[str, Any]:
    """Turn ffprobe JSON into the flat dict the rest of the app uses."""
    streams = raw.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise ProbeError("文件里没有视频流")

    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    if _rotation(video) in (90, 270):
        width, height = height, width

    fmt = raw.get("format") or {}
    duration = None
    for candidate in (video.get("duration"), fmt.get("duration")):
        try:
            if candidate is not None:
                duration = float(candidate)
                break
        except (TypeError, ValueError):
            continue
    if not duration or duration <= 0:
        raise ProbeError("无法读取视频时长")

    fps = _parse_rate(video.get("avg_frame_rate")) or _parse_rate(video.get("r_frame_rate"))
    try:
        size = int(fmt.get("size") or 0)
    except (TypeError, ValueError):
        size = 0

    try:
        nb_frames = int(video.get("nb_frames") or 0)
    except (TypeError, ValueError):
        nb_frames = 0

    return {
        "width": width,
        "height": height,
        "duration": round(duration, 3),
        "fps": fps,
        "has_audio": audio is not None,
        "codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name") if audio else None,
        "size": size,
        "pix_fmt": video.get("pix_fmt"),
        "nb_frames": nb_frames,
        "alpha_mode": (video.get("tags") or {}).get("alpha_mode"),
    }


def probe(path: str | Path) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            probe_args(path), capture_output=True, text=True, timeout=120, check=False
        )
    except FileNotFoundError as exc:
        raise ProbeError(f"找不到 ffprobe 可执行文件：{settings.ffprobe_bin}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProbeError("ffprobe 超时") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-5:]
        raise ProbeError("ffprobe 失败：" + (" | ".join(tail) or f"exit {proc.returncode}"))
    try:
        raw = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ProbeError("ffprobe 输出无法解析") from exc
    return parse_probe(raw)


# ---------------------------------------------------------------------------
# layer assets (video stickers)
# ---------------------------------------------------------------------------

# Pixel formats whose ffprobe -show_pixel_formats entry has flags.alpha = 1.
ALPHA_PIX_FMTS: frozenset[str] = frozenset(
    {
        "pal8", "argb", "rgba", "abgr", "bgra", "ya8", "ya16be", "ya16le",
        "gbrap", "gbrap10be", "gbrap10le", "gbrap12be", "gbrap12le",
        "gbrap14be", "gbrap14le", "gbrap16be", "gbrap16le", "gbrapf16be",
        "gbrapf16le", "gbrapf32be", "gbrapf32le",
        "rgba64be", "rgba64le", "bgra64be", "bgra64le",
        "yuva420p", "yuva422p", "yuva444p",
        "yuva420p9be", "yuva420p9le", "yuva422p9be", "yuva422p9le",
        "yuva444p9be", "yuva444p9le",
        "yuva420p10be", "yuva420p10le", "yuva422p10be", "yuva422p10le",
        "yuva444p10be", "yuva444p10le",
        "yuva420p12be", "yuva420p12le", "yuva422p12be", "yuva422p12le",
        "yuva444p12be", "yuva444p12le",
        "yuva420p16be", "yuva420p16le", "yuva422p16be", "yuva422p16le",
        "yuva444p16be", "yuva444p16le",
        "ayuv", "ayuv64be", "ayuv64le", "vuya", "uyva", "rgbaf16be", "rgbaf16le",
        "rgbaf32be", "rgbaf32le", "vuyx",
    }
)

# Extensions that always go through the video-sticker path.
VIDEO_STICKER_EXTS: frozenset[str] = frozenset({"mp4", "mov", "webm"})
# Image containers that *may* hold several frames; decided by nb_frames at probe time.
ANIMATABLE_IMAGE_EXTS: frozenset[str] = frozenset({"gif", "webp"})

# VP8/VP9 in WebM keep alpha in a side channel: the default decoder drops it
# silently (transparent areas render as opaque black), so the input must force
# libvpx*. Picking the wrong one is a hard failure ("Bitstream not supported").
_VPX_DECODERS = {"vp8": "libvpx", "vp9": "libvpx-vp9"}


def first_frame_pix_fmt_args(path: str | Path, ffprobe_bin: str | None = None) -> list[str]:
    """argv reading the pix_fmt of the *decoded* first frame (container-level one lies)."""
    return [
        ffprobe_bin or settings.ffprobe_bin,
        "-v", "error",
        "-select_streams", "v:0",
        "-read_intervals", "%+#1",
        "-show_entries", "frame=pix_fmt",
        "-print_format", "json",
        str(path),
    ]  # fmt: skip


def _first_frame_pix_fmt(path: str | Path) -> str | None:
    try:
        proc = subprocess.run(
            first_frame_pix_fmt_args(path), capture_output=True, text=True, timeout=120, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        frames = (json.loads(proc.stdout or "{}") or {}).get("frames") or []
    except json.JSONDecodeError:
        return None
    return frames[0].get("pix_fmt") if frames else None


def alpha_from(meta: dict[str, Any], frame_pix_fmt: str | None) -> tuple[bool, str | None]:
    """(has_alpha, forced_decoder) from probe metadata plus the decoded first frame.

    Two steps, because the container-level pix_fmt is not enough: both HEVC-with-alpha
    and VP9-with-alpha report ``yuv420p`` there.
    """
    codec = (meta.get("codec") or "").lower()
    if codec in _VPX_DECODERS and str(meta.get("alpha_mode") or "") == "1":
        return True, _VPX_DECODERS[codec]
    for candidate in (frame_pix_fmt, meta.get("pix_fmt")):
        if candidate and candidate in ALPHA_PIX_FMTS:
            return True, None
    return False, None


def probe_layer_asset(path: str | Path) -> dict[str, Any]:
    """Probe a sticker asset: regular metadata plus has_alpha / decoder / is_video."""
    meta = probe(path)
    has_alpha, decoder = alpha_from(meta, _first_frame_pix_fmt(path))
    meta["has_alpha"] = has_alpha
    meta["decoder"] = decoder
    return meta

"""ffprobe wrapper: file → {width, height, duration, fps, has_audio, codec, size}."""

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

    return {
        "width": width,
        "height": height,
        "duration": round(duration, 3),
        "fps": fps,
        "has_audio": audio is not None,
        "codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name") if audio else None,
        "size": size,
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

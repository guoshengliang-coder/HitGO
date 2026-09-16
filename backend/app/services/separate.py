"""Vocals / instrumental separation of a video's audio track (contract §1 / §6).

Runs inside the ``separator`` worker only — the one container built from
``Dockerfile.separator`` with torch + Demucs. Everything that touches torch is imported
lazily inside ``separate_stems`` so the API / render worker images never need it, and the
pure helpers (argv builders, stem bookkeeping) stay unit-testable without ffmpeg or torch.

Pipeline (``run_separation``):
    source.mp4 → ffmpeg → 44.1 kHz stereo float PCM in memory
               → Demucs (CPU): drums / bass / other / vocals
               → vocals, instrumental (= drums + bass + other)
               → ffmpeg → {asset_id}.m4a (aac 192k) × 2 → Asset rows (source = derived)
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app import ids
from app.config import settings
from app.db import iso, utcnow
from app.models import (
    ASSET_AUDIO,
    ASSET_READY,
    ASSET_SOURCE_DERIVED,
    SEP_DONE,
    SEP_FAILED,
    SEP_RUNNING,
    Asset,
    Video,
)
from app.services import storage

log = logging.getLogger(__name__)

SAMPLE_RATE = 44100
CHANNELS = 2
STEM_EXT = "m4a"
STEM_BITRATE = "192k"
MODELS: tuple[str, ...] = ("htdemucs", "htdemucs_ft")
STEMS: tuple[str, ...] = ("vocals", "instrumental")


class SeparationError(RuntimeError):
    pass


@dataclass(frozen=True)
class StemFiles:
    """Where the two stems were written; keyed like ``Video.separation``."""

    vocals: Path
    instrumental: Path


# ---------------------------------------------------------------------------
# pure helpers
# ---------------------------------------------------------------------------


def decode_args(src: Path, ffmpeg_bin: str | None = None) -> list[str]:
    """Source audio → raw float32 stereo PCM on stdout (what the model wants)."""
    return [
        ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", str(src),
        "-vn", "-map", "0:a:0",
        "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE),
        "-f", "f32le", "-",
    ]  # fmt: skip


def encode_args(dst: Path, ffmpeg_bin: str | None = None) -> list[str]:
    """Raw float32 stereo PCM on stdin → browser-playable AAC stem."""
    return [
        ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "-i", "-",
        "-c:a", "aac", "-b:a", STEM_BITRATE, "-movflags", "+faststart",
        str(dst),
    ]  # fmt: skip


def stem_name(video_name: str, stem: str) -> str:
    """Asset name shown in the library: ``V01 新手引导A · 人声.m4a``."""
    base = Path(video_name).stem or video_name
    label = "人声" if stem == "vocals" else "伴奏"
    return f"{base} · {label}.{STEM_EXT}"


def instrumental_from(stems: dict[str, Any]) -> Any:
    """Everything that is not the vocals, summed (Demucs' own two-stems rule)."""
    parts = [v for k, v in stems.items() if k != "vocals"]
    if not parts:
        raise SeparationError("模型没有输出伴奏声部")
    total = parts[0]
    for part in parts[1:]:
        total = total + part
    return total


def previous_stem_asset_ids(separation: dict[str, Any] | None) -> list[str]:
    """Asset ids a re-run should replace (contract §1: the old pair is deleted)."""
    if not separation:
        return []
    return [
        str(separation[key])
        for key in ("vocals_asset_id", "instrumental_asset_id")
        if separation.get(key)
    ]


# ---------------------------------------------------------------------------
# the model
# ---------------------------------------------------------------------------


def _run(argv: list[str], what: str, **kw: Any) -> subprocess.CompletedProcess[bytes]:
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=1800, check=False, **kw)
    except FileNotFoundError as exc:
        raise SeparationError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise SeparationError(f"{what}超时") from exc
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-8:])
        raise SeparationError(f"{what}失败（exit {proc.returncode}）：{tail}")
    return proc


def separate_stems(source: Path, model: str, out: StemFiles) -> None:
    """Decode ``source``, run Demucs on the CPU and write both stems to ``out``.

    Imports torch / demucs here on purpose: only the separator image has them.
    """
    try:
        import numpy as np
        import torch
        from demucs.api import Separator
    except ImportError as exc:  # the API / render worker image
        raise SeparationError(
            "这个 worker 没有安装分离模型（需要 separator 镜像）"
        ) from exc

    pcm = _run(decode_args(source), "抽取源音轨").stdout
    if len(pcm) < 4 * CHANNELS * SAMPLE_RATE // 10:
        raise SeparationError("源音轨太短或为空")
    frames = np.frombuffer(pcm, dtype=np.float32).reshape(-1, CHANNELS).T.copy()
    seconds = frames.shape[1] / SAMPLE_RATE
    if seconds > settings.separate_max_seconds:
        raise SeparationError(
            f"源音轨 {seconds:.0f} 秒，超过分离上限 {settings.separate_max_seconds} 秒"
        )

    torch.set_num_threads(max(1, settings.separate_threads))
    separator = Separator(model=model, device="cpu", progress=False)
    _, stems = separator.separate_tensor(torch.from_numpy(frames), SAMPLE_RATE)
    if "vocals" not in stems:
        raise SeparationError("模型没有输出人声声部")
    vocals = stems["vocals"]
    instrumental = instrumental_from(stems)

    for tensor, dst in ((vocals, out.vocals), (instrumental, out.instrumental)):
        # Demucs returns (channels, samples) at the model's rate (44.1 kHz for htdemucs).
        data = tensor.detach().cpu().clamp(-1.0, 1.0).T.contiguous().numpy().astype(np.float32)
        _run(encode_args(dst), "写出分离音轨", input=data.tobytes())


# ---------------------------------------------------------------------------
# job lifecycle
# ---------------------------------------------------------------------------


def _set_state(db: Session, video: Video, **fields: Any) -> None:
    current = dict(video.separation or {})
    current.update(fields)
    current["updated_at"] = iso(utcnow())
    video.separation = current
    db.commit()


def run_separation(db: Session, video_id: str) -> None:
    """Full lifecycle: running → stems → assets → done; any exception → failed."""
    video = db.get(Video, video_id)
    if video is None or not video.separation:
        return  # deleted (or never requested) while queued
    model = str(video.separation.get("model") or MODELS[0])
    if model not in MODELS:
        model = MODELS[0]
    _set_state(db, video, status=SEP_RUNNING, error=None)

    vocals_id, instrumental_id = ids.asset_id(), ids.asset_id()
    out = StemFiles(
        vocals=storage.asset_path(vocals_id, STEM_EXT),
        instrumental=storage.asset_path(instrumental_id, STEM_EXT),
    )
    source = storage.source_path(video.batch_id, video.id, video.source_ext)
    try:
        if not video.has_audio:
            raise SeparationError("源视频没有音轨")
        if not source.is_file():
            raise SeparationError("源视频文件不存在")
        out.vocals.parent.mkdir(parents=True, exist_ok=True)
        separate_stems(source, model, out)
    except Exception as exc:  # noqa: BLE001 - any failure lands in separation.error
        log.exception("separation of %s failed", video_id)
        for path in (out.vocals, out.instrumental):
            storage.remove_file(path)
        _set_state(db, video, status=SEP_FAILED, error=str(exc)[:4000])
        return

    # Replace last time's pair (contract §1); tracks still pointing at them get a warning.
    old_ids = previous_stem_asset_ids(video.separation)
    for asset_id in old_ids:
        old = db.get(Asset, asset_id)
        if old is not None:
            storage.remove_file(storage.asset_path(old.id, old.ext))
            db.delete(old)

    for asset_id, stem in ((vocals_id, "vocals"), (instrumental_id, "instrumental")):
        db.add(
            Asset(
                id=asset_id,
                type=ASSET_AUDIO,
                kind=ASSET_AUDIO,
                status=ASSET_READY,
                name=stem_name(video.name, stem),
                ext=STEM_EXT,
                source=ASSET_SOURCE_DERIVED,
                duration=video.duration,
                has_audio=True,
                derived_from={"video_id": video.id, "video_name": video.name, "stem": stem},
            )
        )
    _set_state(
        db,
        video,
        status=SEP_DONE,
        error=None,
        model=model,
        vocals_asset_id=vocals_id,
        instrumental_asset_id=instrumental_id,
    )

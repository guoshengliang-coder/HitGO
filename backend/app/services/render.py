"""Execute one render job: build the ffmpeg command, stream progress, probe the result.

Runs inside the Celery worker (``app.worker.render_job``). Database writes are
throttled to at most once per second for progress updates.
"""

from __future__ import annotations

import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PIL import Image
from sqlalchemy.orm import Session

from app.config import settings
from app.db import utcnow
from app.models import (
    ASSET_AUDIO,
    ASSET_READY,
    ASSET_STICKER,
    ASSET_VIDEO,
    JOB_DONE,
    JOB_FAILED,
    JOB_RUNNING,
    Asset,
    Batch,
    Job,
    Video,
)
from app.schemas import EditSpec
from app.services import ffprobe, storage
from app.services.filtergraph import (
    AudioSource,
    CoverSource,
    ImageSource,
    RenderPlan,
    build_render_command,
)

STDERR_TAIL_LINES = 40
PROGRESS_MIN_INTERVAL = 1.0  # seconds between DB writes


class RenderError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# progress parsing
# ---------------------------------------------------------------------------


def parse_progress_line(line: str) -> float | None:
    """'out_time_us=1234567' → seconds; None for any other line (or N/A)."""
    line = line.strip()
    for key in ("out_time_us=", "out_time_ms="):
        if line.startswith(key):
            value = line[len(key) :].strip()
            if not value or value == "N/A":
                return None
            try:
                return int(value) / 1_000_000
            except ValueError:
                return None
    return None


def percent_for(out_time: float, expected_duration: float) -> int:
    if expected_duration <= 0:
        return 0
    return max(0, min(99, int(out_time / expected_duration * 100)))


# ---------------------------------------------------------------------------
# ffmpeg execution
# ---------------------------------------------------------------------------


def run_ffmpeg(
    argv: list[str],
    expected_duration: float,
    on_progress: Callable[[int], None],
    *,
    min_interval: float = PROGRESS_MIN_INTERVAL,
) -> None:
    """Run ffmpeg with ``-progress pipe:1``; call on_progress(percent) at most once per second."""
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as exc:
        raise RenderError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc

    stderr_tail: deque[str] = deque(maxlen=STDERR_TAIL_LINES)

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_tail.append(line.rstrip("\n"))

    reader = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()

    last_write = 0.0
    last_percent = -1
    assert proc.stdout is not None
    for line in proc.stdout:
        out_time = parse_progress_line(line)
        if out_time is None:
            continue
        percent = percent_for(out_time, expected_duration)
        now = time.monotonic()
        if percent != last_percent and now - last_write >= min_interval:
            on_progress(percent)
            last_write, last_percent = now, percent

    proc.wait()
    reader.join(timeout=5)
    if proc.returncode != 0:
        tail = "\n".join(stderr_tail)
        raise RenderError(f"ffmpeg 退出码 {proc.returncode}\n{tail}")


# ---------------------------------------------------------------------------
# job orchestration
# ---------------------------------------------------------------------------


def _image_from_file(path: Path, width: int | None = None, height: int | None = None) -> ImageSource | None:
    if not path.is_file():
        return None
    if width and height:
        return ImageSource(str(path), width, height)
    try:
        with Image.open(path) as img:
            w, h = img.size
    except Exception:  # noqa: BLE001 - unreadable image counts as missing
        return None
    return ImageSource(str(path), w, h)


def collect_assets(db: Session, spec: EditSpec) -> dict[str, ImageSource]:
    ids = {layer.asset_id for layer in spec.layers if layer.type == "sticker"}
    if not ids:
        return {}
    return collect_assets_by_id(db, db.query(Asset).filter(Asset.id.in_(ids)).all())


def collect_assets_by_id(db: Session, assets: list[Asset]) -> dict[str, ImageSource]:
    """Resolve sticker assets to renderable media; unready videos and missing files are left out."""
    result: dict[str, ImageSource] = {}
    for asset in assets:
        path = storage.asset_path(asset.id, asset.ext)
        if asset.kind == ASSET_VIDEO:
            # Still preparing (or failed): leave it out, the graph builder warns and skips.
            if asset.status != ASSET_READY or not asset.width or not asset.height:
                continue
            if not path.is_file():
                continue
            result[asset.id] = ImageSource(
                str(path),
                asset.width,
                asset.height,
                duration=asset.duration or 0.0,
                decoder=asset.decoder,
                has_alpha=bool(asset.has_alpha),
                has_audio=bool(asset.has_audio),
            )
            continue
        image = _image_from_file(path, asset.width, asset.height)
        if image is not None:
            result[asset.id] = image
    return result


def collect_cover(db: Session, spec: EditSpec) -> CoverSource | None:
    """The ready sticker asset behind ``spec.cover``; None lets the builder warn and skip it."""
    if spec.cover is None:
        return None
    asset = db.get(Asset, spec.cover.asset_id)
    if asset is None or asset.type != ASSET_STICKER:
        return None
    media = collect_assets_by_id(db, [asset]).get(asset.id)
    if media is None:
        return None
    return CoverSource(media, image_duration=spec.cover.duration)


def collect_audio(db: Session, spec: EditSpec) -> dict[str, AudioSource]:
    """Ready audio assets referenced by ``audio.tracks``; missing ones are warned about by the builder."""
    if spec.audio is None or not spec.audio.tracks:
        return {}
    ids = {track.asset_id for track in spec.audio.tracks}
    result: dict[str, AudioSource] = {}
    for asset in db.query(Asset).filter(Asset.id.in_(ids), Asset.type == ASSET_AUDIO).all():
        if asset.status != ASSET_READY or not asset.duration:
            continue
        path = storage.asset_path(asset.id, asset.ext)
        if not path.is_file():
            continue
        result[asset.id] = AudioSource(str(path), float(asset.duration), name=asset.name)
    return result


def resolve_image_url(url: str) -> ImageSource | None:
    path = storage.media_url_to_path(url)
    return _image_from_file(path) if path else None


def build_plan(db: Session, job: Job, video: Video) -> RenderPlan:
    spec = EditSpec.model_validate(video.edit_spec)
    variant = next((o for o in spec.outputs if o.variant_key == job.variant_key), None)
    if variant is None:
        raise RenderError(f"编辑参数中没有输出变体 {job.variant_key}")
    return build_render_command(
        spec,
        {
            "duration": video.duration,
            "has_audio": video.has_audio,
            "fps": video.fps,
            "width": video.width,
            "height": video.height,
        },
        collect_assets(db, spec),
        variant,
        source_path=str(storage.source_path(video.batch_id, video.id, video.source_ext)),
        output_path=str(storage.tmp_output_path(job.id)),
        resolve_image_url=resolve_image_url,
        ffmpeg_bin=settings.ffmpeg_bin,
        audio_assets=collect_audio(db, spec),
        cover=collect_cover(db, spec),
    )


def build_callback(job: Job, video: Video, batch: Batch, output: dict[str, Any]) -> dict[str, Any]:
    """Contract §4 callback JSON (displayed only; never actually sent)."""
    return {
        "session_id": batch.id,
        "source_id": video.id,
        "variant_key": job.variant_key,
        "status": "done",
        "output": {
            "url": settings.public_base_url + storage.media_url(storage.output_path(job.id)),
            "duration": output["duration"],
            "width": output["width"],
            "height": output["height"],
            "size": output["size"],
            "codec": output["codec"],
        },
        "edit_spec": video.edit_spec,
        "operator": {"id": "demo", "name": "演示用户"},
        "idempotency_key": f"{batch.id}:{video.id}:{job.variant_key}:{job.attempt}",
    }


def render_job(db: Session, job_id: str) -> None:
    """Full lifecycle of a job. Any exception is recorded as status=failed."""
    job = db.get(Job, job_id)
    if job is None:
        return  # deleted while queued
    video = db.get(Video, job.video_id)
    batch = db.get(Batch, job.batch_id)
    if video is None or batch is None:
        job.status, job.error, job.finished_at = JOB_FAILED, "视频或批次已被删除", utcnow()
        db.commit()
        return

    job.status = JOB_RUNNING
    job.progress = 0
    job.error = None
    job.started_at = utcnow()
    job.finished_at = None
    db.commit()

    tmp_out = storage.tmp_output_path(job.id)
    try:
        if video.status != "ready" or not video.edit_spec or not video.duration:
            raise RenderError("视频尚未就绪或没有编辑参数")
        plan = build_plan(db, job, video)
        tmp_out.parent.mkdir(parents=True, exist_ok=True)

        def on_progress(percent: int) -> None:
            job.progress = percent
            db.commit()

        run_ffmpeg(plan.argv, plan.expected_duration, on_progress)

        meta = ffprobe.probe(tmp_out)
        final = storage.output_path(job.id)
        storage.move_atomic(tmp_out, final)
        codec = "h264/aac" if meta.get("has_audio") else "h264"
        output = {
            "width": meta["width"],
            "height": meta["height"],
            "duration": meta["duration"],
            "size": storage.file_size(final),
            "codec": codec,
        }
        if plan.audio is not None:
            output["audio"] = plan.audio
        job.output = output
        job.callback = build_callback(job, video, batch, output)
        job.progress = 100
        job.status = JOB_DONE
        job.error = "警告：" + "；".join(plan.warnings) if plan.warnings else None
        job.finished_at = utcnow()
        db.commit()
    except Exception as exc:  # noqa: BLE001 - every failure must land in the DB
        storage.remove_file(tmp_out)
        db.rollback()
        job = db.get(Job, job_id)
        if job is not None:
            job.status = JOB_FAILED
            job.error = str(exc)[:4000]
            job.finished_at = utcnow()
            db.commit()
        raise RenderError(str(exc)) from exc

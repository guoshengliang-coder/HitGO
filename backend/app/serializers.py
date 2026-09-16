"""ORM rows → contract §1 response dicts (Batch / Video / Asset / Job).

``render_status`` and ``status_counts`` are derived from the latest job per
(video, variant_key); callers pass the relevant Job rows so list endpoints can
load everything with a couple of queries.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable

from app.db import iso
from app.models import (
    ASSET_AUDIO,
    ASSET_READY,
    ASSET_VIDEO,
    JOB_DONE,
    JOB_FAILED,
    JOB_QUEUED,
    JOB_RUNNING,
    VIDEO_FAILED,
    VIDEO_PREPARING,
    VIDEO_READY,
    Asset,
    Batch,
    Job,
    Video,
)
from app.schemas import (
    AssetOut,
    BatchDetailOut,
    BatchOut,
    JobOut,
    LocalizationOut,
    SeparationOut,
    StatusCounts,
    VideoOut,
)
from app.services import storage

RENDER_IDLE = "idle"


def latest_jobs_by_variant(jobs: Iterable[Job]) -> dict[str, Job]:
    latest: dict[str, Job] = {}
    for job in jobs:
        current = latest.get(job.variant_key)
        if current is None or (job.created_at, job.id) > (current.created_at, current.id):
            latest[job.variant_key] = job
    return latest


def render_status(jobs: Iterable[Job]) -> str:
    """failed > running > queued > done (all) > idle, over the latest job per variant."""
    latest = list(latest_jobs_by_variant(jobs).values())
    if not latest:
        return RENDER_IDLE
    statuses = {j.status for j in latest}
    if JOB_FAILED in statuses:
        return JOB_FAILED
    if JOB_RUNNING in statuses:
        return JOB_RUNNING
    if JOB_QUEUED in statuses:
        return JOB_QUEUED
    if statuses == {JOB_DONE}:
        return JOB_DONE
    return RENDER_IDLE


def video_out(video: Video, jobs: Iterable[Job] = ()) -> VideoOut:
    batch_id, vid = video.batch_id, video.id
    ready = video.status == VIDEO_READY
    return VideoOut(
        id=vid,
        batch_id=batch_id,
        name=video.name,
        order=video.order_index,
        status=video.status,
        error=video.error,
        width=video.width,
        height=video.height,
        duration=video.duration,
        fps=video.fps,
        has_audio=bool(video.has_audio),
        source_url=storage.media_url(storage.source_path(batch_id, vid, video.source_ext)),
        proxy_url=storage.media_url(storage.proxy_path(batch_id, vid)) if ready else None,
        poster_url=storage.media_url(storage.poster_path(batch_id, vid)) if ready else None,
        sprite=video.sprite if ready else None,
        edit_spec=video.edit_spec,
        edited=video.edit_spec is not None,
        render_status=render_status(jobs),
        separation=SeparationOut(**video.separation) if video.separation else None,
        localization=LocalizationOut.model_validate(video.localization) if video.localization else None,
        updated_at=iso(video.updated_at) or "",
    )


def _video_bucket(video: Video, rs: str) -> str:
    """Which status_counts bucket a video falls into."""
    if video.status == VIDEO_PREPARING:
        return "preparing"
    if video.status == VIDEO_FAILED or rs == JOB_FAILED:
        return "failed"
    if rs in (JOB_QUEUED, JOB_RUNNING):
        return "rendering"
    if rs == JOB_DONE:
        return "done"
    if video.edit_spec is not None:
        return "edited"
    return "ready"


def group_jobs_by_video(jobs: Iterable[Job]) -> dict[str, list[Job]]:
    grouped: dict[str, list[Job]] = defaultdict(list)
    for job in jobs:
        grouped[job.video_id].append(job)
    return grouped


def batch_out(batch: Batch, videos: list[Video], jobs: Iterable[Job]) -> BatchOut:
    by_video = group_jobs_by_video(jobs)
    counts = StatusCounts()
    for video in videos:
        bucket = _video_bucket(video, render_status(by_video.get(video.id, ())))
        setattr(counts, bucket, getattr(counts, bucket) + 1)
    return BatchOut(
        id=batch.id,
        name=batch.name,
        created_at=iso(batch.created_at) or "",
        video_count=len(videos),
        status_counts=counts,
    )


def batch_detail_out(batch: Batch, videos: list[Video], jobs: Iterable[Job]) -> BatchDetailOut:
    jobs = list(jobs)
    by_video = group_jobs_by_video(jobs)
    base = batch_out(batch, videos, jobs)
    return BatchDetailOut(
        **base.model_dump(),
        videos=[video_out(v, by_video.get(v.id, ())) for v in videos],
    )


def asset_out(asset: Asset) -> AssetOut:
    is_video = asset.kind == ASSET_VIDEO
    is_audio = asset.kind == ASSET_AUDIO
    ready = asset.status == ASSET_READY
    return AssetOut(
        id=asset.id,
        type=asset.type,
        name=asset.name,
        url=storage.media_url(storage.asset_path(asset.id, asset.ext)),
        kind=asset.kind,
        status=asset.status,
        error=asset.error,
        width=asset.width,
        height=asset.height,
        duration=asset.duration if (is_video or is_audio) else None,
        fps=asset.fps if is_video else None,
        has_alpha=asset.has_alpha if is_video else None,
        has_audio=asset.has_audio if is_video else None,
        poster_url=(
            storage.versioned_media_url(storage.asset_poster_path(asset.id))
            if is_video and ready
            else None
        ),
        preview_url=(
            storage.versioned_media_url(storage.asset_preview_path(asset.id, asset.preview_ext))
            if is_video and ready and asset.preview_ext
            else None
        ),
        family=asset.family,
        source=asset.source,
        derived_from=asset.derived_from,
        created_at=iso(asset.created_at) or "",
    )


def job_out(job: Job, batch_name: str | None = None, video_name: str | None = None) -> JobOut:
    done = job.status == JOB_DONE
    return JobOut(
        id=job.id,
        batch_id=job.batch_id,
        video_id=job.video_id,
        variant_key=job.variant_key,
        status=job.status,
        progress=job.progress,
        error=job.error,
        output_url=storage.media_url(storage.output_path(job.id)) if done else None,
        output=job.output if done else None,
        callback=job.callback if done else None,
        created_at=iso(job.created_at) or "",
        started_at=iso(job.started_at),
        finished_at=iso(job.finished_at),
        batch_name=batch_name,
        video_name=video_name,
    )

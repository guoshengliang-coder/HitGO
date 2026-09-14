"""Helpers shared by routers: lookups that 404 with Chinese messages, job loading, enqueue→503."""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import worker
from app.models import Batch, Job, Video


def get_batch_or_404(db: Session, batch_id: str) -> Batch:
    batch = db.get(Batch, batch_id)
    if batch is None:
        raise HTTPException(404, "批次不存在")
    return batch


def get_video_or_404(db: Session, video_id: str) -> Video:
    video = db.get(Video, video_id)
    if video is None:
        raise HTTPException(404, "视频不存在")
    return video


def get_job_or_404(db: Session, job_id: str) -> Job:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "任务不存在")
    return job


def jobs_for_batch(db: Session, batch_id: str) -> list[Job]:
    return list(db.scalars(select(Job).where(Job.batch_id == batch_id)).all())


def jobs_for_videos(db: Session, video_ids: Iterable[str]) -> list[Job]:
    ids = list(video_ids)
    if not ids:
        return []
    return list(db.scalars(select(Job).where(Job.video_id.in_(ids))).all())


def videos_for_batch(db: Session, batch_id: str) -> list[Video]:
    stmt = select(Video).where(Video.batch_id == batch_id).order_by(Video.order_index, Video.created_at)
    return list(db.scalars(stmt).all())


def enqueue_or_503(task, *args) -> None:  # noqa: ANN001
    try:
        worker.enqueue(task, *args)
    except worker.QueueUnavailable as exc:
        raise HTTPException(503, f"任务队列不可用（Redis 未连接）：{exc}") from exc

"""Celery app + tasks (preprocess_video, preprocess_asset, render_job) and the API-side ``enqueue`` helper.

The API never blocks on Redis for long: publishing uses a short connection
timeout and a single retry, and failures are turned into ``QueueUnavailable``
which the routers map to HTTP 503.
"""

from __future__ import annotations

import logging

from celery import Celery
from kombu.exceptions import OperationalError

from app.config import settings
from app.db import SessionLocal, utcnow
from app.models import (
    ASSET_AUDIO,
    ASSET_FAILED,
    ASSET_READY,
    VIDEO_FAILED,
    VIDEO_READY,
    Asset,
    Job,
    Video,
)
from app.services import asset_preprocess, ffprobe, preprocess, render, storage

log = logging.getLogger(__name__)

celery_app = Celery("hitgo", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(
    task_always_eager=False,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    worker_concurrency=settings.worker_concurrency,
    task_ignore_result=True,
    broker_connection_timeout=2,
    broker_connection_retry_on_startup=True,
    task_publish_retry=True,
    task_publish_retry_policy={
        "max_retries": 1,
        "interval_start": 0,
        "interval_step": 0.2,
        "interval_max": 0.5,
    },
    task_track_started=False,
    timezone="UTC",
)


class QueueUnavailable(RuntimeError):
    """Raised when a task cannot be published (broker unreachable)."""


def enqueue(task, *args) -> None:  # noqa: ANN001
    """Publish a task; raise QueueUnavailable instead of leaking kombu errors."""
    try:
        task.apply_async(args=args)
    except (OperationalError, ConnectionError, OSError) as exc:
        log.warning("enqueue %s failed: %s", getattr(task, "name", task), exc)
        raise QueueUnavailable(str(exc)) from exc


# ---------------------------------------------------------------------------
# tasks
# ---------------------------------------------------------------------------


@celery_app.task(name="hitgo.preprocess_video", bind=True, max_retries=3)
def preprocess_video(self, video_id: str) -> None:  # noqa: ANN001
    db = SessionLocal()
    try:
        video = db.get(Video, video_id)
        if video is None:
            # Row not visible yet (published right after commit) or deleted.
            if self.request.retries < self.max_retries:
                raise self.retry(countdown=1)
            log.info("preprocess: video %s vanished", video_id)
            return
        batch_id = video.batch_id
        source = storage.source_path(batch_id, video.id, video.source_ext)
        sprite = storage.sprite_path(batch_id, video.id)
        try:
            meta = preprocess.run_preprocess(
                source=source,
                proxy=storage.proxy_path(batch_id, video.id),
                sprite=sprite,
                poster=storage.poster_path(batch_id, video.id),
                sprite_url=storage.media_url(sprite),
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("preprocess %s failed", video_id)
            video.status = VIDEO_FAILED
            video.error = str(exc)[:4000]
            video.updated_at = utcnow()
            db.commit()
            return

        video.width = meta["width"]
        video.height = meta["height"]
        video.duration = meta["duration"]
        video.fps = meta["fps"]
        video.has_audio = meta["has_audio"]
        video.codec = meta["codec"]
        video.sprite = meta["sprite"]
        video.status = VIDEO_READY
        video.error = None
        video.updated_at = utcnow()
        db.commit()
    finally:
        db.close()


@celery_app.task(name="hitgo.preprocess_asset", bind=True, max_retries=3)
def preprocess_asset(self, asset_id: str) -> None:  # noqa: ANN001
    """Probe a video sticker and build its poster + preview proxy (contract §6)."""
    db = SessionLocal()
    try:
        asset = db.get(Asset, asset_id)
        if asset is None:
            # Row not visible yet (published right after commit) or deleted.
            if self.request.retries < self.max_retries:
                raise self.retry(countdown=1)
            log.info("preprocess: asset %s vanished", asset_id)
            return
        source = storage.asset_path(asset.id, asset.ext)
        if asset.type == ASSET_AUDIO:
            # Audio assets only need their duration (contract §6); no poster / preview.
            try:
                meta = ffprobe.probe_audio(source)
            except Exception as exc:  # noqa: BLE001
                log.exception("preprocess audio %s failed", asset_id)
                asset.status = ASSET_FAILED
                asset.error = str(exc)[:4000]
                db.commit()
                return
            asset.duration = meta["duration"]
            asset.has_audio = True
            asset.status = ASSET_READY
            asset.error = None
            db.commit()
            return
        # A ready asset is only here for the has_audio backfill; failing that must not
        # take a working sticker out of service.
        was_ready = asset.status == ASSET_READY
        try:
            meta = asset_preprocess.run_asset_preprocess(
                source=source,
                poster=storage.asset_poster_path(asset.id),
                preview_for_ext=lambda ext: storage.asset_preview_path(asset.id, ext),
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("preprocess asset %s failed", asset_id)
            if was_ready:
                asset.has_audio = False  # stop the startup backfill from retrying forever
                db.commit()
                return
            asset.status = ASSET_FAILED
            asset.error = str(exc)[:4000]
            db.commit()
            return

        asset.width = meta["width"]
        asset.height = meta["height"]
        asset.duration = meta["duration"]
        asset.fps = meta["fps"]
        asset.has_alpha = meta["has_alpha"]
        asset.has_audio = bool(meta.get("has_audio"))
        asset.decoder = meta["decoder"]
        asset.preview_ext = meta["preview_ext"]
        asset.status = ASSET_READY
        asset.error = None
        db.commit()
    finally:
        db.close()


@celery_app.task(name="hitgo.render_job", bind=True, max_retries=3)
def render_job(self, job_id: str) -> None:  # noqa: ANN001
    db = SessionLocal()
    try:
        if db.get(Job, job_id) is None and self.request.retries < self.max_retries:
            raise self.retry(countdown=1)
        render.render_job(db, job_id)
    except render.RenderError as exc:
        # Already persisted as status=failed by the service; just log it.
        log.error("render %s failed: %s", job_id, str(exc).splitlines()[0] if str(exc) else exc)
    finally:
        db.close()

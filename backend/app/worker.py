"""Celery app + tasks (preprocess_video, preprocess_asset, render_job, separate_video, localize_video) and the API-side ``enqueue`` helper.

The API never blocks on Redis for long: publishing uses a short connection
timeout and a single retry, and failures are turned into ``QueueUnavailable``
which the routers map to HTTP 503.
"""

from __future__ import annotations

import logging

from celery import Celery
from celery.exceptions import SoftTimeLimitExceeded
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
from app.services import asset_preprocess, erase, ffprobe, localize, preprocess, render, screentext, separate, storage, tts

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
    # Separation needs torch + Demucs, which only the ``separator`` container has
    # (Dockerfile.separator, ``-Q separate``); the default worker never sees the task.
    task_routes={"hitgo.separate_video": {"queue": "separate"}},
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


def enqueue_later(task, countdown: int, *args) -> None:  # noqa: ANN001
    """Publish a task to run after ``countdown`` seconds.

    Used by the erase poll (HIG-38): each tick re-enqueues the next one instead of sleeping, so
    a minutes-long cloud job never occupies the single worker slot.
    """
    try:
        task.apply_async(args=args, countdown=max(0, countdown))
    except (OperationalError, ConnectionError, OSError) as exc:
        log.warning("enqueue_later %s failed: %s", getattr(task, "name", task), exc)
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
            # Step 0 (contract §6): stills and blanks have no uploaded source.mp4 yet.
            source_gen: list[str] | None = None
            if video.kind == "image":
                still = storage.find_still(batch_id, video.id)
                if still is None:
                    raise preprocess.PreprocessError("找不到上传的图片")
                source_gen = preprocess.still_args(still, source)
            elif video.kind == "blank":
                from app.schemas import CANVAS_SIZES  # local: the module header is shared

                p = video.blank_params or {}
                source_gen = preprocess.blank_args(
                    source, p["color"], p["duration"], CANVAS_SIZES[p["aspect"]]
                )
            meta = preprocess.run_preprocess(
                source=source,
                proxy=storage.proxy_path(batch_id, video.id),
                sprite=sprite,
                poster=storage.poster_path(batch_id, video.id),
                sprite_url=storage.media_url(sprite),
                source_gen=source_gen,
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


@celery_app.task(name="hitgo.separate_video", bind=True, max_retries=3)
def separate_video(self, video_id: str) -> None:  # noqa: ANN001
    """Vocals / instrumental separation (contract §6); runs on the ``separate`` queue."""
    db = SessionLocal()
    try:
        if db.get(Video, video_id) is None:
            if self.request.retries < self.max_retries:
                raise self.retry(countdown=1)
            log.info("separate: video %s vanished", video_id)
            return
        separate.run_separation(db, video_id)
    finally:
        db.close()


@celery_app.task(
    name="hitgo.localize_video",
    bind=True,
    max_retries=3,
    soft_time_limit=settings.localize_timeout_seconds,
    time_limit=settings.localize_timeout_seconds + 60,
)
def localize_video(self, video_id: str) -> None:  # noqa: ANN001
    """Transcribe / translate / dub (contract §6); network-bound, so it runs on the default queue."""
    db = SessionLocal()
    try:
        if db.get(Video, video_id) is None:
            if self.request.retries < self.max_retries:
                raise self.retry(countdown=1)
            log.info("localize: video %s vanished", video_id)
            return
        try:
            localize.run_localization(db, video_id)
        except SoftTimeLimitExceeded:
            # run_localization already wrote the failed state; only the retry bookkeeping is left.
            log.error("localize %s exceeded %ss", video_id, settings.localize_timeout_seconds)
    finally:
        db.close()


@celery_app.task(
    name="hitgo.screen_text_video",
    bind=True,
    max_retries=3,
    soft_time_limit=settings.screentext_timeout_seconds,
    time_limit=settings.screentext_timeout_seconds + 60,
)
def screen_text_video(self, video_id: str) -> None:  # noqa: ANN001
    """Detect / translate on-screen text and hand erasure off (contract §6, HIG-38)."""
    db = SessionLocal()
    try:
        if db.get(Video, video_id) is None:
            if self.request.retries < self.max_retries:
                raise self.retry(countdown=1)
            log.info("screen text: video %s vanished", video_id)
            return
        try:
            screentext.run_screen_text(db, video_id)
        except SoftTimeLimitExceeded:
            # run_screen_text already wrote the failed state; only retry bookkeeping is left.
            log.error("screen text %s exceeded %ss", video_id, settings.screentext_timeout_seconds)
    finally:
        db.close()


@celery_app.task(name="hitgo.erase_poll", bind=True, max_retries=3, soft_time_limit=300, time_limit=360)
def erase_poll(self, video_id: str) -> None:  # noqa: ANN001
    """One tick of the erase job; re-enqueues itself until done, failed or past the deadline."""
    db = SessionLocal()
    try:
        erase.poll_once(db, video_id)
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


@celery_app.task(
    name="hitgo.synthesize_tts",
    bind=True,
    max_retries=3,
    soft_time_limit=settings.localize_timeout_seconds,
    time_limit=settings.localize_timeout_seconds + 60,
)
def synthesize_tts(self, asset_id: str) -> None:  # noqa: ANN001
    """Read poster copy aloud into a derived audio asset (HIG-50, contract §6); network-bound, default queue."""
    db = SessionLocal()
    try:
        if db.get(Asset, asset_id) is None:
            # Row not visible yet (published right after commit) or deleted.
            if self.request.retries < self.max_retries:
                raise self.retry(countdown=1)
            log.info("tts: asset %s vanished", asset_id)
            return
        try:
            tts.run_tts(db, asset_id)
        except SoftTimeLimitExceeded:
            log.error("tts %s exceeded %ss", asset_id, settings.localize_timeout_seconds)
            # run_tts marks the asset failed itself; this covers the limit firing before it got there.
            db.rollback()
            asset = db.get(Asset, asset_id)
            if asset is not None and asset.status != ASSET_FAILED:
                asset.status = ASSET_FAILED
                asset.error = f"朗读合成超过 {settings.localize_timeout_seconds} 秒仍未完成，已中止"
                db.commit()
    finally:
        db.close()

"""Batches: list/create/detail/delete, video upload, batch apply, jobs & outputs (contract §3)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ids, worker
from app.config import settings
from app.db import get_db, utcnow
from app.errors import CodedHTTPException
from app.models import JOB_DONE, VIDEO_PREPARING, Batch, Job, Video
from app.routers._common import (
    enqueue_or_503,
    get_batch_or_404,
    jobs_for_batch,
    videos_for_batch,
)
from app.schemas import (
    ApplyIn,
    BatchCreate,
    BatchDetailOut,
    BatchOut,
    BlankVideoIn,
    JobOut,
    RenameIn,
    UploadTicketOut,
    VideoOut,
)
from app.serializers import batch_detail_out, batch_out, group_jobs_by_video, job_out, video_out
from app.services import storage, upload_ticket
from app.services.apply import apply_modules

router = APIRouter(prefix="/api/batches", tags=["batches"])

VIDEO_EXTS = {"mp4", "mov"}
# Stills (HIG-50): stored as still.<ext>, preprocess turns them into a 5 s source.mp4.
IMAGE_EXTS = {"jpg", "jpeg", "png"}
IMAGE_MAX_BYTES = 20 * 1024 * 1024


@router.get("", response_model=list[BatchOut])
def list_batches(db: Session = Depends(get_db)) -> list[BatchOut]:
    batches = db.scalars(select(Batch).order_by(Batch.created_at.desc(), Batch.id)).all()
    videos = db.scalars(select(Video)).all()
    jobs = db.scalars(select(Job)).all()
    videos_by_batch: dict[str, list[Video]] = {b.id: [] for b in batches}
    for v in videos:
        videos_by_batch.setdefault(v.batch_id, []).append(v)
    jobs_by_batch: dict[str, list[Job]] = {b.id: [] for b in batches}
    for j in jobs:
        jobs_by_batch.setdefault(j.batch_id, []).append(j)
    return [batch_out(b, videos_by_batch[b.id], jobs_by_batch[b.id]) for b in batches]


@router.post("", response_model=BatchOut, status_code=201)
def create_batch(body: BatchCreate, db: Session = Depends(get_db)) -> BatchOut:
    batch = Batch(id=ids.batch_id(), name=body.name)
    db.add(batch)
    db.commit()
    return batch_out(batch, [], [])


@router.get("/{batch_id}", response_model=BatchDetailOut)
def get_batch(batch_id: str, db: Session = Depends(get_db)) -> BatchDetailOut:
    batch = get_batch_or_404(db, batch_id)
    return batch_detail_out(batch, videos_for_batch(db, batch_id), jobs_for_batch(db, batch_id))


@router.patch("/{batch_id}", response_model=BatchOut)
def rename_batch(batch_id: str, body: RenameIn, db: Session = Depends(get_db)) -> BatchOut:
    batch = get_batch_or_404(db, batch_id)
    batch.name = body.name
    db.commit()
    return batch_out(batch, videos_for_batch(db, batch_id), jobs_for_batch(db, batch_id))


@router.delete("/{batch_id}", status_code=204)
def delete_batch(batch_id: str, db: Session = Depends(get_db)) -> None:
    batch = get_batch_or_404(db, batch_id)
    job_ids = [j.id for j in jobs_for_batch(db, batch_id)]
    db.delete(batch)  # cascades to videos and jobs
    db.commit()
    storage.remove_tree(storage.batch_dir(batch_id))
    for job_id in job_ids:
        for output_format in ("mp4", "mov", "png", "jpg"):
            storage.remove_file(storage.output_path(job_id, output_format))
            storage.remove_file(storage.tmp_output_path(job_id, output_format))


# --- upload ------------------------------------------------------------------


def _upload_batch_or_404(db: Session, batch_id: str) -> Batch:
    batch = db.get(Batch, batch_id)
    if batch is None:
        raise CodedHTTPException(404, "批次不存在", "UPLOAD_BATCH_NOT_FOUND")
    return batch


@router.post("/{batch_id}/upload-ticket", response_model=UploadTicketOut)
def create_video_upload_ticket(batch_id: str, db: Session = Depends(get_db)) -> UploadTicketOut:
    _upload_batch_or_404(db, batch_id)
    if not settings.upload_base_url:
        return UploadTicketOut()
    path = f"/api/batches/{batch_id}/videos"
    ticket, expires = upload_ticket.issue(settings.access_code, path=path)
    return UploadTicketOut(
        upload_url=f"{settings.upload_base_url}{path}",
        ticket=ticket,
        expires_at=datetime.fromtimestamp(expires, UTC).isoformat().replace("+00:00", "Z"),
    )


@router.post("/{batch_id}/videos", response_model=list[VideoOut], status_code=201)
async def upload_videos(
    batch_id: str,
    files: list[UploadFile] = [],  # noqa: B006 - FastAPI form binding
    db: Session = Depends(get_db),
) -> list[VideoOut]:
    _upload_batch_or_404(db, batch_id)
    if not files:
        raise CodedHTTPException(400, "没有上传文件", "UPLOAD_NO_FILES")

    start = len(videos_for_batch(db, batch_id))

    created: list[Video] = []
    try:
        for i, upload in enumerate(files):
            name = upload.filename or f"video_{i + 1}.mp4"
            ext = Path(name).suffix.lower().lstrip(".")
            if ext not in VIDEO_EXTS and ext not in IMAGE_EXTS:
                raise CodedHTTPException(400, f"{name}：只支持 mp4 / mov / jpg / png 文件", "UPLOAD_UNSUPPORTED_FORMAT")
            is_image = ext in IMAGE_EXTS
            video = Video(
                id=ids.video_id(),
                batch_id=batch_id,
                name=name,
                order_index=start + i,
                status=VIDEO_PREPARING,
                kind="image" if is_image else "video",
                # An image's source.mp4 is generated by preprocess (contract §6 step 0).
                source_ext="mp4" if is_image else ext,
                original_ext=ext,
            )
            if is_image:
                dst = storage.still_path(batch_id, video.id, ext)
            else:
                dst = storage.source_path(batch_id, video.id, ext)
            # Register before writing so a rejected file's directory is cleaned up too.
            created.append(video)
            size = await storage.write_upload(upload, dst)
            if size == 0:
                raise CodedHTTPException(400, f"{name}：文件为空", "UPLOAD_EMPTY_FILE")
            if is_image and size > IMAGE_MAX_BYTES:
                raise CodedHTTPException(400, f"{name}：图片不能超过 20 MiB", "UPLOAD_IMAGE_TOO_LARGE")
            db.add(video)
        # Commit before publishing so the worker always finds the rows.
        db.commit()
    except Exception:
        db.rollback()
        for video in created:
            storage.remove_tree(storage.video_dir(batch_id, video.id))
        raise
    try:
        for video in created:
            enqueue_or_503(worker.preprocess_video, video.id)
    except HTTPException as exc:
        # Queue down: undo the whole upload so the user can simply retry it.
        for video in created:
            db.delete(video)
        db.commit()
        for video in created:
            storage.remove_tree(storage.video_dir(batch_id, video.id))
        raise CodedHTTPException(503, str(exc.detail), "UPLOAD_PROCESSING_UNAVAILABLE") from exc
    return [video_out(v) for v in created]


@router.post("/{batch_id}/blank", response_model=VideoOut, status_code=201)
def create_blank_video(batch_id: str, body: BlankVideoIn, db: Session = Depends(get_db)) -> VideoOut:
    """A solid-colour source clip (HIG-50); preprocess generates source.mp4 from blank_params."""
    get_batch_or_404(db, batch_id)
    n = len(videos_for_batch(db, batch_id))
    video = Video(
        id=ids.video_id(),
        batch_id=batch_id,
        name=body.name or f"空白素材 {n + 1}",
        order_index=n,
        status=VIDEO_PREPARING,
        kind="blank",
        source_ext="mp4",
        blank_params={"color": body.color, "duration": body.duration, "aspect": body.aspect},
    )
    db.add(video)
    # Commit before publishing so the worker always finds the row.
    db.commit()
    try:
        enqueue_or_503(worker.preprocess_video, video.id)
    except HTTPException:
        # Queue down: undo so the user can simply retry.
        db.delete(video)
        db.commit()
        raise
    return video_out(video)


# --- apply -------------------------------------------------------------------


@router.post("/{batch_id}/apply", response_model=list[VideoOut])
def apply_spec(batch_id: str, body: ApplyIn, db: Session = Depends(get_db)) -> list[VideoOut]:
    get_batch_or_404(db, batch_id)
    source = db.get(Video, body.source_video_id)
    if source is None or source.batch_id != batch_id:
        raise HTTPException(404, "源视频不存在或不属于该批次")
    if not source.edit_spec:
        raise HTTPException(400, "源视频还没有编辑参数")

    target_ids = [t for t in dict.fromkeys(body.target_video_ids) if t != source.id]
    targets = db.scalars(select(Video).where(Video.id.in_(target_ids))).all() if target_ids else []
    found = {t.id for t in targets}
    missing = [t for t in target_ids if t not in found]
    if missing:
        raise HTTPException(404, f"目标视频不存在：{', '.join(missing)}")
    for t in targets:
        if t.batch_id != batch_id:
            raise HTTPException(400, f"目标视频 {t.id} 不属于该批次")

    now = utcnow()
    for target in targets:
        target.edit_spec = apply_modules(
            source.edit_spec, target.edit_spec, body.modules, target.duration, body.layer_mode
        )
        target.updated_at = now
    db.commit()

    by_video = group_jobs_by_video(jobs_for_batch(db, batch_id))
    ordered = sorted(targets, key=lambda v: (v.order_index, v.created_at))
    return [video_out(v, by_video.get(v.id, ())) for v in ordered]


# --- jobs / outputs ----------------------------------------------------------


@router.get("/{batch_id}/jobs", response_model=list[JobOut])
def batch_jobs(batch_id: str, db: Session = Depends(get_db)) -> list[JobOut]:
    get_batch_or_404(db, batch_id)
    jobs = sorted(jobs_for_batch(db, batch_id), key=lambda j: (j.created_at, j.id), reverse=True)
    return [job_out(j) for j in jobs]


@router.get("/{batch_id}/outputs", response_model=list[JobOut])
def batch_outputs(batch_id: str, db: Session = Depends(get_db)) -> list[JobOut]:
    get_batch_or_404(db, batch_id)
    order = {v.id: v.order_index for v in videos_for_batch(db, batch_id)}
    done = [j for j in jobs_for_batch(db, batch_id) if j.status == JOB_DONE]
    done.sort(key=lambda j: (order.get(j.video_id, 0), j.variant_key, j.created_at))
    return [job_out(j) for j in done]

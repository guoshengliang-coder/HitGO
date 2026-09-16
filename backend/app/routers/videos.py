"""Videos: GET /api/videos/{id}, PUT /api/videos/{id}/spec, POST /api/videos/{id}/separate, DELETE /api/videos/{id}."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app import worker
from app.db import get_db, iso, utcnow
from app.models import SEP_ACTIVE, SEP_QUEUED, VIDEO_READY
from app.routers._common import enqueue_or_503, get_video_or_404, jobs_for_videos
from app.schemas import EditSpec, SeparateIn, SpecIn, VideoOut
from app.serializers import video_out
from app.services import storage

router = APIRouter(prefix="/api/videos", tags=["videos"])


def format_validation_errors(exc: ValidationError) -> list[dict[str, str]]:
    """Pydantic errors → [{field, message}] with dotted field paths."""
    items = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()))
        msg = err.get("msg", "")
        if msg.startswith("Value error, "):
            msg = msg[len("Value error, ") :]
        items.append({"field": loc or "edit_spec", "message": msg})
    return items


@router.get("/{video_id}", response_model=VideoOut)
def get_video(video_id: str, db: Session = Depends(get_db)) -> VideoOut:
    video = get_video_or_404(db, video_id)
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.put("/{video_id}/spec", response_model=VideoOut)
def put_spec(video_id: str, body: SpecIn, db: Session = Depends(get_db)):
    video = get_video_or_404(db, video_id)
    if body.edit_spec is None:
        video.edit_spec = None
    else:
        if video.status != VIDEO_READY:
            raise HTTPException(400, "视频尚未预处理完成，暂时不能保存编辑参数")
        try:
            EditSpec.model_validate(body.edit_spec, context={"duration": video.duration})
        except ValidationError as exc:
            errors = format_validation_errors(exc)
            summary = "；".join(f"{e['field']}: {e['message']}" for e in errors[:5])
            return JSONResponse(
                status_code=400,
                content={"detail": f"编辑参数校验失败：{summary}", "errors": errors},
            )
        # Store the raw (validated) spec so frontend-only extra fields survive round trips.
        video.edit_spec = body.edit_spec
    video.updated_at = utcnow()
    db.commit()
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.post("/{video_id}/separate", response_model=VideoOut, status_code=202)
def separate_video(video_id: str, body: SeparateIn | None = None, db: Session = Depends(get_db)):
    """Queue a vocals / instrumental separation of the source audio (contract §3)."""
    video = get_video_or_404(db, video_id)
    if video.status != VIDEO_READY:
        raise HTTPException(400, "视频尚未预处理完成，暂时不能分离")
    if not video.has_audio:
        raise HTTPException(400, "源视频没有音轨，没有可分离的内容")
    previous = dict(video.separation or {})
    if previous.get("status") in SEP_ACTIVE:
        raise HTTPException(409, "这条视频正在分离中，请等它完成")
    model = (body or SeparateIn()).model
    video.separation = {**previous, "status": SEP_QUEUED, "model": model, "error": None, "updated_at": iso(utcnow())}
    db.commit()
    try:
        enqueue_or_503(worker.separate_video, video.id)
    except HTTPException:
        video.separation = previous or None  # queue down: back to what it was
        db.commit()
        raise
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.delete("/{video_id}", status_code=204)
def delete_video(video_id: str, db: Session = Depends(get_db)) -> None:
    video = get_video_or_404(db, video_id)
    batch_id = video.batch_id
    job_ids = [j.id for j in video.jobs]
    db.delete(video)  # cascades to jobs
    db.commit()
    storage.remove_tree(storage.video_dir(batch_id, video_id))
    for job_id in job_ids:
        storage.remove_file(storage.output_path(job_id))
        storage.remove_file(storage.tmp_output_path(job_id))

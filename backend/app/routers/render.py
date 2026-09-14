"""POST /api/render — one Job per (video, output variant); 409 on active duplicates."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ids, worker
from app.db import get_db
from app.models import JOB_ACTIVE, JOB_FAILED, JOB_QUEUED, VIDEO_READY, Job, Video
from app.routers._common import enqueue_or_503
from app.schemas import EditSpec, JobOut, RenderIn
from app.serializers import job_out

router = APIRouter(prefix="/api", tags=["render"])


@router.post("/render", response_model=list[JobOut], status_code=201)
def create_render_jobs(body: RenderIn, db: Session = Depends(get_db)):
    video_ids = list(dict.fromkeys(body.video_ids))
    videos = {v.id: v for v in db.scalars(select(Video).where(Video.id.in_(video_ids))).all()}
    missing = [vid for vid in video_ids if vid not in videos]
    if missing:
        raise HTTPException(404, f"视频不存在：{', '.join(missing)}")

    # Validate every video before creating anything.
    plan: list[tuple[Video, list[str]]] = []
    for vid in video_ids:
        video = videos[vid]
        if video.status != VIDEO_READY:
            raise HTTPException(400, f"视频 {video.name} 尚未预处理完成")
        if not video.edit_spec:
            raise HTTPException(400, f"视频 {video.name} 还没有编辑参数")
        try:
            spec = EditSpec.model_validate(video.edit_spec, context={"duration": video.duration})
        except ValidationError as exc:
            first = exc.errors()[0]
            raise HTTPException(
                400, f"视频 {video.name} 的编辑参数无效：{first.get('msg', '')}"
            ) from None
        plan.append((video, [o.variant_key for o in spec.outputs]))

    active = db.scalars(
        select(Job).where(Job.video_id.in_(video_ids), Job.status.in_(JOB_ACTIVE))
    ).all()
    active_keys = {(j.video_id, j.variant_key): j for j in active}
    conflicts = [
        {"video_id": v.id, "variant_key": key, "job_id": active_keys[(v.id, key)].id}
        for v, keys in plan
        for key in keys
        if (v.id, key) in active_keys
    ]
    if conflicts:
        return JSONResponse(
            status_code=409,
            content={"detail": "部分视频已有进行中的渲染任务，请等待完成后再试", "conflicts": conflicts},
        )

    jobs: list[Job] = []
    try:
        for video, keys in plan:
            for key in keys:
                job = Job(
                    id=ids.job_id(),
                    batch_id=video.batch_id,
                    video_id=video.id,
                    variant_key=key,
                    status=JOB_QUEUED,
                )
                db.add(job)
                jobs.append(job)
        # Commit before publishing: the worker may pick a task up within
        # milliseconds and must find the row already there.
        db.commit()
    except Exception:
        db.rollback()
        raise
    try:
        for job in jobs:
            enqueue_or_503(worker.render_job, job.id)
    except HTTPException as exc:
        for job in jobs:
            job.status, job.error = JOB_FAILED, exc.detail
        db.commit()
        raise
    return [job_out(j) for j in jobs]

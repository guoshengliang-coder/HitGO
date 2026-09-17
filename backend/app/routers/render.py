"""POST /api/render — one Job per (video, language, output variant); 409 on active duplicates.

``variant_keys`` narrows the outputs rendered (HIG-29); conflicts are only checked for those.
``items`` (HIG-43) renders several languages of one video, each from its own spec snapshot.
"""

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
from app.schemas import EditSpec, JobOut, RenderIn, RenderItemIn
from app.serializers import job_out
from app.services import localize
from app.services.sequence import resolve_sequence

router = APIRouter(prefix="/api", tags=["render"])


@router.post("/render", response_model=list[JobOut], status_code=201)
def create_render_jobs(body: RenderIn, db: Session = Depends(get_db)):
    items: list[RenderItemIn] = []
    seen: set[tuple[str, str | None]] = set()
    for item in body.planned_items():  # a repeated video + language keeps its first entry
        if (item.video_id, item.lang) not in seen:
            seen.add((item.video_id, item.lang))
            items.append(item)
    video_ids = list(dict.fromkeys(i.video_id for i in items))
    videos = {v.id: v for v in db.scalars(select(Video).where(Video.id.in_(video_ids))).all()}
    missing = [vid for vid in video_ids if vid not in videos]
    if missing:
        raise HTTPException(404, f"视频不存在：{', '.join(missing)}")
    unknown_langs = [i.lang for i in items if i.lang is not None and i.lang not in localize.LANGS]
    if unknown_langs:
        raise HTTPException(400, f"不支持的语言：{', '.join(dict.fromkeys(unknown_langs))}")

    # Validate every (video, language) before creating anything.
    plan: list[tuple[Video, RenderItemIn, list[str]]] = []
    for item in items:
        video = videos[item.video_id]
        if video.status != VIDEO_READY:
            raise HTTPException(400, f"视频 {video.name} 尚未预处理完成")
        raw = item.edit_spec if item.edit_spec is not None else video.edit_spec
        if not raw:
            raise HTTPException(400, f"视频 {video.name} 还没有编辑参数")
        try:
            spec = EditSpec.model_validate(raw, context={"duration": video.duration})
        except ValidationError as exc:
            first = exc.errors()[0]
            raise HTTPException(
                400, f"视频 {video.name} 的编辑参数无效：{first.get('msg', '')}"
            ) from None
        try:
            resolve_sequence(db, video, spec)
        except ValueError as exc:
            raise HTTPException(400, f"视频 {video.name} 的拼接片段无效：{exc}") from None
        keys = [o.variant_key for o in spec.outputs]
        if body.variant_keys is not None:
            unknown = [k for k in dict.fromkeys(body.variant_keys) if k not in keys]
            if unknown:
                raise HTTPException(400, f"视频 {video.name} 的编辑参数里没有输出 {', '.join(unknown)}")
            wanted = set(body.variant_keys)
            keys = [k for k in keys if k in wanted]
        plan.append((video, item, keys))

    active = db.scalars(
        select(Job).where(Job.video_id.in_(video_ids), Job.status.in_(JOB_ACTIVE))
    ).all()
    active_keys = {(j.video_id, j.variant_key, j.lang): j for j in active}
    conflicts = [
        {"video_id": v.id, "variant_key": key, "lang": item.lang, "job_id": active_keys[(v.id, key, item.lang)].id}
        for v, item, keys in plan
        for key in keys
        if (v.id, key, item.lang) in active_keys
    ]
    if conflicts:
        return JSONResponse(
            status_code=409,
            content={"detail": "部分视频已有进行中的渲染任务，请等待完成后再试", "conflicts": conflicts},
        )

    jobs: list[Job] = []
    try:
        for video, item, keys in plan:
            for key in keys:
                job = Job(
                    id=ids.job_id(),
                    batch_id=video.batch_id,
                    video_id=video.id,
                    variant_key=key,
                    name=body.name,
                    lang=item.lang,
                    edit_spec=item.edit_spec,
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

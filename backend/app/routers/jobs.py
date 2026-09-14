"""Jobs: GET /api/jobs?ids=, GET /api/jobs/{id}, POST /api/jobs/{id}/retry."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import worker
from app.db import get_db
from app.models import JOB_FAILED, JOB_QUEUED, Job
from app.routers._common import enqueue_or_503, get_job_or_404
from app.schemas import JobOut
from app.serializers import job_out

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("", response_model=list[JobOut])
def list_jobs(ids: str = Query(default=""), db: Session = Depends(get_db)) -> list[JobOut]:
    wanted = [i.strip() for i in ids.split(",") if i.strip()]
    if not wanted:
        return []
    rows = {j.id: j for j in db.scalars(select(Job).where(Job.id.in_(wanted))).all()}
    return [job_out(rows[i]) for i in wanted if i in rows]


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: str, db: Session = Depends(get_db)) -> JobOut:
    return job_out(get_job_or_404(db, job_id))


@router.post("/{job_id}/retry", response_model=JobOut)
def retry_job(job_id: str, db: Session = Depends(get_db)) -> JobOut:
    job = get_job_or_404(db, job_id)
    if job.status != JOB_FAILED:
        raise HTTPException(409, "只有失败的任务可以重试")
    job.status = JOB_QUEUED
    job.progress = 0
    job.error = None
    job.output = None
    job.callback = None
    job.started_at = None
    job.finished_at = None
    job.attempt += 1
    db.commit()  # before publishing, so the worker finds status=queued
    try:
        enqueue_or_503(worker.render_job, job.id)
    except HTTPException as exc:
        job.status, job.error = JOB_FAILED, exc.detail
        db.commit()
        raise
    return job_out(job)

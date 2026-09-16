"""Cross-batch outputs: GET /api/outputs."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import JOB_DONE, Batch, Job, Video
from app.schemas import JobOut
from app.serializers import job_out

router = APIRouter(prefix="/api/outputs", tags=["outputs"])

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


def _escape_like(term: str) -> str:
    """Make % and _ in a search box match themselves, not act as wildcards."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("", response_model=list[JobOut])
def list_outputs(
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=255),
    db: Session = Depends(get_db),
) -> list[JobOut]:
    """Finished outputs across every batch, newest first.

    Sorted by finished_at so "what did I just render" is the first row. A done job
    should always have finished_at, but coalescing to created_at keeps a row with a
    missing timestamp in a sensible place instead of bunching every such row at one
    end. Batch and video names are prefetched for the page only -- walking
    job.batch / job.video per row would be one query each.

    ``q`` narrows to jobs whose export name, batch name or video name contains it
    (case-insensitive), before paging.
    """
    stmt = select(Job).where(Job.status == JOB_DONE)
    term = (q or "").strip()
    if term:
        pattern = f"%{_escape_like(term.lower())}%"
        stmt = (
            stmt.join(Batch, Batch.id == Job.batch_id)
            .join(Video, Video.id == Job.video_id)
            .where(
                or_(
                    func.lower(func.coalesce(Job.name, "")).like(pattern, escape="\\"),
                    func.lower(Batch.name).like(pattern, escape="\\"),
                    func.lower(Video.name).like(pattern, escape="\\"),
                )
            )
        )
    rows = db.scalars(
        stmt.order_by(func.coalesce(Job.finished_at, Job.created_at).desc(), Job.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    if not rows:
        return []
    batch_names = dict(
        db.execute(select(Batch.id, Batch.name).where(Batch.id.in_({j.batch_id for j in rows}))).all()
    )
    video_names = dict(
        db.execute(select(Video.id, Video.name).where(Video.id.in_({j.video_id for j in rows}))).all()
    )
    return [
        job_out(j, batch_name=batch_names.get(j.batch_id), video_name=video_names.get(j.video_id))
        for j in rows
    ]

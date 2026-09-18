"""Cross-batch outputs: GET /api/outputs, POST /api/outputs/zip (HIG-47)."""

from __future__ import annotations

from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import JOB_DONE, Batch, Job, Video
from app.schemas import JobOut
from app.serializers import job_out
from app.services import localize, storage
from app.services.output_zip import ZipEntry, dedupe_names, output_file_name, stream_zip

router = APIRouter(prefix="/api/outputs", tags=["outputs"])

DEFAULT_LIMIT = 100
MAX_LIMIT = 500
# One zip holds at most this many outputs (same as a page of GET /api/outputs).
MAX_ZIP_JOBS = 500
# ``GET /api/outputs?lang=original``: outputs without a language (HIG-43).
ORIGINAL_LANG = "original"


def lang_label(lang: str | None) -> str | None:
    """Chinese name of a localize language for file names; unknown codes fall back to the code."""
    if not lang:
        return None
    return localize.LANGS.get(lang, {}).get("label", lang)


def _escape_like(term: str) -> str:
    """Make % and _ in a search box match themselves, not act as wildcards."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("", response_model=list[JobOut])
def list_outputs(
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=255),
    lang: str | None = Query(default=None, max_length=16),
    db: Session = Depends(get_db),
) -> list[JobOut]:
    """Finished outputs across every batch, newest first.

    Sorted by finished_at so "what did I just render" is the first row. A done job
    should always have finished_at, but coalescing to created_at keeps a row with a
    missing timestamp in a sensible place instead of bunching every such row at one
    end. Batch and video names are prefetched for the page only -- walking
    job.batch / job.video per row would be one query each.

    ``q`` narrows to jobs whose export name, batch name or video name contains it
    (case-insensitive), or whose language label does (HIG-43), before paging. ``lang``
    keeps one language; ``original`` keeps outputs without one.
    """
    stmt = select(Job).where(Job.status == JOB_DONE)
    if lang == ORIGINAL_LANG:
        stmt = stmt.where(Job.lang.is_(None))
    elif lang:
        stmt = stmt.where(Job.lang == lang)
    term = (q or "").strip()
    if term:
        pattern = f"%{_escape_like(term.lower())}%"
        matching_langs = [code for code, info in localize.LANGS.items() if term.lower() in info["label"].lower()]
        stmt = (
            stmt.join(Batch, Batch.id == Job.batch_id)
            .join(Video, Video.id == Job.video_id)
            .where(
                or_(
                    func.lower(func.coalesce(Job.name, "")).like(pattern, escape="\\"),
                    func.lower(Batch.name).like(pattern, escape="\\"),
                    func.lower(Video.name).like(pattern, escape="\\"),
                    Job.lang.in_(matching_langs),
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


@router.post("/zip")
def download_outputs_zip(
    job_ids: list[str] = Form(default_factory=list),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Finished outputs as one zip, streamed (contract §3).

    Form-encoded on purpose: the page submits a hidden form so the browser downloads straight
    to disk instead of buffering the whole archive into a blob. Ids keep the order they were
    sent in; duplicates, unknown ids, unfinished jobs and missing files are skipped.
    """
    ids = list(dict.fromkeys(i.strip() for i in job_ids if i.strip()))
    if not ids:
        raise HTTPException(400, "没有选择要下载的产物")
    if len(ids) > MAX_ZIP_JOBS:
        raise HTTPException(400, f"一次最多打包 {MAX_ZIP_JOBS} 个产物")
    jobs = {j.id: j for j in db.scalars(select(Job).where(Job.id.in_(ids), Job.status == JOB_DONE)).all()}
    rows = [jobs[i] for i in ids if i in jobs and storage.output_path(i, jobs[i].output_format).is_file()]
    if not rows:
        raise HTTPException(400, "所选产物都已不存在或还没完成，无法下载")
    batch_names = dict(db.execute(select(Batch.id, Batch.name).where(Batch.id.in_({j.batch_id for j in rows}))).all())
    video_names = dict(db.execute(select(Video.id, Video.name).where(Video.id.in_({j.video_id for j in rows}))).all())
    names = dedupe_names(
        [
            output_file_name(
                j.id, j.variant_key, j.name, batch_names.get(j.batch_id), video_names.get(j.video_id), lang_label(j.lang), j.output_format
            )
            for j in rows
        ]
    )
    entries = [
        ZipEntry(name=n, path=storage.output_path(j.id, j.output_format), modified=j.finished_at) for n, j in zip(names, rows, strict=True)
    ]
    only_batch = {j.batch_id for j in rows}
    label = batch_names.get(next(iter(only_batch))) if len(only_batch) == 1 else None
    filename = _zip_name(label)
    return StreamingResponse(
        stream_zip(entries),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename=\"HitGO_outputs.zip\"; filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _zip_name(batch_name: str | None) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    base = output_file_name("", "", None, batch_name, None).removesuffix(".mp4") if batch_name else ""
    return f"{base or 'HitGO'}_产物_{stamp}.zip"

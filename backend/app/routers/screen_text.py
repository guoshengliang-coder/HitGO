"""On-screen text: POST /api/videos/{id}/screen-text, PUT …/blocks, PUT / DELETE …/versions/{lang},
DELETE …/erase, GET /api/screen-text/options (contract §3, HIG-38)."""

from __future__ import annotations

import copy

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import worker
from app.config import settings
from app.db import get_db, iso, utcnow
from app.models import ST_ACTIVE, ST_DONE, ST_QUEUED, VIDEO_READY, Video
from app.routers._common import enqueue_or_503, get_video_or_404, jobs_for_videos
from app.schemas import BlocksIn, ScreenTextIn, ScreenTextOptionsOut, ScreenTextsIn, VideoOut
from app.serializers import video_out
from app.services import erase as erase_service
from app.services import localize, screentext

router = APIRouter(prefix="/api", tags=["screen-text"])


def _active(part: dict | None) -> bool:
    return bool(part) and part.get("status") in ST_ACTIVE


def _any_active(st: dict | None) -> bool:
    st = st or {}
    return _active(st.get("detect")) or _active(st.get("erase")) or any(_active(v) for v in (st.get("versions") or {}).values())


def _queue(db: Session, video: Video, previous: dict | None, st: dict) -> VideoOut:
    """Persist ``st``, enqueue the task; on a dead queue put ``previous`` back and 503."""
    video.screen_text = st
    video.updated_at = utcnow()
    db.commit()
    try:
        enqueue_or_503(worker.screen_text_video, video.id)
    except HTTPException:
        video.screen_text = previous
        db.commit()
        raise
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.get("/screen-text/options", response_model=ScreenTextOptionsOut)
def screen_text_options() -> dict:
    return {
        "enabled": screentext.enabled(settings),
        "erase_enabled": screentext.enabled(settings) and erase_service.erase_enabled(settings),
        "erase_provider": settings.erase_provider,
        "max_seconds": settings.screentext_max_seconds,
        "max_frames": settings.screentext_max_frames,
        "max_blocks": settings.screentext_max_blocks,
    }


@router.post("/videos/{video_id}/screen-text", response_model=VideoOut, status_code=202)
def start_screen_text(video_id: str, body: ScreenTextIn, db: Session = Depends(get_db)):
    """Queue: detect if asked (or never done), translate each target language, then erase."""
    video = get_video_or_404(db, video_id)
    if video.status != VIDEO_READY:
        raise HTTPException(400, "视频尚未预处理完成，暂时不能处理画面文字")
    if (video.duration or 0) > settings.screentext_max_seconds:
        raise HTTPException(400, f"源视频超过 {settings.screentext_max_seconds} 秒，暂不支持画面文字处理")
    sources = {s["code"] for s in localize.source_langs()}
    if body.source_lang not in sources:
        raise HTTPException(400, f"不支持的源语言：{body.source_lang}")
    table = localize.voice_table(settings)
    for lang in body.target_langs:
        if lang not in table:
            raise HTTPException(400, f"不支持的目标语言：{lang}")
    if not screentext.enabled(settings):
        raise HTTPException(503, "没有配置 DASHSCOPE_API_KEY，画面文字识别不可用")
    if body.erase and not erase_service.erase_enabled(settings):
        raise HTTPException(503, "当前部署没有可用的擦除供应商")

    previous = copy.deepcopy(video.screen_text) if video.screen_text else None
    st = copy.deepcopy(previous) if previous else {}
    detect = st.get("detect") or {}
    versions = dict(st.get("versions") or {})
    if _active(detect):
        raise HTTPException(409, "这条视频正在识别画面文字，请等它完成")
    if _active(st.get("erase")):
        raise HTTPException(409, "这条视频正在擦除画面文字，请等它完成")
    for lang in body.target_langs:
        if _active(versions.get(lang)):
            raise HTTPException(409, f"{localize.LANGS[lang]['label']}的画面文字正在翻译中，请等它完成")

    now = iso(utcnow())
    need_detect = body.detect or detect.get("status") != ST_DONE
    if need_detect:
        st["detect"] = {**detect, "status": ST_QUEUED, "error": None, "blocks": list(detect.get("blocks") or []), "updated_at": now}
    else:
        st["detect"] = detect
    if not need_detect and not body.target_langs and not body.erase:
        raise HTTPException(400, "已经识别过了：请选择目标语言、或勾上擦除，再不然带上 detect 重新识别")

    for lang in body.target_langs:
        old = versions.get(lang) or {}
        versions[lang] = {
            **old,
            "status": ST_QUEUED,
            "texts": list(old.get("texts") or []),
            "stale": bool(old.get("stale", False)),
            "error": None,
            "updated_at": now,
        }
    st["versions"] = versions
    if body.erase:
        st["erase"] = {**(st.get("erase") or {}), "status": ST_QUEUED, "error": None, "updated_at": now}

    # Languages an earlier (still queued) task has not picked up yet stay on the list.
    pending = dict(st.get("pending") or {})
    carried = [l for l in pending.get("target_langs") or [] if l not in body.target_langs and _active(versions.get(l))]
    st["pending"] = {
        "target_langs": [*carried, *body.target_langs],
        "source_lang": body.source_lang,
        "terms": [t.model_dump() for t in body.terms],
        "erase": bool(body.erase),
        "scope": body.scope.model_dump() if body.scope else None,
    }
    return _queue(db, video, previous, st)


@router.put("/videos/{video_id}/screen-text/blocks", response_model=VideoOut)
def update_blocks(video_id: str, body: BlocksIn, db: Session = Depends(get_db)):
    """Fix the detected text / boxes / times; no task is started, every version becomes stale."""
    video = get_video_or_404(db, video_id)
    st = copy.deepcopy(video.screen_text) if video.screen_text else {}
    detect = st.get("detect") or {}
    if detect.get("status") != ST_DONE:
        raise HTTPException(400, "还没有识别结果，不能修正")
    if _any_active(st):
        raise HTTPException(409, "有画面文字任务正在进行中，请等它完成再修正")
    try:
        blocks = screentext.apply_block_edits(detect.get("blocks") or [], [b.model_dump(exclude_none=True) for b in body.blocks])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    now = iso(utcnow())
    st["detect"] = {**detect, "blocks": blocks, "updated_at": now}
    for version in (st.get("versions") or {}).values():
        if version.get("texts"):
            version["stale"] = True
            version["updated_at"] = now
    if st.get("erase"):
        # The clean copy was made from the old boxes; it no longer matches what is on screen.
        st["erase"] = {**st["erase"], "stale": True, "updated_at": now}
    video.screen_text = st
    video.updated_at = utcnow()
    db.commit()
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.put("/videos/{video_id}/screen-text/versions/{lang}", response_model=VideoOut)
def update_version(video_id: str, lang: str, body: ScreenTextsIn, db: Session = Depends(get_db)):
    """Edit one language's translations; nothing is re-run."""
    video = get_video_or_404(db, video_id)
    st = copy.deepcopy(video.screen_text) if video.screen_text else {}
    versions = st.get("versions") or {}
    version = versions.get(lang)
    if version is None:
        raise HTTPException(404, "没有这个语言的画面文字版本")
    if _active(version):
        raise HTTPException(409, "这个版本正在翻译中，请等它完成")
    try:
        texts = screentext.apply_text_edits(version.get("texts") or [], [t.model_dump() for t in body.texts])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    versions[lang] = {**version, "texts": texts, "updated_at": iso(utcnow())}
    st["versions"] = versions
    video.screen_text = st
    video.updated_at = utcnow()
    db.commit()
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.delete("/videos/{video_id}/screen-text/versions/{lang}", status_code=204)
def delete_version(video_id: str, lang: str, db: Session = Depends(get_db)) -> None:
    video = get_video_or_404(db, video_id)
    st = copy.deepcopy(video.screen_text) if video.screen_text else {}
    versions = st.get("versions") or {}
    version = versions.get(lang)
    if version is None:
        raise HTTPException(404, "没有这个语言的画面文字版本")
    if _active(version):
        raise HTTPException(409, "这个版本正在翻译中，请等它完成再删除")
    del versions[lang]
    st["versions"] = versions
    pending = dict(st.get("pending") or {})
    if pending:
        pending["target_langs"] = [l for l in pending.get("target_langs") or [] if l != lang]
        st["pending"] = pending
    video.screen_text = st
    video.updated_at = utcnow()
    db.commit()


@router.delete("/videos/{video_id}/screen-text/erase", status_code=204)
def delete_erase(video_id: str, db: Session = Depends(get_db)) -> None:
    """Throw the clean copy away and go back to the original.

    A spec that still says ``source_variant = "clean"`` is left alone on purpose: the renderer
    falls back to the original with a warning (contract §2), which is friendlier than rewriting
    somebody's saved spec behind their back.
    """
    video = get_video_or_404(db, video_id)
    st = copy.deepcopy(video.screen_text) if video.screen_text else {}
    if not st.get("erase"):
        raise HTTPException(404, "这条视频没有无字版")
    if _active(st.get("erase")):
        raise HTTPException(409, "正在擦除中，请等它完成再删除")
    erase_service.remove(video)
    st["erase"] = None
    video.screen_text = st
    video.updated_at = utcnow()
    db.commit()

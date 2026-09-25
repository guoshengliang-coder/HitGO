"""Localization: POST /api/videos/{id}/localize, POST …/localize/transcribe, PUT …/localize/transcript, PUT / DELETE …/localize/versions/{lang},
GET /api/localize/options (contract §3)."""

from __future__ import annotations

import copy

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import worker
from app.config import settings
from app.db import get_db, iso, utcnow
from app.models import LOC_ACTIVE, LOC_DONE, LOC_QUEUED, VIDEO_READY, Asset, Video
from app.routers._common import enqueue_or_503, get_video_or_404, jobs_for_videos
from app.schemas import LocalizeIn, LocalizeOptionsOut, TranscribeIn, TranscriptCuesIn, VersionCuesIn, VideoOut
from app.serializers import video_out
from app.services import localize, storage

router = APIRouter(prefix="/api", tags=["localize"])


def _require_enabled() -> None:
    if not localize.enabled(settings):
        raise HTTPException(503, "没有配置 DASHSCOPE_API_KEY，改语言功能不可用")


def _active(part: dict | None) -> bool:
    return bool(part) and part.get("status") in LOC_ACTIVE


def _require_clonable(langs: list[str]) -> None:
    """Every language must be one the cloned voice can speak (contract §3 ``clone``, HIG-58)."""
    bad = [lang for lang in langs if not localize.clone_supported(lang, settings)]
    if bad:
        labels = "、".join(localize.LANGS[lang]["label"] for lang in bad)
        raise HTTPException(400, f"{labels}暂不支持用原声配音，请改用系统音色")


def _queue(db: Session, video: Video, previous: dict | None, loc: dict) -> VideoOut:
    """Persist ``loc``, enqueue the task; on a dead queue put ``previous`` back and 503."""
    video.localization = loc
    db.commit()
    try:
        enqueue_or_503(worker.localize_video, video.id)
    except HTTPException:
        video.localization = previous
        db.commit()
        raise
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.get("/localize/options", response_model=LocalizeOptionsOut)
def localize_options() -> dict:
    return localize.options_out(settings)


@router.post("/videos/{video_id}/localize", response_model=VideoOut, status_code=202)
def localize_video(video_id: str, body: LocalizeIn, db: Session = Depends(get_db)):
    """Queue: transcribe if needed, then translate (→ synthesize → mix unless ``dub`` is false) each target language."""
    video = get_video_or_404(db, video_id)
    if video.status != VIDEO_READY:
        raise HTTPException(400, "视频尚未预处理完成，暂时不能改语言")
    if not video.has_audio:
        raise HTTPException(400, "源视频没有音轨，没有可改语言的内容")
    sources = {s["code"] for s in localize.source_langs()}
    if body.source_lang not in sources:
        raise HTTPException(400, f"不支持的源语言：{body.source_lang}")
    table = localize.voice_table(settings)
    for lang in body.target_langs:
        if lang not in table:
            raise HTTPException(400, f"不支持的目标语言：{lang}")
    if body.use_source_voice:
        _require_clonable(body.target_langs)
        voices = dict.fromkeys(body.target_langs, "")  # filled in by the task from clone_voice
    else:
        try:
            voices = {lang: localize.resolve_voice(lang, (body.voices or {}).get(lang), table) for lang in body.target_langs}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    previous = copy.deepcopy(video.localization) if video.localization else None
    loc = copy.deepcopy(previous) if previous else {}
    transcript = loc.get("transcript") or {}
    versions = dict(loc.get("versions") or {})
    if _active(transcript):
        raise HTTPException(409, "这条视频正在听写中，请等它完成")
    for lang in body.target_langs:
        if _active(versions.get(lang)):
            raise HTTPException(409, f"{localize.LANGS[lang]['label']}版本正在生成中，请等它完成")
    _require_enabled()

    now = iso(utcnow())
    need_asr = body.retranscribe or transcript.get("status") != LOC_DONE
    if need_asr:
        loc["source_lang"] = body.source_lang
        loc["transcript"] = {**transcript, "status": LOC_QUEUED, "error": None, "cues": list(transcript.get("cues") or []), "updated_at": now}
    else:
        loc.setdefault("source_lang", body.source_lang)
        loc["transcript"] = transcript
    terms = [t.model_dump() for t in body.terms]
    for lang in body.target_langs:
        old = versions.get(lang) or {}
        versions[lang] = {
            **old,
            "status": LOC_QUEUED,
            "stage": None,
            "voice": voices[lang],
            "terms": terms,
            "cues": list(old.get("cues") or []),
            "stale": bool(old.get("stale", False)),
            "error": None,
            "warnings": [],
            "voice_asset_id": old.get("voice_asset_id"),
            "dub": body.dub,
            "voice_stale": bool(old.get("voice_stale", False)),
            "source_voice": bool(body.use_source_voice),
            "adaptive_timing": False,
            "timeline_duration": None,
            "updated_at": now,
        }
    loc["versions"] = versions
    # Languages an earlier (still queued) task has not picked up yet stay on the list.
    pending = dict(loc.get("pending") or {})
    carried = [l for l in pending.get("target_langs") or [] if l not in body.target_langs and _active(versions.get(l))]
    loc["pending"] = {
        "target_langs": [*carried, *body.target_langs],
        "retranscribe": bool(body.retranscribe or (pending.get("retranscribe") and carried)),
    }
    return _queue(db, video, previous, loc)


@router.post("/videos/{video_id}/localize/transcribe", response_model=VideoOut, status_code=202)
def transcribe_video(video_id: str, body: TranscribeIn, db: Session = Depends(get_db)):
    """Queue ASR only (HIG-84 自动识别字幕); a finished transcript is returned as is unless ``retranscribe``."""
    video = get_video_or_404(db, video_id)
    if video.status != VIDEO_READY:
        raise HTTPException(400, "视频尚未预处理完成，暂时不能识别字幕")
    if not video.has_audio:
        raise HTTPException(400, "源视频没有音轨，没有可识别的人声")
    sources = {s["code"] for s in localize.source_langs()}
    if body.source_lang not in sources:
        raise HTTPException(400, f"不支持的源语言：{body.source_lang}")
    previous = copy.deepcopy(video.localization) if video.localization else None
    loc = copy.deepcopy(previous) if previous else {}
    transcript = loc.get("transcript") or {}
    if _active(transcript):
        raise HTTPException(409, "这条视频正在听写中，请等它完成")
    if any(_active(v) for v in (loc.get("versions") or {}).values()):
        raise HTTPException(409, "有语言版本正在生成中，请等它完成再识别字幕")
    _require_enabled()
    if transcript.get("status") == LOC_DONE and not body.retranscribe:
        return video_out(video, jobs_for_videos(db, [video.id]))  # already transcribed: no ASR cost

    loc["source_lang"] = body.source_lang
    loc["transcript"] = {
        **transcript, "status": LOC_QUEUED, "error": None, "cues": list(transcript.get("cues") or []), "updated_at": iso(utcnow()),
    }  # fmt: skip
    loc["pending"] = {"target_langs": [], "retranscribe": True, "transcribe_only": True}
    return _queue(db, video, previous, loc)


@router.put("/videos/{video_id}/localize/transcript", response_model=VideoOut)
def update_transcript(video_id: str, body: TranscriptCuesIn, db: Session = Depends(get_db)):
    """Fix the template text; no task is started, every version becomes stale."""
    video = get_video_or_404(db, video_id)
    loc = copy.deepcopy(video.localization) if video.localization else {}
    transcript = loc.get("transcript") or {}
    if transcript.get("status") != LOC_DONE:
        raise HTTPException(400, "还没有听写结果，不能修正模板")
    versions = loc.get("versions") or {}
    if any(_active(v) for v in versions.values()):
        raise HTTPException(409, "有语言版本正在生成中，请等它完成再修正模板")
    if body.source_lang is not None:
        if body.source_lang not in localize.LANGS:
            raise HTTPException(400, f"不支持的源语言：{body.source_lang}")
        loc["source_lang"] = body.source_lang
    try:
        cues = localize.apply_cue_edits(transcript.get("cues") or [], [c.model_dump() for c in body.cues], "text")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    now = iso(utcnow())
    loc["transcript"] = {**transcript, "cues": cues, "updated_at": now}
    for version in versions.values():
        if version.get("cues"):
            version["stale"] = True
            version["updated_at"] = now
    loc["versions"] = versions
    video.localization = loc
    video.updated_at = utcnow()
    db.commit()
    return video_out(video, jobs_for_videos(db, [video.id]))


@router.put("/videos/{video_id}/localize/versions/{lang}", response_model=VideoOut, status_code=202)
def update_version(video_id: str, lang: str, body: VersionCuesIn, db: Session = Depends(get_db)):
    """Edit the translation and / or change the voice (or dub a translate-only version), then run only TTS + mix."""
    video = get_video_or_404(db, video_id)
    if lang not in localize.LANGS:
        raise HTTPException(400, f"不支持的目标语言：{lang}")
    previous = copy.deepcopy(video.localization) if video.localization else None
    loc = copy.deepcopy(previous) if previous else {}
    version = (loc.get("versions") or {}).get(lang)
    if not version or not version.get("cues"):
        raise HTTPException(400, "该版本还没有译文，请先生成")
    # No voice-over yet (translated only) or an outdated one: an empty body means "dub it as it is" (HIG-56).
    undubbed = not version.get("voice_asset_id") or bool(version.get("voice_stale"))
    if not body.cues and body.voice is None and body.use_source_voice is None and not undubbed:
        raise HTTPException(400, "没有改动：请修改译文或选择音色")
    if _active(version) or _active(loc.get("transcript")):
        raise HTTPException(409, "这个版本正在生成中，请等它完成")
    # None keeps whatever this version used last time — unless a voice was picked, which is
    # how the version row switches a cloned version back to a system voice (HIG-58).
    source_voice = (bool(version.get("source_voice")) and body.voice is None) if body.use_source_voice is None else body.use_source_voice
    if source_voice:
        _require_clonable([lang])
    voice = version.get("voice")
    if source_voice:
        voice = ""  # the task fills it in from clone_voice
    elif body.voice is not None or version.get("source_voice"):
        # Switching back off the cloned voice with no voice given falls back to the default.
        try:
            voice = localize.resolve_voice(lang, body.voice, localize.voice_table(settings))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    try:
        old_cue_asset_ids = list(dict.fromkeys([
            *(version.get("old_cue_asset_ids") or []),
            *(str(c["voice_asset_id"]) for c in version["cues"] if c.get("voice_asset_id")),
        ]))
        cues = localize.apply_cue_edits(version["cues"], [c.model_dump() for c in body.cues], "translated")
        # About to re-synthesise: the old voice-over windows no longer describe this text (HIG-36).
        cues = localize.with_placements(cues, [])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    _require_enabled()
    version.update(
        status=LOC_QUEUED,
        stage=localize.STAGE_TTS,
        dub=True,
        voice=voice,
        source_voice=source_voice,
        cues=cues,
        old_cue_asset_ids=old_cue_asset_ids,
        error=None,
        warnings=[],
        adaptive_timing=False,
        timeline_duration=None,
        updated_at=iso(utcnow()),
    )
    pending = dict(loc.get("pending") or {})
    carried = [l for l in pending.get("target_langs") or [] if l != lang and _active(loc["versions"].get(l))]
    loc["pending"] = {"target_langs": [*carried, lang], "retranscribe": bool(pending.get("retranscribe") and carried)}
    return _queue(db, video, previous, loc)


@router.delete("/videos/{video_id}/localize/versions/{lang}", status_code=204)
def delete_version(video_id: str, lang: str, db: Session = Depends(get_db)) -> None:
    """Drop one language version together with its dubbed asset."""
    video = get_video_or_404(db, video_id)
    loc = copy.deepcopy(video.localization) if video.localization else {}
    versions = loc.get("versions") or {}
    version = versions.get(lang)
    if version is None:
        raise HTTPException(404, "没有这个语言版本")
    if _active(version):
        raise HTTPException(409, "这个版本正在生成中，请等它完成再删除")
    for asset_id in localize.previous_voice_asset_ids(loc, [lang]):
        asset = db.get(Asset, asset_id)
        if asset is not None:
            storage.remove_file(storage.asset_path(asset.id, asset.ext))
            db.delete(asset)
    del versions[lang]
    loc["versions"] = versions
    pending = dict(loc.get("pending") or {})
    if pending:
        pending["target_langs"] = [l for l in pending.get("target_langs") or [] if l != lang]
        loc["pending"] = pending
    video.localization = loc
    video.updated_at = utcnow()
    db.commit()

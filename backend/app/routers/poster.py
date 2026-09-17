"""Poster (大字报, HIG-50): POST /api/tts (read copy aloud → derived audio asset), GET /api/tts/preview/{lang}/{voice}
(one cached sentence per voice, HIG-42), POST /api/highlight (contract §3)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app import ids, worker
from app.config import settings
from app.db import get_db
from app.models import ASSET_AUDIO, ASSET_PREPARING, ASSET_SOURCE_DERIVED, Asset
from app.routers._common import enqueue_or_503
from app.routers.localize import _require_enabled
from app.schemas import AssetOut, HighlightIn, HighlightOut, TtsIn
from app.serializers import asset_out
from app.services import highlight, localize, tts
from app.services.tts import STEM_TTS

router = APIRouter(prefix="/api", tags=["poster"])

NAME_CHARS = 20
EXCERPT_CHARS = 40
PREVIEW_CACHE_CONTROL = "public, max-age=86400"


def _require_voice(lang: str, voice: str) -> None:
    table = localize.voice_table(settings)
    if lang not in table or not any(v["id"] == voice for v in table[lang]):
        raise HTTPException(400, "不支持的语言或音色")


@router.post("/tts", response_model=AssetOut, status_code=202)
def synthesize_tts(body: TtsIn, db: Session = Depends(get_db)):
    """Create the audio asset as ``preparing`` and queue the synthesis; the client polls GET /api/assets/{id}."""
    _require_enabled()
    _require_voice(body.lang, body.voice)
    asset = Asset(
        id=ids.asset_id(),
        type=ASSET_AUDIO,
        kind=ASSET_AUDIO,
        status=ASSET_PREPARING,
        name=body.name or body.text[:NAME_CHARS],
        ext=localize.VOICE_EXT,
        source=ASSET_SOURCE_DERIVED,
        has_audio=True,
        derived_from={
            "stem": STEM_TTS,
            "lang": body.lang,
            "voice": body.voice,
            "speech_rate": body.speech_rate,
            "text": body.text[:EXCERPT_CHARS],  # what the library shows
            "tts_text": body.text,  # what the worker reads aloud
        },
    )
    db.add(asset)
    # Commit before publishing so the worker always finds the row.
    db.commit()
    try:
        enqueue_or_503(worker.synthesize_tts, asset.id)
    except HTTPException:
        # Queue down: drop the row so the user can simply retry.
        db.delete(asset)
        db.commit()
        raise
    return asset_out(asset)


@router.get("/tts/preview/{lang}/{voice}", response_class=FileResponse)
def preview_tts(lang: str, voice: str) -> FileResponse:
    """Synchronous: the fixed preview sentence in this voice, synthesized once and cached on disk."""
    _require_enabled()
    _require_voice(lang, voice)
    try:
        path = tts.preview_wav(lang, voice, localize.make_providers(settings))
    except Exception as exc:  # noqa: BLE001 - vendor failures surface as a gateway error
        raise HTTPException(502, f"试听合成失败：{str(exc)[:500]}") from exc
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": PREVIEW_CACHE_CONTROL})


@router.post("/highlight", response_model=HighlightOut)
def pick_highlight(body: HighlightIn) -> dict:
    """Synchronous: the phrases worth colouring, as UTF-16 ranges into ``text``."""
    _require_enabled()
    try:
        provider = localize.make_providers(settings).highlight
        phrases = highlight.pick_highlights(body.text, body.max_phrases, provider)
    except Exception as exc:  # noqa: BLE001 - vendor / parsing failures surface as a gateway error
        raise HTTPException(502, f"重点词挑选失败：{str(exc)[:500]}") from exc
    return {"phrases": phrases}

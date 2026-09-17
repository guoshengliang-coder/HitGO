"""Read poster copy aloud into a derived audio asset (HIG-50, contract §1 / §6 ``hitgo.synthesize_tts``).

Reuses the localization stack: the same voice table / TTS providers, ``wav_duration`` and the
``mix_args`` ffmpeg command. The copy is split into ≤ 500-character sentence groups (the vendor's
per-request limit), each synthesized to ``tmp/{asset_id}.tts/{i}.wav``, then laid end to end
over a silent bed → ``{asset_id}.m4a``. The asset row carries the full copy in
``derived_from.tts_text`` (``derived_from.text`` is the short display excerpt).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ASSET_FAILED, ASSET_READY, Asset
from app.services import ffprobe, localize, storage

log = logging.getLogger(__name__)

STEM_TTS = "tts"
MAX_CHUNK_CHARS = 500
# Sentence ends (kept on the sentence); commas / spaces are only used to soften a hard split.
_SENTENCE_BREAK = re.compile(r"(?<=[。！？!?；;\n])")
_SOFT_BREAK = re.compile(r"[，,、\s]")


def tts_tmp_dir(asset_id: str) -> Path:
    """Scratch dir for one synthesis run (per-chunk wav); removed after (contract §5)."""
    return storage.tmp_dir() / f"{asset_id}.{STEM_TTS}"


def _hard_split(run: str, max_chars: int) -> list[str]:
    """A single sentence longer than the limit: cut at the last comma / space before it, else anywhere."""
    out: list[str] = []
    while len(run) > max_chars:
        head = run[:max_chars]
        cut = max((m.end() for m in _SOFT_BREAK.finditer(head)), default=0)
        if cut < max_chars // 2:
            cut = max_chars
        out.append(run[:cut].strip())
        run = run[cut:].strip()
    if run:
        out.append(run)
    return [piece for piece in out if piece]


def split_tts_text(text: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """Sentence-bounded chunks of at most ``max_chars`` characters, in order, none empty."""
    chunks: list[str] = []
    current = ""
    for sentence in _SENTENCE_BREAK.split(text or ""):
        if not sentence.strip():
            continue
        # Spacing between sentences is kept (Latin text needs it); the chunk is trimmed at the end.
        for piece in _hard_split(sentence, max_chars) if len(sentence.strip()) > max_chars else [sentence]:
            if current.strip() and len(current.strip()) + len(piece.strip()) > max_chars:
                chunks.append(current.strip())
                current = piece
            else:
                current += piece
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _synthesize(asset: Asset, providers: localize.Providers, tmp: Path, dst: Path) -> float:
    """Chunks → wav clips → one m4a; returns the probed duration. Raises on any failure."""
    info = dict(asset.derived_from or {})
    text = str(info.get("tts_text") or info.get("text") or "").strip()
    if not text:
        raise localize.LocalizeError("没有可朗读的文案")
    lang = str(info.get("lang") or "zh")
    voice = str(info.get("voice") or localize.resolve_voice(lang, None))
    model = localize.voice_model(lang, voice)
    # The contract lets speech_rate through only where the model honours it (cosyvoice).
    rate = float(info.get("speech_rate") or 1.0) if localize.supports_speech_rate(model) else 1.0

    tmp.mkdir(parents=True, exist_ok=True)
    clips: list[tuple[Path, float, float]] = []
    cursor = 0.0
    for i, chunk in enumerate(split_tts_text(text)):
        clip = tmp / f"{i:04d}.wav"
        clip.write_bytes(providers.tts.synthesize(chunk, voice, rate, model=model, lang=lang))
        seconds = localize.wav_duration(clip)
        if seconds <= 0:
            raise localize.LocalizeError(f"第 {i + 1} 段合成结果为空")
        clips.append((clip, cursor, 1.0))
        cursor += seconds
    dst.parent.mkdir(parents=True, exist_ok=True)
    localize._run(localize.mix_args(clips, cursor, dst), "拼接")  # noqa: SLF001 - same ffmpeg wrapper as the dub mix
    return float(ffprobe.probe_audio(dst)["duration"])


def _fail(db: Session, asset_id: str, message: str) -> None:
    db.rollback()
    asset = db.get(Asset, asset_id)
    if asset is None:
        return
    asset.status = ASSET_FAILED
    asset.error = message[:4000]
    db.commit()


def run_tts(db: Session, asset_id: str, providers: localize.Providers | None = None) -> None:
    """Full lifecycle for one ``POST /api/tts`` asset: preparing → ready (duration) or failed (error)."""
    asset = db.get(Asset, asset_id)
    if asset is None:
        return  # deleted while queued
    tmp = tts_tmp_dir(asset_id)
    dst = storage.asset_path(asset_id, localize.VOICE_EXT)
    try:
        duration = _synthesize(asset, providers or localize.make_providers(settings), tmp, dst)
        asset.duration = duration
        asset.has_audio = True
        asset.status = ASSET_READY
        asset.error = None
        db.commit()
    except SoftTimeLimitExceeded:
        log.warning("tts %s hit the soft time limit", asset_id)
        storage.remove_file(dst)
        _fail(db, asset_id, f"朗读合成超过 {settings.localize_timeout_seconds} 秒仍未完成，已中止")
        raise
    except Exception as exc:  # noqa: BLE001 - lands in asset.error
        log.exception("tts %s failed", asset_id)
        storage.remove_file(dst)
        _fail(db, asset_id, str(exc))
    finally:
        storage.remove_tree(tmp)

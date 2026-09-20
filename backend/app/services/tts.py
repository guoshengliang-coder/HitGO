"""Read poster copy aloud into a derived audio asset (HIG-50, contract §1 / §6 ``hitgo.synthesize_tts``).

Reuses the localization stack: the same voice table / TTS providers, ``wav_duration`` and the
``mix_args`` ffmpeg command. The copy is split into ≤ 500-character sentence groups (the vendor's
per-request limit), each synthesized to ``tmp/{asset_id}.tts/{i}.wav``, then laid end to end
over a silent bed → ``{asset_id}.m4a``. The asset row carries the full copy in
``derived_from.tts_text`` (``derived_from.text`` is the short display excerpt).
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path

from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ASSET_FAILED, ASSET_READY, Asset
from app.services import ffprobe, localize, storage

log = logging.getLogger(__name__)

STEM_TTS = "tts"
# Conservative default / the per-request limit of cosyvoice and qwen3-tts. The limit actually used
# comes from the voice's model (localize.max_tts_chars); MiniMax takes far longer texts.
MAX_CHUNK_CHARS = 500
# Everything outside this set becomes "_" in a cache file name; uniqueness rests on the hash. The
# dot is deliberately not allowed, so a sanitized name can never contain "..".
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9_-]")
# Sentence/clause ends (kept on the chunk). Clause-sized requests avoid a vendor returning a
# successful but audibly truncated long utterance, and give the poster an actual progress clock.
_SENTENCE_BREAK = re.compile(r"(?<=[。！？!?；;，,、：:\n])")
_SOFT_BREAK = re.compile(r"[，,、\s]")
MAX_SYNC_CHARS = 120


def tts_tmp_dir(asset_id: str) -> Path:
    """Scratch dir for one synthesis run (per-chunk wav); removed after (contract §5)."""
    return storage.tmp_dir() / f"{asset_id}.{STEM_TTS}"


# --- voice preview (GET /api/tts/preview/{lang}/{voice}, HIG-42) ---------------------

# One fixed sentence per language so a preview is the same for every user and can be cached per
# voice; anything not listed falls back to English (the qwen3 voices speak all their languages).
PREVIEW_TEXT: dict[str, str] = {
    "zh": "你好，我是这条视频的配音，欢迎试听我的声音。",
    "yue": "你好，我係呢條片嘅配音，歡迎試聽我把聲。",
    "en": "Hi there, this is how I sound reading your video.",
    "ja": "こんにちは、この動画のナレーションを担当します。",
    "ko": "안녕하세요, 이 영상의 내레이션을 맡았습니다.",
    "id": "Halo, beginilah suara saya saat membacakan video Anda.",
    "es": "Hola, así sueno leyendo tu vídeo.",
    "pt": "Olá, é assim que eu soo lendo o seu vídeo.",
    "fr": "Bonjour, voici ma voix pour lire votre vidéo.",
    "de": "Hallo, so klinge ich, wenn ich Ihr Video vorlese.",
    "it": "Ciao, ecco come suono leggendo il tuo video.",
    "ru": "Здравствуйте, вот как звучит мой голос в вашем видео.",
    # Thai / Vietnamese / Arabic only have MiniMax voices (HIG-59). The Arabic line is written in
    # logical order (Python does not care about display direction) and keeps Latin words out, so an
    # editor showing it right-to-left cannot tempt anyone into "fixing" it into something wrong.
    "th": "สวัสดีค่ะ นี่คือเสียงพากย์สำหรับวิดีโอของคุณ",
    "vi": "Xin chào, đây là giọng đọc cho video của bạn.",
    "ar": "مرحبا، هذا هو صوتي عند قراءة الفيديو الخاص بك.",
}
PREVIEW_DIR = "tts-preview"


def preview_text(lang: str) -> str:
    return PREVIEW_TEXT.get(lang) or PREVIEW_TEXT["en"]


def _safe_name(value: str, fallback: str) -> str:
    """``value`` reduced to characters that are safe in a file name, or ``fallback`` if nothing is left."""
    return _UNSAFE_NAME.sub("_", value)[:40] or fallback


def preview_path(lang: str, voice: str, model: str) -> Path:
    """Cache file under ``data/tts-preview/`` (contract §5); the hash ties it to voice + model +
    sentence, so changing any of them simply produces a new file and the old one becomes dead
    weight to clean.

    ``lang`` and ``voice`` arrive from the request path, and a MiniMax voice id is not tame:
    ``Chinese (Mandarin)_Sweet_Lady``, ``Cantonese_ProfessionalHost（F)``, an emotion variant's
    ``~happy``. They are sanitized for the visible part of the name, and the raw voice id goes into
    the hash — so two ids that sanitize to the same string still get two different files.
    """
    digest = hashlib.sha1(f"{voice}\n{model}\n{preview_text(lang)}".encode()).hexdigest()[:8]  # noqa: S324 - cache key, not security
    return storage.data_dir() / PREVIEW_DIR / f"{_safe_name(lang, 'lang')}-{_safe_name(voice, 'voice')}-{digest}.wav"


def preview_wav(lang: str, voice: str, providers: localize.Providers) -> Path:
    """The cached preview wav for one voice, synthesizing it on first use. Raises on vendor failure."""
    spec = localize.voice_spec(lang, voice)
    model = str(spec["model"])
    dst = preview_path(lang, voice, model)
    if dst.is_file() and dst.stat().st_size > 0:
        return dst
    data = providers.tts.synthesize(
        preview_text(lang), str(spec["voice"]), 1.0, model=model, lang=lang, emotion=spec["emotion"]
    )
    if not data:
        raise localize.LocalizeError(f"合成失败（音色 {voice}）：音频为空")
    dst.parent.mkdir(parents=True, exist_ok=True)
    # Write beside then rename: a second request for the same voice never sees a half-written file.
    part = dst.with_name(f"{dst.name}.{os.getpid()}.part")
    part.write_bytes(data)
    os.replace(part, dst)
    return dst


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


def split_tts_clauses(text: str, max_chars: int = MAX_SYNC_CHARS) -> list[str]:
    """Short, independently synthesized clauses; unlike split_tts_text, never merges them."""
    out: list[str] = []
    for clause in _SENTENCE_BREAK.split(text or ""):
        clause = clause.strip()
        if not clause:
            continue
        out.extend(_hard_split(clause, max_chars))
    return out


def _synthesize(asset: Asset, providers: localize.Providers, tmp: Path, dst: Path) -> tuple[float, list[dict[str, object]]]:
    """Clause clips → one m4a; returns duration + the measured clause clock."""
    info = dict(asset.derived_from or {})
    text = str(info.get("tts_text") or info.get("text") or "").strip()
    if not text:
        raise localize.LocalizeError("没有可朗读的文案")
    lang = str(info.get("lang") or "zh")
    voice = str(info.get("voice") or localize.resolve_voice(lang, None))
    spec = localize.voice_spec(lang, voice)
    model = str(spec["model"])
    # The contract lets speech_rate through only where the model honours it (not qwen3-tts).
    rate = float(info.get("speech_rate") or 1.0) if localize.supports_speech_rate(model) else 1.0

    tmp.mkdir(parents=True, exist_ok=True)
    clips: list[tuple[Path, float, float]] = []
    segments: list[dict[str, object]] = []
    cursor = 0.0
    for i, chunk in enumerate(split_tts_clauses(text, min(localize.max_tts_chars(model), MAX_SYNC_CHARS))):
        clip = tmp / f"{i:04d}.wav"
        clip.write_bytes(
            providers.tts.synthesize(chunk, str(spec["voice"]), rate, model=model, lang=lang, emotion=spec["emotion"])
        )
        seconds = localize.wav_duration(clip)
        if seconds <= 0:
            raise localize.LocalizeError(f"第 {i + 1} 段合成结果为空")
        clips.append((clip, cursor, 1.0))
        segments.append({"text": chunk, "start": round(cursor, 3), "end": round(cursor + seconds, 3)})
        cursor += seconds
    dst.parent.mkdir(parents=True, exist_ok=True)
    localize._run(localize.mix_args(clips, cursor, dst), "拼接")  # noqa: SLF001 - same ffmpeg wrapper as the dub mix
    duration = float(ffprobe.probe_audio(dst)["duration"])
    if duration <= 0 or len(segments) != len(clips):
        raise localize.LocalizeError("朗读拼接结果不完整")
    return duration, segments


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
        duration, segments = _synthesize(asset, providers or localize.make_providers(settings), tmp, dst)
        asset.duration = duration
        asset.derived_from = {**dict(asset.derived_from or {}), "segments": segments}
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

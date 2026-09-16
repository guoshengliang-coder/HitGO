"""Localization: one transcript template, one dubbed version per target language (contract §1 / §3 / §6).

Runs on the default worker queue — every heavy step is a network call to Alibaba DashScope
(``dashscope_providers``), so it never touches torch or the separator image. The pure
helpers (argv builders, cue bookkeeping, placement planning) stay unit-testable without
ffmpeg or the vendor SDK; the ``Fake*`` providers let the whole lifecycle run in tests.

Pipeline (``run_localization``), driven by ``Video.localization.pending``:
    source.mp4 → ffmpeg → 16 kHz mono wav → ASR → transcript.cues (source timeline, seconds)
    per target language:
        transcript texts → MT (one numbered block, per-sentence fallback) → version.cues
        each translated cue → TTS → wav clip → placed at the cue's source start (atempo ≤ max)
        clips → ffmpeg amix over a silent bed → {asset_id}.m4a → Asset(source = derived, stem = dubbed)
"""

from __future__ import annotations

import copy
import io
import logging
import re
import subprocess
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy.orm import Session

from app import ids
from app.config import Settings, settings
from app.db import iso, utcnow
from app.models import (
    ASSET_AUDIO,
    ASSET_READY,
    ASSET_SOURCE_DERIVED,
    LOC_DONE,
    LOC_FAILED,
    LOC_QUEUED,
    LOC_RUNNING,
    Asset,
    Video,
)
from app.services import storage

log = logging.getLogger(__name__)

ASR_SAMPLE_RATE = 16000
MIX_SAMPLE_RATE = 44100
VOICE_EXT = "m4a"
VOICE_BITRATE = "192k"
MAX_CUES = 400
STAGE_TRANSLATE = "translate"
STAGE_TTS = "tts"
STAGE_MIX = "mix"
STEM_DUBBED = "dubbed"
AUTO = "auto"
# CosyVoice speech_rate range; a clip longer than its slot is re-synthesized faster before atempo.
MAX_SPEECH_RATE = 2.0
MT_DOMAINS = (
    "Voice-over script for a short marketing video. Translate naturally and concisely so that "
    "each numbered line, when spoken aloud, takes about as long as the source line."
)


class LocalizeError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# languages and voices
# ---------------------------------------------------------------------------

# code → label (UI), mt_name (Qwen-MT wants English full names), asr (Paraformer v2 can
# transcribe it), font_hint (subtitle font the frontend should prefer).
LANGS: dict[str, dict[str, Any]] = {
    "zh": {"label": "中文", "mt_name": "Chinese", "asr": True, "font_hint": "Noto Sans SC"},
    "en": {"label": "英语", "mt_name": "English", "asr": True, "font_hint": "Noto Sans SC"},
    "ja": {"label": "日语", "mt_name": "Japanese", "asr": True, "font_hint": "Noto Sans JP"},
    "ko": {"label": "韩语", "mt_name": "Korean", "asr": True, "font_hint": "Noto Sans KR"},
    "yue": {"label": "粤语", "mt_name": "Cantonese", "asr": True, "font_hint": "Noto Sans SC"},
    "de": {"label": "德语", "mt_name": "German", "asr": True, "font_hint": "Noto Sans SC"},
    "fr": {"label": "法语", "mt_name": "French", "asr": True, "font_hint": "Noto Sans SC"},
    "ru": {"label": "俄语", "mt_name": "Russian", "asr": True, "font_hint": "Noto Sans SC"},
    "pt": {"label": "葡萄牙语", "mt_name": "Portuguese", "asr": False, "font_hint": "Noto Sans SC"},
    "th": {"label": "泰语", "mt_name": "Thai", "asr": False, "font_hint": "Noto Sans Thai"},
    "id": {"label": "印尼语", "mt_name": "Indonesian", "asr": False, "font_hint": "Noto Sans SC"},
    "vi": {"label": "越南语", "mt_name": "Vietnamese", "asr": False, "font_hint": "Noto Sans SC"},
    "es": {"label": "西班牙语", "mt_name": "Spanish", "asr": False, "font_hint": "Noto Sans SC"},
    "it": {"label": "意大利语", "mt_name": "Italian", "asr": False, "font_hint": "Noto Sans SC"},
    "ar": {"label": "阿拉伯语", "mt_name": "Arabic", "asr": False, "font_hint": "Noto Sans Arabic", "rtl": True},
}

# Which DashScope API a TTS model goes through. CosyVoice / Qwen-Audio-TTS use the
# tts_v2 SpeechSynthesizer (has speech_rate); Qwen3-TTS uses MultiModalConversation and
# returns a URL (no speech_rate: the atempo step covers overruns).
QWEN3_TTS_PREFIX = "qwen3-tts"
# Qwen3-TTS language_type values; anything else is sent as "Auto".
QWEN3_TTS_LANGUAGE_TYPES = {"zh": "Chinese", "en": "English", "de": "German", "it": "Italian", "pt": "Portuguese", "es": "Spanish", "ja": "Japanese", "ko": "Korean", "fr": "French", "ru": "Russian"}


def tts_api_for(model: str) -> str:
    """``"qwen3"`` (MultiModalConversation, URL result) or ``"tts_v2"`` (SpeechSynthesizer bytes)."""
    return "qwen3" if model.startswith(QWEN3_TTS_PREFIX) else "tts_v2"


def supports_speech_rate(model: str) -> bool:
    return tts_api_for(model) == "tts_v2"


def language_type_for(lang: str) -> str:
    return QWEN3_TTS_LANGUAGE_TYPES.get(lang, "Auto")

# cosyvoice-v3-flash voices per language (help.aliyun.com/zh/model-studio/cosyvoice-voice-list,
# checked 2026-09-16). The first entry is the default. Languages without a confirmed voice
# (de / fr / ru / pt / th / vi / es) are not offered as targets until LOCALIZE_VOICES adds one.
DEFAULT_VOICES: dict[str, list[dict[str, str]]] = {
    "zh": [
        {"id": "longxiaochun_v3", "label": "龙小淳（知性女）"},
        {"id": "longcheng_v3", "label": "龙橙（青年男）"},
        {"id": "loongbella_v3", "label": "Bella（干练女）"},
    ],
    "en": [
        {"id": "loongabby_v3", "label": "Abby（美式女）"},
        {"id": "loongandy_v3", "label": "Andy（美式男）"},
        {"id": "loongemily_v3", "label": "Emily（英式女）"},
        {"id": "loongeric_v3", "label": "Eric（英式男）"},
    ],
    "ja": [
        {"id": "loongtomoka_v3", "label": "Tomoka（日语女）"},
        {"id": "loongtomoya_v3", "label": "Tomoya（日语男）"},
        {"id": "loongyuuna_v3", "label": "Yuuna（日语女·年轻）"},
        {"id": "loongyuuma_v3", "label": "Yuuma（日语男·年轻）"},
    ],
    "ko": [
        {"id": "loongkyong_v3", "label": "Kyong（韩语女）"},
        {"id": "loongjihun_v3", "label": "Jihun（韩语男）"},
    ],
    "yue": [
        {"id": "longjiaxin_v3", "label": "龙嘉欣（粤语女）"},
        {"id": "longanyue_v3", "label": "龙安粤（粤语男）"},
    ],
    "id": [
        {"id": "loongindah_v3", "label": "Indah（印尼女）"},
    ],
    # Spanish / Portuguese / French (and German / Italian / Russian) have no CosyVoice system
    # voice; Qwen3-TTS-Flash's voices speak all ten of its languages (voice list page, 2026-09-16).
    **{
        lang: [
            {"id": "Cherry", "label": "Cherry（女·亲切）", "model": "qwen3-tts-flash"},
            {"id": "Serena", "label": "Serena（女·温柔）", "model": "qwen3-tts-flash"},
            {"id": "Ethan", "label": "Ethan（男·阳光）", "model": "qwen3-tts-flash"},
        ]
        for lang in ("es", "pt", "fr", "de", "it", "ru")
    },
}
# Voices without a "model" key belong to the configured default (LOCALIZE_TTS_MODEL, cosyvoice-v3-flash).


def source_langs() -> list[dict[str, str]]:
    """``auto`` plus every language the ASR model can transcribe (contract §3 options)."""
    out = [{"code": AUTO, "label": "自动识别"}]
    out += [{"code": code, "label": info["label"]} for code, info in LANGS.items() if info["asr"]]
    return out


def parse_voice_overrides(raw: str) -> dict[str, dict[str, str]]:
    """``LOCALIZE_VOICES="ko=loongkyong_v3,ar=loongmary@qwen-audio-3.0-tts-flash"`` → {lang: {id[, model]}}.

    ``@model`` names the TTS model the voice belongs to (defaults to LOCALIZE_TTS_MODEL). Junk is ignored.
    """
    out: dict[str, dict[str, str]] = {}
    for item in (raw or "").split(","):
        if "=" not in item:
            continue
        lang, voice = (p.strip() for p in item.split("=", 1))
        model = ""
        if "@" in voice:
            voice, model = (p.strip() for p in voice.split("@", 1))
        if lang in LANGS and voice:
            out[lang] = {"id": voice, **({"model": model} if model else {})}
    return out


def voice_table(cfg: Settings | None = None) -> dict[str, list[dict[str, str]]]:
    """Voices per target language: defaults with the env override moved to (or added at) the front.

    Each entry is ``{id, label[, model]}``; no ``model`` = the configured default TTS model.
    """
    cfg = cfg or settings
    table = {lang: list(voices) for lang, voices in DEFAULT_VOICES.items()}
    for lang, override in parse_voice_overrides(cfg.localize_voices).items():
        voice = override["id"]
        voices = [v for v in table.get(lang, []) if v["id"] != voice]
        known = next((v for v in table.get(lang, []) if v["id"] == voice), None)
        entry = dict(known) if known else {"id": voice, "label": voice}
        if override.get("model"):
            entry["model"] = override["model"]
        table[lang] = [entry, *voices]
    return {lang: table[lang] for lang in LANGS if table.get(lang)}


def voice_model(lang: str, voice: str, table: dict[str, list[dict[str, str]]] | None = None, cfg: Settings | None = None) -> str:
    """The TTS model a voice belongs to (contract §6): its own ``model`` or LOCALIZE_TTS_MODEL."""
    cfg = cfg or settings
    table = table if table is not None else voice_table(cfg)
    entry = next((v for v in table.get(lang, []) if v["id"] == voice), None)
    return str((entry or {}).get("model") or cfg.localize_tts_model)


def target_langs(cfg: Settings | None = None) -> list[dict[str, Any]]:
    return [
        {"code": lang, "label": LANGS[lang]["label"], "rtl": bool(LANGS[lang].get("rtl")), "voices": [{"id": v["id"], "label": v["label"]} for v in voices]}
        for lang, voices in voice_table(cfg).items()
    ]


def enabled(cfg: Settings | None = None) -> bool:
    cfg = cfg or settings
    return cfg.localize_provider == "fake" or bool(cfg.dashscope_api_key)


def options_out(cfg: Settings | None = None) -> dict[str, Any]:
    """Body of ``GET /api/localize/options`` (contract §3)."""
    return {"enabled": enabled(cfg), "source_langs": source_langs(), "target_langs": target_langs(cfg)}


def resolve_voice(lang: str, requested: str | None, table: dict[str, list[dict[str, str]]] | None = None) -> str:
    """The voice to synthesize ``lang`` with: the requested one (must be offered) or the default."""
    table = table if table is not None else voice_table()
    voices = table.get(lang) or []
    if not voices:
        raise ValueError(f"{LANGS.get(lang, {}).get('label', lang)} 还没有可用的音色")
    if requested is None or requested == "":
        return voices[0]["id"]
    if not any(v["id"] == requested for v in voices):
        raise ValueError(f"音色 {requested} 不适用于{LANGS[lang]['label']}")
    return requested


def mt_name(code: str) -> str:
    """Language code → the English name Qwen-MT wants; ``auto`` passes through."""
    if code == AUTO:
        return AUTO
    return str(LANGS[code]["mt_name"])


# ---------------------------------------------------------------------------
# pure helpers
# ---------------------------------------------------------------------------


def _fmt(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def extract_args(src: Path, dst: Path, ffmpeg_bin: str | None = None) -> list[str]:
    """Source audio → 16 kHz mono PCM wav, what the ASR model wants."""
    return [
        ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(src),
        "-vn", "-map", "0:a:0",
        "-ac", "1", "-ar", str(ASR_SAMPLE_RATE), "-c:a", "pcm_s16le",
        str(dst),
    ]  # fmt: skip


def wav_duration(path: Path) -> float:
    """Seconds of audio in a PCM wav (TTS clips, the ASR input).

    Measured from the bytes actually on disk, not the header: CosyVoice streams its wav and
    leaves a placeholder data size in the header (``wave`` then reports hours of audio).
    """
    with wave.open(str(path), "rb") as w:
        rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
    if not rate or not channels or not width:
        return 0.0
    data = path.read_bytes()
    pos = 12  # after "RIFF" <size> "WAVE"
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        if chunk_id == b"data":
            payload = len(data) - (pos + 8)
            return min(size, payload) / (rate * channels * width) if size else payload / (rate * channels * width)
        pos += 8 + size + (size & 1)
    return 0.0


def silent_wav(seconds: float, rate: int = 22050) -> bytes:
    """A mono 16-bit PCM wav of silence (Fake TTS, tests)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * max(0, int(round(seconds * rate))))
    return buf.getvalue()


MAX_CUE_CHARS = 60  # a subtitle line the viewer can actually read; longer ASR "sentences" get split
MAX_CUE_SECONDS = 6.0
_SENTENCE_END = ".!?。！？"
_CLAUSE_END = ",;:，；："
_ASCII_LETTER = re.compile(r"[A-Za-z]")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。！？])\s+")


def _word_text(word: dict[str, Any]) -> str:
    return (str(word.get("text") or "") + str(word.get("punctuation") or "")).strip()


def _join_words(parts: list[str]) -> str:
    if any(_ASCII_LETTER.search(p) for p in parts):
        return re.sub(r"\s+([,.;:!?])", r"\1", " ".join(parts)).strip()
    return "".join(parts).strip()


def split_sentence(sent: dict[str, Any], max_chars: int = MAX_CUE_CHARS, max_seconds: float = MAX_CUE_SECONDS) -> list[dict[str, Any]]:
    """Break one ASR sentence into subtitle-sized pieces (``begin_time`` / ``end_time`` ms, ``text``).

    Paraformer often hands back a whole ad as one "sentence" when the speaker never pauses.
    With word timestamps the cut goes at sentence-final punctuation, or at a clause break /
    any word once the piece is over ``max_chars`` / ``max_seconds``; without them the text is
    cut at sentence punctuation and the time shared out by character count.
    """
    text = str(sent.get("text") or "").strip()
    begin = float(sent.get("begin_time") or 0)
    end = float(sent.get("end_time") or begin)
    if not text:
        return []
    words = [w for w in (sent.get("words") or []) if isinstance(w, dict) and _word_text(w)]
    if words:
        pieces: list[dict[str, Any]] = []
        parts: list[str] = []
        piece_begin: float | None = None
        prev_end = begin
        hard_limit = max_chars * 1.5

        def flush(end_ms: float) -> None:
            nonlocal parts, piece_begin
            joined = _join_words(parts)
            if joined and piece_begin is not None:
                pieces.append({"begin_time": piece_begin, "end_time": end_ms, "text": joined})
            parts, piece_begin = [], None

        for k, word in enumerate(words):
            wtext = _word_text(word)
            wbegin = float(word.get("begin_time") or prev_end)
            wend = float(word.get("end_time") or wbegin)
            # A word that would push the piece past the hard limit starts a new piece instead.
            if parts and len(_join_words([*parts, wtext])) > hard_limit:
                flush(prev_end)
            if piece_begin is None:
                piece_begin = wbegin
            parts.append(wtext)
            prev_end = wend
            joined = _join_words(parts)
            last = k == len(words) - 1
            long_enough = len(joined) >= max_chars or (wend - piece_begin) / 1000.0 >= max_seconds
            if last or wtext[-1:] in _SENTENCE_END or (long_enough and wtext[-1:] in _CLAUSE_END):
                flush(wend)
        return [p for p in pieces if p["text"]]
    chunks = [c.strip() for c in _SENTENCE_SPLIT.split(text) if c.strip()]
    if len(chunks) <= 1:
        return [{"begin_time": begin, "end_time": end, "text": text}]
    total_chars = sum(len(c) for c in chunks) or 1
    pieces = []
    cursor = begin
    for c in chunks:
        span = (end - begin) * len(c) / total_chars
        pieces.append({"begin_time": cursor, "end_time": cursor + span, "text": c})
        cursor += span
    return pieces


def cues_from_sentences(sentences: list[dict[str, Any]], duration: float | None, max_cues: int = MAX_CUES) -> list[dict[str, Any]]:
    """ASR sentences (``begin_time`` / ``end_time`` ms, ``text``) → transcript cues in seconds.

    Long sentences are first cut into subtitle-sized pieces (``split_sentence``). Empty
    sentences are dropped, ends are clamped to the source duration, sentences starting
    past the end vanish, and ``i`` is renumbered so it stays a dense index.
    """
    cues: list[dict[str, Any]] = []
    pieces = [p for sent in sentences for p in split_sentence(sent)]
    for sent in sorted(pieces, key=lambda s: float(s.get("begin_time") or 0)):
        text = str(sent.get("text") or "").strip()
        if not text:
            continue
        start = max(0.0, float(sent.get("begin_time") or 0) / 1000.0)
        end = float(sent.get("end_time") or 0) / 1000.0
        if duration is not None and duration > 0:
            if start >= duration:
                continue
            end = min(end, duration)
        if end <= start:
            end = start + 0.1
        cues.append({"i": len(cues), "start": round(start, 3), "end": round(end, 3), "text": text})
        if len(cues) >= max_cues:
            break
    return cues


_NUMBERED = re.compile(r"^\s*(\d+)\s*[.．)）:：、]\s*(.*)$")


def numbered_block(texts: list[str]) -> str:
    """Sentences → one ``1. …\\n2. …`` block so the translator sees the whole context."""
    return "\n".join(f"{n}. {t.strip()}" for n, t in enumerate(texts, start=1))


def parse_numbered_block(text: str, n: int) -> list[str] | None:
    """Inverse of ``numbered_block``; None unless every number 1..n appears exactly once, in order."""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _NUMBERED.match(line)
        if m and int(m.group(1)) == len(out) + 1:
            out.append(m.group(2).strip())
        elif out:
            out[-1] = (out[-1] + " " + line).strip()  # wrapped continuation of the last one
        else:
            return None
    if len(out) != n or any(not t for t in out):
        return None
    return out


def translate_with_fallback(provider: TranslateProvider, texts: list[str], source: str, target: str, terms: list[dict[str, str]]) -> list[str]:
    """One numbered request for the whole transcript; if it comes back malformed, sentence by sentence."""
    if not texts:
        return []
    block = provider.translate(numbered_block(texts), source, target, terms)
    parsed = parse_numbered_block(block, len(texts))
    if parsed is not None:
        return parsed
    log.warning("numbered translation did not parse (%d sentences); falling back to per-sentence", len(texts))
    return [provider.translate(t, source, target, terms).strip() for t in texts]


def plan_placements(cues: list[dict[str, Any]], clip_durations: list[float], total: float, max_tempo: float) -> tuple[list[dict[str, Any]], list[str]]:
    """Where each clip goes on the source timeline.

    A clip starts at its cue's ``start``; if it would run into the next cue (or past the end),
    it is sped up with ``atempo`` up to ``max_tempo``; if that still is not enough, the overlap
    is kept and reported in ``warnings`` so the user can shorten the translation.
    """
    placements: list[dict[str, Any]] = []
    warnings: list[str] = []
    slots = cue_slots(cues, total)
    for k, cue in enumerate(cues):
        start = float(cue["start"])
        available = slots[k]
        clip = float(clip_durations[k])
        tempo = 1.0
        if clip > available > 0:
            tempo = min(max_tempo, clip / available)
        elif clip > available:  # nothing left at all (cue at the very end)
            tempo = max_tempo
        tempo = round(max(tempo, 1.0), 3)
        effective = clip / tempo if tempo else clip
        if effective > available + 0.05:
            warnings.append(
                f"第 {int(cue['i']) + 1} 句配音 {effective:.1f} 秒，超出可用的 {available:.1f} 秒"
                + (f"（已加速 {tempo:.2f}×）" if tempo > 1 else "")
                + "，建议缩短译文"
            )
        placements.append({"i": cue["i"], "start": round(start, 3), "tempo": tempo, "duration": round(effective, 3)})
    return placements, warnings


def mix_args(clips: list[tuple[Path, float, float]], total: float, dst: Path, ffmpeg_bin: str | None = None) -> list[str]:
    """One ffmpeg command: silent stereo bed of ``total`` seconds + every clip delayed to its start.

    ``clips`` = (path, start_seconds, tempo). Output: aac 192k, 44.1 kHz stereo, browser-playable.
    """
    argv = [ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    for path, _start, _tempo in clips:
        argv += ["-i", str(path)]
    chains = [f"anullsrc=r={MIX_SAMPLE_RATE}:cl=stereo,atrim=end={_fmt(total)}[bed]"]
    labels = ["[bed]"]
    for k, (_path, start, tempo) in enumerate(clips):
        steps: list[str] = []
        if abs(tempo - 1.0) > 1e-6:
            steps.append(f"atempo={_fmt(tempo)}")
        delay_ms = round(start * 1000)
        if delay_ms > 0:
            steps.append(f"adelay={delay_ms}:all=1")
        steps.append(f"aformat=sample_rates={MIX_SAMPLE_RATE}:channel_layouts=stereo")
        chains.append(f"[{k}:a]" + ",".join(steps) + f"[c{k}]")
        labels.append(f"[c{k}]")
    if clips:
        chains.append(f"{''.join(labels)}amix=inputs={len(labels)}:duration=first:normalize=0:dropout_transition=0[aout]")
    else:
        chains[0] = chains[0].replace("[bed]", "[aout]")
    argv += [
        "-filter_complex", ";".join(chains),
        "-map", "[aout]", "-c:a", "aac", "-b:a", VOICE_BITRATE, "-movflags", "+faststart",
        str(dst),
    ]  # fmt: skip
    return argv


def cue_slots(cues: list[dict[str, Any]], total: float) -> list[float]:
    """Seconds each cue may occupy: from its start to the next cue's start (the last one: to the end)."""
    slots: list[float] = []
    for k, cue in enumerate(cues):
        start = float(cue["start"])
        limit = float(cues[k + 1]["start"]) if k + 1 < len(cues) else float(total)
        slots.append(max(limit - start, 0.0))
    return slots


def speech_rate_for(clip_seconds: float, slot_seconds: float, max_rate: float = MAX_SPEECH_RATE) -> float:
    """Faster synthesis rate that would fit ``clip_seconds`` into ``slot_seconds``; 1.0 = already fits."""
    if slot_seconds <= 0 or clip_seconds <= slot_seconds:
        return 1.0
    return round(min(max_rate, clip_seconds / slot_seconds), 2)


def voice_name(video_name: str, lang: str) -> str:
    """Asset name shown in the library: ``V01 新手引导A · 韩语配音.m4a``."""
    base = Path(video_name).stem or video_name
    label = LANGS.get(lang, {}).get("label", lang)
    return f"{base} · {label}配音.{VOICE_EXT}"


def previous_voice_asset_ids(localization: dict[str, Any] | None, langs: list[str] | None = None) -> list[str]:
    """Dubbed asset ids of the given (default: all) versions — what a re-run replaces / a delete removes."""
    if not localization:
        return []
    versions = localization.get("versions") or {}
    out: list[str] = []
    for lang, version in versions.items():
        if langs is not None and lang not in langs:
            continue
        if version and version.get("voice_asset_id"):
            out.append(str(version["voice_asset_id"]))
    return out


def apply_cue_edits(cues: list[dict[str, Any]], edits: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Return ``cues`` with ``key`` replaced per ``edits`` (matched on ``i``); unknown ``i`` → ValueError."""
    by_i = {int(c["i"]): dict(c) for c in cues}
    for edit in edits:
        i = int(edit["i"])
        if i not in by_i:
            raise ValueError(f"没有第 {i + 1} 句")
        by_i[i][key] = str(edit[key]).strip()
    return [by_i[i] for i in sorted(by_i)]


# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------


@dataclass
class AsrResult:
    sentences: list[dict[str, Any]]
    lang: str | None = None  # detected language when the model reports one


class AsrProvider(Protocol):
    def transcribe(self, wav: Path, lang: str | None) -> AsrResult: ...


class TranslateProvider(Protocol):
    def translate(self, text: str, source: str, target: str, terms: list[dict[str, str]]) -> str: ...


class TtsProvider(Protocol):
    def synthesize(self, text: str, voice: str, speech_rate: float = 1.0, *, model: str | None = None, lang: str | None = None) -> bytes: ...


@dataclass
class Providers:
    asr: AsrProvider
    mt: TranslateProvider
    tts: TtsProvider


@dataclass
class FakeAsr:
    sentences: list[dict[str, Any]] = field(
        default_factory=lambda: [
            {"begin_time": 420, "end_time": 2910, "text": "Welcome to HitGO."},
            {"begin_time": 3000, "end_time": 5500, "text": "Let's get started."},
        ]
    )
    lang: str | None = "en"
    calls: list[tuple[Path, str | None]] = field(default_factory=list)

    def transcribe(self, wav: Path, lang: str | None) -> AsrResult:
        self.calls.append((wav, lang))
        return AsrResult(sentences=copy.deepcopy(self.sentences), lang=self.lang)


@dataclass
class FakeTranslate:
    """``[ko] text`` per line, numbering preserved; ``broken`` returns junk (fallback tests)."""

    broken: bool = False
    calls: list[str] = field(default_factory=list)

    def translate(self, text: str, source: str, target: str, terms: list[dict[str, str]]) -> str:
        self.calls.append(text)
        if self.broken and "\n" in text:
            return "번역 실패"
        lines = []
        for line in text.splitlines():
            m = _NUMBERED.match(line)
            if m:
                lines.append(f"{m.group(1)}. [{target}] {m.group(2)}")
            else:
                lines.append(f"[{target}] {line}")
        return "\n".join(lines)


@dataclass
class FakeTts:
    seconds: float = 1.0
    fail_voices: set[str] = field(default_factory=set)
    calls: list[tuple[str, str]] = field(default_factory=list)

    models: list[str | None] = field(default_factory=list)

    def synthesize(self, text: str, voice: str, speech_rate: float = 1.0, *, model: str | None = None, lang: str | None = None) -> bytes:
        self.calls.append((text, voice) if speech_rate == 1.0 else (text, voice, speech_rate))
        self.models.append(model)
        if voice in self.fail_voices:
            raise LocalizeError(f"音色 {voice} 合成失败")
        return silent_wav(self.seconds / speech_rate)


def fake_providers() -> Providers:
    return Providers(asr=FakeAsr(), mt=FakeTranslate(), tts=FakeTts())


def make_providers(cfg: Settings | None = None) -> Providers:
    cfg = cfg or settings
    if cfg.localize_provider == "fake":
        return fake_providers()
    if cfg.localize_provider != "dashscope":
        raise LocalizeError(f"未知的 LOCALIZE_PROVIDER：{cfg.localize_provider}")
    if not cfg.dashscope_api_key:
        raise LocalizeError("没有配置 DASHSCOPE_API_KEY，无法调用百炼")
    from app.services import dashscope_providers  # noqa: PLC0415 - keeps the vendor SDK lazy

    return dashscope_providers.make_providers(cfg)


# ---------------------------------------------------------------------------
# job lifecycle
# ---------------------------------------------------------------------------


def _run(argv: list[str], what: str, timeout: int = 600) -> subprocess.CompletedProcess[bytes]:
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise LocalizeError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise LocalizeError(f"{what}超时") from exc
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-8:])
        raise LocalizeError(f"{what}失败（exit {proc.returncode}）：{tail}")
    return proc


def _save(
    db: Session,
    video: Video,
    loc: dict[str, Any],
    *,
    transcript: bool = False,
    langs: list[str] | tuple[str, ...] = (),
    stale_all: bool = False,
    clear_pending: bool = False,
) -> None:
    """Write back only the parts this task owns (the transcript and / or the given versions).

    The API keeps accepting requests while a task runs — adding another language, deleting a
    finished version — so the row is re-read and merged rather than overwritten wholesale,
    otherwise a queued language could vanish under a running task.
    """
    db.refresh(video)
    fresh: dict[str, Any] = copy.deepcopy(video.localization or {})
    fresh.setdefault("versions", {})
    if transcript:
        fresh["transcript"] = copy.deepcopy(loc["transcript"])
        fresh["source_lang"] = loc.get("source_lang", fresh.get("source_lang"))
    if stale_all:
        for version in fresh["versions"].values():
            version["stale"] = True
    for lang in langs:
        if lang in loc["versions"]:
            fresh["versions"][lang] = copy.deepcopy(loc["versions"][lang])
    if clear_pending:
        fresh.pop("pending", None)
    video.localization = fresh  # a new object so the JSON column notices
    db.commit()


def _stamp(part: dict[str, Any], **fields: Any) -> dict[str, Any]:
    part.update(fields)
    part["updated_at"] = iso(utcnow())
    return part


def transcribe(video: Video, source_lang: str, asr: AsrProvider, tmp: Path) -> tuple[list[dict[str, Any]], str]:
    """Extract the audio and run ASR; returns (cues, source language actually used)."""
    if not video.has_audio:
        raise LocalizeError("源视频没有音轨")
    if video.duration and video.duration > settings.localize_max_seconds:
        raise LocalizeError(f"源视频 {video.duration:.0f} 秒，超过改语言上限 {settings.localize_max_seconds} 秒")
    source = storage.source_path(video.batch_id, video.id, video.source_ext)
    if not source.is_file():
        raise LocalizeError("源视频文件不存在")
    tmp.mkdir(parents=True, exist_ok=True)
    wav = tmp / "asr.wav"
    _run(extract_args(source, wav), "抽取源音轨")
    result = asr.transcribe(wav, None if source_lang == AUTO else source_lang)
    cues = cues_from_sentences(result.sentences, video.duration)
    if not cues:
        raise LocalizeError("没有识别出任何语句（源音轨可能没有人声）")
    lang = source_lang
    if lang == AUTO and result.lang in LANGS:
        lang = str(result.lang)
    return cues, lang


def transcript_status(loc: dict[str, Any]) -> str | None:
    return (loc.get("transcript") or {}).get("status")


def _fail_versions(loc: dict[str, Any], langs: list[str], error: str) -> None:
    for lang in langs:
        version = loc["versions"].get(lang)
        if version is not None and version.get("status") in (LOC_QUEUED, LOC_RUNNING):
            _stamp(version, status=LOC_FAILED, stage=None, error=error)


def _build_version(db: Session, video: Video, loc: dict[str, Any], lang: str, providers: Providers, tmp: Path) -> None:
    """translate → tts → mix for one language; raises on failure (caller records it)."""
    version = loc["versions"][lang]
    transcript = loc["transcript"]
    cues = transcript.get("cues") or []
    source_lang = str(loc.get("source_lang") or AUTO)
    terms = list(version.get("terms") or [])

    if not (version.get("stage") == STAGE_TTS and version.get("cues")):
        _stamp(version, status=LOC_RUNNING, stage=STAGE_TRANSLATE, error=None)
        _save(db, video, loc, langs=[lang])
        translated = translate_with_fallback(providers.mt, [c["text"] for c in cues], mt_name(source_lang), mt_name(lang), terms)
        version["cues"] = [{"i": c["i"], "translated": t} for c, t in zip(cues, translated, strict=True)]

    _stamp(version, status=LOC_RUNNING, stage=STAGE_TTS, error=None)
    _save(db, video, loc, langs=[lang])
    translated_by_i = {int(c["i"]): str(c.get("translated") or "").strip() for c in version["cues"]}
    voice = str(version.get("voice") or resolve_voice(lang, None))
    model = voice_model(lang, voice)
    spoken: list[dict[str, Any]] = []
    clip_paths: list[Path] = []
    clip_durations: list[float] = []
    tmp.mkdir(parents=True, exist_ok=True)
    total = float(video.duration or max(float(c["end"]) for c in cues))
    slots = dict(zip((int(c["i"]) for c in cues), cue_slots(cues, total), strict=True))
    for cue in cues:
        text = translated_by_i.get(int(cue["i"]), "")
        if not text:
            continue
        clip = tmp / f"{lang}_{int(cue['i']):04d}.wav"
        clip.write_bytes(providers.tts.synthesize(text, voice, model=model, lang=lang))
        seconds = wav_duration(clip)
        # Translations often run longer than the source (Korean ≈ 2× English): ask the model to
        # speak faster before falling back to atempo, which only sounds fine up to ~1.3×.
        rate = speech_rate_for(seconds, slots[int(cue["i"])]) if supports_speech_rate(model) else 1.0
        if rate > 1.0:
            clip.write_bytes(providers.tts.synthesize(text, voice, rate, model=model, lang=lang))
            seconds = wav_duration(clip)
        spoken.append(cue)
        clip_paths.append(clip)
        clip_durations.append(seconds)
    if not spoken:
        raise LocalizeError("没有可合成的译文")

    _stamp(version, stage=STAGE_MIX)
    _save(db, video, loc, langs=[lang])
    placements, warnings = plan_placements(spoken, clip_durations, total, settings.localize_max_tempo)
    asset_id = ids.asset_id()
    dst = storage.asset_path(asset_id, VOICE_EXT)
    dst.parent.mkdir(parents=True, exist_ok=True)
    clips = [(path, p["start"], p["tempo"]) for path, p in zip(clip_paths, placements, strict=True)]
    try:
        _run(mix_args(clips, total, dst), "混音")
    except Exception:
        storage.remove_file(dst)
        raise

    # Replace last time's dubbed asset (contract §1); tracks still pointing at it get a warning.
    for old_id in previous_voice_asset_ids(loc, [lang]):
        old = db.get(Asset, old_id)
        if old is not None:
            storage.remove_file(storage.asset_path(old.id, old.ext))
            db.delete(old)
    db.add(
        Asset(
            id=asset_id,
            type=ASSET_AUDIO,
            kind=ASSET_AUDIO,
            status=ASSET_READY,
            name=voice_name(video.name, lang),
            ext=VOICE_EXT,
            source=ASSET_SOURCE_DERIVED,
            duration=video.duration,
            has_audio=True,
            derived_from={"video_id": video.id, "video_name": video.name, "stem": STEM_DUBBED, "lang": lang},
        )
    )
    _stamp(version, status=LOC_DONE, stage=None, error=None, warnings=warnings, stale=False, voice=voice, voice_asset_id=asset_id)
    _save(db, video, loc, langs=[lang])


def run_localization(db: Session, video_id: str, providers: Providers | None = None) -> None:
    """Full lifecycle for what ``localization.pending`` asks: transcript if needed, then each language.

    Every version ends done or failed on its own; the transcript failing fails all of them.
    A Celery soft time limit fails whatever is still running / queued with a readable reason.
    """
    video = db.get(Video, video_id)
    if video is None or not video.localization:
        return  # deleted (or never requested) while queued
    loc = copy.deepcopy(video.localization)
    loc.setdefault("versions", {})
    loc.setdefault("transcript", {"status": LOC_QUEUED, "error": None, "cues": []})
    pending = dict(loc.get("pending") or {})
    # Every queued version is ours: a task queued behind this one finds nothing left to do.
    langs = [lang for lang, v in loc["versions"].items() if lang in LANGS and (v or {}).get("status") == LOC_QUEUED]
    retranscribe = bool(pending.get("retranscribe"))
    needs_transcript = retranscribe or transcript_status(loc) != LOC_DONE
    tmp = storage.localize_tmp_dir(video_id)
    transcript = loc["transcript"]
    try:
        try:
            providers = providers or make_providers(settings)
        except Exception as exc:  # noqa: BLE001 - misconfiguration / missing SDK is a job failure
            log.exception("localization of %s could not start", video_id)
            message = str(exc)[:4000]
            if needs_transcript:
                _stamp(transcript, status=LOC_FAILED, error=message)
            _fail_versions(loc, langs, message)
            _save(db, video, loc, transcript=needs_transcript, langs=langs, clear_pending=True)
            return

        if needs_transcript:
            _stamp(transcript, status=LOC_RUNNING, error=None)
            _save(db, video, loc, transcript=True)
            try:
                cues, source_lang = transcribe(video, str(loc.get("source_lang") or AUTO), providers.asr, tmp)
            except SoftTimeLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001 - lands in transcript.error
                log.exception("transcription of %s failed", video_id)
                message = f"听写失败：{str(exc)[:4000]}"
                _stamp(transcript, status=LOC_FAILED, error=message)
                _fail_versions(loc, langs, message)
                _save(db, video, loc, transcript=True, langs=langs, clear_pending=True)
                return
            _stamp(transcript, status=LOC_DONE, error=None, cues=cues)
            loc["source_lang"] = source_lang
            for version in loc["versions"].values():  # every translation came from the old template
                version["stale"] = True
            _save(db, video, loc, transcript=True, stale_all=True, clear_pending=True)

        for lang in langs:
            try:
                _build_version(db, video, loc, lang, providers, tmp)
            except SoftTimeLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001 - one language failing must not stop the others
                log.exception("localization of %s to %s failed", video_id, lang)
                db.rollback()
                _stamp(loc["versions"][lang], status=LOC_FAILED, stage=None, error=str(exc)[:4000])
                _save(db, video, loc, langs=[lang])
    except SoftTimeLimitExceeded:
        log.warning("localization of %s hit the soft time limit", video_id)
        db.rollback()
        message = f"改语言超过 {settings.localize_timeout_seconds} 秒仍未完成，已中止"
        timed_out_transcript = transcript.get("status") in (LOC_QUEUED, LOC_RUNNING)
        if timed_out_transcript:
            _stamp(transcript, status=LOC_FAILED, error=message)
        _fail_versions(loc, langs, message)
        _save(db, video, loc, transcript=timed_out_transcript, langs=langs, clear_pending=True)
    finally:
        storage.remove_tree(tmp)

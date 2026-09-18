"""Independent subtitle and audio downloads for existing project media (HIG-71)."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from app.config import settings
from app.db import get_db
from app.models import Asset, Video
from app.services import storage

router = APIRouter(prefix="/api/media-export", tags=["media-export"])


class MediaExportIn(BaseModel):
    video_ids: list[str] = Field(min_length=1, max_length=50)
    kind: Literal["subtitle", "audio", "batch"]
    languages: list[str] = Field(default_factory=lambda: ["original"])
    subtitle_mode: Literal["original", "translated", "edited", "bilingual"] = "edited"
    subtitle_format: Literal["srt", "vtt", "ass", "txt", "json"] = "srt"
    audio_stem: Literal["original", "vocals", "instrumental", "dubbing", "mixed", "speaker", "selected_track"] = "original"
    audio_format: Literal["mp3", "wav", "m4a", "aac"] = "mp3"
    range_mode: Literal["whole", "selected", "in_out", "single", "speaker"] = "whole"
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, gt=0)
    selected_layer_ids: list[str] = Field(default_factory=list)
    selected_track_id: str | None = None
    speaker: str | None = None
    keep_timecodes: bool = True
    keep_speaker: bool = True
    merge_short: bool = False
    include_background: bool = True
    sample_rate: Literal[16000, 22050, 44100, 48000] = 48000
    bitrate: Literal[64, 96, 128, 192, 256, 320] = 192
    channels: Literal[1, 2] = 2
    normalize_loudness: bool = False


def _safe(value: str) -> str:
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", value).strip(" .")[:80] or "media"


def _stamp(t: float, sep: str = ",") -> str:
    ms = max(0, round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}{sep}{ms % 1000:03d}"


def _speaker(cue: dict) -> str | None:
    return str(cue.get("speaker") or cue.get("speaker_id") or "").strip() or None


def _cues(video: Video, mode: str, lang: str) -> list[dict]:
    loc = video.localization or {}
    transcript = ((loc.get("transcript") or {}).get("cues") or [])
    if mode == "edited":
        return [
            {"start": layer["t"][0], "end": layer["t"][1], "text": layer.get("text", ""),
             "speaker": layer.get("speaker"), "style": layer.get("style"), "layer_id": layer.get("id")}
            for layer in ((video.edit_spec or {}).get("layers") or [])
            if layer.get("type") == "text" and isinstance(layer.get("t"), list) and layer.get("text")
            and (layer.get("origin") in ("localize", "subtitle") or (layer.get("name") or "").startswith("字幕"))
        ]
    if mode == "original":
        return [{"start": c["start"], "end": c["end"], "text": c.get("text", ""), "speaker": _speaker(c)} for c in transcript]
    version = ((loc.get("versions") or {}).get(lang) or {})
    translations = {c.get("i"): c.get("translated", "") for c in (version.get("cues") or [])}
    if not translations:
        return []
    result = []
    for c in transcript:
        translated = translations.get(c.get("i"), "")
        if not translated:
            continue
        source = c.get("text", "")
        result.append({"start": c["start"], "end": c["end"], "text": f"{source}\n{translated}" if mode == "bilingual" else translated,
                       "speaker": _speaker(c)})
    return result


def _select_cues(cues: list[dict], video: Video, req: MediaExportIn) -> list[dict]:
    selected = set(req.selected_layer_ids)
    windows = [layer["t"] for layer in ((video.edit_spec or {}).get("layers") or [])
               if layer.get("id") in selected and isinstance(layer.get("t"), list)]
    if req.range_mode in ("selected", "single") and not windows and not selected:
        raise HTTPException(400, "请先选中字幕片段")
    result = []
    for cue in cues:
        a, b = float(cue["start"]), float(cue["end"])
        if req.range_mode == "in_out" and (req.start is None or req.end is None or b <= req.start or a >= req.end):
            continue
        if req.range_mode in ("selected", "single") and not (cue.get("layer_id") in selected or any(b > x and a < y for x, y in windows)):
            continue
        if req.range_mode == "speaker" and _speaker(cue) != req.speaker:
            continue
        if req.range_mode == "in_out":
            a, b = max(a, req.start or 0), min(b, req.end or b)
        if b > a and cue.get("text"):
            result.append({**cue, "start": a, "end": b})
    result.sort(key=lambda c: (c["start"], c["end"]))
    if req.range_mode == "single":
        result = result[:1]
    if req.merge_short:
        merged = []
        for cue in result:
            if merged and merged[-1]["end"] - merged[-1]["start"] < 0.5 and cue["start"] - merged[-1]["end"] < 0.15:
                merged[-1] = {**merged[-1], "end": cue["end"], "text": merged[-1]["text"] + " " + cue["text"]}
            else:
                merged.append(cue)
        result = merged
    return result


def _subtitle_bytes(cues: list[dict], req: MediaExportIn) -> bytes:
    lines = []
    if req.subtitle_format == "json":
        payload = cues if req.keep_speaker else [{key: value for key, value in cue.items() if key != "speaker"} for cue in cues]
        return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    if req.subtitle_format == "vtt":
        lines.append("WEBVTT\n")
    if req.subtitle_format == "ass":
        def ass_color(value: str | None, fallback: str) -> str:
            raw = (value or fallback).lstrip("#")
            if not re.fullmatch(r"[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", raw):
                raw = fallback.lstrip("#")
            alpha = 255 - (int(raw[6:8], 16) if len(raw) == 8 else 255)
            return f"&H{alpha:02X}{raw[4:6]}{raw[2:4]}{raw[0:2]}".upper()

        def ass_time(value: float) -> str:
            centi = max(0, round(value * 100))
            return f"{centi // 360000:01d}:{centi // 6000 % 60:02d}:{centi // 100 % 60:02d}.{centi % 100:02d}"

        lines.extend(["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "", "[V4+ Styles]",
                      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"])
        styles: dict[str, str] = {}
        for cue in cues:
            style = cue.get("style") or {}
            key = json.dumps(style, ensure_ascii=False, sort_keys=True)
            if key in styles:
                continue
            name = f"Style{len(styles) + 1}"
            styles[key] = name
            font = re.sub(r"[,\r\n]", " ", str(style.get("font_family") or "Arial"))
            size = max(8, round(float(style.get("font_size") or 0.025) * 1920))
            foreground = ass_color(style.get("color"), "#FFFFFF")
            outline = ass_color(style.get("stroke_color"), "#000000")
            background = ass_color(style.get("background"), "#00000000")
            bold = -1 if (style.get("font_weight") or 400) >= 700 else 0
            alignment = {"left": 1, "center": 2, "right": 3}.get(style.get("align"), 2)
            lines.append(f"Style: {name},{font},{size},{foreground},{foreground},{outline},{background},{bold},0,0,0,100,100,0,0,3,2,0,{alignment},20,20,100,1")
        lines.extend(["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"])
        for cue in cues:
            style_name = styles[json.dumps(cue.get("style") or {}, ensure_ascii=False, sort_keys=True)]
            speaker = re.sub(r"[,\r\n]", " ", _speaker(cue) or "") if req.keep_speaker else ""
            content = cue["text"].replace("{", r"\{").replace("\n", r"\N")
            lines.append(f"Dialogue: 0,{ass_time(cue['start'])},{ass_time(cue['end'])},{style_name},{speaker},0,0,0,,{content}")
        return ("\n".join(lines) + "\n").encode("utf-8")
    for i, cue in enumerate(cues, 1):
        speaker = _speaker(cue) if req.keep_speaker else None
        text = (f"{speaker}: " if speaker else "") + cue["text"]
        if req.subtitle_format == "txt":
            lines.append((f"[{_stamp(cue['start'])} → {_stamp(cue['end'])}] " if req.keep_timecodes else "") + text)
        else:
            if req.subtitle_format == "srt":
                lines.append(str(i))
            sep = "." if req.subtitle_format == "vtt" else ","
            lines.append(f"{_stamp(cue['start'], sep)} --> {_stamp(cue['end'], sep)}")
            lines.append(text)
            lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _asset_path(db: Session, asset_id: str | None) -> Path | None:
    asset = db.get(Asset, asset_id) if asset_id else None
    if not asset or asset.status != "ready":
        return None
    path = storage.asset_path(asset.id, asset.ext)
    return path if path.is_file() else None


def _audio_inputs(db: Session, video: Video, req: MediaExportIn, lang: str) -> list[Path]:
    loc = video.localization or {}
    sep = video.separation or {}
    source = storage.source_path(video.batch_id, video.id, video.source_ext)
    if req.audio_stem in ("original", "speaker"):
        return [source] if video.has_audio and source.is_file() else []
    if req.audio_stem in ("vocals", "instrumental"):
        path = _asset_path(db, sep.get(f"{req.audio_stem}_asset_id"))
        return [path] if path else []
    if req.audio_stem == "selected_track":
        track = next((t for t in ((video.edit_spec or {}).get("audio") or {}).get("tracks", []) if t.get("id") == req.selected_track_id), None)
        path = _asset_path(db, track.get("asset_id") if track else None)
        return [path] if path else []
    version = ((loc.get("versions") or {}).get(lang) or {})
    voice = _asset_path(db, version.get("voice_asset_id"))
    if not voice:
        return []
    if req.audio_stem == "mixed" and req.include_background:
        bg = _asset_path(db, sep.get("instrumental_asset_id"))
        return [voice, bg] if bg else []
    return [voice]


def _render_audio(db: Session, video: Video, req: MediaExportIn, lang: str, out: Path) -> bool:
    inputs = _audio_inputs(db, video, req, lang)
    if not inputs:
        return False
    argv = [settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y"]
    for path in inputs:
        argv += ["-i", str(path)]
    if req.range_mode == "in_out":
        if req.start is None or req.end is None or req.end <= req.start:
            raise HTTPException(400, "入点和出点必须形成有效区间")
        if req.audio_stem != "speaker":
            argv += ["-ss", str(req.start), "-t", str(req.end - req.start)]
    filters = []
    if req.audio_stem == "speaker" or req.range_mode == "speaker":
        cues = [c for c in _cues(video, "original", "original") if _speaker(c) == req.speaker]
        if req.range_mode == "in_out" and req.start is not None and req.end is not None:
            cues = [{**c, "start": max(c["start"], req.start), "end": min(c["end"], req.end)}
                    for c in cues if c["end"] > req.start and c["start"] < req.end]
        if not cues:
            return False
        parts = []
        for i, cue in enumerate(cues):
            filters.append(f"[0:a]atrim=start={cue['start']}:end={cue['end']},asetpts=PTS-STARTPTS[s{i}]")
            parts.append(f"[s{i}]")
        filters.append("".join(parts) + f"concat=n={len(parts)}:v=0:a=1[mixed]")
    elif req.range_mode in ("selected", "single"):
        spec = video.edit_spec or {}
        track = next((t for t in ((spec.get("audio") or {}).get("tracks") or []) if t.get("id") == req.selected_track_id), None)
        if req.audio_stem == "selected_track":
            if not track:
                raise HTTPException(400, "请先选中音频片段")
            window = track.get("t")
            if isinstance(window, list):
                offset = float(track.get("offset") or 0)
                windows = [(offset, offset + float(window[1]) - float(window[0]))]
            else:
                windows = []  # Full-length track, already selected.
        else:
            selected = set(req.selected_layer_ids)
            windows = [tuple(layer["t"]) for layer in (spec.get("layers") or [])
                       if layer.get("id") in selected and isinstance(layer.get("t"), list)]
            if track and isinstance(track.get("t"), list):
                windows.append(tuple(track["t"]))
            if not windows:
                raise HTTPException(400, "请先选中字幕或音频片段")
        windows = sorted((max(0, float(a)), float(b)) for a, b in windows if b > a)
        if req.range_mode == "single":
            windows = windows[:1]
        if windows:
            input_label = "[0:a]"
            if len(inputs) > 1:
                filters.append("[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[base]")
                input_label = "[base]"
            parts = []
            for i, (start, end) in enumerate(windows):
                filters.append(f"{input_label}atrim=start={start}:end={end},asetpts=PTS-STARTPTS[s{i}]")
                parts.append(f"[s{i}]")
            filters.append("".join(parts) + f"concat=n={len(parts)}:v=0:a=1[mixed]")
    elif len(inputs) > 1:
        filters.append("[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[mixed]")
    if filters:
        output = "[mixed]"
        if req.normalize_loudness:
            filters.append("[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[normalized]")
            output = "[normalized]"
        argv += ["-filter_complex", ";".join(filters), "-map", output]
    else:
        argv += ["-map", "0:a:0"]
    if req.normalize_loudness and not filters:
        argv += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
    codec = {"mp3": "libmp3lame", "wav": "pcm_s16le", "m4a": "aac", "aac": "aac"}[req.audio_format]
    argv += ["-vn", "-ac", str(req.channels), "-ar", str(req.sample_rate), "-c:a", codec]
    if req.audio_format != "wav":
        argv += ["-b:a", f"{req.bitrate}k"]
    argv += [str(out)]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=600, check=False)
    if result.returncode:
        raise HTTPException(422, f"音频导出失败：{result.stderr[-400:]}")
    return out.is_file() and out.stat().st_size > 0


@router.post("/files")
def export_files(req: MediaExportIn, db: Session = Depends(get_db)) -> FileResponse:
    videos = [db.get(Video, video_id) for video_id in req.video_ids]
    if any(video is None or video.status != "ready" for video in videos):
        raise HTTPException(400, "所选视频不存在或尚未就绪")
    if req.range_mode == "speaker" and not req.speaker:
        raise HTTPException(400, "请选择说话人")
    storage.tmp_dir().mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="media-export-", dir=storage.tmp_dir()))
    try:
        paths: list[Path] = []
        for video in videos:
            assert video is not None
            available = list(((video.localization or {}).get("versions") or {}).keys())
            languages = ["original", *available] if "all" in req.languages else req.languages
            subtitle_languages = ["original"] if req.subtitle_mode in ("original", "edited") else languages
            audio_languages = ["original"] if req.audio_stem in ("original", "vocals", "instrumental", "speaker", "selected_track") else languages
            for lang in dict.fromkeys([*subtitle_languages, *audio_languages]):
                stem = _safe(f"{video.name}_{video.id[:8]}_{lang}")
                if req.kind in ("subtitle", "batch") and lang in subtitle_languages:
                    mode = req.subtitle_mode if lang != "original" else ("original" if req.subtitle_mode in ("translated", "bilingual") else req.subtitle_mode)
                    cues = _select_cues(_cues(video, mode, lang), video, req)
                    if cues:
                        path = tmp / f"{stem}_{mode}.{req.subtitle_format}"
                        path.write_bytes(_subtitle_bytes(cues, req))
                        paths.append(path)
                if req.kind in ("audio", "batch") and lang in audio_languages:
                    path = tmp / f"{stem}_{req.audio_stem}.{req.audio_format}"
                    if _render_audio(db, video, req, lang, path):
                        paths.append(path)
        if not paths:
            raise HTTPException(422, "所选范围没有可导出的字幕或音频；请确认已生成对应语言、轨道或说话人数据")
        archive = tmp / "HitGO_media.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            used: set[str] = set()
            for path in paths:
                name = path.name
                i = 2
                while name in used:
                    name = f"{path.stem}_{i}{path.suffix}"
                    i += 1
                used.add(name)
                zf.write(path, name)
        return FileResponse(archive, media_type="application/zip", filename="HitGO_media.zip", background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True))
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

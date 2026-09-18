"""Independent subtitle exports preserve language, time and metadata."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import wave
import zipfile

import pytest

from app.routers.media_export import MediaExportIn, _subtitle_bytes
from app.services import storage


@pytest.mark.parametrize("format,marker", [
    ("srt", "00:00:00,000 --> 00:00:01,250"),
    ("vtt", "WEBVTT"),
    ("ass", "Dialogue: 0,"),
    ("txt", "你好"),
    ("json", '"speaker": "A"'),
])
def test_subtitle_formats(format, marker):
    req = MediaExportIn(video_ids=["video"], kind="subtitle", subtitle_format=format)
    data = _subtitle_bytes([{"start": 0, "end": 1.25, "text": "你好", "speaker": "A", "style": {"color": "#FFFFFF"}}], req)
    assert marker in data.decode("utf-8")


def test_export_original_translated_and_bilingual(client, ready_video, db):
    ready_video.localization = {
        "source_lang": "en",
        "transcript": {"status": "done", "cues": [{"i": 1, "start": 0, "end": 1, "text": "Hello", "speaker": "A"}]},
        "versions": {"es": {"status": "done", "cues": [{"i": 1, "translated": "Hola"}]}},
    }
    db.commit()
    for mode, expected in (("original", "Hello"), ("translated", "Hola"), ("bilingual", "Hello\nHola")):
        response = client.post("/api/media-export/files", json={"video_ids": [ready_video.id], "kind": "subtitle", "languages": ["es"], "subtitle_mode": mode, "subtitle_format": "json"})
        assert response.status_code == 200, response.text
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            payload = json.loads(archive.read(archive.namelist()[0]))
            assert expected == payload[0]["text"]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires FFmpeg")
def test_audio_export_transcodes_and_cuts_real_source(client, ready_video, db):
    source = storage.source_path(ready_video.batch_id, ready_video.id, ready_video.source_ext)
    source.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", str(source)], check=True)
    ready_video.has_audio = True
    db.commit()
    response = client.post("/api/media-export/files", json={
        "video_ids": [ready_video.id], "kind": "audio", "languages": ["original"], "audio_stem": "original",
        "audio_format": "wav", "range_mode": "in_out", "start": 0.2, "end": 0.8,
        "sample_rate": 44100, "channels": 1,
    })
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        with wave.open(io.BytesIO(archive.read(archive.namelist()[0]))) as result:
            assert result.getframerate() == 44100
            assert result.getnchannels() == 1
            assert 0.55 < result.getnframes() / result.getframerate() < 0.65


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires FFmpeg")
def test_audio_export_selected_subtitle_ranges(client, ready_video, db):
    source = storage.source_path(ready_video.batch_id, ready_video.id, ready_video.source_ext)
    source.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", str(source)], check=True)
    ready_video.has_audio = True
    ready_video.edit_spec = {"layers": [
        {"id": "one", "type": "text", "t": [0.2, 0.5], "text": "one"},
        {"id": "two", "type": "text", "t": [1.0, 1.4], "text": "two"},
    ]}
    db.commit()
    response = client.post("/api/media-export/files", json={
        "video_ids": [ready_video.id], "kind": "audio", "audio_stem": "original",
        "audio_format": "wav", "range_mode": "selected", "selected_layer_ids": ["one", "two"],
    })
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        with wave.open(io.BytesIO(archive.read(archive.namelist()[0]))) as result:
            assert 0.65 < result.getnframes() / result.getframerate() < 0.75

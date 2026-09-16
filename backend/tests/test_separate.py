"""Vocals / instrumental separation (contract §1 / §3 / §6): pure helpers, job lifecycle, API."""

from __future__ import annotations

from pathlib import Path

import pytest

from app import worker
from app.models import Asset, Video
from app.services import separate, storage
VIDEO = "v_test000001"

# --- pure helpers -------------------------------------------------------------------


def test_decode_and_encode_args_are_raw_float_pcm_at_44k_stereo():
    dec = separate.decode_args(Path("/data/src.mp4"), "ffmpeg")
    assert dec[-1] == "-" and dec[dec.index("-f") + 1] == "f32le"
    assert dec[dec.index("-ar") + 1] == "44100" and dec[dec.index("-ac") + 1] == "2" and "-vn" in dec
    enc = separate.encode_args(Path("/data/assets/a_x.m4a"), "ffmpeg")
    assert enc[enc.index("-i") + 1] == "-" and enc[enc.index("-c:a") + 1] == "aac"
    assert enc[enc.index("-b:a") + 1] == "192k" and enc[-1] == "/data/assets/a_x.m4a"


def test_stem_names_and_instrumental_sum():
    assert separate.stem_name("V01 新手引导A.mp4", "vocals") == "V01 新手引导A · 人声.m4a"
    assert separate.stem_name("口播", "instrumental") == "口播 · 伴奏.m4a"
    assert separate.instrumental_from({"drums": 1, "bass": 2, "other": 4, "vocals": 8}) == 7
    with pytest.raises(separate.SeparationError):
        separate.instrumental_from({"vocals": 8})


def test_previous_stem_asset_ids():
    assert separate.previous_stem_asset_ids(None) == []
    assert separate.previous_stem_asset_ids({"status": "failed"}) == []
    sep = {"status": "done", "vocals_asset_id": "a_v", "instrumental_asset_id": "a_i"}
    assert separate.previous_stem_asset_ids(sep) == ["a_v", "a_i"]


# --- job lifecycle (model stubbed) -------------------------------------------------


def fake_stems(source: Path, model: str, out: separate.StemFiles) -> None:
    for path in (out.vocals, out.instrumental):
        path.write_bytes(b"\x00" * 64)


def test_run_separation_creates_two_derived_assets_and_replaces_the_previous_pair(ready_video, db, monkeypatch):
    monkeypatch.setattr(separate, "separate_stems", fake_stems)
    video = db.get(Video, VIDEO)
    # Leftovers from a previous run: they must be deleted, files included.
    old = Asset(id="a_oldvocal", type="audio", kind="audio", status="ready", name="old.m4a", ext="m4a", source="derived")
    old_path = storage.asset_path(old.id, "m4a")
    old_path.parent.mkdir(parents=True, exist_ok=True)
    old_path.write_bytes(b"old")
    db.add(old)
    video.separation = {"status": "queued", "model": "htdemucs", "vocals_asset_id": "a_oldvocal", "instrumental_asset_id": "a_gone"}
    db.commit()

    separate.run_separation(db, VIDEO)
    db.expire_all()
    video = db.get(Video, VIDEO)
    sep = video.separation
    assert sep["status"] == "done" and sep["error"] is None and sep["model"] == "htdemucs" and sep["updated_at"]
    vocals = db.get(Asset, sep["vocals_asset_id"])
    inst = db.get(Asset, sep["instrumental_asset_id"])
    assert vocals.type == "audio" and vocals.kind == "audio" and vocals.status == "ready" and vocals.source == "derived"
    assert vocals.name == "V01 · 人声.m4a" and inst.name == "V01 · 伴奏.m4a"
    assert vocals.duration == 24.6 and vocals.has_audio is True and vocals.ext == "m4a"
    assert vocals.derived_from == {"video_id": VIDEO, "video_name": "V01.mp4", "stem": "vocals"}
    assert inst.derived_from["stem"] == "instrumental"
    assert storage.asset_path(vocals.id, "m4a").is_file() and storage.asset_path(inst.id, "m4a").is_file()
    assert db.get(Asset, "a_oldvocal") is None and not old_path.exists()


def test_run_separation_failure_is_recorded_and_leaves_no_files(ready_video, db, monkeypatch):
    written: list[Path] = []

    def boom(source, model, out):
        out.vocals.write_bytes(b"partial")
        written.extend([out.vocals, out.instrumental])
        raise separate.SeparationError("源音轨太短或为空")

    monkeypatch.setattr(separate, "separate_stems", boom)
    video = db.get(Video, VIDEO)
    video.separation = {"status": "queued", "model": "htdemucs_ft"}
    db.commit()
    separate.run_separation(db, VIDEO)
    db.expire_all()
    sep = db.get(Video, VIDEO).separation
    assert sep["status"] == "failed" and "太短" in sep["error"] and sep["model"] == "htdemucs_ft"
    assert db.query(Asset).count() == 0
    assert written and not any(p.exists() for p in written)


def test_run_separation_without_torch_fails_cleanly(ready_video, db, monkeypatch):
    """The api / render image has no demucs: the job must fail with a readable message, not crash."""
    import builtins

    real_import = builtins.__import__

    def no_torch(name, *args, **kwargs):
        if name in ("torch", "demucs", "demucs.api", "numpy"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_torch)
    video = db.get(Video, VIDEO)
    video.separation = {"status": "queued", "model": "htdemucs"}
    db.commit()
    separate.run_separation(db, VIDEO)
    db.expire_all()
    sep = db.get(Video, VIDEO).separation
    assert sep["status"] == "failed" and "separator" in sep["error"]


def test_worker_task_runs_the_separation(ready_video, db, monkeypatch):
    monkeypatch.setattr(separate, "separate_stems", fake_stems)
    video = db.get(Video, VIDEO)
    video.separation = {"status": "queued", "model": "htdemucs"}
    db.commit()
    worker.separate_video.run(VIDEO)
    db.expire_all()
    assert db.get(Video, VIDEO).separation["status"] == "done"
    assert worker.celery_app.conf.task_routes["hitgo.separate_video"] == {"queue": "separate"}


# --- API ------------------------------------------------------------------------------


def test_separate_endpoint_queues_and_reports_status(client, ready_video, enqueued, db):
    assert client.get(f"/api/videos/{VIDEO}").json()["separation"] is None
    r = client.post(f"/api/videos/{VIDEO}/separate", json={"model": "htdemucs_ft"})
    assert r.status_code == 202, r.text
    sep = r.json()["separation"]
    assert sep["status"] == "queued" and sep["model"] == "htdemucs_ft" and sep["vocals_asset_id"] is None
    assert enqueued.calls == [("hitgo.separate_video", (VIDEO,))]
    # Active → 409; the default model is htdemucs.
    assert client.post(f"/api/videos/{VIDEO}/separate").status_code == 409
    video = db.get(Video, VIDEO)
    video.separation = {"status": "done", "model": "htdemucs_ft", "vocals_asset_id": "a_v", "instrumental_asset_id": "a_i"}
    db.commit()
    r = client.post(f"/api/videos/{VIDEO}/separate")
    assert r.status_code == 202 and r.json()["separation"]["model"] == "htdemucs"
    # A re-run keeps last time's asset ids until the worker replaces them.
    assert r.json()["separation"]["vocals_asset_id"] == "a_v"
    assert client.post("/api/videos/v_missing/separate").status_code == 404
    assert client.post(f"/api/videos/{VIDEO}/separate", json={"model": "spleeter"}).status_code == 400


def test_separate_endpoint_rejects_silent_or_unready_videos(client, ready_video, enqueued, db):
    video = db.get(Video, VIDEO)
    video.has_audio = False
    db.commit()
    r = client.post(f"/api/videos/{VIDEO}/separate")
    assert r.status_code == 400 and "没有音轨" in r.json()["detail"]
    video.has_audio, video.status = True, "preparing"
    db.commit()
    assert client.post(f"/api/videos/{VIDEO}/separate").status_code == 400
    assert enqueued.calls == []


def test_separate_endpoint_reverts_when_the_queue_is_down(client, ready_video, monkeypatch, db):
    def down(task, *args):
        raise worker.QueueUnavailable("redis down")

    monkeypatch.setattr(worker, "enqueue", down)
    assert client.post(f"/api/videos/{VIDEO}/separate").status_code == 503
    db.expire_all()
    assert db.get(Video, VIDEO).separation is None


def test_derived_assets_are_listed_by_source_and_deletable(client, ready_video, db):
    a = Asset(id="a_stem1", type="audio", kind="audio", status="ready", name="V01 · 人声.m4a", ext="m4a",
              source="derived", duration=24.6, has_audio=True,
              derived_from={"video_id": VIDEO, "video_name": "V01.mp4", "stem": "vocals"})  # fmt: skip
    db.add(a)
    db.commit()
    path = storage.asset_path(a.id, "m4a")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"stem")
    listed = client.get("/api/assets?source=derived").json()
    assert [x["id"] for x in listed] == ["a_stem1"]
    assert listed[0]["derived_from"]["stem"] == "vocals" and listed[0]["duration"] == 24.6
    assert client.get("/api/assets?source=upload").json() == []
    assert client.get("/api/assets?source=nope").status_code == 400
    assert client.delete("/api/assets/a_stem1").status_code == 204 and not path.exists()


def test_video_can_be_deleted_while_its_stems_stay(client, ready_video, db):
    video = db.get(Video, VIDEO)
    video.separation = {"status": "done", "model": "htdemucs", "vocals_asset_id": "a_v", "instrumental_asset_id": "a_i"}
    db.add(Asset(id="a_v", type="audio", kind="audio", status="ready", name="v.m4a", ext="m4a", source="derived",
                 derived_from={"video_id": VIDEO, "video_name": "V01.mp4", "stem": "vocals"}))  # fmt: skip
    db.commit()
    assert client.delete(f"/api/videos/{VIDEO}").status_code == 204
    assert client.get("/api/assets/a_v").status_code == 200

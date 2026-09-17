"""Read-aloud synthesis (HIG-50): chunking, the run_tts lifecycle with fake providers, ffmpeg stubbed or real."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from celery.exceptions import SoftTimeLimitExceeded

from app import worker
from app.config import settings
from app.models import Asset
from app.services import ffprobe, localize, storage, tts

ASSET = "a_tts0000001"


def test_split_tts_text_keeps_sentences_whole_and_merges_up_to_the_limit():
    assert tts.split_tts_text("") == []
    assert tts.split_tts_text("   \n ") == []
    assert tts.split_tts_text("一句话没有标点") == ["一句话没有标点"]
    assert tts.split_tts_text("第一句。第二句！第三句？\n第四句", max_chars=6) == ["第一句。", "第二句！", "第三句？", "第四句"]
    assert tts.split_tts_text("第一句。第二句！第三句？\n第四句", max_chars=8) == ["第一句。第二句！", "第三句？第四句"]
    assert tts.split_tts_text("a. b; c；d!e?f", max_chars=100) == ["a. b; c；d!e?f"]
    assert tts.split_tts_text("First one. Second one! Third?", max_chars=12) == ["First one.", "Second one!", "Third?"]
    assert tts.split_tts_text("First one. Second one! Third?", max_chars=22) == ["First one. Second one!", "Third?"]
    long = "好消息" * 200  # 600 chars, no sentence end → hard split
    assert [len(c) for c in tts.split_tts_text(long)] == [500, 100]
    soft = "，".join(["abcd"] * 300)  # a comma run: the cut moves back to a comma
    chunks = tts.split_tts_text(soft)
    assert all(len(c) <= 500 for c in chunks) and "".join(chunks).replace("，", "") == "abcd" * 300


def _add_asset(db, text="第一句。第二句！", **overrides) -> Asset:
    info = {"stem": "tts", "lang": "zh", "voice": "longxiaochun_v3", "speech_rate": 1.0, "text": text[:40], "tts_text": text}
    info.update(overrides.pop("derived_from", {}))
    asset = Asset(id=ASSET, type="audio", kind="audio", status="preparing", name=text[:20], ext="m4a", source="derived",
                  has_audio=True, derived_from=info, **overrides)  # fmt: skip
    db.add(asset)
    db.commit()
    return asset


@pytest.fixture
def stub_ffmpeg(monkeypatch):
    """Stand in for the mix (writes a marker file) and for ffprobe (reports the bed length)."""
    calls: list[list[str]] = []

    def fake_run(argv, what, timeout=600):
        calls.append(argv)
        Path(argv[-1]).write_bytes(b"mix")
        return None

    def fake_probe(path):
        argv = calls[-1]
        graph = argv[argv.index("-filter_complex") + 1]
        total = float(graph.split("atrim=end=")[1].split("[")[0])
        return {"duration": total, "codec": "aac"}

    monkeypatch.setattr(localize, "_run", fake_run)
    monkeypatch.setattr(ffprobe, "probe_audio", fake_probe)
    return calls


def test_run_tts_synthesizes_each_chunk_and_marks_the_asset_ready(db, stub_ffmpeg):
    _add_asset(db, "第一句。第二句！第三句？", derived_from={"speech_rate": 1.2})
    fake = localize.FakeTts(seconds=1.5)
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=fake)
    tts.run_tts(db, ASSET, providers)
    db.expire_all()
    asset = db.get(Asset, ASSET)
    assert asset.status == "ready" and asset.error is None
    assert asset.duration == pytest.approx(1.25)  # FakeTts: 1.5 s spoken at 1.2×
    assert fake.calls == [("第一句。第二句！第三句？", "longxiaochun_v3", 1.2)]  # one chunk, rate honoured (cosyvoice)
    assert fake.models == ["cosyvoice-v3-flash"]
    argv = stub_ffmpeg[-1]
    assert argv[-1] == str(storage.asset_path(ASSET, "m4a")) and "aac" in argv and "192k" in argv
    assert not tts.tts_tmp_dir(ASSET).exists()


def test_run_tts_places_chunks_end_to_end(db, stub_ffmpeg, monkeypatch):
    _add_asset(db, "第一句。第二句！", derived_from={"lang": "es", "voice": "Cherry", "speech_rate": 1.5})
    fake = localize.FakeTts(seconds=2.0)
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=fake)
    monkeypatch.setattr(tts, "split_tts_text", lambda text, max_chars=500: ["第一句。", "第二句！"])
    tts.run_tts(db, ASSET, providers)
    db.expire_all()
    asset = db.get(Asset, ASSET)
    assert asset.status == "ready" and asset.duration == pytest.approx(4.0)
    # qwen3-tts ignores speech_rate, so the fake sees 1.0 and the two-tuple form.
    assert fake.calls == [("第一句。", "Cherry"), ("第二句！", "Cherry")] and fake.models == ["qwen3-tts-flash"] * 2
    graph = stub_ffmpeg[-1][stub_ffmpeg[-1].index("-filter_complex") + 1]
    assert "adelay=2000:all=1" in graph and "atrim=end=4" in graph and "amix=inputs=3" in graph


def test_run_tts_failure_marks_the_asset_failed_and_cleans_up(db, stub_ffmpeg):
    _add_asset(db, "坏音色。", derived_from={"voice": "longcheng_v3"})
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=localize.FakeTts(fail_voices={"longcheng_v3"}))
    tts.run_tts(db, ASSET, providers)
    db.expire_all()
    asset = db.get(Asset, ASSET)
    assert asset.status == "failed" and "longcheng_v3" in asset.error and asset.duration is None
    assert stub_ffmpeg == [] and not tts.tts_tmp_dir(ASSET).exists()
    assert not storage.asset_path(ASSET, "m4a").exists()


def test_run_tts_without_text_fails_and_a_missing_asset_is_a_no_op(db, stub_ffmpeg):
    tts.run_tts(db, "a_nope", localize.fake_providers())  # nothing to do, nothing raised
    _add_asset(db, "x", derived_from={"tts_text": "", "text": ""})
    tts.run_tts(db, ASSET, localize.fake_providers())
    db.expire_all()
    assert db.get(Asset, ASSET).status == "failed" and "文案" in db.get(Asset, ASSET).error


def test_run_tts_soft_time_limit_marks_failed_and_reraises(db, stub_ffmpeg):
    _add_asset(db)

    class SlowTts:
        def synthesize(self, text, voice, speech_rate=1.0, *, model=None, lang=None):  # noqa: ANN001
            raise SoftTimeLimitExceeded()

    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=SlowTts())
    with pytest.raises(SoftTimeLimitExceeded):
        tts.run_tts(db, ASSET, providers)
    db.expire_all()
    asset = db.get(Asset, ASSET)
    assert asset.status == "failed" and "已中止" in asset.error
    assert not tts.tts_tmp_dir(ASSET).exists()


def test_worker_task_runs_the_synthesis_on_the_default_queue(db, stub_ffmpeg):
    _add_asset(db)
    worker.synthesize_tts.run(ASSET)
    db.expire_all()
    assert db.get(Asset, ASSET).status == "ready"
    assert "hitgo.synthesize_tts" not in worker.celery_app.conf.task_routes
    assert worker.synthesize_tts.soft_time_limit == settings.localize_timeout_seconds


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="needs ffmpeg")
def test_run_tts_really_produces_an_m4a_of_the_summed_length(db, monkeypatch):
    _add_asset(db, "第一句。第二句！", derived_from={"lang": "es", "voice": "Cherry"})
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=localize.FakeTts(seconds=1.0))
    monkeypatch.setattr(tts, "split_tts_text", lambda text, max_chars=500: ["第一句。", "第二句！"])
    tts.run_tts(db, ASSET, providers)
    db.expire_all()
    asset = db.get(Asset, ASSET)
    assert asset.status == "ready", asset.error
    assert asset.duration == pytest.approx(2.0, abs=0.2)
    dst = storage.asset_path(ASSET, "m4a")
    assert dst.is_file() and ffprobe.probe_audio(dst)["codec"] == "aac"
    assert not tts.tts_tmp_dir(ASSET).exists()

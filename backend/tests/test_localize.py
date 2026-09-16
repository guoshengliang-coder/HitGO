"""Localization (contract §1 / §3 / §6): pure helpers, job lifecycle with fake providers, API."""

from __future__ import annotations

import copy
import shutil
import wave
from pathlib import Path

import pytest
from celery.exceptions import SoftTimeLimitExceeded

from app import worker
from app.config import settings
from app.models import Asset, Video
from app.services import localize, storage

VIDEO = "v_test000001"
KO_VOICE = "loongkyong_v3"
JA_VOICE = "loongtomoka_v3"


# --- pure helpers -------------------------------------------------------------------


def test_extract_args_is_16k_mono_pcm_wav():
    argv = localize.extract_args(Path("/data/src.mp4"), Path("/data/tmp/v.loc/asr.wav"), "ffmpeg")
    assert argv[0] == "ffmpeg" and argv[-1] == "/data/tmp/v.loc/asr.wav"
    assert argv[argv.index("-ar") + 1] == "16000" and argv[argv.index("-ac") + 1] == "1"
    assert argv[argv.index("-c:a") + 1] == "pcm_s16le" and "-vn" in argv


def test_silent_wav_and_wav_duration(tmp_path):
    clip = tmp_path / "c.wav"
    clip.write_bytes(localize.silent_wav(1.5))
    assert localize.wav_duration(clip) == pytest.approx(1.5, abs=1e-3)
    with wave.open(str(clip), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == 22050


def test_wav_duration_ignores_a_streaming_placeholder_header(tmp_path):
    """CosyVoice streams its wav: the header's data size is a placeholder, only the bytes on disk count."""
    good = tmp_path / "good.wav"
    good.write_bytes(localize.silent_wav(1.5))
    assert localize.wav_duration(good) == pytest.approx(1.5, abs=1e-3)

    data = bytearray(localize.silent_wav(1.5))
    pos = data.index(b"data")
    data[pos + 4 : pos + 8] = (0xFFFFFFFF).to_bytes(4, "little")  # what the vendor writes
    streamed = tmp_path / "streamed.wav"
    streamed.write_bytes(bytes(data))
    assert localize.wav_duration(streamed) == pytest.approx(1.5, abs=1e-3)

    data[pos + 4 : pos + 8] = (0).to_bytes(4, "little")  # zero-size placeholder
    streamed.write_bytes(bytes(data))
    assert localize.wav_duration(streamed) == pytest.approx(1.5, abs=1e-3)


def test_cue_slots_and_speech_rate_for():
    cues = [{"i": 0, "start": 0.4}, {"i": 1, "start": 3.0}, {"i": 2, "start": 9.0}]
    assert localize.cue_slots(cues, 12.0) == [2.6, 6.0, 3.0]
    assert localize.speech_rate_for(2.0, 2.6) == 1.0  # fits
    assert localize.speech_rate_for(3.9, 2.6) == 1.5  # 1.5× faster would fit exactly
    assert localize.speech_rate_for(9.0, 2.6) == 2.0  # capped at the vendor's max
    assert localize.speech_rate_for(1.0, 0.0) == 1.0  # no slot at all: leave it to atempo / warnings


def test_build_version_resynthesizes_faster_when_a_clip_overflows_its_slot(ready_video, db, no_ffmpeg):
    """Korean runs ~2× longer than English: the second synthesis asks for speech_rate before atempo."""
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, source_lang="en")
    tts = localize.FakeTts(seconds=5.0)  # cue 0 has a 2.58 s slot, cue 1 has 21.6 s
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=tts)
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    ko = db.get(Video, VIDEO).localization["versions"]["ko"]
    assert ko["status"] == "done"
    rates = [c[2] for c in tts.calls if len(c) == 3]
    assert rates == [1.94]  # only cue 0 was re-synthesized, at 5.0 / 2.58
    assert ko["warnings"] == []  # at 1.94× the clip is 2.58 s and fits without atempo


def test_cues_from_sentences_drops_empty_clamps_and_renumbers():
    sentences = [
        {"begin_time": 3000, "end_time": 5500, "text": " second "},
        {"begin_time": 420, "end_time": 2910, "text": "first"},
        {"begin_time": 6000, "end_time": 7000, "text": "   "},
        {"begin_time": 9000, "end_time": 12000, "text": "clamped"},
        {"begin_time": 11000, "end_time": 12000, "text": "gone"},
    ]
    cues = localize.cues_from_sentences(sentences, duration=10.0)
    assert cues == [
        {"i": 0, "start": 0.42, "end": 2.91, "text": "first"},
        {"i": 1, "start": 3.0, "end": 5.5, "text": "second"},
        {"i": 2, "start": 9.0, "end": 10.0, "text": "clamped"},
    ]
    many = [{"begin_time": k * 1000, "end_time": k * 1000 + 500, "text": str(k)} for k in range(500)]
    assert len(localize.cues_from_sentences(many, None)) == localize.MAX_CUES


def test_numbered_block_round_trips_and_rejects_bad_output():
    texts = ["Welcome to HitGO.", "Let's go."]
    block = localize.numbered_block(texts)
    assert block == "1. Welcome to HitGO.\n2. Let's go."
    assert localize.parse_numbered_block("1. 환영합니다.\n\n2) 시작합시다.", 2) == ["환영합니다.", "시작합시다."]
    # Wrapped continuation lines glue onto the previous sentence; full-width numbering is fine.
    assert localize.parse_numbered_block("1．첫 번째\n이어서\n2、두 번째", 2) == ["첫 번째 이어서", "두 번째"]
    assert localize.parse_numbered_block("1. only one", 2) is None
    assert localize.parse_numbered_block("2. wrong order\n1. x", 2) is None
    assert localize.parse_numbered_block("no numbers at all", 1) is None
    assert localize.parse_numbered_block("1. \n2. b", 2) is None


def test_translate_with_fallback_goes_sentence_by_sentence_when_numbering_breaks():
    good = localize.FakeTranslate()
    out = localize.translate_with_fallback(good, ["a", "b"], "English", "Korean", [])
    assert out == ["[Korean] a", "[Korean] b"] and len(good.calls) == 1
    broken = localize.FakeTranslate(broken=True)
    out = localize.translate_with_fallback(broken, ["a", "b"], "English", "Korean", [])
    assert out == ["[Korean] a", "[Korean] b"] and len(broken.calls) == 3
    assert localize.translate_with_fallback(good, [], "English", "Korean", []) == []


def test_plan_placements_speeds_up_then_warns():
    cues = [{"i": 0, "start": 0.0}, {"i": 1, "start": 2.0}, {"i": 2, "start": 4.0}]
    placements, warnings = localize.plan_placements(cues, [1.5, 2.4, 5.0], total=6.0, max_tempo=1.3)
    assert placements[0] == {"i": 0, "start": 0.0, "tempo": 1.0, "duration": 1.5}
    assert placements[1]["tempo"] == pytest.approx(1.2) and placements[1]["duration"] == pytest.approx(2.0)
    assert placements[2]["tempo"] == 1.3 and placements[2]["duration"] == pytest.approx(3.846, abs=1e-3)
    assert len(warnings) == 1 and "第 3 句" in warnings[0] and "1.30×" in warnings[0]


def test_mix_args_is_one_ffmpeg_command_over_a_silent_bed():
    argv = localize.mix_args(
        [(Path("/t/ko_0000.wav"), 0.0, 1.0), (Path("/t/ko_0001.wav"), 3.0, 1.2)],
        total=24.6,
        dst=Path("/data/assets/a_x.m4a"),
        ffmpeg_bin="ffmpeg",
    )
    assert argv[:2] == ["ffmpeg", "-hide_banner"] and argv.count("-i") == 2
    graph = argv[argv.index("-filter_complex") + 1]
    assert graph == (
        "anullsrc=r=44100:cl=stereo,atrim=end=24.6[bed];"
        "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[c0];"
        "[1:a]atempo=1.2,adelay=3000:all=1,aformat=sample_rates=44100:channel_layouts=stereo[c1];"
        "[bed][c0][c1]amix=inputs=3:duration=first:normalize=0:dropout_transition=0[aout]"
    )
    assert argv[argv.index("-map") + 1] == "[aout]" and argv[argv.index("-b:a") + 1] == "192k"
    assert argv[-1] == "/data/assets/a_x.m4a" and "+faststart" in argv


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg not installed")
def test_mix_args_really_produces_a_track_of_the_source_length(tmp_path):
    from app.services import ffprobe

    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    a.write_bytes(localize.silent_wav(1.0))
    b.write_bytes(localize.silent_wav(2.0))
    dst = tmp_path / "out.m4a"
    localize._run(localize.mix_args([(a, 0.5, 1.0), (b, 2.0, 1.25)], 6.0, dst), "混音")
    assert dst.is_file() and dst.stat().st_size > 0
    assert ffprobe.probe_audio(dst)["duration"] == pytest.approx(6.0, abs=0.2)


def test_voice_names_and_previous_asset_ids():
    assert localize.voice_name("V01 新手引导A.mp4", "ko") == "V01 新手引导A · 韩语配音.m4a"
    assert localize.voice_name("口播", "ja") == "口播 · 日语配音.m4a"
    assert localize.previous_voice_asset_ids(None) == []
    loc = {"versions": {"ko": {"voice_asset_id": "a_k"}, "ja": {"voice_asset_id": None}, "zh": {"voice_asset_id": "a_z"}}}
    assert localize.previous_voice_asset_ids(loc) == ["a_k", "a_z"]
    assert localize.previous_voice_asset_ids(loc, ["ja", "zh"]) == ["a_z"]


def test_voice_table_and_resolve_voice(monkeypatch):
    table = localize.voice_table(settings)
    assert table["ko"][0]["id"] == KO_VOICE and table["ja"][0]["id"] == JA_VOICE
    assert "de" not in table  # no confirmed cosyvoice-v3-flash voice yet
    assert localize.resolve_voice("ko", None, table) == KO_VOICE
    assert localize.resolve_voice("ko", "loongjihun_v3", table) == "loongjihun_v3"
    with pytest.raises(ValueError):
        localize.resolve_voice("ko", JA_VOICE, table)
    with pytest.raises(ValueError):
        localize.resolve_voice("de", None, table)
    monkeypatch.setattr(settings, "localize_voices", "de=some_de_voice, ko=loongjihun_v3,bogus,xx=1")
    table = localize.voice_table(settings)
    assert table["de"] == [{"id": "some_de_voice", "label": "some_de_voice"}]
    assert [v["id"] for v in table["ko"]] == ["loongjihun_v3", KO_VOICE]
    codes = [t["code"] for t in localize.target_langs(settings)]
    assert codes.index("de") > codes.index("ko")  # LANGS order, not env order


def test_apply_cue_edits():
    cues = [{"i": 0, "text": "a"}, {"i": 1, "text": "b"}]
    assert localize.apply_cue_edits(cues, [{"i": 1, "text": " B "}], "text") == [{"i": 0, "text": "a"}, {"i": 1, "text": "B"}]
    assert cues[1]["text"] == "b"  # input untouched
    with pytest.raises(ValueError, match="第 3 句"):
        localize.apply_cue_edits(cues, [{"i": 2, "text": "c"}], "text")


def test_make_providers_needs_a_key_for_dashscope(monkeypatch):
    monkeypatch.setattr(settings, "localize_provider", "dashscope")
    monkeypatch.setattr(settings, "dashscope_api_key", "")
    with pytest.raises(localize.LocalizeError, match="DASHSCOPE_API_KEY"):
        localize.make_providers(settings)
    assert isinstance(localize.make_providers(_fake_settings(monkeypatch)).asr, localize.FakeAsr)


def _fake_settings(monkeypatch):
    monkeypatch.setattr(settings, "localize_provider", "fake")
    return settings


# --- job lifecycle (ffmpeg stubbed, fake providers) ----------------------------------


@pytest.fixture
def no_ffmpeg(monkeypatch):
    """Stand in for the two ffmpeg calls: write a silent wav for ASR, a marker file for the mix."""
    calls: list[list[str]] = []

    def fake_run(argv, what, timeout=600):
        calls.append(argv)
        dst = Path(argv[-1])
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(localize.silent_wav(0.5, 16000) if "pcm_s16le" in argv else b"mix")
        return None

    monkeypatch.setattr(localize, "_run", fake_run)
    return calls


def queue(db, target_langs, *, transcript=None, versions=None, source_lang="auto", retranscribe=False):
    """Put the video into the state ``POST /localize`` leaves behind."""
    video = db.get(Video, VIDEO)
    versions = dict(versions or {})
    for lang in target_langs:
        old = versions.get(lang) or {}
        versions[lang] = {
            "status": "queued", "stage": old.get("stage"), "voice": old.get("voice") or localize.resolve_voice(lang, None),
            "terms": [], "cues": old.get("cues") or [], "stale": old.get("stale", False), "error": None, "warnings": [],
            "voice_asset_id": old.get("voice_asset_id"),
        }  # fmt: skip
    video.localization = {
        "source_lang": source_lang,
        "transcript": transcript or {"status": "queued", "error": None, "cues": []},
        "versions": versions,
        "pending": {"target_langs": list(target_langs), "retranscribe": retranscribe},
    }
    db.commit()
    return video


DONE_TRANSCRIPT = {
    "status": "done",
    "error": None,
    "cues": [{"i": 0, "start": 0.42, "end": 2.91, "text": "Welcome to HitGO."}, {"i": 1, "start": 3.0, "end": 5.5, "text": "Let's get started."}],
}


def test_run_localization_transcribes_once_and_builds_one_asset_per_language(ready_video, db, no_ffmpeg):
    queue(db, ["ko", "ja"])
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert "pending" not in loc
    assert loc["source_lang"] == "en"  # auto → what the model detected
    tr = loc["transcript"]
    assert tr["status"] == "done" and tr["error"] is None and tr["updated_at"]
    assert tr["cues"] == DONE_TRANSCRIPT["cues"]
    assert len(providers.asr.calls) == 1 and providers.asr.calls[0][1] is None
    assert len(providers.mt.calls) == 2  # one numbered block per language
    for lang, target, voice in (("ko", "Korean", KO_VOICE), ("ja", "Japanese", JA_VOICE)):
        v = loc["versions"][lang]
        assert v["status"] == "done" and v["stage"] is None and v["error"] is None and v["stale"] is False
        assert v["voice"] == voice and v["warnings"] == [] and v["updated_at"]
        assert v["cues"] == [{"i": 0, "translated": f"[{target}] Welcome to HitGO."}, {"i": 1, "translated": f"[{target}] Let's get started."}]
        asset = db.get(Asset, v["voice_asset_id"])
        assert asset.type == "audio" and asset.kind == "audio" and asset.status == "ready" and asset.source == "derived"
        assert asset.duration == 24.6 and asset.has_audio is True and asset.ext == "m4a"
        assert asset.derived_from == {"video_id": VIDEO, "video_name": "V01.mp4", "stem": "dubbed", "lang": lang}
        assert storage.asset_path(asset.id, "m4a").is_file()
    assert loc["versions"]["ko"]["voice_asset_id"] != loc["versions"]["ja"]["voice_asset_id"]
    assert db.get(Asset, loc["versions"]["ko"]["voice_asset_id"]).name == "V01 · 韩语配音.m4a"
    assert [(t, v) for t, v in providers.tts.calls] == [
        ("[Korean] Welcome to HitGO.", KO_VOICE), ("[Korean] Let's get started.", KO_VOICE),
        ("[Japanese] Welcome to HitGO.", JA_VOICE), ("[Japanese] Let's get started.", JA_VOICE),
    ]  # fmt: skip
    # extract once + mix twice; scratch dir is gone.
    assert len(no_ffmpeg) == 3 and not storage.localize_tmp_dir(VIDEO).exists()


def test_running_task_does_not_clobber_a_version_queued_meanwhile(ready_video, db, no_ffmpeg):
    """POST /localize may add another language while a task runs; the task must write back only its own parts."""
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, source_lang="en")
    providers = localize.fake_providers()
    real = providers.tts.synthesize

    def add_ja_meanwhile(text, voice):
        video = db.get(Video, VIDEO)
        loc = copy.deepcopy(video.localization)
        loc["versions"]["ja"] = {"status": "queued", "stage": None, "voice": JA_VOICE, "terms": [], "cues": [], "stale": False, "error": None, "warnings": [], "voice_asset_id": None}  # fmt: skip
        loc["pending"] = {"target_langs": ["ko", "ja"], "retranscribe": False}
        video.localization = loc
        db.commit()
        return real(text, voice)

    providers.tts.synthesize = add_ja_meanwhile
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert loc["versions"]["ko"]["status"] == "done"
    assert loc["versions"]["ja"]["status"] == "queued"  # survived, for the task queued behind
    providers.tts.synthesize = real
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert loc["versions"]["ja"]["status"] == "done" and loc["versions"]["ko"]["status"] == "done"
    assert providers.asr.calls == []


def test_second_run_adds_a_language_without_transcribing_again(ready_video, db, no_ffmpeg):
    ko = {"status": "done", "voice": KO_VOICE, "cues": [{"i": 0, "translated": "x"}, {"i": 1, "translated": "y"}], "voice_asset_id": "a_ko"}
    queue(db, ["ja"], transcript=DONE_TRANSCRIPT, versions={"ko": ko}, source_lang="en")
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert providers.asr.calls == [] and len(no_ffmpeg) == 1
    assert loc["transcript"]["cues"] == DONE_TRANSCRIPT["cues"] and loc["source_lang"] == "en"
    assert loc["versions"]["ko"] == ko  # untouched
    assert loc["versions"]["ja"]["status"] == "done"
    assert [c for c in providers.mt.calls] == ["1. Welcome to HitGO.\n2. Let's get started."]


def test_stage_tts_skips_translation_and_replaces_the_old_asset(ready_video, db, no_ffmpeg):
    old = Asset(id="a_oldko", type="audio", kind="audio", status="ready", name="old.m4a", ext="m4a", source="derived")
    old_path = storage.asset_path(old.id, "m4a")
    old_path.parent.mkdir(parents=True, exist_ok=True)
    old_path.write_bytes(b"old")
    db.add(old)
    edited = [{"i": 0, "translated": "힛고에 오신 것을 환영합니다."}, {"i": 1, "translated": "시작합시다."}]
    ko = {"stage": "tts", "voice": "loongjihun_v3", "cues": edited, "voice_asset_id": "a_oldko", "stale": False}
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, versions={"ko": ko}, source_lang="en")
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    v = db.get(Video, VIDEO).localization["versions"]["ko"]
    assert providers.mt.calls == [] and providers.tts.calls == [(edited[0]["translated"], "loongjihun_v3"), (edited[1]["translated"], "loongjihun_v3")]
    assert v["status"] == "done" and v["cues"] == edited and v["voice"] == "loongjihun_v3"
    assert v["voice_asset_id"] != "a_oldko" and db.get(Asset, "a_oldko") is None and not old_path.exists()
    assert db.get(Asset, v["voice_asset_id"]) is not None


def test_one_language_failing_keeps_its_translation_and_the_other_language(ready_video, db, no_ffmpeg):
    queue(db, ["ko", "ja"], transcript=DONE_TRANSCRIPT, source_lang="en")
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=localize.FakeTts(fail_voices={JA_VOICE}))
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    versions = db.get(Video, VIDEO).localization["versions"]
    assert versions["ko"]["status"] == "done" and db.get(Asset, versions["ko"]["voice_asset_id"]) is not None
    ja = versions["ja"]
    assert ja["status"] == "failed" and ja["stage"] is None and "合成失败" in ja["error"] and ja["voice_asset_id"] is None
    assert ja["cues"][0]["translated"] == "[Japanese] Welcome to HitGO."  # kept for editing / retry
    assert db.query(Asset).count() == 1


def test_retranscribe_replaces_the_template_and_marks_other_versions_stale(ready_video, db, no_ffmpeg):
    ja = {"status": "done", "voice": JA_VOICE, "cues": [{"i": 0, "translated": "x"}], "voice_asset_id": "a_ja", "stale": False}
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, versions={"ja": ja}, source_lang="en", retranscribe=True)
    providers = localize.fake_providers()
    providers.asr.sentences = [{"begin_time": 0, "end_time": 1000, "text": "New take."}]
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert len(providers.asr.calls) == 1 and providers.asr.calls[0][1] == "en"  # explicit source → hint
    assert loc["transcript"]["cues"] == [{"i": 0, "start": 0.0, "end": 1.0, "text": "New take."}]
    assert loc["versions"]["ja"]["stale"] is True and loc["versions"]["ja"]["status"] == "done"
    assert loc["versions"]["ko"]["stale"] is False and loc["versions"]["ko"]["cues"] == [{"i": 0, "translated": "[Korean] New take."}]


def test_run_localization_fails_fast_on_silent_or_overlong_sources(ready_video, db, no_ffmpeg, monkeypatch):
    video = db.get(Video, VIDEO)
    video.has_audio = False
    db.commit()
    queue(db, ["ko"])
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert loc["transcript"]["status"] == "failed" and "没有音轨" in loc["transcript"]["error"]
    assert loc["versions"]["ko"]["status"] == "failed" and "没有音轨" in loc["versions"]["ko"]["error"]
    assert providers.asr.calls == [] and no_ffmpeg == []

    video = db.get(Video, VIDEO)
    video.has_audio = True
    db.commit()
    monkeypatch.setattr(settings, "localize_max_seconds", 10)
    queue(db, ["ko"])
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert loc["transcript"]["status"] == "failed" and "上限 10 秒" in loc["transcript"]["error"]
    assert db.query(Asset).count() == 0


def test_empty_transcript_fails_every_requested_version(ready_video, db, no_ffmpeg):
    queue(db, ["ko"])
    providers = localize.fake_providers()
    providers.asr.sentences = [{"begin_time": 0, "end_time": 100, "text": ""}]
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert loc["transcript"]["status"] == "failed" and "没有识别出" in loc["transcript"]["error"]
    assert loc["versions"]["ko"]["status"] == "failed"


def test_run_localization_without_dashscope_fails_cleanly(ready_video, db, no_ffmpeg, monkeypatch):
    """The SDK missing (or the provider misconfigured) must land in the JSON, not crash the task."""
    import builtins

    real_import = builtins.__import__

    def no_sdk(name, *args, **kwargs):
        if name == "dashscope" or name.startswith("dashscope."):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_sdk)
    monkeypatch.setattr(settings, "localize_provider", "dashscope")
    monkeypatch.setattr(settings, "dashscope_api_key", "sk-test")
    queue(db, ["ko"])
    localize.run_localization(db, VIDEO)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert loc["transcript"]["status"] == "failed" and "dashscope" in loc["transcript"]["error"]
    assert loc["versions"]["ko"]["status"] == "failed" and "dashscope" in loc["versions"]["ko"]["error"]


def test_soft_time_limit_fails_whatever_is_left_with_a_readable_reason(ready_video, db, no_ffmpeg):
    class SlowTts(localize.FakeTts):
        def synthesize(self, text, voice, speech_rate=1.0):
            raise SoftTimeLimitExceeded()

    queue(db, ["ko", "ja"], transcript=DONE_TRANSCRIPT, source_lang="en")
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=SlowTts())
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    for lang in ("ko", "ja"):
        v = loc["versions"][lang]
        assert v["status"] == "failed" and v["stage"] is None and "中止" in v["error"]
    assert loc["versions"]["ko"]["cues"]  # translation done before the limit hit is kept
    assert not storage.localize_tmp_dir(VIDEO).exists()


def test_worker_task_runs_the_localization_on_the_default_queue(ready_video, db, no_ffmpeg):
    queue(db, ["ko"])
    worker.localize_video.run(VIDEO)
    db.expire_all()
    loc = db.get(Video, VIDEO).localization
    assert loc["transcript"]["status"] == "done" and loc["versions"]["ko"]["status"] == "done"
    assert "hitgo.localize_video" not in worker.celery_app.conf.task_routes
    assert worker.localize_video.soft_time_limit == settings.localize_timeout_seconds


# --- API ------------------------------------------------------------------------------


def test_options_lists_languages_and_voices(client, monkeypatch):
    r = client.get("/api/localize/options")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["source_langs"][0] == {"code": "auto", "label": "自动识别"}
    assert {s["code"] for s in body["source_langs"]} == {"auto", "zh", "en", "ja", "ko", "yue", "de", "fr", "ru"}
    ko = next(t for t in body["target_langs"] if t["code"] == "ko")
    assert ko["label"] == "韩语" and ko["voices"][0] == {"id": KO_VOICE, "label": "Kyong（韩语女）"}
    assert all(t["voices"] for t in body["target_langs"])
    monkeypatch.setattr(settings, "localize_provider", "dashscope")
    monkeypatch.setattr(settings, "dashscope_api_key", "")
    assert client.get("/api/localize/options").json()["enabled"] is False


def test_localize_endpoint_queues_and_reports_status(client, ready_video, enqueued, db):
    assert client.get(f"/api/videos/{VIDEO}").json()["localization"] is None
    r = client.post(
        f"/api/videos/{VIDEO}/localize",
        json={"target_langs": ["ko", "ja"], "voices": {"ja": "loongtomoya_v3"}, "terms": [{"source": "HitGO", "target": "힛고"}]},
    )
    assert r.status_code == 202, r.text
    loc = r.json()["localization"]
    assert "pending" not in loc and loc["source_lang"] == "auto"
    assert loc["transcript"] == {"status": "queued", "error": None, "cues": [], "updated_at": loc["transcript"]["updated_at"]}
    ko, ja = loc["versions"]["ko"], loc["versions"]["ja"]
    assert ko["status"] == "queued" and ko["stage"] is None and ko["voice"] == KO_VOICE and ko["stale"] is False
    assert ko["terms"] == [{"source": "HitGO", "target": "힛고"}] and ko["cues"] == [] and ko["voice_asset_id"] is None
    assert ja["voice"] == "loongtomoya_v3"
    assert enqueued.calls == [("hitgo.localize_video", (VIDEO,))]
    assert current_loc(db)["pending"] == {"target_langs": ["ko", "ja"], "retranscribe": False}
    # Anything already queued → 409, whether the transcript or one of the versions.
    assert client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["zh"]}).status_code == 409
    assert client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ko"]}).status_code == 409
    assert client.post("/api/videos/v_missing/localize", json={"target_langs": ["ko"]}).status_code == 404


def test_localize_endpoint_reuses_a_done_transcript_and_carries_queued_languages(client, ready_video, enqueued, db):
    video = db.get(Video, VIDEO)
    video.localization = {
        "source_lang": "en",
        "transcript": DONE_TRANSCRIPT,
        "versions": {"ko": {"status": "queued", "voice": KO_VOICE, "cues": []}},
        "pending": {"target_langs": ["ko"], "retranscribe": False},
    }
    db.commit()
    r = client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ja"]})
    assert r.status_code == 202
    loc = r.json()["localization"]
    assert loc["transcript"]["status"] == "done" and loc["source_lang"] == "en"
    assert loc["versions"]["ja"]["status"] == "queued" and loc["versions"]["ko"]["status"] == "queued"
    assert current_loc(db)["pending"] == {"target_langs": ["ko", "ja"], "retranscribe": False}
    # retranscribe re-queues the transcript (cues kept until the worker replaces them).
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done"))
    r = client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ko"], "source_lang": "zh", "retranscribe": True})
    assert r.status_code == 202
    loc = r.json()["localization"]
    assert loc["transcript"]["status"] == "queued" and len(loc["transcript"]["cues"]) == 2 and loc["source_lang"] == "zh"
    assert current_loc(db)["pending"]["retranscribe"] is True


def test_localize_endpoint_validates_languages_voices_and_readiness(client, ready_video, enqueued, db):
    post = lambda body: client.post(f"/api/videos/{VIDEO}/localize", json=body)  # noqa: E731
    assert post({"target_langs": ["xx"]}).status_code == 400
    assert post({"target_langs": ["de"]}).status_code == 400  # no voice yet
    assert post({"target_langs": []}).status_code == 400
    assert post({"target_langs": ["ko"] * 6}).status_code == 400
    assert post({"target_langs": ["ko"], "source_lang": "th"}).status_code == 400  # ASR cannot do Thai
    r = post({"target_langs": ["ko"], "voices": {"ko": JA_VOICE}})
    assert r.status_code == 400 and "音色" in r.json()["detail"]
    video = db.get(Video, VIDEO)
    video.has_audio = False
    db.commit()
    r = post({"target_langs": ["ko"]})
    assert r.status_code == 400 and "没有音轨" in r.json()["detail"]
    video.has_audio, video.status = True, "preparing"
    db.commit()
    assert post({"target_langs": ["ko"]}).status_code == 400
    assert enqueued.calls == [] and current_loc(db) is None


def test_localize_endpoint_is_503_without_a_key_or_a_queue(client, ready_video, monkeypatch, db):
    monkeypatch.setattr(settings, "localize_provider", "dashscope")
    monkeypatch.setattr(settings, "dashscope_api_key", "")
    r = client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ko"]})
    assert r.status_code == 503 and "DASHSCOPE_API_KEY" in r.json()["detail"]
    monkeypatch.setattr(settings, "localize_provider", "fake")

    def down(task, *args):
        raise worker.QueueUnavailable("redis down")

    monkeypatch.setattr(worker, "enqueue", down)
    assert client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ko"]}).status_code == 503
    db.expire_all()
    assert db.get(Video, VIDEO).localization is None


def patch_loc(db, mutate):
    """Edit ``Video.localization`` the way SQLAlchemy notices: fresh row, deep copy, reassign."""
    db.expire_all()
    video = db.get(Video, VIDEO)
    loc = copy.deepcopy(video.localization)
    mutate(loc)
    video.localization = loc
    db.commit()


def current_loc(db):
    db.expire_all()
    return db.get(Video, VIDEO).localization


def _done_state(db, **ko_extra):
    video = db.get(Video, VIDEO)
    video.localization = {
        "source_lang": "en",
        "transcript": DONE_TRANSCRIPT,
        "versions": {
            "ko": {"status": "done", "stage": None, "voice": KO_VOICE, "terms": [], "stale": False, "error": None, "warnings": [],
                   "cues": [{"i": 0, "translated": "환영"}, {"i": 1, "translated": "시작"}], "voice_asset_id": "a_ko", **ko_extra},
            "ja": {"status": "failed", "stage": None, "voice": JA_VOICE, "terms": [], "stale": False, "error": "x", "warnings": [],
                   "cues": [], "voice_asset_id": None},
        },
    }  # fmt: skip
    db.commit()
    asset = Asset(id="a_ko", type="audio", kind="audio", status="ready", name="V01 · 韩语配音.m4a", ext="m4a", source="derived",
                  duration=24.6, has_audio=True, derived_from={"video_id": VIDEO, "video_name": "V01.mp4", "stem": "dubbed", "lang": "ko"})  # fmt: skip
    db.add(asset)
    db.commit()
    path = storage.asset_path("a_ko", "m4a")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"ko")
    return path


def test_put_transcript_edits_the_template_and_makes_every_version_stale(client, ready_video, enqueued, db):
    r = client.put(f"/api/videos/{VIDEO}/localize/transcript", json={"cues": [{"i": 0, "text": "x"}]})
    assert r.status_code == 400
    _done_state(db)
    r = client.put(f"/api/videos/{VIDEO}/localize/transcript", json={"cues": [{"i": 1, "text": " Let us begin. "}], "source_lang": "en"})
    assert r.status_code == 200, r.text
    loc = r.json()["localization"]
    assert loc["transcript"]["cues"][1] == {"i": 1, "start": 3.0, "end": 5.5, "text": "Let us begin."}
    assert loc["transcript"]["cues"][0]["text"] == "Welcome to HitGO."
    assert loc["versions"]["ko"]["stale"] is True and loc["versions"]["ko"]["status"] == "done"
    assert loc["versions"]["ja"]["stale"] is False  # never had a translation to go stale
    assert enqueued.calls == []
    assert client.put(f"/api/videos/{VIDEO}/localize/transcript", json={"cues": [{"i": 9, "text": "x"}]}).status_code == 400
    assert client.put(f"/api/videos/{VIDEO}/localize/transcript", json={"cues": [{"i": 0, "text": "  "}]}).status_code == 400
    assert client.put(f"/api/videos/{VIDEO}/localize/transcript", json={"cues": [], "source_lang": "auto"}).status_code == 400
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="running"))
    assert client.put(f"/api/videos/{VIDEO}/localize/transcript", json={"cues": []}).status_code == 409


def test_put_version_requeues_only_tts_and_mix(client, ready_video, enqueued, db):
    put = lambda lang, body: client.put(f"/api/videos/{VIDEO}/localize/versions/{lang}", json=body)  # noqa: E731
    assert put("ko", {"cues": [{"i": 0, "translated": "x"}]}).status_code == 400  # nothing localized yet
    _done_state(db)
    assert put("ja", {"cues": [{"i": 0, "translated": "x"}]}).status_code == 400  # no translation to edit
    assert put("ko", {"cues": []}).status_code == 400  # nothing to do
    assert put("xx", {"voice": KO_VOICE}).status_code == 400
    r = put("ko", {"cues": [], "voice": JA_VOICE})
    assert r.status_code == 400 and "音色" in r.json()["detail"]
    r = put("ko", {"cues": [{"i": 1, "translated": " 시작합시다 "}]})
    assert r.status_code == 202, r.text
    ko = r.json()["localization"]["versions"]["ko"]
    assert ko["status"] == "queued" and ko["stage"] == "tts" and ko["voice"] == KO_VOICE and ko["error"] is None
    assert ko["cues"] == [{"i": 0, "translated": "환영"}, {"i": 1, "translated": "시작합시다"}]
    assert ko["voice_asset_id"] == "a_ko"  # kept until the worker replaces it
    assert enqueued.calls == [("hitgo.localize_video", (VIDEO,))]
    assert current_loc(db)["pending"] == {"target_langs": ["ko"], "retranscribe": False}
    assert put("ko", {"voice": "loongjihun_v3"}).status_code == 409  # now queued
    assert put("ko", {"cues": [{"i": 7, "translated": "x"}]}).status_code == 409
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done"))
    assert put("ko", {"cues": [{"i": 7, "translated": "x"}]}).status_code == 400
    r = put("ko", {"voice": "loongjihun_v3"})  # voice change alone is enough
    assert r.status_code == 202 and r.json()["localization"]["versions"]["ko"]["voice"] == "loongjihun_v3"


def test_put_version_reverts_when_the_queue_is_down(client, ready_video, monkeypatch, db):
    _done_state(db)

    def down(task, *args):
        raise worker.QueueUnavailable("redis down")

    monkeypatch.setattr(worker, "enqueue", down)
    r = client.put(f"/api/videos/{VIDEO}/localize/versions/ko", json={"voice": "loongjihun_v3"})
    assert r.status_code == 503
    loc = current_loc(db)
    ko = loc["versions"]["ko"]
    assert ko["status"] == "done" and ko["voice"] == KO_VOICE and "pending" not in loc


def test_delete_version_removes_the_version_and_its_asset(client, ready_video, db):
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/ko").status_code == 404
    path = _done_state(db)
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/zh").status_code == 404
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="running"))
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/ko").status_code == 409
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done"))
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/ko").status_code == 204
    loc = current_loc(db)
    assert "ko" not in loc["versions"] and "ja" in loc["versions"] and loc["transcript"]["status"] == "done"
    assert db.get(Asset, "a_ko") is None and not path.exists()
    assert client.get(f"/api/videos/{VIDEO}").json()["localization"]["versions"].keys() == {"ja"}
    # The failed ja version has no asset: deleting it is just bookkeeping.
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/ja").status_code == 204
    assert client.get(f"/api/videos/{VIDEO}").json()["localization"]["versions"] == {}


def test_video_serialization_carries_the_full_localization_block(client, ready_video, db):
    _done_state(db, warnings=["第 2 句配音 3.1 秒，超出可用的 2.5 秒（已加速 1.30×），建议缩短译文"])
    loc = client.get(f"/api/videos/{VIDEO}").json()["localization"]
    assert loc["source_lang"] == "en"
    assert loc["transcript"]["cues"][0] == {"i": 0, "start": 0.42, "end": 2.91, "text": "Welcome to HitGO."}
    ko = loc["versions"]["ko"]
    assert set(ko) == {"status", "stage", "voice", "terms", "cues", "stale", "error", "warnings", "voice_asset_id", "updated_at"}
    assert ko["warnings"][0].startswith("第 2 句") and ko["voice_asset_id"] == "a_ko"
    listed = client.get("/api/assets?source=derived").json()
    assert listed[0]["derived_from"] == {"video_id": VIDEO, "video_name": "V01.mp4", "stem": "dubbed", "lang": "ko"}
    # Batch listing goes through the same serializer.
    videos = client.get("/api/batches/b_test000001").json()["videos"]
    assert videos[0]["localization"]["versions"]["ko"]["status"] == "done"

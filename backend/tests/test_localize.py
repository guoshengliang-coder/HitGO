"""Localization (contract §1 / §3 / §6): pure helpers, job lifecycle with fake providers, API."""

from __future__ import annotations

import copy
import math
from dataclasses import replace
import shutil
import struct
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
    assert not localize.wav_has_signal(clip)


def test_valid_length_wav_must_contain_audio_signal(tmp_path):
    clip = tmp_path / "voice.wav"
    rate = 22050
    samples = [int(5000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(rate)]
    with wave.open(str(clip), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    assert localize.wav_duration(clip) == pytest.approx(1.0)
    assert localize.wav_has_signal(clip)


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


def test_split_sentence_cuts_at_punctuation_using_word_timestamps():
    words = []
    t = 0
    for w in ["Welcome", "to", "HitGO.", "Pick", "a", "language,", "then", "export.", "Try", "it", "today."]:
        words.append({"begin_time": t, "end_time": t + 400, "text": w})
        t += 500
    sent = {"begin_time": 0, "end_time": t, "text": " ".join(w["text"] for w in words), "words": words}
    pieces = localize.split_sentence(sent)
    assert [p["text"] for p in pieces] == ["Welcome to HitGO.", "Pick a language, then export.", "Try it today."]
    assert (pieces[0]["begin_time"], pieces[0]["end_time"]) == (0, 1400)
    assert (pieces[1]["begin_time"], pieces[1]["end_time"]) == (1500, 3900)
    assert pieces[2]["begin_time"] == 4000


def test_split_sentence_uses_the_punctuation_field_and_joins_cjk_without_spaces():
    words = [
        {"begin_time": 0, "end_time": 300, "text": "欢迎", "punctuation": ""},
        {"begin_time": 300, "end_time": 700, "text": "使用", "punctuation": "。"},
        {"begin_time": 700, "end_time": 1200, "text": "立即", "punctuation": ""},
        {"begin_time": 1200, "end_time": 1600, "text": "试用", "punctuation": "！"},
    ]
    pieces = localize.split_sentence({"begin_time": 0, "end_time": 1600, "text": "欢迎使用。立即试用！", "words": words})
    assert [p["text"] for p in pieces] == ["欢迎使用。", "立即试用！"]
    assert pieces[1]["begin_time"] == 700


def test_split_sentence_cuts_a_long_clause_run_at_commas_and_by_length():
    words = [{"begin_time": k * 300, "end_time": k * 300 + 250, "text": ("w%d," % k if k % 6 == 5 else "w%d" % k)} for k in range(40)]
    sent = {"begin_time": 0, "end_time": 12000, "text": "x", "words": words}
    pieces = localize.split_sentence(sent, max_chars=30, max_seconds=4.0)
    assert len(pieces) > 1
    assert all(len(p["text"]) <= 45 for p in pieces)  # never more than 1.5 × max_chars
    assert all(p["end_time"] > p["begin_time"] for p in pieces)
    assert pieces[-1]["end_time"] == words[-1]["end_time"]


def test_split_sentence_without_words_shares_time_by_characters():
    sent = {"begin_time": 0, "end_time": 4000, "text": "Hello there. How are you?"}
    pieces = localize.split_sentence(sent)
    assert [p["text"] for p in pieces] == ["Hello there.", "How are you?"]
    assert pieces[0]["begin_time"] == 0 and pieces[1]["end_time"] == 4000
    assert pieces[0]["end_time"] == pytest.approx(pieces[1]["begin_time"])
    assert localize.split_sentence({"begin_time": 0, "end_time": 900, "text": "Just one sentence"}) == [{"begin_time": 0, "end_time": 900, "text": "Just one sentence"}]


def test_cues_from_sentences_splits_a_run_on_sentence():
    cues = localize.cues_from_sentences([{"begin_time": 0, "end_time": 3000, "text": "One. Two. Three."}], 10.0)
    assert [c["text"] for c in cues] == ["One.", "Two.", "Three."]
    assert [c["i"] for c in cues] == [0, 1, 2] and cues[-1]["end"] == 3.0


def test_voice_models_and_env_overrides_with_model():
    table = localize.voice_table(settings)
    assert localize.voice_model("ko", "loongkyong_v3", table) == "cosyvoice-v3-flash"
    assert localize.voice_model("es", "Cherry", table) == "qwen3-tts-flash"
    assert {"es", "pt", "fr", "de", "it", "ru"} <= set(table)
    assert localize.voice_model("ar", "Arabic_CalmWoman", table) == settings.minimax_tts_model  # HIG-59
    assert localize.parse_voice_overrides("ar=loongmary@qwen-audio-3.0-tts-flash, ko=loongjihun_v3,junk") == {
        "ar": {"id": "loongmary", "model": "qwen-audio-3.0-tts-flash"},
        "ko": {"id": "loongjihun_v3"},
    }
    cfg = replace(settings, localize_voices="ar=loongmary@qwen-audio-3.0-tts-flash")
    table = localize.voice_table(cfg)
    # The override goes to the front; Arabic's built-in MiniMax voices stay behind it (HIG-59).
    assert table["ar"][0] == {"id": "loongmary", "label": "loongmary", "model": "qwen-audio-3.0-tts-flash"}
    assert [v["id"] for v in table["ar"][1:]] == ["Arabic_CalmWoman", "Arabic_FriendlyGuy"]
    assert localize.voice_model("ar", "loongmary", table, cfg) == "qwen-audio-3.0-tts-flash"
    ar = next(t for t in localize.target_langs(cfg) if t["code"] == "ar")
    # model stays internal; an env-added voice has no gender / style; qwen-audio goes through tts_v2 → speech_rate ok
    assert ar["rtl"] is True and ar["voices"][0] == {"id": "loongmary", "label": "loongmary", "gender": None, "style": None, "speech_rate": True, "provider": "aliyun"}
    assert localize.tts_api_for("qwen3-tts-flash") == "qwen3" and localize.tts_api_for("cosyvoice-v3-flash") == "tts_v2"
    assert localize.supports_speech_rate("qwen-audio-3.0-tts-flash") and not localize.supports_speech_rate("qwen3-tts-flash")
    assert localize.language_type_for("es") == "Spanish" and localize.language_type_for("ar") == "Auto"


def test_build_version_passes_the_voice_model_and_skips_rate_resynthesis_for_qwen3(ready_video, db, no_ffmpeg):
    queue(db, ["es"], transcript=DONE_TRANSCRIPT, source_lang="en")
    tts = localize.FakeTts(seconds=5.0)  # cue 0 overflows its 2.58 s slot
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=tts)
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    es = db.get(Video, VIDEO).localization["versions"]["es"]
    assert es["status"] == "done" and es["voice"] == "Cherry"
    assert set(tts.models) == {"qwen3-tts-flash"}
    assert all(len(c) == 2 for c in tts.calls)  # no speech_rate re-synthesis on Qwen3-TTS
    assert es["warnings"] and "停帧" in es["warnings"][0]


def test_cue_slots_and_speech_rate_for():
    cues = [{"i": 0, "start": 0.4}, {"i": 1, "start": 3.0}, {"i": 2, "start": 9.0}]
    assert localize.cue_slots(cues, 12.0) == [2.6, 6.0, 3.0]
    assert localize.speech_rate_for(2.0, 2.6) == 1.0  # fits
    assert localize.speech_rate_for(3.9, 2.6) == 1.5  # 1.5× faster would fit exactly
    assert localize.speech_rate_for(9.0, 2.6) == 2.0  # capped at the vendor's max
    assert localize.speech_rate_for(1.0, 0.0) == 1.0  # no slot at all: leave it to atempo / warnings


def test_build_version_preserves_natural_tts_when_a_clip_overflows_its_slot(ready_video, db, no_ffmpeg):
    """A long Korean line extends the picture; the two voices do not overlap."""
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, source_lang="en")
    tts = localize.FakeTts(seconds=5.0)  # cue 0 has a 2.58 s slot, cue 1 has 21.6 s
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=tts)
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    ko = db.get(Video, VIDEO).localization["versions"]["ko"]
    assert ko["status"] == "done"
    assert all(len(c) == 2 for c in tts.calls)
    assert ko["cues"][1]["dub_start"] >= ko["cues"][0]["dub_start"] + ko["cues"][0]["dub_duration"]
    assert ko["cues"][0]["hold_after"] > 0 and "停帧" in ko["warnings"][0]


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


def test_adaptive_placements_preserve_gaps_and_reject_unnatural_picture_speed():
    cues = [
        {"i": 0, "start": 0.5, "end": 2.5},
        {"i": 1, "start": 3.0, "end": 5.0},
    ]
    placements, total, warnings = localize.plan_adaptive_placements(cues, [2.5, 1.6], 6.0)
    assert warnings == []
    assert placements == [
        {"i": 0, "start": 0.5, "tempo": 1.0, "duration": 2.5, "video_speed": 0.8},
        {"i": 1, "start": 3.5, "tempo": 1.0, "duration": 1.6, "video_speed": 1.25},
    ]
    assert total == 6.1  # leading / inter-cue / trailing silence all stay at 1×
    placements, total, warnings = localize.plan_adaptive_placements(cues, [4.0, 1.6], 6.0)
    assert placements is None and total == 6.0 and "保守范围" in warnings[0]


def test_complete_placements_hold_the_last_frame_instead_of_cutting_a_long_line():
    cues = [{"i": 0, "start": 0.5, "end": 2.5}, {"i": 1, "start": 3.0, "end": 5.0}]
    placements, total, warnings = localize.plan_complete_placements(cues, [4.0, 1.6], 6.0)
    assert placements[0] == {"i": 0, "start": 0.5, "tempo": 1.0, "duration": 4.0, "video_speed": 0.8, "hold_after": 1.5}
    assert placements[1]["start"] == pytest.approx(5.0)
    assert placements[1]["video_speed"] == pytest.approx(1.25)
    assert total == pytest.approx(7.6)
    assert len(warnings) == 1 and "停帧" in warnings[0]


def test_with_placements_writes_and_strips_dub_windows():
    cues = [{"i": 0, "translated": "a"}, {"i": 1, "translated": "b"}, {"i": 2, "translated": ""}]
    placements = [{"i": 0, "start": 0.0, "tempo": 1.0, "duration": 1.5}, {"i": 1, "start": 2.0, "tempo": 1.2, "duration": 2.0}]
    out = localize.with_placements(cues, placements)
    assert out[0] == {"i": 0, "translated": "a", "dub_start": 0.0, "dub_duration": 1.5}
    assert out[1] == {"i": 1, "translated": "b", "dub_start": 2.0, "dub_duration": 2.0, "dub_tempo": 1.2}
    assert out[2] == {"i": 2, "translated": ""}  # nothing was synthesised for it
    assert localize.with_placements(out, []) == cues  # an empty plan strips the fields again


def test_with_placements_replaces_stale_windows_and_skips_zero_length():
    cues = [{"i": 0, "translated": "a", "dub_start": 9.0, "dub_duration": 9.0}, {"i": 1, "translated": "b", "dub_start": 1.0, "dub_duration": 1.0}]
    out = localize.with_placements(cues, [{"i": 0, "start": 0.4242, "tempo": 1.0, "duration": 1.2345}, {"i": 1, "start": 3.0, "tempo": 1.0, "duration": 0.0}])
    assert out[0]["dub_start"] == 0.424 and out[0]["dub_duration"] == 1.234
    assert "dub_start" not in out[1] and "dub_duration" not in out[1]


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
    assert not localize.mixed_voice_has_signal(dst)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_mixed_voice_signal_check_accepts_audible_output(tmp_path):
    rate = 22050
    samples = [int(5000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(rate)]
    clip = tmp_path / "spoken.wav"
    with wave.open(str(clip), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    dst = tmp_path / "voice.m4a"
    localize._run(localize.mix_args([(clip, 0, 1.0)], 1.0, dst), "混音")
    assert localize.mixed_voice_has_signal(dst)


def test_voice_names_and_previous_asset_ids():
    assert localize.voice_name("V01 新手引导A.mp4", "ko") == "V01 新手引导A · 韩语配音.m4a"
    assert localize.voice_name("口播", "ja") == "口播 · 日语配音.m4a"
    assert localize.previous_voice_asset_ids(None) == []
    loc = {"versions": {"ko": {"voice_asset_id": "a_k"}, "ja": {"voice_asset_id": None}, "zh": {"voice_asset_id": "a_z"}}}
    assert localize.previous_voice_asset_ids(loc) == ["a_k", "a_z"]
    assert localize.previous_voice_asset_ids(loc, ["ja", "zh"]) == ["a_z"]
    loc["versions"]["ko"]["cues"] = [{"i": 0, "voice_asset_id": "a_cue"}]
    loc["versions"]["ko"]["old_cue_asset_ids"] = ["a_previous", "a_cue"]
    assert localize.previous_voice_asset_ids(loc, ["ko"]) == ["a_k", "a_cue", "a_previous"]


def test_default_voice_table_is_well_formed_and_keeps_its_defaults():
    """HIG-42: every built-in voice carries gender / style, ids are unique per language, defaults unchanged."""
    table = localize.voice_table(settings)
    assert len(table["zh"]) >= 30 and len(table["en"]) >= 14
    for lang, voices in table.items():
        ids = [v["id"] for v in voices]
        assert len(ids) == len(set(ids)), lang
        for v in voices:
            assert v["gender"] in localize.GENDERS and v["style"], (lang, v)
    assert [table[lang][0]["id"] for lang in ("zh", "en", "ja", "ko", "yue", "id", "es")] == [
        "longxiaochun_v3", "loongabby_v3", "loongtomoka_v3", KO_VOICE, "longjiaxin_v3", "loongindah_v3", "Cherry"
    ]  # fmt: skip
    assert {v["gender"] for v in table["zh"]} == set(localize.GENDERS)
    out = {t["code"]: t for t in localize.target_langs(settings)}
    zh = out["zh"]["voices"][0]
    assert zh == {"id": "longxiaochun_v3", "label": "龙小淳", "gender": "female", "style": "知性积极", "speech_rate": True, "provider": "aliyun"}
    # Spanish now mixes both vendors: the qwen3-tts voices have no speech_rate, the MiniMax ones do.
    assert all(v["speech_rate"] is False for v in out["es"]["voices"] if v["provider"] == "aliyun")
    assert all(v["speech_rate"] is True for v in out["es"]["voices"] if v["provider"] == "minimax")
    assert all(v["speech_rate"] is True for v in out["zh"]["voices"])
    # model / vendor voice id / emotion all stay internal (HIG-59)
    assert set(out["zh"]["voices"][0]) == {"id", "label", "gender", "style", "speech_rate", "provider"}


def test_voice_table_and_resolve_voice(monkeypatch):
    table = localize.voice_table(settings)
    assert table["ko"][0]["id"] == KO_VOICE and table["ja"][0]["id"] == JA_VOICE
    assert localize.resolve_voice("ko", None, table) == KO_VOICE
    assert localize.resolve_voice("ko", "loongjihun_v3", table) == "loongjihun_v3"
    with pytest.raises(ValueError):
        localize.resolve_voice("ko", JA_VOICE, table)
    with pytest.raises(ValueError):
        localize.resolve_voice("ar", None, localize.voice_table(replace(settings, minimax_tts_model="")))
    monkeypatch.setattr(settings, "localize_voices", "ar=some_ar_voice, ko=loongjihun_v3,bogus,xx=1")
    table = localize.voice_table(settings)
    assert table["ar"][0] == {"id": "some_ar_voice", "label": "some_ar_voice"}
    assert [v["id"] for v in table["ko"]][:2] == ["loongjihun_v3", KO_VOICE]
    codes = [t["code"] for t in localize.target_langs(settings)]
    assert codes.index("ar") > codes.index("ko")  # LANGS order, not env order


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


def test_silent_vendor_response_fails_instead_of_publishing_voice(ready_video, db):
    class SilentVendor:
        def synthesize(self, text, voice, speech_rate=1.0, **kwargs):  # noqa: ANN001, ANN003
            return localize.silent_wav(1.0)

    queue(db, ["ko"], transcript=DONE_TRANSCRIPT)
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=SilentVendor())
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    version = db.get(Video, VIDEO).localization["versions"]["ko"]
    assert version["status"] == "failed"
    assert "无声音频" in version["error"]
    assert version["voice_asset_id"] is None


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
        assert [(c["i"], c["translated"]) for c in v["cues"]] == [(0, f"[{target}] Welcome to HitGO."), (1, f"[{target}] Let's get started.")]
        assert v["cues"][0]["dub_start"] == 0.42
        assert v["cues"][1]["dub_start"] >= v["cues"][0]["dub_start"] + v["cues"][0]["dub_duration"]
        asset = db.get(Asset, v["voice_asset_id"])
        assert asset.type == "audio" and asset.kind == "audio" and asset.status == "ready" and asset.source == "derived"
        assert asset.duration == pytest.approx(v["timeline_duration"]) and asset.has_audio is True and asset.ext == "m4a"
        assert asset.derived_from == {"video_id": VIDEO, "video_name": "V01.mp4", "stem": "dubbed", "lang": lang, "adaptive_timing": True}
        assert storage.asset_path(asset.id, "m4a").is_file()
    assert loc["versions"]["ko"]["voice_asset_id"] != loc["versions"]["ja"]["voice_asset_id"]
    assert db.get(Asset, loc["versions"]["ko"]["voice_asset_id"]).name == "V01 · 韩语配音.m4a"
    assert [(t, v) for t, v in providers.tts.calls] == [
        ("[Korean] Welcome to HitGO.", KO_VOICE), ("[Korean] Let's get started.", KO_VOICE),
        ("[Japanese] Welcome to HitGO.", JA_VOICE), ("[Japanese] Let's get started.", JA_VOICE),
    ]  # fmt: skip
    # extract once + mix twice; scratch dir is gone.
    assert len(no_ffmpeg) == 3 and not storage.localize_tmp_dir(VIDEO).exists()


def test_spoken_localization_builds_an_adaptive_picture_timeline(ready_video, db, no_ffmpeg):
    class AdaptiveTranslate(localize.FakeTranslate):
        def localize_for_speech(self, sources, translations, target, terms, target_seconds):  # noqa: ANN001
            return [f"自然口播 {i + 1}" for i in range(len(sources))]

    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, source_lang="en")
    providers = localize.Providers(
        asr=localize.FakeAsr(),
        mt=AdaptiveTranslate(),
        tts=localize.FakeTts(seconds=2.0),
    )
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    version = db.get(Video, VIDEO).localization["versions"]["ko"]
    assert version["adaptive_timing"] is True
    assert version["timeline_duration"] == pytest.approx(23.61)
    assert [c["translated"] for c in version["cues"]] == ["自然口播 1", "自然口播 2"]
    assert [c["video_speed"] for c in version["cues"]] == [pytest.approx(1.245), pytest.approx(1.25)]
    assert [c["dub_start"] for c in version["cues"]] == [0.42, 2.51]
    asset = db.get(Asset, version["voice_asset_id"])
    assert asset.duration == pytest.approx(23.61)
    assert asset.derived_from["adaptive_timing"] is True
    cue_assets = [db.get(Asset, cue["voice_asset_id"]) for cue in version["cues"]]
    assert all(asset is not None and asset.derived_from["stem"] == "dubbed_cue" for asset in cue_assets)
    assert cue_assets[0].id != cue_assets[1].id


def test_running_task_does_not_clobber_a_version_queued_meanwhile(ready_video, db, no_ffmpeg):
    """POST /localize may add another language while a task runs; the task must write back only its own parts."""
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, source_lang="en")
    providers = localize.fake_providers()
    real = providers.tts.synthesize

    def add_ja_meanwhile(text, voice, *args, **kw):
        video = db.get(Video, VIDEO)
        loc = copy.deepcopy(video.localization)
        loc["versions"]["ja"] = {"status": "queued", "stage": None, "voice": JA_VOICE, "terms": [], "cues": [], "stale": False, "error": None, "warnings": [], "voice_asset_id": None}  # fmt: skip
        loc["pending"] = {"target_langs": ["ko", "ja"], "retranscribe": False}
        video.localization = loc
        db.commit()
        return real(text, voice, *args, **kw)

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
    assert v["status"] == "done" and v["voice"] == "loongjihun_v3"
    assert [{"i": c["i"], "translated": c["translated"]} for c in v["cues"]] == edited  # plus dub_start / dub_duration (HIG-36)
    assert v["voice_asset_id"] != "a_oldko" and db.get(Asset, "a_oldko") is None and not old_path.exists()
    assert db.get(Asset, v["voice_asset_id"]) is not None


def test_translate_only_stops_before_tts_and_marks_an_older_voice_over_stale(ready_video, db, no_ffmpeg):
    """dub=false (HIG-56): translation lands, no TTS / mix, a previous voice-over is kept but flagged."""
    ko = {"voice": KO_VOICE, "cues": [{"i": 0, "translated": "old"}, {"i": 1, "translated": "old"}], "voice_asset_id": "a_oldko"}
    video = queue(db, ["ko", "ja"], transcript=DONE_TRANSCRIPT, versions={"ko": ko}, source_lang="en")
    loc = copy.deepcopy(video.localization)
    for v in loc["versions"].values():
        v["dub"] = False
    video.localization = loc
    db.commit()
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    versions = db.get(Video, VIDEO).localization["versions"]
    assert providers.tts.calls == [] and no_ffmpeg == [] and len(providers.mt.calls) == 2
    for lang, target in (("ko", "Korean"), ("ja", "Japanese")):
        v = versions[lang]
        assert v["status"] == "done" and v["stage"] is None and v["dub"] is False
        assert v["cues"][0] == {"i": 0, "translated": f"[{target}] Welcome to HitGO."}
    assert versions["ko"]["voice_asset_id"] == "a_oldko" and versions["ko"]["voice_stale"] is True
    assert versions["ja"]["voice_asset_id"] is None and versions["ja"]["voice_stale"] is False


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
    assert db.query(Asset).count() == 3  # combined dub plus two independent cue assets


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
    ko_cues = loc["versions"]["ko"]["cues"]
    assert loc["versions"]["ko"]["stale"] is False and [(c["i"], c["translated"]) for c in ko_cues] == [(0, "[Korean] New take.")]


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
        def synthesize(self, text, voice, speech_rate=1.0, **kw):
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
    assert ko["label"] == "韩语" and ko["voices"][0] == {"id": KO_VOICE, "label": "Kyong", "gender": "female", "style": "韩语", "speech_rate": True, "provider": "aliyun"}
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
    assert ko["cues"] == [{"i": 0, "translated": "환영", "dub_start": None, "dub_duration": None, "video_speed": None, "hold_after": None, "voice_asset_id": None, "dub_tempo": None},
                          {"i": 1, "translated": "시작합시다", "dub_start": None, "dub_duration": None, "video_speed": None, "hold_after": None, "voice_asset_id": None, "dub_tempo": None}]  # fmt: skip
    assert ko["voice_asset_id"] == "a_ko"  # kept until the worker replaces it
    assert enqueued.calls == [("hitgo.localize_video", (VIDEO,))]
    assert current_loc(db)["pending"] == {"target_langs": ["ko"], "retranscribe": False}
    assert put("ko", {"voice": "loongjihun_v3"}).status_code == 409  # now queued
    assert put("ko", {"cues": [{"i": 7, "translated": "x"}]}).status_code == 409
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done"))
    assert put("ko", {"cues": [{"i": 7, "translated": "x"}]}).status_code == 400
    r = put("ko", {"voice": "loongjihun_v3"})  # voice change alone is enough
    assert r.status_code == 202 and r.json()["localization"]["versions"]["ko"]["voice"] == "loongjihun_v3"


def test_put_version_with_an_empty_body_dubs_a_translate_only_or_outdated_version(client, ready_video, enqueued, db):
    put = lambda body: client.put(f"/api/videos/{VIDEO}/localize/versions/ko", json=body)  # noqa: E731
    _done_state(db, voice_asset_id=None, dub=False)
    r = put({})
    assert r.status_code == 202, r.text
    ko = r.json()["localization"]["versions"]["ko"]
    assert ko["status"] == "queued" and ko["stage"] == "tts" and ko["dub"] is True and ko["voice"] == KO_VOICE
    assert enqueued.calls == [("hitgo.localize_video", (VIDEO,))]
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done", voice_asset_id="a_ko", voice_stale=True))
    assert put({}).status_code == 202  # outdated voice-over
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done", voice_stale=False))
    assert put({}).status_code == 400  # up-to-date voice-over: nothing to do


def test_localize_endpoint_translate_only_request(client, ready_video, enqueued, db):
    r = client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ko"], "dub": False})
    assert r.status_code == 202, r.text
    ko = r.json()["localization"]["versions"]["ko"]
    assert ko["dub"] is False and ko["voice_stale"] is False and ko["voice"] == KO_VOICE
    patch_loc(db, lambda loc: [v.update(status="done") for v in (loc["transcript"], loc["versions"]["ko"])])
    r = client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ko"]})
    assert r.status_code == 202 and r.json()["localization"]["versions"]["ko"]["dub"] is True  # default keeps the old behaviour


def test_build_version_records_where_each_dub_landed(ready_video, db, no_ffmpeg):
    """HIG-36: the editor times split subtitles by the voice-over, so the mix plan is written back."""
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, source_lang="en")
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=localize.FakeTts(seconds=2.0))
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    ko = db.get(Video, VIDEO).localization["versions"]["ko"]
    assert ko["status"] == "done"
    # Both keep their natural 2 s take; the picture speeds up conservatively.
    assert ko["cues"][0]["dub_start"] == 0.42 and ko["cues"][0]["dub_duration"] == 2.0
    assert ko["cues"][1]["dub_start"] == pytest.approx(2.51) and ko["cues"][1]["dub_duration"] == 2.0


def test_translate_only_version_has_no_dub_windows(ready_video, db, no_ffmpeg):
    """dub = false rebuilds the cues from the translation, so last mix's windows go with them (HIG-36)."""
    dubbed = {"ko": {"stage": None, "cues": [{"i": 0, "translated": "old", "dub_start": 9.0, "dub_duration": 9.0}], "voice_asset_id": "a_old"}}
    queue(db, ["ko"], transcript=DONE_TRANSCRIPT, source_lang="en", versions=dubbed)
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(dub=False))
    providers = localize.Providers(asr=localize.FakeAsr(), mt=localize.FakeTranslate(), tts=localize.FakeTts())
    localize.run_localization(db, VIDEO, providers)
    db.expire_all()
    ko = db.get(Video, VIDEO).localization["versions"]["ko"]
    assert ko["status"] == "done" and ko["voice_stale"] is True
    assert all("dub_start" not in c and "dub_duration" not in c for c in ko["cues"])


def test_put_version_clears_the_dub_windows_and_ignores_them_in_the_body(client, ready_video, enqueued, db):
    """The old windows describe the old voice-over; the client cannot set them either (HIG-36)."""
    _done_state(db, cues=[{"i": 0, "translated": "환영", "dub_start": 0.42, "dub_duration": 2.0},
                          {"i": 1, "translated": "시작", "dub_start": 3.0, "dub_duration": 2.0}])  # fmt: skip
    r = client.put(f"/api/videos/{VIDEO}/localize/versions/ko", json={"cues": [{"i": 1, "translated": "시작합시다", "dub_start": 99.0, "dub_duration": 99.0}]})
    assert r.status_code == 202, r.text
    assert r.json()["localization"]["versions"]["ko"]["cues"] == [
            {"i": 0, "translated": "환영", "dub_start": None, "dub_duration": None, "video_speed": None, "hold_after": None, "voice_asset_id": None, "dub_tempo": None},
            {"i": 1, "translated": "시작합시다", "dub_start": None, "dub_duration": None, "video_speed": None, "hold_after": None, "voice_asset_id": None, "dub_tempo": None},
    ]
    assert all("dub_start" not in c for c in current_loc(db)["versions"]["ko"]["cues"])


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
    cue_asset = Asset(id="a_cue", type="audio", kind="audio", status="ready", name="cue.wav", ext="wav", source="derived")
    cue_path = storage.asset_path(cue_asset.id, cue_asset.ext)
    cue_path.parent.mkdir(parents=True, exist_ok=True)
    cue_path.write_bytes(b"cue")
    db.add(cue_asset)
    db.commit()
    patch_loc(db, lambda loc: loc["versions"]["ko"]["cues"][0].update(voice_asset_id="a_cue"))
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/zh").status_code == 404
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="running"))
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/ko").status_code == 409
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done"))
    assert client.delete(f"/api/videos/{VIDEO}/localize/versions/ko").status_code == 204
    loc = current_loc(db)
    assert "ko" not in loc["versions"] and "ja" in loc["versions"] and loc["transcript"]["status"] == "done"
    assert db.get(Asset, "a_ko") is None and not path.exists()
    assert db.get(Asset, "a_cue") is None and not cue_path.exists()
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
    assert set(ko) == {"status", "stage", "voice", "terms", "cues", "stale", "error", "warnings", "voice_asset_id", "dub", "voice_stale", "source_voice", "adaptive_timing", "timeline_duration", "updated_at"}
    assert ko["dub"] is True and ko["voice_stale"] is False  # old rows without the fields
    assert ko["warnings"][0].startswith("第 2 句") and ko["voice_asset_id"] == "a_ko"
    listed = client.get("/api/assets?source=derived").json()
    assert listed[0]["derived_from"] == {"video_id": VIDEO, "video_name": "V01.mp4", "stem": "dubbed", "lang": "ko"}
    # Batch listing goes through the same serializer.
    videos = client.get("/api/batches/b_test000001").json()["videos"]
    assert videos[0]["localization"]["versions"]["ko"]["status"] == "done"


# --- 原声配音（HIG-58）---------------------------------------------------------------

# Twelve seconds of continuous reading: enough to clone from.
LONG_CUES = [
    {"i": 0, "start": 0.0, "end": 3.0, "text": "one"},
    {"i": 1, "start": 3.0, "end": 6.5, "text": "two"},
    {"i": 2, "start": 6.5, "end": 9.0, "text": "three"},
    {"i": 3, "start": 9.0, "end": 12.4, "text": "four"},
    {"i": 4, "start": 12.4, "end": 15.0, "text": "five"},
]
LONG_TRANSCRIPT = {"status": "done", "error": None, "cues": LONG_CUES}


def test_plan_voice_sample_takes_the_first_long_enough_run():
    window = localize.plan_voice_sample(LONG_CUES)
    assert window == {"start": 0.0, "seconds": 12.4}  # cues 0–3 reach 10 s of speech


def test_plan_voice_sample_needs_ten_seconds_of_speech():
    assert localize.plan_voice_sample(LONG_CUES[:2]) is None
    assert localize.plan_voice_sample([]) is None
    assert localize.plan_voice_sample(DONE_TRANSCRIPT["cues"]) is None  # ~5 s only


def test_plan_voice_sample_skips_a_run_broken_by_silence():
    """A gap that pushes the window past 20 s ends the run; a later dense run still works."""
    cues = [
        {"i": 0, "start": 0.0, "end": 4.0, "text": "a"},
        {"i": 1, "start": 30.0, "end": 36.0, "text": "b"},  # 26 s of silence before it
        {"i": 2, "start": 36.0, "end": 41.0, "text": "c"},
    ]
    assert localize.plan_voice_sample(cues) == {"start": 30.0, "seconds": 11.0}


def test_plan_voice_sample_respects_the_twenty_second_ceiling():
    cues = [{"i": k, "start": k * 6.0, "end": k * 6.0 + 5.5, "text": "x"} for k in range(6)]
    window = localize.plan_voice_sample(cues)
    assert window is not None and window["seconds"] <= localize.CLONE_SAMPLE_MAX_SECONDS


def test_sample_args_cuts_the_window():
    argv = localize.sample_args(Path("/d/source.mp4"), Path("/d/s.wav"), 3.25, 12.0, mono_pcm=True, ffmpeg_bin="ffmpeg")
    assert argv[argv.index("-ss") + 1] == "3.25" and argv[argv.index("-t") + 1] == "12"
    assert argv[argv.index("-ar") + 1] == "16000" and argv[argv.index("-c:a") + 1] == "pcm_s16le"
    # -ss / -t before -i so ffmpeg seeks instead of decoding the whole file
    assert argv.index("-ss") < argv.index("-i")
    aac = localize.sample_args(Path("/d/a_v.m4a"), Path("/d/s.m4a"), 1.0, 15.0, mono_pcm=False, ffmpeg_bin="ffmpeg")
    assert aac[aac.index("-c:a") + 1] == "aac"


def test_clone_supported_follows_the_configured_tts_model(monkeypatch):
    assert localize.clone_supported("zh") and localize.clone_supported("ja") and localize.clone_supported("yue")
    assert not localize.clone_supported("es") and not localize.clone_supported("it") and not localize.clone_supported("ar")
    # The clone is bound to LOCALIZE_TTS_MODEL; a model with no cloning speaks for nobody.
    monkeypatch.setattr(settings, "localize_tts_model", "qwen3-tts-flash")
    assert not localize.clone_supported("zh")


def test_options_ship_the_clone_capability(client):
    langs = {t["code"]: t for t in client.get("/api/localize/options").json()["target_langs"]}
    assert langs["ja"]["clone"] is True and langs["fr"]["clone"] is True
    assert langs["es"]["clone"] is False and langs["it"]["clone"] is False


def test_sample_url_carries_a_read_ticket(monkeypatch):
    from app.services import media_ticket

    path = storage.voice_sample_path(VIDEO, "wav")
    monkeypatch.setattr(settings, "access_code", "secret", raising=True)
    url = localize.sample_url(path)
    base, _, query = url.partition("?")
    assert base == f"https://hitgo.example/media/voice-samples/{VIDEO}.wav"
    assert media_ticket.verify(f"voice-samples/{VIDEO}.wav", query.removeprefix("t="), "secret")
    # No access code, no gate, no ticket.
    monkeypatch.setattr(settings, "access_code", "", raising=True)
    assert "?" not in localize.sample_url(path)


def _queue_source_voice(db, langs, *, transcript=None):
    db.expire_all()
    keep = copy.deepcopy((db.get(Video, VIDEO).localization or {}).get("clone_voice"))
    video = queue(db, langs, transcript=transcript or LONG_TRANSCRIPT)
    loc = copy.deepcopy(video.localization)
    if keep:
        loc["clone_voice"] = keep  # queue() rewrites the row; a real POST would not drop it
    for lang in langs:
        loc["versions"][lang]["source_voice"] = True
        loc["versions"][lang]["voice"] = ""
    video.localization = loc
    db.commit()
    return video


def test_run_localization_clones_once_and_dubs_every_language_with_it(ready_video, db, no_ffmpeg):
    _queue_source_voice(db, ["ko", "ja"])
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    loc = current_loc(db)

    clone = loc["clone_voice"]
    assert clone["status"] == "done" and clone["voice_id"] == "hitgo-fake-1"
    assert clone["model"] == settings.localize_tts_model and clone["error"] is None
    assert clone["sample"] == {"from": "source", "start": 0.0, "seconds": 12.4}
    assert len(providers.clone.calls) == 1  # one clone for the whole video, not one per language
    sample_url, model = providers.clone.calls[0]
    assert f"/media/voice-samples/{VIDEO}.wav" in sample_url and model == settings.localize_tts_model
    assert storage.find_voice_sample(VIDEO) is not None

    for lang in ("ko", "ja"):
        v = loc["versions"][lang]
        assert v["status"] == "done" and v["source_voice"] is True and v["voice"] == "hitgo-fake-1"
        assert v["voice_asset_id"] and v["error"] is None
    assert {voice for _, voice in providers.tts.calls} == {"hitgo-fake-1"}
    assert set(providers.tts.models) == {settings.localize_tts_model}


def test_a_second_run_reuses_the_cloned_voice(ready_video, db, no_ffmpeg):
    _queue_source_voice(db, ["ko"])
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    _queue_source_voice(db, ["ja"], transcript=LONG_TRANSCRIPT)
    localize.run_localization(db, VIDEO, providers)
    loc = current_loc(db)
    assert len(providers.clone.calls) == 1  # not cloned again
    assert loc["versions"]["ja"]["voice"] == "hitgo-fake-1"


def test_a_clone_bound_to_another_model_is_redone(ready_video, db, no_ffmpeg):
    _queue_source_voice(db, ["ko"])
    patch_loc(db, lambda loc: loc.update(clone_voice={"status": "done", "voice_id": "old", "model": "cosyvoice-v2", "error": None}))
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    loc = current_loc(db)
    assert len(providers.clone.calls) == 1
    assert loc["clone_voice"]["voice_id"] == "hitgo-fake-1" and loc["clone_voice"]["model"] == settings.localize_tts_model
    assert loc["versions"]["ko"]["voice"] == "hitgo-fake-1"


def test_a_short_transcript_fails_the_clone_with_a_readable_reason(ready_video, db, no_ffmpeg):
    _queue_source_voice(db, ["ko"], transcript=DONE_TRANSCRIPT)  # ~5 s of speech
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    loc = current_loc(db)
    assert loc["clone_voice"]["status"] == "failed" and "不足 10 秒" in loc["clone_voice"]["error"]
    assert not providers.clone.calls  # never reached the vendor
    ko = loc["versions"]["ko"]
    assert ko["status"] == "failed" and ko["error"].startswith("音色复刻失败：")


def test_a_failed_clone_leaves_the_system_voice_versions_alone(ready_video, db, no_ffmpeg):
    """HIG-58 acceptance: cloning failing must not take the system-voice path down with it."""
    video = queue(db, ["ko", "ja"], transcript=LONG_TRANSCRIPT)
    loc = copy.deepcopy(video.localization)
    loc["versions"]["ko"]["source_voice"] = True
    loc["versions"]["ko"]["voice"] = ""
    video.localization = loc
    db.commit()

    providers = localize.fake_providers()
    providers.clone = localize.FakeVoiceClone(fail="样本里有背景音")
    localize.run_localization(db, VIDEO, providers)
    loc = current_loc(db)

    assert loc["clone_voice"]["status"] == "failed" and "背景音" in loc["clone_voice"]["error"]
    ko = loc["versions"]["ko"]
    assert ko["status"] == "failed" and "音色复刻失败" in ko["error"] and ko["voice_asset_id"] is None
    ja = loc["versions"]["ja"]
    assert ja["status"] == "done" and ja["voice"] == JA_VOICE and ja["voice_asset_id"]
    assert {voice for _, voice in providers.tts.calls} == {JA_VOICE}


def test_the_clone_prefers_the_separated_vocals(ready_video, db, no_ffmpeg):
    vocals = Asset(id="a_vocals", type="audio", kind="audio", status="ready", name="V01 · 人声.m4a", ext="m4a",
                   source="derived", duration=24.6, has_audio=True,
                   derived_from={"video_id": VIDEO, "video_name": "V01.mp4", "stem": "vocals"})  # fmt: skip
    db.add(vocals)
    path = storage.asset_path("a_vocals", "m4a")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"vocals")
    video = db.get(Video, VIDEO)
    video.separation = {"status": "done", "vocals_asset_id": "a_vocals", "instrumental_asset_id": None}
    db.commit()

    _queue_source_voice(db, ["ko"])
    providers = localize.fake_providers()
    localize.run_localization(db, VIDEO, providers)
    loc = current_loc(db)
    assert loc["clone_voice"]["sample"]["from"] == "vocals"
    assert f"/media/voice-samples/{VIDEO}.m4a" in providers.clone.calls[0][0]


def test_post_localize_refuses_source_voice_for_a_language_that_cannot_be_cloned(client, ready_video, enqueued):
    r = client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ja", "es"], "use_source_voice": True})
    assert r.status_code == 400 and "西班牙语" in r.json()["detail"]
    assert not enqueued.calls  # rejected before anything was queued


def test_post_localize_with_source_voice_marks_every_version(client, ready_video, enqueued, db):
    r = client.post(f"/api/videos/{VIDEO}/localize", json={"target_langs": ["ko", "ja"], "use_source_voice": True})
    assert r.status_code == 202, r.text
    versions = current_loc(db)["versions"]
    assert all(v["source_voice"] is True and v["voice"] == "" for v in versions.values())
    # The response tells the frontend which versions are on the original voice.
    assert r.json()["localization"]["versions"]["ko"]["source_voice"] is True


def test_put_version_switches_between_the_original_voice_and_a_system_one(client, ready_video, enqueued, db):
    _done_state(db, cues=[{"i": 0, "translated": "환영"}])

    on = client.put(f"/api/videos/{VIDEO}/localize/versions/ko", json={"use_source_voice": True})
    assert on.status_code == 202, on.text
    ko = current_loc(db)["versions"]["ko"]
    assert ko["source_voice"] is True and ko["voice"] == "" and ko["stage"] == "tts"

    # A queued version is busy; the switch back happens after that run landed.
    assert client.put(f"/api/videos/{VIDEO}/localize/versions/ko", json={"use_source_voice": False}).status_code == 409
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done", stage=None, voice="hitgo-fake-1", voice_asset_id="a_ko"))

    off = client.put(f"/api/videos/{VIDEO}/localize/versions/ko", json={"use_source_voice": False})
    assert off.status_code == 202, off.text
    ko = current_loc(db)["versions"]["ko"]
    assert ko["source_voice"] is False and ko["voice"] == KO_VOICE  # back to the language default


def test_picking_a_voice_switches_a_cloned_version_back(client, ready_video, enqueued, db):
    """The version row has no use_source_voice toggle: choosing a voice is the way back."""
    _done_state(db, source_voice=True, voice="hitgo-fake-1")
    r = client.put(f"/api/videos/{VIDEO}/localize/versions/ko", json={"cues": [], "voice": KO_VOICE})
    assert r.status_code == 202, r.text
    ko = current_loc(db)["versions"]["ko"]
    assert ko["source_voice"] is False and ko["voice"] == KO_VOICE


def test_put_version_refuses_source_voice_for_an_unclonable_language(client, ready_video, enqueued, db):
    _done_state(db)
    patch_loc(db, lambda loc: loc["versions"].update(it={"status": "done", "stage": None, "voice": "Cherry", "terms": [],
                                                          "cues": [{"i": 0, "translated": "ciao"}], "stale": False,
                                                          "error": None, "warnings": [], "voice_asset_id": None}))  # fmt: skip
    r = client.put(f"/api/videos/{VIDEO}/localize/versions/it", json={"use_source_voice": True})
    assert r.status_code == 400 and "意大利语" in r.json()["detail"]


# --- MiniMax 作为第二家音色来源（HIG-59）-------------------------------------------


def test_tts_api_for_leaves_every_non_minimax_model_exactly_where_it_was():
    """三分支的不变量：只有 MiniMax/ 前缀改变路由，其余模型名的行为逐字不变。"""
    for model in ("cosyvoice-v3-flash", "cosyvoice-v2", "qwen-audio-3.0-tts-flash", "", "minimax-but-not-a-path"):
        assert localize.tts_api_for(model) == "tts_v2", model
    assert localize.tts_api_for("qwen3-tts-flash") == "qwen3"
    # 大小写不敏感：LOCALIZE_VOICES 里人手写成 minimax/ 也要认，否则会静默落到 tts_v2
    for model in ("MiniMax/speech-2.8-hd", "minimax/speech-02-turbo", "MINIMAX/speech-2.8-turbo"):
        assert localize.tts_api_for(model) == "minimax", model


def test_minimax_speaks_speech_rate_but_cannot_hold_a_cloned_voice():
    assert localize.supports_speech_rate("MiniMax/speech-2.8-hd")
    assert localize.supports_speech_rate("cosyvoice-v3-flash")
    assert not localize.supports_speech_rate("qwen3-tts-flash")
    # clone_supported must NOT be written in terms of supports_speech_rate: the two were equivalent
    # before MiniMax, and conflating them would advertise clone: true for a MiniMax default model.
    cfg = replace(settings, localize_tts_model="MiniMax/speech-2.8-hd")
    assert localize.clone_supported("zh", cfg) is False
    assert localize.clone_supported("zh", settings) is True


def test_language_boost_is_its_own_table():
    assert localize.language_boost_for("yue") == "Chinese,Yue"  # comma-bearing, unlike qwen3
    assert [localize.language_boost_for(c) for c in ("th", "vi", "ar")] == ["Thai", "Vietnamese", "Arabic"]
    assert localize.language_boost_for("xx") == "auto" and localize.language_boost_for(None) == "auto"
    assert localize.language_type_for("th") == "Auto"  # the qwen3 table is untouched by any of this
    assert set(localize.MINIMAX_LANGUAGE_BOOST) == set(localize.LANGS)


def test_max_tts_chars_follows_the_model():
    assert localize.max_tts_chars("MiniMax/speech-2.8-hd") == 2000
    assert localize.max_tts_chars("cosyvoice-v3-flash") == localize.max_tts_chars("qwen3-tts-flash") == 500


def test_merge_voices_appends_and_leaves_the_base_alone():
    base = {"zh": [{"id": "a"}], "en": [{"id": "b"}]}
    merged = localize._merge_voices(base, {"zh": [{"id": "c"}], "th": [{"id": "d"}]})
    assert [v["id"] for v in merged["zh"]] == ["a", "c"]  # appended, so the default stays first
    assert [v["id"] for v in merged["en"]] == ["b"]
    assert [v["id"] for v in merged["th"]] == ["d"]
    assert base == {"zh": [{"id": "a"}], "en": [{"id": "b"}]}


def test_minimax_voices_unlock_thai_vietnamese_and_arabic():
    table = localize.voice_table(settings)
    assert set(table) == set(localize.LANGS)  # all 15 target languages now have at least one voice
    for lang in ("th", "vi", "ar"):
        assert table[lang], lang
        assert all(v["model"] == settings.minimax_tts_model for v in table[lang]), lang
    out = {t["code"]: t for t in localize.target_langs(settings)}
    assert all(v["provider"] == "minimax" and v["speech_rate"] is True for v in out["ar"]["voices"])
    assert out["ar"]["rtl"] is True
    # CLONE_MODEL_LANGS already contained th / vi, so "用原声配音" turns on for them by itself (HIG-58)
    assert out["th"]["clone"] is True and out["vi"]["clone"] is True and out["ar"]["clone"] is False


def test_minimax_table_is_well_formed_and_never_leaks_its_internals():
    table = localize.voice_table(settings)
    seen: set[str] = set()
    for lang, voices in table.items():
        for v in voices:
            if not str(v.get("model", "")).startswith("MiniMax/"):
                continue
            assert v["gender"] in localize.GENDERS and v["style"], (lang, v)
            assert v["voice"] and not v["voice"].startswith("MiniMax/"), v
            # ids are globally unique too: the vendor's multilingual voices are easy to repeat
            assert v["id"] not in seen, v["id"]
            seen.add(v["id"])
            if "~" in v["id"]:
                assert v["id"] == f"{v['voice']}~{v['emotion']}", v
    assert len(seen) >= 80
    assert all(set(v) == {"id", "label", "gender", "style", "speech_rate", "provider"} for t in localize.target_langs(settings) for v in t["voices"])


def test_voice_spec_splits_an_emotion_variant_back_apart():
    spec = localize.voice_spec("zh", "Chinese (Mandarin)_Sweet_Lady~happy")
    assert spec == {"voice": "Chinese (Mandarin)_Sweet_Lady", "model": settings.minimax_tts_model, "emotion": "happy"}
    plain = localize.voice_spec("zh", "Chinese (Mandarin)_Sweet_Lady")
    assert plain["voice"] == "Chinese (Mandarin)_Sweet_Lady" and plain["emotion"] is None
    assert localize.voice_spec("zh", "longxiaochun_v3") == {"voice": "longxiaochun_v3", "model": settings.localize_tts_model, "emotion": None}
    # an id that is not in the table falls back to itself on the configured default model
    assert localize.voice_spec("zh", "nope") == {"voice": "nope", "model": settings.localize_tts_model, "emotion": None}


def test_empty_minimax_tts_model_puts_the_voice_table_back_as_it_was():
    cfg = replace(settings, minimax_tts_model="")
    table = localize.voice_table(cfg)
    assert {"th", "vi", "ar"}.isdisjoint(table)
    assert not [v for voices in table.values() for v in voices if "MiniMax/" in str(v.get("model", ""))]
    assert table == localize.voice_table(replace(cfg, minimax_tts_model=""))
    assert [t["code"] for t in localize.target_langs(cfg)] == [c for c in localize.LANGS if c not in ("th", "vi", "ar")]


def test_minimax_is_off_unless_the_env_asks_for_it(monkeypatch):
    """开通与否后端探不到，所以缺省必须是关的——否则界面出现音色而每次合成都 502。"""
    from app.config import load_settings

    monkeypatch.delenv("MINIMAX_TTS_MODEL", raising=False)
    assert load_settings().minimax_tts_model == ""
    monkeypatch.setenv("MINIMAX_TTS_MODEL", "MiniMax/speech-02-turbo")
    assert load_settings().minimax_tts_model == "MiniMax/speech-02-turbo"


# --- transcribe only (HIG-84 自动识别字幕) --------------------------------------------


def test_transcribe_endpoint_queues_asr_only(client, ready_video, enqueued, db):
    r = client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={})
    assert r.status_code == 202, r.text
    loc = r.json()["localization"]
    assert "pending" not in loc and loc["source_lang"] == "auto" and loc["versions"] == {}
    assert loc["transcript"]["status"] == "queued" and loc["transcript"]["cues"] == []
    assert enqueued.calls == [("hitgo.localize_video", (VIDEO,))]
    assert current_loc(db)["pending"] == {"target_langs": [], "retranscribe": True, "transcribe_only": True}
    # a transcription already running → 409, and nothing more is queued
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={"retranscribe": True}).status_code == 409
    assert client.post("/api/videos/v_missing/localize/transcribe", json={}).status_code == 404
    assert len(enqueued.calls) == 1


def test_transcribe_endpoint_returns_a_done_transcript_without_queueing(client, ready_video, enqueued, db):
    _done_state(db)
    r = client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={"source_lang": "zh"})
    assert r.status_code == 202
    assert r.json()["localization"]["transcript"]["cues"] == DONE_TRANSCRIPT["cues"]
    assert enqueued.calls == [] and "pending" not in current_loc(db) and current_loc(db)["source_lang"] == "en"
    # retranscribe asks ASR again; the old cues stay until the worker replaces them
    r = client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={"source_lang": "zh", "retranscribe": True})
    assert r.status_code == 202
    loc = r.json()["localization"]
    assert loc["transcript"]["status"] == "queued" and len(loc["transcript"]["cues"]) == 2 and loc["source_lang"] == "zh"
    assert loc["versions"]["ko"]["status"] == "done"
    assert enqueued.calls == [("hitgo.localize_video", (VIDEO,))]


def test_transcribe_endpoint_is_409_while_a_version_runs_and_validates(client, ready_video, enqueued, db, monkeypatch):
    _done_state(db)
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="running"))
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={"retranscribe": True}).status_code == 409
    patch_loc(db, lambda loc: loc["versions"]["ko"].update(status="done"))
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={"source_lang": "th"}).status_code == 400
    monkeypatch.setattr(settings, "localize_provider", "dashscope")
    monkeypatch.setattr(settings, "dashscope_api_key", "")
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={}).status_code == 503
    monkeypatch.setattr(settings, "localize_provider", "fake")

    def down(task, *args):
        raise worker.QueueUnavailable("redis down")

    monkeypatch.setattr(worker, "enqueue", down)
    before = current_loc(db)
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={"retranscribe": True}).status_code == 503
    assert current_loc(db) == before  # put back
    video = db.get(Video, VIDEO)
    video.has_audio = False
    db.commit()
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={}).status_code == 400
    assert enqueued.calls == []


def test_transcribe_only_run_writes_the_transcript_and_builds_no_version(client, ready_video, enqueued, db, no_ffmpeg):
    _done_state(db)
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={"source_lang": "en", "retranscribe": True}).status_code == 202
    providers = localize.fake_providers()
    providers.asr.sentences = [{"begin_time": 0, "end_time": 1000, "text": "New take."}]
    db.expire_all()  # the endpoint wrote through another session
    localize.run_localization(db, VIDEO, providers)
    loc = current_loc(db)
    assert "pending" not in loc
    assert loc["transcript"]["status"] == "done" and loc["transcript"]["cues"] == [{"i": 0, "start": 0.0, "end": 1.0, "text": "New take."}]
    assert len(providers.asr.calls) == 1 and providers.mt.calls == [] and providers.tts.calls == []
    assert set(loc["versions"]) == {"ko", "ja"}  # untouched apart from being stale now
    assert loc["versions"]["ko"]["status"] == "done" and loc["versions"]["ko"]["stale"] is True
    assert loc["versions"]["ko"]["voice_asset_id"] == "a_ko" and loc["versions"]["ja"]["status"] == "failed"
    assert db.query(Asset).count() == 1 and len(no_ffmpeg) == 1  # extract only, no mix


def test_transcribe_only_run_on_a_fresh_video(client, ready_video, enqueued, db, no_ffmpeg):
    assert client.post(f"/api/videos/{VIDEO}/localize/transcribe", json={}).status_code == 202
    db.expire_all()
    localize.run_localization(db, VIDEO, localize.fake_providers())
    loc = current_loc(db)
    assert loc["transcript"]["status"] == "done" and loc["transcript"]["cues"] == DONE_TRANSCRIPT["cues"]
    assert loc["versions"] == {} and loc["source_lang"] == "en" and "pending" not in loc

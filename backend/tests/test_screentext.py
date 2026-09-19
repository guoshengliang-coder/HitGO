"""On-screen text detection, clustering and the API around it (contract §1 / §3 / §6, HIG-38)."""

from __future__ import annotations

import pytest

from app.models import ST_DONE, ST_FAILED, ST_QUEUED, Video
from app.services import screentext
from app.services.screentext import DetectedText, FakeScreenText


def box(x, y, w, h):
    return {"x": x, "y": y, "w": w, "h": h}


# --- geometry ---------------------------------------------------------------


def test_iou_and_union():
    a = box(0.1, 0.1, 0.2, 0.2)
    assert screentext.iou(a, a) == pytest.approx(1.0)
    assert screentext.iou(a, box(0.5, 0.5, 0.2, 0.2)) == 0.0
    u = screentext.union_box([box(0.1, 0.8, 0.3, 0.05), box(0.5, 0.82, 0.3, 0.05)])
    assert u == box(0.1, 0.8, 0.7, 0.07)


def test_clamp_box_keeps_everything_inside_the_frame():
    b = screentext.clamp_box(box(0.9, 0.95, 0.5, 0.5))
    assert b["x"] + b["w"] <= 1.0 + 1e-9
    assert b["y"] + b["h"] <= 1.0 + 1e-9
    # A model that returns a negative origin must not produce a negative-width box.
    b = screentext.clamp_box(box(-0.2, -0.1, 0.4, 0.3))
    assert b["x"] == 0.0 and b["w"] > 0


# --- clustering -------------------------------------------------------------


def test_same_text_across_frames_becomes_one_block_with_a_time_range():
    per_frame = [
        (0.0, [DetectedText("限时免费", box(0.6, 0.06, 0.3, 0.07), 0.9)]),
        (2.0, [DetectedText("限时免费", box(0.61, 0.06, 0.3, 0.07), 0.95)]),
        (4.0, [DetectedText("限时免费", box(0.6, 0.061, 0.3, 0.07), 0.8)]),
    ]
    blocks = screentext.cluster_blocks(per_frame, step=2.0)

    assert len(blocks) == 1
    assert blocks[0]["text"] == "限时免费"
    # First sighting minus half a sample, last plus half: the text was on screen between frames too.
    assert blocks[0]["t"] == [0.0, 5.0]
    assert blocks[0]["confidence"] == pytest.approx(0.883, abs=0.01)
    assert blocks[0]["moving"] is False


def test_the_same_text_reappearing_later_is_two_blocks():
    """Two layers with two time ranges beats one layer that jumps back on screen."""
    per_frame = [
        (0.0, [DetectedText("买一送一", box(0.2, 0.1, 0.3, 0.06))]),
        (2.0, []),
        (4.0, []),
        (6.0, [DetectedText("买一送一", box(0.2, 0.1, 0.3, 0.06))]),
    ]
    blocks = screentext.cluster_blocks(per_frame, step=2.0)

    assert len(blocks) == 2
    assert [b["t"][0] for b in blocks] == [0.0, 5.0]


def test_text_that_drifts_is_flagged_as_moving():
    per_frame = [
        (0.0, [DetectedText("飘字", box(0.1, 0.5, 0.2, 0.05))]),
        (2.0, [DetectedText("飘字", box(0.16, 0.5, 0.2, 0.05))]),
    ]
    blocks = screentext.cluster_blocks(per_frame, step=2.0)

    assert len(blocks) == 1
    assert blocks[0]["moving"] is True
    # Moving text is out of scope: it must not reach translation or erasure.
    assert screentext.enabled_blocks({"blocks": blocks}) == []


def test_blocks_far_apart_do_not_merge_even_with_the_same_text():
    per_frame = [
        (0.0, [DetectedText("标题", box(0.1, 0.05, 0.2, 0.05)), DetectedText("标题", box(0.7, 0.9, 0.2, 0.05))]),
    ]
    assert len(screentext.cluster_blocks(per_frame, step=2.0)) == 2


# --- subtitle band ----------------------------------------------------------


def test_bottom_centred_lines_become_the_subtitle_band():
    per_frame = [
        (0.0, [DetectedText("第一句话", box(0.15, 0.82, 0.7, 0.05))]),
        (2.0, [DetectedText("第二句话", box(0.12, 0.82, 0.76, 0.05))]),
        (4.0, [DetectedText("角标", box(0.75, 0.05, 0.2, 0.05))]),
    ]
    blocks = screentext.cluster_blocks(per_frame, step=2.0)
    band, rest = screentext.split_band(blocks)

    assert band is not None
    assert band["box"]["y"] == pytest.approx(0.81, abs=0.02)
    assert [b["text"] for b in rest] == ["角标"]
    assert [b["id"] for b in rest] == ["s0"]  # ids stay dense after the band is pulled out


def test_a_single_low_line_is_not_a_subtitle_band():
    """One line low in frame is as likely a slogan; blurring it for the whole clip is worse."""
    per_frame = [(0.0, [DetectedText("立即下载", box(0.3, 0.85, 0.4, 0.05))])]
    band, rest = screentext.split_band(screentext.cluster_blocks(per_frame, step=2.0))

    assert band is None
    assert len(rest) == 1


def test_limit_blocks_keeps_the_largest_and_renumbers():
    blocks = [
        {"id": "s0", "text": "小", "box": box(0, 0, 0.05, 0.02), "t": [0, 1]},
        {"id": "s1", "text": "大", "box": box(0, 0.3, 0.6, 0.1), "t": [1, 2]},
        {"id": "s2", "text": "中", "box": box(0, 0.6, 0.3, 0.06), "t": [2, 3]},
    ]
    kept = screentext.limit_blocks(blocks, 2)

    assert {b["text"] for b in kept} == {"大", "中"}
    assert [b["id"] for b in kept] == ["s0", "s1"]


# --- frame sampling ---------------------------------------------------------


def test_frame_time_starts_at_zero():
    """ffmpeg's fps filter emits the first frame at t=0, not at t=1/fps."""
    assert screentext.frame_time(0, 0.5) == 0.0
    assert screentext.frame_time(1, 0.5) == 2.0
    assert screentext.frame_time(3, 2.0) == 1.5


def test_sample_args_caps_the_frame_count():
    argv = screentext.sample_args(__import__("pathlib").Path("/x/source.mp4"), __import__("pathlib").Path("/tmp/out"), 0.5, 20, "ffmpeg")
    assert "-frames:v" in argv and argv[argv.index("-frames:v") + 1] == "20"
    assert any("fps=0.5" in a for a in argv)


def test_dedupe_drops_frames_that_look_the_same(tmp_path):
    from PIL import Image

    paths = []
    for i, color in enumerate([(10, 10, 10), (10, 10, 10), (200, 30, 30), (200, 30, 30)]):
        p = tmp_path / f"f{i:04d}.jpg"
        Image.new("RGB", (64, 64), color).save(p)
        paths.append(p)
    kept = screentext.dedupe_frames(paths)

    # Two distinct looks → two frames sent to the (per-frame billed) vision model.
    assert kept == [paths[0], paths[2]]


# --- edits ------------------------------------------------------------------


def test_apply_block_edits_only_touches_what_was_sent():
    blocks = [{"id": "s0", "text": "旧", "box": box(0.1, 0.1, 0.2, 0.05), "t": [0, 2], "enabled": True, "moving": False}]
    out = screentext.apply_block_edits(blocks, [{"id": "s0", "text": "新", "enabled": False}])

    assert out[0]["text"] == "新"
    assert out[0]["enabled"] is False
    assert out[0]["box"] == blocks[0]["box"]
    assert blocks[0]["text"] == "旧"  # input untouched


def test_apply_block_edits_rejects_unknown_ids():
    with pytest.raises(ValueError, match="s9"):
        screentext.apply_block_edits([{"id": "s0", "text": "a", "box": box(0, 0, 1, 1), "t": [0, 1]}], [{"id": "s9", "text": "b"}])


def test_enabled_blocks_skips_disabled_and_moving():
    detect = {
        "blocks": [
            {"id": "s0", "enabled": True, "moving": False},
            {"id": "s1", "enabled": False, "moving": False},
            {"id": "s2", "enabled": True, "moving": True},
        ]
    }
    assert [b["id"] for b in screentext.enabled_blocks(detect)] == ["s0"]


# --- detection end to end (fake provider) -----------------------------------


class _StubVideo:
    pass


def test_translate_blocks_uses_the_numbered_protocol():
    from app.services.localize import FakeTranslate

    mt = FakeTranslate()
    blocks = [{"id": "s0", "text": "限时免费"}, {"id": "s1", "text": "立即下载"}]
    out = screentext.translate_blocks(blocks, "zh", "ko", [], mt)

    assert [t["id"] for t in out] == ["s0", "s1"]
    assert all(t["translated"] for t in out)
    # One request for the whole batch, not one per block.
    assert len(mt.calls) == 1


# --- API --------------------------------------------------------------------


def test_post_queues_detection(client, ready_video, enqueued):
    r = client.post(f"/api/videos/{ready_video.id}/screen-text", json={"detect": True})

    assert r.status_code == 202
    assert r.json()["screen_text"]["detect"]["status"] == ST_QUEUED
    assert "hitgo.screen_text_video" in enqueued.names()


def test_post_without_target_langs_is_allowed(client, ready_video):
    """Detect + erase with no language at all: strip the old subtitles, re-caption by hand."""
    r = client.post(f"/api/videos/{ready_video.id}/screen-text", json={"detect": True, "erase": True})

    assert r.status_code == 202
    body = r.json()["screen_text"]
    assert body["versions"] == {}
    assert body["erase"]["status"] == ST_QUEUED


def test_post_rejects_a_video_that_is_too_long(client, ready_video, db):
    ready_video.duration = 9999
    db.commit()
    r = client.post(f"/api/videos/{ready_video.id}/screen-text", json={"detect": True})

    assert r.status_code == 400
    assert "秒" in r.json()["detail"]


def test_post_conflicts_while_detection_is_running(client, ready_video, db):
    ready_video.screen_text = {"detect": {"status": "running"}, "versions": {}}
    db.commit()
    r = client.post(f"/api/videos/{ready_video.id}/screen-text", json={"detect": True})

    assert r.status_code == 409


def test_post_without_detect_and_without_work_is_rejected(client, ready_video, db):
    ready_video.screen_text = {"detect": {"status": ST_DONE, "blocks": []}, "versions": {}}
    db.commit()
    r = client.post(f"/api/videos/{ready_video.id}/screen-text", json={})

    assert r.status_code == 400


def test_put_blocks_marks_versions_and_the_clean_copy_stale(client, ready_video, db):
    ready_video.screen_text = {
        "detect": {"status": ST_DONE, "blocks": [{"id": "s0", "text": "旧", "box": box(0.1, 0.1, 0.2, 0.05), "t": [0, 2], "enabled": True, "moving": False}]},
        "erase": {"status": ST_DONE, "stale": False},
        "versions": {"ko": {"status": ST_DONE, "texts": [{"id": "s0", "translated": "구"}], "stale": False}},
    }
    db.commit()
    r = client.put(f"/api/videos/{ready_video.id}/screen-text/blocks", json={"blocks": [{"id": "s0", "text": "新"}]})

    assert r.status_code == 200
    body = r.json()["screen_text"]
    assert body["detect"]["blocks"][0]["text"] == "新"
    assert body["versions"]["ko"]["stale"] is True
    assert body["erase"]["stale"] is True  # the clean copy was cut from the old boxes


def test_put_blocks_before_any_detection_is_rejected(client, ready_video):
    r = client.put(f"/api/videos/{ready_video.id}/screen-text/blocks", json={"blocks": []})
    assert r.status_code == 400


def test_put_version_edits_translations(client, ready_video, db):
    ready_video.screen_text = {
        "detect": {"status": ST_DONE, "blocks": []},
        "versions": {"ko": {"status": ST_DONE, "texts": [{"id": "s0", "translated": "旧"}], "stale": False}},
    }
    db.commit()
    r = client.put(f"/api/videos/{ready_video.id}/screen-text/versions/ko", json={"texts": [{"id": "s0", "translated": "새"}]})

    assert r.status_code == 200
    assert r.json()["screen_text"]["versions"]["ko"]["texts"][0]["translated"] == "새"


def test_delete_version(client, ready_video, db):
    ready_video.screen_text = {"detect": {"status": ST_DONE, "blocks": []}, "versions": {"ko": {"status": ST_DONE, "texts": []}}}
    db.commit()
    assert client.delete(f"/api/videos/{ready_video.id}/screen-text/versions/ko").status_code == 204
    assert client.delete(f"/api/videos/{ready_video.id}/screen-text/versions/ko").status_code == 404


def test_options_reports_what_this_deployment_can_do(client):
    body = client.get("/api/screen-text/options").json()

    assert body["enabled"] is True  # provider = fake in tests
    assert body["erase_enabled"] is True
    assert body["max_blocks"] > 0


# --- the task end to end (fake providers, no ffmpeg) ------------------------


@pytest.fixture
def stub_detect(monkeypatch):
    """Replace the ffmpeg + vision half so the orchestration can be tested on its own."""

    def fake_detect_blocks(video, provider, tmp, hint_lang, cfg=None):
        return {
            "status": ST_DONE,
            "error": None,
            "model": "fake",
            "frames": 3,
            "subtitle_band": {"box": box(0.06, 0.8, 0.88, 0.07), "style": {"align": "center"}, "confidence": 0.8},
            "blocks": [
                {"id": "s0", "text": "限时免费", "box": box(0.6, 0.06, 0.3, 0.07), "t": [1.0, 4.0],
                 "lines": 1, "style": {"color": "#FFFFFF"}, "confidence": 0.9, "moving": False, "enabled": True},
            ],
            "updated_at": None,
        }

    monkeypatch.setattr(screentext, "detect_blocks", fake_detect_blocks)
    return fake_detect_blocks


def test_run_detects_then_translates(db, ready_video, stub_detect, enqueued):
    ready_video.screen_text = {
        "detect": {"status": ST_QUEUED},
        "versions": {"ko": {"status": ST_QUEUED, "texts": []}},
        "pending": {"target_langs": ["ko"], "source_lang": "zh", "terms": [], "erase": False, "scope": None},
    }
    db.commit()

    screentext.run_screen_text(db, ready_video.id)

    db.refresh(ready_video)
    st = ready_video.screen_text
    assert st["detect"]["status"] == ST_DONE
    assert st["versions"]["ko"]["status"] == ST_DONE
    assert st["versions"]["ko"]["texts"][0]["id"] == "s0"
    assert st["versions"]["ko"]["texts"][0]["translated"]
    assert "pending" not in st


def test_detection_failure_fails_the_languages_too_but_nothing_else(db, ready_video, monkeypatch, enqueued):
    def boom(*a, **k):
        raise screentext.ScreenTextError("抽帧失败")

    monkeypatch.setattr(screentext, "detect_blocks", boom)
    ready_video.screen_text = {
        "detect": {"status": ST_QUEUED},
        "versions": {"ko": {"status": ST_QUEUED, "texts": []}},
        "pending": {"target_langs": ["ko"], "source_lang": "zh", "terms": [], "erase": True, "scope": None},
    }
    ready_video.localization = {"source_lang": "zh", "transcript": {"status": "done", "cues": []}, "versions": {}}
    db.commit()

    screentext.run_screen_text(db, ready_video.id)

    db.refresh(ready_video)
    st = ready_video.screen_text
    assert st["detect"]["status"] == ST_FAILED
    assert st["detect"]["error"] == "抽帧失败"
    assert st["versions"]["ko"]["status"] == ST_FAILED
    # The dubbing chain is a different feature and must be untouched by this failure.
    assert ready_video.localization["transcript"]["status"] == "done"


def test_one_language_failing_does_not_stop_the_others(db, ready_video, stub_detect, monkeypatch, enqueued):
    calls = {"n": 0}
    real = screentext.translate_blocks

    def flaky(blocks, source_lang, target_lang, terms, mt):
        calls["n"] += 1
        if target_lang == "ko":
            raise RuntimeError("配额用尽")
        return real(blocks, source_lang, target_lang, terms, mt)

    monkeypatch.setattr(screentext, "translate_blocks", flaky)
    ready_video.screen_text = {
        "detect": {"status": ST_QUEUED},
        "versions": {"ko": {"status": ST_QUEUED, "texts": []}, "ja": {"status": ST_QUEUED, "texts": []}},
        "pending": {"target_langs": ["ko", "ja"], "source_lang": "zh", "terms": [], "erase": False, "scope": None},
    }
    db.commit()

    screentext.run_screen_text(db, ready_video.id)

    db.refresh(ready_video)
    versions = ready_video.screen_text["versions"]
    assert versions["ko"]["status"] == ST_FAILED
    assert "配额用尽" in versions["ko"]["error"]
    assert versions["ja"]["status"] == ST_DONE


def test_erase_is_started_after_translation(db, ready_video, stub_detect, enqueued):
    ready_video.screen_text = {
        "detect": {"status": ST_QUEUED},
        "erase": {"status": ST_QUEUED},
        "versions": {},
        "pending": {"target_langs": [], "source_lang": "zh", "terms": [], "erase": True, "scope": None},
    }
    db.commit()

    screentext.run_screen_text(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == "running"
    assert enqueued.later_names() == ["hitgo.erase_poll"]


def test_save_merges_instead_of_overwriting(db, ready_video):
    """A language queued while the task runs must not vanish under the write-back."""
    ready_video.screen_text = {"detect": {"status": ST_QUEUED}, "versions": {}}
    db.commit()
    st = {"detect": {"status": ST_DONE, "blocks": []}, "versions": {"ko": {"status": ST_DONE, "texts": []}}}

    # Someone POSTs another language while the task holds its own copy of the state.
    ready_video.screen_text = {**ready_video.screen_text, "versions": {"ja": {"status": ST_QUEUED, "texts": []}}}
    db.commit()

    screentext.save(db, ready_video, st, detect=True, langs=["ko"])

    db.refresh(ready_video)
    assert set(ready_video.screen_text["versions"]) == {"ja", "ko"}
    assert ready_video.screen_text["detect"]["status"] == ST_DONE

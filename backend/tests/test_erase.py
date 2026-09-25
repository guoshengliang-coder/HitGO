"""Erasure: region planning, the re-enqueue polling loop, validation and cleanup (HIG-38)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db import iso, utcnow
from app.models import ST_DONE, ST_FAILED, ST_RUNNING
from app.services import erase, screentext, storage
from app.services.erase import EraseRegion, FakeErase


def box(x, y, w, h):
    return {"x": x, "y": y, "w": w, "h": h}


def _detect(band=True, blocks=None):
    return {
        "status": ST_DONE,
        "subtitle_band": {"box": box(0.06, 0.80, 0.88, 0.075)} if band else None,
        "blocks": blocks if blocks is not None else [
            {"id": "s0", "box": box(0.6, 0.06, 0.3, 0.07), "t": [1.0, 4.0], "enabled": True, "moving": False},
            {"id": "s1", "box": box(0.1, 0.4, 0.2, 0.05), "t": [5.0, 8.0], "enabled": True, "moving": False},
        ],
    }


# --- regions ----------------------------------------------------------------


def test_the_subtitle_band_is_erased_for_the_whole_clip():
    """Per-sentence timing would leave un-erased frames wherever a range was off by a sample."""
    regions = erase.regions_for(_detect(), None)

    band = regions[0]
    assert band.t is None
    assert band.box == pytest.approx({"x": 0.04, "y": 0.775, "w": 0.92, "h": 0.125})
    assert [r.t for r in regions[1:]] == [(1.0, 4.0), (5.0, 8.0)]


def test_scope_narrows_to_the_chosen_blocks():
    regions = erase.regions_for(_detect(), {"band": False, "block_ids": ["s1"]})

    assert len(regions) == 1
    assert regions[0].t == (5.0, 8.0)


def test_disabled_and_moving_blocks_are_never_erased():
    detect = _detect(band=False, blocks=[
        {"id": "s0", "box": box(0.1, 0.1, 0.2, 0.05), "t": [0, 1], "enabled": False, "moving": False},
        {"id": "s1", "box": box(0.3, 0.1, 0.2, 0.05), "t": [0, 1], "enabled": True, "moving": True},
    ])
    assert erase.regions_for(detect, None) == []


# --- local provider ---------------------------------------------------------


def test_delogo_filter_keeps_a_pixel_of_border_to_interpolate_from():
    chain = erase.delogo_filter([EraseRegion(box=box(0.0, 0.0, 1.0, 1.0))], 1080, 1920)

    assert chain.startswith("delogo=")
    parts = dict(kv.split("=", 1) for kv in chain.removeprefix("delogo=").split(":") if "=" in kv)
    assert int(parts["x"]) >= 1 and int(parts["y"]) >= 1
    assert int(parts["x"]) + int(parts["w"]) <= 1079
    assert int(parts["y"]) + int(parts["h"]) <= 1919


def test_delogo_filter_adds_enable_only_for_timed_regions():
    chain = erase.delogo_filter(
        [EraseRegion(box=box(0.1, 0.8, 0.5, 0.06)), EraseRegion(box=box(0.1, 0.1, 0.2, 0.05), t=(1.0, 4.0))],
        1080, 1920,
    )
    # The chain separator is a comma and so is the one inside between(t,a,b); ffmpeg's parser
    # respects the quotes (the same shape filtergraph.py already emits), so split on the
    # filter name rather than on commas.
    first, second = chain.split(",delogo=")
    assert "enable" not in first
    assert "enable='between(t,1.000,4.000)'" in second


def test_local_args_refuse_an_empty_region_list():
    with pytest.raises(erase.EraseError):
        erase.local_args(__import__("pathlib").Path("/x.mp4"), __import__("pathlib").Path("/y.mp4"), [], 1080, 1920)


# --- polling ----------------------------------------------------------------


def test_running_job_re_enqueues_itself_instead_of_blocking(db, ready_video, enqueued, monkeypatch):
    provider = FakeErase(running_polls=2)
    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: provider)
    ready_video.screen_text = {
        "detect": _detect(),
        "erase": {"status": ST_RUNNING, "task_id": "t1", "polls": 0, "deadline": iso(utcnow() + timedelta(seconds=600))},
        "versions": {},
    }
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_RUNNING
    assert ready_video.screen_text["erase"]["polls"] == 1
    # The tick ends; the next one is a fresh message, so the single worker slot stays free.
    assert enqueued.later_names() == ["hitgo.erase_poll"]


def test_poll_publishes_the_clean_copy_when_it_finishes(db, ready_video, enqueued, monkeypatch):
    provider = FakeErase(running_polls=0)
    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: provider)
    ready_video.screen_text = {
        "detect": _detect(),
        "erase": {"status": ST_RUNNING, "task_id": "t1", "polls": 0, "deadline": iso(utcnow() + timedelta(seconds=600))},
        "versions": {},
    }
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    er = ready_video.screen_text["erase"]
    assert er["status"] == ST_DONE
    assert er["clean_url"].endswith("/clean.mp4")
    assert storage.clean_path(ready_video.batch_id, ready_video.id).exists()
    assert enqueued.later_names() == []  # nothing left to poll


def test_poll_gives_up_at_the_deadline(db, ready_video, enqueued, monkeypatch):
    """A vendor task that silently vanished must not leave the item on 'running' forever."""
    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: FakeErase(running_polls=99))
    ready_video.screen_text = {
        "detect": _detect(),
        "erase": {"status": ST_RUNNING, "task_id": "t1", "polls": 5, "deadline": iso(utcnow() - timedelta(seconds=1))},
        "versions": {},
    }
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_FAILED
    assert "已中止" in ready_video.screen_text["erase"]["error"]
    assert enqueued.later_names() == []


def test_poll_ignores_a_job_that_is_no_longer_running(db, ready_video, enqueued, monkeypatch):
    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: FakeErase(running_polls=0))
    ready_video.screen_text = {"detect": _detect(), "erase": {"status": ST_DONE, "task_id": "t1"}, "versions": {}}
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_DONE
    assert enqueued.later_names() == []


def test_a_transient_poll_error_does_not_fail_the_job(db, ready_video, enqueued, monkeypatch):
    class Flaky(FakeErase):
        def poll(self, task_id):
            raise RuntimeError("网络抖动")

    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: Flaky())
    ready_video.screen_text = {
        "detect": _detect(),
        "erase": {"status": ST_RUNNING, "task_id": "t1", "polls": 0, "deadline": iso(utcnow() + timedelta(seconds=600))},
        "versions": {},
    }
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_RUNNING
    assert enqueued.later_names() == ["hitgo.erase_poll"]


# --- start / cleanup --------------------------------------------------------


def test_start_without_regions_fails_fast(db, ready_video, enqueued):
    st = {"detect": _detect(band=False, blocks=[]), "versions": {}}
    erase.start(db, ready_video, st, None)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_FAILED
    assert enqueued.later_names() == []


def test_start_records_the_scope_and_schedules_a_poll(db, ready_video, enqueued):
    st = {"detect": _detect(), "versions": {}}
    erase.start(db, ready_video, st, {"band": True, "block_ids": ["s0"]})

    db.refresh(ready_video)
    er = ready_video.screen_text["erase"]
    assert er["status"] == ST_RUNNING
    assert er["scope"] == {"band": True, "block_ids": ["s0"]}
    assert er["deadline"]
    assert enqueued.later_names() == ["hitgo.erase_poll"]


def test_delete_erase_removes_the_files(client, db, ready_video):
    for path in (
        storage.clean_path(ready_video.batch_id, ready_video.id),
        storage.clean_proxy_path(ready_video.batch_id, ready_video.id),
        storage.clean_poster_path(ready_video.batch_id, ready_video.id),
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    ready_video.screen_text = {"detect": _detect(), "erase": {"status": ST_DONE}, "versions": {}}
    db.commit()

    assert client.delete(f"/api/videos/{ready_video.id}/screen-text/erase").status_code == 204

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"] is None
    assert not storage.clean_path(ready_video.batch_id, ready_video.id).exists()
    assert not storage.clean_proxy_path(ready_video.batch_id, ready_video.id).exists()


def test_delete_erase_404_when_there_is_none(client, ready_video):
    assert client.delete(f"/api/videos/{ready_video.id}/screen-text/erase").status_code == 404


# --- source_variant (contract §2) -------------------------------------------


def test_render_uses_the_clean_copy_when_it_exists(db, ready_video):
    from app.schemas import EditSpec
    from app.services import render
    from tests.conftest import valid_spec

    clean = storage.clean_path(ready_video.batch_id, ready_video.id)
    clean.parent.mkdir(parents=True, exist_ok=True)
    clean.write_bytes(b"\x00" * 16)
    spec = EditSpec.model_validate({**valid_spec(), "source_variant": "clean"})

    path, warning = render.source_for(ready_video, spec)

    assert path.endswith("clean.mp4")
    assert warning is None


def test_render_falls_back_to_the_original_with_a_warning(db, ready_video):
    """Deleting the clean copy must not turn every saved spec into a failing export."""
    from app.schemas import EditSpec
    from app.services import render
    from tests.conftest import valid_spec

    storage.clean_path(ready_video.batch_id, ready_video.id).unlink(missing_ok=True)
    spec = EditSpec.model_validate({**valid_spec(), "source_variant": "clean"})

    path, warning = render.source_for(ready_video, spec)

    assert path.endswith("source.mp4")
    assert warning and "原片" in warning


def test_original_is_the_default(db, ready_video):
    from app.schemas import EditSpec
    from app.services import render
    from tests.conftest import valid_spec

    spec = EditSpec.model_validate(valid_spec())

    assert spec.source_variant == "original"
    assert render.source_for(ready_video, spec) == (
        str(storage.source_path(ready_video.batch_id, ready_video.id, ready_video.source_ext)),
        None,
    )


def test_a_sequence_cannot_use_the_clean_copy():
    """The concatenated source is virtual; there is no single clean.mp4 behind it."""
    import pytest as _pytest

    from app.schemas import EditSpec
    from tests.conftest import valid_spec

    spec = valid_spec()
    spec["source_variant"] = "clean"
    spec["sequence"] = {"clips": [{"id": "c_1", "video_id": "v_test000001", "in": 0, "out": 4.2}]}
    spec["trim"] = {"remove": []}
    with _pytest.raises(ValueError, match="无字版"):
        EditSpec.model_validate(spec)


# --- local provider survives a restart --------------------------------------


def test_local_erase_finds_its_result_without_remembering_it():
    """The poll tick may run in a worker that restarted since submit, so the provider must be
    able to find the file from the task id alone — not from anything held in the instance."""
    from app.services.erase import LocalErase

    task_id = "local-v_test000001"
    path = LocalErase._result_path(task_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"clean")
    try:
        fresh = LocalErase(width=1080, height=1920)  # a brand-new instance, as after a restart
        progress = fresh.poll(task_id)
        assert progress.status == "done"
        dst = storage.tmp_dir() / "moved.mp4"
        fresh.fetch(task_id, progress, dst)
        assert dst.exists() and not path.exists()
        dst.unlink()
    finally:
        path.unlink(missing_ok=True)


def test_local_erase_reports_a_missing_result_as_failed():
    from app.services.erase import LocalErase

    LocalErase._result_path("local-nothing").unlink(missing_ok=True)
    progress = LocalErase().poll("local-nothing")

    assert progress.status == "failed"
    assert "不见了" in (progress.error or "")


# --- start() must always leave a terminal status ----------------------------


def test_an_unknown_provider_fails_the_job_instead_of_stranding_it(db, ready_video, enqueued, monkeypatch):
    """Anything escaping start() would leave erase on queued forever, and every later request
    on this video answers 409 — only a database edit gets out of that."""
    monkeypatch.setattr(erase, "make_provider", lambda *a, **k: (_ for _ in ()).throw(erase.EraseError("不认识的擦除供应商：nope")))
    st = {"detect": _detect(), "erase": {"status": "queued"}, "versions": {}}

    erase.start(db, ready_video, st, None)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_FAILED
    assert "nope" in ready_video.screen_text["erase"]["error"]


def test_a_dead_broker_fails_the_job_instead_of_leaving_it_unpolled(db, ready_video, monkeypatch):
    from app import worker

    def boom(*a, **k):
        raise worker.QueueUnavailable("broker 不可达")

    monkeypatch.setattr(worker, "enqueue_later", boom)
    st = {"detect": _detect(), "erase": {"status": "queued"}, "versions": {}}

    erase.start(db, ready_video, st, None)

    db.refresh(ready_video)
    # Nothing would ever poll it, and the deadline is only checked inside poll_once.
    assert ready_video.screen_text["erase"]["status"] == ST_FAILED
    assert "进度查询" in ready_video.screen_text["erase"]["error"]


def test_a_provider_that_raises_on_submit_is_reported(db, ready_video, enqueued, monkeypatch):
    class Exploding(FakeErase):
        def submit(self, *a, **k):
            raise RuntimeError("厂商 SDK 炸了")

    monkeypatch.setattr(erase, "make_provider", lambda *a, **k: Exploding())
    st = {"detect": _detect(), "erase": {"status": "queued"}, "versions": {}}

    erase.start(db, ready_video, st, None)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_FAILED
    assert "厂商 SDK 炸了" in ready_video.screen_text["erase"]["error"]


# --- provider selection (HIG-38) --------------------------------------------


def test_ghostcut_needs_credentials_before_it_counts_as_available():
    """The editor greys out the erase button from this, so it must not promise what it cannot do."""
    from dataclasses import replace

    from app.config import settings as base

    bare = replace(base, erase_provider="ghostcut", ghostcut_app_key="", ghostcut_app_secret="")
    configured = replace(base, erase_provider="ghostcut", ghostcut_app_key="k", ghostcut_app_secret="s")

    assert erase.erase_enabled(bare) is False
    assert erase.erase_enabled(configured) is True
    # local needs nothing at all — it is the floor of the feature.
    assert erase.erase_enabled(replace(base, erase_provider="local")) is True


def test_an_unknown_provider_is_not_reported_as_available():
    from dataclasses import replace

    from app.config import settings as base

    assert erase.erase_enabled(replace(base, erase_provider="nope")) is False


def test_make_provider_refuses_ghostcut_without_credentials(ready_video):
    from dataclasses import replace

    from app.config import settings as base

    cfg = replace(base, erase_provider="ghostcut", ghostcut_app_key="", ghostcut_app_secret="")
    with pytest.raises(erase.EraseError, match="GHOSTCUT_APP_KEY"):
        erase.make_provider(ready_video, cfg)


def test_public_source_url_carries_a_read_ticket(ready_video):
    """A cloud vendor fetches the file itself, so /media is opened for this one path only."""
    from dataclasses import replace

    from app.config import settings as base
    from app.services import media_ticket

    cfg = replace(base, access_code="s3cret", public_base_url="https://hitgo.example")
    url = erase.public_source_url(ready_video, cfg)

    assert url.startswith("https://hitgo.example/media/batches/")
    head, _, query = url.partition("?t=")
    rel = head[len("https://hitgo.example/media/") :]
    assert media_ticket.verify(rel, query, "s3cret")
    # And the ticket is bound to that path: it cannot be moved to another file.
    assert not media_ticket.verify("batches/other/file.mp4", query, "s3cret")


def test_no_access_code_means_no_ticket_noise(ready_video):
    from dataclasses import replace

    from app.config import settings as base

    url = erase.public_source_url(ready_video, replace(base, access_code="", public_base_url="https://hitgo.example"))

    assert "?t=" not in url


def test_the_local_provider_is_not_handed_a_public_url(db, ready_video, enqueued, monkeypatch):
    """It reads the file off disk; minting a ticket for it would open /media for nothing."""
    seen = {}

    class Recording(FakeErase):
        def submit(self, source, public_url, regions, duration):
            seen["public_url"] = public_url
            return "t1"

    recording = Recording()
    recording.name = "local"
    monkeypatch.setattr(erase, "make_provider", lambda *a, **k: recording)
    erase.start(db, ready_video, {"detect": _detect(), "versions": {}}, None)

    assert seen["public_url"] is None


def test_a_cloud_provider_is_handed_a_public_url(db, ready_video, enqueued, monkeypatch):
    seen = {}

    class Recording(FakeErase):
        def submit(self, source, public_url, regions, duration):
            seen["public_url"] = public_url
            return "t1"

    recording = Recording()
    recording.name = "ghostcut"
    monkeypatch.setattr(erase, "make_provider", lambda *a, **k: recording)
    erase.start(db, ready_video, {"detect": _detect(), "versions": {}}, None)

    assert seen["public_url"].startswith("https://")
    assert "/media/batches/" in seen["public_url"]


# --- HIG-86: timeouts that can be resumed, ticks that must not strand the job ---


def _running(deadline_in: int, **extra):
    return {
        "status": ST_RUNNING,
        "provider": "ghostcut",
        "task_id": "249943229",
        "polls": 3,
        "deadline": iso(utcnow() + timedelta(seconds=deadline_in)),
        **extra,
    }


def test_a_cloud_timeout_can_be_resumed(db, ready_video, enqueued, monkeypatch):
    class Slow(FakeErase):
        def poll(self, task_id):
            return erase.EraseProgress(status="running", detail="排队中（状态 0）")

    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: Slow(name="ghostcut"))
    ready_video.screen_text = {"detect": _detect(), "erase": _running(-1), "versions": {}}
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    er = ready_video.screen_text["erase"]
    assert er["status"] == ST_FAILED
    assert er["resumable"] is True
    assert er["vendor_status"] == "排队中（状态 0）"
    assert "继续等待" in er["error"]
    assert er["task_id"] == "249943229"  # kept, so the same job can be polled again


def test_a_local_timeout_is_not_resumable(db, ready_video, enqueued, monkeypatch):
    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: FakeErase(running_polls=99))
    ready_video.screen_text = {"detect": _detect(), "erase": {**_running(-1), "provider": "fake"}, "versions": {}}
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["resumable"] is False
    assert "继续等待" not in ready_video.screen_text["erase"]["error"]


def test_a_running_tick_records_the_vendor_status(db, ready_video, enqueued, monkeypatch):
    class Slow(FakeErase):
        def poll(self, task_id):
            return erase.EraseProgress(status="running", detail="处理中 40%（状态 3）")

    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: Slow())
    ready_video.screen_text = {"detect": _detect(), "erase": _running(600), "versions": {}}
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["vendor_status"] == "处理中 40%（状态 3）"
    assert enqueued.later_names() == ["hitgo.erase_poll"]


def test_a_misconfigured_provider_fails_the_tick_instead_of_stranding_it(db, ready_video, enqueued, monkeypatch):
    def boom(video, cfg=None):
        raise erase.EraseError("没有配置 GHOSTCUT_APP_KEY / GHOSTCUT_APP_SECRET")

    monkeypatch.setattr(erase, "provider_for", boom)
    ready_video.screen_text = {"detect": _detect(), "erase": _running(600), "versions": {}}
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_FAILED
    assert "GHOSTCUT_APP_KEY" in ready_video.screen_text["erase"]["error"]


def test_an_unexpected_finish_error_fails_the_job(db, ready_video, enqueued, monkeypatch):
    class Broken(FakeErase):
        def fetch(self, task_id, progress, dst):
            raise OSError("disk full")

    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: Broken(name="ghostcut", running_polls=0))
    ready_video.screen_text = {"detect": _detect(), "erase": _running(600), "versions": {}}
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    er = ready_video.screen_text["erase"]
    assert er["status"] == ST_FAILED
    assert "disk full" in er["error"]
    assert er["resumable"] is True  # the vendor still has the result; fetching again is enough


def test_a_broker_hiccup_between_ticks_fails_the_job(db, ready_video, monkeypatch):
    from app import worker

    monkeypatch.setattr(erase, "provider_for", lambda video, cfg=None: FakeErase(running_polls=99))

    def boom(*args, **kwargs):
        raise worker.QueueUnavailable("redis down")

    monkeypatch.setattr(worker, "enqueue_later", boom)
    ready_video.screen_text = {"detect": _detect(), "erase": _running(600), "versions": {}}
    db.commit()

    erase.poll_once(db, ready_video.id)

    db.refresh(ready_video)
    assert ready_video.screen_text["erase"]["status"] == ST_FAILED
    assert "redis down" in ready_video.screen_text["erase"]["error"]


def test_the_stale_projection_offers_to_keep_waiting_past_the_deadline():
    state = {"erase": _running(-5, updated_at=iso(utcnow())), "versions": {}}
    out, changed = screentext.expire_stale_state(state, task_timeout_seconds=1200, erase_timeout_seconds=3600)

    assert changed
    assert out["erase"]["status"] == ST_FAILED
    assert out["erase"]["resumable"] is True
    assert "3600 秒仍未完成" in out["erase"]["error"]


def _texted_detect():
    detect = _detect()
    for block in detect["blocks"]:
        block["text"] = f"文字{block['id']}"
    return detect


def test_resume_polls_the_same_task_with_a_fresh_deadline(client, db, ready_video, enqueued):
    ready_video.screen_text = {
        "detect": _texted_detect(),
        "erase": {**_running(-60), "status": ST_FAILED, "resumable": True, "error": "擦除超过 3600 秒仍未完成"},
        "versions": {},
    }
    db.commit()

    r = client.post(f"/api/videos/{ready_video.id}/screen-text", json={"erase_resume": True})

    assert r.status_code == 202
    er = r.json()["screen_text"]["erase"]
    assert er["status"] == ST_RUNNING
    assert er["task_id"] == "249943229"
    assert er["resumable"] is False
    assert er["deadline"] > iso(utcnow())
    # Only a poll tick: nothing is resubmitted to the vendor.
    assert enqueued.later_names() == ["hitgo.erase_poll"]
    assert "hitgo.screen_text_video" not in enqueued.names()


def test_resume_refuses_when_there_is_nothing_to_resume(client, db, ready_video, enqueued):
    ready_video.screen_text = {
        "detect": _texted_detect(),
        "erase": {"status": ST_FAILED, "provider": "ghostcut", "task_id": "1", "error": "供应商擦除失败"},
        "versions": {},
    }
    db.commit()

    r = client.post(f"/api/videos/{ready_video.id}/screen-text", json={"erase_resume": True})

    assert r.status_code == 400
    assert "重新擦除" in r.json()["detail"]
    assert enqueued.later_names() == []

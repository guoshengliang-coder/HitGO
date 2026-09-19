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

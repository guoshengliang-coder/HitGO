"""API tests: TestClient + temp DATA_DIR + SQLite; Celery enqueue recorded, ffmpeg never called."""

from __future__ import annotations

import io
from datetime import timedelta

import pytest
from celery.exceptions import Retry
from fastapi.testclient import TestClient

from app import worker
from app.config import settings
from app.db import SessionLocal, utcnow
from app.main import app
from app.models import Asset, Batch, Job, Video
from app.services import storage
from tests.conftest import make_png, valid_spec

BATCH = "b_test000001"
VIDEO = "v_test000001"


def upload_files(names):
    return [("files", (n, io.BytesIO(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096), "video/mp4")) for n in names]


def put_spec(client, video_id, spec):
    return client.put(f"/api/videos/{video_id}/spec", json={"edit_spec": spec})


def add_job(db, video_id, variant, status, batch_id=BATCH, **kw):
    job = Job(id=kw.pop("id", f"j_{variant}_{status}"[:32]), batch_id=batch_id, video_id=video_id, variant_key=variant, status=status, **kw)
    db.add(job)
    db.commit()
    return job


# --- config / auth -------------------------------------------------------------


def test_safe_zones(client):
    r = client.get("/api/safe-zones")
    assert r.status_code == 200
    data = r.json()
    assert [z["key"] for z in data] == ["generic-vertical", "douyin", "kuaishou", "tencent", "meta", "google"]
    for preset in data:
        assert preset["aspect"] == "9:16" and preset["zones"] and "仅供参考" in preset["note"]
        for z in preset["zones"]:
            assert 0 <= z["x"] <= 1 and 0 <= z["y"] <= 1 and z["x"] + z["w"] <= 1.0001 and z["y"] + z["h"] <= 1.0001
        # new (nullable) keys are always present
        assert {"overlay_url", "inner", "outer"} <= preset.keys()
        assert preset["overlay_url"] in (None, f"/api/overlays/{preset['key']}.png")
        for frame in ("inner", "outer"):
            rect = preset[frame]
            assert rect is None or {"label", "x", "y", "w", "h"} <= rect.keys()
    # every shipped preset has an overlay and frames; inner sits inside outer
    for preset in data:
        assert preset["overlay_url"] and preset["inner"] and preset["outer"]
        assert "示意" in preset["note"]
        i, o = preset["inner"], preset["outer"]
        assert o["x"] <= i["x"] and o["y"] <= i["y"]
        assert i["x"] + i["w"] <= o["x"] + o["w"] + 1e-9 and i["y"] + i["h"] <= o["y"] + o["h"] + 1e-9


def test_overlays_served_and_validated(client):
    r = client.get("/api/overlays/douyin.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["cache-control"] == "public, max-age=86400"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    from PIL import Image

    with Image.open(io.BytesIO(r.content)) as img:
        assert img.size == (1080, 1920) and img.mode == "RGBA"
    for key in [p["key"] for p in client.get("/api/safe-zones").json()]:
        assert client.get(f"/api/overlays/{key}.png").status_code == 200
    assert client.get("/api/overlays/nope.png").status_code == 404
    assert client.get("/api/overlays/../safe_zones.png").status_code == 404
    assert client.get("/api/overlays/douyin.jpg").status_code == 404


def test_overlays_gated_by_access_code(monkeypatch, enqueued):
    monkeypatch.setattr(settings, "access_code", "secret", raising=True)
    with TestClient(app, base_url="https://testserver") as c:
        assert c.get("/api/overlays/douyin.png").status_code == 401
        assert c.get("/api/safe-zones").status_code == 401
        assert c.post("/api/auth", json={"code": "secret"}).status_code == 200
        assert c.get("/api/overlays/douyin.png").status_code == 200


# --- presets -------------------------------------------------------------------


def test_presets_lifecycle(client):
    assert client.get("/api/presets?type=text_style").json() == []
    style = {"font_family": "Noto Sans SC", "color": "#FFFFFF", "shadow": {"color": "#000000", "blur": 0.01, "offset": [0, 0.004]}, "letter_spacing": 0.02}
    r = client.post("/api/presets", json={"type": "text_style", "name": " 标题白字 ", "data": style})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["id"].startswith("p_") and p["type"] == "text_style" and p["name"] == "标题白字"
    assert p["data"] == style and p["created_at"].endswith("Z")

    r = client.post("/api/presets", json={"type": "text_style", "name": "second", "data": {"color": "#000"}})
    assert r.status_code == 201
    listed = client.get("/api/presets?type=text_style").json()
    assert [x["name"] for x in listed] == ["second", "标题白字"]  # newest first

    # validation
    assert client.post("/api/presets", json={"type": "sticker_pack", "name": "x", "data": {}}).status_code == 400
    assert client.post("/api/presets", json={"type": "text_style", "name": "", "data": {}}).status_code == 400
    assert client.post("/api/presets", json={"type": "text_style", "name": "   ", "data": {}}).status_code == 400
    assert client.post("/api/presets", json={"type": "text_style", "name": "x" * 41, "data": {}}).status_code == 400
    assert client.post("/api/presets", json={"type": "text_style", "name": "x" * 40, "data": {}}).status_code == 201
    assert client.post("/api/presets", json={"type": "text_style", "name": "no-data"}).status_code == 201
    assert client.post("/api/presets", json={"type": "text_style", "name": "bad", "data": [1]}).status_code == 400
    assert client.get("/api/presets").status_code == 400  # type is required
    assert client.get("/api/presets?type=bogus").status_code == 400

    assert client.delete(f"/api/presets/{p['id']}").status_code == 204
    assert client.delete(f"/api/presets/{p['id']}").status_code == 404
    assert p["id"] not in [x["id"] for x in client.get("/api/presets?type=text_style").json()]


def test_health_and_docs(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/openapi.json").status_code == 200


def test_auth_not_required_by_default(client):
    assert client.get("/api/auth").json() == {"required": False, "ok": True}
    assert client.post("/api/auth", json={"code": "anything"}).json() == {"required": False, "ok": True}


def test_auth_gate_with_access_code(monkeypatch, enqueued):
    monkeypatch.setattr(settings, "access_code", "secret", raising=True)
    # https base URL so the client echoes the Secure cookie back (PUBLIC_BASE_URL is https)
    with TestClient(app, base_url="https://testserver") as c:
        assert c.get("/api/auth").json() == {"required": True, "ok": False}
        assert c.get("/api/batches").status_code == 401
        assert c.get("/media/assets/x.png").status_code == 401
        assert c.post("/api/auth", json={"code": "wrong"}).status_code == 401
        r = c.post("/api/auth", json={"code": "secret"})
        assert r.status_code == 200 and r.json() == {"required": True, "ok": True}
        cookie = r.headers["set-cookie"]
        assert "hitgo_access=secret" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie.replace("Lax", "lax")
        assert "Max-Age=2592000" in cookie and "Secure" in cookie  # PUBLIC_BASE_URL is https
        assert c.get("/api/auth").json() == {"required": True, "ok": True}
        assert c.get("/api/batches").status_code == 200


def test_media_blocks_db_and_tmp(client):
    (settings.data_dir / "tmp").mkdir(exist_ok=True)
    (settings.data_dir / "tmp" / "x.mp4").write_bytes(b"x")
    assert client.get("/media/tmp/x.mp4").status_code == 404
    assert client.get("/media/hitgo.db").status_code == 404
    assert client.get("/media/hitgo.db-wal").status_code == 404
    png = make_png(settings.data_dir / "uploads" / "u_serve.png", (4, 4))
    r = client.get("/media/uploads/u_serve.png")
    assert r.status_code == 200 and r.content == png.read_bytes()


def test_spa_fallback_without_dist(client):
    r = client.get("/")
    assert r.status_code == 404 and "前端" in r.text
    assert client.get("/api/nope").status_code == 404
    assert client.get("/api/nope").json()["detail"]


def test_spa_serves_dist(monkeypatch, tmp_path, enqueued):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>app</html>")
    (dist / "assets" / "a.js").write_text("js")
    monkeypatch.setattr(settings, "frontend_dist", dist)
    from app.main import create_app

    with TestClient(create_app()) as c:
        assert c.get("/").text == "<html>app</html>"
        assert c.get("/batches/b_1").text == "<html>app</html>"
        assert c.get("/assets/a.js").text == "js"
        assert c.get("/api/unknown").status_code == 404


# --- batches -------------------------------------------------------------------


def test_batch_crud_and_ordering(client):
    assert client.get("/api/batches").json() == []
    r = client.post("/api/batches", json={"name": " 9 月新手引导 A/B "})
    assert r.status_code == 201
    b = r.json()
    assert b["id"].startswith("b_") and b["name"] == "9 月新手引导 A/B"
    assert b["video_count"] == 0 and b["created_at"].endswith("Z")
    assert b["status_counts"] == {"preparing": 0, "ready": 0, "edited": 0, "rendering": 0, "done": 0, "failed": 0}
    client.post("/api/batches", json={"name": "second"})
    names = [x["name"] for x in client.get("/api/batches").json()]
    assert names[0] == "second"  # newest first
    assert client.post("/api/batches", json={"name": "  "}).status_code == 400
    assert client.post("/api/batches", json={}).status_code == 400
    assert client.get("/api/batches/b_missing").status_code == 404
    assert client.get("/api/batches/b_missing").json()["detail"] == "批次不存在"
    assert client.delete(f"/api/batches/{b['id']}").status_code == 204
    assert client.get(f"/api/batches/{b['id']}").status_code == 404


def test_upload_videos_streams_and_enqueues(client, enqueued):
    bid = client.post("/api/batches", json={"name": "b"}).json()["id"]
    r = client.post(f"/api/batches/{bid}/videos", files=upload_files(["V01.mp4", "V02.MOV"]))
    assert r.status_code == 201, r.text
    videos = r.json()
    assert [v["order"] for v in videos] == [0, 1]
    assert [v["status"] for v in videos] == ["preparing", "preparing"]
    assert videos[0]["name"] == "V01.mp4" and videos[1]["source_url"].endswith("/source.mov")
    assert videos[0]["proxy_url"] is None and videos[0]["sprite"] is None
    assert videos[0]["render_status"] == "idle" and videos[0]["edited"] is False
    for v in videos:
        path = storage.media_url_to_path(v["source_url"])
        assert path and path.is_file() and path.stat().st_size > 4096
    assert enqueued.names() == ["hitgo.preprocess_video", "hitgo.preprocess_video"]
    assert [a[0] for _, a in enqueued.calls] == [v["id"] for v in videos]

    # order continues from existing count
    r = client.post(f"/api/batches/{bid}/videos", files=upload_files(["V03.mp4"]))
    assert r.json()[0]["order"] == 2
    detail = client.get(f"/api/batches/{bid}").json()
    assert detail["video_count"] == 3 and detail["status_counts"]["preparing"] == 3
    assert [v["name"] for v in detail["videos"]] == ["V01.mp4", "V02.MOV", "V03.mp4"]


def test_upload_rejects_bad_files_atomically(client, enqueued):
    bid = client.post("/api/batches", json={"name": "b"}).json()["id"]
    r = client.post(f"/api/batches/{bid}/videos", files=upload_files(["ok.mp4", "bad.avi"]))
    assert r.status_code == 400 and "avi" in r.json()["detail"]
    assert client.get(f"/api/batches/{bid}").json()["videos"] == []
    assert not any(storage.batch_dir(bid).rglob("source.*"))
    assert enqueued.calls == []
    assert client.post(f"/api/batches/{bid}/videos").status_code == 400
    assert client.post("/api/batches/b_missing/videos", files=upload_files(["a.mp4"])).status_code == 404


def test_upload_returns_503_when_queue_down(monkeypatch):
    """Real enqueue against an unreachable Redis → 503 and nothing persisted."""
    with TestClient(app) as c:
        bid = c.post("/api/batches", json={"name": "b"}).json()["id"]
        r = c.post(f"/api/batches/{bid}/videos", files=upload_files(["a.mp4"]))
        assert r.status_code == 503, r.text
        assert "Redis" in r.json()["detail"]
        assert c.get(f"/api/batches/{bid}").json()["videos"] == []


def test_delete_batch_removes_files_and_jobs(client, ready_video, db):
    out = storage.output_path("j_del")
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(b"v")
    add_job(db, VIDEO, "9x16", "done", id="j_del", output={"width": 1}, callback={})
    assert client.delete(f"/api/batches/{BATCH}").status_code == 204
    assert not storage.batch_dir(BATCH).exists() and not out.exists()
    assert db.query(Job).count() == 0 and db.query(Video).count() == 0


# --- videos / spec -------------------------------------------------------------


def test_get_video_ready_shape(client, ready_video):
    v = client.get(f"/api/videos/{VIDEO}").json()
    assert v["status"] == "ready" and v["duration"] == 24.6 and v["has_audio"] is True
    assert v["proxy_url"] == f"/media/batches/{BATCH}/{VIDEO}/proxy.mp4"
    assert v["poster_url"].endswith("poster.jpg") and v["sprite"]["columns"] == 10
    assert v["edit_spec"] is None and v["edited"] is False and v["render_status"] == "idle"
    assert client.get("/api/videos/v_missing").status_code == 404


def test_put_spec_validates_and_stores_raw(client, ready_video):
    spec = valid_spec()
    spec["layers"][0]["ui_color"] = "#fff"  # frontend-only field survives
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["edited"] is True and v["edit_spec"]["layers"][0]["ui_color"] == "#fff"

    bad = valid_spec(trim={"remove": [[1, 2], [20, 99]]})
    r = put_spec(client, VIDEO, bad)
    assert r.status_code == 400
    body = r.json()
    assert "校验失败" in body["detail"] and body["errors"][0]["field"].startswith("trim.remove")
    assert "超出视频时长" in body["errors"][0]["message"]

    r = put_spec(client, VIDEO, valid_spec(outputs=[]))
    assert r.status_code == 400 and "outputs" in r.json()["errors"][0]["field"]

    bad = valid_spec()
    bad["outputs"][1]["layer_overrides"]["l_1"]["asset_id"] = "x"
    r = put_spec(client, VIDEO, bad)
    assert r.status_code == 400 and "asset_id" in r.json()["errors"][0]["field"]

    r = put_spec(client, VIDEO, None)
    assert r.status_code == 200 and r.json()["edited"] is False


def test_put_spec_text_glow_round_trips(client, ready_video):
    spec = valid_spec()
    glow = {"color": "#FF7A1ACC", "blur": 0.014}
    spec["layers"][1]["style"]["glow"] = glow
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 200, r.text
    assert r.json()["edit_spec"]["layers"][1]["style"]["glow"] == glow
    assert client.get(f"/api/videos/{VIDEO}").json()["edit_spec"]["layers"][1]["style"]["glow"] == glow

    spec["layers"][1]["style"]["glow"] = None
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 200, r.text
    assert r.json()["edit_spec"]["layers"][1]["style"]["glow"] is None

    spec["layers"][1]["style"]["glow"] = {"color": "#FFFFFF", "blur": -1}
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 400 and "glow" in r.json()["errors"][0]["field"]


def test_put_spec_keeps_localize_markers_on_layers_and_tracks(client, ready_video):
    """origin / lang are frontend markers (contract §2): validated as extra, stored and returned raw."""
    spec = valid_spec()
    spec["layers"][1]["origin"] = "localize"
    spec["layers"][1]["lang"] = "ko"
    spec["audio"] = {
        "source_volume": 0,
        "tracks": [{"id": "au_1", "asset_id": "a_dub", "role": "voice", "align": "source", "t": "all", "origin": "localize", "lang": "ko"}],
    }  # fmt: skip
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 200, r.text
    got = client.get(f"/api/videos/{VIDEO}").json()["edit_spec"]
    assert got["layers"][1]["origin"] == "localize" and got["layers"][1]["lang"] == "ko"
    assert got["audio"]["tracks"][0]["origin"] == "localize" and got["audio"]["tracks"][0]["lang"] == "ko"


def test_put_spec_requires_ready_video(client, enqueued):
    bid = client.post("/api/batches", json={"name": "b"}).json()["id"]
    vid = client.post(f"/api/batches/{bid}/videos", files=upload_files(["a.mp4"])).json()[0]["id"]
    r = put_spec(client, vid, valid_spec())
    assert r.status_code == 400 and "预处理" in r.json()["detail"]


def test_delete_video(client, ready_video, db):
    add_job(db, VIDEO, "9x16", "failed")
    assert client.delete(f"/api/videos/{VIDEO}").status_code == 204
    assert client.get(f"/api/videos/{VIDEO}").status_code == 404
    assert not storage.video_dir(BATCH, VIDEO).exists()
    assert db.query(Job).count() == 0
    assert client.get(f"/api/batches/{BATCH}").json()["video_count"] == 0


def test_delete_video_refuses_while_rendering(client, ready_video, db):
    add_job(db, VIDEO, "9x16", "running")
    r = client.delete(f"/api/videos/{VIDEO}")
    assert r.status_code == 409 and "渲染" in r.json()["detail"]
    assert client.get(f"/api/videos/{VIDEO}").status_code == 200
    assert storage.video_dir(BATCH, VIDEO).exists()


def test_rename_video(client, ready_video):
    r = client.patch(f"/api/videos/{VIDEO}", json={"name": "  开场 A 版  "})
    assert r.status_code == 200 and r.json()["name"] == "开场 A 版"
    assert client.get(f"/api/videos/{VIDEO}").json()["name"] == "开场 A 版"
    assert client.patch(f"/api/videos/{VIDEO}", json={"name": "   "}).status_code == 400
    assert client.patch(f"/api/videos/{VIDEO}", json={"name": "x" * 256}).status_code == 400
    assert client.patch("/api/videos/v_missing", json={"name": "a"}).status_code == 404


def test_rename_batch(client, ready_video):
    r = client.patch(f"/api/batches/{BATCH}", json={"name": " 9 月投放 "})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "9 月投放" and body["video_count"] == 1
    assert client.get(f"/api/batches/{BATCH}").json()["name"] == "9 月投放"
    assert client.patch(f"/api/batches/{BATCH}", json={"name": ""}).status_code == 400
    assert client.patch("/api/batches/b_missing", json={"name": "a"}).status_code == 404


# --- render status derivation --------------------------------------------------


@pytest.mark.parametrize(
    "statuses,expected,bucket",
    [
        ([], "idle", "edited"),
        ([("9x16", "queued")], "queued", "rendering"),
        ([("9x16", "running"), ("1x1", "done")], "running", "rendering"),
        ([("9x16", "done"), ("1x1", "failed")], "failed", "failed"),
        ([("9x16", "done"), ("1x1", "done")], "done", "done"),
    ],
)
def test_render_status_from_latest_jobs(client, ready_video, db, statuses, expected, bucket):
    put_spec(client, VIDEO, valid_spec())
    # an older failed job on 9x16 must be superseded by the newer one
    add_job(db, VIDEO, "9x16", "failed", id="j_old", created_at=utcnow().replace(year=2000))
    for i, (variant, status) in enumerate(statuses):
        add_job(db, VIDEO, variant, status, id=f"j_new{i}")
    if not statuses:
        db.query(Job).delete()
        db.commit()
    assert client.get(f"/api/videos/{VIDEO}").json()["render_status"] == expected
    counts = client.get(f"/api/batches/{BATCH}").json()["status_counts"]
    assert counts[bucket] == 1


# --- render / jobs ---------------------------------------------------------------


def test_render_creates_jobs_and_conflicts(client, ready_video, enqueued):
    r = client.post("/api/render", json={"video_ids": [VIDEO]})
    assert r.status_code == 400 and "编辑参数" in r.json()["detail"]
    put_spec(client, VIDEO, valid_spec())
    enqueued.calls.clear()

    r = client.post("/api/render", json={"video_ids": [VIDEO, VIDEO]})
    assert r.status_code == 201, r.text
    jobs = r.json()
    assert [j["variant_key"] for j in jobs] == ["9x16", "1x1"]
    assert all(j["status"] == "queued" and j["progress"] == 0 and j["output_url"] is None for j in jobs)
    assert enqueued.names() == ["hitgo.render_job"] * 2
    assert client.get(f"/api/videos/{VIDEO}").json()["render_status"] == "queued"

    r = client.post("/api/render", json={"video_ids": [VIDEO]})
    assert r.status_code == 409
    body = r.json()
    assert body["detail"] and {c["variant_key"] for c in body["conflicts"]} == {"9x16", "1x1"}
    assert body["conflicts"][0]["video_id"] == VIDEO and body["conflicts"][0]["job_id"].startswith("j_")

    assert client.post("/api/render", json={"video_ids": ["v_missing"]}).status_code == 404
    assert client.post("/api/render", json={"video_ids": []}).status_code == 400

    ids = ",".join(j["id"] for j in jobs)
    polled = client.get(f"/api/jobs?ids={ids},j_nope").json()
    assert [j["id"] for j in polled] == [j["id"] for j in jobs]
    assert client.get("/api/jobs").json() == []
    assert client.get(f"/api/jobs/{jobs[0]['id']}").json()["variant_key"] == "9x16"
    assert client.get("/api/jobs/j_missing").status_code == 404

    listed = client.get(f"/api/batches/{BATCH}/jobs").json()
    assert len(listed) == 2 and client.get(f"/api/batches/{BATCH}/outputs").json() == []


def test_render_name_is_stored_on_every_job(client, ready_video, enqueued):
    spec = valid_spec()
    put_spec(client, VIDEO, spec)
    r = client.post("/api/render", json={"video_ids": [VIDEO], "name": "  九月投放 A  "})
    assert r.status_code == 201
    jobs = r.json()
    assert jobs and all(j["name"] == "九月投放 A" for j in jobs)
    assert client.get(f"/api/jobs/{jobs[0]['id']}").json()["name"] == "九月投放 A"


def test_render_name_is_optional_and_bounded(client, ready_video, enqueued):
    put_spec(client, VIDEO, valid_spec())
    assert client.post("/api/render", json={"video_ids": [VIDEO], "name": "x" * 121}).status_code == 400
    jobs = client.post("/api/render", json={"video_ids": [VIDEO], "name": "   "}).json()
    assert all(j["name"] is None for j in jobs)


def test_render_refuses_not_ready_video(client, enqueued):
    bid = client.post("/api/batches", json={"name": "b"}).json()["id"]
    vid = client.post(f"/api/batches/{bid}/videos", files=upload_files(["a.mp4"])).json()[0]["id"]
    r = client.post("/api/render", json={"video_ids": [vid]})
    assert r.status_code == 400 and "预处理" in r.json()["detail"]


def test_retry_only_failed(client, ready_video, db, enqueued):
    add_job(db, VIDEO, "9x16", "done", id="j_done")
    failed = add_job(db, VIDEO, "1x1", "failed", id="j_fail", error="boom", progress=40, finished_at=utcnow())
    assert client.post("/api/jobs/j_done/retry").status_code == 409
    r = client.post(f"/api/jobs/{failed.id}/retry")
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "queued" and j["progress"] == 0 and j["error"] is None and j["finished_at"] is None
    assert enqueued.names() == ["hitgo.render_job"]
    db.expire_all()
    assert db.get(Job, "j_fail").attempt == 2


def test_outputs_sorted_and_done_shape(client, ready_video, db):
    v2 = Video(id="v_test000002", batch_id=BATCH, name="V02.mp4", order_index=1, status="ready", duration=5, has_audio=False)
    db.add(v2)
    db.commit()
    out = {"width": 1080, "height": 1920, "duration": 20.6, "size": 123, "codec": "h264/aac"}
    add_job(db, "v_test000002", "9x16", "done", id="j_v2", output=out, callback={"k": 1})
    add_job(db, VIDEO, "9x16", "done", id="j_v1b", output=out, callback={"k": 2})
    add_job(db, VIDEO, "1x1", "done", id="j_v1a", output=out, callback={"k": 3})
    add_job(db, VIDEO, "4x5", "failed", id="j_v1f")
    r = client.get(f"/api/batches/{BATCH}/outputs").json()
    assert [(j["video_id"], j["variant_key"]) for j in r] == [(VIDEO, "1x1"), (VIDEO, "9x16"), ("v_test000002", "9x16")]
    assert r[0]["output_url"] == "/media/outputs/j_v1a.mp4" and r[0]["output"] == out and r[0]["callback"] == {"k": 3}
    # the per-batch list never carries the redundant names -- its caller already knows the batch
    assert all(j["batch_name"] is None and j["video_name"] is None for j in r)


# --- cross-batch outputs -----------------------------------------------------------


def _two_batches(db):
    """Second batch + video, so cross-batch ordering has something to cross."""
    b2 = Batch(id="b_test000002", name="第二批")
    v2 = Video(id="v_test000002", batch_id=b2.id, name="V02.mp4", order_index=0, status="ready", duration=5, has_audio=False)
    db.add_all([b2, v2])
    db.commit()
    return b2, v2


def test_all_outputs_is_cross_batch_newest_first(client, ready_video, db):
    b2, v2 = _two_batches(db)
    out = {"width": 1080, "height": 1920, "duration": 20.6, "size": 123, "codec": "h264/aac"}
    base = utcnow()
    add_job(db, VIDEO, "9x16", "done", id="j_old", output=out, finished_at=base - timedelta(minutes=10))
    add_job(db, v2.id, "9x16", "done", id="j_new", batch_id=b2.id, output=out, finished_at=base - timedelta(minutes=1))
    r = client.get("/api/outputs")
    assert r.status_code == 200
    got = r.json()
    assert [j["id"] for j in got] == ["j_new", "j_old"]
    assert [(j["batch_name"], j["video_name"]) for j in got] == [("第二批", "V02.mp4"), ("测试批次", "V01.mp4")]


def test_all_outputs_only_done(client, ready_video, db):
    out = {"width": 1080, "height": 1920, "duration": 20.6, "size": 123, "codec": "h264/aac"}
    add_job(db, VIDEO, "9x16", "done", id="j_done", output=out, finished_at=utcnow())
    add_job(db, VIDEO, "1x1", "failed", id="j_failed")
    add_job(db, VIDEO, "4x5", "queued", id="j_queued")
    assert [j["id"] for j in client.get("/api/outputs").json()] == ["j_done"]


def test_all_outputs_falls_back_to_created_at(client, ready_video, db):
    """A done row without finished_at still sorts by its own clock, not to one end."""
    out = {"width": 1080, "height": 1920, "duration": 20.6, "size": 123, "codec": "h264/aac"}
    base = utcnow()
    add_job(db, VIDEO, "9x16", "done", id="j_a", output=out, finished_at=base - timedelta(minutes=5))
    add_job(db, VIDEO, "1x1", "done", id="j_b", output=out, created_at=base - timedelta(minutes=1))
    add_job(db, VIDEO, "4x5", "done", id="j_c", output=out, finished_at=base - timedelta(minutes=30))
    assert [j["id"] for j in client.get("/api/outputs").json()] == ["j_b", "j_a", "j_c"]


def test_all_outputs_paging(client, ready_video, db):
    out = {"width": 1080, "height": 1920, "duration": 20.6, "size": 123, "codec": "h264/aac"}
    base = utcnow()
    for i in range(5):
        add_job(db, VIDEO, f"v{i}", "done", id=f"j_{i}", output=out, finished_at=base - timedelta(minutes=i))
    assert [j["id"] for j in client.get("/api/outputs?limit=2").json()] == ["j_0", "j_1"]
    assert [j["id"] for j in client.get("/api/outputs?limit=2&offset=2").json()] == ["j_2", "j_3"]
    assert [j["id"] for j in client.get("/api/outputs?limit=2&offset=4").json()] == ["j_4"]
    assert client.get("/api/outputs?limit=2&offset=99").json() == []
    # app-wide handler turns FastAPI's 422 into the project's 400 + errors[] shape
    assert client.get("/api/outputs?limit=0").status_code == 400
    assert client.get("/api/outputs?limit=501").status_code == 400
    assert client.get("/api/outputs?offset=-1").status_code == 400


def test_all_outputs_search(client, ready_video, db):
    b2, v2 = _two_batches(db)
    out = {"width": 1080, "height": 1920, "duration": 20.6, "size": 123, "codec": "h264/aac"}
    base = utcnow()
    add_job(db, VIDEO, "9x16", "done", id="j_named", output=out, name="Spring Promo", finished_at=base - timedelta(minutes=3))
    add_job(db, VIDEO, "1x1", "done", id="j_plain", output=out, finished_at=base - timedelta(minutes=2))
    add_job(db, v2.id, "9x16", "done", id="j_b2", batch_id=b2.id, output=out, finished_at=base - timedelta(minutes=1))

    def ids(q):
        return [j["id"] for j in client.get("/api/outputs", params={"q": q}).json()]

    assert ids("spring") == ["j_named"]  # export name, case-insensitive
    assert ids("第二批") == ["j_b2"]  # batch name
    assert ids("V01") == ["j_plain", "j_named"]  # video name
    assert ids("  ") == ["j_b2", "j_plain", "j_named"]  # blank = no filter
    assert ids("%") == []  # wildcards match literally
    assert [j["id"] for j in client.get("/api/outputs", params={"q": "V01", "limit": 1, "offset": 1}).json()] == ["j_named"]


def test_all_outputs_empty(client):
    assert client.get("/api/outputs").json() == []


# --- assets / uploads --------------------------------------------------------------


def test_assets_lifecycle(client, png_bytes, tmp_path):
    assert client.get("/api/assets").json() == []
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("限时免费.png", io.BytesIO(png_bytes), "image/png"))],
    )
    assert r.status_code == 200, r.text
    a = r.json()[0]
    assert a["id"].startswith("a_") and a["type"] == "sticker" and (a["width"], a["height"]) == (300, 120)
    assert a["url"] == f"/media/assets/{a['id']}.png" and a["source"] == "upload" and a["family"] is None
    assert client.get(a["url"]).status_code == 200

    r = client.post("/api/assets", data={"type": "font"}, files=[("files", ("Alibaba PuHuiTi.ttf", io.BytesIO(b"\x00" * 64), "font/ttf"))])
    assert r.status_code == 200
    f = r.json()[0]
    assert f["family"] == "Alibaba PuHuiTi" and f["width"] is None

    assert [x["type"] for x in client.get("/api/assets?type=font").json()] == ["font"]
    assert [x["type"] for x in client.get("/api/assets?type=sticker").json()] == ["sticker"]
    assert len(client.get("/api/assets").json()) == 2
    assert client.get("/api/assets?type=video").status_code == 400

    r = client.post("/api/assets", data={"type": "sticker"}, files=[("files", ("x.ttf", io.BytesIO(b"1"), "font/ttf"))])
    assert r.status_code == 400 and "png" in r.json()["detail"]
    r = client.post("/api/assets", data={"type": "sticker"}, files=[("files", ("x.png", io.BytesIO(b"not png"), "image/png"))])
    assert r.status_code == 400 and "解析" in r.json()["detail"]
    assert client.post("/api/assets", data={"type": "gif"}, files=[("files", ("x.png", io.BytesIO(png_bytes), "image/png"))]).status_code == 400

    path = storage.media_url_to_path(a["url"])
    assert client.delete(f"/api/assets/{a['id']}").status_code == 204
    assert not path.exists()
    assert client.delete(f"/api/assets/{a['id']}").status_code == 404


def test_assets_source_filter(client, png_bytes, db):
    from app.models import ASSET_SOURCE_BUILTIN, Asset

    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("mine.png", io.BytesIO(png_bytes), "image/png"))],
    )
    assert r.status_code == 200, r.text
    mine = r.json()[0]

    db.add(Asset(id="a_builtin001", type="sticker", name="内置.png", ext="png",
                 width=10, height=10, source=ASSET_SOURCE_BUILTIN))
    db.commit()

    assert [x["id"] for x in client.get("/api/assets?source=upload").json()] == [mine["id"]]
    assert [x["id"] for x in client.get("/api/assets?source=builtin").json()] == ["a_builtin001"]
    assert client.get("/api/assets?source=library").json() == []
    assert len(client.get("/api/assets?type=sticker").json()) == 2
    assert len(client.get("/api/assets?type=sticker&source=upload").json()) == 1
    assert client.get("/api/assets?source=nope").status_code == 400

    # builtin comes back on the next startup, so deleting it would be a fake delete
    r = client.delete("/api/assets/a_builtin001")
    assert r.status_code == 400 and "自己上传" in r.json()["detail"]
    assert client.delete(f"/api/assets/{mine['id']}").status_code == 204


def test_animated_gif_becomes_a_video_sticker(client, enqueued):
    """Replaces HIG-4's "reject animated GIF" rule.

    That rule existed because a multi-frame input rendered one pass and then froze;
    animated stickers now go down the video path instead, which plays and loops them.
    """
    from PIL import Image

    buf = io.BytesIO()
    frames = [Image.new("RGB", (8, 8), c).convert("P") for c in ((255, 0, 0), (0, 0, 255))]
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("anim.gif", io.BytesIO(buf.getvalue()), "image/gif"))],
    )
    assert r.status_code == 200, r.text
    a = r.json()[0]
    assert a["kind"] == "video" and a["status"] == "preparing"
    assert enqueued.names() == ["hitgo.preprocess_asset"]


def test_still_gif_stays_an_image_sticker(client, enqueued):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 0, 0)).convert("P").save(buf, "GIF")
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("still.gif", io.BytesIO(buf.getvalue()), "image/gif"))],
    )
    assert r.status_code == 200, r.text
    a = r.json()[0]
    assert a["kind"] == "image" and a["status"] == "ready" and (a["width"], a["height"]) == (8, 8)
    assert enqueued.calls == []


def test_sticker_upload_rejects_oversized_file(client, png_bytes, monkeypatch):
    from app.routers import assets as assets_router

    monkeypatch.setitem(assets_router.MAX_BYTES, "sticker", 16)
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("big.png", io.BytesIO(png_bytes), "image/png"))],
    )
    assert r.status_code == 400 and "上限" in r.json()["detail"]
    assert client.get("/api/assets").json() == []


def test_layer_image_upload(client, png_bytes):
    r = client.post("/api/uploads/layer-image", files={"file": ("text.png", io.BytesIO(png_bytes), "image/png")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"].startswith("/media/uploads/u_") and body["url"].endswith(".png")
    assert (body["width"], body["height"]) == (300, 120)
    assert client.get(body["url"]).status_code == 200
    r = client.post("/api/uploads/layer-image", files={"file": ("t.jpg", io.BytesIO(b"x"), "image/jpeg")})
    assert r.status_code == 400
    r = client.post("/api/uploads/layer-image", files={"file": ("t.png", io.BytesIO(b"nope"), "image/png")})
    assert r.status_code == 400


# --- batch apply --------------------------------------------------------------------


def test_batch_apply(client, ready_video, db):
    short = Video(id="v_test000002", batch_id=BATCH, name="V02.mp4", order_index=1, status="ready", duration=10.0, has_audio=True)
    other_batch_video = Video(id="v_other", batch_id=BATCH, name="V03.mp4", order_index=2, status="preparing")
    db.add_all([short, other_batch_video])
    db.commit()
    put_spec(client, VIDEO, valid_spec())

    r = client.post(f"/api/batches/{BATCH}/apply", json={"source_video_id": VIDEO, "target_video_ids": ["v_test000002", VIDEO], "modules": ["trim", "layers"]})
    assert r.status_code == 200, r.text
    updated = r.json()
    assert [v["id"] for v in updated] == ["v_test000002"]
    spec = updated[0]["edit_spec"]
    assert spec["trim"]["remove"] == [[3.2, 5.8]]  # 17–18.4 dropped for the 10 s target
    assert len(spec["layers"]) == 2 and spec["outputs"] == [] and updated[0]["edited"] is True

    r = client.post(f"/api/batches/{BATCH}/apply", json={"source_video_id": VIDEO, "target_video_ids": ["v_test000002"], "modules": ["outputs"]})
    assert len(r.json()[0]["edit_spec"]["outputs"]) == 2

    assert client.post(f"/api/batches/{BATCH}/apply", json={"source_video_id": "v_test000002", "target_video_ids": [VIDEO], "modules": ["bogus"]}).status_code == 400
    assert client.post(f"/api/batches/{BATCH}/apply", json={"source_video_id": "v_nope", "target_video_ids": [VIDEO], "modules": ["trim"]}).status_code == 404
    assert client.post(f"/api/batches/{BATCH}/apply", json={"source_video_id": VIDEO, "target_video_ids": ["v_nope"], "modules": ["trim"]}).status_code == 404
    put_spec(client, "v_test000002", None)
    r = client.post(f"/api/batches/{BATCH}/apply", json={"source_video_id": "v_test000002", "target_video_ids": [VIDEO], "modules": ["trim"]})
    assert r.status_code == 400 and "编辑参数" in r.json()["detail"]


def test_batch_apply_layer_mode(client, ready_video, db):
    target = Video(id="v_test000002", batch_id=BATCH, name="V02.mp4", order_index=1, status="ready", duration=24.6, has_audio=True)
    db.add(target)
    db.commit()
    put_spec(client, VIDEO, valid_spec())
    tspec = valid_spec(trim={"remove": []})
    tspec["layers"][0].update({"asset_id": "a_old", "anchor": "bottom-right", "margin": [0.02, 0.03], "t": [2, 9]})
    tspec["layers"][1].update({"text": "旧", "anchor": "center", "margin": [0.1, 0.2], "t": [1, 3]})
    assert put_spec(client, "v_test000002", tspec).status_code == 200

    body = {"source_video_id": VIDEO, "target_video_ids": ["v_test000002"], "modules": ["layers"], "layer_mode": "style_only"}
    r = client.post(f"/api/batches/{BATCH}/apply", json=body)
    assert r.status_code == 200, r.text
    layers = r.json()[0]["edit_spec"]["layers"]
    assert len(layers) == 2
    assert layers[0]["asset_id"] == "a_sticker001" and layers[0]["anchor"] == "bottom-right" and layers[0]["t"] == [2, 9]
    assert layers[1]["text"] == "限时免费" and layers[1]["anchor"] == "center" and layers[1]["t"] == [1, 3]

    body["layer_mode"] = "replace"
    layers = client.post(f"/api/batches/{BATCH}/apply", json=body).json()[0]["edit_spec"]["layers"]
    assert layers == valid_spec()["layers"]

    body["layer_mode"] = "merge"
    r = client.post(f"/api/batches/{BATCH}/apply", json=body)
    assert r.status_code == 400 and "layer_mode" in r.json()["errors"][0]["field"]


# --- worker task wrappers (ffmpeg mocked) --------------------------------------------


def test_preprocess_task_success_and_failure(ready_video, monkeypatch, db):
    from app.services import preprocess

    meta = {"width": 720, "height": 1280, "duration": 12.0, "fps": 25.0, "has_audio": False, "codec": "hevc",
            "sprite": {"url": "/media/x", "interval": 1.0, "tile_width": 90, "tile_height": 160, "columns": 10, "count": 12}}
    monkeypatch.setattr(preprocess, "run_preprocess", lambda **kw: meta)
    worker.preprocess_video.run(VIDEO)
    db.expire_all()
    v = db.get(Video, VIDEO)
    assert v.status == "ready" and v.width == 720 and v.has_audio is False and v.sprite["count"] == 12

    def boom(**kw):
        raise preprocess.PreprocessError("ffprobe 失败：moov atom not found")

    monkeypatch.setattr(preprocess, "run_preprocess", boom)
    worker.preprocess_video.run(VIDEO)
    db.expire_all()
    v = db.get(Video, VIDEO)
    assert v.status == "failed" and "moov" in v.error
    with pytest.raises(Retry):  # unknown row → retry (row may not be committed yet)
        worker.preprocess_video.run("v_missing")


def test_render_task_success_writes_output_and_callback(ready_video, monkeypatch, db, client):
    from app.services import ffprobe, render as render_service

    put_spec(client, VIDEO, valid_spec())
    make_png(storage.upload_path("u_text00001"), (540, 130))
    job = add_job(db, VIDEO, "9x16", "queued", id="j_run1")

    def fake_run(argv, expected, on_progress, **kw):
        assert argv[0] == settings.ffmpeg_bin and argv[-1] == str(storage.tmp_output_path("j_run1"))
        on_progress(50)
        storage.tmp_output_path("j_run1").write_bytes(b"mp4" * 100)

    monkeypatch.setattr(render_service, "run_ffmpeg", fake_run)
    monkeypatch.setattr(ffprobe, "probe", lambda p: {"width": 1080, "height": 1920, "duration": 20.6, "has_audio": True, "codec": "h264", "fps": 30, "size": 300})
    worker.render_job.run(job.id)
    db.expire_all()
    j = db.get(Job, job.id)
    assert j.status == "done" and j.progress == 100 and j.started_at and j.finished_at
    assert storage.output_path(job.id).is_file() and not storage.tmp_output_path(job.id).exists()
    assert j.output == {"width": 1080, "height": 1920, "duration": 20.6, "size": 300, "codec": "h264/aac"}
    cb = j.callback
    assert cb["session_id"] == BATCH and cb["source_id"] == VIDEO and cb["variant_key"] == "9x16"
    assert cb["output"]["url"] == "https://hitgo.example/media/outputs/j_run1.mp4"
    assert cb["idempotency_key"] == f"{BATCH}:{VIDEO}:9x16:1" and cb["operator"] == {"id": "demo", "name": "演示用户"}
    assert cb["edit_spec"]["spec_version"] == 1
    # sticker asset a_sticker001 does not exist → warning, still done
    assert j.error.startswith("警告：") and "a_sticker001" in j.error
    api = client.get(f"/api/jobs/{job.id}").json()
    assert api["output_url"] == "/media/outputs/j_run1.mp4" and api["callback"]["status"] == "done"


def test_render_task_records_the_audio_it_actually_mixed(ready_video, monkeypatch, db, client):
    """HIG-26: output.audio lists the tracks that went into the mix and the ones skipped."""
    from app.services import ffprobe, render as render_service

    storage.asset_path("a_voice_ok", "mp3").parent.mkdir(parents=True, exist_ok=True)
    storage.asset_path("a_voice_ok", "mp3").write_bytes(b"id3")
    db.add(Asset(id="a_voice_ok", type="audio", kind="audio", name="口播.mp3", ext="mp3", status="ready", source="upload", duration=24.0))
    db.commit()
    spec = valid_spec(layers=[])
    spec["audio"] = {"source_volume": 0, "tracks": [
        {"id": "au_v", "asset_id": "a_voice_ok", "role": "voice"},
        {"id": "au_old", "asset_id": "a_stem_deleted", "align": "source"},
    ]}  # fmt: skip
    put_spec(client, VIDEO, spec)
    job = add_job(db, VIDEO, "9x16", "queued", id="j_audio1")
    monkeypatch.setattr(render_service, "run_ffmpeg", lambda argv, expected, on_progress, **kw: storage.tmp_output_path("j_audio1").write_bytes(b"mp4"))
    monkeypatch.setattr(ffprobe, "probe", lambda p: {"width": 1080, "height": 1920, "duration": 20.6, "has_audio": True})
    worker.render_job.run(job.id)
    db.expire_all()
    j = db.get(Job, job.id)
    assert j.status == "done"
    assert j.output["audio"] == {
        "source_volume": 0.0,
        "source_mute": 0,
        "tracks": [{"id": "au_v", "asset_id": "a_voice_ok", "name": "口播.mp3", "role": "voice"}],
        "skipped": ["au_old"],
    }
    assert "au_old" in j.error
    assert client.get(f"/api/jobs/{job.id}").json()["output"]["audio"]["skipped"] == ["au_old"]


def test_render_task_failure_records_stderr_tail(ready_video, monkeypatch, db, client):
    from app.services import render as render_service

    put_spec(client, VIDEO, valid_spec())
    job = add_job(db, VIDEO, "1x1", "queued", id="j_run2")

    def fake_run(argv, expected, on_progress, **kw):
        raise render_service.RenderError("ffmpeg 退出码 1\nlast stderr line")

    monkeypatch.setattr(render_service, "run_ffmpeg", fake_run)
    worker.render_job.run(job.id)
    db.expire_all()
    j = db.get(Job, job.id)
    assert j.status == "failed" and "last stderr line" in j.error and j.finished_at
    assert client.get(f"/api/videos/{VIDEO}").json()["render_status"] == "failed"
    with pytest.raises(Retry):
        worker.render_job.run("j_missing")


def test_run_ffmpeg_progress_parsing(monkeypatch, tmp_path):
    """Drive run_ffmpeg with a fake 'ffmpeg' script that prints -progress style lines."""
    import sys

    from app.services.render import parse_progress_line, percent_for, run_ffmpeg

    assert parse_progress_line("out_time_us=1500000") == 1.5
    assert parse_progress_line("out_time_ms=N/A") is None and parse_progress_line("frame=1") is None
    assert percent_for(10, 20) == 50 and percent_for(30, 20) == 99 and percent_for(1, 0) == 0

    script = tmp_path / "fake_ffmpeg.py"
    script.write_text(
        "import sys\n"
        "for us in (2_000_000, 5_000_000, 10_000_000):\n"
        "    print(f'out_time_us={us}'); print('progress=continue'); sys.stdout.flush()\n"
        "print('progress=end')\n"
        "sys.stderr.write('warning line\\n')\n"
        "sys.exit(int(sys.argv[1]))\n"
    )
    seen: list[int] = []
    run_ffmpeg([sys.executable, str(script), "0"], 10.0, seen.append, min_interval=0)
    assert seen == [20, 50, 99]
    with pytest.raises(render_service_error()) as info:
        run_ffmpeg([sys.executable, str(script), "3"], 10.0, seen.append, min_interval=0)
    assert "退出码 3" in str(info.value) and "warning line" in str(info.value)


def render_service_error():
    from app.services.render import RenderError

    return RenderError


def test_ffprobe_parse_handles_rotation_and_rates():
    from app.services.ffprobe import ProbeError, parse_probe

    raw = {
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
             "avg_frame_rate": "30000/1001", "duration": "24.600000", "side_data_list": [{"rotation": -90}]},
            {"codec_type": "audio", "codec_name": "aac"},
        ],
        "format": {"duration": "24.62", "size": "1234"},
    }
    meta = parse_probe(raw)
    assert (meta["width"], meta["height"]) == (1080, 1920) and meta["fps"] == 29.97
    assert meta["duration"] == 24.6 and meta["has_audio"] and meta["codec"] == "h264" and meta["size"] == 1234
    with pytest.raises(ProbeError):
        parse_probe({"streams": [{"codec_type": "audio"}]})


def test_preprocess_command_builders(tmp_path):
    from app.services import preprocess

    src, dst = tmp_path / "s.mp4", tmp_path / "d"
    assert "scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)'" in preprocess.proxy_args(src, dst)
    assert preprocess.sprite_rows(24.6) == 3 and preprocess.sprite_rows(10) == 1 and preprocess.sprite_count(24.6) == 25
    v = preprocess.sprite_args(src, dst, 24.6, horizontal=False)
    assert v[v.index("-vf") + 1] == "fps=1,scale=90:-2,tile=10x3"
    h = preprocess.sprite_args(src, dst, 5, horizontal=True)
    assert h[h.index("-vf") + 1] == "fps=1,scale=160:-2,tile=10x1"
    assert preprocess.poster_time(24.6) == 0.5 and preprocess.poster_time(0.6) == 0.3
    p = preprocess.poster_args(src, dst, 0.6)
    assert p[p.index("-ss") + 1] == "0.300"
    sprite = make_png(tmp_path / "sprite.jpg", (900, 480))
    meta = preprocess.sprite_meta(sprite, "/media/x/sprite.jpg", 24.6)
    assert meta == {"url": "/media/x/sprite.jpg", "interval": 1.0, "tile_width": 90, "tile_height": 160, "columns": 10, "count": 25}


def test_storage_media_url_roundtrip():
    p = storage.upload_path("u_abc")
    assert storage.media_url(p) == "/media/uploads/u_abc.png"
    assert storage.media_url_to_path("/media/uploads/u_abc.png") == p.resolve()
    assert storage.media_url_to_path("/media/../etc/passwd") is None
    assert storage.media_url_to_path("/media/hitgo.db") is None
    assert storage.media_url_to_path("/media/tmp/x.mp4") is None
    assert storage.media_url_to_path("https://x/media/a.png") is None


def test_video_sticker_upload_is_async_and_pollable(client, enqueued, db):
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("角标动效.mp4", io.BytesIO(b"\x00" * 2048), "video/mp4"))],
    )
    assert r.status_code == 200, r.text
    a = r.json()[0]
    # Nothing is decoded inline: the worker fills width/height/duration later.
    assert a["kind"] == "video" and a["status"] == "preparing"
    assert a["width"] is None and a["poster_url"] is None and a["preview_url"] is None
    assert a["url"] == f"/media/assets/{a['id']}.mp4"
    assert enqueued.names() == ["hitgo.preprocess_asset"]
    assert [args[0] for _, args in enqueued.calls] == [a["id"]]

    single = client.get(f"/api/assets/{a['id']}")
    assert single.status_code == 200 and single.json()["status"] == "preparing"
    assert client.get("/api/assets/a_missing").status_code == 404

    # Once the worker is done the derived URLs appear.
    asset = db.get(Asset, a["id"])
    asset.status, asset.kind = "ready", "video"
    asset.width, asset.height, asset.duration = 600, 240, 2.4
    asset.fps, asset.has_alpha, asset.preview_ext = 30.0, False, "mp4"
    db.commit()
    ready = client.get(f"/api/assets/{a['id']}").json()
    # Derived files not on disk (yet): plain URLs, no version to add.
    assert ready["poster_url"] == f"/media/assets/{a['id']}.poster.jpg"
    assert ready["preview_url"] == f"/media/assets/{a['id']}.preview.mp4"
    assert ready["duration"] == 2.4 and ready["has_alpha"] is False


def test_video_sticker_upload_rejects_oversized_files(client, enqueued, monkeypatch):
    from app.routers import assets as assets_router

    monkeypatch.setattr(assets_router, "MAX_VIDEO_STICKER_BYTES", 2 * 1024 * 1024)
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("big.mov", io.BytesIO(b"\x00" * (3 * 1024 * 1024)), "video/quicktime"))],
    )
    assert r.status_code == 400 and "上限" in r.json()["detail"]
    assert client.get("/api/assets").json() == []
    assert enqueued.calls == []
    assert not any(storage.data_dir().joinpath("assets").glob("*.mov"))


def test_image_sticker_upload_stays_synchronous(client, enqueued, png_bytes):
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("静态.png", io.BytesIO(png_bytes), "image/png"))],
    )
    a = r.json()[0]
    assert a["kind"] == "image" and a["status"] == "ready" and (a["width"], a["height"]) == (300, 120)
    assert a["duration"] is None and a["has_alpha"] is None
    assert enqueued.calls == []  # no worker round-trip for still images


def test_deleting_a_video_sticker_removes_its_derived_files(client, db):
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("x.webm", io.BytesIO(b"\x00" * 512), "video/webm"))],
    )
    a = r.json()[0]
    asset = db.get(Asset, a["id"])
    asset.status, asset.preview_ext = "ready", "webm"
    db.commit()
    poster = storage.asset_poster_path(a["id"])
    preview = storage.asset_preview_path(a["id"], "webm")
    poster.write_bytes(b"jpg")
    preview.write_bytes(b"webm")

    assert client.delete(f"/api/assets/{a['id']}").status_code == 204
    assert not poster.exists() and not preview.exists()
    assert not storage.asset_path(a["id"], "webm").exists()


def test_render_skips_a_video_sticker_that_is_not_ready(ready_video, db, client):
    from app.services.render import collect_assets
    from app.schemas import EditSpec

    db.add(Asset(id="a_sticker001", type="sticker", name="v.mp4", ext="mp4",
                 kind="video", status="preparing", source="upload"))
    db.commit()
    spec = EditSpec.model_validate(valid_spec())
    # Not ready → not resolved → the graph builder warns and skips the layer.
    assert collect_assets(db, spec) == {}


# --- sticker audio + upload host (HIG-6 / HIG-7) ------------------------------------


def test_video_sticker_reports_has_audio_once_ready(client, db):
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("带声音.mp4", io.BytesIO(b"\x00" * 1024), "video/mp4"))],
    )
    a = r.json()[0]
    assert a["has_audio"] is None  # not probed yet
    asset = db.get(Asset, a["id"])
    asset.status, asset.width, asset.height, asset.duration = "ready", 600, 240, 2.0
    asset.has_audio, asset.preview_ext = True, "mp4"
    db.commit()
    assert client.get(f"/api/assets/{a['id']}").json()["has_audio"] is True


def test_audio_asset_upload_is_async_and_pollable(client, enqueued, db):
    r = client.post(
        "/api/assets",
        data={"type": "audio"},
        files=[("files", ("口播.mp3", io.BytesIO(b"\x00" * 2048), "audio/mpeg"))],
    )
    assert r.status_code == 200, r.text
    a = r.json()[0]
    assert a["type"] == "audio" and a["kind"] == "audio" and a["status"] == "preparing"
    assert a["url"] == f"/media/assets/{a['id']}.mp3" and a["duration"] is None
    assert a["width"] is None and a["poster_url"] is None and a["preview_url"] is None
    assert enqueued.names() == ["hitgo.preprocess_asset"]

    asset = db.get(Asset, a["id"])
    asset.status, asset.duration, asset.has_audio = "ready", 24.5, True
    db.commit()
    ready = client.get(f"/api/assets/{a['id']}").json()
    assert ready["status"] == "ready" and ready["duration"] == 24.5
    assert ready["poster_url"] is None and ready["preview_url"] is None  # no derived files for audio

    assert [x["type"] for x in client.get("/api/assets?type=audio").json()] == ["audio"]
    assert client.get("/api/assets?type=sticker").json() == []

    r = client.post("/api/assets", data={"type": "audio"}, files=[("files", ("x.ogg", io.BytesIO(b"1"), "audio/ogg"))])
    assert r.status_code == 400 and "mp3" in r.json()["detail"]
    r = client.post("/api/assets", data={"type": "sticker"}, files=[("files", ("x.mp3", io.BytesIO(b"1"), "audio/mpeg"))])
    assert r.status_code == 400

    path = storage.media_url_to_path(a["url"])
    assert client.delete(f"/api/assets/{a['id']}").status_code == 204
    assert not path.exists()


def test_audio_asset_upload_rejects_oversized_files(client, enqueued, monkeypatch):
    from app.routers import assets as assets_router

    monkeypatch.setitem(assets_router.MAX_BYTES, "audio", 1024)
    r = client.post("/api/assets", data={"type": "audio"}, files=[("files", ("big.wav", io.BytesIO(b"\x00" * 2048), "audio/wav"))])
    assert r.status_code == 400 and "上限" in r.json()["detail"]
    assert enqueued.names() == [] and client.get("/api/assets").json() == []


def test_audio_preprocess_only_probes_the_duration(monkeypatch, db):
    from app.services import ffprobe

    db.add(Asset(id="a_audio", type="audio", name="bgm.mp3", ext="mp3", kind="audio", status="preparing"))
    db.commit()
    monkeypatch.setattr(ffprobe, "probe_audio", lambda path: {"duration": 12.25, "codec": "mp3"})
    worker.preprocess_asset.run("a_audio")
    db.expire_all()
    asset = db.get(Asset, "a_audio")
    assert asset.status == "ready" and asset.duration == 12.25 and asset.has_audio is True
    assert asset.error is None and asset.width is None and asset.preview_ext is None

    def boom(path):
        raise ffprobe.ProbeError("文件里没有音频流")

    db.add(Asset(id="a_bad", type="audio", name="x.wav", ext="wav", kind="audio", status="preparing"))
    db.commit()
    monkeypatch.setattr(ffprobe, "probe_audio", boom)
    worker.preprocess_asset.run("a_bad")
    db.expire_all()
    bad = db.get(Asset, "a_bad")
    assert bad.status == "failed" and "音频流" in bad.error


def test_video_sticker_limit_is_one_gib():
    from app.routers import assets as assets_router

    assert assets_router.MAX_VIDEO_STICKER_BYTES == 1024 * 1024 * 1024
    assert assets_router._human_mib(assets_router.MAX_VIDEO_STICKER_BYTES) == "1 GiB"
    assert assets_router._human_mib(10 * 1024 * 1024) == "10 MiB"


def test_mix_audio_is_accepted_and_kept_in_the_spec(client, ready_video):
    spec = valid_spec()
    spec["layers"][0]["mix_audio"] = True
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 200, r.text
    assert client.get(f"/api/videos/{VIDEO}").json()["edit_spec"]["layers"][0]["mix_audio"] is True


def test_upload_ticket_is_empty_without_an_upload_host(client):
    assert client.post("/api/assets/upload-ticket").json() == {
        "upload_url": None,
        "ticket": None,
        "expires_at": None,
    }


def test_upload_ticket_lets_the_cookieless_upload_host_accept_assets(monkeypatch, enqueued, png_bytes):
    monkeypatch.setattr(settings, "access_code", "secret")
    monkeypatch.setattr(settings, "upload_base_url", "https://up.example")
    sticker = [("files", ("a.png", io.BytesIO(png_bytes), "image/png"))]
    with TestClient(app, base_url="https://testserver") as c:
        assert c.post("/api/assets/upload-ticket").status_code == 401  # gated like any API
        c.post("/api/auth", json={"code": "secret"})
        body = c.post("/api/assets/upload-ticket").json()
        assert body["upload_url"] == "https://up.example/api/assets"
        assert body["ticket"] and body["expires_at"].endswith("Z")
        ticket = body["ticket"]

    with TestClient(app, base_url="https://testserver") as bare:  # no cookie, like the upload host
        assert bare.post("/api/assets", data={"type": "sticker"}, files=sticker).status_code == 401
        bad = {"X-Upload-Ticket": ticket[:-1] + ("0" if ticket[-1] != "0" else "1")}
        assert bare.post("/api/assets", data={"type": "sticker"}, files=sticker, headers=bad).status_code == 401
        ok = bare.post(
            "/api/assets", data={"type": "sticker"}, files=sticker, headers={"X-Upload-Ticket": ticket}
        )
        assert ok.status_code == 200, ok.text
        # The ticket opens exactly one door.
        assert bare.get("/api/assets", headers={"X-Upload-Ticket": ticket}).status_code == 401
        assert bare.get("/api/batches", headers={"X-Upload-Ticket": ticket}).status_code == 401


def test_upload_host_cors_allows_the_main_site(monkeypatch, enqueued):
    from app.main import cors_origins, create_app

    monkeypatch.setattr(settings, "env", "prod")
    monkeypatch.setattr(settings, "access_code", "secret")
    assert cors_origins() == []  # prod without an upload host: no CORS at all
    monkeypatch.setattr(settings, "upload_base_url", "https://up.example")
    assert cors_origins() == ["https://hitgo.example"]

    with TestClient(create_app(), base_url="https://up.example") as c:
        # Preflight carries neither cookie nor ticket; it must not hit the access gate.
        r = c.options(
            "/api/assets",
            headers={
                "Origin": "https://hitgo.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-upload-ticket",
            },
        )
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == "https://hitgo.example"
        evil = c.options(
            "/api/assets",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
        assert evil.headers.get("access-control-allow-origin") != "https://evil.example"


def test_startup_backfills_has_audio_for_ready_video_stickers(enqueued, db):
    from app.main import backfill_video_sticker_audio

    db.add_all([
        Asset(id="a_old", type="sticker", name="old.mp4", ext="mp4", kind="video", status="ready"),
        Asset(id="a_known", type="sticker", name="k.mp4", ext="mp4", kind="video", status="ready", has_audio=False),
        Asset(id="a_prep", type="sticker", name="p.mp4", ext="mp4", kind="video", status="preparing"),
        Asset(id="a_png", type="sticker", name="s.png", ext="png"),
    ])  # fmt: skip
    db.commit()
    backfill_video_sticker_audio()
    assert enqueued.calls == [("hitgo.preprocess_asset", ("a_old",))]


def test_failed_backfill_keeps_a_ready_sticker_in_service(monkeypatch, db):
    from app.services import asset_preprocess

    db.add(Asset(id="a_ready", type="sticker", name="r.mp4", ext="mp4", kind="video", status="ready"))
    db.commit()

    def boom(**_kw):
        raise asset_preprocess.AssetPreprocessError("libopus missing")

    monkeypatch.setattr(asset_preprocess, "run_asset_preprocess", boom)
    worker.preprocess_asset.run("a_ready")
    db.expire_all()
    asset = db.get(Asset, "a_ready")
    assert asset.status == "ready" and asset.error is None
    assert asset.has_audio is False  # stops the startup backfill from retrying forever


def test_video_sticker_preview_url_changes_when_the_file_is_regenerated(client, db):
    """The audio backfill rewrites the preview in place; a stale browser cache must not win."""
    import os

    asset = Asset(
        id="a_regen", type="sticker", name="r.webm", ext="webm", kind="video", status="ready",
        width=600, height=240, duration=2.0, preview_ext="webm",
    )  # fmt: skip
    db.add(asset)
    db.commit()
    preview = storage.asset_preview_path("a_regen", "webm")
    poster = storage.asset_poster_path("a_regen")
    preview.parent.mkdir(parents=True, exist_ok=True)
    preview.write_bytes(b"old")
    poster.write_bytes(b"jpg")
    os.utime(preview, (1_700_000_000, 1_700_000_000))

    first = client.get("/api/assets/a_regen").json()
    assert first["preview_url"] == "/media/assets/a_regen.preview.webm?v=1700000000"
    assert first["poster_url"].startswith("/media/assets/a_regen.poster.jpg?v=")
    assert client.get(first["preview_url"]).content == b"old"  # the query is ignored when serving

    preview.write_bytes(b"new, with audio")
    os.utime(preview, (1_700_000_500, 1_700_000_500))
    second = client.get("/api/assets/a_regen").json()
    assert second["preview_url"] == "/media/assets/a_regen.preview.webm?v=1700000500"
    assert storage.media_url_to_path(second["preview_url"]) == preview.resolve()


def test_startup_seeds_sample_audio_as_builtin_assets(monkeypatch, enqueued, db, tmp_path, png_bytes):
    """samples/audio/*.mp3 become builtin audio assets that are probed like uploads (contract §1)."""
    from app.config import settings
    from app.main import seed_builtin_assets

    (tmp_path / "audio").mkdir()
    (tmp_path / "audio" / "bgm.mp3").write_bytes(b"\x00" * 512)
    (tmp_path / "audio" / "notes.txt").write_text("ignored")
    (tmp_path / "stickers").mkdir()
    (tmp_path / "stickers" / "s.png").write_bytes(png_bytes)
    monkeypatch.setattr(settings, "samples_dir", tmp_path)

    seed_builtin_assets()
    rows = {a.name: a for a in db.query(Asset).all()}
    assert set(rows) == {"bgm.mp3", "s.png"}
    audio = rows["bgm.mp3"]
    assert (audio.type, audio.kind, audio.status, audio.source) == ("audio", "audio", "preparing", "builtin")
    assert audio.family is None and storage.asset_path(audio.id, "mp3").is_file()
    assert enqueued.calls == [("hitgo.preprocess_asset", (audio.id,))]

    # Idempotent: a second startup does not import the same files again.
    seed_builtin_assets()
    assert db.query(Asset).count() == 2


# --- cover (HIG-9) --------------------------------------------------------------------


def test_jpg_sticker_upload_is_a_ready_image(client, enqueued):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (720, 1280), (200, 30, 30)).save(buf, "JPEG")
    r = client.post(
        "/api/assets",
        data={"type": "sticker"},
        files=[("files", ("封面.JPG", io.BytesIO(buf.getvalue()), "image/jpeg"))],
    )
    assert r.status_code == 200, r.text
    a = r.json()[0]
    assert a["kind"] == "image" and a["status"] == "ready" and (a["width"], a["height"]) == (720, 1280)
    assert a["url"].endswith(".jpg") and enqueued.calls == []


def test_collect_cover_resolves_only_ready_sticker_assets(ready_video, db, client):
    from app.schemas import EditSpec
    from app.services.render import build_plan, collect_cover

    make_png(storage.asset_path("a_cover_img", "png"), (1080, 1920))
    db.add_all([
        Asset(id="a_cover_img", type="sticker", name="c.png", ext="png", kind="image", status="ready",
              source="upload", width=1080, height=1920),
        Asset(id="a_cover_vid", type="sticker", name="c.mp4", ext="mp4", kind="video", status="preparing",
              source="upload"),
        Asset(id="a_font", type="font", name="f.ttf", ext="ttf", source="upload"),
    ])  # fmt: skip
    db.commit()

    def cover_of(asset_id, **extra):
        return collect_cover(db, EditSpec.model_validate(valid_spec(cover={"asset_id": asset_id, **extra})))

    cover = cover_of("a_cover_img", duration=2.5)
    assert cover is not None and not cover.media.is_video and cover.duration == 2.5
    assert cover_of("a_cover_vid") is None  # still preparing
    assert cover_of("a_font") is None  # not a sticker asset
    assert cover_of("a_missing") is None
    assert collect_cover(db, EditSpec.model_validate(valid_spec())) is None

    # The job plan carries the cover into the graph and the total duration.
    put_spec(client, VIDEO, valid_spec(cover={"asset_id": "a_cover_img", "duration": 2.5}))
    job = Job(id="j_cover0001", batch_id=BATCH, video_id=VIDEO, variant_key="9x16", status="queued")
    db.add(job)
    db.commit()
    db.expire_all()  # the spec was written through the API in another session
    plan = build_plan(db, job, db.get(Video, VIDEO))
    assert "concat=n=2:v=1:a=1[vfinal][afinal]" in plan.filter_complex
    assert plan.expected_duration == pytest.approx(2.5 + 20.6)


def test_batch_apply_cover_module(client, ready_video, db):
    other = Video(id="v_test000002", batch_id=BATCH, name="V02.mp4", order_index=1, status="ready", duration=10.0, has_audio=True)
    db.add(other)
    db.commit()
    put_spec(client, VIDEO, valid_spec(cover={"asset_id": "a_cover", "duration": 1.5}))
    r = client.post(f"/api/batches/{BATCH}/apply", json={"source_video_id": VIDEO, "target_video_ids": ["v_test000002"], "modules": ["cover"]})
    assert r.status_code == 200, r.text
    assert r.json()[0]["edit_spec"]["cover"] == {"asset_id": "a_cover", "duration": 1.5}


def test_mask_layer_round_trips_through_the_spec_api(client, ready_video):
    spec = valid_spec()
    mask = {"id": "l_m", "type": "mask", "mode": "solid", "color": "#112233", "blur": 1, "height": 0.2,
            "anchor": "bottom-center", "margin": [0, 0.1], "width": 1.0, "rotate": 0, "opacity": 0.8, "t": [0, 6],
            "name": "遮盖"}
    spec["layers"].insert(1, mask)
    spec["outputs"][1]["layer_overrides"]["l_m"] = {"height": 0.15}
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 200, r.text
    stored = client.get(f"/api/videos/{VIDEO}").json()["edit_spec"]
    assert stored["layers"][1] == mask  # raw spec, frontend-only name included
    assert stored["outputs"][1]["layer_overrides"]["l_m"] == {"height": 0.15}

    # defaults are the worker's business: a minimal mask is accepted as-is
    spec["layers"][1] = {"id": "l_m", "type": "mask"}
    del spec["outputs"][1]["layer_overrides"]["l_m"]
    assert put_spec(client, VIDEO, spec).status_code == 200
    assert client.get(f"/api/videos/{VIDEO}").json()["edit_spec"]["layers"][1] == {"id": "l_m", "type": "mask"}

    spec["layers"][1] = {"id": "l_m", "type": "mask", "color": "#00000080"}
    r = put_spec(client, VIDEO, spec)
    assert r.status_code == 400 and "color" in r.json()["errors"][0]["field"]

"""POST /api/outputs/zip (HIG-47): finished outputs streamed as one STORED zip."""

from __future__ import annotations

import io
import zipfile
from urllib.parse import unquote

from app.db import utcnow
from app.models import Batch, Job, Video
from app.routers.outputs import MAX_ZIP_JOBS
from app.services import storage
from app.services.output_zip import ZipEntry, dedupe_names, output_file_name, stream_zip

BATCH = "b_test000001"
VIDEO = "v_test000001"
OUT = {"width": 1080, "height": 1920, "duration": 20.6, "size": 123, "codec": "h264/aac"}


def add_done(db, job_id, variant="9x16", content=b"mp4", video_id=VIDEO, batch_id=BATCH, **kw):
    db.add(Job(id=job_id, batch_id=batch_id, video_id=video_id, variant_key=variant, status="done", output=OUT, finished_at=utcnow(), **kw))
    db.commit()
    if content is not None:
        path = storage.output_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def post_zip(client, ids):
    return client.post("/api/outputs/zip", data={"job_ids": ids})


def test_zip_contains_outputs_named_like_the_single_download(client, ready_video, db):
    add_done(db, "j_a", "9x16", b"A" * 5000, name="春季投放")
    add_done(db, "j_b", "1x1", b"B" * 10)
    r = post_zip(client, ["j_a", "j_b"])
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    disposition = r.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert unquote(disposition.split("filename*=UTF-8''")[1]).startswith("测试批次_产物_")
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert zf.testzip() is None
    assert zf.namelist() == ["春季投放_V01_9x16.mp4", "测试批次_V01_1x1.mp4"]
    assert zf.read("春季投放_V01_9x16.mp4") == b"A" * 5000
    assert all(i.compress_type == zipfile.ZIP_STORED for i in zf.infolist())


def test_zip_skips_unfinished_unknown_and_missing_files(client, ready_video, db):
    add_done(db, "j_ok", "9x16", b"ok")
    add_done(db, "j_gone", "1x1", content=None)  # done row whose file was deleted
    db.add(Job(id="j_run", batch_id=BATCH, video_id=VIDEO, variant_key="4x5", status="running"))
    db.commit()
    r = post_zip(client, ["j_run", "j_nope", "j_gone", "j_ok", "j_ok"])
    assert r.status_code == 200, r.text
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["测试批次_V01_9x16.mp4"]


def test_zip_dedupes_same_names_across_repeat_exports(client, ready_video, db):
    add_done(db, "j_1", "9x16", b"1")
    add_done(db, "j_2", "9x16", b"2")
    r = post_zip(client, ["j_2", "j_1"])
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert zf.namelist() == ["测试批次_V01_9x16.mp4", "测试批次_V01_9x16 (2).mp4"]
    assert zf.read("测试批次_V01_9x16 (2).mp4") == b"1"


def test_zip_across_batches_uses_generic_name(client, ready_video, db):
    db.add_all([Batch(id="b_test000002", name="第二批"), Video(id="v_test000002", batch_id="b_test000002", name="V02.mov", order_index=0, status="ready", duration=5, has_audio=False)])
    db.commit()
    add_done(db, "j_a", "9x16", b"a")
    add_done(db, "j_b", "9x16", b"b", video_id="v_test000002", batch_id="b_test000002")
    r = post_zip(client, ["j_a", "j_b"])
    assert unquote(r.headers["content-disposition"].split("filename*=UTF-8''")[1]).startswith("HitGO_产物_")
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["测试批次_V01_9x16.mp4", "第二批_V02_9x16.mp4"]


def test_zip_rejects_empty_nothing_downloadable_and_too_many(client, ready_video, db):
    assert client.post("/api/outputs/zip").status_code == 400
    assert post_zip(client, ["  "]).status_code == 400
    r = post_zip(client, ["j_nope"])
    assert r.status_code == 400 and "无法下载" in r.json()["detail"]
    r = post_zip(client, [f"j_{i}" for i in range(MAX_ZIP_JOBS + 1)])
    assert r.status_code == 400 and str(MAX_ZIP_JOBS) in r.json()["detail"]


def test_output_file_name_matches_frontend_rule():
    assert output_file_name("j_1", "9x16", None, "批次", "开场 A.MOV") == "批次_开场 A_9x16.mp4"
    assert output_file_name("j_1", "1x1", "a/b:c", "批次", "v.mp4") == "a_b_c_v_1x1.mp4"
    assert output_file_name("j_1", "", None, None, None) == "j_1.mp4"
    assert output_file_name("j_1", "9x16", "", "  多   空格 ", None) == "多 空格_9x16.mp4"


def test_dedupe_names_is_case_insensitive():
    assert dedupe_names(["a.mp4", "A.mp4", "a.mp4", "b"]) == ["a.mp4", "A (2).mp4", "a (3).mp4", "b"]


def test_stream_zip_emits_bytes_before_the_last_entry_and_reads_back(tmp_path):
    files = []
    for i in range(3):
        p = tmp_path / f"{i}.mp4"
        p.write_bytes(bytes([i]) * (2 << 20))  # two read chunks each
        files.append(ZipEntry(name=f"{i}.mp4", path=p))
    gen = stream_zip(files)
    first = next(gen)
    assert first.startswith(b"PK\x03\x04")  # local header of entry 0 is out before any other file is read
    data = first + b"".join(gen)
    zf = zipfile.ZipFile(io.BytesIO(data))
    assert zf.testzip() is None
    assert [len(zf.read(n)) for n in zf.namelist()] == [2 << 20] * 3


def test_zip_names_carry_the_language(client, ready_video, db):
    """HIG-43: 名称_视频名_语言名_规格.mp4; outputs without a language keep the old name."""
    add_done(db, "j_ko", "9x16", b"k", name="投放", lang="ko")
    add_done(db, "j_orig", "9x16", b"o", name="投放")
    add_done(db, "j_odd", "9x16", b"x", name="投放", lang="zz")
    r = post_zip(client, ["j_ko", "j_orig", "j_odd"])
    assert r.status_code == 200, r.text
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["投放_V01_韩语_9x16.mp4", "投放_V01_9x16.mp4", "投放_V01_zz_9x16.mp4"]


def test_output_file_name_language_segment():
    assert output_file_name("j", "1x1", None, "批次", "a.mov", "日语") == "批次_a_日语_1x1.mp4"
    assert output_file_name("j", "1x1", None, "批次", "a.mov", None) == "批次_a_1x1.mp4"

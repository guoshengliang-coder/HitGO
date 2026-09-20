"""GhostCut erase provider (HIG-38).

No SDK to stub here — the provider speaks plain HTTP — so these tests replace ``urlopen`` and
assert on the bytes that would go over the wire. The shapes mirror real responses captured
against the live API on 2026-09-20, which matters because the vendor's own documentation is
login-gated: if their format drifts, these fixtures are the record of what we built against.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from app.services.erase import EraseError, EraseRegion
from app.services.erase_ghostcut import GhostCutErase, masks_payload, sign, submit_payload

KEY, SECRET = "app-key", "app-secret"


def box(x, y, w, h):
    return {"x": x, "y": y, "w": w, "h": h}


def provider():
    return GhostCutErase(base_url="https://api.example.com", app_key=KEY, app_secret=SECRET)


class FakeResponse:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def read(self, size=-1):
        data, self._data = self._data, b""
        return data


@pytest.fixture
def http(monkeypatch):
    """Records requests and replays queued responses."""
    from app.services import erase_ghostcut

    sent: list[dict] = []
    queue: list = []

    def urlopen(request, timeout=0):  # noqa: ARG001
        if isinstance(request, str):  # the result download
            sent.append({"url": request})
        else:
            sent.append({"url": request.full_url, "headers": dict(request.headers), "body": request.data})
        if not queue:
            raise AssertionError("no queued response")
        nxt = queue.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return FakeResponse(nxt)

    monkeypatch.setattr(erase_ghostcut.urllib.request, "urlopen", urlopen)
    return type("Http", (), {"sent": sent, "queue": queue})()


def ok(body):
    return {"code": 1000, "msg": "success", "body": body}


# --- signing ----------------------------------------------------------------


def test_signature_is_md5_of_md5_body_plus_secret():
    """The scheme the vendor actually accepts; verified against the live gateway."""
    body = b'{"urls":["https://x/y.mp4"]}'
    expected = hashlib.md5((hashlib.md5(body).hexdigest() + SECRET).encode()).hexdigest()

    assert sign(body, SECRET) == expected


def test_the_signature_covers_the_exact_bytes_sent(http):
    http.queue.append(ok({"idProject": 1}))
    provider().submit(Path("/x/source.mp4"), "https://pub/source.mp4", [EraseRegion(box=box(0, 0.8, 1, 0.2))], 10.0)

    request = http.sent[0]
    assert request["headers"]["Appkey"] == KEY
    assert request["headers"]["Appsign"] == sign(request["body"], SECRET)


# --- request shape ----------------------------------------------------------


def test_masks_are_a_json_string_of_four_corner_points():
    """videoInpaintMasks is a string, not a nested object — the gateway rejects the object form."""
    masks = masks_payload([EraseRegion(box=box(0.06, 0.8, 0.88, 0.075))])
    parsed = json.loads(masks)

    assert isinstance(masks, str)
    assert parsed == [{
        "type": "remove_only_ocr",
        "start": 0,
        "end": 99999,
        "region": [[0.06, 0.8], [0.94, 0.8], [0.94, 0.875], [0.06, 0.875]],
    }]


def test_regions_are_marked_for_the_whole_clip_on_purpose():
    """remove_only_ocr erases the text a region *contains*, so a full-length mark is a no-op
    while the text is absent. That also keeps us off the undocumented start/end unit."""
    parsed = json.loads(masks_payload([EraseRegion(box=box(0.1, 0.1, 0.2, 0.05), t=(3.0, 7.0))]))

    assert parsed[0]["start"] == 0
    assert parsed[0]["end"] == 99999


def test_region_corners_are_clamped_inside_the_frame():
    parsed = json.loads(masks_payload([EraseRegion(box=box(0.9, 0.9, 0.5, 0.5))]))
    xs = [p[0] for p in parsed[0]["region"]]
    ys = [p[1] for p in parsed[0]["region"]]

    assert max(xs) <= 1.0 and max(ys) <= 1.0


def test_submit_payload_asks_for_the_advanced_removal_mode():
    payload = submit_payload("https://pub/a.mp4", [EraseRegion(box=box(0, 0.8, 1, 0.2))], "1080p", "hitgo")

    assert payload["urls"] == ["https://pub/a.mp4"]
    assert payload["needChineseOcclude"] == 2  # basic mode misses stylised captions
    assert payload["resolution"] == "1080p"


def test_submit_returns_the_project_id(http):
    http.queue.append(ok({"idProject": 249807732, "dataList": [{"id": 538176634, "url": "https://pub/a.mp4"}]}))

    task_id = provider().submit(Path("/x/source.mp4"), "https://pub/a.mp4", [EraseRegion(box=box(0, 0.8, 1, 0.2))], 3.0)

    assert task_id == "249807732"
    assert json.loads(http.sent[0]["body"])["urls"] == ["https://pub/a.mp4"]


def test_submit_without_a_public_url_fails_clearly(http):
    with pytest.raises(EraseError, match="公网"):
        provider().submit(Path("/x/source.mp4"), None, [EraseRegion(box=box(0, 0, 1, 1))], 3.0)


def test_missing_credentials_fail_before_any_call(http):
    bare = GhostCutErase(base_url="https://api.example.com")
    with pytest.raises(EraseError, match="GHOSTCUT_APP_KEY"):
        bare.submit(Path("/x/source.mp4"), "https://pub/a.mp4", [EraseRegion(box=box(0, 0, 1, 1))], 3.0)
    assert http.sent == []


# --- polling ----------------------------------------------------------------


def row(**over):
    base = {"id": 538176634, "idProject": 249807732, "processStatus": 0, "processProgress": 50.0,
            "errorDetail": "", "url": "https://pub/a.mp4"}
    base.update(over)
    return base


def test_poll_reports_running_until_the_result_appears(http):
    http.queue.append(ok({"content": [row()], "count": 1}))

    assert provider().poll("249807732").status == "running"


def test_poll_returns_the_result_url_on_success(http):
    http.queue.append(ok({"content": [row(processStatus=1, processProgress=100.0,
                                          videoUrl="https://cdn.example/clean.mp4")], "count": 1}))

    progress = provider().poll("249807732")

    assert progress.status == "done"
    assert progress.url == "https://cdn.example/clean.mp4"


def test_success_without_a_url_is_a_failure_not_a_silent_pass(http):
    http.queue.append(ok({"content": [row(processStatus=1, videoUrl="")], "count": 1}))

    progress = provider().poll("249807732")

    assert progress.status == "failed"
    assert "成片地址" in progress.error


def test_poll_surfaces_the_vendor_error_detail(http):
    http.queue.append(ok({"content": [row(processStatus=2, errorDetail="下载源视频失败")], "count": 1}))

    progress = provider().poll("249807732")

    assert progress.status == "failed"
    assert "下载源视频失败" in progress.error


def test_an_empty_status_page_is_a_failure(http):
    """The job is gone on their side; reporting 'running' forever would hang until the deadline."""
    http.queue.append(ok({"content": [], "count": 0}))

    assert provider().poll("249807732").status == "failed"


def test_a_business_error_is_raised_even_on_http_200(http):
    """The gateway answers 200 for business errors, so the body's code is the real check."""
    http.queue.append({"code": 3008, "msg": "urls is required"})

    with pytest.raises(EraseError, match="urls is required"):
        provider().poll("249807732")


# --- download ---------------------------------------------------------------


def test_fetch_streams_the_result_to_disk(http, tmp_path):
    http.queue.append(b"clean-bytes")
    dst = tmp_path / "clean.mp4"

    from app.services.erase import EraseProgress

    provider().fetch("249807732", EraseProgress(status="done", url="https://cdn.example/clean.mp4"), dst)

    assert dst.read_bytes() == b"clean-bytes"
    assert http.sent[0]["url"] == "https://cdn.example/clean.mp4"


def test_a_failed_download_leaves_no_half_file(http, tmp_path):
    http.queue.append(OSError("连接断开"))
    dst = tmp_path / "clean.mp4"

    from app.services.erase import EraseProgress

    with pytest.raises(EraseError, match="下载擦除结果失败"):
        provider().fetch("249807732", EraseProgress(status="done", url="https://cdn.example/clean.mp4"), dst)
    assert not dst.exists()


# --- resolution -------------------------------------------------------------


def test_resolution_follows_the_source_so_a_1080p_creative_is_not_downscaled():
    """The vendor re-encodes at whatever tier it is told; a fixed default would quietly
    hand back a 720p copy of a 1080p ad."""
    from app.services.erase_ghostcut import resolution_for

    assert resolution_for(480) == "480p"
    assert resolution_for(720) == "720p"
    assert resolution_for(1080) == "1080p"
    assert resolution_for(1920) == "1080p"  # vertical 1080x1920 creatives
    assert resolution_for(2160) == "1080p"  # the vendor's ceiling
    assert resolution_for(None) == "1080p"  # unknown: do not shrink


def test_the_submitted_resolution_comes_from_the_video(http):
    http.queue.append(ok({"idProject": 1}))
    tall = GhostCutErase(base_url="https://api.example.com", app_key=KEY, app_secret=SECRET, video_height=1920)

    tall.submit(Path("/x/source.mp4"), "https://pub/a.mp4", [EraseRegion(box=box(0, 0.8, 1, 0.2))], 3.0)

    assert json.loads(http.sent[0]["body"])["resolution"] == "1080p"


def test_an_explicit_resolution_overrides_the_source(http):
    http.queue.append(ok({"idProject": 1}))
    forced = GhostCutErase(base_url="https://api.example.com", app_key=KEY, app_secret=SECRET,
                           resolution="480p", video_height=1920)

    forced.submit(Path("/x/source.mp4"), "https://pub/a.mp4", [EraseRegion(box=box(0, 0.8, 1, 0.2))], 3.0)

    assert json.loads(http.sent[0]["body"])["resolution"] == "480p"

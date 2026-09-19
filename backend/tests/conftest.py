"""Test setup: temp DATA_DIR + SQLite, unreachable Redis, Celery enqueue recorded (not executed)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

# Must be set before any `app.*` import (settings are read at import time).
_TMP = Path(tempfile.mkdtemp(prefix="hitgo-test-"))
os.environ["DATA_DIR"] = str(_TMP / "data")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'data' / 'hitgo.db'}"
os.environ["REDIS_URL"] = "redis://127.0.0.1:1/0"  # nothing listens here
os.environ["ACCESS_CODE"] = ""
os.environ["PUBLIC_BASE_URL"] = "https://hitgo.example"
os.environ["SAMPLES_DIR"] = "-"
os.environ["ENV"] = "dev"
os.environ["FRONTEND_DIST"] = str(_TMP / "no-dist")
os.environ["LOCALIZE_PROVIDER"] = "fake"  # never dashscope / the network in tests
os.environ["MINIMAX_TTS_MODEL"] = "MiniMax/speech-2.8-hd"  # opt-in in prod (HIG-59); tests cover it on
os.environ["SCREENTEXT_PROVIDER"] = "fake"  # HIG-38: no vision model, no network
os.environ["ERASE_PROVIDER"] = "fake"  # HIG-38: no ffmpeg, no cloud vendor

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import worker  # noqa: E402
from app.db import SessionLocal, init_db, utcnow  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Asset, Batch, Job, Preset, Upload, Video  # noqa: E402
from app.services import storage  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _schema():
    storage.ensure_dirs()
    init_db()


@pytest.fixture(autouse=True)
def clean_db():
    """Start every test from an empty database."""
    db = SessionLocal()
    try:
        for model in (Job, Video, Batch, Asset, Upload, Preset):
            db.query(model).delete()
        db.commit()
    finally:
        db.close()
    yield


class EnqueueRecorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        # (task name, countdown, args) for the delayed variant (erase polling, HIG-38).
        self.later: list[tuple[str, int, tuple]] = []

    def __call__(self, task, *args) -> None:  # noqa: ANN001
        self.calls.append((task.name, args))

    def call_later(self, task, countdown: int, *args) -> None:  # noqa: ANN001
        self.later.append((task.name, countdown, args))

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def later_names(self) -> list[str]:
        return [name for name, _, _ in self.later]


@pytest.fixture
def enqueued(monkeypatch) -> EnqueueRecorder:
    rec = EnqueueRecorder()
    monkeypatch.setattr(worker, "enqueue", rec)
    monkeypatch.setattr(worker, "enqueue_later", rec.call_later)
    return rec


@pytest.fixture
def client(enqueued) -> TestClient:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


# --- factories ---------------------------------------------------------------


def make_png(path: Path, size: tuple[int, int] = (600, 240)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", size, (255, 0, 0, 128)).save(path, "PNG")
    return path


@pytest.fixture
def png_bytes() -> bytes:
    import io

    buf = io.BytesIO()
    Image.new("RGBA", (300, 120), (0, 255, 0, 255)).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def ready_video(db):
    """A batch with one preprocessed video (status=ready, duration 24.6s) and its source file."""
    batch = Batch(id="b_test000001", name="测试批次")
    video = Video(
        id="v_test000001",
        batch_id=batch.id,
        name="V01.mp4",
        order_index=0,
        status="ready",
        width=1080,
        height=1920,
        duration=24.6,
        fps=30.0,
        has_audio=True,
        codec="h264",
        sprite={
            "url": "/media/batches/b_test000001/v_test000001/sprite.jpg",
            "interval": 1.0,
            "tile_width": 90,
            "tile_height": 160,
            "columns": 10,
            "count": 25,
        },
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add_all([batch, video])
    db.commit()
    src = storage.source_path(batch.id, video.id)
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(b"\x00" * 16)
    return video


def valid_spec(**overrides) -> dict:
    spec = {
        "spec_version": 1,
        "trim": {"remove": [[3.2, 5.8], [17.0, 18.4]]},
        "layers": [
            {
                "id": "l_1",
                "type": "sticker",
                "asset_id": "a_sticker001",
                "anchor": "top-left",
                "margin": [0.08, 0.12],
                "width": 0.35,
                "rotate": 0,
                "opacity": 1,
                "t": [0, 6],
            },
            {
                "id": "l_2",
                "type": "text",
                "text": "限时免费",
                "style": {"font_family": "Noto Sans SC", "font_size": 0.05, "color": "#FFFFFF"},
                "image_url": "/media/uploads/u_text00001.png",
                "image_size": [540, 130],
                "anchor": "top-center",
                "margin": [0, 0.06],
                "width": 0.5,
                "rotate": 0,
                "opacity": 1,
                "t": "all",
            },
        ],
        "outputs": [
            {"variant_key": "9x16", "aspect": "9:16", "fill": "blur"},
            {
                "variant_key": "1x1",
                "aspect": "1:1",
                "fill": "blur",
                "layer_overrides": {"l_1": {"margin": [0.05, 0.05], "width": 0.3}},
            },
        ],
    }
    spec.update(overrides)
    return spec

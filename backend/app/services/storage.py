"""Filesystem layout under DATA_DIR (contract §5) and safe file helpers.

    {DATA_DIR}/hitgo.db
    {DATA_DIR}/batches/{batch_id}/{video_id}/source.mp4 | proxy.mp4 | poster.jpg | sprite.jpg
    {DATA_DIR}/assets/{asset_id}.{ext} | {asset_id}.poster.jpg | {asset_id}.preview.{webm|mp4}
    {DATA_DIR}/uploads/{upload_id}.png
    {DATA_DIR}/outputs/{job_id}.mp4
    {DATA_DIR}/tmp/
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import BinaryIO

from app.config import settings

MEDIA_PREFIX = "/media"
# Paths under DATA_DIR that must never be served through /media.
MEDIA_BLOCKED_PREFIXES = ("hitgo.db", "tmp")

CHUNK_SIZE = 1024 * 1024


def data_dir() -> Path:
    return settings.data_dir


def ensure_dirs() -> None:
    for sub in ("batches", "assets", "uploads", "outputs", "tmp"):
        (data_dir() / sub).mkdir(parents=True, exist_ok=True)


# --- batches / videos --------------------------------------------------------


def batch_dir(batch_id: str) -> Path:
    return data_dir() / "batches" / batch_id


def video_dir(batch_id: str, video_id: str) -> Path:
    return batch_dir(batch_id) / video_id


def source_path(batch_id: str, video_id: str, ext: str = "mp4") -> Path:
    return video_dir(batch_id, video_id) / f"source.{ext}"


def proxy_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "proxy.mp4"


def poster_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "poster.jpg"


def sprite_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "sprite.jpg"


# --- assets / uploads / outputs / tmp ----------------------------------------


def asset_path(asset_id: str, ext: str) -> Path:
    return data_dir() / "assets" / f"{asset_id}.{ext}"


def asset_poster_path(asset_id: str) -> Path:
    """Video sticker: first frame, shown in the asset grid and as a canvas fallback."""
    return data_dir() / "assets" / f"{asset_id}.poster.jpg"


def asset_preview_path(asset_id: str, ext: str) -> Path:
    """Video sticker: browser-playable proxy (rendering always uses the original)."""
    return data_dir() / "assets" / f"{asset_id}.preview.{ext}"


def upload_path(upload_id: str) -> Path:
    return data_dir() / "uploads" / f"{upload_id}.png"


def output_path(job_id: str) -> Path:
    return data_dir() / "outputs" / f"{job_id}.mp4"


def tmp_dir() -> Path:
    return data_dir() / "tmp"


def tmp_output_path(job_id: str) -> Path:
    return tmp_dir() / f"{job_id}.mp4"


# --- URL mapping -------------------------------------------------------------


def media_url(path: Path) -> str:
    """Absolute filesystem path under DATA_DIR → '/media/...' site-relative URL."""
    rel = path.resolve().relative_to(data_dir().resolve())
    return f"{MEDIA_PREFIX}/{rel.as_posix()}"


def media_url_to_path(url: str) -> Path | None:
    """'/media/uploads/u_x.png' → absolute path, or None if it escapes DATA_DIR / is blocked."""
    if not url.startswith(MEDIA_PREFIX + "/"):
        return None
    rel = url[len(MEDIA_PREFIX) + 1 :].split("?", 1)[0]
    if is_blocked_media_path(rel):
        return None
    base = data_dir().resolve()
    candidate = (base / rel).resolve()
    if candidate == base or base not in candidate.parents:
        return None
    return candidate


def is_blocked_media_path(rel: str) -> bool:
    rel = rel.lstrip("/")
    first = rel.split("/", 1)[0]
    return any(first == p or first.startswith(p) for p in MEDIA_BLOCKED_PREFIXES)


# --- file helpers ------------------------------------------------------------


def write_stream(src: BinaryIO, dst: Path, chunk_size: int = CHUNK_SIZE) -> int:
    """Copy a (sync) file object to dst in chunks, atomically. Returns bytes written."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    total = 0
    with open(tmp, "wb") as out:
        while True:
            chunk = src.read(chunk_size)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
    os.replace(tmp, dst)
    return total


async def write_upload(upload, dst: Path, chunk_size: int = CHUNK_SIZE) -> int:  # noqa: ANN001
    """Copy a Starlette UploadFile to dst in chunks (never whole-file in memory)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    total = 0
    with open(tmp, "wb") as out:
        while True:
            chunk = await upload.read(chunk_size)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
    os.replace(tmp, dst)
    return total


def move_atomic(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(src, dst)
    except OSError:
        # Cross-device: copy then remove.
        shutil.copy2(src, dst)
        src.unlink(missing_ok=True)


def remove_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0

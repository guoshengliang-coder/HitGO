"""Filesystem layout under DATA_DIR (contract §5) and safe file helpers.

    {DATA_DIR}/hitgo.db
    {DATA_DIR}/batches/{batch_id}/{video_id}/source.mp4 | proxy.mp4 | poster.jpg | sprite.jpg | still.{jpg|png}
    {DATA_DIR}/assets/{asset_id}.{ext} | {asset_id}.poster.jpg | {asset_id}.preview.{webm|mp4}
    {DATA_DIR}/uploads/{upload_id}.png
    {DATA_DIR}/outputs/{job_id}.{mp4|mov|png|jpg}
    {DATA_DIR}/tmp/                          ({video_id}.loc/ while a localization runs)
    {DATA_DIR}/voice-samples/{video_id}.{m4a|wav}   voice-cloning sample (HIG-58)
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
    for sub in ("batches", "assets", "uploads", "outputs", "tmp", "voice-samples"):
        (data_dir() / sub).mkdir(parents=True, exist_ok=True)


# --- batches / videos --------------------------------------------------------


def batch_dir(batch_id: str) -> Path:
    return data_dir() / "batches" / batch_id


def video_dir(batch_id: str, video_id: str) -> Path:
    return batch_dir(batch_id) / video_id


def source_path(batch_id: str, video_id: str, ext: str = "mp4") -> Path:
    return video_dir(batch_id, video_id) / f"source.{ext}"


def still_path(batch_id: str, video_id: str, ext: str) -> Path:
    """Uploaded still image for a kind=image video; preprocess turns it into source.mp4."""
    return video_dir(batch_id, video_id) / f"still.{ext}"


def find_still(batch_id: str, video_id: str) -> Path | None:
    """The still.<ext> of a kind=image video (the extension is not stored on the row)."""
    return next(iter(sorted(video_dir(batch_id, video_id).glob("still.*"))), None)


def proxy_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "proxy.mp4"


def poster_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "poster.jpg"


def sprite_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "sprite.jpg"


# On-screen text erasure (contract §1 screen_text.erase, HIG-38). Same geometry, frame rate,
# duration and audio as source.mp4, so nothing in edit_spec needs converting between the two.
def clean_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "clean.mp4"


def clean_proxy_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "clean_proxy.mp4"


def clean_poster_path(batch_id: str, video_id: str) -> Path:
    return video_dir(batch_id, video_id) / "clean_poster.jpg"


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


def output_path(job_id: str, output_format: str = "mp4") -> Path:
    return data_dir() / "outputs" / f"{job_id}.{output_format}"


def tmp_dir() -> Path:
    return data_dir() / "tmp"


def tmp_output_path(job_id: str, output_format: str = "mp4") -> Path:
    return tmp_dir() / f"{job_id}.{output_format}"


def voice_sample_path(video_id: str, ext: str) -> Path:
    """Sample a voice clone was made from (HIG-58). Served through /media with a read ticket."""
    return data_dir() / "voice-samples" / f"{video_id}.{ext}"


def find_voice_sample(video_id: str) -> Path | None:
    """The stored sample of a video, whichever extension it was written with."""
    return next(iter(sorted((data_dir() / "voice-samples").glob(f"{video_id}.*"))), None)


def localize_tmp_dir(video_id: str) -> Path:
    """Scratch dir for one localization run (16 kHz wav, per-cue TTS clips); removed after."""
    return tmp_dir() / f"{video_id}.loc"


# --- URL mapping -------------------------------------------------------------


def media_url(path: Path) -> str:
    """Absolute filesystem path under DATA_DIR → '/media/...' site-relative URL."""
    rel = path.resolve().relative_to(data_dir().resolve())
    return f"{MEDIA_PREFIX}/{rel.as_posix()}"


def versioned_media_url(path: Path) -> str:
    """``media_url`` plus ``?v=<mtime>`` for files regenerated in place.

    /media responses carry no Cache-Control, so browsers reuse them heuristically. A
    derived file rewritten under the same name (the video sticker preview the audio
    backfill redoes) would keep playing the stale copy; a changed URL cannot.
    StaticFiles ignores the query, and ``media_url_to_path`` strips it.
    """
    url = media_url(path)
    try:
        return f"{url}?v={int(path.stat().st_mtime)}"
    except OSError:
        return url


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

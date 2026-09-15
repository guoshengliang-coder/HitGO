"""Assets: GET/POST/DELETE /api/assets (stickers and fonts, contract §3).

Image stickers are probed inline with Pillow. Video stickers (mp4/mov/webm, plus
animated gif/webp) cannot be — they need ffprobe, a poster and a browser-playable
preview proxy — so they land as ``status=preparing`` and a Celery task finishes
the job, mirroring how source videos are ingested in ``routers/batches.py``.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, Query, UploadFile
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ids, worker
from app.db import get_db
from app.models import (
    ASSET_FONT,
    ASSET_IMAGE,
    ASSET_PREPARING,
    ASSET_READY,
    ASSET_SOURCE_UPLOAD,
    ASSET_STICKER,
    ASSET_VIDEO,
    Asset,
)
from app.routers._common import enqueue_or_503
from app.schemas import AssetOut
from app.serializers import asset_out
from app.services import storage
from app.services.ffprobe import ANIMATABLE_IMAGE_EXTS, VIDEO_STICKER_EXTS

router = APIRouter(prefix="/api/assets", tags=["assets"])

STICKER_IMAGE_EXTS = {"png", "webp", "gif"}
STICKER_EXTS = STICKER_IMAGE_EXTS | set(VIDEO_STICKER_EXTS)
FONT_EXTS = {"ttf", "otf", "woff2"}
ALLOWED = {ASSET_STICKER: STICKER_EXTS, ASSET_FONT: FONT_EXTS}

# Contract §3: per-file upload ceilings. The prototype only ever holds a handful of small
# overlays, and nginx's 2g body limit is far too loose to catch a mistaken drag-and-drop.
MAX_BYTES = {ASSET_STICKER: 10 * 1024 * 1024, ASSET_FONT: 20 * 1024 * 1024}
# Video stickers are decoded frame by frame on every render, so they get their own (larger
# but still bounded) ceiling; the duration cap is enforced by the preprocessing task.
MAX_VIDEO_STICKER_BYTES = 50 * 1024 * 1024
MAX_VIDEO_STICKER_SECONDS = 60.0


def _ext(filename: str) -> str:
    return Path(filename).suffix.lower().lstrip(".")


def _human_mib(size: int) -> str:
    return f"{size // (1024 * 1024)} MiB"


def _asset_files(asset: Asset) -> list[Path]:
    """Every file on disk belonging to this asset, derived files included."""
    paths = [storage.asset_path(asset.id, asset.ext)]
    if asset.kind == ASSET_VIDEO:
        paths.append(storage.asset_poster_path(asset.id))
        if asset.preview_ext:
            paths.append(storage.asset_preview_path(asset.id, asset.preview_ext))
    return paths


def _read_image_sticker(path: Path, name: str) -> tuple[tuple[int, int], int]:
    """(size, frame count) of an uploaded image sticker; rejects unreadable files."""
    try:
        with Image.open(path) as img:
            return img.size, getattr(img, "n_frames", 1)
    except (UnidentifiedImageError, OSError):
        raise HTTPException(400, f"{name}：无法解析图片") from None


@router.get("", response_model=list[AssetOut])
def list_assets(
    type: str | None = Query(default=None, pattern="^(sticker|font)$"),
    source: str | None = Query(default=None, pattern="^(upload|builtin|library)$"),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    stmt = select(Asset).order_by(Asset.created_at.desc(), Asset.id)
    if type:
        stmt = stmt.where(Asset.type == type)
    if source:
        stmt = stmt.where(Asset.source == source)
    return [asset_out(a) for a in db.scalars(stmt).all()]


@router.get("/{asset_id}", response_model=AssetOut)
def get_asset(asset_id: str, db: Session = Depends(get_db)) -> AssetOut:
    """Single asset; the frontend polls this while a video sticker is preparing."""
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(404, "素材不存在")
    return asset_out(asset)


@router.post("", response_model=list[AssetOut])
async def create_assets(
    type: str = Form(...),
    files: list[UploadFile] = [],  # noqa: B006 - FastAPI form binding
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    if type not in ALLOWED:
        raise HTTPException(400, "type 必须是 sticker 或 font")
    if not files:
        raise HTTPException(400, "没有上传文件")

    created: list[Asset] = []
    written: list[Path] = []
    pending: list[str] = []  # asset ids needing async preprocessing
    try:
        for upload in files:
            name = upload.filename or "file"
            ext = _ext(name)
            if ext not in ALLOWED[type]:
                raise HTTPException(
                    400, f"{name}：{type} 只支持 {', '.join(sorted(ALLOWED[type]))} 格式"
                )
            is_video_ext = type == ASSET_STICKER and ext in VIDEO_STICKER_EXTS
            asset_id = ids.asset_id()
            dst = storage.asset_path(asset_id, ext)
            size = await storage.write_upload(upload, dst)
            written.append(dst)
            if size == 0:
                raise HTTPException(400, f"{name}：文件为空")
            limit = MAX_VIDEO_STICKER_BYTES if is_video_ext else MAX_BYTES[type]
            if size > limit:
                raise HTTPException(400, f"{name}：文件超过 {_human_mib(limit)} 上限")

            asset = Asset(
                id=asset_id, type=type, name=name, ext=ext, source=ASSET_SOURCE_UPLOAD
            )
            if type == ASSET_FONT:
                asset.family = Path(name).stem
            elif is_video_ext:
                asset.kind, asset.status = ASSET_VIDEO, ASSET_PREPARING
                pending.append(asset_id)
            else:
                asset.kind, asset.status = ASSET_IMAGE, ASSET_READY
                (asset.width, asset.height), frames = _read_image_sticker(dst, name)
                if ext in ANIMATABLE_IMAGE_EXTS and frames > 1:
                    # Animated gif/webp go down the video path: as a still input the
                    # renderer would only ever show their first frame.
                    asset.kind, asset.status = ASSET_VIDEO, ASSET_PREPARING
                    pending.append(asset_id)
            db.add(asset)
            created.append(asset)
        # Commit before publishing so the worker always finds the rows.
        db.commit()
    except Exception:
        db.rollback()
        for path in written:
            storage.remove_file(path)
        raise

    try:
        for asset_id in pending:
            enqueue_or_503(worker.preprocess_asset, asset_id)
    except HTTPException:
        # Queue down: undo the whole upload so the user can simply retry it.
        for asset in created:
            db.delete(asset)
        db.commit()
        for path in written:
            storage.remove_file(path)
        raise
    return [asset_out(a) for a in created]


@router.delete("/{asset_id}", status_code=204)
def delete_asset(asset_id: str, db: Session = Depends(get_db)) -> None:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(404, "素材不存在")
    if asset.source != ASSET_SOURCE_UPLOAD:
        # builtin comes back on the next startup, library belongs to the upstream system.
        raise HTTPException(400, "只能删除自己上传的素材")
    paths = _asset_files(asset)
    db.delete(asset)
    db.commit()
    for path in paths:
        storage.remove_file(path)

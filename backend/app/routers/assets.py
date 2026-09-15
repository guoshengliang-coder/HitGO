"""Assets: GET/POST/DELETE /api/assets (stickers and fonts, contract §3)."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, Query, UploadFile
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ids
from app.db import get_db
from app.models import ASSET_FONT, ASSET_SOURCE_UPLOAD, ASSET_STICKER, Asset
from app.schemas import AssetOut
from app.serializers import asset_out
from app.services import storage

router = APIRouter(prefix="/api/assets", tags=["assets"])

STICKER_EXTS = {"png", "webp", "gif"}
FONT_EXTS = {"ttf", "otf", "woff2"}
ALLOWED = {ASSET_STICKER: STICKER_EXTS, ASSET_FONT: FONT_EXTS}

# Contract §3: per-file upload ceilings. The prototype only ever holds a handful of small
# overlays, and nginx's 2g body limit is far too loose to catch a mistaken drag-and-drop.
MAX_BYTES = {ASSET_STICKER: 10 * 1024 * 1024, ASSET_FONT: 20 * 1024 * 1024}


def _ext(filename: str) -> str:
    return Path(filename).suffix.lower().lstrip(".")


def _human_mib(size: int) -> str:
    return f"{size // (1024 * 1024)} MiB"


def _read_sticker_size(path: Path, name: str) -> tuple[int, int]:
    """Pixel size of an uploaded sticker; rejects unreadable files and animated GIFs."""
    try:
        with Image.open(path) as img:
            # Contract says "gif 静态": an animated GIF would render as a single pass and
            # then freeze (overlay uses eof_action=repeat), which is not what anyone means.
            if getattr(img, "n_frames", 1) > 1:
                raise HTTPException(400, f"{name}：不支持动态图片，请上传静态 png / webp / gif")
            return img.size
    except HTTPException:
        raise
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
    try:
        for upload in files:
            name = upload.filename or "file"
            ext = _ext(name)
            if ext not in ALLOWED[type]:
                raise HTTPException(
                    400, f"{name}：{type} 只支持 {', '.join(sorted(ALLOWED[type]))} 格式"
                )
            asset_id = ids.asset_id()
            dst = storage.asset_path(asset_id, ext)
            size = await storage.write_upload(upload, dst)
            written.append(dst)
            if size == 0:
                raise HTTPException(400, f"{name}：文件为空")
            limit = MAX_BYTES[type]
            if size > limit:
                raise HTTPException(400, f"{name}：文件超过 {_human_mib(limit)} 上限")

            asset = Asset(
                id=asset_id, type=type, name=name, ext=ext, source=ASSET_SOURCE_UPLOAD
            )
            if type == ASSET_STICKER:
                asset.width, asset.height = _read_sticker_size(dst, name)
            else:
                asset.family = Path(name).stem
            db.add(asset)
            created.append(asset)
        db.commit()
    except Exception:
        db.rollback()
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
    path = storage.asset_path(asset.id, asset.ext)
    db.delete(asset)
    db.commit()
    storage.remove_file(path)

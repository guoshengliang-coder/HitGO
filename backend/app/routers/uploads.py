"""Upload diagnostics and frontend-rendered text-layer PNGs (contract §3)."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from app import ids
from app.db import get_db
from app.models import Upload
from app.schemas import LayerImageOut, UploadDiagnosticIn
from app.services import storage

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
log = logging.getLogger("uvicorn.error")


@router.post("/diagnostic", status_code=204)
def record_upload_diagnostic(body: UploadDiagnosticIn) -> None:
    log.warning("upload_client_failure %s", json.dumps(body.model_dump(), ensure_ascii=False, sort_keys=True))


@router.post("/layer-image", response_model=LayerImageOut)
async def upload_layer_image(file: UploadFile, db: Session = Depends(get_db)) -> LayerImageOut:
    name = (file.filename or "").lower()
    if not (name.endswith(".png") or file.content_type == "image/png"):
        raise HTTPException(400, "文字图层图片必须是 PNG")

    upload_id = ids.upload_id()
    dst = storage.upload_path(upload_id)
    size = await storage.write_upload(file, dst)
    if size == 0:
        storage.remove_file(dst)
        raise HTTPException(400, "上传的文件为空")
    try:
        with Image.open(dst) as img:
            if img.format != "PNG":
                raise UnidentifiedImageError
            width, height = img.size
    except (UnidentifiedImageError, OSError):
        storage.remove_file(dst)
        raise HTTPException(400, "无法解析 PNG 文件") from None

    db.add(Upload(id=upload_id, width=width, height=height))
    db.commit()
    return LayerImageOut(url=storage.media_url(dst), width=width, height=height)

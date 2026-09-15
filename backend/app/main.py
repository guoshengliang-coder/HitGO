"""FastAPI application: API routers, /media static files, SPA hosting, access-code gate."""

from __future__ import annotations

import logging
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import settings
from app.db import init_db
from app.routers import assets, auth, batches, config, jobs, presets, render, uploads, videos
from app.routers.auth import access_ok
from app.services import storage, upload_ticket

log = logging.getLogger("hitgo")

ALLOWED_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


# ---------------------------------------------------------------------------
# startup
# ---------------------------------------------------------------------------


def seed_builtin_assets() -> None:
    """Import samples/{stickers,fonts,audio} as builtin assets once (contract: source=builtin)."""
    samples = settings.samples_dir
    if not samples or not samples.is_dir():
        return
    from PIL import Image
    from sqlalchemy import select

    from app import ids, worker
    from app.db import SessionLocal
    from app.models import (
        ASSET_AUDIO,
        ASSET_FONT,
        ASSET_PREPARING,
        ASSET_SOURCE_BUILTIN,
        ASSET_STICKER,
        ASSET_VIDEO,
        Asset,
    )
    from app.routers.assets import AUDIO_EXTS, FONT_EXTS, STICKER_EXTS
    from app.services.ffprobe import ANIMATABLE_IMAGE_EXTS, VIDEO_STICKER_EXTS

    db = SessionLocal()
    pending: list[str] = []
    try:
        existing = {
            (a.type, a.name)
            for a in db.scalars(select(Asset).where(Asset.source == ASSET_SOURCE_BUILTIN))
        }
        for asset_type, sub, exts in (
            (ASSET_STICKER, "stickers", STICKER_EXTS),
            (ASSET_FONT, "fonts", FONT_EXTS),
            (ASSET_AUDIO, "audio", AUDIO_EXTS),
        ):
            folder = samples / sub
            if not folder.is_dir():
                continue
            for file in sorted(folder.iterdir()):
                ext = file.suffix.lower().lstrip(".")
                if not file.is_file() or ext not in exts or (asset_type, file.name) in existing:
                    continue
                asset = Asset(
                    id=ids.asset_id(),
                    type=asset_type,
                    name=file.name,
                    ext=ext,
                    source=ASSET_SOURCE_BUILTIN,
                )
                dst = storage.asset_path(asset.id, ext)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, dst)
                if asset_type == ASSET_FONT:
                    asset.family = file.stem
                elif asset_type == ASSET_AUDIO:
                    asset.kind, asset.status = ASSET_AUDIO, ASSET_PREPARING
                    pending.append(asset.id)
                elif ext in VIDEO_STICKER_EXTS:
                    asset.kind, asset.status = ASSET_VIDEO, ASSET_PREPARING
                    pending.append(asset.id)
                else:
                    try:
                        with Image.open(dst) as img:
                            asset.width, asset.height = img.size
                            frames = getattr(img, "n_frames", 1)
                    except OSError:
                        storage.remove_file(dst)
                        continue
                    if ext in ANIMATABLE_IMAGE_EXTS and frames > 1:
                        asset.kind, asset.status = ASSET_VIDEO, ASSET_PREPARING
                        pending.append(asset.id)
                db.add(asset)
        db.commit()
    except Exception:  # noqa: BLE001 - seeding must never block startup
        log.exception("seeding builtin assets failed")
        db.rollback()
        return
    finally:
        db.close()

    for asset_id in pending:
        try:
            worker.enqueue(worker.preprocess_asset, asset_id)
        except worker.QueueUnavailable:
            # Broker not up yet: the asset stays "preparing" and can be re-queued
            # by deleting and re-uploading it. Never block startup on Redis.
            log.warning("builtin asset %s could not be queued for preprocessing", asset_id)


def backfill_video_sticker_audio() -> None:
    """Re-probe ready video stickers that predate ``Asset.has_audio`` (contract §6).

    They need the flag and a preview proxy that carries audio. The asset stays ready
    while the worker redoes it, so specs already using it keep rendering.
    """
    from sqlalchemy import select

    from app import worker
    from app.db import SessionLocal
    from app.models import ASSET_READY, ASSET_VIDEO, Asset

    db = SessionLocal()
    try:
        stale = list(
            db.scalars(
                select(Asset.id).where(
                    Asset.kind == ASSET_VIDEO,
                    Asset.status == ASSET_READY,
                    Asset.has_audio.is_(None),
                )
            )
        )
    except Exception:  # noqa: BLE001 - never block startup
        log.exception("listing video stickers to backfill failed")
        return
    finally:
        db.close()

    for asset_id in stale:
        try:
            worker.enqueue(worker.preprocess_asset, asset_id)
        except worker.QueueUnavailable:
            # Retried on the next startup: has_audio is still null.
            log.warning("video sticker %s could not be queued for audio backfill", asset_id)
            return


@asynccontextmanager
async def lifespan(_app: FastAPI):
    storage.ensure_dirs()
    init_db()
    seed_builtin_assets()
    backfill_video_sticker_audio()
    yield


# ---------------------------------------------------------------------------
# access-code gate (pure ASGI so upload streaming is untouched)
# ---------------------------------------------------------------------------


class AccessGate:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope.get("path", "")
        if path.startswith("/media/"):
            if storage.is_blocked_media_path(path[len("/media/") :]):
                await JSONResponse({"detail": "不存在"}, status_code=404)(scope, receive, send)
                return
        gated = path.startswith("/api/") or path.startswith("/media/") or path in ("/api", "/media")
        # /api/auth issues the cookie; /api/health is polled by the compose healthcheck.
        if gated and settings.access_code and path not in ("/api/auth", "/api/health"):
            if not access_ok(Request(scope)) and not _ticket_ok(scope):
                await JSONResponse({"detail": "需要访问码"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def _ticket_ok(scope: Scope) -> bool:
    """POST /api/assets from the cookie-less upload host (contract §0 / §3)."""
    if scope.get("method") != "POST" or scope.get("path") != "/api/assets":
        return False
    for name, value in scope.get("headers", []):
        if name == upload_ticket.HEADER.encode():
            return upload_ticket.verify(value.decode("latin-1"), settings.access_code)
    return False


def cors_origins() -> list[str]:
    """Browser origins allowed to call the API cross-origin.

    dev: the Vite server. With an upload host configured: the main site, whose pages
    POST /api/assets to that host.
    """
    origins = list(ALLOWED_DEV_ORIGINS) if settings.is_dev else []
    if settings.upload_base_url and settings.public_base_url not in origins:
        origins.append(settings.public_base_url)
    return origins


# ---------------------------------------------------------------------------
# app
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    app = FastAPI(title="HitGO", version="0.1.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")

    for r in (auth, batches, videos, assets, uploads, render, jobs, config, presets):
        app.include_router(r.router)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {
                "field": ".".join(str(p) for p in e.get("loc", ()) if p != "body") or "body",
                "message": str(e.get("msg", "")).removeprefix("Value error, "),
            }
            for e in exc.errors()
        ]
        first = errors[0] if errors else {"field": "", "message": ""}
        detail = f"请求参数无效：{first['field']} {first['message']}".strip()
        return JSONResponse(status_code=400, content={"detail": detail, "errors": errors})

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_req: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "请求失败"
        if exc.status_code == 404 and detail == "Not Found":
            detail = "资源不存在"
        return JSONResponse(status_code=exc.status_code, content={"detail": detail}, headers=exc.headers)

    @app.get("/api/health", include_in_schema=False)
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # /media → DATA_DIR (hitgo.db and tmp/ blocked by AccessGate)
    storage.ensure_dirs()
    app.mount("/media", StaticFiles(directory=str(settings.data_dir)), name="media")

    _mount_spa(app)

    app.add_middleware(AccessGate)
    origins = cors_origins()
    if origins:
        from fastapi.middleware.cors import CORSMiddleware

        # Added after AccessGate so it wraps it: preflight OPTIONS carries no cookie or
        # ticket and must be answered before the gate would turn it away.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    return app


def _mount_spa(app: FastAPI) -> None:
    dist: Path = settings.frontend_dist
    index = dist / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith("api/") or path.startswith("media/"):
            return JSONResponse({"detail": "资源不存在"}, status_code=404)
        if not index.is_file():
            return PlainTextResponse("前端尚未构建（frontend/dist 不存在）", status_code=404)
        if path:
            candidate = (dist / path).resolve()
            if dist.resolve() in candidate.parents and candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(index)


app = create_app()

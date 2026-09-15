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
from app.services import storage

log = logging.getLogger("hitgo")

ALLOWED_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


# ---------------------------------------------------------------------------
# startup
# ---------------------------------------------------------------------------


def seed_builtin_assets() -> None:
    """Import samples/{stickers,fonts} as builtin assets once (contract: source=builtin)."""
    samples = settings.samples_dir
    if not samples or not samples.is_dir():
        return
    from PIL import Image
    from sqlalchemy import select

    from app import ids
    from app.db import SessionLocal
    from app.models import ASSET_FONT, ASSET_SOURCE_BUILTIN, ASSET_STICKER, Asset
    from app.routers.assets import FONT_EXTS, STICKER_EXTS

    db = SessionLocal()
    try:
        existing = {
            (a.type, a.name)
            for a in db.scalars(select(Asset).where(Asset.source == ASSET_SOURCE_BUILTIN))
        }
        for asset_type, sub, exts in (
            (ASSET_STICKER, "stickers", STICKER_EXTS),
            (ASSET_FONT, "fonts", FONT_EXTS),
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
                if asset_type == ASSET_STICKER:
                    try:
                        with Image.open(dst) as img:
                            asset.width, asset.height = img.size
                    except OSError:
                        storage.remove_file(dst)
                        continue
                else:
                    asset.family = file.stem
                db.add(asset)
        db.commit()
    except Exception:  # noqa: BLE001 - seeding must never block startup
        log.exception("seeding builtin assets failed")
        db.rollback()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    storage.ensure_dirs()
    init_db()
    seed_builtin_assets()
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
            if not access_ok(Request(scope)):
                await JSONResponse({"detail": "需要访问码"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


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

    if settings.is_dev:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=ALLOWED_DEV_ORIGINS,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    app.add_middleware(AccessGate)
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

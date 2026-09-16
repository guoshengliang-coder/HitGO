"""Runtime settings read from environment variables.

Everything is resolved once at import time into the module-level ``settings``
object. Tests set the relevant variables before importing ``app.*``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


@dataclass
class Settings:
    data_dir: Path
    database_url: str
    redis_url: str
    access_code: str
    public_base_url: str
    # Upload host that bypasses the CDN (contract §3 upload-ticket); "" = same-origin uploads.
    upload_base_url: str
    worker_concurrency: int
    env: str
    ffmpeg_bin: str
    ffprobe_bin: str
    frontend_dist: Path
    samples_dir: Path | None
    # Vocals / instrumental separation (separator worker, contract §6).
    separate_threads: int
    separate_max_seconds: int

    @property
    def is_dev(self) -> bool:
        return self.env == "dev"

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def load_settings() -> Settings:
    data_dir = Path(_env("DATA_DIR", "/data")).expanduser()
    default_db = f"sqlite:///{data_dir / 'hitgo.db'}"
    samples_raw = _env("SAMPLES_DIR", str(REPO_DIR / "samples"))
    samples_dir = Path(samples_raw) if samples_raw and samples_raw != "-" else None
    return Settings(
        data_dir=data_dir,
        database_url=_env("DATABASE_URL", default_db),
        redis_url=_env("REDIS_URL", "redis://localhost:6379/0"),
        access_code=_env("ACCESS_CODE", "").strip(),
        public_base_url=_env("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/"),
        upload_base_url=_env("UPLOAD_BASE_URL", "").strip().rstrip("/"),
        worker_concurrency=int(_env("WORKER_CONCURRENCY", "1")),
        env=_env("ENV", "prod").lower(),
        ffmpeg_bin=_env("FFMPEG_BIN", "ffmpeg"),
        ffprobe_bin=_env("FFPROBE_BIN", "ffprobe"),
        frontend_dist=Path(_env("FRONTEND_DIST", str(REPO_DIR / "frontend" / "dist"))),
        samples_dir=samples_dir,
        separate_threads=int(_env("SEPARATE_THREADS", "4")),
        separate_max_seconds=int(_env("SEPARATE_MAX_SECONDS", "600")),
    )


settings = load_settings()

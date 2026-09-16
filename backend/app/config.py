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
    # Localization (ASR → MT → TTS via Alibaba DashScope, contract §6). provider = dashscope | fake.
    dashscope_api_key: str
    localize_provider: str
    localize_asr_model: str
    localize_mt_model: str
    localize_tts_model: str
    localize_max_seconds: int
    localize_max_tempo: float
    localize_timeout_seconds: int
    # "ko=loongkyong_v3,ja=loongtomoka_v3": per-language default voice overrides.
    localize_voices: str

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
        dashscope_api_key=_env("DASHSCOPE_API_KEY", "").strip(),
        localize_provider=_env("LOCALIZE_PROVIDER", "dashscope").strip().lower(),
        localize_asr_model=_env("LOCALIZE_ASR_MODEL", "paraformer-realtime-v2"),
        localize_mt_model=_env("LOCALIZE_MT_MODEL", "qwen-mt-plus"),
        localize_tts_model=_env("LOCALIZE_TTS_MODEL", "cosyvoice-v3-flash"),
        localize_max_seconds=int(_env("LOCALIZE_MAX_SECONDS", "600")),
        localize_max_tempo=float(_env("LOCALIZE_MAX_TEMPO", "1.3")),
        localize_timeout_seconds=int(_env("LOCALIZE_TIMEOUT_SECONDS", "900")),
        localize_voices=_env("LOCALIZE_VOICES", "").strip(),
    )


settings = load_settings()

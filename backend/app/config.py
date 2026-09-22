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
    # Upload host for assets and batch videos, bypassing the CDN (contract §3).
    upload_base_url: str
    # How long a read ticket for one /media file stays valid (contract §0, HIG-58): long
    # enough for the voice-cloning endpoint to fetch the sample, short enough to expire.
    media_ticket_ttl_seconds: int
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
    # Chat model that turns literal MT into natural, duration-aware dubbing copy (HIG-73).
    localize_script_model: str
    localize_tts_model: str
    localize_max_seconds: int
    localize_max_tempo: float
    localize_timeout_seconds: int
    # "ko=loongkyong_v3,ja=loongtomoka_v3": per-language default voice overrides.
    localize_voices: str
    # HIG-59: DashScope-hosted MiniMax voice model; empty (the default) = no MiniMax voices at all.
    minimax_tts_model: str
    # Chat model that picks the phrases worth highlighting in poster copy (HIG-50); shares
    # DASHSCOPE_API_KEY / LOCALIZE_PROVIDER with localization.
    highlight_model: str
    # On-screen text (detect → translate → erase, contract §6, HIG-38). Detection shares
    # DASHSCOPE_API_KEY with localization; provider = dashscope | fake.
    screentext_provider: str
    screentext_model: str
    screentext_sample_fps: float
    screentext_max_frames: int
    screentext_max_blocks: int
    screentext_max_seconds: int
    screentext_timeout_seconds: int
    screentext_call_timeout_seconds: int
    # Erase provider: fake (tests) | local (ffmpeg delogo, no network) | a cloud vendor.
    erase_provider: str
    erase_poll_interval_seconds: int
    erase_max_wait_seconds: int
    # GhostCut (鬼手剪辑) credentials; only read when erase_provider is "ghostcut".
    ghostcut_base_url: str
    ghostcut_app_key: str
    ghostcut_app_secret: str
    ghostcut_resolution: str

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
        media_ticket_ttl_seconds=int(_env("MEDIA_TICKET_TTL_SECONDS", "1800")),
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
        localize_script_model=_env("LOCALIZE_SCRIPT_MODEL", "qwen-plus"),
        localize_tts_model=_env("LOCALIZE_TTS_MODEL", "cosyvoice-v3-flash"),
        localize_max_seconds=int(_env("LOCALIZE_MAX_SECONDS", "600")),
        localize_max_tempo=float(_env("LOCALIZE_MAX_TEMPO", "1.3")),
        localize_timeout_seconds=int(_env("LOCALIZE_TIMEOUT_SECONDS", "900")),
        localize_voices=_env("LOCALIZE_VOICES", "").strip(),
        # Empty by default on purpose: the MiniMax models are activated separately in the Bailian
        # console (an un-activated one answers 400 "The product is not activated"), and the backend
        # cannot tell whether that was done without spending a call. So MiniMax voices are opt-in —
        # until this is set, the voice table and the target languages are exactly as they were.
        minimax_tts_model=_env("MINIMAX_TTS_MODEL", "").strip(),
        highlight_model=_env("HIGHLIGHT_MODEL", "qwen-plus").strip(),
        # Defaults to whatever localization uses, so a deployment that already has a key gets
        # on-screen text detection without a second variable to set.
        screentext_provider=_env("SCREENTEXT_PROVIDER", _env("LOCALIZE_PROVIDER", "dashscope")).strip().lower(),
        screentext_model=_env("SCREENTEXT_MODEL", "qwen3-vl-plus").strip(),
        screentext_sample_fps=float(_env("SCREENTEXT_SAMPLE_FPS", "0.5")),
        screentext_max_frames=int(_env("SCREENTEXT_MAX_FRAMES", "20")),
        screentext_max_blocks=int(_env("SCREENTEXT_MAX_BLOCKS", "40")),
        screentext_max_seconds=int(_env("SCREENTEXT_MAX_SECONDS", "180")),
        screentext_timeout_seconds=int(_env("SCREENTEXT_TIMEOUT_SECONDS", "1200")),
        screentext_call_timeout_seconds=int(_env("SCREENTEXT_CALL_TIMEOUT_SECONDS", "60")),
        # "local" needs no credentials and no network: ffmpeg delogo over the detected boxes.
        # It is the default so the whole chain works out of the box, blur-quality rather than
        # inpainting-quality, until a cloud vendor is picked (HIG-38).
        erase_provider=_env("ERASE_PROVIDER", "local").strip().lower(),
        erase_poll_interval_seconds=int(_env("ERASE_POLL_INTERVAL_SECONDS", "10")),
        erase_max_wait_seconds=int(_env("ERASE_MAX_WAIT_SECONDS", "3600")),
        ghostcut_base_url=_env("GHOSTCUT_BASE_URL", "https://api.zhaoli.com").strip().rstrip("/"),
        ghostcut_app_key=_env("GHOSTCUT_APP_KEY", "").strip(),
        ghostcut_app_secret=_env("GHOSTCUT_APP_SECRET", "").strip(),
        # Empty = follow the source video's height; set it only to force a tier.
        ghostcut_resolution=_env("GHOSTCUT_RESOLUTION", "").strip(),
    )


settings = load_settings()

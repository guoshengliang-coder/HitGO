"""Erase burnt-in text from the picture and keep the result beside the original (HIG-38).

The mask layer the editor already has blurs a region; it is not removal. This produces a real
"clean" copy of the source — same geometry, frame rate, duration and audio, so nothing in
``edit_spec`` needs converting between the two and ``source_variant`` can switch back and forth
freely (contract §2). The original is never overwritten.

Providers
    fake    tests; no ffmpeg, no network
    local   ffmpeg ``delogo`` over the detected boxes. No credentials, no upload, works on the
            prototype server as-is. Interpolates from the region's border, so it is markedly
            better than a blur and markedly worse than a real inpainting model — it is the
            floor of the feature, and the fallback whenever a cloud vendor is unavailable.
    <vendor>  a cloud inpainting service, added once the comparison in HIG-38 picks one.

Polling
    Cloud erasure is asynchronous and can take minutes. ``WORKER_CONCURRENCY`` defaults to 1, so
    a blocking poll would starve every dubbing job behind it. Instead the submit step returns
    immediately and the task re-enqueues ``hitgo.erase_poll`` with a countdown: each tick is a
    short task, the queue keeps flowing, and a worker restart loses nothing because the message
    lives in Redis. ``deadline`` bounds the whole thing so a task the vendor silently dropped
    cannot leave the item stuck on "running" forever.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any, Protocol

from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.db import iso, utcnow
from app.models import ST_DONE, ST_FAILED, ST_RUNNING, Video
from app.services import storage

log = logging.getLogger(__name__)

# The clean copy must line up with the original frame for frame, or every layer time in the
# spec would silently drift. Anything beyond this is treated as a broken result.
DURATION_TOLERANCE = 0.2
FPS_TOLERANCE = 0.05


class EraseError(RuntimeError):
    """Chinese reason shown on the item."""


@dataclass(frozen=True)
class EraseRegion:
    """One rectangle to erase; ``t`` is None for the whole clip."""

    box: dict[str, float]
    t: tuple[float, float] | None = None


@dataclass(frozen=True)
class EraseProgress:
    status: str  # "running" | "done" | "failed"
    url: str | None = None
    error: str | None = None
    # What the vendor itself says about the job ("排队中", "处理中 40%"), shown while running.
    detail: str | None = None


class EraseProvider(Protocol):
    name: str

    def submit(self, source: Path, public_url: str | None, regions: list[EraseRegion], duration: float) -> str: ...
    def poll(self, task_id: str) -> EraseProgress: ...
    def fetch(self, task_id: str, progress: EraseProgress, dst: Path) -> None: ...


@dataclass
class FakeErase:
    """Reports ``running`` for ``running_polls`` ticks, then ``done``."""

    name: str = "fake"
    running_polls: int = 1
    submits: list[tuple[Path, list[EraseRegion]]] = field(default_factory=list)
    polls: list[str] = field(default_factory=list)

    def submit(self, source: Path, public_url: str | None, regions: list[EraseRegion], duration: float) -> str:
        self.submits.append((source, regions))
        return f"fake-{len(self.submits)}"

    def poll(self, task_id: str) -> EraseProgress:
        self.polls.append(task_id)
        if len(self.polls) <= self.running_polls:
            return EraseProgress(status="running")
        return EraseProgress(status="done", url=f"fake://{task_id}")

    def fetch(self, task_id: str, progress: EraseProgress, dst: Path) -> None:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(b"fake-clean-mp4")


def delogo_filter(regions: list[EraseRegion], width: int, height: int) -> str:
    """``delogo`` chain for the regions, in pixels, clamped inside the frame.

    ffmpeg's delogo needs at least one pixel of surrounding picture to interpolate from, so
    every box is kept one pixel away from each edge; boxes that cannot satisfy that are dropped
    rather than failing the whole render.
    """
    parts: list[str] = []
    for region in regions:
        x = int(round(region.box["x"] * width))
        y = int(round(region.box["y"] * height))
        w = int(round(region.box["w"] * width))
        h = int(round(region.box["h"] * height))
        x = max(1, min(x, width - 3))
        y = max(1, min(y, height - 3))
        w = max(1, min(w, width - x - 1))
        h = max(1, min(h, height - y - 1))
        if w < 1 or h < 1:
            continue
        part = f"delogo=x={x}:y={y}:w={w}:h={h}"
        if region.t is not None:
            part += f":enable='between(t,{region.t[0]:.3f},{region.t[1]:.3f})'"
        parts.append(part)
    return ",".join(parts)


def local_args(src: Path, dst: Path, regions: list[EraseRegion], width: int, height: int, ffmpeg_bin: str | None = None) -> list[str]:
    """Re-encode the source with the regions painted over; audio is copied untouched."""
    chain = delogo_filter(regions, width, height)
    if not chain:
        raise EraseError("没有可擦除的区域")
    return [
        ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(src),
        "-vf", chain,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        str(dst),
    ]  # fmt: skip


@dataclass
class LocalErase:
    """ffmpeg ``delogo``, run synchronously inside ``submit``; polling returns done at once.

    The result path is derived from the task id rather than remembered in the instance, so a
    worker that restarts between submit and the poll tick still finds the file.
    """

    name: str = "local"
    width: int = 0
    height: int = 0
    ffmpeg_bin: str | None = None

    @staticmethod
    def _result_path(task_id: str) -> Path:
        return storage.tmp_dir() / f"{task_id}.clean.mp4"

    def submit(self, source: Path, public_url: str | None, regions: list[EraseRegion], duration: float) -> str:
        task_id = f"local-{source.parent.name}"
        dst = self._result_path(task_id)
        dst.parent.mkdir(parents=True, exist_ok=True)
        argv = local_args(source, dst, regions, self.width, self.height, self.ffmpeg_bin)
        try:
            proc = subprocess.run(argv, capture_output=True, timeout=1800, check=False)
        except FileNotFoundError as exc:
            raise EraseError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc
        except subprocess.TimeoutExpired as exc:
            raise EraseError("本机擦除超时") from exc
        if proc.returncode != 0:
            tail = "\n".join((proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-8:])
            raise EraseError(f"本机擦除失败（exit {proc.returncode}）：{tail}")
        return task_id

    def poll(self, task_id: str) -> EraseProgress:
        path = self._result_path(task_id)
        if not path.exists():
            return EraseProgress(status="failed", error="本机擦除的结果文件不见了")
        return EraseProgress(status="done", url=str(path))

    def fetch(self, task_id: str, progress: EraseProgress, dst: Path) -> None:
        src = self._result_path(task_id)
        if not src.exists():
            raise EraseError("本机擦除的结果文件不见了")
        storage.move_atomic(src, dst)


def make_provider(video: Video | None = None, cfg: Settings | None = None) -> EraseProvider:
    cfg = cfg or settings
    if cfg.erase_provider == "fake":
        return FakeErase()
    if cfg.erase_provider == "local":
        return LocalErase(width=int(video.width or 0) if video else 0, height=int(video.height or 0) if video else 0, ffmpeg_bin=cfg.ffmpeg_bin)
    if cfg.erase_provider == "ghostcut":
        from app.services.erase_ghostcut import GhostCutErase  # noqa: PLC0415  (keep the import local, as with every vendor)

        if not cfg.ghostcut_app_key or not cfg.ghostcut_app_secret:
            raise EraseError("擦除供应商设为 ghostcut，但没有配置 GHOSTCUT_APP_KEY / GHOSTCUT_APP_SECRET")
        return GhostCutErase(
            base_url=cfg.ghostcut_base_url,
            app_key=cfg.ghostcut_app_key,
            app_secret=cfg.ghostcut_app_secret,
            resolution=cfg.ghostcut_resolution,
            video_id=video.id if video else "",
            video_height=int(video.height or 0) if video else 0,
        )
    raise EraseError(f"不认识的擦除供应商：{cfg.erase_provider}")


def erase_enabled(cfg: Settings | None = None) -> bool:
    """Whether this deployment can erase at all (the editor greys the button out otherwise)."""
    cfg = cfg or settings
    if cfg.erase_provider in ("fake", "local"):
        return True  # neither needs credentials or the network
    if cfg.erase_provider == "ghostcut":
        return bool(cfg.ghostcut_app_key and cfg.ghostcut_app_secret)
    return False


def public_source_url(video: Video, cfg: Settings | None = None) -> str:
    """Absolute /media URL of the source plus a read ticket, for a vendor to fetch itself.

    Same mechanism the voice cloning uses (HIG-58): ``/media`` stays behind the access-code
    gate and only this one path is opened, only for as long as the ticket lasts.
    """
    from app.services import media_ticket  # noqa: PLC0415

    cfg = cfg or settings
    path = storage.source_path(video.batch_id, video.id, video.source_ext)
    rel = storage.media_url(path)[len(storage.MEDIA_PREFIX) + 1 :]
    url = cfg.public_base_url + storage.media_url(path)
    if not cfg.access_code:
        return url  # nothing gating /media; a ticket would be noise
    ticket = media_ticket.issue(rel, cfg.access_code, cfg.media_ticket_ttl_seconds)
    return f"{url}?{media_ticket.PARAM}={ticket}"


def regions_for(detect: dict[str, Any] | None, scope: dict[str, Any] | None) -> list[EraseRegion]:
    """Which rectangles this run erases.

    The subtitle band is erased for the whole clip rather than per sentence: it is cheaper with
    every vendor, and it cannot leave a few un-erased frames where a time range was off by one
    sample. Graphic blocks keep their own time range — they are usually short and localised.
    """
    from app.services import screentext  # noqa: PLC0415

    detect = detect or {}
    scope = scope or {}
    want_band = scope.get("band", True)
    ids = scope.get("block_ids")
    regions: list[EraseRegion] = []
    band = detect.get("subtitle_band")
    if want_band and band:
        regions.append(EraseRegion(box=band["box"], t=None))
    for block in screentext.enabled_blocks(detect):
        if ids is not None and block["id"] not in ids:
            continue
        t = block.get("t") or None
        regions.append(EraseRegion(box=block["box"], t=(float(t[0]), float(t[1])) if t else None))
    return regions


def start(db: Session, video: Video, st: dict[str, Any], scope: dict[str, Any] | None, cfg: Settings | None = None) -> None:
    """Submit the erase job and hand polling to ``hitgo.erase_poll``."""
    from app import worker  # noqa: PLC0415
    from app.services import screentext  # noqa: PLC0415

    cfg = cfg or settings
    regions = regions_for(st.get("detect"), scope)
    if not regions:
        st["erase"] = screentext.stamp(dict(st.get("erase") or {}), status=ST_FAILED, error="没有要擦除的画面文字")
        screentext.save(db, video, st, erase=True)
        return
    # Everything from here on must leave a terminal status behind. An exception escaping this
    # function would strand ``erase`` on queued / running, and every later request on this video
    # answers 409 for as long as that lasts — only a database edit gets out of it.
    try:
        provider = make_provider(video, cfg)
    except EraseError as exc:
        st["erase"] = screentext.stamp(dict(st.get("erase") or {}), status=ST_FAILED, error=str(exc))
        screentext.save(db, video, st, erase=True)
        return
    source = storage.source_path(video.batch_id, video.id, video.source_ext)
    # Cloud providers pull the file themselves; the local one reads it off disk and ignores this.
    public_url = None if provider.name in ("fake", "local") else public_source_url(video, cfg)
    try:
        task_id = provider.submit(source, public_url, regions, float(video.duration or 0.0))
    except Exception as exc:  # noqa: BLE001  a vendor SDK may raise anything at all
        st["erase"] = screentext.stamp(dict(st.get("erase") or {}), status=ST_FAILED, error=f"提交擦除失败：{exc}", provider=provider.name)
        screentext.save(db, video, st, erase=True)
        return
    deadline = utcnow() + timedelta(seconds=cfg.erase_max_wait_seconds)
    st["erase"] = screentext.stamp(
        dict(st.get("erase") or {}),
        status=ST_RUNNING,
        provider=provider.name,
        task_id=task_id,
        polls=0,
        deadline=iso(deadline),
        scope={"band": bool((scope or {}).get("band", True)), "block_ids": (scope or {}).get("block_ids")},
        stale=False,
        error=None,
        resumable=False,
        vendor_status=None,
        clean_url=None,
        clean_proxy_url=None,
        clean_poster_url=None,
    )
    screentext.save(db, video, st, erase=True)
    # LocalErase already finished inside submit; poll right away instead of waiting a tick.
    try:
        worker.enqueue_later(worker.erase_poll, 0 if provider.name == "local" else cfg.erase_poll_interval_seconds, video.id)
    except Exception as exc:  # noqa: BLE001  a dead broker must not leave a job nobody polls
        st["erase"] = screentext.stamp(st["erase"], status=ST_FAILED, error=f"无法安排擦除进度查询：{exc}")
        screentext.save(db, video, st, erase=True)


def provider_for(video: Video, cfg: Settings | None = None) -> EraseProvider:
    """A provider for the poll tick. Providers hold no per-job state, so a fresh one is fine —
    that is what lets polling survive a worker restart."""
    return make_provider(video, cfg)


def resumable_provider(name: str | None) -> bool:
    """Cloud jobs keep running on the vendor's side after we stop waiting, so they can be
    picked up again; the local / fake ones finish inside ``submit`` and have nothing to resume."""
    return bool(name) and name not in ("local", "fake")


def timeout_reason(seconds: int, resumable: bool) -> str:
    reason = f"擦除超过 {seconds} 秒仍未完成，已中止"
    if resumable:
        reason += "；供应商可能还在处理，可以点「继续等待」接着查同一个任务（不会重新提交）"
    return reason


def poll_once(db: Session, video_id: str, cfg: Settings | None = None) -> None:
    """One tick of ``hitgo.erase_poll``: finish, give up, or ask to be woken again.

    Every way out leaves a terminal status or schedules the next tick. A tick that dies in the
    middle (provider misconfigured, download or proxy past the task's soft limit) used to leave
    ``erase`` on running with nobody polling it, until the stale check said "没有进展".
    """
    from celery.exceptions import SoftTimeLimitExceeded  # noqa: PLC0415

    from app import worker  # noqa: PLC0415
    from app.services import screentext  # noqa: PLC0415

    cfg = cfg or settings
    video = db.get(Video, video_id)
    if video is None:
        return
    st: dict[str, Any] = dict(video.screen_text or {})
    er = dict(st.get("erase") or {})
    if er.get("status") != ST_RUNNING or not er.get("task_id"):
        return  # cancelled, replaced or already finished

    def fail(reason: str, **extra: Any) -> None:
        st["erase"] = screentext.stamp(er, status=ST_FAILED, error=reason, **extra)
        screentext.save(db, video, st, erase=True)

    try:
        provider = provider_for(video, cfg)
    except EraseError as exc:
        fail(str(exc))
        return
    try:
        progress = provider.poll(str(er["task_id"]))
    except Exception as exc:  # noqa: BLE001  a transient vendor error should not kill the job
        log.warning("erase poll failed for %s", video_id, exc_info=True)
        progress = EraseProgress(status="running", error=str(exc))

    er["polls"] = int(er.get("polls") or 0) + 1
    if progress.detail:
        er["vendor_status"] = progress.detail
    if progress.status == "failed":
        fail(progress.error or "擦除失败", resumable=False)
        return
    if progress.status == "done":
        try:
            _finish(video, provider, str(er["task_id"]), progress, cfg)
        except EraseError as exc:
            fail(str(exc), resumable=False)
            return
        except SoftTimeLimitExceeded:
            fail("下载或处理擦除结果超时，已中止；可以点「继续等待」再取一次结果", resumable=resumable_provider(provider.name))
            raise
        except Exception as exc:  # noqa: BLE001  e.g. a disk error while publishing clean.mp4
            log.exception("erase finish failed for %s", video_id)
            fail(f"处理擦除结果出错：{exc}", resumable=resumable_provider(provider.name))
            return
        st["erase"] = screentext.stamp(
            er,
            status=ST_DONE,
            error=None,
            resumable=False,
            clean_url=storage.media_url(storage.clean_path(video.batch_id, video.id)),
            clean_proxy_url=storage.media_url(storage.clean_proxy_path(video.batch_id, video.id)),
            clean_poster_url=storage.media_url(storage.clean_poster_path(video.batch_id, video.id)),
        )
        screentext.save(db, video, st, erase=True)
        return

    deadline = er.get("deadline")
    if deadline and iso(utcnow()) >= str(deadline):
        resumable = resumable_provider(provider.name)
        fail(timeout_reason(cfg.erase_max_wait_seconds, resumable), resumable=resumable)
        return
    st["erase"] = screentext.stamp(er)
    screentext.save(db, video, st, erase=True)
    try:
        worker.enqueue_later(worker.erase_poll, cfg.erase_poll_interval_seconds, video_id)
    except Exception as exc:  # noqa: BLE001  a broker hiccup must not strand the job on running
        fail(f"无法安排下一次擦除进度查询：{exc}", resumable=resumable_provider(provider.name))


def resume(db: Session, video: Video, cfg: Settings | None = None) -> None:
    """「继续等待」: poll the same vendor job again with a fresh deadline — no new submission.

    Raises ``EraseError`` with the Chinese reason when there is nothing to resume. The caller
    queues the first tick.
    """
    from app.services import screentext  # noqa: PLC0415

    cfg = cfg or settings
    st: dict[str, Any] = dict(video.screen_text or {})
    er = dict(st.get("erase") or {})
    if er.get("status") != ST_FAILED or not er.get("resumable") or not er.get("task_id"):
        raise EraseError("没有可以继续等待的擦除任务：请重新擦除")
    if not resumable_provider(er.get("provider")):
        raise EraseError("本地擦除没有可以继续等待的任务：请重新擦除")
    st["erase"] = screentext.stamp(
        er,
        status=ST_RUNNING,
        error=None,
        resumable=False,
        deadline=iso(utcnow() + timedelta(seconds=cfg.erase_max_wait_seconds)),
    )
    video.screen_text = st


def _finish(video: Video, provider: EraseProvider, task_id: str, progress: EraseProgress, cfg: Settings) -> None:
    """Download, validate against the original, then publish clean.mp4 + proxy + poster."""
    from app.services import ffprobe, preprocess  # noqa: PLC0415

    tmp = storage.tmp_dir() / f"{video.id}.clean.mp4"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    provider.fetch(task_id, progress, tmp)
    if not tmp.exists() or tmp.stat().st_size == 0:
        raise EraseError("擦除结果下载失败或文件为空")

    # A clean copy that does not line up with the original would silently shift every layer
    # time in the spec, so a mismatch is a hard failure rather than a warning.
    if cfg.erase_provider != "fake":
        try:
            meta = ffprobe.probe(tmp)
        except Exception as exc:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            raise EraseError(f"擦除结果无法解析：{exc}") from exc
        got = float(meta.get("duration") or 0.0)
        want = float(video.duration or 0.0)
        if want and abs(got - want) > DURATION_TOLERANCE:
            tmp.unlink(missing_ok=True)
            raise EraseError(f"擦除结果时长 {got:.2f} 秒与原片 {want:.2f} 秒不一致，已丢弃")
        got_fps = float(meta.get("fps") or 0.0)
        want_fps = float(video.fps or 0.0)
        if want_fps and got_fps and abs(got_fps - want_fps) > FPS_TOLERANCE:
            # A re-timed copy would shift every layer time in the spec by a growing amount.
            tmp.unlink(missing_ok=True)
            raise EraseError(f"擦除结果帧率 {got_fps:.2f} 与原片 {want_fps:.2f} 不一致，已丢弃")

    dst = storage.clean_path(video.batch_id, video.id)
    storage.move_atomic(tmp, dst)
    if cfg.erase_provider == "fake":
        return
    proxy = storage.clean_proxy_path(video.batch_id, video.id)
    poster = storage.clean_poster_path(video.batch_id, video.id)
    for argv, what in (
        (preprocess.proxy_args(dst, proxy), "生成无字版预览"),
        (preprocess.poster_args(dst, poster, float(video.duration or 0.0)), "生成无字版封面"),
    ):
        proc = subprocess.run(argv, capture_output=True, timeout=1800, check=False)
        if proc.returncode != 0:
            log.warning("%s failed: %s", what, (proc.stderr or b"").decode("utf-8", "replace")[-400:])


def remove(video: Video) -> None:
    """Delete the clean copy and its derived files (DELETE …/screen-text/erase)."""
    for path in (
        storage.clean_path(video.batch_id, video.id),
        storage.clean_proxy_path(video.batch_id, video.id),
        storage.clean_poster_path(video.batch_id, video.id),
    ):
        path.unlink(missing_ok=True)

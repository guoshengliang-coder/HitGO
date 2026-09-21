"""On-screen text localization: detect → estimate style → translate (contract §6, HIG-38).

The second half of "改语言": `localize.py` replaces what the video *says*, this replaces what
it *shows*. The two run independently — detecting and erasing does not need a target language,
and a failure here never touches the dubbing.

Pipeline (``run_screen_text``):
    source.mp4 → ffmpeg sampled frames → perceptual de-dupe → vision model per frame
               → cross-frame clustering into blocks → style estimate per block
               → the bottom-centre cluster becomes ``subtitle_band``, the rest ``blocks``
               → numbered-block translation per target language

**Hard subtitles are deliberately not read line by line.** Their content *is* the speech, and
the translation and timing of the speech are already solved (``localization.versions[lang]
.cues[].dub_start / dub_duration``, HIG-36). So we only measure where the subtitle band sits and
what it looks like; the editor then moves the existing translated subtitle layers there. This
takes the per-video vision calls from hundreds down to a dozen. The known cost: a clip that has
burnt-in subtitles but no speech has no translation to reuse, and is out of scope for now.

Everything above the provider boundary is a pure function so the tests can drive it without
ffmpeg, Pillow-heavy fixtures or a network.
"""

from __future__ import annotations

import copy
import difflib
import hashlib
import logging
import re
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections.abc import Callable
from typing import Any, Protocol

from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.db import iso, utcnow
from app.models import ST_DONE, ST_FAILED, ST_QUEUED, ST_RUNNING, Video
from app.services import storage

log = logging.getLogger(__name__)


class ScreenTextError(RuntimeError):
    """Anything the user should see as a Chinese reason on the item."""


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def expire_stale_state(
    state: dict[str, Any] | None,
    *,
    now: datetime | None = None,
    task_timeout_seconds: int,
    erase_timeout_seconds: int,
) -> tuple[dict[str, Any] | None, bool]:
    """Project abandoned queued/running screen-text work into a retryable failure.

    Celery's task limits only start once a worker has received the task.  A broker delivery
    lost before that point used to leave the JSON state active forever, which also disabled the
    retry button.  A running detection refreshes ``updated_at`` after every frame, so for it
    the limit measures "no progress for that long", not total run time.  The projection is pure so serializers can show the repaired state without
    writing during a GET; the POST endpoint persists the same projection before retrying.
    """
    if not state:
        return state, False
    current = now or utcnow()
    out = copy.deepcopy(state)
    changed = False

    def expire(part: dict[str, Any] | None, seconds: int, label: str) -> None:
        nonlocal changed
        if not part or part.get("status") not in (ST_QUEUED, ST_RUNNING):
            return
        updated = _parse_time(part.get("updated_at"))
        deadline = _parse_time(part.get("deadline"))
        stale = (deadline is not None and current >= deadline) or (
            updated is not None and current >= updated + timedelta(seconds=max(1, seconds))
        )
        if not stale:
            return
        if part.get("status") == ST_QUEUED:
            # Never picked up: the single worker slot was busy (render, preprocessing, dubbing)
            # or the worker is down. Saying "识别超时" here sent people hunting in the wrong place.
            error = f"{label}排队超过 {seconds} 秒仍未开始，已中止；后台可能正忙于其它任务，请稍后手动重试"
        else:
            error = f"{label}超过 {seconds} 秒没有进展，已中止；请手动重试"
        part.update(status=ST_FAILED, error=error, updated_at=iso(current))
        changed = True

    expire(out.get("detect"), task_timeout_seconds, "画面文字识别")
    for lang, version in (out.get("versions") or {}).items():
        expire(version, task_timeout_seconds, f"{lang}画面文字翻译")
    expire(out.get("erase"), erase_timeout_seconds, "画面文字擦除")
    if changed:
        out.pop("pending", None)
    return out, changed


# --- geometry ---------------------------------------------------------------

Box = dict[str, float]


def box(x: float, y: float, w: float, h: float) -> Box:
    return {"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}


def clamp_box(b: Box) -> Box:
    """Into the unit square, keeping at least a sliver of width and height."""
    x = min(max(float(b.get("x", 0.0)), 0.0), 1.0)
    y = min(max(float(b.get("y", 0.0)), 0.0), 1.0)
    w = min(max(float(b.get("w", 0.0)), 0.0), 1.0 - x)
    h = min(max(float(b.get("h", 0.0)), 0.0), 1.0 - y)
    return box(x, y, max(w, 0.001), max(h, 0.001))


def iou(a: Box, b: Box) -> float:
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    ix = max(0.0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0.0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def union_box(boxes: list[Box]) -> Box:
    x = min(b["x"] for b in boxes)
    y = min(b["y"] for b in boxes)
    x2 = max(b["x"] + b["w"] for b in boxes)
    y2 = max(b["y"] + b["h"] for b in boxes)
    return box(x, y, x2 - x, y2 - y)


def center(b: Box) -> tuple[float, float]:
    return (b["x"] + b["w"] / 2, b["y"] + b["h"] / 2)


# --- provider boundary ------------------------------------------------------


@dataclass(frozen=True)
class DetectedText:
    """One piece of text the vision model found in one frame."""

    text: str
    box: Box
    confidence: float | None = None


class ScreenTextProvider(Protocol):
    def detect(self, frame: Path, hint_lang: str | None) -> list[DetectedText]: ...


@dataclass
class FakeScreenText:
    """Replays canned results frame by frame; the last one repeats once exhausted."""

    results: list[list[DetectedText]] = field(default_factory=list)
    calls: list[Path] = field(default_factory=list)

    def detect(self, frame: Path, hint_lang: str | None) -> list[DetectedText]:
        self.calls.append(frame)
        if not self.results:
            return []
        i = min(len(self.calls) - 1, len(self.results) - 1)
        return self.results[i]


@dataclass
class Providers:
    detect: ScreenTextProvider
    # Translation reuses localization's provider: same terms, same retry, same numbered block.
    mt: Any


def enabled(cfg: Settings | None = None) -> bool:
    cfg = cfg or settings
    return cfg.screentext_provider == "fake" or bool(cfg.dashscope_api_key)


def make_providers(cfg: Settings | None = None) -> Providers:
    from app.services import localize  # noqa: PLC0415  (avoid a circular import at module load)

    cfg = cfg or settings
    loc = localize.make_providers(cfg)
    if cfg.screentext_provider == "fake":
        return Providers(detect=FakeScreenText(), mt=loc.mt)
    from app.services import dashscope_providers  # noqa: PLC0415  (keep the vendor SDK lazy)

    return Providers(
        detect=dashscope_providers.DashScopeScreenText(
            api_key=cfg.dashscope_api_key, model=cfg.screentext_model, timeout_seconds=cfg.screentext_call_timeout_seconds
        ),
        mt=loc.mt,
    )


# --- frame sampling ---------------------------------------------------------

FRAME_PREFIX = "f"
FRAME_HEIGHT = 720  # what we send to the model: enough to read overlay text, cheap to upload


def sample_args(src: Path, out_dir: Path, fps: float, max_frames: int, ffmpeg_bin: str | None = None) -> list[str]:
    """Evenly sampled frames, scaled down, at most ``max_frames`` of them."""
    return [
        ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(src),
        "-vf", f"fps={fps},scale=-2:{FRAME_HEIGHT}",
        "-frames:v", str(max_frames),
        "-q:v", "3",
        str(out_dir / f"{FRAME_PREFIX}%04d.jpg"),
    ]  # fmt: skip


def effective_fps(fps: float, max_frames: int, duration: float | None) -> float:
    """Sampling rate that spreads ``max_frames`` over the whole video.

    At the configured 0.5 fps and 20 frames only the first 40 s were ever looked at, so text in
    the second half of a longer creative was silently never detected. Longer videos now get a
    sparser grid instead of a truncated one.
    """
    if fps <= 0:
        return fps
    if duration and max_frames > 0 and duration * fps > max_frames:
        return max(int(max_frames / duration * 10000) / 10000, 0.0001)
    return fps


def frame_time(index: int, fps: float) -> float:
    """Source-timeline seconds of the ``index``-th sampled frame (0-based).

    ``fps=0.5`` samples at 0 s, 2 s, 4 s … — ffmpeg emits the first frame at t=0, not at t=1/fps.
    """
    return round(index / fps, 3) if fps > 0 else 0.0


def frame_paths(out_dir: Path) -> list[Path]:
    return sorted(out_dir.glob(f"{FRAME_PREFIX}*.jpg"))


def dedupe_frames(paths: list[Path], threshold: float = 4.0) -> list[Path]:
    """Drop frames that look the same as the one we last kept.

    Ad creatives hold a still frame for seconds at a time, and the vision model is billed per
    frame, so this is where most of the cost goes away. Comparison is a 32×32 grey thumbnail
    mean absolute difference — cheap, and insensitive to encoder noise.
    """
    from PIL import Image  # noqa: PLC0415

    kept: list[Path] = []
    last: list[int] | None = None
    for path in paths:
        try:
            with Image.open(path) as im:
                thumb = list(im.convert("L").resize((32, 32)).getdata())
        except Exception:  # noqa: BLE001  unreadable frame: keep it, the model will decide
            kept.append(path)
            last = None
            continue
        if last is not None:
            diff = sum(abs(a - b) for a, b in zip(thumb, last, strict=False)) / len(thumb)
            if diff < threshold:
                continue
        kept.append(path)
        last = thumb
    return kept


# --- clustering -------------------------------------------------------------

_WS = re.compile(r"\s+")

MIN_IOU = 0.5  # same text at the same place across frames = one block
# Centre drift (relative) above which we call a block "moving". Was 0.02, but on real frames the
# vision model's box for a static line wobbles by a few percent from frame to frame (its width
# estimate especially), which flagged persistent captions as moving and dropped them.
MOVE_TOLERANCE = 0.05
# Two readings of the same line count as one text above this similarity: the model misreads a
# character or two differently on each frame ("具体奖励" / "员受助"), and exact matching split one
# persistent disclaimer into a dozen blocks.
SIMILAR_TEXT = 0.8


def normalize_text(text: str) -> str:
    return _WS.sub(" ", (text or "").strip())


def similar_text(a: str, b: str) -> bool:
    if a == b:
        return True
    if min(len(a), len(b)) < 8:
        # Short lines differ in exactly the character that matters: "1元" / "2元", or two
        # consecutive subtitles "第一句" / "第二句". OCR noise only needs absorbing on long lines.
        return False
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() >= SIMILAR_TEXT


def block_id(text: str) -> str:
    """A stable id for a piece of on-screen text, derived from the text itself.

    Positional ids (s0, s1, …) look tidier but break the one thing that matters across a
    re-detection: the translations already written and the geometry already adjusted are keyed
    by id, and a re-detect that finds one block more would shift every one of them onto the
    wrong text.
    """
    return "s" + hashlib.sha1(normalize_text(text).encode("utf-8")).hexdigest()[:8]


def same_place(a: Box, b: Box, min_iou: float = MIN_IOU) -> bool:
    """Is ``b`` the same on-screen line as ``a``, one frame later?

    IoU alone is too strict for thin lines: a disclaimer 3 % of the frame tall whose box the model
    places 2 % higher on the next frame drops below 0.5 IoU and splits into a new block every few
    seconds. So a line also matches when it mostly overlaps horizontally and its vertical centre
    moved by less than a line height.
    """
    if iou(a, b) >= min_iou:
        return True
    overlap = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    if overlap <= 0 or overlap < 0.6 * min(a["w"], b["w"]):
        return False
    return abs(center(a)[1] - center(b)[1]) <= max(a["h"], b["h"])


@dataclass
class _Track:
    text: str
    boxes: list[Box]
    times: list[float]
    # How far each sighting's evidence reaches (see ``cluster_blocks``).
    ends: list[float]
    confidences: list[float]
    readings: list[str] = field(default_factory=list)

    def best_text(self) -> str:
        """The most frequent reading (the longest on a tie): OCR noise is rarely repeated."""
        counts = Counter(self.readings or [self.text])
        return max(counts, key=lambda t: (counts[t], len(t)))

    def moved(self) -> float:
        if len(self.boxes) < 2:
            return 0.0
        xs = [center(b)[0] for b in self.boxes]
        ys = [center(b)[1] for b in self.boxes]
        return max(max(xs) - min(xs), max(ys) - min(ys))


def cluster_blocks(
    per_frame: list[tuple[float, float, list[DetectedText]]],
    step: float,
    *,
    min_iou: float = MIN_IOU,
) -> list[dict[str, Any]]:
    """Per-frame detections → blocks with a time range.

    Each entry is ``(seen_at, covers_until, items)``. The two times differ because of the
    perceptual de-duplication upstream: a frame that stood in for several identical frames
    after it *is* evidence that the text was still on screen for all of them, and dropping
    that would shrink a ten-second title down to one sampling interval. Frames that were
    actually sent to the model have ``covers_until == seen_at``.

    Matching is "same normalised text, boxes overlap": a caption that re-appears later in a
    different spot becomes two blocks, which is what the editor wants — two layers with two
    time ranges rather than one that jumps.
    """
    tracks: list[_Track] = []
    open_tracks: dict[int, float] = {}  # track index → the end of its coverage so far
    for time, until, items in per_frame:
        seen: set[int] = set()
        for item in items:
            text = normalize_text(item.text)
            if not text:
                continue
            b = clamp_box(item.box)
            match: int | None = None
            for i, track in enumerate(tracks):
                if i in seen or not similar_text(track.text, text):
                    continue
                # Only continue a track whose coverage runs up to this frame.
                if open_tracks.get(i) is None or time - open_tracks[i] > step * 1.5 + 1e-6:
                    continue
                if same_place(track.boxes[-1], b, min_iou):
                    match = i
                    break
            if match is None:
                tracks.append(_Track(text=text, boxes=[b], times=[time], ends=[until], confidences=[item.confidence or 0.0], readings=[text]))
                match = len(tracks) - 1
            else:
                tracks[match].readings.append(text)
                tracks[match].boxes.append(b)
                tracks[match].times.append(time)
                tracks[match].ends.append(until)
                tracks[match].confidences.append(item.confidence or 0.0)
            seen.add(match)
            open_tracks[match] = max(time, until)

    half = step / 2
    out: list[dict[str, Any]] = []
    used: Counter[str] = Counter()
    for i, track in enumerate(tracks):
        start = max(0.0, track.times[0] - half)
        end = max(track.ends[-1], track.times[-1]) + half
        confidences = [c for c in track.confidences if c > 0]
        # Ids come from the text, not from position. Re-detecting shifts what is found and in
        # which order, and positional ids would silently re-attach an old translation — and the
        # geometry someone adjusted by hand — to a different piece of text.
        text = track.best_text()
        base = block_id(text)
        used[base] += 1
        block_key = base if used[base] == 1 else f"{base}-{used[base]}"
        out.append(
            {
                "id": block_key,
                "text": text,
                "box": union_box(track.boxes),
                "t": [round(start, 3), round(end, 3)],
                "lines": 1,
                "confidence": round(sum(confidences) / len(confidences), 3) if confidences else None,
                "moving": track.moved() > MOVE_TOLERANCE,
                "enabled": True,
                # Internal: exactly which sampled frame to measure the style on. Popped before
                # the block is written back, so it never reaches the contract.
                "first_seen": track.times[0],
            }
        )
    out.sort(key=lambda b: (b["t"][0], b["box"]["y"], b["box"]["x"]))
    return out


# Where burnt-in subtitles live: lower part of the frame, horizontally centred.
BAND_MIN_Y = 0.62
BAND_CENTER_TOLERANCE = 0.18


def is_subtitle_like(b: dict[str, Any]) -> bool:
    cx, cy = center(b["box"])
    return cy >= BAND_MIN_Y and abs(cx - 0.5) <= BAND_CENTER_TOLERANCE


# Lines whose centres sit this close vertically are one row; a subtitle band is at most this tall.
BAND_ROW_TOLERANCE = 0.035
BAND_MAX_HEIGHT = 0.16


def split_band(blocks: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Pull the burnt-in subtitle blocks out into a single band.

    Hard subtitles are many *different* lines shown one after another on the *same row*. So the
    subtitle-like blocks are grouped into rows by vertical centre and the row carrying the most
    distinct lines wins; an adjacent row joins it only when it too carries several lines (a
    two-line subtitle). Taking the union of everything low and centred instead — what this did
    before — swallowed pop-ups and buttons and produced a band covering a third of the frame,
    which erasure then blurred for the whole clip.

    It takes at least two lines on the row before we call it a subtitle band: one line low in
    the frame is just as likely to be a slogan, and blurring a slogan for the whole clip is worse
    than leaving it to the user.
    """
    candidates = sorted((b for b in blocks if is_subtitle_like(b) and not b["moving"]), key=lambda b: center(b["box"])[1])
    rows: list[list[dict[str, Any]]] = []
    for b in candidates:
        cy = center(b["box"])[1]
        if rows and abs(cy - sum(center(x["box"])[1] for x in rows[-1]) / len(rows[-1])) <= BAND_ROW_TOLERANCE:
            rows[-1].append(b)
        else:
            rows.append([b])
    rows = [r for r in rows if len({x["text"] for x in r}) >= 2]
    if not rows:
        return None, blocks
    best = max(rows, key=lambda r: (len({x["text"] for x in r}), center(r[0]["box"])[1]))
    members = list(best)
    for row in rows:
        if row is best:
            continue
        trial = union_box([x["box"] for x in members + row])
        if trial["h"] <= BAND_MAX_HEIGHT:
            members += row
    band_box = union_box([x["box"] for x in members])
    if band_box["h"] > BAND_MAX_HEIGHT:
        return None, blocks
    band = {
        "box": band_box,
        "style": {},
        "confidence": round(min(1.0, len(members) / 4), 2),
    }
    ids = {id(x) for x in members}
    return band, [b for b in blocks if id(b) not in ids]


def limit_blocks(blocks: list[dict[str, Any]], max_blocks: int) -> list[dict[str, Any]]:
    """Keep the ``max_blocks`` largest, in time order. Ids are content-derived, so they survive."""
    if len(blocks) <= max_blocks:
        return blocks
    kept = sorted(blocks, key=lambda b: b["box"]["w"] * b["box"]["h"], reverse=True)[:max_blocks]
    kept.sort(key=lambda b: (b["t"][0], b["box"]["y"], b["box"]["x"]))
    return kept


def apply_block_edits(blocks: list[dict[str, Any]], edits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge the user's corrections into the detected blocks (only the keys they sent)."""
    by_id = {b["id"]: b for b in blocks}
    unknown = [e["id"] for e in edits if e["id"] not in by_id]
    if unknown:
        raise ValueError(f"没有这些画面文字块：{'、'.join(unknown)}")
    out = copy.deepcopy(blocks)
    index = {b["id"]: b for b in out}
    for edit in edits:
        target = index[edit["id"]]
        if edit.get("text") is not None:
            target["text"] = normalize_text(edit["text"])
        if edit.get("box") is not None:
            target["box"] = clamp_box(edit["box"])
        if edit.get("t") is not None:
            a, b = float(edit["t"][0]), float(edit["t"][1])
            target["t"] = [round(max(0.0, a), 3), round(max(a, b), 3)]
        if edit.get("enabled") is not None:
            target["enabled"] = bool(edit["enabled"])
    return out


def enabled_blocks(detect: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Blocks the user left on and we can actually handle (moving text is out of scope)."""
    if not detect:
        return []
    return [b for b in detect.get("blocks") or [] if b.get("enabled", True) and not b.get("moving")]


def apply_text_edits(texts: list[dict[str, Any]], edits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge corrected translations into a version's ``texts``."""
    known = {t["id"] for t in texts}
    unknown = [e["id"] for e in edits if e["id"] not in known]
    if unknown:
        raise ValueError(f"没有这些画面文字块：{'、'.join(unknown)}")
    out = copy.deepcopy(texts)
    index = {t["id"]: t for t in out}
    for edit in edits:
        index[edit["id"]]["translated"] = (edit.get("translated") or "").strip()
    return out


# --- orchestration ----------------------------------------------------------


def _run(argv: list[str], what: str, timeout: int = 600) -> subprocess.CompletedProcess[bytes]:
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise ScreenTextError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ScreenTextError(f"{what}超时") from exc
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-8:])
        raise ScreenTextError(f"{what}失败（exit {proc.returncode}）：{tail}")
    return proc


def stamp(part: dict[str, Any], **fields: Any) -> dict[str, Any]:
    """Update a status part and refresh its ``updated_at``; ``erase.py`` writes through it too."""
    part.update(fields)
    part["updated_at"] = iso(utcnow())
    return part


def save(
    db: Session,
    video: Video,
    st: dict[str, Any],
    *,
    detect: bool = False,
    erase: bool = False,
    langs: list[str] | tuple[str, ...] = (),
    stale_all: bool = False,
    clear_pending: bool = False,
) -> None:
    """Write back only the parts this task owns.

    Same reason as ``localize._save``: the API keeps taking requests while the task runs, so the
    row is re-read and merged instead of overwritten — otherwise a language queued a second ago
    disappears under a running task.
    """
    db.refresh(video)
    fresh: dict[str, Any] = copy.deepcopy(video.screen_text or {})
    fresh.setdefault("versions", {})
    if detect:
        fresh["detect"] = copy.deepcopy(st.get("detect"))
    if erase:
        fresh["erase"] = copy.deepcopy(st.get("erase"))
    if stale_all:
        for version in fresh["versions"].values():
            version["stale"] = True
        if fresh.get("erase"):
            fresh["erase"]["stale"] = True
    for lang in langs:
        if lang in st.get("versions", {}):
            fresh["versions"][lang] = copy.deepcopy(st["versions"][lang])
    if clear_pending:
        fresh.pop("pending", None)
    video.screen_text = fresh  # a new object so the JSON column notices
    video.updated_at = utcnow()
    db.commit()


def detect_blocks(
    video: Video,
    provider: ScreenTextProvider,
    tmp: Path,
    hint_lang: str | None,
    cfg: Settings | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Sample, de-duplicate, recognise, cluster and style — the whole ``detect`` part.

    ``on_progress(done, total)`` is called before the first vision call and after each one, so
    the caller can show "识别中 N/M 帧" and keep the state's heartbeat fresh.
    """
    cfg = cfg or settings
    src = storage.source_path(video.batch_id, video.id, video.source_ext)
    if not src.exists():
        raise ScreenTextError("找不到源视频文件")
    tmp.mkdir(parents=True, exist_ok=True)
    fps = effective_fps(cfg.screentext_sample_fps, cfg.screentext_max_frames, video.duration)
    _run(sample_args(src, tmp, fps, cfg.screentext_max_frames), "抽帧")
    frames = frame_paths(tmp)
    if not frames:
        raise ScreenTextError("没有抽到任何画面帧")
    index_of = {path: i for i, path in enumerate(frames)}
    kept = dedupe_frames(frames)
    step = 1.0 / fps if fps > 0 else 1.0

    # Each kept frame stands in for the identical frames that followed it, so it carries their
    # time as well — otherwise a title held on a static shot would come back one interval long.
    kept_indices = [index_of[path] for path in kept]
    covers_until = [
        frame_time((kept_indices[k + 1] - 1) if k + 1 < len(kept_indices) else (len(frames) - 1), fps)
        for k in range(len(kept_indices))
    ]

    per_frame: list[tuple[float, float, list[DetectedText]]] = []
    if on_progress:
        on_progress(0, len(kept))
    for k, path in enumerate(kept):
        seen_at = frame_time(kept_indices[k], fps)
        per_frame.append((seen_at, max(seen_at, covers_until[k]), provider.detect(path, hint_lang)))
        if on_progress:
            on_progress(k + 1, len(kept))

    blocks = cluster_blocks(per_frame, step)
    band, blocks = split_band(blocks)
    blocks = limit_blocks(blocks, cfg.screentext_max_blocks)

    # Style: measured on the exact frame each block was first seen on, not the nearest guess.
    by_time = {seen_at: path for (seen_at, _, _), path in zip(per_frame, kept, strict=False)}
    _estimate_styles(blocks, band, by_time)
    for block in blocks:
        block.pop("first_seen", None)

    return {
        "status": ST_DONE,
        "error": None,
        "model": cfg.screentext_model if cfg.screentext_provider != "fake" else "fake",
        "frames": len(kept),
        "subtitle_band": band,
        "blocks": blocks,
        "updated_at": iso(utcnow()),
    }


def _estimate_styles(blocks: list[dict[str, Any]], band: dict[str, Any] | None, by_time: dict[float, Path]) -> None:
    """Fill in each block's ``style`` from the frame it was first seen on.

    The frame is looked up by that exact timestamp rather than by nearest match: after
    de-duplication the kept frames are far apart and can show completely different shots, so a
    near miss would measure the wrong picture and report a confident, wrong style.

    A failure here is never fatal: a block without a style still gets written back, the editor
    just falls back to the default subtitle look.
    """
    from PIL import Image  # noqa: PLC0415

    from app.services import screen_style  # noqa: PLC0415

    cache: dict[Path, Any] = {}

    def frame_for(when: float | None) -> Any:
        path = by_time.get(when) if when is not None else None
        if path is None:
            return None
        if path not in cache:
            try:
                with Image.open(path) as im:
                    cache[path] = im.convert("RGB").copy()
            except Exception:  # noqa: BLE001
                cache[path] = None
        return cache[path]

    for block in blocks:
        image = frame_for(block.get("first_seen"))
        if image is None:
            continue
        try:
            style = screen_style.estimate_style(image, block["box"])
        except Exception:  # noqa: BLE001  estimation is best-effort by design
            log.warning("style estimation failed for block %s", block["id"], exc_info=True)
            continue
        block["lines"] = style.pop("lines", block.get("lines", 1))
        block["style"] = style
    if band is not None:
        # The band is measured on the first frame any of its lines showed up on.
        image = frame_for(next(iter(sorted(by_time))) if by_time else None)
        if image is not None:
            try:
                band["style"] = screen_style.estimate_style(image, band["box"])
                band["style"].pop("lines", None)
            except Exception:  # noqa: BLE001
                log.warning("style estimation failed for the subtitle band", exc_info=True)


def translate_blocks(
    blocks: list[dict[str, Any]],
    source_lang: str,
    target_lang: str,
    terms: list[dict[str, str]],
    mt: Any,
) -> list[dict[str, Any]]:
    """One numbered request for all the on-screen text, same protocol as the dubbing."""
    from app.services import localize  # noqa: PLC0415

    if not blocks:
        return []
    texts = [b["text"] for b in blocks]
    translated = localize.translate_with_fallback(mt, texts, source_lang, target_lang, terms)
    return [{"id": b["id"], "translated": t.strip()} for b, t in zip(blocks, translated, strict=False)]


def detection_failure_reason(exc: BaseException) -> str:
    """The Chinese reason shown on ``detect.error``, with a hint for the causes we have seen."""
    reason = str(exc) or exc.__class__.__name__
    if not isinstance(exc, ScreenTextError) and "画面文字识别" not in reason:
        reason = f"画面文字识别失败：{reason}"
    if "403" in reason or "Access denied" in reason or "not activated" in reason.lower():
        reason += "（当前百炼账号没有这个视觉模型的权限：请检查 SCREENTEXT_MODEL，或在百炼控制台开通该模型）"
    return reason


def run_screen_text(db: Session, video_id: str, providers: Providers | None = None, cfg: Settings | None = None) -> None:
    """The ``hitgo.screen_text_video`` task body: detect, translate, and hand erasure off."""
    from celery.exceptions import SoftTimeLimitExceeded  # noqa: PLC0415

    from app.services import erase as erase_service  # noqa: PLC0415

    cfg = cfg or settings
    video = db.get(Video, video_id)
    if video is None:
        return
    providers = providers or make_providers(cfg)
    st: dict[str, Any] = copy.deepcopy(video.screen_text or {})
    st.setdefault("versions", {})
    pending = dict(st.get("pending") or {})
    langs: list[str] = [l for l in pending.get("target_langs") or [] if st["versions"].get(l, {}).get("status") == ST_QUEUED]
    want_erase = bool(pending.get("erase"))
    scope = pending.get("scope") or {}
    terms: list[dict[str, str]] = list(pending.get("terms") or [])
    source_lang = pending.get("source_lang") or "auto"
    tmp = storage.tmp_dir() / f"{video_id}.st"

    try:
        if (st.get("detect") or {}).get("status") in (ST_QUEUED, ST_RUNNING):
            st["detect"] = stamp(dict(st.get("detect") or {}), status=ST_RUNNING, error=None, progress=None)
            save(db, video, st, detect=True)

            def progress(done: int, total: int) -> None:
                # Also the heartbeat: expire_stale_state measures time since the last update.
                st["detect"] = stamp(dict(st["detect"]), progress={"done": done, "total": total})
                save(db, video, st, detect=True)

            try:
                st["detect"] = detect_blocks(
                    video, providers.detect, tmp, source_lang if source_lang != "auto" else None, cfg, on_progress=progress
                )
            except SoftTimeLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001  every failure must end in a visible reason
                # The vision call raises LocalizeError (e.g. 403 for a model the account may not
                # use). Only ScreenTextError used to be caught here, so anything else escaped,
                # left detect "running" and surfaced 20 minutes later as a bare timeout.
                reason = detection_failure_reason(exc)
                if not isinstance(exc, ScreenTextError):
                    log.warning("screen text detection failed for %s", video_id, exc_info=True)
                st["detect"] = stamp(dict(st["detect"]), status=ST_FAILED, error=reason)
                save(db, video, st, detect=True)
                _fail_versions(db, video, st, langs, "画面文字识别失败，无法翻译")
                _fail_erase(db, video, st, reason)
                return
            save(db, video, st, detect=True, stale_all=True)

        detect = st.get("detect") or {}
        if detect.get("status") != ST_DONE:
            _fail_versions(db, video, st, langs, "还没有画面文字识别结果")
            _fail_erase(db, video, st, "还没有画面文字识别结果")
            return

        blocks = enabled_blocks(detect)
        for lang in langs:
            version = dict(st["versions"].get(lang) or {})
            st["versions"][lang] = stamp(version, status=ST_RUNNING, error=None)
            save(db, video, st, langs=[lang])
            try:
                texts = translate_blocks(blocks, source_lang, lang, terms, providers.mt)
            except Exception as exc:  # noqa: BLE001  one language failing must not stop the rest
                log.warning("screen text translation failed for %s", lang, exc_info=True)
                st["versions"][lang] = stamp(dict(st["versions"][lang]), status=ST_FAILED, error=f"翻译失败：{exc}")
            else:
                st["versions"][lang] = stamp(dict(st["versions"][lang]), status=ST_DONE, texts=texts, stale=False, error=None)
            save(db, video, st, langs=[lang])

        if want_erase:
            erase_service.start(db, video, st, scope, cfg)
    except SoftTimeLimitExceeded:
        log.error("screen text %s exceeded %ss", video_id, cfg.screentext_timeout_seconds)
        note = f"画面文字处理超过 {cfg.screentext_timeout_seconds} 秒仍未完成，已中止"
        if (st.get("detect") or {}).get("status") in (ST_QUEUED, ST_RUNNING):
            st["detect"] = stamp(dict(st["detect"]), status=ST_FAILED, error=note)
            save(db, video, st, detect=True)
        _fail_versions(db, video, st, [l for l in langs if st["versions"].get(l, {}).get("status") in (ST_QUEUED, ST_RUNNING)], note)
        _fail_erase(db, video, st, note)
        raise
    except Exception as exc:
        # Last line of defence (a database hiccup, a bug): never leave a part queued/running,
        # which would disable the retry button until the stale check fires. Roll back first: after
        # a database error the session is stuck in the failed transaction and every save() below
        # (and the one in ``finally``) would raise PendingRollbackError instead of writing.
        log.exception("screen text %s failed", video_id)
        db.rollback()
        note = f"画面文字处理出错：{exc}"
        if (st.get("detect") or {}).get("status") in (ST_QUEUED, ST_RUNNING):
            st["detect"] = stamp(dict(st["detect"]), status=ST_FAILED, error=note)
            save(db, video, st, detect=True)
        _fail_versions(db, video, st, [l for l in langs if st["versions"].get(l, {}).get("status") in (ST_QUEUED, ST_RUNNING)], note)
        _fail_erase(db, video, st, note)
        raise
    finally:
        storage.remove_tree(tmp)
        db.refresh(video)
        save(db, video, st, clear_pending=True)


def _fail_versions(db: Session, video: Video, st: dict[str, Any], langs: list[str], reason: str) -> None:
    touched = []
    for lang in langs:
        version = st["versions"].get(lang)
        if version and version.get("status") in (ST_QUEUED, ST_RUNNING):
            st["versions"][lang] = stamp(dict(version), status=ST_FAILED, error=reason)
            touched.append(lang)
    if touched:
        save(db, video, st, langs=touched)


def _fail_erase(db: Session, video: Video, st: dict[str, Any], reason: str) -> None:
    er = st.get("erase")
    if er and er.get("status") in (ST_QUEUED, ST_RUNNING):
        st["erase"] = stamp(dict(er), status=ST_FAILED, error=reason)
        save(db, video, st, erase=True)

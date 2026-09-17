"""Build the ffmpeg command for one render job (contract §6, "渲染").

Pure: no filesystem or database access. The caller resolves sticker assets and
text-layer PNGs into ``ImageSource`` objects; layers whose image cannot be
resolved are skipped and reported in ``RenderPlan.warnings``.

Filter graph order:
    source → trim/atrim + concat (skipped when nothing is removed)
           → canvas fill (blur | color | crop; crop honours an optional source window first)
           → one overlay per layer (enable='between(t,a,b)' for timed layers; an animated text
             layer, HIG-40, loops its PNG and moves through perspective / geq / overlay
             expressions, see services/animation.py; a reveal, HIG-45, masks the PNG's alpha
             before that, see services/reveal.py); mask layers
             (contract §2 type "mask") take no input: a split + crop + boxblur + overlay, or a
             drawbox, over the running canvas
           → format=yuv420p
           → (cover only) [cover v][cover a][main v][main a]concat=n=2 — the cover is laid on the
             canvas with the same fill, the main part is exactly the chain above
    audio: source audio (trimmed like the video) is mapped as-is, unless the spec asks
           for more — a video sticker layer with mix_audio, or an ``audio`` block
           (source gain + BGM / voice-over tracks). Then every extra track is windowed,
           faded, delayed and amix'ed on top of the (gain-adjusted) source audio, or of
           silence when the source is muted / has no track.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from app.schemas import (
    CANVAS_SIZES,
    DEFAULT_VARIANT_KEY,
    CropRect,
    EditSpec,
    MaskLayer,
    OutputVariant,
    StickerLayer,
    TextLayer,
)
from app.services import reveal as reveal_mask
from app.services.animation import AnimExpr, enter_delay, expressions, scale_headroom, with_time
from app.services.scroll import scroll_path, y_expression
from app.services.layout import (
    Box,
    FitMap,
    fit_map,
    follow_layer_box,
    follow_mask_box,
    layer_box,
    mask_box,
    rotated_overlay_position,
)
from app.services.sequence import ClipSource

_AUDIO_ARGS: list[str] = ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]

# Output quality tiers (contract §2 outputs[].quality / §6 编码).
ENCODE_PRESETS: dict[str, list[str]] = {
    "standard": [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-maxrate", "8M", "-bufsize", "16M",
        *_AUDIO_ARGS,
    ],
    "high": [
        "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-maxrate", "10M", "-bufsize", "20M",
        *_AUDIO_ARGS,
    ],
}  # fmt: skip

ENCODE_ARGS: list[str] = ENCODE_PRESETS["standard"]  # backwards-compatible alias


def encode_args(quality: str = "standard") -> list[str]:
    """Encoder argv for a quality tier; unknown tiers fall back to standard."""
    return list(ENCODE_PRESETS.get(quality, ENCODE_PRESETS["standard"]))

# Blurred backdrop (contract §2 outputs[].blur / bg_brightness): radius = short side × strength × this.
BLUR_BG_RADIUS_PER_SHORT_SIDE = 0.08
BLUR_BG_POWER = 2
# Mask layer blur strength (contract §2 mask.blur 1 | 2 | 3) → boxblur luma radius : power.
MASK_BLUR_LEVELS: dict[int, tuple[int, int]] = {1: (10, 1), 2: (20, 2), 3: (40, 3)}
MASK_MIN_SIZE = 2  # px; a mask region smaller than this after clamping is skipped
MIN_SEGMENT = 0.01  # seconds; shorter keep-segments are dropped
# Every amix input is brought to one format so sources with odd layouts or rates mix cleanly.
AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


@dataclass(frozen=True)
class ImageSource:
    """One layer's media. ``duration is None`` means a still image (the original case)."""

    path: str
    width: int
    height: int
    duration: float | None = None  # seconds; None = still image
    decoder: str | None = None  # forced input decoder, e.g. "libvpx-vp9" for alpha WebM
    has_alpha: bool = True  # informational; drives the frontend hint, not the graph
    has_audio: bool = False  # only consulted for layers with mix_audio

    @property
    def is_video(self) -> bool:
        return self.duration is not None


@dataclass(frozen=True)
class AudioSource:
    """One audio asset (BGM / voice-over) resolved to a local file, for ``audio.tracks``."""

    path: str
    duration: float  # seconds
    name: str = ""  # asset display name, only echoed into RenderPlan.audio


@dataclass(frozen=True)
class CoverSource:
    """The resolved ``cover`` asset. ``media.is_video`` decides image vs. video cover."""

    media: ImageSource
    image_duration: float = 1.0  # spec cover.duration; ignored for video covers

    @property
    def duration(self) -> float:
        if self.media.is_video:
            return float(self.media.duration or 0.0)
        return float(self.image_duration)


DEFAULT_FPS = 30.0


@dataclass
class RenderPlan:
    argv: list[str]
    expected_duration: float
    canvas: tuple[int, int]
    warnings: list[str] = field(default_factory=list)
    filter_complex: str = ""
    # What the output audio is actually made of (contract §1 Job output.audio); None
    # when the spec has no audio block.
    audio: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def keep_segments(remove: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    """Complement of the removed ranges within [0, duration]."""
    segments: list[tuple[float, float]] = []
    cursor = 0.0
    for a, b in sorted(remove):
        a = max(0.0, min(a, duration))
        b = max(0.0, min(b, duration))
        if a > cursor + MIN_SEGMENT:
            segments.append((cursor, a))
        cursor = max(cursor, b)
    if duration - cursor > MIN_SEGMENT:
        segments.append((cursor, duration))
    return segments


def ffmpeg_color(hex_color: str) -> str:
    """'#RRGGBB[AA]' → '0xRRGGBB[AA]' (ffmpeg color syntax that never clashes with '#')."""
    return "0x" + hex_color.lstrip("#")


def _fmt(v: float) -> str:
    """Compact float formatting for filter arguments."""
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def blur_background_radius(W: int, H: int, strength: int) -> int:
    """boxblur radius of the blurred backdrop, kept below the chroma plane's limit (quarter of the short side)."""
    short = min(W, H)
    radius = round(short * max(0, min(100, strength)) / 100 * BLUR_BG_RADIUS_PER_SHORT_SIDE)
    return max(0, min(radius, short // 4 - 1))


def blur_background_steps(W: int, H: int, strength: int, brightness: int) -> list[str]:
    """Filters for the cover-scaled backdrop: blur, then dim it with a translucent black box."""
    steps: list[str] = []
    radius = blur_background_radius(W, H, strength)
    if radius > 0:
        steps.append(f"boxblur={radius}:{BLUR_BG_POWER}")
    if brightness < 100:
        steps.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=black@{_fmt(1 - brightness / 100)}:t=fill")
    return steps


def fill_chains(
    label: str,
    fill: str,
    color: str | None,
    crop: CropRect | None,
    W: int,
    H: int,
    out: str,
    tag: str = "",
    blur: int = 60,
    brightness: int = 50,
) -> list[str]:
    """Lay ``label`` onto the W×H canvas (contract §2 fill), ending in ``out``.

    ``tag`` suffixes the intermediate labels so a second fill (the cover) can live in the same
    graph; the main video uses no tag, which keeps its chains exactly as they always were.
    ``blur`` / ``brightness`` are the variant's backdrop strength and brightness (fill == "blur" only).
    """
    chains: list[str] = []
    if fill == "blur":
        chains.append(f"{label}split=2[bg{tag}][fg{tag}]")
        backdrop = [f"crop={W}:{H}", *blur_background_steps(W, H, blur, brightness)]
        chains.append(
            f"[bg{tag}]scale={W}:{H}:force_original_aspect_ratio=increase,"
            f"{','.join(backdrop)}[bgb{tag}]"
        )
        chains.append(f"[fg{tag}]scale={W}:{H}:force_original_aspect_ratio=decrease[fgs{tag}]")
        chains.append(f"[bgb{tag}][fgs{tag}]overlay=(W-w)/2:(H-h)/2{out}")
    elif fill == "color":
        chains.append(
            f"{label}scale={W}:{H}:force_original_aspect_ratio=decrease,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={ffmpeg_color(color or '#000000')}{out}"
        )
    else:  # crop
        if crop is not None:
            # Explicit source window first (relative to the decoded frame), then the same cover
            # chain so a window whose ratio differs from the canvas is centre-cropped, not stretched.
            chains.append(
                f"{label}crop=w='iw*{_fmt(crop.w)}':h='ih*{_fmt(crop.h)}'"
                f":x='iw*{_fmt(crop.x)}':y='ih*{_fmt(crop.y)}'[cs{tag}]"
            )
            label = f"[cs{tag}]"
        chains.append(f"{label}scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}{out}")
    return chains


def apply_overrides(layer: StickerLayer | TextLayer | MaskLayer, variant: OutputVariant | None) -> dict[str, Any]:
    """Effective geometry for a layer inside a variant (layer_overrides applied).

    ``height`` is only present for mask layers (the other kinds take theirs from the media).
    """
    geo = {
        "anchor": layer.anchor,
        "margin": tuple(layer.margin),
        "width": layer.width,
        "rotate": layer.rotate,
        "opacity": layer.opacity,
    }
    if isinstance(layer, MaskLayer):
        geo["height"] = layer.height
    override = variant.layer_overrides.get(layer.id) if variant is not None else None
    if override is not None:
        for key, value in override.as_dict().items():
            if key == "height" and not isinstance(layer, MaskLayer):
                continue
            geo[key] = tuple(value) if key == "margin" else value
    return geo


def variant_fit_map(spec: EditSpec, variant: OutputVariant, src_w: float, src_h: float) -> FitMap | None:
    """Reference (9x16) → ``variant`` map when layers follow the video there, else None.

    The reference is the spec's ``9x16`` output, or a 9:16 blur canvas when there is none.
    Needs the source size; without it (legacy rows) we fall back to canvas-relative layout.
    """
    if variant.layer_fit != "video" or not (src_w and src_h and src_w > 0 and src_h > 0):
        return None
    ref = next((o for o in spec.outputs if o.variant_key == DEFAULT_VARIANT_KEY), None)
    if ref is variant:
        return None
    ref_tuple = (ref.fill, ref.crop, *ref.canvas) if ref is not None else ("blur", None, *CANVAS_SIZES["9:16"])
    return fit_map(ref_tuple, (variant.fill, variant.crop, *variant.canvas), src_w, src_h)


def _reference_geometry(spec: EditSpec, layer: StickerLayer | TextLayer | MaskLayer) -> dict[str, Any]:
    ref = next((o for o in spec.outputs if o.variant_key == DEFAULT_VARIANT_KEY), None)
    return apply_overrides(layer, ref) if ref is not None else apply_overrides(layer, None)


def _follows(layer: StickerLayer | TextLayer | MaskLayer, variant: OutputVariant, fmap: FitMap | None) -> bool:
    if fmap is None:
        return False
    override = variant.layer_overrides.get(layer.id)
    return override is None or not override.detaches


def mask_layer_box(
    spec: EditSpec, layer: MaskLayer, variant: OutputVariant, fmap: FitMap | None
) -> Box:
    """Mask rectangle on ``variant``'s canvas (follow the video or canvas-relative)."""
    if _follows(layer, variant, fmap):
        ref = _reference_geometry(spec, layer)
        rw, rh = fmap.ref_w, fmap.ref_h  # type: ignore[union-attr]
        return follow_mask_box(mask_box(ref["anchor"], ref["margin"], ref["width"], ref["height"], rw, rh), fmap)  # type: ignore[arg-type]
    geo = apply_overrides(layer, variant)
    W, H = variant.canvas
    return mask_box(geo["anchor"], geo["margin"], geo["width"], geo["height"], W, H)


def image_layer_box(
    spec: EditSpec,
    layer: StickerLayer | TextLayer,
    variant: OutputVariant,
    fmap: FitMap | None,
    image_w: int,
    image_h: int,
) -> Box:
    """Sticker / text rectangle on ``variant``'s canvas (follow the video or canvas-relative)."""
    if _follows(layer, variant, fmap):
        ref = _reference_geometry(spec, layer)
        return follow_layer_box(
            ref["anchor"], ref["margin"], ref["width"], image_w, image_h, fmap,  # type: ignore[arg-type]
            clamp=not isinstance(layer, TextLayer),  # HIG-37: text off the frame is cropped, not pushed back
        )
    geo = apply_overrides(layer, variant)
    W, H = variant.canvas
    return layer_box(geo["anchor"], geo["margin"], geo["width"], W, H, image_w, image_h)


def _layer_window(t: Any, expected_duration: float) -> tuple[float, float]:
    """Visible window on the post-trim timeline; "all" spans the whole output."""
    if t == "all":
        return 0.0, expected_duration
    return float(t[0]), min(float(t[1]), expected_duration)


def _mask_chains(
    layer: MaskLayer,
    geo: Mapping[str, Any],
    box: Box,
    W: int,
    H: int,
    current: str,
    n: int,
    window: tuple[float, float] | None,
    warnings: list[str],
    quiet_offcanvas: bool = False,
) -> list[str] | None:
    """Filter chains that lay mask layer ``n`` over ``current`` and end in ``[c{n}]``.

    ``window`` is the (start, end) of a timed layer, None for "all". Returns None — without
    consuming the ``[c{n}]`` label — when the region falls off the canvas or is too small to
    blur; the reason goes to ``warnings``.
    """
    x, y, w, h = box.rounded()
    # Clamp to the canvas: crop / drawbox reject regions that stick out.
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    w, h = x1 - x0, y1 - y0
    if w < MASK_MIN_SIZE or h < MASK_MIN_SIZE:
        # A mask following the video can be cropped out of a cover output on purpose: no warning.
        if not quiet_offcanvas:
            warnings.append(f"图层 {layer.id}：遮盖区域不在画布内，已跳过")
        return None
    x, y = x0, y0

    enable = f":enable='between(t,{_fmt(window[0])},{_fmt(window[1])})'" if window else ""
    opacity = float(geo["opacity"])
    out = f"[c{n}]"
    if layer.mode == "solid":
        color = ffmpeg_color(layer.color)
        if opacity < 1:
            color += f"@{_fmt(opacity)}"
        return [f"{current}drawbox=x={x}:y={y}:w={w}:h={h}:color={color}:t=fill{enable}{out}"]

    radius, power = MASK_BLUR_LEVELS[layer.blur]
    # boxblur refuses a radius that is not < min(w, h) / 2; shrink it to fit the region.
    radius = min(radius, min(w, h) // 2 - 1)
    if radius < 1:
        warnings.append(f"图层 {layer.id}：遮盖区域太小，无法模糊，已跳过")
        return None
    src, blurred, mixed = f"[m{n}s]", f"[m{n}b]", f"[m{n}x]"
    # format=rgba before crop: on yuv420p an odd x / y would be silently rounded to even.
    steps = [f"{blurred}format=rgba", f"crop={w}:{h}:{x}:{y}", f"boxblur=lr={radius}:lp={power}{enable}"]
    if opacity < 1:
        steps.append(f"colorchannelmixer=aa={_fmt(opacity)}")
    return [
        f"{current}split=2{src}{blurred}",
        ",".join(steps) + mixed,
        f"{src}{mixed}overlay={x}:{y}{enable}{out}",
    ]


# ---------------------------------------------------------------------------
# main builder
# ---------------------------------------------------------------------------


def cut_composed(chains: list[str], label: str, segments: list[tuple[float, float]], tag: str, audio: bool = False) -> str:
    """Trim a joined stream, preserving transitions before the cut; labels need splitting."""
    count = len(segments)
    split = 'asplit' if audio else 'split'
    trim, pts = ('atrim', 'asetpts') if audio else ('trim', 'setpts')
    inputs = [f'[{tag}in{i}]' for i in range(count)]
    if count > 1:
        chains.append(f'{label}{split}={count}{"".join(inputs)}')
    else:
        inputs = [label]
    outputs = []
    for i, (a, b) in enumerate(segments):
        out = f'[{tag}{i}]'
        chains.append(f'{inputs[i]}{trim}=start={_fmt(a)}:end={_fmt(b)},{pts}=PTS-STARTPTS{out}')
        outputs.append(out)
    if count == 1:
        return outputs[0]
    result = f'[{tag}joined]'
    chains.append(f'{"".join(outputs)}concat=n={count}:v={0 if audio else 1}:a={1 if audio else 0}{result}')
    return result


def build_render_command(
    spec: EditSpec,
    video_meta: Mapping[str, Any],
    assets: Mapping[str, ImageSource],
    variant: OutputVariant,
    *,
    source_path: str,
    output_path: str,
    resolve_image_url: Callable[[str], ImageSource | None] | None = None,
    ffmpeg_bin: str = "ffmpeg",
    audio_assets: Mapping[str, AudioSource] | None = None,
    cover: CoverSource | None = None,
    sequence_sources: list[ClipSource] | None = None,
) -> RenderPlan:
    """Return the ffmpeg argv, expected output duration and any layer warnings.

    video_meta needs: duration (s), has_audio (bool); fps is optional and only used to
    pace a cover. width/height are optional: ffmpeg scales relative to the actual decoded
    frame, and they are only read to lay out layers on a ``layer_fit = "video"`` output. ``audio_assets`` maps the ``audio.tracks[].asset_id`` values
    the caller could resolve; unresolved tracks are skipped with a warning. ``cover`` is
    the resolved ``spec.cover`` asset; when the spec has a cover the caller could not
    resolve, the render goes on without it and says so in the warnings.
    """
    sequence_sources = sequence_sources or []
    duration = spec.sequence.duration if spec.sequence else float(video_meta["duration"])
    has_audio = any(c.has_audio for c in sequence_sources) if sequence_sources else bool(video_meta.get("has_audio", False))
    canvas_w, canvas_h = variant.canvas
    audio_spec = spec.audio
    source_volume = float(audio_spec.source_volume) if audio_spec is not None else 1.0
    if audio_spec is not None and audio_spec.source_hidden:
        source_volume = 0.0
    # v0.22.1 and earlier applied the owner's mute to every inserted source.
    # Migrate that interpretation at render time too, for old queued/saved specs.
    legacy_clip_audio = bool(sequence_sources) and all(c.clip.source_volume is None for c in sequence_sources)
    clip_gains = [
        (source_volume if c.clip.video_id == video_meta.get("video_id") else 1.0)
        if legacy_clip_audio else (c.clip.source_volume if c.clip.source_volume is not None else 1.0)
        for c in sequence_sources
    ]
    if legacy_clip_audio:
        source_volume = 1.0
    # A muted source (audio.source_volume = 0) must not be decoded into the trim/concat
    # graph at all: a concat output nobody consumes makes ffmpeg reject the whole graph
    # ("Filter 'concat' has output 0 (at) unconnected").
    source_heard = has_audio and source_volume > 0 and (
        not sequence_sources or any(c.has_audio and gain > 0 for c, gain in zip(sequence_sources, clip_gains))
    )

    warnings: list[str] = []
    # One argv group per input: video stickers need per-input options (-stream_loop, -c:v).
    inputs: list[list[str]] = [["-i", c.path] for c in sequence_sources] if sequence_sources else [["-i", source_path]]
    chains: list[str] = []

    # ---- 1. trim / concat ---------------------------------------------------
    if sequence_sources:
        expected_duration = duration
        trimmed = True
        source_segments: list[tuple[float, float]] = []
        fps = _fmt(float(video_meta.get("fps") or DEFAULT_FPS))
        elapsed = 0.0
        for i, src in enumerate(sequence_sources):
            clip = src.clip
            length = clip.source_out - clip.source_in
            raw = f"[seqraw{i}]"
            chains.append(
                f"[{i}:v]trim=start={_fmt(clip.source_in)}:end={_fmt(clip.source_out)},"
                f"setpts=PTS-STARTPTS,fps={fps},setsar=1{raw}"
            )
            filled = f"[seqfill{i}]"
            chains += fill_chains(
                raw, variant.fill, variant.color, variant.crop, canvas_w, canvas_h, filled,
                tag=f"_seq{i}", blur=variant.blur, brightness=variant.bg_brightness,
            )
            chains.append(f"{filled}format=yuv420p,setsar=1[seqv{i}]")
            if source_heard:
                if src.has_audio and clip_gains[i] > 0:
                    chains.append(
                        f"[{i}:a]atrim=start={_fmt(clip.source_in)}:end={_fmt(clip.source_out)},"
                        f"asetpts=PTS-STARTPTS,{AUDIO_FORMAT},volume={_fmt(clip_gains[i])},apad,atrim=end={_fmt(length)}[seqa{i}]"
                    )
                else:
                    chains.append(f"anullsrc=r=48000:cl=stereo,atrim=end={_fmt(length)}[seqa{i}]")
            if i == 0:
                video_label = "[seqv0]"
                audio_label = "[seqa0]" if source_heard else None
                elapsed = length
                continue
            transition = clip.transition
            overlap = transition.duration if transition else 0.0
            next_video = f"[seqjoinedv{i}]"
            next_audio = f"[seqjoineda{i}]" if source_heard else None
            if overlap > 0:
                names = {
                    "fade": "fade", "slide_left": "slideleft", "slide_right": "slideright",
                    "wipe_left": "wipeleft", "wipe_right": "wiperight",
                }
                chains.append(
                    f"{video_label}[seqv{i}]xfade=transition={names[transition.type]}:"
                    f"duration={_fmt(overlap)}:offset={_fmt(elapsed - overlap)}{next_video}"
                )
                if source_heard:
                    chains.append(f"{audio_label}[seqa{i}]acrossfade=d={_fmt(overlap)}{next_audio}")
            elif source_heard:
                chains.append(f"{video_label}{audio_label}[seqv{i}][seqa{i}]concat=n=2:v=1:a=1{next_video}{next_audio}")
            else:
                chains.append(f"{video_label}[seqv{i}]concat=n=2:v=1:a=0{next_video}")
            video_label, audio_label = next_video, next_audio
            elapsed += length - overlap
        source_segments = keep_segments(spec.trim.remove, duration)
        if not source_segments:
            raise ValueError("剪辑后没有保留任何片段")
        expected_duration = sum(b - a for a, b in source_segments)
        if spec.trim.remove:
            video_label = cut_composed(chains, video_label, source_segments, 'seqcutv')
            if source_heard:
                audio_label = cut_composed(chains, audio_label, source_segments, 'seqcuta', audio=True)
    else:
        segments = keep_segments(spec.trim.remove, duration)
        if not segments:
            raise ValueError("剪辑后没有保留任何片段")
        expected_duration = sum(b - a for a, b in segments)
        trimmed = bool(spec.trim.remove) and segments != [(0.0, duration)]
        # Tracks on the source timeline (align = "source") follow the source, not its loops.
        source_segments = segments

        # Output length decoupled from the source (HIG-50, contract §2 trim.duration): longer
        # loops the kept segments — the source input repeats forever and the trim windows
        # are shifted one source length per pass, so the usual trim + concat chain does the
        # rest; shorter only needs the output -t below.
        target = spec.trim.duration
        if target is not None and target > expected_duration + MIN_SEGMENT:
            passes = math.ceil(target / expected_duration)
            segments = [(a + k * duration, b + k * duration) for k in range(passes) for a, b in segments]
            inputs[0] = ["-stream_loop", "-1", *inputs[0]]
            trimmed = True
        if target is not None:
            expected_duration = float(target)

        if trimmed:
            labels: list[str] = []
            for i, (a, b) in enumerate(segments):
                chains.append(f"[0:v]trim=start={_fmt(a)}:end={_fmt(b)},setpts=PTS-STARTPTS[v{i}]")
                labels.append(f"[v{i}]")
                if source_heard:
                    chains.append(
                        f"[0:a]atrim=start={_fmt(a)}:end={_fmt(b)},asetpts=PTS-STARTPTS[a{i}]"
                    )
                    labels.append(f"[a{i}]")
            if len(segments) == 1:
                video_label, audio_label = "[v0]", "[a0]" if source_heard else None
            else:
                n = len(segments)
                if source_heard:
                    chains.append(f"{''.join(labels)}concat=n={n}:v=1:a=1[vt][at]")
                    video_label, audio_label = "[vt]", "[at]"
                else:
                    chains.append(f"{''.join(labels)}concat=n={n}:v=1:a=0[vt]")
                    video_label, audio_label = "[vt]", None
        else:
            video_label, audio_label = "[0:v]", None  # audio mapped straight from input

    # ---- 2. canvas fill -----------------------------------------------------
    W, H = canvas_w, canvas_h
    if sequence_sources:
        chains.append(f"{video_label}setpts=PTS-STARTPTS[c0]")
    else:
        chains += fill_chains(
            video_label, variant.fill, variant.color, variant.crop, W, H, "[c0]",
            blur=variant.blur, brightness=variant.bg_brightness,
        )
    current = "[c0]"

    # ---- 3. layers ----------------------------------------------------------
    fmap = variant_fit_map(
        spec, variant,
        float(W if sequence_sources else (video_meta.get("width") or 0)),
        float(H if sequence_sources else (video_meta.get("height") or 0)),
    )
    layer_index = 0
    has_video_layer = False
    sticker_audio: list[str] = []  # labels of sticker audio chains to mix in
    for layer in spec.layers:
        if layer.hidden:
            continue  # eye off: no picture, and a video sticker's mix_audio goes with it
        if isinstance(layer, MaskLayer):
            # No media input: the mask works on the running canvas itself.
            window = None if layer.t == "all" else _layer_window(layer.t, expected_duration)
            mask = _mask_chains(
                layer,
                apply_overrides(layer, variant),
                mask_layer_box(spec, layer, variant, fmap),
                W,
                H,
                current,
                layer_index + 1,
                window,
                warnings,
                quiet_offcanvas=_follows(layer, variant, fmap),
            )
            if mask is None:
                continue
            chains += mask
            layer_index += 1
            current = f"[c{layer_index}]"
            continue

        image = _resolve_layer_image(layer, assets, resolve_image_url, warnings, variant.variant_key)
        if image is None:
            continue

        t_start, t_end = _layer_window(layer.t, expected_duration)
        if image.is_video and t_start >= expected_duration:
            warnings.append(f"图层 {layer.id}：出现时段起点超出剪后时长，已跳过")
            continue

        geo = apply_overrides(layer, variant)

        if isinstance(layer, TextLayer) and layer.scroll is not None and not image.is_video:
            # Scrolling copy (HIG-50): the tall PNG is padded by one box height above and
            # below, and a box-sized crop window slides down it with time; anchor / margin
            # do not apply, the window sits in the clip box. Frames count from the
            # output's t = 0 (same input shape as animated text).
            fps = _fmt(float(video_meta.get("fps") or DEFAULT_FPS))
            input_index = len(inputs)
            inputs.append(["-loop", "1", "-framerate", fps, "-t", _fmt(t_end), "-i", image.path])
            layer_index += 1
            lbl = f"[l{layer_index}]"
            sb = layer.scroll.box
            bx, by = round(sb.x * W), round(sb.y * H)
            bw, bh = max(2, round(sb.w * W)), max(2, round(sb.h * H))
            w = min(bw, max(1, round(float(geo["width"]) * W)))
            h = max(1, round(w * image.height / image.width))
            steps = [f"[{input_index}:v]format=rgba", f"scale={w}:{h}"]
            opacity = float(geo["opacity"])
            if opacity < 1:
                steps.append(f"colorchannelmixer=aa={_fmt(opacity)}")
            steps.append(f"pad={w}:{h + 2 * bh}:0:{bh}:color=0x00000000")
            path = scroll_path(layer.scroll, h / H)
            steps.append(f"crop={w}:{bh}:0:'{y_expression(path, H, 't', t_start)}'")
            chains.append(",".join(steps) + lbl)
            overlay = f"{current}{lbl}overlay={bx + (bw - w) // 2}:{by}:eof_action=repeat"
            if layer.t != "all":
                overlay += f":enable='between(t,{_fmt(t_start)},{_fmt(t_end)})'"
            out = f"[c{layer_index}]"
            chains.append(overlay + out)
            current = out
            continue

        box = image_layer_box(spec, layer, variant, fmap, image.width, image.height)
        x, y, w, h = box.rounded()
        w, h = max(1, w), max(1, h)

        playback = getattr(layer, "playback", "loop")
        options: list[str] = []
        if image.is_video:
            has_video_layer = True
            if playback == "loop":
                # Safe only because the layer chain ends in trim=end (see below);
                # on its own -stream_loop -1 makes ffmpeg run forever.
                options += ["-stream_loop", "-1"]
            if image.decoder:
                options += ["-c:v", image.decoder]

        # Text animation (HIG-40): None-valued channels stay static; no animation = the old argv.
        is_text = isinstance(layer, TextLayer) and not image.is_video
        window_len = t_end - t_start
        anim = expressions(layer.animation, window_len) if is_text else AnimExpr()
        # Reveal (HIG-45): an alpha mask over the PNG plane, plus the background block and cursor.
        mask: str | None = None
        cursor: reveal_mask.Cursor | None = None
        background: ImageSource | None = None
        if is_text and layer.animation is not None and layer.animation.reveal is not None:
            if layer.glyph_layout is None:
                warnings.append(f"图层 {layer.id}：没有 glyph_layout，逐字动画已跳过")
            else:
                delay = enter_delay(layer.animation, window_len)
                mask = reveal_mask.mask_expression(layer.glyph_layout, layer.animation.reveal, window_len, delay)
                if mask is not None:
                    cursor = reveal_mask.cursor(layer.glyph_layout, layer.animation.reveal, window_len, delay, w, h)
                    background = _resolve_text_background(layer, resolve_image_url, variant.variant_key)
        animated = any((anim.opacity, anim.dx, anim.dy, anim.scale, mask))
        fps = _fmt(float(video_meta.get("fps") or DEFAULT_FPS))

        input_index = len(inputs)
        if animated:
            # A still PNG hands overlay a single frame; per-frame alpha / scale need one frame per
            # output frame. Frames count from the output's t = 0, so filter time == output time.
            inputs.append(["-loop", "1", "-framerate", fps, "-t", _fmt(t_end), "-i", image.path])
        else:
            inputs.append([*options, "-i", image.path])
        layer_index += 1
        lbl = f"[l{layer_index}]"

        steps = [f"[{input_index}:v]format=rgba", f"scale={w}:{h}"]
        if mask is not None:
            # In the PNG plane, before padding / rotation move its pixels around.
            steps.append(f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*{with_time(mask, 'T', t_start)}'")
            if background is not None:
                bg_index = len(inputs)
                inputs.append(["-loop", "1", "-framerate", fps, "-t", _fmt(t_end), "-i", background.path])
                chains.append(",".join(steps) + f"[rv{layer_index}]")
                chains.append(f"[{bg_index}:v]format=rgba,scale={w}:{h}[rb{layer_index}]")
                steps = [f"[rb{layer_index}][rv{layer_index}]overlay=0:0:format=auto", "format=rgba"]
            if cursor is not None:
                color = _cursor_color(layer)
                chains.append(",".join(steps) + f"[rt{layer_index}]")
                chains.append(f"color=c={color}:s={cursor.width}x{cursor.height}:r={fps},format=rgba[rc{layer_index}]")
                steps = [
                    f"[rt{layer_index}][rc{layer_index}]overlay=x='{with_time(cursor.x, 't', t_start)}'"
                    f":y='{with_time(cursor.y, 't', t_start)}':enable='{with_time(cursor.enable, 't', t_start)}'"
                    ":shortest=1:format=auto",
                    "format=rgba",
                ]
        frame = box  # the rectangle the layer's frame occupies before rotation
        if anim.scale:
            # Scale around the centre inside a fixed, padded frame: filter links cannot change
            # size per frame, so perspective moves the corners instead of resizing.
            headroom = scale_headroom(layer.animation, window_len)
            pw = 2 * math.ceil(w * headroom / 2)
            ph = 2 * math.ceil(h * headroom / 2)
            steps.append(f"pad={pw}:{ph}:{(pw - w) // 2}:{(ph - h) // 2}:color=0x00000000")
            # perspective's frame counter `in` starts at 1, and it has no time variable
            s = with_time(anim.scale, f"(in-1)/{fps}", t_start)
            corners = {
                "x0": f"W/2-W/2*({s})", "y0": f"H/2-H/2*({s})",
                "x1": f"W/2+W/2*({s})", "y1": f"H/2-H/2*({s})",
                "x2": f"W/2-W/2*({s})", "y2": f"H/2+H/2*({s})",
                "x3": f"W/2+W/2*({s})", "y3": f"H/2+H/2*({s})",
            }  # fmt: skip
            steps.append(
                "perspective=" + ":".join(f"{k}='{v}'" for k, v in corners.items()) + ":sense=destination:eval=frame"
            )
            frame = Box(box.x + (w - pw) / 2, box.y + (h - ph) / 2, pw, ph)
            x, y = round(frame.x), round(frame.y)
        rotate = float(geo["rotate"]) % 360
        if rotate != 0:
            rad = math.radians(rotate)
            r = f"{rad:.6f}"
            steps.append(f"rotate={r}:c=none:ow='rotw({r})':oh='roth({r})'")
            rx, ry = rotated_overlay_position(frame, rotate)
            x, y = round(rx), round(ry)
        opacity = float(geo["opacity"])
        if anim.opacity:
            fade = with_time(anim.opacity, "T", t_start)
            gain = fade if opacity >= 1 else f"{_fmt(opacity)}*{fade}"
            # The gain only depends on time: evaluate it once per row (st / ld) instead of per pixel.
            # Long curves (bounce, elastic) on a padded, rotated frame are otherwise ~15× slower.
            steps.append(f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*if(eq(X,0),st(0,{gain}),ld(0))'")
        elif opacity < 1:
            steps.append(f"colorchannelmixer=aa={_fmt(opacity)}")
        if image.is_video:
            # Start the sticker at its own frame 0 when the window opens, instead of
            # letting it run (and finish) behind the enable= gate.
            steps.append(
                "setpts=PTS-STARTPTS"
                if t_start <= 0
                else f"setpts=PTS-STARTPTS+{_fmt(t_start)}/TB"
            )
            # Bounds the looped input and any sticker longer than the main stream.
            steps.append(f"trim=end={_fmt(t_end)}")
        chains.append(",".join(steps) + lbl)

        eof_action = "pass" if (image.is_video and playback == "once") else "repeat"
        ox = f"'{x}+{H}*({with_time(anim.dx, 't', t_start)})'" if anim.dx else str(x)
        oy = f"'{y}+{H}*({with_time(anim.dy, 't', t_start)})'" if anim.dy else str(y)
        overlay = f"{current}{lbl}overlay={ox}:{oy}:eof_action={eof_action}"
        if layer.t != "all":
            overlay += f":enable='between(t,{_fmt(t_start)},{_fmt(t_end)})'"
        out = f"[c{layer_index}]"
        chains.append(overlay + out)
        current = out

        if image.is_video and image.has_audio and getattr(layer, "mix_audio", False):
            window = t_end - t_start
            if window > MIN_SEGMENT:
                # Same timing as the picture: from the sticker's own 0 s at the window
                # start, cut at the window end (the looped input repeats the audio too).
                steps = [f"[{input_index}:a]asetpts=PTS-STARTPTS", f"atrim=end={_fmt(window)}"]
                delay_ms = round(t_start * 1000)
                if delay_ms > 0:
                    steps.append(f"adelay={delay_ms}:all=1")
                steps.append(AUDIO_FORMAT)
                label = f"[sa{len(sticker_audio) + 1}]"
                chains.append(",".join(steps) + label)
                sticker_audio.append(label)

    # ---- 4. final format ----------------------------------------------------
    if spec.cover is not None and cover is None:
        warnings.append(f"封面素材 {spec.cover.asset_id} 不存在或未就绪，已跳过封面")
    elif cover is not None and cover.duration <= MIN_SEGMENT:
        warnings.append("封面素材时长为 0，已跳过封面")
        cover = None
    main_duration = expected_duration
    if cover is None:
        chains.append(f"{current}format=yuv420p[vout]")
    else:
        # Concat needs identical size and SAR on both parts; trim holds the main part to
        # its planned length so a long sticker cannot push the cover's successor around.
        chains.append(
            f"{current}format=yuv420p,setsar=1,trim=end={_fmt(main_duration)}[vmain]"
        )

    # ---- 5. audio tracks (contract §2 audio.tracks) ----------------------------
    track_audio: list[str] = []
    mixed_tracks: list[dict[str, Any]] = []
    skipped_tracks: list[str] = []
    for track in audio_spec.tracks if audio_spec is not None else []:
        if track.hidden:
            continue  # eye off: deliberately left out, so not a warning / skipped entry
        source = (audio_assets or {}).get(track.asset_id)
        if source is None:
            warnings.append(f"音轨 {track.id}：音频素材 {track.asset_id} 不存在或未就绪，已跳过")
            skipped_tracks.append(track.id)
            continue
        if track.t == "all":
            t_start, t_end = 0.0, expected_duration
        else:
            t_start, t_end = float(track.t[0]), min(float(track.t[1]), expected_duration)
        window = t_end - t_start
        if window <= MIN_SEGMENT:
            warnings.append(f"音轨 {track.id}：出声时段起点超出剪后时长，已跳过")
            skipped_tracks.append(track.id)
            continue
        aligned = getattr(track, "align", "post") == "source"
        available = float(source.duration) - float(track.offset)
        if available <= MIN_SEGMENT:
            warnings.append(f"音轨 {track.id}：起始偏移不小于素材时长，已跳过")
            skipped_tracks.append(track.id)
            continue

        n_track = len(track_audio) + 1
        steps: list[str] = []
        if aligned:
            # On the source timeline (a separated stem, a re-recorded voice-over): cut it
            # exactly like the source audio, then take the window off the post-trim result.
            input_index = len(inputs)
            inputs.append(["-i", source.path])
            head = f"[{input_index}:a]"
            if sequence_sources:
                # A source-aligned stem belongs to the edited (owner) video's raw frames.
                # Inserted clips have no matching stem; keep silence there while retaining
                # each original span at its new position on the composed timeline.
                pieces: list[str] = []
                position = 0.0
                for k, segment in enumerate(sequence_sources):
                    c = segment.clip
                    position -= c.transition.duration if c.transition else 0.0
                    length = c.source_out - c.source_in
                    if c.video_id == video_meta.get("video_id"):
                        label = f"[tk{n_track}s{k}]"
                        delay = round(position * 1000)
                        chains.append(
                            f"{head}atrim=start={_fmt(c.source_in)}:end={_fmt(c.source_out)},"
                            f"asetpts=PTS-STARTPTS,{AUDIO_FORMAT},adelay={delay}:all=1{label}"
                        )
                        pieces.append(label)
                    position += length
                joined = f"[tk{n_track}c]"
                if pieces:
                    chains.append(
                        f"anullsrc=r=48000:cl=stereo,atrim=end={_fmt(duration)}[tk{n_track}bed]"
                    )
                    chains.append(
                        f"[tk{n_track}bed]{''.join(pieces)}amix=inputs={len(pieces) + 1}:"
                        f"duration=first:normalize=0:dropout_transition=0{joined}"
                    )
                else:
                    chains.append(f"anullsrc=r=48000:cl=stereo,atrim=end={_fmt(duration)}{joined}")
                head = joined
                if spec.trim.remove:
                    head = cut_composed(chains, head, source_segments, f'tk{n_track}cut', audio=True)
            elif trimmed:
                seg_labels: list[str] = []
                for k, (a, b) in enumerate(source_segments):
                    seg = f"[tk{n_track}s{k}]"
                    chains.append(
                        f"{head}atrim=start={_fmt(a)}:end={_fmt(b)},asetpts=PTS-STARTPTS{seg}"
                    )
                    seg_labels.append(seg)
                if len(seg_labels) > 1:
                    head = f"[tk{n_track}c]"
                    chains.append(f"{''.join(seg_labels)}concat=n={len(seg_labels)}:v=0:a=1{head}")
                else:
                    head = seg_labels[0]
            if t_start > 0:
                steps.append(f"atrim=start={_fmt(t_start)}:end={_fmt(t_end)}")
                steps.append("asetpts=PTS-STARTPTS")
            else:
                steps.append(f"atrim=end={_fmt(window)}")
            effective = window
        else:
            # Bounded by atrim=end below, like looped video stickers (and by -t at the end).
            options = ["-stream_loop", "-1"] if track.loop else []
            input_index = len(inputs)
            inputs.append([*options, "-i", source.path])
            head = f"[{input_index}:a]"
            if track.offset > 0:
                steps.append(f"atrim=start={_fmt(track.offset)}")
            steps += ["asetpts=PTS-STARTPTS", f"atrim=end={_fmt(window)}"]
            # Fades run against the audible span: a non-looping file shorter than the
            # window ends early, and the fade-out must land where the sound actually stops.
            effective = window if track.loop else min(window, available)
        if track.volume != 1:
            steps.append(f"volume={_fmt(track.volume)}")
        fade_in = min(float(track.fade_in), effective)
        fade_out = min(float(track.fade_out), effective)
        if fade_in > 0:
            steps.append(f"afade=t=in:st=0:d={_fmt(fade_in)}")
        if fade_out > 0:
            steps.append(f"afade=t=out:st={_fmt(effective - fade_out)}:d={_fmt(fade_out)}")
        delay_ms = round(t_start * 1000)
        if delay_ms > 0:
            steps.append(f"adelay={delay_ms}:all=1")
        steps.append(AUDIO_FORMAT)
        label = f"[tk{n_track}]"
        chains.append(head + ",".join(steps) + label)
        track_audio.append(label)
        mixed_tracks.append(
            {"id": track.id, "asset_id": track.asset_id, "name": source.name, "role": track.role}
        )

    # ---- 6. audio mix -----------------------------------------------------------
    # Only when the spec asks for something beyond the plain source track; otherwise
    # the argv stays exactly what it was before any audio feature existed.
    overlays = sticker_audio + track_audio
    # source_mute spans (post-trim time) that actually fall inside the output.
    mutes = [
        (float(a), min(float(b), expected_duration))
        for a, b in (audio_spec.source_mute if audio_spec is not None else [])
        if a < expected_duration
    ]
    mutes = [(a, b) for a, b in mutes if b - a > MIN_SEGMENT] if source_heard else []
    graph_audio = bool(overlays) or source_volume != 1 or bool(mutes) or bool(sequence_sources)
    audio_map: list[str]
    if graph_audio:
        if source_heard:
            base = f"{audio_label or '[0:a:0]'}{AUDIO_FORMAT}"
            if source_volume != 1:
                base += f",volume={_fmt(source_volume)}"
            if mutes:
                # between(t,…) reads the frame time, so the main track must start at 0.
                base += ",asetpts=PTS-STARTPTS" + "".join(
                    f",volume=0:enable='between(t,{_fmt(a)},{_fmt(b)})'" for a, b in mutes
                )
            chains.append(base + "[abase]")
        elif overlays:
            # Silent bed so amix (duration=first) still spans the whole output.
            chains.append(
                f"anullsrc=r=48000:cl=stereo,atrim=end={_fmt(expected_duration)}[abase]"
            )
        if overlays:
            chains.append(
                f"[abase]{''.join(overlays)}amix=inputs={len(overlays) + 1}"
                ":duration=first:normalize=0:dropout_transition=0[aout]"
            )
            audio_map = ["-map", "[aout]"]
        elif source_heard:
            audio_map = ["-map", "[abase]"]  # only the source gain / mutes changed: no amix
        else:
            audio_map = ["-an"]  # muted source, nothing mixed in
    elif has_audio:
        audio_map = ["-map", audio_label if audio_label else "0:a:0"]
    else:
        audio_map = ["-an"]

    # ---- 7. cover (contract §2 cover): [cover][main] concat ----------------------------
    video_map = "[vout]"
    if cover is not None:
        n = cover.duration
        fps = _fmt(float(video_meta.get("fps") or DEFAULT_FPS))
        # Main audio as one labelled stream of exactly the main length, whatever shape the
        # mapping above took (a filter label, the raw source stream, or no audio at all).
        if audio_map == ["-an"]:
            chains.append(f"anullsrc=r=48000:cl=stereo,atrim=end={_fmt(main_duration)}[amain]")
        else:
            src = audio_map[1] if audio_map[1].startswith("[") else f"[{audio_map[1]}]"
            chains.append(f"{src}{AUDIO_FORMAT},apad,atrim=end={_fmt(main_duration)}[amain]")

        media = cover.media
        input_index = len(inputs)
        if media.is_video:
            options = ["-c:v", media.decoder] if media.decoder else []
            inputs.append([*options, "-i", media.path])
        else:
            inputs.append(["-loop", "1", "-framerate", fps, "-t", _fmt(n), "-i", media.path])
        # The source crop window describes the source frame, so the cover never gets it.
        chains += fill_chains(
            f"[{input_index}:v]", variant.fill, variant.color, None, W, H, "[cvf]", tag="_cv",
            blur=variant.blur, brightness=variant.bg_brightness,
        )
        chains.append(
            f"[cvf]fps={fps},setsar=1,format=yuv420p,trim=end={_fmt(n)},setpts=PTS-STARTPTS[cv]"
        )
        if media.is_video and media.has_audio:
            chains.append(
                f"[{input_index}:a]asetpts=PTS-STARTPTS,{AUDIO_FORMAT},apad,atrim=end={_fmt(n)}[ca]"
            )
        else:
            chains.append(f"anullsrc=r=48000:cl=stereo,atrim=end={_fmt(n)}[ca]")
        chains.append("[cv][ca][vmain][amain]concat=n=2:v=1:a=1[vfinal][afinal]")
        video_map = "[vfinal]"
        audio_map = ["-map", "[afinal]"]
        expected_duration = n + main_duration
    filter_complex = ";".join(chains)

    # ---- argv ---------------------------------------------------------------
    argv: list[str] = [ffmpeg_bin, "-hide_banner", "-y", "-nostats"]
    for group in inputs:
        argv += group
    argv += ["-filter_complex", filter_complex, "-map", video_map]
    # An explicit -map disables automatic stream selection, so sticker / track audio
    # is only ever heard through the [aout] mix above.
    argv += audio_map
    argv += encode_args(getattr(variant, "quality", "standard"))
    if has_video_layer or track_audio or spec.trim.duration is not None or sequence_sources:
        # Belt and braces: overlay takes the longest input, so a sticker (or a looped
        # audio track) could otherwise stretch the output. Only added when such an
        # input exists, so still-image renders keep their exact argv. A trim.duration
        # always gets it: a looped source has no end of its own, and a shorter target
        # is cut here.
        argv += ["-t", _fmt(expected_duration)]
    argv += ["-progress", "pipe:1", output_path]

    return RenderPlan(
        argv=argv,
        expected_duration=expected_duration,
        canvas=(W, H),
        warnings=warnings,
        filter_complex=filter_complex,
        audio=None
        if audio_spec is None
        else {
            "source_volume": source_volume if has_audio else 0.0,
            "source_mute": len(mutes),
            "tracks": mixed_tracks,
            "skipped": skipped_tracks,
        },
    )


def _resolve_text_background(
    layer: TextLayer,
    resolve_image_url: Callable[[str], ImageSource | None] | None,
    variant_key: str | None,
) -> ImageSource | None:
    """The background-block-only PNG of a revealing text layer (HIG-45); None = no background."""
    if resolve_image_url is None:
        return None
    variant_image = (layer.variant_images or {}).get(variant_key) if variant_key else None
    for url in (variant_image.background_url if variant_image else None, layer.background_image):
        if url:
            found = resolve_image_url(url)
            if found is not None:
                return found
    return None


def _cursor_color(layer: TextLayer) -> str:
    color = (layer.style.color if layer.style else None) or "#FFFFFF"
    return "0x" + color[1:7] if color.startswith("#") and len(color) >= 7 else "0xFFFFFF"


def _resolve_layer_image(
    layer: StickerLayer | TextLayer,
    assets: Mapping[str, ImageSource],
    resolve_image_url: Callable[[str], ImageSource | None] | None,
    warnings: list[str],
    variant_key: str | None = None,
) -> ImageSource | None:
    if isinstance(layer, StickerLayer):
        image = assets.get(layer.asset_id)
        if image is None:
            warnings.append(f"图层 {layer.id}：贴纸素材 {layer.asset_id} 不存在，已跳过")
        return image

    # text layer: the worker only consumes the pre-rendered PNG. A PNG re-rendered for this output
    # (variant_images, HIG-29) wins; if it cannot be found, quietly use the base one.
    variant_image = (layer.variant_images or {}).get(variant_key) if variant_key else None
    if variant_image is not None and resolve_image_url is not None:
        found = resolve_image_url(variant_image.url)
        if found is not None:
            return ImageSource(found.path, variant_image.size[0], variant_image.size[1])
    if not layer.image_url:
        warnings.append(f"图层 {layer.id}：文字图层没有 image_url，已跳过")
        return None
    image = resolve_image_url(layer.image_url) if resolve_image_url else None
    if image is None:
        warnings.append(f"图层 {layer.id}：文字 PNG {layer.image_url} 不存在，已跳过")
        return None
    if layer.image_size:
        # Prefer the size the frontend declared; it is what the layout was designed on.
        image = ImageSource(image.path, layer.image_size[0], layer.image_size[1])
    return image

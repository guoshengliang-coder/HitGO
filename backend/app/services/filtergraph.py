"""Build the ffmpeg command for one render job (contract §6, "渲染").

Pure: no filesystem or database access. The caller resolves sticker assets and
text-layer PNGs into ``ImageSource`` objects; layers whose image cannot be
resolved are skipped and reported in ``RenderPlan.warnings``.

Filter graph order:
    source → trim/atrim + concat (skipped when nothing is removed)
           → canvas fill (blur | color | crop; crop honours an optional source window first)
           → one overlay per layer (enable='between(t,a,b)' for timed layers)
           → format=yuv420p
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from app.schemas import CANVAS_SIZES, EditSpec, OutputVariant, StickerLayer, TextLayer
from app.services.layout import layer_box, rotated_overlay_position

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

BLUR_RADIUS = "20:2"
MIN_SEGMENT = 0.01  # seconds; shorter keep-segments are dropped


@dataclass(frozen=True)
class ImageSource:
    path: str
    width: int
    height: int


@dataclass
class RenderPlan:
    argv: list[str]
    expected_duration: float
    canvas: tuple[int, int]
    warnings: list[str] = field(default_factory=list)
    filter_complex: str = ""


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


def apply_overrides(layer: StickerLayer | TextLayer, variant: OutputVariant) -> dict[str, Any]:
    """Effective geometry for a layer inside a variant (layer_overrides applied)."""
    geo = {
        "anchor": layer.anchor,
        "margin": tuple(layer.margin),
        "width": layer.width,
        "rotate": layer.rotate,
        "opacity": layer.opacity,
    }
    override = variant.layer_overrides.get(layer.id)
    if override is not None:
        for key, value in override.as_dict().items():
            geo[key] = tuple(value) if key == "margin" else value
    return geo


# ---------------------------------------------------------------------------
# main builder
# ---------------------------------------------------------------------------


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
) -> RenderPlan:
    """Return the ffmpeg argv, expected output duration and any layer warnings.

    video_meta needs: duration (s), has_audio (bool). width/height are not required
    because ffmpeg scales relative to the actual decoded frame.
    """
    duration = float(video_meta["duration"])
    has_audio = bool(video_meta.get("has_audio", False))
    canvas_w, canvas_h = CANVAS_SIZES[variant.aspect]

    warnings: list[str] = []
    inputs: list[str] = [source_path]
    chains: list[str] = []

    # ---- 1. trim / concat ---------------------------------------------------
    segments = keep_segments(spec.trim.remove, duration)
    if not segments:
        raise ValueError("剪辑后没有保留任何片段")
    expected_duration = sum(b - a for a, b in segments)
    trimmed = bool(spec.trim.remove) and segments != [(0.0, duration)]

    if trimmed:
        labels: list[str] = []
        for i, (a, b) in enumerate(segments):
            chains.append(f"[0:v]trim=start={_fmt(a)}:end={_fmt(b)},setpts=PTS-STARTPTS[v{i}]")
            labels.append(f"[v{i}]")
            if has_audio:
                chains.append(
                    f"[0:a]atrim=start={_fmt(a)}:end={_fmt(b)},asetpts=PTS-STARTPTS[a{i}]"
                )
                labels.append(f"[a{i}]")
        if len(segments) == 1:
            video_label, audio_label = "[v0]", "[a0]" if has_audio else None
        else:
            n = len(segments)
            if has_audio:
                chains.append(f"{''.join(labels)}concat=n={n}:v=1:a=1[vt][at]")
                video_label, audio_label = "[vt]", "[at]"
            else:
                chains.append(f"{''.join(labels)}concat=n={n}:v=1:a=0[vt]")
                video_label, audio_label = "[vt]", None
    else:
        video_label, audio_label = "[0:v]", None  # audio mapped straight from input

    # ---- 2. canvas fill -----------------------------------------------------
    W, H = canvas_w, canvas_h
    if variant.fill == "blur":
        chains.append(f"{video_label}split=2[bg][fg]")
        chains.append(
            f"[bg]scale={W}:{H}:force_original_aspect_ratio=increase,"
            f"crop={W}:{H},boxblur={BLUR_RADIUS}[bgb]"
        )
        chains.append(f"[fg]scale={W}:{H}:force_original_aspect_ratio=decrease[fgs]")
        chains.append(f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2[c0]")
    elif variant.fill == "color":
        chains.append(
            f"{video_label}scale={W}:{H}:force_original_aspect_ratio=decrease,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={ffmpeg_color(variant.color)}[c0]"
        )
    else:  # crop
        if variant.crop is not None:
            # Explicit source window first (relative to the decoded frame), then the same cover
            # chain so a window whose ratio differs from the canvas is centre-cropped, not stretched.
            r = variant.crop
            chains.append(
                f"{video_label}crop=w='iw*{_fmt(r.w)}':h='ih*{_fmt(r.h)}'"
                f":x='iw*{_fmt(r.x)}':y='ih*{_fmt(r.y)}'[cs]"
            )
            video_label = "[cs]"
        chains.append(
            f"{video_label}scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}[c0]"
        )
    current = "[c0]"

    # ---- 3. layers ----------------------------------------------------------
    layer_index = 0
    for layer in spec.layers:
        image = _resolve_layer_image(layer, assets, resolve_image_url, warnings)
        if image is None:
            continue
        geo = apply_overrides(layer, variant)
        box = layer_box(
            geo["anchor"], geo["margin"], geo["width"], W, H, image.width, image.height
        )
        x, y, w, h = box.rounded()
        w, h = max(1, w), max(1, h)

        input_index = len(inputs)
        inputs.append(image.path)
        layer_index += 1
        lbl = f"[l{layer_index}]"

        steps = [f"[{input_index}:v]format=rgba", f"scale={w}:{h}"]
        rotate = float(geo["rotate"]) % 360
        if rotate != 0:
            rad = math.radians(rotate)
            r = f"{rad:.6f}"
            steps.append(f"rotate={r}:c=none:ow='rotw({r})':oh='roth({r})'")
            rx, ry = rotated_overlay_position(box, rotate)
            x, y = round(rx), round(ry)
        opacity = float(geo["opacity"])
        if opacity < 1:
            steps.append(f"colorchannelmixer=aa={_fmt(opacity)}")
        chains.append(",".join(steps) + lbl)

        overlay = f"{current}{lbl}overlay={x}:{y}:eof_action=repeat"
        if layer.t != "all":
            a, b = layer.t
            overlay += f":enable='between(t,{_fmt(a)},{_fmt(b)})'"
        out = f"[c{layer_index}]"
        chains.append(overlay + out)
        current = out

    # ---- 4. final format ----------------------------------------------------
    chains.append(f"{current}format=yuv420p[vout]")
    filter_complex = ";".join(chains)

    # ---- argv ---------------------------------------------------------------
    argv: list[str] = [ffmpeg_bin, "-hide_banner", "-y", "-nostats"]
    for path in inputs:
        argv += ["-i", path]
    argv += ["-filter_complex", filter_complex, "-map", "[vout]"]
    if has_audio:
        argv += ["-map", audio_label if audio_label else "0:a:0"]
    else:
        argv += ["-an"]
    argv += encode_args(getattr(variant, "quality", "standard"))
    argv += ["-progress", "pipe:1", output_path]

    return RenderPlan(
        argv=argv,
        expected_duration=expected_duration,
        canvas=(W, H),
        warnings=warnings,
        filter_complex=filter_complex,
    )


def _resolve_layer_image(
    layer: StickerLayer | TextLayer,
    assets: Mapping[str, ImageSource],
    resolve_image_url: Callable[[str], ImageSource | None] | None,
    warnings: list[str],
) -> ImageSource | None:
    if isinstance(layer, StickerLayer):
        image = assets.get(layer.asset_id)
        if image is None:
            warnings.append(f"图层 {layer.id}：贴纸素材 {layer.asset_id} 不存在，已跳过")
        return image

    # text layer: the worker only consumes the pre-rendered PNG
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

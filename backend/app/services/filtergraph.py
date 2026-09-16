"""Build the ffmpeg command for one render job (contract §6, "渲染").

Pure: no filesystem or database access. The caller resolves sticker assets and
text-layer PNGs into ``ImageSource`` objects; layers whose image cannot be
resolved are skipped and reported in ``RenderPlan.warnings``.

Filter graph order:
    source → trim/atrim + concat (skipped when nothing is removed)
           → canvas fill (blur | color | crop; crop honours an optional source window first)
           → one overlay per layer (enable='between(t,a,b)' for timed layers)
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

from app.schemas import CANVAS_SIZES, CropRect, EditSpec, OutputVariant, StickerLayer, TextLayer
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


def fill_chains(
    label: str,
    fill: str,
    color: str | None,
    crop: CropRect | None,
    W: int,
    H: int,
    out: str,
    tag: str = "",
) -> list[str]:
    """Lay ``label`` onto the W×H canvas (contract §2 fill), ending in ``out``.

    ``tag`` suffixes the intermediate labels so a second fill (the cover) can live in the same
    graph; the main video uses no tag, which keeps its chains exactly as they always were.
    """
    chains: list[str] = []
    if fill == "blur":
        chains.append(f"{label}split=2[bg{tag}][fg{tag}]")
        chains.append(
            f"[bg{tag}]scale={W}:{H}:force_original_aspect_ratio=increase,"
            f"crop={W}:{H},boxblur={BLUR_RADIUS}[bgb{tag}]"
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
    audio_assets: Mapping[str, AudioSource] | None = None,
    cover: CoverSource | None = None,
) -> RenderPlan:
    """Return the ffmpeg argv, expected output duration and any layer warnings.

    video_meta needs: duration (s), has_audio (bool); fps is optional and only used to
    pace a cover. width/height are not required because ffmpeg scales relative to the
    actual decoded frame. ``audio_assets`` maps the ``audio.tracks[].asset_id`` values
    the caller could resolve; unresolved tracks are skipped with a warning. ``cover`` is
    the resolved ``spec.cover`` asset; when the spec has a cover the caller could not
    resolve, the render goes on without it and says so in the warnings.
    """
    duration = float(video_meta["duration"])
    has_audio = bool(video_meta.get("has_audio", False))
    canvas_w, canvas_h = CANVAS_SIZES[variant.aspect]
    audio_spec = spec.audio
    source_volume = float(audio_spec.source_volume) if audio_spec is not None else 1.0
    # A muted source (audio.source_volume = 0) must not be decoded into the trim/concat
    # graph at all: a concat output nobody consumes makes ffmpeg reject the whole graph
    # ("Filter 'concat' has output 0 (at) unconnected").
    source_heard = has_audio and source_volume > 0

    warnings: list[str] = []
    # One argv group per input: video stickers need per-input options (-stream_loop, -c:v).
    inputs: list[list[str]] = [["-i", source_path]]
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
    chains += fill_chains(video_label, variant.fill, variant.color, variant.crop, W, H, "[c0]")
    current = "[c0]"

    # ---- 3. layers ----------------------------------------------------------
    layer_index = 0
    has_video_layer = False
    sticker_audio: list[str] = []  # labels of sticker audio chains to mix in
    for layer in spec.layers:
        image = _resolve_layer_image(layer, assets, resolve_image_url, warnings)
        if image is None:
            continue

        # Visible window on the post-trim timeline; "all" spans the whole output.
        if layer.t == "all":
            t_start, t_end = 0.0, expected_duration
        else:
            t_start, t_end = float(layer.t[0]), min(float(layer.t[1]), expected_duration)
        if image.is_video and t_start >= expected_duration:
            warnings.append(f"图层 {layer.id}：出现时段起点超出剪后时长，已跳过")
            continue

        geo = apply_overrides(layer, variant)
        box = layer_box(
            geo["anchor"], geo["margin"], geo["width"], W, H, image.width, image.height
        )
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

        input_index = len(inputs)
        inputs.append([*options, "-i", image.path])
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
        overlay = f"{current}{lbl}overlay={x}:{y}:eof_action={eof_action}"
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
    for track in audio_spec.tracks if audio_spec is not None else []:
        source = (audio_assets or {}).get(track.asset_id)
        if source is None:
            warnings.append(f"音轨 {track.id}：音频素材 {track.asset_id} 不存在或未就绪，已跳过")
            continue
        if track.t == "all":
            t_start, t_end = 0.0, expected_duration
        else:
            t_start, t_end = float(track.t[0]), min(float(track.t[1]), expected_duration)
        window = t_end - t_start
        if window <= MIN_SEGMENT:
            warnings.append(f"音轨 {track.id}：出声时段起点超出剪后时长，已跳过")
            continue
        aligned = getattr(track, "align", "post") == "source"
        available = float(source.duration) - float(track.offset)
        if available <= MIN_SEGMENT:
            warnings.append(f"音轨 {track.id}：起始偏移不小于素材时长，已跳过")
            continue

        n_track = len(track_audio) + 1
        steps: list[str] = []
        if aligned:
            # On the source timeline (a separated stem, a re-recorded voice-over): cut it
            # exactly like the source audio, then take the window off the post-trim result.
            input_index = len(inputs)
            inputs.append(["-i", source.path])
            head = f"[{input_index}:a]"
            if trimmed:
                seg_labels: list[str] = []
                for k, (a, b) in enumerate(segments):
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

    # ---- 6. audio mix -----------------------------------------------------------
    # Only when the spec asks for something beyond the plain source track; otherwise
    # the argv stays exactly what it was before any audio feature existed.
    overlays = sticker_audio + track_audio
    graph_audio = bool(overlays) or source_volume != 1
    audio_map: list[str]
    if graph_audio:
        if source_heard:
            base = f"{audio_label or '[0:a:0]'}{AUDIO_FORMAT}"
            if source_volume != 1:
                base += f",volume={_fmt(source_volume)}"
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
            audio_map = ["-map", "[abase]"]  # only the source gain changed: no amix
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
            f"[{input_index}:v]", variant.fill, variant.color, None, W, H, "[cvf]", tag="_cv"
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
    if has_video_layer or track_audio:
        # Belt and braces: overlay takes the longest input, so a sticker (or a looped
        # audio track) could otherwise stretch the output. Only added when such an
        # input exists, so still-image renders keep their exact argv.
        argv += ["-t", _fmt(expected_duration)]
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

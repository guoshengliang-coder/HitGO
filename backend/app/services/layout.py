"""Layer geometry: anchor / margin / width → pixel box on a canvas (contract §2 formulas).

Pure functions, shared by the render filtergraph and unit-tested directly.
Formulas (canvas W×H, layer width w = width·W, height h from the image aspect — or, for
mask layers, h = height·H):

    x: left   → margin.x·W          y: top    → margin.y·H
       center → (W−w)/2 + margin.x·W   center → (H−h)/2 + margin.y·H
       right  → W − w − margin.x·W     bottom → H − h − margin.y·H
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    def rounded(self) -> tuple[int, int, int, int]:
        return round(self.x), round(self.y), round(self.w), round(self.h)


def split_anchor(anchor: str) -> tuple[str, str]:
    """'bottom-right' → ('bottom', 'right'); 'center' → ('center', 'center')."""
    if anchor == "center":
        return "center", "center"
    v, h = anchor.split("-", 1)
    return v, h


def layer_box(
    anchor: str,
    margin: tuple[float, float],
    width: float,
    canvas_w: int,
    canvas_h: int,
    image_w: int,
    image_h: int,
) -> Box:
    """Un-rotated layer rectangle in canvas pixels (floats; callers round)."""
    if image_w <= 0 or image_h <= 0:
        raise ValueError("image size must be positive")
    w = width * canvas_w
    h = w * image_h / image_w
    return _place(anchor, margin, w, h, canvas_w, canvas_h)


def mask_box(
    anchor: str,
    margin: tuple[float, float],
    width: float,
    height: float,
    canvas_w: int,
    canvas_h: int,
) -> Box:
    """Mask layer rectangle: no media aspect, ``height`` is relative to the canvas height."""
    return _place(anchor, margin, width * canvas_w, height * canvas_h, canvas_w, canvas_h)


def _place(
    anchor: str, margin: tuple[float, float], w: float, h: float, canvas_w: int, canvas_h: int
) -> Box:
    """Anchor + margin arithmetic shared by every layer kind (contract §2 formulas)."""
    mx, my = margin
    v, hz = split_anchor(anchor)

    if hz == "left":
        x = mx * canvas_w
    elif hz == "center":
        x = (canvas_w - w) / 2 + mx * canvas_w
    elif hz == "right":
        x = canvas_w - w - mx * canvas_w
    else:  # pragma: no cover
        raise ValueError(f"unknown horizontal anchor: {hz}")

    if v == "top":
        y = my * canvas_h
    elif v == "center":
        y = (canvas_h - h) / 2 + my * canvas_h
    elif v == "bottom":
        y = canvas_h - h - my * canvas_h
    else:  # pragma: no cover
        raise ValueError(f"unknown vertical anchor: {v}")

    return Box(x, y, w, h)


def rotated_size(w: float, h: float, degrees: float) -> tuple[float, float]:
    """Bounding box of a w×h rectangle rotated by `degrees` (same as ffmpeg rotw/roth)."""
    rad = math.radians(degrees)
    c, s = abs(math.cos(rad)), abs(math.sin(rad))
    return w * c + h * s, w * s + h * c


def rotated_overlay_position(box: Box, degrees: float) -> tuple[float, float]:
    """Top-left of the rotated image's bounding box so the rotation stays centered on `box`."""
    rw, rh = rotated_size(box.w, box.h, degrees)
    return box.cx - rw / 2, box.cy - rh / 2


# ---------------------------------------------------------------------------
# layer_fit = "video": layers follow the video frame across aspect ratios (HIG-29)
# ---------------------------------------------------------------------------
#
# Layers are designed on the 9x16 reference canvas. For another output the source frame lands
# somewhere else (contain for blur / color, cover of the crop window for crop), so we map
# reference-canvas pixels → source pixels → target-canvas pixels. That map is a uniform scale
# ``k`` plus an offset: p_v = offset + p_ref · k.


def frame_region(
    fill: str, crop: Any, src_w: float, src_h: float, W: float, H: float
) -> tuple[Box, Box]:
    """(source rect S, canvas rect D) of the video frame on a W×H canvas — same geometry as
    ``filtergraph.fill_chains`` (contain for blur / color; crop window then cover for crop).
    ``crop`` is anything with x / y / w / h in 0–1 of the source, or None."""
    if fill == "crop":
        if crop is not None:
            sx, sy = crop.x * src_w, crop.y * src_h
            sw, sh = max(1.0, crop.w * src_w), max(1.0, crop.h * src_h)
        else:
            sx, sy, sw, sh = 0.0, 0.0, float(src_w), float(src_h)
        scale = max(W / sw, H / sh)
    else:
        sx, sy, sw, sh = 0.0, 0.0, float(src_w), float(src_h)
        scale = min(W / sw, H / sh)
    w, h = sw * scale, sh * scale
    return Box(sx, sy, sw, sh), Box((W - w) / 2, (H - h) / 2, w, h)


@dataclass(frozen=True)
class FitMap:
    """Reference canvas → target canvas: p_target = (ox, oy) + p_ref · k."""

    k: float
    ox: float
    oy: float
    ref_w: float
    ref_h: float
    W: float
    H: float

    def point(self, x: float, y: float) -> tuple[float, float]:
        return self.ox + x * self.k, self.oy + y * self.k

    @property
    def visible(self) -> Box:
        """The reference canvas mapped onto the target, clipped to the target canvas."""
        x0, y0 = self.point(0, 0)
        x1, y1 = self.point(self.ref_w, self.ref_h)
        cx0, cy0 = max(0.0, x0), max(0.0, y0)
        cx1, cy1 = min(self.W, x1), min(self.H, y1)
        if cx1 - cx0 <= 0 or cy1 - cy0 <= 0:
            return Box(0.0, 0.0, self.W, self.H)
        return Box(cx0, cy0, cx1 - cx0, cy1 - cy0)


def fit_map(
    ref: tuple[str, Any, int, int],
    target: tuple[str, Any, int, int],
    src_w: float,
    src_h: float,
) -> FitMap:
    """Build the map between two outputs given as (fill, crop, W, H)."""
    s9, d9 = frame_region(ref[0], ref[1], src_w, src_h, ref[2], ref[3])
    sv, dv = frame_region(target[0], target[1], src_w, src_h, target[2], target[3])
    sc9, scv = d9.w / s9.w, dv.w / sv.w
    k = scv / sc9
    ox = dv.x + (s9.x - sv.x) * scv - d9.x * k
    oy = dv.y + (s9.y - sv.y) * scv - d9.y * k
    return FitMap(k, ox, oy, float(ref[2]), float(ref[3]), float(target[2]), float(target[3]))


def follow_mask_box(ref_box: Box, m: FitMap) -> Box:
    """Masks track the burnt-in pixels exactly: map the reference box as a whole."""
    x, y = m.point(ref_box.x, ref_box.y)
    return Box(x, y, ref_box.w * m.k, ref_box.h * m.k)


def follow_layer_box(
    anchor: str,
    margin: tuple[float, float],
    width: float,
    image_w: int,
    image_h: int,
    m: FitMap,
    *,
    clamp: bool = True,
) -> Box:
    """Text / sticker: keep the anchor inside the visible video area, scale by min(k, 1) so a
    cover crop never blows text up, then shift the box back inside the canvas. For blur / color
    (visible area = mapped reference canvas, k ≤ 1) this equals mapping the reference box.

    ``clamp=False`` (text, HIG-37) skips the shift: a box hanging off the frame stays there and
    the overlay crops it, as the editor preview does."""
    if image_w <= 0 or image_h <= 0:
        raise ValueError("image size must be positive")
    s = min(m.k, 1.0)
    w = width * m.ref_w * s
    h = w * image_h / image_w
    v = m.visible
    # margins are relative to the reference canvas; express them on the visible area
    placed = _place(anchor, margin, w, h, v.w, v.h)
    box = Box(v.x + placed.x, v.y + placed.y, w, h)
    return _clamp_into(box, m.W, m.H) if clamp else box


def _clamp_into(b: Box, W: float, H: float) -> Box:
    x = min(max(b.x, 0.0), W - b.w) if b.w <= W else 0.0
    y = min(max(b.y, 0.0), H - b.h) if b.h <= H else 0.0
    return Box(x, y, b.w, b.h)

"""Layer geometry: anchor / margin / width → pixel box on a canvas (contract §2 formulas).

Pure functions, shared by the render filtergraph and unit-tested directly.
Formulas (canvas W×H, layer width w = width·W, height h from the image aspect):

    x: left   → margin.x·W          y: top    → margin.y·H
       center → (W−w)/2 + margin.x·W   center → (H−h)/2 + margin.y·H
       right  → W − w − margin.x·W     bottom → H − h − margin.y·H
"""

from __future__ import annotations

import math
from dataclasses import dataclass


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

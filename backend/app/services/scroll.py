"""Scrolling text geometry (HIG-50 大字报, contract §2 ``layers[type=text].scroll``).

Everything here is in fractions of the canvas height, so the same numbers describe the
render on any output and the editor preview; :mod:`filtergraph` multiplies by the canvas
height when it writes the ffmpeg ``crop`` expression. The frontend re-implements the same
curve in ``lib/poster.ts``; both are held to ``frontend/src/lib/fixtures/scrollCases.json``.

The PNG (height ``h``) sits inside a taller transparent image with ``bh`` (the clip box
height) of padding above and below it. A window of height ``bh`` slides down that image:
its top edge ``y`` runs from ``y0`` to ``y1``, which is what the viewer sees as the copy
moving up through the box.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas import TextScroll


@dataclass(frozen=True)
class ScrollPath:
    """Where the clip window starts and stops, in fractions of the canvas height."""

    y0: float
    y1: float
    speed: float  # canvas heights per second
    hold_start: float
    hold_end: float

    @property
    def travel(self) -> float:
        return max(0.0, self.y1 - self.y0)

    @property
    def duration(self) -> float:
        """Whole run: leading hold + travel + trailing hold, seconds."""
        return self.hold_start + self.travel / self.speed + self.hold_end


def scroll_path(scroll: TextScroll, png_h: float) -> ScrollPath:
    """``png_h`` is the PNG height after scaling, as a fraction of the canvas height."""
    bh = scroll.box.h
    y0 = 0.0 if scroll.start == "enter" else bh
    y1 = png_h + bh if scroll.end == "exit" else max(y0, png_h)
    # Holds only mean something when the copy is on screen at that end of the run.
    hold_start = scroll.hold_start if scroll.start == "visible" else 0.0
    hold_end = scroll.hold_end if scroll.end == "stay" else 0.0
    return ScrollPath(y0=y0, y1=y1, speed=scroll.speed, hold_start=hold_start, hold_end=hold_end)


def sample_y(path: ScrollPath, u: float) -> float:
    """Window top at local time ``u`` (seconds since the layer's window opened)."""
    y = path.y0 + (u - path.hold_start) * path.speed
    return min(max(y, path.y0), path.y1)


def _n(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def y_expression(path: ScrollPath, canvas_h: float, variable: str = "t", start: float = 0.0) -> str:
    """ffmpeg expression for the window top in pixels, in the filter's time ``variable``."""
    local = f"({variable}-{_n(start)})" if start > 0 else variable
    if path.hold_start > 0:
        local = f"({local}-{_n(path.hold_start)})"
    y0 = _n(path.y0 * canvas_h)
    y1 = _n(path.y1 * canvas_h)
    return f"clip({y0}+{local}*{_n(path.speed * canvas_h)},{y0},{y1})"

"""Text layer animation curves (HIG-40, contract §2 ``layers[type=text].animation``).

One definition serves both sides of the worker: :func:`expressions` writes the curves as
ffmpeg expressions of a local-time variable ``U`` (seconds since the layer's window opened),
and :func:`sample` evaluates those very strings in Python. The frontend re-implements the
same numbers in ``lib/textAnimation.ts``; both are held to
``frontend/src/lib/fixtures/textAnimationCases.json``.

The expression syntax used here is the common subset of ffmpeg's evaluator and Python:
numbers, ``+ - * /``, parentheses, ``clip / pow / cos / sin / between`` and ``PI``.

A frame of animation is four values:

- ``opacity``: multiplier on the layer's own opacity (0–1);
- ``dx`` / ``dy``: offset of the layer centre as a fraction of the canvas **height**, so the
  same motion looks the same on every output aspect and in the editor preview;
- ``scale``: uniform scale around the layer centre.

Timing, for a window of length ``L``: the enter runs over ``[0, di]`` with ``di = min(in, L)``,
the exit over ``[L − do, L]`` with ``do = min(out, L − di)``, and the loop from ``di`` to ``L``
(under the exit too). Every factor starts at rest, so nothing jumps when a phase begins.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.schemas import TextAnimation

SLIDE = 0.05  # slide distance, fraction of the canvas height
POP_FROM = 0.5  # pop in grows from this scale (with an ease-out-back overshoot); pop out shrinks to it
BACK = 1.70158  # ease-out-back overshoot constant
BREATHE = 0.03  # breathe scales between 1 and 1 + 2·BREATHE
FLOAT = 0.008  # float bobs up and down by this fraction of the canvas height
BLINK = 0.35  # blink dips opacity to 1 − 2·BLINK
# Headroom the scaled layer needs inside its fixed-size frame: pop in overshoots to ~1.05 and
# breathe reaches 1.06; pop in ends before the loop starts, and pop out only shrinks.
SCALE_HEADROOM = 1.1


@dataclass(frozen=True)
class AnimFrame:
    opacity: float = 1.0
    dx: float = 0.0
    dy: float = 0.0
    scale: float = 1.0


@dataclass(frozen=True)
class AnimExpr:
    """ffmpeg expressions in ``U``; None = that channel does not move."""

    opacity: str | None = None
    dx: str | None = None
    dy: str | None = None
    scale: str | None = None


def _n(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def phase_lengths(anim: TextAnimation, window: float) -> tuple[float, float]:
    """(enter, exit) durations actually used inside a window of length ``window``."""
    L = max(0.0, window)
    di = min(anim.enter.duration, L) if anim.enter else 0.0
    do = min(anim.exit.duration, max(0.0, L - di)) if anim.exit else 0.0
    return di, do


def expressions(anim: TextAnimation | None, window: float) -> AnimExpr:
    if anim is None or not anim.active or window <= 0:
        return AnimExpr()
    L = window
    di, do = phase_lengths(anim, L)
    opacity: list[str] = []
    dx: list[str] = []
    dy: list[str] = []
    scale: list[str] = []

    if anim.enter and di > 0:
        p = f"clip(U/{_n(di)},0,1)"
        ease = f"(1-pow(1-{p},3))"  # ease-out cubic
        rest = f"(1-{ease})"
        preset = anim.enter.preset
        if preset == "pop":
            opacity.append(f"clip(3*{p},0,1)")
            back = f"(1+{_n(BACK + 1)}*pow({p}-1,3)+{_n(BACK)}*pow({p}-1,2))"
            scale.append(f"({_n(POP_FROM)}+{_n(1 - POP_FROM)}*{back})")
        else:
            opacity.append(ease)
            if preset == "slide_up":
                dy.append(f"{_n(SLIDE)}*{rest}")
            elif preset == "slide_down":
                dy.append(f"-{_n(SLIDE)}*{rest}")
            elif preset == "slide_left":
                dx.append(f"{_n(SLIDE)}*{rest}")
            elif preset == "slide_right":
                dx.append(f"-{_n(SLIDE)}*{rest}")

    if anim.exit and do > 0:
        q = f"clip((U-{_n(L - do)})/{_n(do)},0,1)"
        ease = f"pow({q},3)"  # ease-in cubic
        preset = anim.exit.preset
        opacity.append(f"(1-{ease})")
        if preset == "pop":
            scale.append(f"(1-{_n(1 - POP_FROM)}*{ease})")
        elif preset == "slide_up":
            dy.append(f"-{_n(SLIDE)}*{ease}")
        elif preset == "slide_down":
            dy.append(f"{_n(SLIDE)}*{ease}")
        elif preset == "slide_left":
            dx.append(f"-{_n(SLIDE)}*{ease}")
        elif preset == "slide_right":
            dx.append(f"{_n(SLIDE)}*{ease}")

    if anim.loop and L - di > 0:
        # From the end of the enter to the end of the window, overlapping the exit: cutting the
        # loop where the exit starts would make blink / float jump back to rest in one frame.
        on = f"between(U,{_n(di)},{_n(L)})"
        wave = f"(2*PI*(U-{_n(di)})/{_n(anim.loop.period)})"
        preset = anim.loop.preset
        if preset == "breathe":
            scale.append(f"(1+{on}*{_n(BREATHE)}*(1-cos({wave})))")
        elif preset == "float":
            dy.append(f"-{on}*{_n(FLOAT)}*sin({wave})")
        elif preset == "blink":
            opacity.append(f"(1-{on}*{_n(BLINK)}*(1-cos({wave})))")

    return AnimExpr(
        opacity="*".join(opacity) or None,
        dx="+".join(dx) or None,
        dy="+".join(dy) or None,
        scale="*".join(scale) or None,
    )


def with_time(expr: str, variable: str, start: float) -> str:
    """Substitute the local time ``U`` with ``(variable − start)`` for one ffmpeg filter."""
    local = f"({variable}-{_n(start)})" if start > 0 else variable
    return expr.replace("U", local)


_NAMESPACE = {
    "clip": lambda x, lo, hi: min(max(x, lo), hi),
    "pow": math.pow,
    "cos": math.cos,
    "sin": math.sin,
    "between": lambda x, lo, hi: 1.0 if lo <= x <= hi else 0.0,
    "PI": math.pi,
}


def _eval(expr: str | None, u: float, default: float) -> float:
    if expr is None:
        return default
    return float(eval(expr, {"__builtins__": {}}, {**_NAMESPACE, "U": u}))  # noqa: S307 — our own strings


def sample(anim: TextAnimation | None, u: float, window: float) -> AnimFrame:
    """Evaluate :func:`expressions` at local time ``u`` (what the output shows at that moment)."""
    e = expressions(anim, window)
    return AnimFrame(
        opacity=_eval(e.opacity, u, 1.0),
        dx=_eval(e.dx, u, 0.0),
        dy=_eval(e.dy, u, 0.0),
        scale=_eval(e.scale, u, 1.0),
    )

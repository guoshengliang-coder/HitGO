"""Text layer animation curves (HIG-40, HIG-44; contract §2 ``layers[type=text].animation``).

One definition serves both sides of the worker: :func:`expressions` writes the curves as
ffmpeg expressions of a local-time variable ``U`` (seconds since the layer's window opened),
and :func:`sample` evaluates those very strings in Python. The frontend re-implements the
same numbers in ``lib/textAnimation.ts``; both are held to
``frontend/src/lib/fixtures/textAnimationCases.json``.

The expression syntax used here is the common subset of ffmpeg's evaluator and Python:
numbers, ``+ - * /``, parentheses, ``clip / pow / cos / sin / between / lt / gte`` and ``PI``.

A frame of animation is four values:

- ``opacity``: multiplier on the layer's own opacity (0–1);
- ``dx`` / ``dy``: offset of the layer centre as a fraction of the canvas **height**, so the
  same motion looks the same on every output aspect and in the editor preview;
- ``scale``: uniform scale around the layer centre.

Timing, for a window of length ``L`` and an enter delay ``dl``: the enter runs over
``[dl, dl + di]`` with ``di = min(in, L − dl)``, the exit over ``[L − do, L]`` with
``do = min(out, L − dl − di)``, and the loop from ``dl + di`` to ``L`` (under the exit too).
Every factor starts at rest, so nothing jumps when a phase begins.

Fields added in HIG-44 (``easing``, ``distance``, ``fade``, ``scale``, ``overshoot``, ``delay``,
``loop.amount``) default to the v0.16.0 motion, and at their defaults the expressions are the
same strings as before.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.schemas import TextAnimation, TextAnimPhase

SLIDE = 0.05  # default slide distance, fraction of the canvas height
POP_FROM = 0.5  # default: pop in grows from this scale (with an ease-out-back overshoot); pop out shrinks to it
BACK = 1.70158  # default ease-out-back overshoot constant
BREATHE = 0.03  # breathe scales between 1 and 1 + 2·BREATHE·amount
FLOAT = 0.008  # float bobs up and down by this fraction of the canvas height (× amount)
BLINK = 0.35  # blink dips opacity to 1 − 2·BLINK·amount (not below 0)
# Minimum headroom the scaled layer gets inside its fixed-size frame: the v0.16.0 presets peak at
# ~1.06 (pop in overshoot, breathe). Larger scales (HIG-44 scale / overshoot / amount) get more.
SCALE_HEADROOM = 1.1
DEFAULT_EASING = {"in": "ease_out", "out": "ease_in"}


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
    dl = min(anim.delay, L)
    di = min(anim.enter.duration, L - dl) if anim.enter else 0.0
    do = min(anim.exit.duration, max(0.0, L - dl - di)) if anim.exit else 0.0
    return di, do


def enter_delay(anim: TextAnimation, window: float) -> float:
    return min(anim.delay, max(0.0, window))


def easing_name(phase: TextAnimPhase, which: str) -> str:
    if phase.easing is not None:
        return phase.easing
    if which == "in" and phase.preset == "pop":
        return "back"
    return DEFAULT_EASING[which]


def _bounce_out(p: str) -> str:
    """easeOutBounce as a sum of gated pieces (no if(): Python cannot evaluate it)."""
    n1, d1 = 7.5625, 2.75
    return (
        f"(lt({p},{_n(1 / d1)})*{_n(n1)}*pow({p},2)"
        f"+between({p},{_n(1 / d1)},{_n(2 / d1)})*lt({p},{_n(2 / d1)})*({_n(n1)}*pow({p}-{_n(1.5 / d1)},2)+0.75)"
        f"+between({p},{_n(2 / d1)},{_n(2.5 / d1)})*lt({p},{_n(2.5 / d1)})*({_n(n1)}*pow({p}-{_n(2.25 / d1)},2)+0.9375)"
        f"+gte({p},{_n(2.5 / d1)})*({_n(n1)}*pow({p}-{_n(2.625 / d1)},2)+0.984375))"
    )


def ease(name: str, p: str, *, settle: bool, overshoot: float = BACK) -> str:
    """Progress 0 → 1 over ``p`` ∈ [0, 1]. ``settle`` picks the enter flavour of back / elastic /
    bounce (overshoot or bounce at the end); the exit flavour moves at the start instead."""
    if name == "linear":
        return p
    if name == "ease_in":
        return f"pow({p},3)"
    if name == "ease_out":
        return f"(1-pow(1-{p},3))"
    if name == "ease_in_out":
        return f"(lt({p},0.5)*4*pow({p},3)+gte({p},0.5)*(1-pow(2-2*{p},3)/2))"
    if name == "back":
        s = overshoot
        if settle:
            return f"(1+{_n(s + 1)}*pow({p}-1,3)+{_n(s)}*pow({p}-1,2))"
        return f"({_n(s + 1)}*pow({p},3)-{_n(s)}*pow({p},2))"
    if name == "elastic":
        c = 2 * math.pi / 3
        if settle:
            return f"(gte({p},1)+lt({p},1)*(pow(2,-10*{p})*sin((10*{p}-0.75)*{_n(c)})+1))"
        return f"(gte({p},1)-lt({p},1)*gte({p},0.000001)*pow(2,10*{p}-10)*sin((10*{p}-10.75)*{_n(c)}))"
    if name == "bounce":
        if settle:
            return _bounce_out(p)
        return f"(1-{_bounce_out(f'(1-{p})')})"
    raise ValueError(f"unknown easing {name}")


def expressions(anim: TextAnimation | None, window: float) -> AnimExpr:
    if anim is None or not anim.active or window <= 0:
        return AnimExpr()
    L = window
    dl = enter_delay(anim, L)
    di, do = phase_lengths(anim, L)
    opacity: list[str] = []
    dx: list[str] = []
    dy: list[str] = []
    scale: list[str] = []

    if anim.enter and di > 0:
        ph = anim.enter
        p = f"clip(U/{_n(di)},0,1)" if dl <= 0 else f"clip((U-{_n(dl)})/{_n(di)},0,1)"
        e = ease(easing_name(ph, "in"), p, settle=True, overshoot=ph.overshoot)
        rest = f"(1-{e})"
        if ph.preset == "pop":
            opacity.append(f"clip(3*{p},0,1)")
            scale.append(f"({_n(ph.scale)}+{_n(1 - ph.scale)}*{e})")
        else:
            if ph.preset == "fade" or ph.fade:
                # clip only when the curve can leave [0, 1], so the v0.16.0 strings stay as they were
                opacity.append(e if easing_name(ph, "in") in ("linear", "ease_in", "ease_out", "ease_in_out") else f"clip({e},0,1)")
            dist = _n(ph.distance)
            if ph.preset == "slide_up":
                dy.append(f"{dist}*{rest}")
            elif ph.preset == "slide_down":
                dy.append(f"-{dist}*{rest}")
            elif ph.preset == "slide_left":
                dx.append(f"{dist}*{rest}")
            elif ph.preset == "slide_right":
                dx.append(f"-{dist}*{rest}")

    if anim.exit and do > 0:
        ph = anim.exit
        q = f"clip((U-{_n(L - do)})/{_n(do)},0,1)"
        name = easing_name(ph, "out")
        e = ease(name, q, settle=False, overshoot=ph.overshoot)
        monotone = name in ("linear", "ease_in", "ease_out", "ease_in_out")
        if ph.preset in ("fade", "pop") or ph.fade:
            opacity.append(f"(1-{e})" if monotone else f"clip(1-{e},0,1)")
        dist = _n(ph.distance)
        if ph.preset == "pop":
            scale.append(f"(1-{_n(1 - ph.scale)}*{e})")
        elif ph.preset == "slide_up":
            dy.append(f"-{dist}*{e}")
        elif ph.preset == "slide_down":
            dy.append(f"{dist}*{e}")
        elif ph.preset == "slide_left":
            dx.append(f"-{dist}*{e}")
        elif ph.preset == "slide_right":
            dx.append(f"{dist}*{e}")

    start = dl + di
    if anim.loop and L - start > 0:
        # From the end of the enter to the end of the window, overlapping the exit: cutting the
        # loop where the exit starts would make blink / float jump back to rest in one frame.
        on = f"between(U,{_n(start)},{_n(L)})"
        wave = f"(2*PI*(U-{_n(start)})/{_n(anim.loop.period)})"
        preset = anim.loop.preset
        k = anim.loop.amount
        if preset == "breathe":
            scale.append(f"(1+{on}*{_n(BREATHE * k)}*(1-cos({wave})))")
        elif preset == "float":
            dy.append(f"-{on}*{_n(FLOAT * k)}*sin({wave})")
        elif preset == "blink":
            dip = f"(1-{on}*{_n(BLINK * k)}*(1-cos({wave})))"
            opacity.append(dip if 2 * BLINK * k <= 1 else f"clip({dip},0,1)")

    return AnimExpr(
        opacity="*".join(opacity) or None,
        dx="+".join(dx) or None,
        dy="+".join(dy) or None,
        scale="*".join(scale) or None,
    )


def scale_headroom(anim: TextAnimation | None, window: float, samples: int = 400) -> float:
    """How much bigger than the layer its padded frame must be: the largest scale the animation
    reaches (sampled), never below :data:`SCALE_HEADROOM`."""
    e = expressions(anim, window)
    if not e.scale or window <= 0:
        return SCALE_HEADROOM
    peak = max(_eval(e.scale, window * i / samples, 1.0) for i in range(samples + 1))
    return max(SCALE_HEADROOM, math.ceil(peak * 1.02 * 100) / 100)


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
    "lt": lambda a, b: 1.0 if a < b else 0.0,
    "gte": lambda a, b: 1.0 if a >= b else 0.0,
    "if_": lambda c, a, b: a if c else b,
    "mod": math.fmod,
    "PI": math.pi,
}


def _eval(expr: str | None, u: float, default: float) -> float:
    if expr is None:
        return default
    return evaluate(expr, U=u)


def evaluate(expr: str, **variables: float) -> float:
    """Evaluate one of our ffmpeg expressions in Python (``if(`` is a keyword there)."""
    code = expr.replace("if(", "if_(")
    return float(eval(code, {"__builtins__": {}}, {**_NAMESPACE, **variables}))  # noqa: S307 — our own strings


def sample(anim: TextAnimation | None, u: float, window: float) -> AnimFrame:
    """Evaluate :func:`expressions` at local time ``u`` (what the output shows at that moment)."""
    e = expressions(anim, window)
    return AnimFrame(
        opacity=_eval(e.opacity, u, 1.0),
        dx=_eval(e.dx, u, 0.0),
        dy=_eval(e.dy, u, 0.0),
        scale=_eval(e.scale, u, 1.0),
    )

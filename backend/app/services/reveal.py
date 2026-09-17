"""Glyph-by-glyph reveal of a text layer (HIG-45, contract §2 ``animation.reveal``).

The text stays one pre-rendered PNG. The frontend records where each reveal unit (a grapheme,
or a word) sits in it (``TextLayer.glyph_layout``, fractions of the PNG), and the worker
multiplies the PNG's alpha by a time-varying mask:

- ``typewriter``: unit ``k`` appears at once at ``t_k``;
- ``fade_chars``: unit ``k`` fades in over ``F = min(0.3, D/2)`` from ``t_k``;
- ``wipe``: an edge sweeps across unit ``k``'s ink between ``t_k`` and ``t_{k+1}``.

Each unit owns a *cell*: its line's band (split halfway between neighbouring lines) and the
stretch of that band up to halfway to its neighbours, so glow and shadow between two glyphs
appear with them. The mask is a binary search over lines, then over cells — per-pixel cost is
logarithmic in the glyph count (a flat sum of per-glyph terms is several times slower).

As in services/animation.py, :func:`mask_expression` writes ffmpeg expressions and
:func:`sample_alpha` evaluates those very strings; the frontend (``lib/textReveal.ts``)
re-implements the numbers, both held to ``frontend/src/lib/fixtures/textRevealCases.json``.
Local time is ``U`` (seconds since the layer's window opened); the mask also uses ``X / W``
and ``Y / H``, which in Python are passed as fractions with ``W = H = 1``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.schemas import GlyphLayout, TextReveal
from app.services.animation import _n, evaluate

FADE_SECONDS = 0.3  # fade_chars: each unit's fade, at most half the reveal
WIPE_FEATHER = 0.01  # wipe: soft edge, fraction of the PNG width
CURSOR_TAIL = 1.0  # typewriter cursor keeps blinking this long after the last unit (1 blink / s)


@dataclass(frozen=True)
class Unit:
    index: int  # reveal order
    line: int
    left: float
    right: float
    cell_left: float
    cell_right: float


@dataclass(frozen=True)
class RevealTiming:
    start: float  # local seconds
    duration: float
    times: list[float]  # t_k; wipe carries one more (t_N = end)

    @property
    def end(self) -> float:
        return self.start + self.duration


def _cbrt(v: float) -> float:
    return max(0.0, v) ** (1 / 3)


def inverse_ease(name: str, y: float) -> float:
    """Progress p at which the (monotone) reveal curve reaches y."""
    y = min(max(y, 0.0), 1.0)
    if name == "ease_in":
        return _cbrt(y)
    if name == "ease_out":
        return 1 - _cbrt(1 - y)
    if name == "ease_in_out":
        return _cbrt(y / 4) if y < 0.5 else 1 - _cbrt(2 * (1 - y)) / 2
    return y


def fade_seconds(duration: float) -> float:
    return min(FADE_SECONDS, duration / 2)


def timing(reveal: TextReveal, count: int, window: float, delay: float) -> RevealTiming | None:
    """When each unit starts, inside a window of length ``window``; the reveal starts with the
    enter (after its delay) and is cut to the window."""
    start = min(max(delay, 0.0), window)
    duration = min(reveal.duration, window - start)
    if duration <= 0 or count <= 0:
        return None
    inv = lambda y: inverse_ease(reveal.easing, y)  # noqa: E731
    if reveal.preset == "wipe":
        times = [start + duration * inv(k / count) for k in range(count + 1)]
    else:
        span = duration - (fade_seconds(duration) if reveal.preset == "fade_chars" else 0.0)
        times = [start + span * (inv(k / (count - 1)) if count > 1 else 0.0) for k in range(count)]
    return RevealTiming(start, duration, times)


def units(layout: GlyphLayout) -> list[list[Unit]]:
    """Units per line, sorted left to right, with their cells."""
    out: list[list[Unit]] = []
    index = 0
    for li, line in enumerate(layout.lines):
        row = []
        for left, right in line.units:
            row.append((index, left, right))
            index += 1
        row.sort(key=lambda r: (r[1], r[2]))
        cells: list[Unit] = []
        for i, (k, left, right) in enumerate(row):
            cl = 0.0 if i == 0 else (row[i - 1][2] + left) / 2
            cr = 1.0 if i == len(row) - 1 else (right + row[i + 1][1]) / 2
            cells.append(Unit(k, li, left, right, cl, max(cl, cr)))
        out.append(cells)
    return out


def _leaf(unit: Unit, reveal: TextReveal, t: RevealTiming, rtl: bool) -> str:
    tk = t.times[unit.index]
    if reveal.preset == "typewriter":
        return f"gte(U,{_n(tk)})"
    if reveal.preset == "fade_chars":
        return f"clip((U-{_n(tk)})/{_n(fade_seconds(t.duration))},0,1)"
    t1 = t.times[unit.index + 1]
    s0 = max(unit.cell_left, unit.left)
    s1 = min(unit.cell_right, unit.right)
    s1 = max(s0, s1)
    span = _n(s1 - s0 + WIPE_FEATHER)
    prog = f"clip((U-{_n(tk)})/{_n(max(t1 - tk, 1e-6))},0,1)"
    if rtl:
        sweep = f"clip((X/W-({_n(s1)}-{span}*{prog}))/{_n(WIPE_FEATHER)},0,1)"
    else:
        sweep = f"clip(({_n(s0)}+{span}*{prog}-X/W)/{_n(WIPE_FEATHER)},0,1)"
    return f"if(gte(U,{_n(t1)}),1,gte(U,{_n(tk)})*{sweep})"


def _search(items: Sequence[str], splits: Sequence[float], var: str) -> str:
    """Balanced ``if(lt(var, split), left, right)`` over leaves; ``splits[i]`` separates i / i + 1."""
    if len(items) == 1:
        return items[0]
    mid = len(items) // 2
    return f"if(lt({var},{_n(splits[mid - 1])}),{_search(items[:mid], splits[:mid - 1], var)},{_search(items[mid:], splits[mid:], var)})"


def mask_expression(layout: GlyphLayout, reveal: TextReveal, window: float, delay: float) -> str | None:
    """Alpha multiplier in ``U``, ``X / W`` and ``Y / H``; 1 once the reveal is over."""
    t = timing(reveal, layout.count, window, delay)
    if t is None:
        return None
    rows = units(layout)
    line_exprs = []
    for li, cells in enumerate(rows):
        leaves = [_leaf(c, reveal, t, layout.lines[li].rtl) for c in cells]
        splits = [c.cell_right for c in cells[:-1]]
        line_exprs.append(_search(leaves, splits, "X/W"))
    lines = layout.lines
    line_splits = [(lines[i].bottom + lines[i + 1].top) / 2 for i in range(len(lines) - 1)]
    return f"if(gte(U,{_n(t.end)}),1,{_search(line_exprs, line_splits, 'Y/H')})"


def sample_alpha(layout: GlyphLayout, reveal: TextReveal, window: float, delay: float, u: float, x: float, y: float) -> float:
    """What the mask is at local time ``u`` for the PNG point (x, y), both fractions."""
    expr = mask_expression(layout, reveal, window, delay)
    return 1.0 if expr is None else evaluate(expr, U=u, X=x, W=1.0, Y=y, H=1.0)


@dataclass(frozen=True)
class Cursor:
    x: str  # overlay x / y in U, pixels inside the layer's w × h frame
    y: str
    enable: str
    width: int
    height: int


def cursor(layout: GlyphLayout, reveal: TextReveal, window: float, delay: float, w: int, h: int) -> Cursor | None:
    """The typewriter cursor: a bar right after the newest unit (before the first one until it
    appears), solid while typing, then blinking for :data:`CURSOR_TAIL` seconds."""
    if reveal.preset != "typewriter" or not reveal.cursor:
        return None
    t = timing(reveal, layout.count, window, delay)
    if t is None:
        return None
    line0 = layout.lines[0]
    line_px = (line0.bottom - line0.top) * h
    cw = max(2, round(line_px * 0.06))
    ch = max(2, round(line_px * 0.8))
    by_index = {u.index: u for row in units(layout) for u in row}
    gap = cw * 0.6

    def spot(k: int, after: bool) -> tuple[int, int]:
        u = by_index[k]
        line = layout.lines[u.line]
        rtl = line.rtl
        edge_right = (after and not rtl) or (not after and rtl)
        x = u.right * w + gap if edge_right else u.left * w - gap - cw
        top = line.top * h + ((line.bottom - line.top) * h - ch) / 2
        return min(max(0, round(x)), max(0, w - cw)), min(max(0, round(top)), max(0, h - ch))

    spots = [spot(0, after=False)] + [spot(k, after=True) for k in range(layout.count)]
    # spots[i] holds while U < times[i] (i ≥ 1 after unit i − 1 appeared); the last one to the end
    splits = t.times[: layout.count]
    xs = _search([str(s[0]) for s in spots], splits, "U")
    ys = _search([str(s[1]) for s in spots], splits, "U")
    tail = min(window, t.end + CURSOR_TAIL)
    enable = f"between(U,{_n(t.start)},{_n(t.end)})+between(U,{_n(t.end)},{_n(tail)})*lt(mod(U-{_n(t.end)},1),0.5)"
    return Cursor(xs, ys, enable, cw, ch)

"""Estimate a text layer's style from the pixels inside an OCR box (contract §6, HIG-38).

The detector gives us *where* the text is; this module answers *what it looks like* so the
translated layer we write back is visually close to the original. Everything here is a pure
function over a Pillow image, so the tests synthesise their own inputs instead of shipping
video frames.

What is reliable and what is not — this is the honest version of the item's "尽量还原":

    font size   high     foreground row height over frame height
    colour      high     largest quantised cluster of the eroded foreground
    align       high     where the box sits relative to the centre line
    stroke      medium   second cluster in the ring just outside the glyph core
    background  medium   one dominant non-foreground cluster inside the box
    stroke width low     only a coarse guess; falls back to a fixed value
    font family  —       not possible; the caller substitutes a per-language default

Anything we cannot estimate is left out of the returned dict rather than guessed, and
``confidence`` says how much of it to trust.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from PIL import Image, ImageFilter

# A glyph's em box is taller than its ink: cap height plus descender is roughly 85% of the
# font size for the faces used in ad creatives, so scale the measured ink height back up.
INK_TO_FONT_SIZE = 1.18

# Foreground = far enough from the border colour. Relative to the box's own dynamic range so
# that a low-contrast overlay is not thrown away wholesale.
_MIN_FG_DISTANCE = 40.0
_FG_DISTANCE_RATIO = 0.25

# Below / above these the foreground mask is not a plausible piece of text (empty crop, or a
# crop that is almost entirely "text"), and every estimate built on it is suspect.
_FG_RATIO_MIN = 0.03
_FG_RATIO_MAX = 0.55

_QUANT_BITS = 3  # 5 bits per channel kept


def _quant(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    return (rgb[0] >> _QUANT_BITS << _QUANT_BITS, rgb[1] >> _QUANT_BITS << _QUANT_BITS, rgb[2] >> _QUANT_BITS << _QUANT_BITS)


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def _luma(rgb: tuple[int, int, int]) -> float:
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def _distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def crop_box(image: Image.Image, box: dict[str, float]) -> Image.Image:
    """The pixels of one normalised box, clamped to the image."""
    w, h = image.size
    x0 = max(0, min(w - 1, int(round(float(box["x"]) * w))))
    y0 = max(0, min(h - 1, int(round(float(box["y"]) * h))))
    x1 = max(x0 + 1, min(w, int(round((float(box["x"]) + float(box["w"])) * w))))
    y1 = max(y0 + 1, min(h, int(round((float(box["y"]) + float(box["h"])) * h))))
    return image.convert("RGB").crop((x0, y0, x1, y1))


def border_color(crop: Image.Image, ring: int = 2) -> tuple[int, int, int]:
    """Median colour of the outermost ``ring`` pixels — what the text sits on."""
    w, h = crop.size
    px = crop.load()
    samples: list[tuple[int, int, int]] = []
    for y in range(h):
        for x in range(w):
            if x < ring or y < ring or x >= w - ring or y >= h - ring:
                samples.append(px[x, y])
    if not samples:
        return (0, 0, 0)
    # Per-channel median: robust against a stray bright pixel in the ring.
    return tuple(sorted(s[c] for s in samples)[len(samples) // 2] for c in range(3))  # type: ignore[return-value]


def foreground_mask(crop: Image.Image, bg: tuple[int, int, int]) -> Image.Image:
    """1-bit mask of the pixels that are plausibly glyph ink."""
    px = crop.convert("RGB").load()
    w, h = crop.size
    extremes = crop.convert("L").getextrema()
    span = float(extremes[1] - extremes[0]) if extremes else 0.0
    threshold = max(_MIN_FG_DISTANCE, span * _FG_DISTANCE_RATIO)
    mask = Image.new("L", (w, h), 0)
    mpx = mask.load()
    for y in range(h):
        for x in range(w):
            if _distance(px[x, y], bg) >= threshold:
                mpx[x, y] = 255
    return mask


def row_runs(mask: Image.Image, min_ratio: float = 0.02) -> list[tuple[int, int]]:
    """Vertical runs of rows that contain foreground: one run per line of text."""
    w, h = mask.size
    px = mask.load()
    filled = [sum(1 for x in range(w) if px[x, y]) >= max(1, int(w * min_ratio)) for y in range(h)]
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for y, on in enumerate(filled):
        if on and start is None:
            start = y
        elif not on and start is not None:
            runs.append((start, y))
            start = None
    if start is not None:
        runs.append((start, h))
    if not runs:
        return runs
    # A box is rarely pixel-tight on its text: one row of whatever sits just outside it reads
    # as a line of its own and would double the line count. Keep only runs thick enough to be
    # a line of the same text.
    tallest = max(b - a for a, b in runs)
    return [r for r in runs if (r[1] - r[0]) >= max(2, tallest * 0.25)]


def dominant_color(crop: Image.Image, mask: Image.Image) -> tuple[int, int, int] | None:
    """Largest quantised colour cluster among the masked pixels."""
    px = crop.convert("RGB").load()
    mpx = mask.load()
    w, h = crop.size
    counter: Counter[tuple[int, int, int]] = Counter()
    for y in range(h):
        for x in range(w):
            if mpx[x, y]:
                counter[_quant(px[x, y])] += 1
    if not counter:
        return None
    return counter.most_common(1)[0][0]


def _count(mask: Image.Image) -> int:
    return sum(1 for p in mask.getdata() if p)


def glyph_core(mask: Image.Image, max_steps: int = 6, keep_ratio: float = 0.06) -> Image.Image:
    """Erode the ink blob down to its centre.

    One erosion only removes the anti-aliased fringe. When the text is stroked, the stroke is
    *inside* the ink blob too and can easily out-area a thin glyph stem, so a single step
    leaves the stroke colour winning the vote. Keep eroding while a meaningful core survives:
    what is left is the fill, not the outline.
    """
    total = _count(mask)
    if not total:
        return mask
    core = mask
    for _ in range(max_steps):
        nxt = core.filter(ImageFilter.MinFilter(3))
        if _count(nxt) < max(1, int(total * keep_ratio)):
            break
        core = nxt
    return core


def _mask_minus(mask: Image.Image, inner: Image.Image) -> Image.Image:
    """The part of the ink blob outside ``inner`` — where a stroke lives."""
    w, h = mask.size
    mpx, ipx = mask.load(), inner.load()
    ring = Image.new("L", (w, h), 0)
    rpx = ring.load()
    for y in range(h):
        for x in range(w):
            if mpx[x, y] and not ipx[x, y]:
                rpx[x, y] = 255
    return ring


def align_for(box: dict[str, float]) -> str:
    """Horizontal alignment implied by where the box sits on the canvas."""
    center = float(box["x"]) + float(box["w"]) / 2
    if abs(center - 0.5) < 0.06:
        return "center"
    return "left" if center < 0.5 else "right"


def estimate_style(image: Image.Image, box: dict[str, float]) -> dict[str, Any]:
    """Style of the text inside ``box``; keys we cannot estimate are left out.

    Always returns ``align`` and ``confidence``; ``font_size`` / ``color`` whenever the
    foreground mask looks like text at all; ``stroke_color`` / ``stroke_width`` /
    ``background`` / ``line_height`` only when the evidence supports them.
    """
    style: dict[str, Any] = {"align": align_for(box)}
    crop = crop_box(image, box)
    w, h = crop.size
    frame_h = image.size[1] or 1
    bg = border_color(crop)
    mask = foreground_mask(crop, bg)

    fg = sum(1 for p in mask.getdata() if p)
    ratio = fg / float(w * h) if w and h else 0.0
    if not fg or not (_FG_RATIO_MIN <= ratio <= _FG_RATIO_MAX):
        # Empty or saturated crop: position is still useful, the rest would be invention.
        style["confidence"] = 0.2
        return style

    runs = row_runs(mask)
    score = 1.0
    if runs:
        heights = sorted(r[1] - r[0] for r in runs)
        ink = heights[len(heights) // 2]
        style["font_size"] = round(ink * INK_TO_FONT_SIZE / frame_h, 4)
        style["lines"] = len(runs)
        if len(runs) >= 2:
            centers = [(a + b) / 2 for a, b in runs]
            gaps = [centers[i + 1] - centers[i] for i in range(len(centers) - 1)]
            if ink:
                style["line_height"] = round(sum(gaps) / len(gaps) / ink, 3)
        # Wildly uneven line heights mean the mask caught something other than text.
        if len(heights) >= 2 and heights[-1] > heights[0] * 3:
            score -= 0.25
    else:
        score -= 0.3

    core = glyph_core(mask)
    fill = dominant_color(crop, core) or dominant_color(crop, mask)
    if fill is not None:
        style["color"] = _hex(fill)
        # The stroke, if there is one, is the ink that survives outside the eroded core but is
        # neither the fill nor the background behind the box.
        ring_color = dominant_color(crop, _mask_minus(mask, core.filter(ImageFilter.MaxFilter(3))))
        if ring_color is not None and abs(_luma(ring_color) - _luma(fill)) > 60 and _distance(ring_color, bg) > _MIN_FG_DISTANCE:
            style["stroke_color"] = _hex(ring_color)
            # Coarse on purpose: measuring true stroke width from an antialiased crop is not
            # something we can do reliably, and the user can drag it afterwards.
            style["stroke_width"] = 0.004
    else:
        score -= 0.3

    # A solid plate behind the text (subtitle bar, price tag): the box interior is dominated by
    # one non-foreground colour that is not what surrounds the box.
    inside = Image.new("L", (w, h), 255)
    ipx, mpx = inside.load(), mask.filter(ImageFilter.MaxFilter(5)).load()
    for y in range(h):
        for x in range(w):
            if mpx[x, y]:
                ipx[x, y] = 0
    plate = dominant_color(crop, inside)
    if plate is not None and _distance(plate, bg) > _MIN_FG_DISTANCE:
        style["background"] = _hex(plate)

    if ratio < 0.06 or ratio > 0.4:
        score -= 0.2
    style["confidence"] = round(max(0.0, min(1.0, score)), 2)
    return style

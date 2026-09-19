"""Style estimation from pixels (contract §6 step 2, HIG-38).

The inputs are synthesised here rather than checked in as video frames: that keeps the tests
fast and, more importantly, makes the expected answer something we know exactly (we drew it).
Latin text only — the CI image has no CJK font, and a glyph that does not render would make
these assert against an empty crop.
"""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.services import screen_style

W, H = 1080, 1920


def _font(size: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    pytest.skip("no scalable font available to draw the fixtures")


def _frame(bg=(30, 40, 60)) -> Image.Image:
    return Image.new("RGB", (W, H), bg)


def test_white_text_black_stroke_bottom_center():
    img = _frame()
    ImageDraw.Draw(img).text(
        (W / 2, 1560), "LIMITED FREE", font=_font(72), fill=(255, 255, 255),
        stroke_width=4, stroke_fill=(0, 0, 0), anchor="mm",
    )
    style = screen_style.estimate_style(img, {"x": 0.10, "y": 0.79, "w": 0.80, "h": 0.06})

    assert style["align"] == "center"
    # Ink is shorter than the em box; 1.18 puts the estimate back near the real 72/1920.
    assert style["font_size"] == pytest.approx(72 / H, abs=0.006)
    assert style["color"] in ("#F8F8F8", "#FFFFFF")
    assert style["stroke_color"] == "#000000"
    assert style["stroke_width"] > 0
    assert style["confidence"] >= 0.7


def test_stroke_does_not_win_the_fill_vote():
    """A single erosion leaves the outline out-weighing a thin stem; the fill must still win."""
    img = _frame()
    ImageDraw.Draw(img).text(
        (W / 2, 900), "IIIII", font=_font(64), fill=(255, 220, 0),
        stroke_width=5, stroke_fill=(0, 0, 0), anchor="mm",
    )
    style = screen_style.estimate_style(img, {"x": 0.35, "y": 0.45, "w": 0.30, "h": 0.05})
    r, g, b = (int(style["color"][i : i + 2], 16) for i in (1, 3, 5))
    assert r > 200 and g > 180 and b < 80, style["color"]


def test_two_lines_are_counted_and_line_height_estimated():
    img = _frame((10, 10, 10))
    draw = ImageDraw.Draw(img)
    draw.text((W / 2, 300), "FIRST LINE", font=_font(60), fill=(255, 220, 0), anchor="mm")
    draw.text((W / 2, 390), "SECOND LINE", font=_font(60), fill=(255, 220, 0), anchor="mm")
    style = screen_style.estimate_style(img, {"x": 0.20, "y": 0.135, "w": 0.60, "h": 0.075})

    assert style["lines"] == 2
    assert style["line_height"] > 1.0


def test_one_stray_row_outside_the_box_does_not_add_a_line():
    """Boxes are never pixel-tight; a sliver of what is just outside must not read as a line."""
    img = Image.new("RGB", (W, H), (200, 210, 220))
    draw = ImageDraw.Draw(img)
    draw.rectangle([640, 80, 1020, 200], fill=(255, 255, 255))
    draw.text((830, 140), "SALE", font=_font(64), fill=(227, 49, 43), anchor="mm")
    # Deliberately 1–2 px taller than the plate.
    style = screen_style.estimate_style(img, {"x": 0.59, "y": 0.042, "w": 0.35, "h": 0.063})

    assert style["lines"] == 1
    assert style["color"].startswith("#E")


def test_alignment_follows_the_box_position():
    img = _frame()
    assert screen_style.align_for({"x": 0.3, "y": 0.1, "w": 0.4, "h": 0.05}) == "center"
    assert screen_style.align_for({"x": 0.02, "y": 0.1, "w": 0.3, "h": 0.05}) == "left"
    assert screen_style.align_for({"x": 0.62, "y": 0.1, "w": 0.3, "h": 0.05}) == "right"
    # And the full estimate reports the same thing.
    ImageDraw.Draw(img).text((120, 200), "TOP LEFT", font=_font(48), fill=(255, 255, 255))
    assert screen_style.estimate_style(img, {"x": 0.09, "y": 0.10, "w": 0.30, "h": 0.04})["align"] == "left"


def test_empty_crop_reports_low_confidence_and_invents_nothing():
    style = screen_style.estimate_style(_frame((20, 20, 20)), {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.05})

    assert style["confidence"] <= 0.3
    assert "color" not in style
    assert "font_size" not in style
    assert style["align"] == "left"  # position is still knowable


def test_crop_box_clamps_to_the_image():
    img = _frame()
    crop = screen_style.crop_box(img, {"x": 0.9, "y": 0.9, "w": 0.5, "h": 0.5})
    assert crop.size[0] <= W and crop.size[1] <= H
    assert crop.size[0] > 0 and crop.size[1] > 0

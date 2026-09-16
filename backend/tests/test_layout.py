import math

import pytest

from app.services.layout import Box, layer_box, mask_box, rotated_overlay_position, rotated_size, split_anchor

W, H = 1080, 1920
IMG = (600, 240)  # 2.5:1 sticker


def box(anchor, margin=(0.0, 0.0), width=0.5):
    return layer_box(anchor, margin, width, W, H, *IMG)


def test_width_and_aspect():
    b = box("top-left", width=0.5)
    assert b.w == 540
    assert b.h == pytest.approx(216)


@pytest.mark.parametrize(
    "anchor,expected",
    [
        ("top-left", (86.4, 96.0)),
        ("top-center", ((W - 540) / 2 + 86.4, 96.0)),
        ("top-right", (W - 540 - 86.4, 96.0)),
        ("center-left", (86.4, (H - 216) / 2 + 96.0)),
        ("center", ((W - 540) / 2 + 86.4, (H - 216) / 2 + 96.0)),
        ("center-right", (W - 540 - 86.4, (H - 216) / 2 + 96.0)),
        ("bottom-left", (86.4, H - 216 - 96.0)),
        ("bottom-center", ((W - 540) / 2 + 86.4, H - 216 - 96.0)),
        ("bottom-right", (W - 540 - 86.4, H - 216 - 96.0)),
    ],
)
def test_all_nine_anchors(anchor, expected):
    b = box(anchor, margin=(0.08, 0.05), width=0.5)
    assert (b.x, b.y) == pytest.approx(expected)


def test_zero_margin_corners():
    assert box("top-left").rounded()[:2] == (0, 0)
    assert box("bottom-right").rounded()[:2] == (W - 540, H - 216)


def test_center_margin_is_offset_from_center():
    plain = box("center")
    shifted = box("center", margin=(-0.1, 0.1))
    assert shifted.x == pytest.approx(plain.x - 0.1 * W)
    assert shifted.y == pytest.approx(plain.y + 0.1 * H)


def test_square_canvas_uses_its_own_dimensions():
    b = layer_box("bottom-right", (0.05, 0.05), 0.3, 1080, 1080, 100, 100)
    assert (b.w, b.h) == (324, 324)
    assert (b.x, b.y) == pytest.approx((1080 - 324 - 54, 1080 - 324 - 54))


def test_split_anchor():
    assert split_anchor("center") == ("center", "center")
    assert split_anchor("bottom-left") == ("bottom", "left")


def test_invalid_image_size():
    with pytest.raises(ValueError):
        layer_box("center", (0, 0), 0.5, W, H, 0, 10)


def test_rotated_size_matches_ffmpeg_rotw_roth():
    assert rotated_size(100, 50, 0) == pytest.approx((100, 50))
    assert rotated_size(100, 50, 90) == pytest.approx((50, 100))
    assert rotated_size(100, 100, 45) == pytest.approx((100 * math.sqrt(2),) * 2)


def test_rotated_overlay_keeps_center():
    b = Box(100, 200, 300, 120)
    x, y = rotated_overlay_position(b, 30)
    rw, rh = rotated_size(300, 120, 30)
    assert (x + rw / 2, y + rh / 2) == pytest.approx((b.cx, b.cy))
    assert rotated_overlay_position(b, 0) == pytest.approx((100, 200))


# --- mask layers: height relative to the canvas, no media aspect -------------------------


def test_mask_box_uses_canvas_height():
    b = mask_box("bottom-center", (0, 0.1), 1.0, 0.12, W, H)
    assert (b.w, b.h) == (1080, pytest.approx(230.4))
    assert (b.x, b.y) == pytest.approx((0, H - 230.4 - 192))


@pytest.mark.parametrize(
    "anchor,expected",
    [
        ("top-left", (86.4, 96.0)),
        ("top-center", ((W - 540) / 2 + 86.4, 96.0)),
        ("top-right", (W - 540 - 86.4, 96.0)),
        ("center-left", (86.4, (H - 192) / 2 + 96.0)),
        ("center", ((W - 540) / 2 + 86.4, (H - 192) / 2 + 96.0)),
        ("center-right", (W - 540 - 86.4, (H - 192) / 2 + 96.0)),
        ("bottom-left", (86.4, H - 192 - 96.0)),
        ("bottom-center", ((W - 540) / 2 + 86.4, H - 192 - 96.0)),
        ("bottom-right", (W - 540 - 86.4, H - 192 - 96.0)),
    ],
)
def test_mask_box_all_nine_anchors(anchor, expected):
    b = mask_box(anchor, (0.08, 0.05), 0.5, 0.1, W, H)
    assert (b.w, b.h) == (540, 192)
    assert (b.x, b.y) == pytest.approx(expected)


def test_mask_box_and_layer_box_share_the_anchor_arithmetic():
    # A 600×240 image at width 0.5 is 540×216; the same box as a mask of height 216/1920.
    img = layer_box("center-right", (0.03, -0.02), 0.5, W, H, *IMG)
    mask = mask_box("center-right", (0.03, -0.02), 0.5, 216 / H, W, H)
    assert (mask.x, mask.y, mask.w, mask.h) == pytest.approx((img.x, img.y, img.w, img.h))

#!/usr/bin/env python3
"""Generate the tiny placeholder stickers in samples/stickers/.

They exist so a fresh environment has something in the editor's 原料库 tab. Deliberately
small (a few KB each, flat colours, no font files) — samples/README.md says no big files.
Re-run after editing STICKERS; the output is deterministic.

    uv run --with pillow python scripts/gen_sample_stickers.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "samples" / "stickers"

# name -> (size, background, accent). Shapes only: text would need a bundled font.
STICKERS = {
    "badge-round-red.png": ((240, 240), (217, 72, 31, 255), (255, 255, 255, 255)),
    "badge-round-blue.png": ((240, 240), (47, 111, 221, 255), (255, 255, 255, 255)),
    "banner-bar-dark.png": ((600, 160), (17, 17, 20, 210), (255, 214, 0, 255)),
    "corner-tag-yellow.png": ((320, 200), (255, 199, 0, 255), (17, 17, 20, 255)),
    "frame-outline-white.png": ((480, 480), (0, 0, 0, 0), (255, 255, 255, 235)),
}


def draw(name: str, size: tuple[int, int], bg: tuple[int, ...], accent: tuple[int, ...]) -> None:
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w, h = size
    if name.startswith("badge-round"):
        d.ellipse((0, 0, w - 1, h - 1), fill=bg)
        d.ellipse((w * 0.12, h * 0.12, w * 0.88, h * 0.88), outline=accent, width=max(2, w // 40))
    elif name.startswith("banner-bar"):
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 5, fill=bg)
        d.rectangle((w * 0.06, h * 0.42, w * 0.94, h * 0.58), fill=accent)
    elif name.startswith("corner-tag"):
        d.polygon([(0, 0), (w - 1, 0), (w - 1, h - 1)], fill=bg)
        d.line([(w * 0.55, h * 0.18), (w * 0.9, h * 0.18)], fill=accent, width=max(2, h // 20))
    else:  # frame-outline
        d.rounded_rectangle(
            (w * 0.04, h * 0.04, w * 0.96, h * 0.96),
            radius=w // 12,
            outline=accent,
            width=max(3, w // 60),
        )
    img.save(OUT / name, "PNG", optimize=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (size, bg, accent) in STICKERS.items():
        draw(name, size, bg, accent)
        print(f"{name}: {(OUT / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()

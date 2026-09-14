"""Generate the safe-zone overlay PNGs (mock platform UIs) into app/data/overlays/.

Run from ``backend/``:  ``uv run python scripts/gen_overlays.py``

Each overlay is a 1080×1920 RGBA image drawn in semi-transparent white / black
(alpha ≈ 150) with thin outlines. The layouts are rough approximations of each
platform's feed UI, sized to match the zone rects in app/data/safe_zones.json.
They are illustrative only (示意，非官方素材) and use Latin placeholder labels.
"""

from __future__ import annotations

import glob
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "app" / "data" / "overlays"

W, H = 1080, 1920
ALPHA = 150
WHITE = (255, 255, 255, ALPHA)
WHITE_SOFT = (255, 255, 255, 90)
BLACK = (0, 0, 0, ALPHA)
LINE = 3  # outline width in px

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/**/DejaVuSans.ttf",
    "/usr/share/fonts/**/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/**/LiberationSans-Regular.ttf",
    "/usr/share/fonts/**/NotoSans-Regular.ttf",
    "/usr/share/fonts/**/*.ttf",
    str(ROOT.parent / "samples" / "fonts" / "*.ttf"),
    str(ROOT.parent / "samples" / "fonts" / "*.otf"),
]


def find_font_file() -> str | None:
    for pattern in FONT_CANDIDATES:
        for match in sorted(glob.glob(pattern, recursive=True)):
            if Path(match).is_file():
                return match
    return None


_FONT_FILE = find_font_file()


def font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    if _FONT_FILE:
        try:
            return ImageFont.truetype(_FONT_FILE, size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def _render_glyph(ch: str) -> bytes:
    f = font(40)
    img = Image.new("L", (60, 60), 0)
    ImageDraw.Draw(img).text((30, 30), ch, font=f, fill=255, anchor="mm")
    return img.tobytes()


_NOTDEF = None


def has_glyph(ch: str) -> bool:
    """True when the font draws `ch` as something other than the .notdef box."""
    global _NOTDEF
    if _NOTDEF is None:
        _NOTDEF = _render_glyph("\U000f0000")  # private-use: never in a UI font
    rendered = _render_glyph(ch)
    return rendered != _NOTDEF and any(rendered)


# preferred glyph → ASCII fallback when the font lacks it
GLYPHS: dict[str, tuple[str, str]] = {
    "like": ("♥", "<3"),
    "comment": ("…", "..."),
    "share": ("➦", "->"),
    "star": ("★", "*"),
    "search": ("⌕", "Q"),
    "more": ("⋮", ":"),
    "menu": ("≡", "="),
    "up": ("▲", "^"),
    "down": ("▼", "v"),
    "remix": ("⟳", "~"),
    "music": ("♪", "~"),
    "plus": ("+", "+"),
}


def glyph(name: str) -> str:
    preferred, fallback = GLYPHS[name]
    return preferred if has_glyph(preferred) else fallback


# ---------------------------------------------------------------------------
# drawing primitives (coordinates are fractions of W / H)
# ---------------------------------------------------------------------------


class Canvas:
    def __init__(self) -> None:
        self.img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    # -- helpers -------------------------------------------------------------
    @staticmethod
    def px(fx: float, fy: float) -> tuple[int, int]:
        return round(fx * W), round(fy * H)

    def text(self, fx: float, fy: float, s: str, size: int = 34, anchor: str = "la",
             fill=WHITE, bold: bool = False) -> None:
        f = font(size)
        x, y = self.px(fx, fy)
        # thin dark halo for legibility on light footage
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            self.d.text((x + dx, y + dy), s, font=f, fill=BLACK, anchor=anchor)
        self.d.text((x, y), s, font=f, fill=fill, anchor=anchor)
        if bold:
            self.d.text((x + 1, y), s, font=f, fill=fill, anchor=anchor)

    def circle(self, fx: float, fy: float, r: int, fill=WHITE_SOFT, outline=BLACK) -> None:
        x, y = self.px(fx, fy)
        self.d.ellipse((x - r, y - r, x + r, y + r), fill=fill, outline=outline, width=LINE)

    def ring(self, fx: float, fy: float, r: int, width: int = 6) -> None:
        x, y = self.px(fx, fy)
        self.d.ellipse((x - r, y - r, x + r, y + r), outline=WHITE, width=width)
        self.d.ellipse((x - r - 2, y - r - 2, x + r + 2, y + r + 2), outline=BLACK, width=2)

    def pill(self, fx: float, fy: float, fw: float, fh: float, radius: int | None = None,
             fill=WHITE_SOFT, outline=BLACK) -> None:
        x0, y0 = self.px(fx, fy)
        x1, y1 = self.px(fx + fw, fy + fh)
        r = radius if radius is not None else (y1 - y0) // 2
        self.d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=fill, outline=outline, width=LINE)

    def rect(self, fx: float, fy: float, fw: float, fh: float, fill=WHITE_SOFT, outline=BLACK) -> None:
        x0, y0 = self.px(fx, fy)
        x1, y1 = self.px(fx + fw, fy + fh)
        self.d.rectangle((x0, y0, x1, y1), fill=fill, outline=outline, width=LINE)

    def hline(self, fx0: float, fx1: float, fy: float, width: int = LINE, fill=WHITE) -> None:
        x0, y = self.px(fx0, fy)
        x1, _ = self.px(fx1, fy)
        self.d.line((x0, y, x1, y), fill=fill, width=width)

    def caption_line(self, fx: float, fy: float, fw: float, height: int = 26) -> None:
        """A blurred-out caption line: rounded bar."""
        x0, y0 = self.px(fx, fy)
        x1, _ = self.px(fx + fw, fy)
        self.d.rounded_rectangle((x0, y0, x1, y0 + height), radius=height // 2,
                                 fill=WHITE_SOFT, outline=BLACK, width=2)

    # -- composite widgets ----------------------------------------------------
    def status_bar(self) -> None:
        self.text(0.06, 0.018, "9:41", size=32, bold=True)
        self.text(0.94, 0.018, "5G  100%", size=28, anchor="ra")
        self.pill(0.905, 0.021, 0.055, 0.013, radius=6)

    def button_icon(self, fx: float, fy: float, r: int, label: str, icon: str = "") -> None:
        self.circle(fx, fy, r)
        if icon:
            self.text(fx, fy, glyph(icon), size=int(r * 1.0), anchor="mm")
        self.text(fx, fy + (r + 16) / H, label, size=26, anchor="ma")

    def avatar_with_follow(self, fx: float, fy: float, r: int = 48) -> None:
        self.ring(fx, fy, r)
        self.circle(fx, fy, r - 8, fill=WHITE_SOFT, outline=None)
        # follow "+" dot at the bottom of the avatar
        dot_r = 20
        self.circle(fx, fy + (r + 4) / H, dot_r, fill=WHITE, outline=BLACK)
        self.text(fx, fy + (r + 4) / H, "+", size=36, anchor="mm", fill=BLACK)

    def spinning_disc(self, fx: float, fy: float, r: int = 46) -> None:
        self.circle(fx, fy, r, fill=BLACK, outline=WHITE)
        self.circle(fx, fy, r // 2, fill=WHITE_SOFT, outline=BLACK)
        self.circle(fx, fy, 6, fill=WHITE, outline=None)

    def action_column(self, fx: float, avatar_y: float, ys: list[tuple[float, str, str]],
                      disc_y: float | None, r: int = 38) -> None:
        """Avatar (+follow dot), then (y, icon-name, label) buttons, then the music disc."""
        self.avatar_with_follow(fx, avatar_y, r=r + 6)
        for fy, icon, label in ys:
            self.button_icon(fx, fy, r, label, icon)
        if disc_y is not None:
            self.spinning_disc(fx, disc_y, r=r - 4)

    def tab_bar(self, labels: list[str], fy: float = 0.94, plus_index: int | None = 2) -> None:
        self.hline(0, 1, fy, width=2)
        n = len(labels)
        for i, label in enumerate(labels):
            cx = (i + 0.5) / n
            if i == plus_index:
                self.pill(cx - 0.036, fy + 0.012, 0.072, 0.034, radius=14, fill=WHITE)
                self.text(cx, fy + 0.029, "+", size=40, anchor="mm", fill=BLACK)
            else:
                self.text(cx, fy + 0.03, label, size=30, anchor="mm")

    def music_line(self, fx: float, fy: float, s: str) -> None:
        self.text(fx, fy, glyph("music"), size=30, anchor="lm")
        self.text(fx + 0.04, fy, s, size=28, anchor="lm")

    def icon(self, fx: float, fy: float, name: str, size: int = 44, anchor: str = "mm") -> None:
        self.text(fx, fy, glyph(name), size=size, anchor=anchor)

    def save(self, key: str) -> Path:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path = OUT_DIR / f"{key}.png"
        self.img.save(path, "PNG", optimize=True)
        return path


# ---------------------------------------------------------------------------
# per-platform layouts (fractions match app/data/safe_zones.json zone rects)
# ---------------------------------------------------------------------------


def draw_generic() -> Canvas:
    c = Canvas()
    c.status_bar()
    c.text(0.5, 0.055, "Feed", size=36, anchor="mm", bold=True)
    c.hline(0.42, 0.58, 0.072, width=4)
    # right column: 0.85–1.0 × 0.35–0.70
    c.action_column(
        0.925, 0.385,
        [(0.46, "like", "12.3w"), (0.535, "comment", "3456"), (0.61, "share", "Share")],
        disc_y=0.675,
    )
    # bottom: 0.78–1.0
    c.text(0.05, 0.80, "@brand", size=36, bold=True)
    c.caption_line(0.05, 0.835, 0.6)
    c.caption_line(0.05, 0.86, 0.42)
    c.music_line(0.05, 0.90, "Original sound - brand")
    c.pill(0.05, 0.925, 0.7, 0.045, radius=16, fill=WHITE)
    c.text(0.4, 0.9475, "Learn more", size=34, anchor="mm", fill=BLACK)
    return c


def draw_douyin() -> Canvas:
    c = Canvas()
    c.status_bar()
    # top nav: 0–0.10
    c.icon(0.08, 0.062, "menu", anchor="lm")
    for fx, label, active in ((0.30, "Follow", False), (0.44, "Friends", False),
                              (0.585, "For You", True), (0.73, "Local", False)):
        c.text(fx, 0.062, label, size=32, anchor="mm", bold=active)
    c.hline(0.535, 0.635, 0.082, width=5)
    c.icon(0.92, 0.062, "search", anchor="rm")
    # right column: 0.84–1.0 × 0.42–0.78
    c.action_column(
        0.92, 0.448,
        [(0.518, "like", "12.3w"), (0.583, "comment", "3456"), (0.648, "star", "8901"), (0.713, "share", "Share")],
        disc_y=0.772,
    )
    # bottom-left: 0.72–0.94 (x ≤ 0.84)
    c.text(0.05, 0.775, "@brand_official", size=38, bold=True)
    c.caption_line(0.05, 0.815, 0.68)
    c.caption_line(0.05, 0.842, 0.5)
    c.music_line(0.05, 0.878, "Original sound - brand")
    c.pill(0.05, 0.895, 0.74, 0.036, radius=10, fill=WHITE)
    c.text(0.42, 0.913, "Download  >", size=32, anchor="mm", fill=BLACK)
    # tab bar: 0.94–1.0
    c.tab_bar(["Home", "Friends", "+", "Inbox", "Me"])
    return c


def draw_kuaishou() -> Canvas:
    c = Canvas()
    c.status_bar()
    # top nav: 0–0.09
    c.icon(0.07, 0.058, "menu", anchor="lm")
    for fx, label, active in ((0.33, "Follow", False), (0.5, "Discover", True), (0.67, "Nearby", False)):
        c.text(fx, 0.058, label, size=32, anchor="mm", bold=active)
    c.hline(0.45, 0.55, 0.078, width=5)
    c.icon(0.93, 0.058, "search", anchor="rm")
    # right column: 0.85–1.0 × 0.40–0.76
    c.action_column(
        0.925, 0.428,
        [(0.498, "like", "9.8w"), (0.563, "comment", "2345"), (0.628, "share", "Share"), (0.693, "star", "Save")],
        disc_y=0.752,
    )
    # bottom: 0.70–1.0 (x ≤ 0.85)
    c.text(0.05, 0.745, "@brand", size=38, bold=True)
    c.pill(0.30, 0.741, 0.14, 0.03, radius=10)
    c.text(0.37, 0.756, "Follow", size=28, anchor="mm")
    c.caption_line(0.05, 0.785, 0.7)
    c.caption_line(0.05, 0.812, 0.5)
    c.music_line(0.05, 0.848, "Original sound")
    # conversion component (CTA card)
    c.pill(0.05, 0.868, 0.76, 0.05, radius=14, fill=WHITE)
    c.text(0.09, 0.893, "Get the app", size=34, anchor="lm", fill=BLACK)
    c.text(0.77, 0.893, ">", size=36, anchor="rm", fill=BLACK)
    c.tab_bar(["Home", "Local", "+", "Msg", "Me"])
    return c


def draw_tencent() -> Canvas:
    c = Canvas()
    c.status_bar()
    # top nav: 0–0.10
    c.text(0.06, 0.062, "<", size=44, anchor="lm")
    for fx, label, active in ((0.33, "Follow", False), (0.5, "Friends", False), (0.67, "Trending", True)):
        c.text(fx, 0.062, label, size=32, anchor="mm", bold=active)
    c.hline(0.61, 0.73, 0.082, width=5)
    c.icon(0.94, 0.062, "search", anchor="rm")
    # right column: 0.86–1.0 × 0.45–0.77
    c.action_column(
        0.93, 0.478,
        [(0.548, "like", "3.2w"), (0.613, "comment", "1234"), (0.678, "share", "Share")],
        disc_y=None,
    )
    c.icon(0.93, 0.745, "comment", size=48)
    # bottom: 0.74–1.0 (x ≤ 0.86)
    c.circle(0.085, 0.775, 34)
    c.text(0.14, 0.775, "Brand Channel", size=36, anchor="lm", bold=True)
    c.pill(0.60, 0.76, 0.16, 0.03, radius=10)
    c.text(0.68, 0.775, "Follow", size=28, anchor="mm")
    c.caption_line(0.05, 0.808, 0.72)
    c.caption_line(0.05, 0.835, 0.52)
    c.pill(0.05, 0.862, 0.08, 0.022, radius=6)
    c.text(0.09, 0.873, "Ad", size=22, anchor="mm")
    c.text(0.15, 0.873, "Sponsored · Learn more >", size=26, anchor="lm")
    c.pill(0.05, 0.895, 0.76, 0.036, radius=10, fill=WHITE)
    c.text(0.43, 0.913, "Learn more", size=32, anchor="mm", fill=BLACK)
    c.tab_bar(["Chats", "Contacts", "+", "Discover", "Me"], plus_index=None)
    return c


def draw_meta() -> Canvas:
    c = Canvas()
    c.status_bar()
    # top title: 0–0.14
    c.text(0.06, 0.085, "Reels", size=48, anchor="lm", bold=True)
    c.circle(0.91, 0.085, 30, fill=None, outline=WHITE)
    c.circle(0.91, 0.085, 12, fill=WHITE, outline=None)
    # right column: 0.86–1.0 × 0.40–0.70
    c.button_icon(0.93, 0.43, 38, "12.3K", "like")
    c.button_icon(0.93, 0.5, 38, "456", "comment")
    c.button_icon(0.93, 0.57, 38, "Share", "share")
    c.icon(0.93, 0.635, "comment", size=48)
    c.spinning_disc(0.93, 0.68, r=34)
    # bottom: 0.65–1.0
    c.circle(0.08, 0.735, 34)
    c.text(0.135, 0.735, "brand_official", size=36, anchor="lm", bold=True)
    c.pill(0.52, 0.72, 0.16, 0.03, radius=8)
    c.text(0.60, 0.735, "Follow", size=28, anchor="mm")
    c.caption_line(0.05, 0.768, 0.72)
    c.caption_line(0.05, 0.795, 0.46)
    c.music_line(0.05, 0.832, "brand · Original audio")
    c.pill(0.05, 0.855, 0.9, 0.05, radius=14, fill=WHITE)
    c.text(0.09, 0.88, "Shop now", size=34, anchor="lm", fill=BLACK)
    c.text(0.91, 0.88, ">", size=36, anchor="rm", fill=BLACK)
    c.tab_bar(["Home", "Search", "+", "Reels", "Profile"])
    return c


def draw_google() -> Canvas:
    c = Canvas()
    c.status_bar()
    # top nav: 0–0.10
    c.text(0.06, 0.062, "Shorts", size=44, anchor="lm", bold=True)
    c.icon(0.76, 0.062, "search")
    c.circle(0.85, 0.062, 22, fill=None, outline=WHITE)
    c.icon(0.94, 0.062, "more")
    # right column: 0.85–1.0 × 0.42–0.76
    c.button_icon(0.925, 0.445, 36, "12K", "up")
    c.button_icon(0.925, 0.508, 36, "Dislike", "down")
    c.button_icon(0.925, 0.571, 36, "456", "comment")
    c.button_icon(0.925, 0.634, 36, "Share", "share")
    c.button_icon(0.925, 0.697, 36, "Remix", "remix")
    c.spinning_disc(0.925, 0.755, r=30)
    # bottom: 0.78–1.0 (x ≤ 0.85)
    c.caption_line(0.05, 0.795, 0.72, height=30)
    c.caption_line(0.05, 0.828, 0.5, height=30)
    c.circle(0.085, 0.875, 34)
    c.text(0.14, 0.875, "@brand", size=36, anchor="lm", bold=True)
    c.pill(0.44, 0.86, 0.22, 0.03, radius=20, fill=WHITE)
    c.text(0.55, 0.875, "Subscribe", size=28, anchor="mm", fill=BLACK)
    c.music_line(0.05, 0.915, "Original sound - brand")
    c.tab_bar(["Home", "Shorts", "+", "Subs", "You"])
    return c


DRAWERS = {
    "generic-vertical": draw_generic,
    "douyin": draw_douyin,
    "kuaishou": draw_kuaishou,
    "tencent": draw_tencent,
    "meta": draw_meta,
    "google": draw_google,
}


def main(argv: list[str]) -> int:
    keys = argv[1:] or list(DRAWERS)
    print(f"font: {_FONT_FILE or 'Pillow default'}")
    for key in keys:
        if key not in DRAWERS:
            print(f"unknown overlay key: {key}", file=sys.stderr)
            return 2
        path = DRAWERS[key]().save(key)
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

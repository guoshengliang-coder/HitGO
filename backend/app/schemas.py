"""Pydantic v2 schemas: request bodies, response models and the strict EditSpec (contract §2).

EditSpec validation that needs the video duration (trim ranges within [0, duration])
is done through the Pydantic validation context: ``EditSpec.model_validate(data,
context={"duration": 24.6})``. Without a context the range-vs-duration check is skipped.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

# ---------------------------------------------------------------------------
# EditSpec
# ---------------------------------------------------------------------------

Anchor = Literal[
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]
ANCHORS: tuple[str, ...] = Anchor.__args__  # type: ignore[attr-defined]

Aspect = Literal["9:16", "1:1", "4:5", "16:9"]
OutputAspect = Literal["9:16", "1:1", "4:5", "16:9", "custom"]
Fill = Literal["blur", "color", "crop"]
# Video sticker shorter than its time window: loop it, hold the last frame, or let it end.
Playback = Literal["loop", "freeze", "once"]

# Shortest in-asset trim a sticker layer may keep (contract §2, HIG-67).
MIN_SOURCE_SEGMENT = 0.1
Quality = Literal["standard", "high"]
LayerMode = Literal["replace", "style_only"]
# How layers sit on a non-reference output (HIG-29): "canvas" = relative to that canvas (the
# original behaviour); "video" = follow where the video frame lands, see services/layout.fit_map.
LayerFit = Literal["canvas", "video"]

CANVAS_SIZES: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "16:9": (1920, 1080),
}

DEFAULT_VARIANT_KEY = "9x16"

_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
_HEX_COLOR_6 = re.compile(r"^#[0-9a-fA-F]{6}$")
_VARIANT_KEY = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

Margin = tuple[float, float]
TimeWindow = tuple[float, float]


def _check_time_window(t: Any) -> Any:
    if t == "all":
        return t
    a, b = t
    if a < 0:
        raise ValueError("出现时段起点不能小于 0")
    if b <= a:
        raise ValueError("出现时段终点必须大于起点")
    return (float(a), float(b))


# Longest track / layer label the editor can store (HIG-48).
TRACK_NAME_MAX = 64

# Audio track tempo range (HIG-75). A single atempo covers 0.5–2.0, so no filter chaining is needed.
TRACK_SPEED_MIN = 0.5
TRACK_SPEED_MAX = 2.0

# Text boxes may be wider than the canvas (HIG-37): the part outside the frame is cropped.
# Stickers and masks stay within one canvas width.
TEXT_WIDTH_MAX = 3.0


class LayerBase(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=64)
    anchor: Anchor = "top-left"
    margin: Margin = (0.0, 0.0)
    width: float = Field(default=0.3, gt=0, le=1.0)
    rotate: float = Field(default=0.0, ge=-360, le=360)
    opacity: float = Field(default=1.0, ge=0, le=1)
    t: Literal["all"] | TimeWindow = "all"
    # Eye switched off in the editor (HIG-33): kept in the spec, left out of the output.
    hidden: bool = False
    # Track label the user typed on the timeline (HIG-48); the worker ignores it.
    name: str | None = Field(default=None, max_length=TRACK_NAME_MAX)

    @field_validator("t")
    @classmethod
    def _validate_t(cls, v: Any) -> Any:
        return _check_time_window(v)


class StickerLayer(LayerBase):
    type: Literal["sticker"]
    asset_id: str = Field(min_length=1)
    # Only meaningful for video stickers (Asset.kind == "video"); still images ignore it.
    playback: Playback = "loop"
    # Mix the sticker's own audio into the output (contract §2); needs Asset.has_audio.
    mix_audio: bool = False
    # In-asset trim (contract §2, HIG-67): take [source_in, source_out) of the asset's own
    # timeline instead of starting at its 0 s. Video assets only; None = the whole asset.
    # playback applies *after* this, so loop repeats the trimmed piece, not the whole asset.
    source_in: float | None = Field(default=None, ge=0)
    source_out: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _check_source_range(self) -> StickerLayer:
        if self.source_out is not None:
            start = self.source_in or 0.0
            if self.source_out - start < MIN_SOURCE_SEGMENT - 1e-6:
                raise ValueError("素材内裁剪长度至少为 0.1 秒")
        return self


class TextShadow(BaseModel):
    """Drop shadow of a text layer; rendered by the frontend into the PNG (contract §2)."""

    model_config = ConfigDict(extra="ignore")

    color: str = "#000000"
    blur: float = Field(default=0.0, ge=0)  # relative to canvas height
    offset: tuple[float, float] = (0.0, 0.0)  # [x, y], relative to canvas height


class TextGlow(BaseModel):
    """Glow (centered blurred halo) of a text layer; rendered by the frontend into the PNG (contract §2)."""

    model_config = ConfigDict(extra="ignore")

    color: str = "#FFFFFF"
    blur: float = Field(default=0.0, ge=0)  # halo radius, relative to canvas height


class TextStyle(BaseModel):
    """Frontend-owned; the worker only consumes the pre-rendered PNG. Kept loose on purpose."""

    model_config = ConfigDict(extra="allow")

    font_family: str | None = None
    font_weight: int | str | None = None
    font_size: float | None = Field(default=None, gt=0)
    color: str | None = None
    stroke_color: str | None = None
    stroke_width: float | None = Field(default=None, ge=0)
    background: str | None = None
    padding: float | None = Field(default=None, ge=0)
    align: Literal["left", "center", "right"] | None = None
    line_height: float | None = Field(default=None, gt=0)
    shadow: TextShadow | None = None
    glow: TextGlow | None = None
    letter_spacing: float | None = None  # em units; negative tightens
    background_width: float | None = Field(default=None, gt=0, le=1)  # relative to canvas width; None = hug text
    background_radius: float | None = Field(default=None, ge=0)  # relative to canvas height; None = auto
    wrap_width: float | None = Field(default=None, gt=0, le=TEXT_WIDTH_MAX)  # HIG-51 auto-wrap box, relative to canvas width (HIG-37: up to 3×); None = no wrap
    box_height: float | None = Field(default=None, gt=0, le=1)  # HIG-51 min text box height, relative to canvas height; None = hug text


class TextSpan(BaseModel):
    """A coloured run of a text layer: UTF-16 index range [start, end) of ``text`` (contract §2)."""

    model_config = ConfigDict(extra="ignore")

    start: int = Field(ge=0)
    end: int = Field(gt=0)
    color: str = Field(min_length=1)

    @model_validator(mode="after")
    def _check_range(self) -> TextSpan:
        if self.end <= self.start:
            raise ValueError("spans 区间终点必须大于起点")
        return self


def _media_url(v: str) -> str:
    if not v.startswith("/media/"):
        raise ValueError("image_url 必须是 /media/ 开头的站内路径")
    return v


class VariantImage(BaseModel):
    """The text PNG re-rendered for one output (HIG-29): same text, drawn at that output's pixel size."""

    model_config = ConfigDict(extra="ignore")

    url: str
    size: tuple[int, int]
    background_url: str | None = None  # HIG-45: this output's background-only PNG, same size

    @field_validator("url")
    @classmethod
    def _validate_url(cls, v: str) -> str:
        return _media_url(v)

    @field_validator("background_url")
    @classmethod
    def _validate_background_url(cls, v: str | None) -> str | None:
        return _media_url(v) if v else None

    @field_validator("size")
    @classmethod
    def _validate_size(cls, v: tuple[int, int]) -> tuple[int, int]:
        if v[0] <= 0 or v[1] <= 0:
            raise ValueError("size 必须为正整数")
        return v


AnimMovePreset = Literal["fade", "slide_up", "slide_down", "slide_left", "slide_right", "pop"]
AnimLoopPreset = Literal["breathe", "float", "blink"]
# Speed curves (HIG-44). back / elastic / bounce settle at the end of an enter and start the
# exit with the mirrored motion; see services/animation.py.
AnimEasing = Literal["linear", "ease_in", "ease_out", "ease_in_out", "back", "elastic", "bounce"]
# Reveal curves only move forwards (HIG-45): the glyph times come from the inverse curve.
RevealEasing = Literal["linear", "ease_in", "ease_out", "ease_in_out"]
RevealPreset = Literal["typewriter", "fade_chars", "wipe"]
ANIM_MAX_SECONDS = 10.0
REVEAL_MAX_SECONDS = 30.0
GLYPH_LAYOUT_MAX_UNITS = 1000


class TextAnimPhase(BaseModel):
    """Enter / exit animation of a text layer (HIG-40); curves in services/animation.py.

    Everything past ``duration`` is optional (HIG-44) and defaults to the v0.16.0 motion.
    """

    model_config = ConfigDict(extra="ignore")

    preset: AnimMovePreset
    duration: float = Field(default=0.5, gt=0, le=ANIM_MAX_SECONDS)
    easing: AnimEasing | None = None  # None = the preset's own curve
    distance: float = Field(default=0.05, ge=0, le=0.5)  # slides; fraction of the canvas height
    fade: bool = True  # slides also fade
    scale: float = Field(default=0.5, ge=0.1, le=3)  # pop: enter starts at / exit ends at this scale
    overshoot: float = Field(default=1.70158, ge=0, le=5)  # easing "back" only
    delay: float = Field(default=0.0, ge=0, le=ANIM_MAX_SECONDS)  # enter only; ignored on the exit


class TextAnimLoop(BaseModel):
    """Loop animation between the end of the enter and the start of the exit (HIG-40)."""

    model_config = ConfigDict(extra="ignore")

    preset: AnimLoopPreset
    period: float = Field(default=1.2, ge=0.2, le=ANIM_MAX_SECONDS)
    amount: float = Field(default=1.0, ge=0, le=3)  # HIG-44: multiplies the preset's amplitude


class TextReveal(BaseModel):
    """Glyph-by-glyph reveal (HIG-45), drawn from ``TextLayer.glyph_layout``; see services/reveal.py."""

    model_config = ConfigDict(extra="ignore")

    preset: RevealPreset
    duration: float = Field(default=1.0, gt=0, le=REVEAL_MAX_SECONDS)
    unit: Literal["char", "word"] = "char"  # frontend only: how glyph_layout was grouped
    cursor: bool = False  # typewriter only
    easing: RevealEasing = "linear"


class TextAnimation(BaseModel):
    # "in" is a Python keyword, hence the aliases; the contract field names are in / out / loop.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    enter: TextAnimPhase | None = Field(default=None, alias="in")
    exit: TextAnimPhase | None = Field(default=None, alias="out")
    loop: TextAnimLoop | None = None
    reveal: TextReveal | None = None  # HIG-45

    @property
    def active(self) -> bool:
        return self.enter is not None or self.exit is not None or self.loop is not None

    @property
    def delay(self) -> float:
        return self.enter.delay if self.enter else 0.0


class GlyphLine(BaseModel):
    """One line of the text PNG: its box and the ink box of each unit, as fractions of the PNG."""

    model_config = ConfigDict(extra="ignore")

    top: float = Field(ge=0, le=1)
    bottom: float = Field(ge=0, le=1)
    rtl: bool = False
    units: list[tuple[float, float]] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> GlyphLine:
        if self.bottom <= self.top:
            raise ValueError("glyph_layout 行的 bottom 必须大于 top")
        for left, right in self.units:
            if not (0 <= left <= right <= 1):
                raise ValueError("glyph_layout 字位置必须满足 0 ≤ left ≤ right ≤ 1")
        return self


class GlyphLayout(BaseModel):
    """Where each reveal unit sits in the text PNG (HIG-45). Units are listed in reveal order."""

    model_config = ConfigDict(extra="ignore")

    lines: list[GlyphLine] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> GlyphLayout:
        if sum(len(line.units) for line in self.lines) > GLYPH_LAYOUT_MAX_UNITS:
            raise ValueError(f"glyph_layout 最多 {GLYPH_LAYOUT_MAX_UNITS} 个字")
        for prev, cur in zip(self.lines, self.lines[1:]):
            if cur.top < prev.top:
                raise ValueError("glyph_layout 的行必须自上而下排列")
        return self

    @property
    def count(self) -> int:
        return sum(len(line.units) for line in self.lines)


ScrollStart = Literal["enter", "visible"]
ScrollEnd = Literal["exit", "stay"]
SCROLL_MAX_HOLD = 60.0
# Generic portrait safe area (contract §2 scroll.box default): clear of the top status bar and
# the bottom caption / action strip on the common short-video apps.
DEFAULT_SCROLL_BOX = {"x": 0.06, "y": 0.14, "w": 0.88, "h": 0.60}


class ScrollBox(BaseModel):
    """Clip rectangle of a scrolling text layer, relative to the canvas (contract §2)."""

    model_config = ConfigDict(extra="ignore")

    x: float = Field(ge=0, lt=1)
    y: float = Field(ge=0, lt=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def _inside_canvas(self) -> ScrollBox:
        if self.x + self.w > 1 + 1e-6:
            raise ValueError("scroll.box 超出画布右边界（x + w 必须 ≤ 1）")
        if self.y + self.h > 1 + 1e-6:
            raise ValueError("scroll.box 超出画布下边界（y + h 必须 ≤ 1）")
        return self


class TextScroll(BaseModel):
    """Scrolling copy inside a clip box (HIG-50 大字报); curve in services/scroll.py."""

    model_config = ConfigDict(extra="ignore")

    speed: float = Field(default=0.08, gt=0, le=2)  # canvas heights per second
    box: ScrollBox = Field(default_factory=lambda: ScrollBox(**DEFAULT_SCROLL_BOX))
    start: ScrollStart = "enter"
    end: ScrollEnd = "exit"
    hold_start: float = Field(default=0, ge=0, le=SCROLL_MAX_HOLD)
    hold_end: float = Field(default=0, ge=0, le=SCROLL_MAX_HOLD)


class TextLayer(LayerBase):
    type: Literal["text"]
    width: float = Field(default=0.3, gt=0, le=TEXT_WIDTH_MAX)  # HIG-37: may exceed the canvas width
    text: str = ""
    style: TextStyle | None = None
    spans: list[TextSpan] | None = None
    image_url: str | None = None
    image_size: tuple[int, int] | None = None
    # Per-output PNGs keyed by variant_key; missing / unresolvable entries fall back to image_url.
    variant_images: dict[str, VariantImage] | None = None
    animation: TextAnimation | None = None  # HIG-40
    scroll: TextScroll | None = None  # HIG-50
    # HIG-45 reveal: unit positions in the PNG, and the background block alone (same size as the PNG).
    glyph_layout: GlyphLayout | None = None
    background_image: str | None = None

    @model_validator(mode="after")
    def _scroll_excludes_animation(self) -> TextLayer:
        if self.scroll is not None and self.animation is not None and (self.animation.active or self.animation.reveal is not None):
            raise ValueError(f"文字图层 {self.id}：滚动（scroll）与动画（animation）不能同时设置")
        return self

    @model_validator(mode="after")
    def _animation_fits_window(self) -> TextLayer:
        anim = self.animation
        if anim is None or self.t == "all":
            return self
        enter = (anim.enter.delay + anim.enter.duration) if anim.enter else 0.0
        total = enter + (anim.exit.duration if anim.exit else 0.0)
        if total > (self.t[1] - self.t[0]) + 1e-6:
            raise ValueError(f"文字图层 {self.id}：入场延迟、入场加出场动画时长不能超过出现时段长度")
        return self

    @field_validator("background_image")
    @classmethod
    def _validate_background_image(cls, v: str | None) -> str | None:
        return _media_url(v) if v else None

    @field_validator("variant_images")
    @classmethod
    def _validate_variant_images(cls, v: dict[str, VariantImage] | None) -> dict[str, VariantImage] | None:
        for key in v or {}:
            if not _VARIANT_KEY.match(key):
                raise ValueError("variant_images 的键必须是合法的 variant_key")
        return v or None

    @field_validator("spans")
    @classmethod
    def _validate_spans(cls, v: list[TextSpan] | None) -> list[TextSpan] | None:
        if not v:
            return v
        for prev, cur in zip(v, v[1:]):
            if cur.start < prev.end:
                raise ValueError("spans 区间必须升序且互不重叠")
        return v

    @field_validator("image_url")
    @classmethod
    def _validate_image_url(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        return _media_url(v)

    @field_validator("image_size")
    @classmethod
    def _validate_image_size(cls, v: tuple[int, int] | None) -> tuple[int, int] | None:
        if v is not None and (v[0] <= 0 or v[1] <= 0):
            raise ValueError("image_size 必须为正整数")
        return v


class ShapeLayer(LayerBase):
    """Editable geometry, rasterized by the editor for the existing PNG overlay path."""

    type: Literal["shape"]
    shape: Literal["rect", "ellipse", "triangle", "line", "arrow", "star"]
    height: float = Field(default=0.12, gt=0, le=1.0)
    fill: str = "#E3312B"
    stroke: str = "#FFFFFF"
    stroke_width: float = Field(default=0.004, ge=0, le=0.1)
    radius: float = Field(default=0.02, ge=0, le=0.5)
    flip_x: bool = False
    flip_y: bool = False
    image_url: str | None = None
    image_size: tuple[int, int] | None = None

    @field_validator("fill", "stroke")
    @classmethod
    def _validate_shape_color(cls, v: str) -> str:
        if not _HEX_COLOR_6.fullmatch(v):
            raise ValueError("图形颜色必须是 #RRGGBB 形式")
        return v

    @field_validator("image_url")
    @classmethod
    def _validate_image_url(cls, v: str | None) -> str | None:
        return _media_url(v) if v else None


MaskMode = Literal["blur", "solid"]


class MaskLayer(LayerBase):
    """A region of the frame blurred or covered by a solid box (contract §2), e.g. over burnt-in
    subtitles. No media behind it: ``height`` is relative to the canvas height and ``rotate`` is
    ignored by the worker."""

    type: Literal["mask"]
    height: float = Field(default=0.12, gt=0, le=1.0)
    mode: MaskMode = "blur"
    blur: int = Field(default=2, ge=1, le=3)  # strength level, blur mode only
    color: str = "#000000"  # solid mode only; the alpha comes from ``opacity``

    @field_validator("color")
    @classmethod
    def _validate_color(cls, v: str) -> str:
        if not _HEX_COLOR_6.match(v):
            raise ValueError("color 必须是 #RRGGBB 形式")
        return v


Layer = Annotated[StickerLayer | TextLayer | MaskLayer | ShapeLayer, Field(discriminator="type")]


class LayerOverride(BaseModel):
    """Per-variant override; only these six keys are allowed (contract §2). ``height`` only
    means something for mask layers."""

    model_config = ConfigDict(extra="forbid")

    anchor: Anchor | None = None
    margin: Margin | None = None
    width: float | None = Field(default=None, gt=0, le=TEXT_WIDTH_MAX)  # ≤ 1 unless the layer is text (checked on EditSpec)
    height: float | None = Field(default=None, gt=0, le=1.0)
    rotate: float | None = Field(default=None, ge=-360, le=360)
    opacity: float | None = Field(default=None, ge=0, le=1)

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.model_dump().items() if v is not None}

    @property
    def detaches(self) -> bool:
        """Any geometry key set → the layer no longer follows the video on this output."""
        return any(v is not None for v in (self.anchor, self.margin, self.width, self.height))


class CropRect(BaseModel):
    """Source-frame crop window for fill="crop" (contract §2): x/y/w/h relative to the source width/height."""

    model_config = ConfigDict(extra="ignore")

    x: float = Field(default=0.0, ge=0, le=1)
    y: float = Field(default=0.0, ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def _inside_frame(self) -> "CropRect":
        if self.x + self.w > 1 + 1e-6:
            raise ValueError("crop 矩形超出源画面右边界（x + w 必须 ≤ 1）")
        if self.y + self.h > 1 + 1e-6:
            raise ValueError("crop 矩形超出源画面下边界（y + h 必须 ≤ 1）")
        return self


class OutputVariant(BaseModel):
    model_config = ConfigDict(extra="ignore")

    variant_key: str
    aspect: OutputAspect
    width: int | None = Field(default=None, ge=2)
    height: int | None = Field(default=None, ge=2)
    fill: Fill = "blur"
    color: str = "#000000"
    quality: Quality = "standard"
    crop: CropRect | None = None  # only honoured when fill == "crop"; None = centred cover crop
    # Blurred backdrop (HIG-54), only honoured when fill == "blur": strength 0–100 and the
    # backdrop brightness in percent (100 = not dimmed). Old specs get the stronger defaults.
    blur: int = Field(default=60, ge=0, le=100)
    bg_brightness: int = Field(default=50, ge=20, le=100)
    layer_fit: LayerFit = "canvas"
    layer_overrides: dict[str, LayerOverride] = Field(default_factory=dict)
    # Editor preference (HIG-35): is this output ticked for export? None = only 9x16 is.
    # The worker ignores it; POST /api/render's variant_keys decides what gets rendered.
    export: bool | None = None

    @field_validator("variant_key")
    @classmethod
    def _validate_key(cls, v: str) -> str:
        if not _VARIANT_KEY.match(v):
            raise ValueError("variant_key 只能包含字母、数字、下划线和中划线")
        return v

    @field_validator("color")
    @classmethod
    def _validate_color(cls, v: str) -> str:
        if not _HEX_COLOR.match(v):
            raise ValueError("color 必须是 #RRGGBB 形式")
        return v

    @model_validator(mode="after")
    def _validate_canvas(self) -> "OutputVariant":
        if self.aspect == "custom":
            if self.variant_key != "custom":
                raise ValueError("自定义画幅的 variant_key 必须是 custom")
            if self.width is None or self.height is None:
                raise ValueError("自定义画幅必须同时提供 width 和 height")
            if self.width % 2 or self.height % 2:
                raise ValueError("自定义画幅的宽高必须是偶数像素（H.264 编码要求）")
        elif self.width is not None or self.height is not None:
            raise ValueError("只有自定义画幅可以指定 width 和 height")
        elif self.variant_key == "custom":
            raise ValueError("custom 输出的 aspect 必须是 custom")
        return self

    @property
    def canvas(self) -> tuple[int, int]:
        if self.aspect == "custom":
            assert self.width is not None and self.height is not None
            return self.width, self.height
        return CANVAS_SIZES[self.aspect]


TRIM_DURATION_MAX = 600.0


class Trim(BaseModel):
    model_config = ConfigDict(extra="ignore")

    remove: list[TimeWindow] = Field(default_factory=list)
    # Output length (HIG-50): None = the post-trim length; longer loops the kept segments,
    # shorter cuts the output (contract §2).
    duration: float | None = Field(default=None, gt=0, le=TRIM_DURATION_MAX)

    @field_validator("remove")
    @classmethod
    def _validate_remove(cls, ranges: list[TimeWindow], info: ValidationInfo) -> list[TimeWindow]:
        duration = (info.context or {}).get("duration") if info.context else None
        prev_end = -1.0
        for i, (a, b) in enumerate(ranges):
            if a < 0:
                raise ValueError(f"删除区间 #{i + 1} 起点不能小于 0")
            if b <= a:
                raise ValueError(f"删除区间 #{i + 1} 终点必须大于起点")
            if a < prev_end:
                raise ValueError(f"删除区间 #{i + 1} 与前一个区间重叠或未按升序排列")
            if duration is not None and b > duration + 1e-3:
                raise ValueError(f"删除区间 #{i + 1} 超出视频时长 {duration:.2f}s")
            prev_end = b
        if duration is not None and ranges:
            removed = sum(b - a for a, b in ranges)
            if removed >= duration - 1e-3:
                raise ValueError("不能删除整条视频")
        return [(float(a), float(b)) for a, b in ranges]


AudioRole = Literal["bgm", "voice"]
# post: the file starts at the window start; source: the file is on the source timeline and
# gets the same trim.remove as the source audio (separated stems, re-recorded voice-overs).
AudioAlign = Literal["post", "source"]
SeparationModel = Literal["htdemucs", "htdemucs_ft"]


class AudioTrack(BaseModel):
    """One BGM / voice-over track mixed into the output (contract §2 ``audio.tracks[]``)."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=64)
    asset_id: str = Field(min_length=1)
    role: AudioRole = "bgm"  # UI grouping only; the worker treats every track alike
    align: AudioAlign = "post"
    t: Literal["all"] | TimeWindow = "all"
    # seconds into the file; with loop the first pass starts here, later passes at 0 (HIG-25)
    offset: float = Field(default=0.0, ge=0)
    volume: float = Field(default=1.0, ge=0, le=1)  # ≤ 1 so the browser preview can match it
    loop: bool = False
    # atempo playback rate, pitch preserved (HIG-75); 1.0 keeps the pre-HIG-75 command byte for byte
    speed: float = Field(default=1.0, ge=TRACK_SPEED_MIN, le=TRACK_SPEED_MAX)
    fade_in: float = Field(default=0.0, ge=0)
    fade_out: float = Field(default=0.0, ge=0)
    hidden: bool = False  # eye off (HIG-33): not mixed in, not reported as skipped
    name: str | None = Field(default=None, max_length=TRACK_NAME_MAX)  # timeline label (HIG-48)

    @field_validator("t")
    @classmethod
    def _validate_t(cls, v: Any) -> Any:
        return _check_time_window(v)

    @model_validator(mode="after")
    def _cross_checks(self) -> AudioTrack:
        if self.align == "source" and (self.loop or self.offset > 0):
            raise ValueError(f"音轨 {self.id}：对齐源时间轴的音轨不能循环，起始偏移必须为 0")
        # Source-aligned tracks ride the source timeline; any tempo change would desync the whole track.
        if self.align == "source" and abs(self.speed - 1.0) > 1e-6:
            raise ValueError(f"音轨 {self.id}：对齐源时间轴的音轨不能变速")
        if self.t != "all" and self.fade_in + self.fade_out > (self.t[1] - self.t[0]) + 1e-6:
            raise ValueError(f"音轨 {self.id}：淡入加淡出不能超过时段长度")
        return self


class AudioSpec(BaseModel):
    """Contract §2 ``audio``: source track gain plus the mixed-in tracks."""

    model_config = ConfigDict(extra="ignore")

    source_volume: float = Field(default=1.0, ge=0, le=1)
    # Post-trim spans where the source audio is silenced, picture untouched (HIG-25).
    source_mute: list[TimeWindow] = Field(default_factory=list)
    tracks: list[AudioTrack] = Field(default_factory=list)
    # Eye off on the source track (HIG-33): no source audio in the output, source_volume kept.
    source_hidden: bool = False
    # Timeline label of the source track (HIG-48); the worker ignores it.
    source_name: str | None = Field(default=None, max_length=TRACK_NAME_MAX)

    @field_validator("source_mute")
    @classmethod
    def _validate_source_mute(cls, ranges: list[TimeWindow]) -> list[TimeWindow]:
        prev_end = -1.0
        for i, (a, b) in enumerate(ranges):
            if a < 0:
                raise ValueError(f"原声静音区间 #{i + 1} 起点不能小于 0")
            if b <= a:
                raise ValueError(f"原声静音区间 #{i + 1} 终点必须大于起点")
            if a < prev_end:
                raise ValueError(f"原声静音区间 #{i + 1} 与前一个区间重叠或未按升序排列")
            prev_end = b
        return [(float(a), float(b)) for a, b in ranges]

    @field_validator("tracks")
    @classmethod
    def _unique_ids(cls, v: list[AudioTrack]) -> list[AudioTrack]:
        ids = [t.id for t in v]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"音轨 id 重复：{', '.join(dupes)}")
        return v


COVER_MIN_DURATION = 0.1
COVER_MAX_DURATION = 10.0


class CoverSpec(BaseModel):
    """Contract §2 ``cover``: an image or video inserted before the (trimmed) main video."""

    model_config = ConfigDict(extra="ignore")

    asset_id: str = Field(min_length=1)  # Asset.type = "sticker", image or video
    # Seconds an image cover stays on screen; a video cover always plays its own full length.
    duration: float = Field(default=1.0, ge=COVER_MIN_DURATION, le=COVER_MAX_DURATION)


class ClipTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["cut", "fade", "slide_left", "slide_right", "wipe_left", "wipe_right"] = "cut"
    duration: float = Field(default=0, ge=0, le=1.5)

    @model_validator(mode="after")
    def _check_duration(self) -> ClipTransition:
        if self.type == "cut" and self.duration != 0:
            raise ValueError("硬切的转场时长必须为 0")
        if self.type != "cut" and self.duration < 0.1:
            raise ValueError("视觉转场时长至少为 0.1 秒")
        return self


class SequenceClip(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, max_length=64)
    video_id: str = Field(min_length=1)
    source_in: float = Field(alias="in", ge=0)
    source_out: float = Field(alias="out", gt=0)
    # None distinguishes legacy sequences whose owner gain was stored as master gain.
    source_volume: float | None = Field(default=None, ge=0, le=1)
    transition: ClipTransition | None = None

    @model_validator(mode="after")
    def _check_range(self) -> SequenceClip:
        if self.source_out - self.source_in < 0.1 - 1e-6:
            raise ValueError("片段时长至少为 0.1 秒")
        return self


class SequenceSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clips: list[SequenceClip] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_clips(self) -> SequenceSpec:
        ids = [clip.id for clip in self.clips]
        if len(ids) != len(set(ids)):
            raise ValueError("片段 id 不能重复")
        if self.clips[0].transition is not None:
            raise ValueError("第一段不能设置入场转场")
        for previous, clip in zip(self.clips, self.clips[1:]):
            transition = clip.transition
            if transition and transition.duration >= min(
                previous.source_out - previous.source_in,
                clip.source_out - clip.source_in,
            ) - 1e-6:
                raise ValueError("转场时长必须小于相邻片段时长")
        return self

    @property
    def duration(self) -> float:
        return sum(c.source_out - c.source_in - (c.transition.duration if c.transition else 0) for c in self.clips)


class EditSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")

    spec_version: Literal[1] = 1
    trim: Trim = Field(default_factory=Trim)
    layers: list[Layer] = Field(default_factory=list)
    outputs: list[OutputVariant] = Field(min_length=1)
    audio: AudioSpec | None = None  # None = keep the source track as-is (pre-audio behaviour)
    cover: CoverSpec | None = None  # None = no cover (pre-cover behaviour)
    sequence: SequenceSpec | None = None  # HIG-39: ordered raw source clips on this video's timeline

    @model_validator(mode="after")
    def _cross_checks(self) -> EditSpec:
        if self.sequence is not None:
            if self.trim.duration is not None:
                raise ValueError("多片段序列的成片时长必须先转换为片段")
            self.trim = Trim.model_validate(self.trim.model_dump(), context={"duration": self.sequence.duration})
        keys = [o.variant_key for o in self.outputs]
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            raise ValueError(f"variant_key 重复：{', '.join(dupes)}")
        ids = [layer.id for layer in self.layers]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"图层 id 重复：{', '.join(dupes)}")
        kinds = {layer.id: layer.type for layer in self.layers}
        for o in self.outputs:
            for layer_id, ov in o.layer_overrides.items():
                if ov.width is not None and ov.width > 1 and kinds.get(layer_id) != "text":
                    raise ValueError(f"输出 {o.variant_key}：图层 {layer_id} 的覆盖宽度不能超过 1（只有文字图层可以宽于画布）")
        return self

    def layer_by_id(self, layer_id: str) -> StickerLayer | TextLayer | MaskLayer | ShapeLayer | None:
        for layer in self.layers:
            if layer.id == layer_id:
                return layer
        return None


def empty_spec() -> dict[str, Any]:
    """The 'empty spec' created by batch apply when the target had none (contract §3)."""
    return {"spec_version": 1, "trim": {"remove": []}, "layers": [], "outputs": []}


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------


class AuthIn(BaseModel):
    code: str = ""


class BatchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("批次名称不能为空")
        return v


class RenameIn(BaseModel):
    """PATCH body for renaming a batch or a video."""

    name: str = Field(min_length=1, max_length=255)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("名称不能为空")
        return v


class SpecIn(BaseModel):
    edit_spec: dict[str, Any] | None


BLANK_DURATION_DEFAULT = 10.0


class BlankVideoIn(BaseModel):
    """POST /api/batches/{id}/blank: a blank source clip (HIG-50, contract §3)."""

    name: str | None = Field(default=None, max_length=255)
    color: str = "#000000"
    duration: float = Field(default=BLANK_DURATION_DEFAULT, gt=0, le=TRIM_DURATION_MAX)
    aspect: Aspect = "9:16"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        if not _HEX_COLOR_6.match(v):
            raise ValueError("color 必须是 #RRGGBB")
        return v.upper()


TTS_TEXT_MAX = 5000


class TtsIn(BaseModel):
    """POST /api/tts (HIG-50): read a piece of copy aloud into a derived audio asset."""

    text: str = Field(min_length=1, max_length=TTS_TEXT_MAX)
    lang: str = Field(min_length=2, max_length=16)
    voice: str = Field(min_length=1, max_length=64)
    speech_rate: float = Field(default=1.0, ge=0.5, le=2.0)
    name: str | None = Field(default=None, max_length=255)

    @field_validator("text")
    @classmethod
    def _strip_text(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("文案不能为空")
        return v

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class HighlightIn(BaseModel):
    """POST /api/highlight (HIG-50): pick the phrases worth colouring in a piece of copy."""

    text: str = Field(min_length=1, max_length=TTS_TEXT_MAX)
    max_phrases: int = Field(default=8, ge=1, le=20)


class HighlightPhrase(BaseModel):
    text: str
    start: int  # UTF-16 offsets into the request text, same index space as TextSpan
    end: int


class HighlightOut(BaseModel):
    phrases: list[HighlightPhrase]


class ApplyIn(BaseModel):
    source_video_id: str
    target_video_ids: list[str] = Field(min_length=1)
    modules: list[Literal["trim", "layers", "outputs", "audio", "cover"]] = Field(min_length=1)
    layer_mode: LayerMode = "replace"


RENDER_NAME_MAX = 120


class RenderItemIn(BaseModel):
    video_id: str
    # Localize language code of this output (HIG-43); None = original / none applied.
    lang: str | None = None
    # Spec snapshot for this output only; None = the video's saved spec at run time.
    edit_spec: dict[str, Any] | None = None


class RenderIn(BaseModel):
    video_ids: list[str] | None = Field(default=None, min_length=1)
    # HIG-43: one entry per (video, language); exclusive with video_ids.
    items: list[RenderItemIn] | None = Field(default=None, min_length=1)
    name: str | None = None
    # Only render these outputs (HIG-29); None = every output in each video's spec.
    variant_keys: list[str] | None = Field(default=None, min_length=1)
    output_format: Literal["source", "mp4", "mov", "png", "jpg"] = "mp4"

    @model_validator(mode="after")
    def _one_source(self) -> RenderIn:
        if (self.video_ids is None) == (self.items is None):
            raise ValueError("video_ids 与 items 需要且只能填一个")
        return self

    def planned_items(self) -> list[RenderItemIn]:
        if self.items is not None:
            return self.items
        return [RenderItemIn(video_id=v) for v in self.video_ids or []]

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if len(v) > RENDER_NAME_MAX:
            raise ValueError(f"导出名称最多 {RENDER_NAME_MAX} 个字符")
        return v or None


PRESET_TYPES: frozenset[str] = frozenset({"text_style"})


class PresetIn(BaseModel):
    type: str
    name: str = Field(min_length=1, max_length=40)
    data: dict[str, Any] = Field(default_factory=dict)

    @field_validator("type")
    @classmethod
    def _validate_type(cls, v: str) -> str:
        if v not in PRESET_TYPES:
            raise ValueError(f"type 必须是 {' | '.join(sorted(PRESET_TYPES))}")
        return v

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("预设名称不能为空")
        if len(v) > 40:
            raise ValueError("预设名称最多 40 个字符")
        return v


# ---------------------------------------------------------------------------
# Response models (contract §1)
# ---------------------------------------------------------------------------


class AuthOut(BaseModel):
    required: bool
    ok: bool


class SpriteOut(BaseModel):
    url: str
    interval: float
    tile_width: int
    tile_height: int
    columns: int
    count: int


class SeparateIn(BaseModel):
    model: SeparationModel = "htdemucs"


class SeparationOut(BaseModel):
    status: str
    model: str
    error: str | None = None
    vocals_asset_id: str | None = None
    instrumental_asset_id: str | None = None
    updated_at: str | None = None


# --- localization (contract §1 Video.localization, §3 /localize) ---------------------------

LANG_CODE = Field(min_length=2, max_length=8, pattern=r"^[a-z]{2,8}$")


class TermIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source: str = Field(min_length=1, max_length=100)
    target: str = Field(min_length=1, max_length=100)


class LocalizeIn(BaseModel):
    source_lang: str = Field(default="auto", min_length=2, max_length=8)
    target_langs: list[str] = Field(min_length=1, max_length=5)
    voices: dict[str, str] | None = None
    terms: list[TermIn] = Field(default_factory=list, max_length=200)
    retranscribe: bool = False
    # False: stop after translating (HIG-56); the voice-over is a later PUT …/versions/{lang}.
    dub: bool = True
    # True: synthesize with the voice cloned from this video instead of a system one (HIG-58);
    # ``voices`` is then ignored and every target language must have options' ``clone``.
    use_source_voice: bool = False

    @field_validator("target_langs")
    @classmethod
    def _unique_langs(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for lang in v:
            lang = lang.strip()
            if lang and lang not in out:
                out.append(lang)
        if not out:
            raise ValueError("至少选择一个目标语言")
        return out


class TranscriptCueIn(BaseModel):
    i: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=2000)

    @field_validator("text")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("句子不能为空")
        return v


class TranscriptCuesIn(BaseModel):
    cues: list[TranscriptCueIn] = Field(default_factory=list, max_length=400)
    source_lang: str | None = Field(default=None, min_length=2, max_length=8)


class VersionCueIn(BaseModel):
    i: int = Field(ge=0)
    translated: str = Field(min_length=1, max_length=2000)

    @field_validator("translated")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("译文不能为空")
        return v


class VersionCuesIn(BaseModel):
    cues: list[VersionCueIn] = Field(default_factory=list, max_length=400)
    voice: str | None = Field(default=None, min_length=1, max_length=64)
    # None: keep what this version used last time (HIG-58).
    use_source_voice: bool | None = None


class TranscriptCueOut(BaseModel):
    i: int
    start: float
    end: float
    text: str


class TranscriptOut(BaseModel):
    status: str
    error: str | None = None
    cues: list[TranscriptCueOut] = Field(default_factory=list)
    updated_at: str | None = None


class VersionCueOut(BaseModel):
    i: int
    translated: str


class TermOut(BaseModel):
    source: str
    target: str


class VersionOut(BaseModel):
    status: str
    stage: str | None = None
    voice: str | None = None
    terms: list[TermOut] = Field(default_factory=list)
    cues: list[VersionCueOut] = Field(default_factory=list)
    stale: bool = False
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    voice_asset_id: str | None = None
    dub: bool = True
    voice_stale: bool = False
    source_voice: bool = False  # HIG-58：这一版用复刻的原声合成，界面显示"原声"
    updated_at: str | None = None


class CloneSampleOut(BaseModel):
    source: str = Field(default="", alias="from")  # vocals | source
    start: float = 0.0
    seconds: float = 0.0

    model_config = ConfigDict(populate_by_name=True)


class CloneVoiceOut(BaseModel):
    """The voice cloned from this video (HIG-58); one per video, shared by every language."""

    status: str
    voice_id: str | None = None
    model: str | None = None
    error: str | None = None
    sample: CloneSampleOut | None = None
    updated_at: str | None = None


class LocalizationOut(BaseModel):
    """``pending`` (the worker's to-do) is internal and deliberately not exposed."""

    source_lang: str = "auto"
    transcript: TranscriptOut | None = None
    clone_voice: CloneVoiceOut | None = None
    versions: dict[str, VersionOut] = Field(default_factory=dict)


class LangOut(BaseModel):
    code: str
    label: str


class VoiceOut(BaseModel):
    id: str
    label: str  # 名字（龙小淳 / Abby）
    gender: Literal["female", "male", "neutral"] | None = None  # 分组用；neutral = 童声 / 角色音；env 加的音色为 None
    style: str | None = None  # 一句话风格（知性积极 / 美式）
    speech_rate: bool = True  # 该音色的模型是否接受 speech_rate（qwen3-tts 不接受，前端禁用语速）
    provider: Literal["aliyun", "minimax"] = "aliyun"  # 音色来源厂商（HIG-59）；前端只在一种语言同时有两家时才标注分组


class TargetLangOut(LangOut):
    rtl: bool = False  # 从右到左书写（阿拉伯语等），前端排字幕时用
    clone: bool = False  # HIG-58：该语言能否用复刻的原声合成（复刻音色绑在 LOCALIZE_TTS_MODEL 上）
    voices: list[VoiceOut] = Field(default_factory=list)


class LocalizeOptionsOut(BaseModel):
    enabled: bool
    source_langs: list[LangOut]
    target_langs: list[TargetLangOut]


class VideoOut(BaseModel):
    id: str
    batch_id: str
    name: str
    order: int
    status: str
    error: str | None
    kind: str = "video"  # video | image | blank (HIG-50)
    original_ext: str | None = None
    width: int | None
    height: int | None
    duration: float | None
    fps: float | None
    has_audio: bool
    source_url: str
    proxy_url: str | None
    poster_url: str | None
    sprite: SpriteOut | None
    edit_spec: dict[str, Any] | None
    edited: bool
    render_status: str
    separation: SeparationOut | None = None
    localization: LocalizationOut | None = None
    updated_at: str


class StatusCounts(BaseModel):
    preparing: int = 0
    ready: int = 0
    edited: int = 0
    rendering: int = 0
    done: int = 0
    failed: int = 0


class BatchOut(BaseModel):
    id: str
    name: str
    created_at: str
    video_count: int
    status_counts: StatusCounts


class BatchDetailOut(BatchOut):
    videos: list[VideoOut]


class AssetOut(BaseModel):
    id: str
    type: str
    name: str
    url: str
    kind: str = "image"
    status: str = "ready"
    error: str | None = None
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    fps: float | None = None
    has_alpha: bool | None = None
    has_audio: bool | None = None
    poster_url: str | None = None
    preview_url: str | None = None
    family: str | None = None
    source: str
    derived_from: dict[str, Any] | None = None
    created_at: str


class JobOut(BaseModel):
    id: str
    batch_id: str
    video_id: str
    variant_key: str
    output_format: Literal["mp4", "mov", "png", "jpg"] = "mp4"
    status: str
    progress: int
    error: str | None
    output_url: str | None
    output: dict[str, Any] | None
    callback: dict[str, Any] | None
    created_at: str
    started_at: str | None
    finished_at: str | None
    name: str | None = None
    # Only the cross-batch list fills these; every other endpoint leaves them None
    # because its caller already knows which batch (and video) it asked about.
    batch_name: str | None = None
    video_name: str | None = None
    lang: str | None = None


class UploadTicketOut(BaseModel):
    """Where to send large uploads; all null when no upload host is configured."""

    upload_url: str | None = None
    ticket: str | None = None
    expires_at: str | None = None


class UploadDiagnosticIn(BaseModel):
    """Minimal, secret-free report from a failed browser video upload."""

    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    batch_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    stage: Literal["ticket", "upload"]
    channel: Literal["direct", "same_origin", "unknown"]
    code: str = Field(min_length=1, max_length=80, pattern=r"^[A-Z0-9_]+$")
    status: int = Field(ge=0, le=599)
    file_count: int = Field(ge=1, le=100)
    total_bytes: int = Field(ge=0)
    elapsed_ms: int = Field(ge=0)


class LayerImageOut(BaseModel):
    url: str
    width: int
    height: int


class PresetOut(BaseModel):
    id: str
    type: str
    name: str
    data: dict[str, Any]
    created_at: str


class SafeZoneRect(BaseModel):
    label: str = ""
    x: float
    y: float
    w: float
    h: float


class SafeZoneOut(BaseModel):
    key: str
    name: str
    aspect: str
    note: str | None = None
    zones: list[SafeZoneRect]
    overlay_url: str | None = None  # /api/overlays/{key}.png — mock platform UI, approximate
    inner: SafeZoneRect | None = None  # conservative safe frame (fractions)
    outer: SafeZoneRect | None = None  # generous safe frame (fractions)

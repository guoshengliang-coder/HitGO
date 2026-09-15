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
Fill = Literal["blur", "color", "crop"]
Quality = Literal["standard", "high"]
LayerMode = Literal["replace", "style_only"]

CANVAS_SIZES: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "16:9": (1920, 1080),
}

DEFAULT_VARIANT_KEY = "9x16"

_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
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


class LayerBase(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=64)
    anchor: Anchor = "top-left"
    margin: Margin = (0.0, 0.0)
    width: float = Field(default=0.3, gt=0, le=1.0)
    rotate: float = Field(default=0.0, ge=-360, le=360)
    opacity: float = Field(default=1.0, ge=0, le=1)
    t: Literal["all"] | TimeWindow = "all"

    @field_validator("t")
    @classmethod
    def _validate_t(cls, v: Any) -> Any:
        return _check_time_window(v)


class StickerLayer(LayerBase):
    type: Literal["sticker"]
    asset_id: str = Field(min_length=1)


class TextShadow(BaseModel):
    """Drop shadow of a text layer; rendered by the frontend into the PNG (contract §2)."""

    model_config = ConfigDict(extra="ignore")

    color: str = "#000000"
    blur: float = Field(default=0.0, ge=0)  # relative to canvas height
    offset: tuple[float, float] = (0.0, 0.0)  # [x, y], relative to canvas height


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
    letter_spacing: float | None = None  # em units; negative tightens
    background_width: float | None = Field(default=None, gt=0, le=1)  # relative to canvas width; None = hug text
    background_radius: float | None = Field(default=None, ge=0)  # relative to canvas height; None = auto


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


class TextLayer(LayerBase):
    type: Literal["text"]
    text: str = ""
    style: TextStyle | None = None
    spans: list[TextSpan] | None = None
    image_url: str | None = None
    image_size: tuple[int, int] | None = None

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
        if not v.startswith("/media/"):
            raise ValueError("image_url 必须是 /media/ 开头的站内路径")
        return v

    @field_validator("image_size")
    @classmethod
    def _validate_image_size(cls, v: tuple[int, int] | None) -> tuple[int, int] | None:
        if v is not None and (v[0] <= 0 or v[1] <= 0):
            raise ValueError("image_size 必须为正整数")
        return v


Layer = Annotated[StickerLayer | TextLayer, Field(discriminator="type")]


class LayerOverride(BaseModel):
    """Per-variant override; only these five keys are allowed (contract §2)."""

    model_config = ConfigDict(extra="forbid")

    anchor: Anchor | None = None
    margin: Margin | None = None
    width: float | None = Field(default=None, gt=0, le=1.0)
    rotate: float | None = Field(default=None, ge=-360, le=360)
    opacity: float | None = Field(default=None, ge=0, le=1)

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.model_dump().items() if v is not None}


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
    aspect: Aspect
    fill: Fill = "blur"
    color: str = "#000000"
    quality: Quality = "standard"
    crop: CropRect | None = None  # only honoured when fill == "crop"; None = centred cover crop
    layer_overrides: dict[str, LayerOverride] = Field(default_factory=dict)

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

    @property
    def canvas(self) -> tuple[int, int]:
        return CANVAS_SIZES[self.aspect]


class Trim(BaseModel):
    model_config = ConfigDict(extra="ignore")

    remove: list[TimeWindow] = Field(default_factory=list)

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


class EditSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")

    spec_version: Literal[1] = 1
    trim: Trim = Field(default_factory=Trim)
    layers: list[Layer] = Field(default_factory=list)
    outputs: list[OutputVariant] = Field(min_length=1)

    @model_validator(mode="after")
    def _cross_checks(self) -> EditSpec:
        keys = [o.variant_key for o in self.outputs]
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            raise ValueError(f"variant_key 重复：{', '.join(dupes)}")
        ids = [layer.id for layer in self.layers]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"图层 id 重复：{', '.join(dupes)}")
        return self

    def layer_by_id(self, layer_id: str) -> StickerLayer | TextLayer | None:
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


class SpecIn(BaseModel):
    edit_spec: dict[str, Any] | None


class ApplyIn(BaseModel):
    source_video_id: str
    target_video_ids: list[str] = Field(min_length=1)
    modules: list[Literal["trim", "layers", "outputs"]] = Field(min_length=1)
    layer_mode: LayerMode = "replace"


class RenderIn(BaseModel):
    video_ids: list[str] = Field(min_length=1)


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


class VideoOut(BaseModel):
    id: str
    batch_id: str
    name: str
    order: int
    status: str
    error: str | None
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
    width: int | None = None
    height: int | None = None
    family: str | None = None
    source: str
    created_at: str


class JobOut(BaseModel):
    id: str
    batch_id: str
    video_id: str
    variant_key: str
    status: str
    progress: int
    error: str | None
    output_url: str | None
    output: dict[str, Any] | None
    callback: dict[str, Any] | None
    created_at: str
    started_at: str | None
    finished_at: str | None


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

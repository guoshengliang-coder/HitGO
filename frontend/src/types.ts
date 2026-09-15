// 类型定义：严格对应 docs/CONTRACT.md

export type VideoStatus = 'preparing' | 'ready' | 'failed';
export type RenderStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface StatusCounts {
  preparing: number;
  ready: number;
  edited: number;
  rendering: number;
  done: number;
  failed: number;
}

export interface Batch {
  id: string;
  name: string;
  created_at: string;
  video_count: number;
  status_counts: StatusCounts;
}

export interface SpriteMeta {
  url: string;
  interval: number;
  tile_width: number;
  tile_height: number;
  columns: number;
  count: number;
}

export interface Video {
  id: string;
  batch_id: string;
  name: string;
  order: number;
  status: VideoStatus;
  error: string | null;
  width: number;
  height: number;
  duration: number;
  fps: number;
  has_audio: boolean;
  source_url: string;
  proxy_url: string;
  poster_url: string;
  sprite: SpriteMeta | null;
  edit_spec: EditSpec | null;
  edited: boolean;
  render_status: RenderStatus;
  updated_at: string;
}

export type BatchDetail = Batch & { videos: Video[] };

export type AssetType = 'sticker' | 'font';

export interface Asset {
  id: string;
  type: AssetType;
  name: string;
  url: string;
  width?: number;
  height?: number;
  family?: string;
  source: 'upload' | 'builtin';
  created_at: string;
}

export interface JobOutput {
  width: number;
  height: number;
  duration: number;
  size: number;
  codec: string;
}

export interface Job {
  id: string;
  batch_id: string;
  video_id: string;
  variant_key: string;
  status: JobStatus;
  progress: number;
  error: string | null;
  output_url: string | null;
  output: JobOutput | null;
  callback: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SafeZoneRect extends Rect {
  label: string;
}

export interface SafeZone {
  key: string;
  name: string;
  aspect: string;
  zones: SafeZoneRect[];
  /** 可选：平台真实 UI 叠层图（透明 PNG），有则「叠层」模式下铺满舞台。 */
  overlay_url?: string | null;
  /** 可选：内（保守）/ 外（宽松）安全框（相对比例），label 可为空串。 */
  inner?: SafeZoneRect | null;
  outer?: SafeZoneRect | null;
}

// ---- edit_spec v1 ----

export type Anchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const ANCHORS: Anchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export type TimeWindow = [number, number] | 'all';

export interface LayerBase {
  id: string;
  anchor: Anchor;
  margin: [number, number];
  width: number;
  rotate: number;
  opacity: number;
  t: TimeWindow;
  // 前端本地字段（不发送给后端语义无影响；后端 schema 允许附加字段则透传）
  name?: string;
  visible?: boolean;
  locked?: boolean;
}

export interface StickerLayer extends LayerBase {
  type: 'sticker';
  asset_id: string;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextShadow {
  color: string;
  blur: number; // 相对画布高
  offset: [number, number]; // 相对画布高
}

export interface TextStyle {
  font_family: string;
  font_weight: number;
  font_size: number; // 相对画布高
  color: string;
  stroke_color: string;
  stroke_width: number; // 相对画布高
  background: string | null;
  padding: number; // 相对画布高
  align: TextAlign;
  line_height: number;
  /** 可选：投影；null / 缺省 = 无。 */
  shadow?: TextShadow | null;
  /** 可选：字距（em，可为负）。 */
  letter_spacing?: number;
  /** 可选：背景块宽度，相对画布宽 (0,1]；null / 缺省 = 紧贴文字。 */
  background_width?: number | null;
  /** 可选：背景圆角，相对画布高；null / 缺省 = 自动（min(padding, font_size×0.2)）。 */
  background_radius?: number | null;
}

/** 局部上色：text 的 UTF-16 字符区间 [start, end) 用 color 填充。 */
export interface TextSpan {
  start: number;
  end: number;
  color: string;
}

/** 文字样式预设：内置 + 用户保存（对应后端 Preset type=text_style）。 */
export interface TextStylePreset {
  id: string;
  name: string;
  style: Partial<TextStyle>;
  builtin?: boolean;
}

export type PresetType = 'text_style';

export interface Preset {
  id: string;
  type: PresetType;
  name: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  style: TextStyle;
  /** 可选：局部上色区间，升序且互不重叠；缺省 / [] = 整段用 style.color。 */
  spans?: TextSpan[];
  image_url?: string | null;
  image_size?: [number, number] | null;
  /** 本地字段：用户是否手动设置过宽度（否则宽度跟随渲染尺寸）。发送时剔除。 */
  width_manual?: boolean;
}

export type Layer = StickerLayer | TextLayer;

export type AspectKey = '9:16' | '1:1' | '4:5' | '16:9';
export type VariantKey = '9x16' | '1x1' | '4x5' | '16x9';
export type FillMode = 'blur' | 'color' | 'crop';
/** 输出编码档位：standard（默认，省略即 standard）| high。 */
export type OutputQuality = 'standard' | 'high';

export type LayerOverride = Partial<Pick<LayerBase, 'anchor' | 'margin' | 'width' | 'rotate' | 'opacity'>>;

/** 源画面上的裁切窗口（相对源宽 / 高的 0–1 比例）；只在 fill = 'crop' 时生效，缺省 = cover 居中。 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutputVariant {
  variant_key: VariantKey;
  aspect: AspectKey;
  fill: FillMode;
  color?: string;
  quality?: OutputQuality;
  crop?: CropRect;
  layer_overrides?: Record<string, LayerOverride>;
}

export interface EditSpec {
  spec_version: 1;
  trim: { remove: [number, number][] };
  layers: Layer[];
  outputs: OutputVariant[];
}

export const VARIANT_DEFS: { key: VariantKey; aspect: AspectKey; width: number; height: number; label: string; note: string }[] = [
  { key: '9x16', aspect: '9:16', width: 1080, height: 1920, label: '9:16', note: '默认 · 替换原素材' },
  { key: '1x1', aspect: '1:1', width: 1080, height: 1080, label: '1:1', note: '派生新素材' },
  { key: '4x5', aspect: '4:5', width: 1080, height: 1350, label: '4:5', note: '派生新素材' },
  { key: '16x9', aspect: '16:9', width: 1920, height: 1080, label: '16:9', note: '派生新素材' },
];

export function variantDef(key: VariantKey) {
  return VARIANT_DEFS.find((v) => v.key === key)!;
}

export function emptySpec(): EditSpec {
  return {
    spec_version: 1,
    trim: { remove: [] },
    layers: [],
    outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'blur', quality: 'standard' }],
  };
}

export function defaultTextStyle(): TextStyle {
  return {
    font_family: 'Noto Sans SC',
    font_weight: 700,
    font_size: 0.05,
    color: '#FFFFFF',
    stroke_color: '#000000',
    stroke_width: 0.004,
    background: null,
    padding: 0.01,
    align: 'center',
    line_height: 1.2,
  };
}

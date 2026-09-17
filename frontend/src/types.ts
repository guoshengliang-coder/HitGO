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

/** 素材来源（契约 §1 Video.kind，HIG-50）：上传的视频 | 上传的图片（转 5 秒静止片）| 空白素材。缺省 video。 */
export type VideoKind = 'video' | 'image' | 'blank';

export interface Video {
  id: string;
  batch_id: string;
  name: string;
  order: number;
  /** 可选，缺省 'video'（HIG-50）；旧后端不返回。 */
  kind?: VideoKind;
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
  /** 可选；人声 / 伴奏分离状态（契约 §1），null / 缺省 = 从未分离。 */
  separation?: Separation | null;
  /** 可选；改语言状态（契约 §1 localization）：一份听写模板 + 按目标语言的版本，null / 缺省 = 从未生成。 */
  localization?: Localization | null;
  updated_at: string;
}

// ---- 改语言（契约 §1 localization）----

/** 听写 / 版本任务状态，与分离一样是后台任务。 */
export type LocalizeStatus = 'queued' | 'running' | 'done' | 'failed';
/** 版本 running 时走到哪一步；queued 且 stage = tts 表示只重合成（译文不变）。 */
export type VersionStage = 'translate' | 'tts' | 'mix';

/** 模板里的一句：start / end 是**源时间轴**的秒，前端用 trim.remove 换算到剪后时间轴（lib/time.sourceRangeToPost）。 */
export interface TranscriptCue {
  i: number;
  start: number;
  end: number;
  text: string;
}

/** 听写模板：听写一次，可人工修正；所有语言版本都从它派生。 */
export interface Transcript {
  status: LocalizeStatus;
  error?: string | null;
  cues: TranscriptCue[];
  updated_at?: string | null;
}

/** 术语表条目：原词 → 译词，翻译时强制替换。 */
export interface LocalizationTerm {
  source: string;
  target: string;
}

/** 版本里的一句译文，按 i 与 transcript.cues 对齐。 */
export interface VersionCue {
  i: number;
  translated: string;
}

export interface LocalizationVersion {
  status: LocalizeStatus;
  stage?: VersionStage | null;
  voice?: string | null;
  terms?: LocalizationTerm[];
  cues: VersionCue[];
  /** 模板改过之后为 true：译文不是最新模板译出来的，要重译。 */
  stale?: boolean;
  error?: string | null;
  warnings?: string[];
  /** done 才有：配音素材（type audio、source derived、derived_from.stem = dubbed）。每次生成换新 id。 */
  voice_asset_id?: string | null;
  /** 缺省 true（HIG-56）：false = 这次只翻译不合成，done 时可能没有 voice_asset_id。 */
  dub?: boolean;
  /** 只翻译覆盖了译文，旧配音还在但对不上新译文，要重新生成口播。 */
  voice_stale?: boolean;
  updated_at?: string | null;
}

export interface Localization {
  /** 听写用的源语言；请求 auto 时为识别结果。 */
  source_lang: string;
  transcript: Transcript | null;
  /** 按目标语言码一份，互相独立。 */
  versions: Record<string, LocalizationVersion>;
}

/** POST /api/videos/{id}/localize 的请求体。 */
export interface LocalizeIn {
  /** 缺省 auto。 */
  source_lang?: string;
  target_langs: string[];
  /** 每个目标语言用的音色 id；缺省用该语言的第一个音色。 */
  voices?: Record<string, string>;
  terms?: LocalizationTerm[];
  /** true = 即使模板已 done 也重新听写。 */
  retranscribe?: boolean;
  /** 缺省 true；false = 只听写 + 翻译，口播之后用 PUT versions/{lang} 生成（HIG-56）。 */
  dub?: boolean;
}

export interface LangOption {
  code: string;
  label: string;
}

export interface TargetLangOption extends LangOption {
  /** 可选，缺省 false：从右到左书写（阿拉伯语等）。 */
  rtl?: boolean;
  voices: { id: string; label: string }[];
}

/** GET /api/localize/options：语言与音色都由后端下发，前端不写死。enabled = false 表示没配 key。 */
export interface LocalizeOptions {
  enabled: boolean;
  source_langs: LangOption[];
  target_langs: TargetLangOption[];
}

export type SeparationStatus = 'queued' | 'running' | 'done' | 'failed';
/** htdemucs（默认）| htdemucs_ft（四模型集成，慢约 4 倍，更干净）。 */
export type SeparationModel = 'htdemucs' | 'htdemucs_ft';

export interface Separation {
  status: SeparationStatus;
  model: SeparationModel;
  error?: string | null;
  vocals_asset_id?: string | null;
  instrumental_asset_id?: string | null;
  updated_at?: string | null;
}

export type BatchDetail = Batch & { videos: Video[] };

export type AssetType = 'sticker' | 'font' | 'audio';
/** 贴纸素材是静态图还是一段视频（多帧 gif / webp 也算 video）；音频素材固定为 audio。 */
export type AssetKind = 'image' | 'video' | 'audio';
/** 视频贴纸要异步探测 + 生成预览代理，期间是 preparing。 */
export type AssetStatus = 'preparing' | 'ready' | 'failed';

/** 素材来源（契约 §1）。`library` 预留给正式物料库，原型阶段不会出现，见 docs/ASSETS.md。 */
export type AssetSource = 'upload' | 'builtin' | 'library' | 'derived';

/**
 * source = derived 才有：从哪条视频分离出的哪个声部；dubbed = 改语言生成的配音，lang 是目标语言码；
 * tts = 大字报朗读（HIG-50），不属于任何视频，所以 video_id / video_name 可缺，另带音色 voice 与文案前 40 字 text。
 */
export interface DerivedFrom {
  video_id?: string | null;
  video_name?: string | null;
  stem: 'vocals' | 'instrumental' | 'dubbed' | 'tts';
  lang?: string | null;
  voice?: string | null;
  text?: string | null;
}

// ---- 大字报（契约 §3，HIG-50）----

/** POST /api/tts 的请求体：把一段文案朗读成派生音频素材（202，之后轮询 GET /api/assets/{id}）。 */
export interface TtsIn {
  text: string;
  lang: string;
  voice: string;
  /** [0.5, 2.0]，缺省 1.0；只对 cosyvoice 音色生效。 */
  speech_rate?: number;
  /** 素材名，缺省取文案前 20 字。 */
  name?: string;
}

/** POST /api/highlight 挑出的重点词组：start / end 是 text 的 UTF-16 区间 [start, end)，与 TextSpan 同一索引空间。 */
export interface HighlightPhrase {
  text: string;
  start: number;
  end: number;
}

export interface HighlightOut {
  phrases: HighlightPhrase[];
}

/** POST /api/batches/{id}/blank 的请求体：空白素材，全部可选（缺省黑色、10 秒、9:16）。 */
export interface BlankVideoIn {
  name?: string;
  /** #RRGGBB */
  color?: string;
  /** 秒，(0, 600] */
  duration?: number;
  aspect?: AspectKey;
}

export interface Asset {
  id: string;
  type: AssetType;
  name: string;
  url: string;
  /** 缺省 'image'；旧后端不返回时按静态图处理。 */
  kind?: AssetKind;
  /** 缺省 'ready'。 */
  status?: AssetStatus;
  error?: string | null;
  width?: number;
  height?: number;
  /** 以下四个只有 kind='video' 且 status='ready' 时有值。 */
  duration?: number | null;
  fps?: number | null;
  has_alpha?: boolean | null;
  /** kind='video' 且预处理完才有：素材是否带音轨；null = 还没探测（旧素材等后端回填）。 */
  has_audio?: boolean | null;
  poster_url?: string | null;
  preview_url?: string | null;
  family?: string;
  source: AssetSource;
  /** 可选；source = derived 才有。 */
  derived_from?: DerivedFrom | null;
  created_at: string;
}

/** 素材是不是视频贴纸（旧后端没有 kind 字段时按静态图）。 */
export function isVideoAsset(asset: Asset | undefined): boolean {
  return asset?.kind === 'video';
}

/** 音频素材（BGM / 口播），只用在 edit_spec.audio.tracks 里。 */
export function isAudioAsset(asset: Asset | undefined): boolean {
  return asset?.type === 'audio';
}

export function isAssetReady(asset: Asset | undefined): boolean {
  return !asset || (asset.status ?? 'ready') === 'ready';
}

/** 成片实际混进了哪些音轨（契约 §1 Job output.audio，HIG-26）；spec 没有 audio 块或旧任务没有。 */
export interface JobOutputAudio {
  source_volume: number;
  source_mute: number;
  tracks: { id: string; asset_id: string; name: string; role: AudioRole }[];
  skipped: string[];
}

export interface JobOutput {
  width: number;
  height: number;
  duration: number;
  size: number;
  codec: string;
  audio?: JobOutputAudio;
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
  /** 导出时填的名称（同一次导出的任务共用）；没填为 null。旧后端不带这个字段。 */
  name?: string | null;
  /** 只有跨批次的 GET /api/outputs 会填；单批次端点不带，名字从批次详情里取。 */
  batch_name?: string | null;
  video_name?: string | null;
  /** 成片语言（HIG-43，改语言的语言码）；null / 缺省 = 原版或没套用语言。 */
  lang?: string | null;
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
  /** 可选；改语言模块生成的图层打 'localize'（契约 §2），套用别的语言版本时按它整批替换。发送给后端，原样存取。 */
  origin?: 'localize';
  /** 可选；与 origin 配套：这层译文字幕属于哪个目标语言。 */
  lang?: string;
  /** 可选（HIG-33）：时间线上关掉眼睛。留在 spec 里，成片不渲染（视频贴纸的声音一起去掉）；缺省 false，false 时不发。 */
  hidden?: boolean;
  /** 可选（HIG-48）：时间线 / 图层列表里改的名字；缺省按内容自动命名，只在非空时发（契约 §2）。 */
  name?: string;
  // 前端本地字段（不发送给后端）
  locked?: boolean;
}

/** 视频贴纸短于显示时段时的行为；静态图忽略。 */
export type Playback = 'loop' | 'freeze' | 'once';

export interface StickerLayer extends LayerBase {
  type: 'sticker';
  asset_id: string;
  /** 可选，缺省 'loop'。 */
  playback?: Playback;
  /** 可选，缺省 false：视频贴纸自带的音轨是否合成进成片（契约 §2），只对 has_audio 的素材生效。 */
  mix_audio?: boolean;
}

/** POST /api/assets/upload-ticket：大文件上传绕开 CDN 的上传子域名；未配置时全是 null。 */
export interface UploadTicket {
  upload_url: string | null;
  ticket: string | null;
  expires_at: string | null;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextShadow {
  color: string;
  blur: number; // 相对画布高
  offset: [number, number]; // 相对画布高
}

/** 发光：以文字轮廓为中心、无偏移的模糊光晕（剪映「发光」）。 */
export interface TextGlow {
  color: string;
  blur: number; // 光晕半径，相对画布高
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
  /** 可选：发光；null / 缺省 = 无。与 shadow 一样由前端烤进 PNG，worker 不读取。 */
  glow?: TextGlow | null;
  /** 可选：字距（em，可为负）。 */
  letter_spacing?: number;
  /** 可选：背景块宽度，相对画布宽 (0,1]；null / 缺省 = 紧贴文字。 */
  background_width?: number | null;
  /** 可选：背景圆角，相对画布高；null / 缺省 = 自动（min(padding, font_size×0.2)）。 */
  background_radius?: number | null;
  /** 可选（HIG-51）：自动换行的文字框宽，相对画布宽 (0,1]；文字按此宽度折行、PNG 宽固定为此宽。null / 缺省 = 不自动换行。 */
  wrap_width?: number | null;
  /** 可选（HIG-51）：文字框最小高度，相对画布高 (0,1]；框比文字高时文字垂直居中、背景块画满整个框。null / 缺省 = 贴合文字。 */
  box_height?: number | null;
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

/** 文字动画预设（HIG-40，契约 §2 layers[type=text].animation）；曲线见 lib/textAnimation。 */
export type TextAnimMovePreset = 'fade' | 'slide_up' | 'slide_down' | 'slide_left' | 'slide_right' | 'pop';
export type TextAnimLoopPreset = 'breathe' | 'float' | 'blink';

/** 速度曲线（HIG-44）：back / elastic / bounce 在入场结尾回弹，出场开头反向蓄力。 */
export type TextAnimEasing = 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out' | 'back' | 'elastic' | 'bounce';
/** 逐字显现（HIG-45）的曲线只往前走。 */
export type TextRevealEasing = 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';
export type TextRevealPreset = 'typewriter' | 'fade_chars' | 'wipe';

/** 入场 / 出场；duration 之外都是 HIG-44 的高级项，缺省 = v0.16.0 效果。 */
export interface TextAnimPhase {
  preset: TextAnimMovePreset;
  /** 秒，缺省 0.5。 */
  duration?: number;
  /** 缺省按预设：入场 ease_out，弹入 back，出场 ease_in。 */
  easing?: TextAnimEasing;
  /** 滑动距离，相对画布高，缺省 0.05。 */
  distance?: number;
  /** 滑动时是否同时淡入淡出，缺省 true。 */
  fade?: boolean;
  /** 弹入起始 / 缩小结束倍数，缺省 0.5。 */
  scale?: number;
  /** 回弹强度（easing = back），缺省 1.70158。 */
  overshoot?: number;
  /** 入场延迟秒，缺省 0；出场忽略。 */
  delay?: number;
}

export interface TextReveal {
  preset: TextRevealPreset;
  /** 秒，缺省 1。 */
  duration?: number;
  /** 按字 / 按词（前端据此生成 glyph_layout），缺省 char。 */
  unit?: 'char' | 'word';
  /** 打字机光标，缺省 false。 */
  cursor?: boolean;
  easing?: TextRevealEasing;
}

export interface TextAnimation {
  /** 入场：时段开头（延迟之后）。 */
  in?: TextAnimPhase;
  /** 出场：时段结尾。 */
  out?: TextAnimPhase;
  /** 循环：入场结束到时段结束（与出场叠加）；period 秒，缺省 1.2；amount 幅度倍数，缺省 1。 */
  loop?: { preset: TextAnimLoopPreset; period?: number; amount?: number };
  /** 逐字显现（HIG-45）：与入场同起点，可与其余三项叠加。 */
  reveal?: TextReveal;
}

/** 逐字显现的字位置（HIG-45）：PNG 宽高的比例，units 按显现顺序排列。 */
export interface GlyphLayout {
  lines: { top: number; bottom: number; rtl?: boolean; units: [number, number][] }[];
}

/** 滚动文字的裁切框（契约 §2 scroll.box），相对画布宽 / 高。 */
export interface ScrollBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 滚动文字（HIG-50 大字报，契约 §2 layers[type=text].scroll）：整篇文案烘焙成一张高 PNG，在裁切框内向上滚动。
 * 前端类型里全部可选，缺省见 lib/poster.DEFAULT_SCROLL；曲线在 lib/poster.ts（与后端 services/scroll.py 共用 golden）。
 */
export interface TextScroll {
  /** 画布高 / 秒，(0, 2]，缺省 0.08。 */
  speed?: number;
  /** 缺省 = 通用竖版安全区（lib/poster.DEFAULT_SCROLL_BOX）。 */
  box?: ScrollBox;
  /** enter（缺省）：从框底边滚入 | visible：开头就有字，首行贴框顶边。 */
  start?: 'enter' | 'visible';
  /** exit（缺省）：滚到全部离开框顶边 | stay：末行贴框底边就停。 */
  end?: 'exit' | 'stay';
  /** 秒，≥ 0，缺省 0：开头停留，只在 start = visible 时生效。 */
  hold_start?: number;
  /** 秒，≥ 0，缺省 0：结尾停留，只在 end = stay 时生效。 */
  hold_end?: number;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  style: TextStyle;
  /** 可选：局部上色区间，升序且互不重叠；缺省 / [] = 整段用 style.color。 */
  spans?: TextSpan[];
  image_url?: string | null;
  image_size?: [number, number] | null;
  /** 可选（HIG-29）：按输出画幅重新渲染的 PNG，键为 variant_key；worker 优先用它，找不到时回落 image_url。导出时重新生成。 */
  variant_images?: Record<string, { url: string; size: [number, number]; background_url?: string }> | null;
  /** 可选（HIG-40）：入场 / 出场 / 循环动画；空对象等于没有，发送时省略。 */
  animation?: TextAnimation;
  /** 可选（HIG-50）：整篇文案在裁切框内滚动；与 animation 互斥（后端 400）。null / 缺省 = 不滚动，发送时省略。 */
  scroll?: TextScroll | null;
  /** 可选（HIG-45）：有逐字显现时导出前生成的字位置。 */
  glyph_layout?: GlyphLayout | null;
  /** 可选（HIG-45）：有逐字显现且有背景块时，只画背景块的 PNG（与 image_url 同尺寸）。 */
  background_image?: string | null;
  /** 本地字段：用户是否手动设置过宽度（否则宽度跟随渲染尺寸）。发送时剔除。 */
  width_manual?: boolean;
}

/** 遮盖方式：blur 区域模糊 | solid 色块。 */
export type MaskMode = 'blur' | 'solid';
/** 模糊强度档（契约 §2 mask.blur）：1 弱 | 2 中 | 3 强。 */
export type MaskBlur = 1 | 2 | 3;

/**
 * 遮盖层（契约 §2 type = "mask"）：把画布上一块矩形区域模糊或盖上色块，典型用途是遮住烧进画面的原字幕。
 * 不需要素材：高度直接相对画布高，rotate 被 worker 忽略。
 */
export interface MaskLayer extends LayerBase {
  type: 'mask';
  /** 相对画布高 (0, 1]，缺省 0.12。 */
  height: number;
  /** 缺省 'blur'。 */
  mode: MaskMode;
  /** 可选，缺省 2：只对 blur 生效。 */
  blur?: MaskBlur;
  /** 可选，缺省 '#000000'：#RRGGBB，只对 solid 生效；透明度用 opacity。 */
  color?: string;
}

export type Layer = StickerLayer | TextLayer | MaskLayer;

export type AspectKey = '9:16' | '1:1' | '4:5' | '16:9';
export type OutputAspectKey = AspectKey | 'custom';
export type VariantKey = '9x16' | '1x1' | '4x5' | '16x9' | 'custom';
export type FillMode = 'blur' | 'color' | 'crop';
/** 输出编码档位：standard（默认，省略即 standard）| high。 */
export type OutputQuality = 'standard' | 'high';

/** 按输出变体覆盖的几何字段；height 只对遮盖层有意义。 */
export type LayerOverride = Partial<Pick<LayerBase, 'anchor' | 'margin' | 'width' | 'rotate' | 'opacity'>> & { height?: number };

/** 源画面上的裁切窗口（相对源宽 / 高的 0–1 比例）；只在 fill = 'crop' 时生效，缺省 = cover 居中。 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutputVariant {
  variant_key: VariantKey;
  aspect: OutputAspectKey;
  /** 仅 custom 输出使用；H.264 yuv420p 要求两者为正偶数。 */
  width?: number;
  height?: number;
  fill: FillMode;
  color?: string;
  quality?: OutputQuality;
  crop?: CropRect;
  /** 可选（HIG-54）：模糊背景的模糊强度 0–100，缺省 60；只在 fill = blur 时生效（lib/blurFill）。 */
  blur?: number;
  /** 可选（HIG-54）：模糊背景的亮度 20–100（%），缺省 50，100 = 不压暗；只在 fill = blur 时生效。 */
  bg_brightness?: number;
  /** 非 9x16 输出上图层怎么摆（HIG-29）：canvas = 相对该画布（缺省）；video = 跟着视频画面走（lib/variantLayout）。 */
  layer_fit?: 'canvas' | 'video';
  layer_overrides?: Record<string, LayerOverride>;
  /** 可选（HIG-35）：导出时是否勾选这个画幅。缺省：9x16 视为勾选，其余视为不勾。只记用户偏好，出哪些文件仍以 render 的 variant_keys 为准。 */
  export?: boolean;
}

/** 音轨角色，只给界面分类（契约 §2 audio.tracks[].role）；worker 不区分。 */
export type AudioRole = 'bgm' | 'voice';

/** 一条叠加进成片的音轨（契约 §2 audio.tracks[]）。除 id / asset_id / t 外都可选，缺省见 lib/audioTracks.TRACK_DEFAULTS。 */
/** post = 素材从时段起点开始播；source = 素材对齐源时间轴，随剪辑一起裁（分离出的人声 / 伴奏）。 */
export type AudioAlign = 'post' | 'source';

export interface AudioTrack {
  id: string;
  asset_id: string;
  role?: AudioRole;
  /** 可选，缺省 'post'。 */
  align?: AudioAlign;
  /** 出声时段，剪后时间轴。 */
  t: TimeWindow;
  /** 从素材第几秒开始播；loop 时是第一遍的起点（HIG-25）。 */
  offset?: number;
  /** 0–1。 */
  volume?: number;
  loop?: boolean;
  fade_in?: number;
  fade_out?: number;
  /** 可选；改语言模块加的配音 / 伴奏轨打 'localize'（契约 §2），与 layers[].origin 同义。 */
  origin?: 'localize';
  lang?: string;
  /** 可选（HIG-33）：关掉眼睛，不混进成片也不算跳过；缺省 false，false 时不发。 */
  hidden?: boolean;
  /** 可选（HIG-48）：时间线上改的轨道名；缺省显示素材文件名，只在非空时发。 */
  name?: string;
}

/** 契约 §2 audio：源音轨音量 + 叠加音轨。缺省（无此块）= 源音轨原样保留。 */
export interface AudioSpec {
  /** 0–1；0 = 源音轨静音。 */
  source_volume: number;
  /** 可选（HIG-25）：源音轨在这些剪后时段静音，画面不动。升序、不重叠。 */
  source_mute?: [number, number][];
  tracks: AudioTrack[];
  /** 可选（HIG-33）：源音轨关掉眼睛，成片不带原声；source_volume 原样保留，打开眼睛即恢复。 */
  source_hidden?: boolean;
  /** 可选（HIG-48）：源音轨改的名字；缺省叫「源音轨」，只在非空时发。 */
  source_name?: string;
}

/** 契约 §2 cover（HIG-9）：成片最前面的封面。缺省（无此块）= 没有封面。 */
export interface CoverSpec {
  /** 贴纸素材：图片或视频。 */
  asset_id: string;
  /** 图片封面停留秒数，0.1–10，缺省 1；视频封面整段播放，忽略此字段。 */
  duration?: number;
}

/** 契约 §2 trim：remove 基于源时间轴；duration（HIG-50）是成片正片时长，null / 缺省 = 剪后时长，长于剪后时长时保留段循环补足。 */
export interface Trim {
  remove: [number, number][];
  /** 秒，(0, 600]；只在正数时发送。 */
  duration?: number | null;
}

/** HIG-39：当前视频的拼接时间轴引用本批次的原始源视频，不套用来源视频的 edit_spec。 */
export type ClipTransitionType = 'cut' | 'fade' | 'slide_left' | 'slide_right' | 'wipe_left' | 'wipe_right';
export interface ClipTransition {
  type: ClipTransitionType;
  duration: number;
}
export interface SequenceClip {
  id: string;
  video_id: string;
  in: number;
  out: number;
  /** 当前片段与前一段之间的转场；首段不设。 */
  transition?: ClipTransition | null;
}
export interface SequenceSpec {
  clips: SequenceClip[];
}

export interface EditSpec {
  spec_version: 1;
  trim: Trim;
  layers: Layer[];
  outputs: OutputVariant[];
  audio?: AudioSpec | null;
  cover?: CoverSpec | null;
  sequence?: SequenceSpec | null;
}

export const VARIANT_DEFS: { key: VariantKey; aspect: OutputAspectKey; width: number; height: number; label: string; note: string }[] = [
  { key: '9x16', aspect: '9:16', width: 1080, height: 1920, label: '9:16', note: '默认 · 替换原素材' },
  { key: '1x1', aspect: '1:1', width: 1080, height: 1080, label: '1:1', note: '派生新素材' },
  { key: '4x5', aspect: '4:5', width: 1080, height: 1350, label: '4:5', note: '派生新素材' },
  { key: '16x9', aspect: '16:9', width: 1920, height: 1080, label: '16:9', note: '派生新素材' },
  { key: 'custom', aspect: 'custom', width: 1080, height: 1350, label: '自定义', note: '派生新素材 · 自定宽高' },
];

export function variantDef(key: VariantKey) {
  return VARIANT_DEFS.find((v) => v.key === key)!;
}

/** 当前输出的真实像素尺寸；固定画幅沿用预设尺寸。 */
export function outputSize(output: OutputVariant): { width: number; height: number } {
  if (output.variant_key === 'custom' && output.width && output.height) return { width: output.width, height: output.height };
  const { width, height } = variantDef(output.variant_key);
  return { width, height };
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

// 编辑器全局状态（zustand）。
// - 每条视频一份草稿 spec（specs）+ 历史栈（history，上限 50）
// - 任何 spec 修改后 1 秒防抖自动保存（PUT /api/videos/{id}/spec）
// - "导出"：先把文字图层烘焙成 PNG，再 PUT spec，再 POST /api/render，并轮询任务
// - 多画幅（HIG-29）：outputs 存「已配置的画幅」，载入 / 批量应用时用 normalizeOutputs 规范化；导出时勾选出哪些画幅，
//   缺的用 ensureVariants 补上缺省设置。画面分组 / 画布预览看的是 previewVariantKey 这个画幅

import { create } from 'zustand';
import { api, ApiError, uploadErrorText, type ApplyLayerMode, type RenderItem } from '../api';
import type { Asset, AudioRole, AudioSpec, AudioTrack, SequenceClip, SeparationModel, BatchDetail, CropRect, EditSpec, Job, Layer, LocalizeIn, LocalizeOptions, OutputVariant, SafeZone, ScrollBox, TextLayer, TextScroll, TextStyle, TextStylePreset, VariantKey, Video, Anchor, LayerOverride, StickerLayer, ShapeLayer, ScreenTextIn, ScreenTextOptions, SourceVariant } from '../types';
import { defaultTextStyle, emptySpec, isAssetReady, isVideoAsset } from '../types';
import { addMuteRange, clampSpeed, newTrackId, splitTrackAt, SOURCE_TRACK_ID, trackDefaultsFor, windowForSpeed } from '../lib/audioTracks';
import { cleanTrackName } from '../lib/trackNames';
import { appliedVersion, applyLocalizationToSpec, autoApplyLang, canApplyVersion, isLocalizationActive, langLabel, localizationFinishText, LOCALIZE_ORIGIN, stripLocalization, type LocalizeBgmChoice } from '../lib/localize';
import { applyScreenTextToSpec, bandHint, cleanReady, screenTextActive, screenTextFinishText, stripScreenText } from '../lib/screentext';
import { loadFeaturePrefs } from '../lib/featurePrefs';
import { planLanguageExport, specLang } from '../lib/langExport';
import type { ExportScope } from '../lib/exportScope';

/** 打开导出弹窗时的预设（HIG-43）：改语言面板打开时预选范围和语言。 */
export interface ExportDialogRequest {
  scope?: ExportScope;
  langs?: string[];
}
import { cloneSpec, ensureVariants, layerAspect, newLayerId, normalizeOutputs, outputFor, setExportKeys, toContractSpec } from '../lib/spec';
import { retrimForAsset } from '../lib/sourceTrim';
import { clipWindows, materializeSequence, moveClipSet, normalizeSequenceAudio, pasteClipSet, removeClipSet, sequenceDuration, setOwnerSourceGain } from '../lib/sequence';
import { effectiveGeometry, overrideFromBox, resolveLayerBox } from '../lib/variantLayout';
import { clamp, normalizeRanges, outputDuration, postTimeOf, postTrimDuration, sourceToPost, wouldRemoveAll } from '../lib/time';
import { isSubtitleTextLayer, MIN_SPLIT, splitLayerAt, splitLayerBlockedReason, splitTextLayerByText, textCutForSplit } from '../lib/layerSplit';
import { charRatio } from '../lib/cueSplit';
import { windowRange } from '../lib/stickerMedia';
import { DEFAULT_SCROLL_BOX, fitScrollSpeed, highlightSpans, newPosterLayer, posterDuration, resolveScroll, voiceTrack } from '../lib/poster';
import { adjustSpans } from '../lib/textSpans';
import { clampCoverDuration, COVER_DEFAULT_DURATION, coverDuration, isCoverAsset } from '../lib/cover';
import { marginFromBox, nudgePlacement, placeLayer, round4, type LayerBox } from '../lib/layout';
import { indexWithinType, insertIndexBelow, layersOfType, moveWithinType, type LayerType } from '../lib/layerKind';
import { layerTypesForStep, stepForLayer, type Step } from '../lib/steps';
import { bakeTextLayer, bakeTextLayerVariants, ensureTextRendered } from '../lib/textImage';
import { bakeShapeLayer } from '../lib/shapeImage';
import { player } from '../lib/player';
import { ensureFontsLoaded } from '../lib/fonts';
import { BUILTIN_TEXT_PRESETS } from '../lib/textPresets';
import { calibrationFromJobs, type Calibration } from '../lib/estimate';
import { hasPreparingVideos, nextCurrentAfterDelete } from '../lib/videos';

export type { Step } from '../lib/steps';
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
export type ApplyModule = 'trim' | 'layers' | 'outputs' | 'audio' | 'cover';
export type SafeZoneView = 'frames' | 'overlay' | 'none';
/** 安全区开启时的显示方式（SafeZoneView 去掉 none）。 */
export type SafeZoneMode = Exclude<SafeZoneView, 'none'>;
export interface ToastAction {
  label: string;
  run: () => void;
}
/** 最近一次批量应用的快照，用于「撤销本次批量应用」。prevSpecs 里的 null 表示目标当时没有 spec。 */
export interface LastApply {
  targetIds: string[];
  prevSpecs: Record<string, EditSpec | null>;
}

export type EditorTheme = 'light' | 'dark';
type TimelineClipboard = { clips: SequenceClip[]; layers: Layer[]; tracks: AudioTrack[]; origin: number };
let timelineClipboard: TimelineClipboard | null = null;
const THEME_KEY = 'hitgo.editorTheme';
/** 整站默认深色（与剪映一致）；只有用户明确切到浅色才记住浅色。 */
function loadTheme(): EditorTheme {
  try {
    if (localStorage.getItem(THEME_KEY) === 'light') return 'light';
  } catch {
    /* ignore */
  }
  return 'dark';
}

const SAFE_ZONE_VIEW_KEY = 'hitgo.safeZoneView';
function loadSafeZoneView(): SafeZoneView {
  try {
    const v = localStorage.getItem(SAFE_ZONE_VIEW_KEY);
    if (v === 'frames' || v === 'overlay' || v === 'none') return v;
  } catch {
    /* ignore */
  }
  return 'frames';
}

/** 上次开启安全区时的显示方式：关掉再打开时恢复它（HIG-13）。 */
const SAFE_ZONE_MODE_KEY = 'hitgo.safeZoneMode';
function loadSafeZoneMode(view: SafeZoneView): SafeZoneMode {
  if (view !== 'none') return view;
  try {
    if (localStorage.getItem(SAFE_ZONE_MODE_KEY) === 'overlay') return 'overlay';
  } catch {
    /* ignore */
  }
  return 'frames';
}

interface History {
  past: EditSpec[];
  future: EditSpec[];
}

const HISTORY_CAP = 50;

export interface EditorState {
  batch: BatchDetail | null;
  videos: Video[];
  loading: boolean;
  error: string | null;
  currentVideoId: string | null;
  selectedIds: string[];
  step: Step;
  safeZones: SafeZone[];
  safeZoneKey: string;
  assets: Asset[];
  specs: Record<string, EditSpec>;
  history: Record<string, History>;
  selectedLayerId: string | null;
  /** HIG-63：同一视频里的视觉图层多选；selectedLayerId 是属性面板的主选中项。 */
  selectedLayerIds: string[];
  subtitleSyncEnabled: boolean;
  setSubtitleSyncEnabled: (enabled: boolean) => void;
  /** HIG-65：贴纸页当前要在预览画布拖画的图形；null = 普通选择。 */
  drawingShape: import('../types').ShapeLayer['shape'] | null;
  /** 用户主动点选图层的次数；重复点同一图层也要把右栏切回属性。 */
  layerFocusVersion: number;
  /** 正在为哪个贴纸图层挑替换素材（HIG-67）；null = 不在替换中。 */
  replacingLayerId: string | null;
  selectedClipId: string | null;
  timelineSelection: string[];
  hasTimelineClipboard: boolean;
  time: number; // 源时间；有封面时封面段为负（[-封面时长, 0)，见 lib/cover）
  playing: boolean;
  /** 播放到第几遍（0 起，HIG-50 循环补足）；镜像 player.lap。成片时刻 = lap × 剪后时长 + 剪后时刻，见 usePostTime。 */
  lap: number;
  /** 大字报（HIG-50）：正在合成的朗读素材 id（就绪后自动加为口播轨）；null = 没在合成。 */
  posterVoicePending: string | null;
  saveState: SaveState;
  saveError: string | null;
  /** 剪辑模块里正在调整 9:16 输出的裁切窗口（中栏换成 CropEditor） */
  cropEditing: boolean;
  /** 画面分组页签与画布预览当前看的画幅（HIG-29）；只在本地，不写进 spec。 */
  previewVariantKey: VariantKey;
  // 渲染
  jobs: Job[];
  trackedJobIds: string[];
  progressOpen: boolean;
  /** 导出弹窗（HIG-43 起放进 store：改语言面板也能带着预选语言打开它）；null = 关着。 */
  exportDialog: ExportDialogRequest | null;
  rendering: boolean;
  toast: string | null;
  toastAction: ToastAction | null;
  // 交互
  shortcutsOpen: boolean;
  /** 吸附开关（N，HIG-30）：时间轴与画布拖动共用；拖动时按 ⌥ / ⌘ 临时取反。 */
  snapEnabled: boolean;
  safeZoneView: SafeZoneView;
  /** 上次开启时的显示方式，toggleSafeZone 打开时恢复 */
  safeZoneMode: SafeZoneMode;
  /** 整站配色（类名挂在 <html> 上，见 App.tsx）；存本机 */
  theme: EditorTheme;
  timelinePps: number | null; // null = 适应窗口
  timelineViewPps: number; // 时间线实际生效的 px/s（适应模式下由容器宽算出），给 Transport 的缩放滑杆读
  layerClipboard: Layer[] | null;
  layerClipboardVideoId: string | null;
  styleClipboard: TextStyle | null;
  // 文字样式预设（内置 + 用户）
  textPresets: TextStylePreset[];
  // 批量应用撤销
  lastApply: LastApply | null;
  // 成片大小估算校准（来自该批次已完成任务的实际码率）
  outputCalibration: Calibration;
  /** 往本批次追加视频的上传进度（0–1）；null = 没在传（HIG-21）。 */
  appendProgress: number | null;

  load: (batchId: string) => Promise<void>;
  loadTextPresets: () => Promise<void>;
  saveTextPreset: (name: string, style: TextStyle) => Promise<void>;
  deleteTextPreset: (id: string) => Promise<void>;
  /** 拉取该批次已完成任务，按实际码率校准估算（剪辑面板的「画面」分组挂载时调用）。 */
  loadOutputCalibration: () => Promise<void>;
  refreshVideos: () => Promise<void>;
  loadAssets: () => Promise<void>;
  /** 把视频文件追加到当前批次（左栏拖入，HIG-21）；传完并入列表并轮询预处理。 */
  /** 追加上传；返回新建视频的 id（失败 / 正在上传时为空数组），大字报「上传背景」据此自动勾选（HIG-55）。 */
  appendVideos: (files: File[]) => Promise<string[]>;
  /** 删除视频（左栏，HIG-20）：逐条调接口，删成功的从列表 / 草稿 / 历史里拿掉。调用方负责二次确认。 */
  deleteVideos: (ids: string[]) => Promise<void>;
  /** 改批次名 / 视频名（HIG-27）；成功返回 true，失败 toast 原因。 */
  renameBatch: (name: string) => Promise<boolean>;
  renameVideo: (id: string, name: string) => Promise<boolean>;
  setCurrent: (id: string) => void;
  toggleSelected: (id: string) => void;
  setSelectedAll: (on: boolean) => void;
  setStep: (s: Step) => void;
  setSafeZoneKey: (k: string) => void;
  setSelectedLayer: (id: string | null) => void;
  selectLayers: (ids: string[], mode?: 'replace' | 'add' | 'subtract') => void;
  selectAllLayers: () => void;
  removeSelectedLayers: () => void;
  duplicateSelectedLayers: () => void;
  shiftSelectedLayers: (seconds: number) => void;
  moveSelectedLayersOnCanvas: (dx: number, dy: number) => void;
  updateSelectedOpacity: (opacity: number) => void;
  updateSelectedTextStyle: (patch: Partial<TextStyle>) => void;
  updateSelectedShapeStyle: (patch: Partial<Pick<ShapeLayer, 'shape' | 'fill' | 'stroke' | 'stroke_width' | 'radius'>>) => void;
  setDrawingShape: (shape: import('../types').ShapeLayer['shape'] | null) => void;
  focusLayer: (layer: Layer) => void;
  setSelectedClip: (id: string | null) => void;
  selectTimelineItems: (keys: string[], mode?: 'replace' | 'add' | 'subtract') => void;
  copyTimelineItems: () => void;
  pasteTimelineItems: () => void;
  deleteTimelineItems: () => void;
  shiftTimelineItems: (seconds: number) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  /** 播放器每帧回调：一次写入 time / playing / lap，少触发几次重渲染。 */
  setPlayhead: (t: number, playing: boolean, lap: number) => void;
  setCropEditing: (on: boolean) => void;
  setPreviewVariant: (key: VariantKey) => void;
  setToast: (m: string | null, action?: ToastAction | null) => void;
  setShortcutsOpen: (on: boolean) => void;
  toggleSnap: () => void;
  setSafeZoneView: (v: SafeZoneView) => void;
  toggleTheme: () => void;
  /** 安全区开关：开着就关（none），关着就恢复上次的显示方式 */
  toggleSafeZone: () => void;
  setTimelinePps: (pps: number | null) => void;
  setTimelineViewPps: (pps: number) => void;

  currentSpec: () => EditSpec | null;
  currentVideo: () => Video | null;
  updateSpec: (fn: (spec: EditSpec) => void, opts?: { history?: boolean; videoId?: string }) => void;
  /** 整体替换某条视频的草稿 spec（null = 重置为空 spec），可记入历史，并安排自动保存。 */
  replaceSpec: (videoId: string, spec: EditSpec | null, opts?: { history?: boolean }) => void;
  /**
   * 把给定快照压入当前（或指定）视频的历史栈。给「输入期间 history=false、提交时才记一条」的编辑用：
   * 开始编辑时抓 cloneSpec(currentSpec) 存起来，提交时传进来；不要在提交时再用 updateLayer(id, {}, true)，
   * 那样记下的是改完之后的 spec，撤销会变成空操作。spec 本身没变，所以不触发自动保存。
   */
  pushHistorySnapshot: (snapshot: EditSpec, videoId?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // 剪辑
  addRemoveRange: (a: number, b: number) => void;
  updateRemoveRange: (index: number, a: number, b: number) => void;
  deleteRemoveRange: (index: number) => void;
  selectedRangeIndex: number | null;
  setSelectedRange: (i: number | null) => void;
  inPoint: number | null;
  setInPoint: (t: number | null) => void;
  setOutPoint: (t: number) => void;
  /** 删左：删除 [0, 当前源时间]。 */
  removeBefore: () => void;
  /** 删右：删除 [当前源时间, duration]。 */
  removeAfter: () => void;
  canRemoveBefore: () => boolean;
  canRemoveAfter: () => boolean;

  // 音频（契约 §2 audio）
  selectedTrackId: string | null;
  toggleVideoHidden: () => void;
  toggleVideoLocked: () => void;
  setSelectedTrack: (id: string | null) => void;
  setSourceVolume: (v: number) => void;
  /** 加一条音轨（素材须 ready）；按角色套默认值，返回新 id。 */
  /** init：拖进时间线时带上落点算出的时段等（HIG-33），覆盖按角色的默认值。 */
  addAudioTrack: (assetId: string, role: AudioRole, init?: Partial<Omit<AudioTrack, 'id' | 'asset_id' | 'role'>>) => string | null;
  updateAudioTrack: (id: string, patch: Partial<AudioTrack>, history?: boolean) => void;
  /** 改音轨速度（HIG-75）：同时按新速度调时段，让这条轨播的素材内容不变。 */
  setTrackSpeed: (id: string, speed: number) => void;
  removeAudioTrack: (id: string) => void;
  /** 音轨眼睛（HIG-33）：隐藏 / 显示，进撤销栈（影响成片）。 */
  toggleTrackHidden: (id: string) => void;
  toggleTrackLocked: (id: string) => void;
  /** 源音轨眼睛（HIG-33）：source_hidden 开关，source_volume 不动。 */
  toggleSourceHidden: () => void;
  toggleSourceLocked: () => void;
  /** 轨道改名（HIG-48）：空白 = 恢复自动名。进撤销历史。 */
  renameAudioTrack: (id: string, name: string) => void;
  renameSourceAudio: (name: string) => void;
  /** 在播放头处把音轨拆成两条（HIG-25），选中后一条；播放头不在时段内部时提示。 */
  splitAudioTrack: (id: string) => void;
  /** 删掉音轨在播放头左 / 右的部分（拆分后删一侧）。选中的是源音轨行（SOURCE_TRACK_ID）时改为加原声静音区间。 */
  cutTrackBefore: (id: string) => void;
  cutTrackAfter: (id: string) => void;
  /** 源音轨静音区间（契约 §2 audio.source_mute，剪后时间）。 */
  selectedMuteIndex: number | null;
  setSelectedMute: (i: number | null) => void;
  addSourceMute: (a: number, b: number) => void;
  updateSourceMute: (index: number, a: number, b: number) => void;
  deleteSourceMute: (index: number) => void;
  /** 人声 / 伴奏分离（契约 §3）：发起后轮询 GET /api/videos/{id} 直到 done / failed。 */
  separateVideo: (model: SeparationModel) => Promise<void>;
  /**
   * 用分离结果替换源音轨：静音源音轨，并加一条对齐源时间轴的音轨（人声 → 口播角色，伴奏 → BGM 角色）。
   * 返回新音轨 id；分离结果不可用时返回 null。
   */
  useStem: (stem: 'vocals' | 'instrumental') => string | null;

  // 改语言（契约 §1 localization / §3 localize）
  /** GET /api/localize/options 的结果；null = 还没拉。拉失败（旧后端没有这个接口等）按 enabled=false 处理。 */
  localizeOptions: LocalizeOptions | null;
  loadLocalizeOptions: () => Promise<void>;
  /** POST localize：听写（模板未就绪时）+ 逐语言生成；发起后轮询到全部结束。成功返回 true。 */
  localizeVideo: (body: LocalizeIn, opts?: { bgm: LocalizeBgmChoice }) => Promise<boolean>;
  /** 修正模板文本（PUT transcript）；不触发任务，已有版本会被标为 stale。 */
  updateTranscript: (edits: { i: number; text: string }[], sourceLang?: string) => Promise<boolean>;
  /** 改译文 / 换音色后只重跑 TTS + 混音（PUT versions/{lang}）。 */
  resynthesizeVersion: (lang: string, edits: { i: number; translated: string }[], voice?: string) => Promise<boolean>;
  /**
   * 「生成口播」（HIG-56）：按现有译文逐个语言合成；完成后按偏好自动套用发起顺序里第一个出口播的语言。
   * useSourceVoice（HIG-58）= 用复刻的原声合成，此时忽略每行选的音色。
   */
  dubVersions: (items: { lang: string; voice: string }[], opts?: { useSourceVoice?: boolean }) => Promise<boolean>;
  deleteVersion: (lang: string) => Promise<boolean>;
  /**
   * 把某个语言版本套用到当前视频：一次 updateSpec = 一步历史，toast 带「撤销」。
   * 已是当前套用的版本时不重复套（返回 false，不记历史）；force 强制重建层 / 轨（沿用已调过的字幕样式）。
   * 版本不可用（没生成完 / 配音素材不存在）时 toast 原因并返回 false。
   */
  applyVersion: (lang: string, opts?: { force?: boolean }) => boolean;

  // 画面文字（契约 §1 screen_text / §3 screen-text，HIG-38）
  /** GET /api/screen-text/options 的结果；null = 还没拉。拉失败按 enabled=false 处理。 */
  screenTextOptions: ScreenTextOptions | null;
  loadScreenTextOptions: () => Promise<void>;
  /** POST screen-text：识别（未识别过时）+ 逐语言翻译 + 可选擦除；发起后轮询到结束。 */
  runScreenText: (body: ScreenTextIn) => Promise<boolean>;
  /** 修正识别结果（PUT blocks）；不触发任务，译文与无字版会被标为 stale。 */
  updateScreenBlocks: (edits: { id: string; text?: string; enabled?: boolean }[]) => Promise<boolean>;
  /** 删掉无字版并切回原片。 */
  deleteScreenErase: () => Promise<boolean>;
  /** 手动切换正片用原片还是无字版；无字版不可用时 toast 原因并返回 false。 */
  setSourceVariant: (variant: SourceVariant) => boolean;

  // 图层
  /** 加一个图层并选中；belowType 指定要压在哪一类之下（遮盖插到第一个文字图层之前），缺省放最上层。 */
  addLayer: (layer: Layer, opts?: { belowType?: LayerType }) => void;
  /** 一次加入多个图层（标题模板），只记一步历史，选中第一个。 */
  addLayers: (layers: Layer[]) => void;
  updateLayer: (id: string, patch: Partial<Layer> | ((l: Layer) => void), history?: boolean) => void;
  /** 在播放头处把图层拆成两条（HIG-79，契约 §2「拆分图层」）；拆不了时弹提示。 */
  splitLayer: (id: string) => void;
  /** 在文本下标 offset 处把字幕图层拆成两条（HIG-36）：时段按光标前后的字数比例分。 */
  splitLayerAtCaret: (id: string, offset: number) => void;
  /** 把已套用的长字幕按当前设置补拆成多条（HIG-36）；只动字幕层，配音轨和 BGM 不变。 */
  resplitSubtitleLayers: () => void;
  removeLayer: (id: string) => void;
  // 层级操作都只在图层自己这一类（文字 / 贴纸）里换序，另一类的位置不动，见 lib/layerKind
  moveLayer: (id: string, dir: -1 | 1) => void;
  moveLayerTo: (id: string, where: 'top' | 'bottom') => void;
  /** 把图层挪到同类里的第 index 位（0 = 同类最下层；越界夹到边界）。 */
  moveLayerToIndex: (id: string, index: number) => void;
  duplicateLayer: (id: string) => void;
  /** 开始 / 取消「替换素材」（HIG-67）。 */
  setReplacingLayer: (id: string | null) => void;
  /**
   * 替换贴纸图层的素材（HIG-67）：只换 asset_id，位置、尺寸、时段、层级、名字、播放方式全部保留。
   * 素材内裁剪按新素材的时长收紧，放不下就整段播（lib/sourceTrim.retrimForAsset）。
   */
  replaceLayerAsset: (layerId: string, assetId: string) => void;
  copyLayer: () => void;
  pasteLayer: () => void;
  copyStyle: () => void;
  pasteStyle: () => void;
  /** 按 1080×1920 参考像素平移图层。 */
  nudgeLayer: (id: string, dx: number, dy: number, history?: boolean) => void;
  /** 设 / 清某画幅上某图层的覆盖（null = 清掉，恢复跟随视频）。 */
  setLayerOverride: (key: VariantKey, id: string, override: LayerOverride | null, history?: boolean) => void;
  /**
   * 预览的是非 9x16 画幅时，在该画幅画布上改图层的像素框并写成覆盖（脱离跟随）；fn 拿到当前框和锚点。
   * 预览的是 9x16 时什么都不做并返回 false，调用方照旧改图层本身。
   */
  editLayerOnPreview: (id: string, fn: (cur: { box: LayerBox; anchor: Anchor }) => { box: LayerBox; anchor?: Anchor; rotate?: number }, history?: boolean) => boolean;

  // 封面（契约 §2 cover，HIG-9）
  /** 设封面素材（贴纸库里的图片 / 视频，须 ready）；已有图片封面时沿用它的时长。 */
  setCover: (assetId: string) => void;
  setCoverDuration: (sec: number, history?: boolean) => void;
  clearCover: () => void;

  // 大字报（契约 §2 scroll / trim.duration，HIG-50）
  /**
   * 加一个滚动文案图层并选中：裁切框取当前安全区的内安全框（没有就用通用竖版缺省），
   * 样式用新建文字的缺省再调成大字报的字号 / 行距，按框宽自动折行。返回图层 id；没有当前视频时 null。
   */
  addPosterLayer: (text?: string) => string | null;
  /** 当前视频的第一个滚动文字图层；没有时 null。 */
  posterLayer: () => TextLayer | null;
  /** 改滚动参数（合并进 layer.scroll，缺省值补齐）；改框时宽度与折行宽跟着框宽走，之后重算成片时长。 */
  setScroll: (id: string, patch: Partial<TextScroll>, history?: boolean) => void;
  /** 改文案：上色区间随文字平移（与属性面板一致）；PNG 重新渲染后按新高度重算成片时长。 */
  setPosterText: (id: string, text: string, history?: boolean) => void;
  /** 把滚动图层的预览 PNG 尺寸写进 image_size（不记历史）并重算成片时长；画布渲染完和改文案 / 改框后都调它。 */
  syncPosterLayer: (id: string) => Promise<void>;
  /**
   * 生成朗读（POST /api/tts）：素材进 assets 并轮询，就绪后替换掉当前视频里已有的朗读轨（tts 派生素材）、
   * 加为口播轨（从 0 起播到素材结束），再重算成片时长。返回素材 id；请求失败 toast 原因（含 503 的 detail）并返回 null。
   */
  generateVoice: (text: string, lang: string, voice: string, speechRate?: number) => Promise<string | null>;
  /** 让后端挑重点词组并上色（并入已有区间，记一步历史）；失败 toast 并返回 false。 */
  autoHighlight: (id: string) => Promise<boolean>;
  /**
   * 按滚动全程与朗读时长把 trim.duration 写成 posterDuration（不记历史，只在变了时写）；
   * 没有滚动图层也没有口播轨时清掉。滚动图层还没渲染出 PNG（算不出时长）时保持原值。
   */
  syncPosterDuration: () => void;

  // 画面（唯一的 9:16 输出）
  /** 改某个画幅的输出设置（缺省 = previewVariantKey）；spec 里还没有这个画幅时先按缺省补上。 */
  patchOutput: (patch: Partial<OutputVariant>, key?: VariantKey) => void;
  /** 当前视频导出时勾选哪些画幅（HIG-35）：写进 outputs[].export，缺的画幅按缺省补上。 */
  setExportVariants: (keys: VariantKey[]) => void;
  /** 写 9:16 输出的裁切窗口；null = 删掉（回到 cover 居中）。 */
  setCrop: (rect: CropRect | null, history?: boolean, key?: VariantKey) => void;

  // 批量 / 渲染
  applyToTargets: (targetIds: string[], modules: ApplyModule[], opts?: { layerMode?: ApplyLayerMode }) => Promise<void>;
  /** 撤销最近一次批量应用：把每个目标恢复到应用前的 spec。 */
  undoLastApply: () => void;
  /** opts.name：导出名称，写到本次建出的每个任务上（HIG-27）。 */
  /** variantKeys：这次导出哪些画幅（缺省只出 9x16）。 */
  /** langs（HIG-43）：多语言导出，勾选的语言码（含 'original' = 原版）；每条视频每个语言各带一份套用好的 spec 快照，编辑器里的 spec 不动。缺省 / 空 = 按当前 spec 出一份。 */
  saveAndRender: (targetIds: string[], opts?: { name?: string; variantKeys?: VariantKey[]; langs?: string[]; outputFormat?: 'source' | 'mp4' | 'mov' | 'png' | 'jpg' }) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  closeProgress: () => void;
  openExport: (req?: ExportDialogRequest) => void;
  closeExport: () => void;
  openProgressFor: (jobs: Job[]) => void;
  flushSave: () => Promise<void>;
}

/**
 * 每个批次都该归零的状态。初始 store 和切换批次时的重置共用这一份，
 * 免得以后新增字段只在其中一处同步（HIG-18）。
 *
 * 跨批次的东西不在这里，清掉它们是倒退：safeZones / safeZoneKey（服务端常量，
 * load 里本来就有复用逻辑）、safeZoneView / safeZoneMode / theme（本机偏好）、
 * textPresets（全局预设）、assets（素材库是全局的，不按批次隔离）。
 */
const PER_BATCH_INITIAL = {
  batch: null,
  videos: [],
  loading: false,
  error: null,
  currentVideoId: null,
  selectedIds: [],
  step: 'trim',
  specs: {},
  history: {},
  selectedLayerId: null,
  selectedLayerIds: [],
  subtitleSyncEnabled: false,
  drawingShape: null,
  layerFocusVersion: 0,
  replacingLayerId: null,
  selectedClipId: null,
  timelineSelection: [],
  hasTimelineClipboard: false,
  selectedRangeIndex: null,
  selectedTrackId: null,
  selectedMuteIndex: null,
  inPoint: null,
  time: 0,
  playing: false,
  lap: 0,
  posterVoicePending: null,
  saveState: 'idle',
  saveError: null,
  cropEditing: false,
  previewVariantKey: '9x16',
  jobs: [],
  trackedJobIds: [],
  progressOpen: false,
  exportDialog: null,
  rendering: false,
  toast: null,
  toastAction: null,
  shortcutsOpen: false,
  snapEnabled: true,
  timelinePps: null,
  timelineViewPps: 32,
  layerClipboard: null,
  layerClipboardVideoId: null,
  styleClipboard: null,
  lastApply: null,
  outputCalibration: {},
  appendProgress: null,
} satisfies Partial<EditorState>;

const saveTimers: Record<string, number> = {};
let pollTimer: number | null = null;
let assetPollTimer: number | null = null;
let videoPollTimer: number | null = null;
/** 轮询到素材不再 preparing 时的回调（store 创建时赋值）：大字报的朗读素材就绪后自动加轨（HIG-50）。 */
let onAssetSettled: (asset: Asset) => void = () => {};
/** 发起朗读合成时的视频 id：就绪后加到它上面（期间可能换了视频）。 */
let posterVoiceVideoId: string | null = null;

/**
 * 视频贴纸是异步预处理的：preparing 期间没有尺寸也没有预览代理，画布画不出来。
 * 轮到 ready / failed 为止，让编辑器里的贴纸自己"长出来"。
 */
function pollPreparingAssets(set: (fn: (s: EditorState) => Partial<EditorState>) => void, get: () => EditorState) {
  if (assetPollTimer !== null) return;
  const tick = async () => {
    assetPollTimer = null;
    const pending = get().assets.filter((a) => (a.status ?? 'ready') === 'preparing');
    if (!pending.length) return;
    const updated = (await Promise.all(pending.map((a) => api.getAsset(a.id).catch(() => null)))).filter(
      (a): a is Asset => !!a,
    );
    if (updated.length) {
      const byId = new Map(updated.map((a) => [a.id, a]));
      set((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }));
      for (const a of updated) if ((a.status ?? 'ready') !== 'preparing') onAssetSettled(a);
    }
    if (get().assets.some((a) => (a.status ?? 'ready') === 'preparing')) {
      assetPollTimer = window.setTimeout(tick, 2000);
    }
  };
  assetPollTimer = window.setTimeout(tick, 2000);
}

/** 视频上会异步变化、需要轮询的字段：分离（separation）和改语言（localization）。 */
type PolledField = 'separation' | 'localization' | 'screen_text';
const fieldTimers: Record<string, number> = {};
/** 视频 id → 这轮「生成口播」发起的语言（按顺序）；改语言轮询结束时据此自动套用（HIG-56）。 */
const dubRequests: Record<string, string[]> = {};
const quickRequests: Record<string, { langs: string[]; readyLang?: string }> = {};
const BGM_CHOICE_KEY = 'hitgo.localizeBgm';
const bgmChoiceMemory: Record<string, LocalizeBgmChoice> = {};

export function loadLocalizeBgm(videoId: string): LocalizeBgmChoice {
  if (bgmChoiceMemory[videoId]) return bgmChoiceMemory[videoId];
  try {
    const choice = JSON.parse(localStorage.getItem(BGM_CHOICE_KEY) ?? '{}')?.[videoId];
    if (choice?.mode === 'replace' && typeof choice.assetId === 'string') return (bgmChoiceMemory[videoId] = { mode: 'replace', assetId: choice.assetId });
  } catch { /* localStorage unavailable or stale */ }
  return { mode: 'keep' };
}

function saveLocalizeBgm(videoId: string, choice: LocalizeBgmChoice) {
  bgmChoiceMemory[videoId] = choice;
  try {
    const all = JSON.parse(localStorage.getItem(BGM_CHOICE_KEY) ?? '{}');
    localStorage.setItem(BGM_CHOICE_KEY, JSON.stringify({ ...(all && typeof all === 'object' ? all : {}), [videoId]: choice }));
  } catch { /* private mode: this run still uses the selected choice in memory */ }
}

function clearLocalizeBgm(videoId: string) {
  delete bgmChoiceMemory[videoId];
  try {
    const all = JSON.parse(localStorage.getItem(BGM_CHOICE_KEY) ?? '{}');
    if (all && typeof all === 'object') {
      delete all[videoId];
      localStorage.setItem(BGM_CHOICE_KEY, JSON.stringify(all));
    }
  } catch { /* localStorage unavailable */ }
}

function applyQuickWhenReady(videoId: string, get: () => EditorState) {
  const pending = quickRequests[videoId];
  if (!pending?.readyLang) return;
  const video = get().videos.find((v) => v.id === videoId);
  if (!video) { delete quickRequests[videoId]; return; }
  const bgm = loadLocalizeBgm(videoId);
  if (bgm.mode === 'keep') {
    if (fieldActive(video, 'separation')) return;
    if (video.separation?.status !== 'done' || !video.separation.instrumental_asset_id) {
      get().setToast('口播已生成，但原伴奏分离失败；未自动套用，请重试分离');
      delete quickRequests[videoId];
      return;
    }
  } else if (!isAssetReady(get().assets.find((a) => a.id === bgm.assetId))) {
    get().setToast('口播已生成，但所选 BGM 不可用；未自动套用');
    delete quickRequests[videoId];
    return;
  }
  if (get().currentVideoId === videoId) get().applyVersion(pending.readyLang, { force: true });
  else get().setToast(`${video.name} 的口播已生成；切回视频后可套用`);
  delete quickRequests[videoId];
}

/** 该字段是否还有后台任务在跑：分离看 status；改语言看听写和所有版本。 */
function fieldActive(video: Video | null | undefined, field: PolledField): boolean {
  if (field === 'separation') {
    const st = video?.separation?.status;
    return st === 'queued' || st === 'running';
  }
  if (field === 'screen_text') return screenTextActive(video?.screen_text);
  return isLocalizationActive(video?.localization);
}

/**
 * 分离 / 改语言都是后台任务：每 2 秒拉一次视频，只更新那个字段，直到它不再 active；
 * 结束后重新拉素材列表让新音轨出现，并按字段各自给一句提示。load() 时对进行中的视频也会调它恢复轮询。
 */
function pollVideoField(videoId: string, field: PolledField, set: (fn: (s: EditorState) => Partial<EditorState>) => void, get: () => EditorState) {
  const key = `${field}:${videoId}`;
  if (fieldTimers[key]) return;
  // 起点快照：改语言结束时只报告这轮里变过的版本
  const before = get().videos.find((v) => v.id === videoId)?.localization ?? null;
  const tick = async () => {
    delete fieldTimers[key];
    let fresh: Video | null = null;
    try {
      fresh = await api.getVideo(videoId);
    } catch {
      /* 断网 / 视频被删：下一轮再试；被删时 videos 里也不会再有它 */
    }
    if (!get().videos.some((v) => v.id === videoId)) return;
    if (fresh) set((s) => ({ videos: s.videos.map((v) => (v.id === fresh!.id ? { ...v, [field]: fresh![field] } : v)) }));
    if (fresh && !fieldActive(fresh, field)) {
      await get().loadAssets();
      if (field === 'separation') {
        if (fresh.separation?.status === 'done') get().setToast('人声 / 伴奏已分离，可在音频模块里使用');
        else get().setToast(`分离失败：${fresh.separation?.error ?? '未知原因'}`);
        applyQuickWhenReady(videoId, get);
      } else if (field === 'screen_text') {
        get().setToast(screenTextFinishText(fresh.screen_text));
      } else {
        const text = localizationFinishText(before, fresh.localization, get().localizeOptions);
        if (text) get().setToast(text);
        const quick = quickRequests[videoId];
        const requested = [...(dubRequests[videoId] ?? []), ...(quick?.langs ?? [])];
        delete dubRequests[videoId];
        const lang = autoApplyLang(before, fresh.localization, requested);
        if (lang && loadFeaturePrefs().autoApplyDub) {
          if (quick) {
            quick.readyLang = lang;
            applyQuickWhenReady(videoId, get);
          } else {
            // 切到别的视频就不动它的 spec：提示回去手动套用
            if (get().currentVideoId === videoId) get().applyVersion(lang, { force: true });
            else get().setToast(`${fresh.name} 的${langLabel(get().localizeOptions, lang)}口播已生成；切回该视频在「套用」里套用`);
          }
        }
        if (!lang || !loadFeaturePrefs().autoApplyDub) delete quickRequests[videoId];
      }
      return;
    }
    if (!get().videos.some((v) => v.id === videoId)) return;
    fieldTimers[key] = window.setTimeout(tick, 2000);
  };
  fieldTimers[key] = window.setTimeout(tick, 2000);
}

/** 把服务器回的视频里的某个字段合进 videos（202 回的是整条 Video，但只信任任务字段，草稿 spec 不动）。 */
function mergeVideoField(set: (fn: (s: EditorState) => Partial<EditorState>) => void, updated: Video, field: PolledField) {
  set((s) => ({ videos: s.videos.map((v) => (v.id === updated.id ? { ...v, [field]: updated[field] } : v)) }));
}

function ensureAudio(spec: EditSpec): AudioSpec {
  if (!spec.audio) spec.audio = { source_volume: 1, tracks: [] };
  return spec.audio;
}

function ensureHistory(h: Record<string, History>, id: string): History {
  if (!h[id]) h[id] = { past: [], future: [] };
  return h[id];
}

/** 每类图层归哪个模块管（粘贴提示用）。 */
const LAYER_HOME: Record<Layer['type'], { kind: string; step: string }> = {
  text: { kind: '文字', step: '文本' },
  sticker: { kind: '贴纸', step: '贴纸' },
  mask: { kind: '遮盖', step: '字幕' },
  shape: { kind: '图形', step: '贴纸' },
};

export const useEditor = create<EditorState>((set, get) => {
  /** 播放头的剪后时刻、剪后时长，以及把音轨 id 在这里拆开的两条（拆不了时提示并返回 null）。HIG-25。 */
  const playheadPost = () => {
    const v = get().currentVideo();
    const spec = get().currentSpec();
    if (!v || !spec) return null;
    const remove = spec.trim.remove;
    // 成片时刻跨遍累加（HIG-50 循环补足）；时长按成片时长，音轨可以排到循环补足的那段里
    const duration = selectSourceDuration(get());
    return { spec, p: postTimeOf(get().lap, postTrimDuration(duration, remove), sourceToPost(Math.max(0, get().time), remove)), postDuration: outputDuration(duration, spec.trim) };
  };
  const splitAt = (id: string) => {
    const ctx = playheadPost();
    const track = ctx?.spec.audio?.tracks.find((t) => t.id === id);
    if (!ctx || !track || track.locked) return null;
    const media = get().assets.find((a) => a.id === track.asset_id)?.duration ?? 0;
    const parts = splitTrackAt(track, ctx.p, ctx.postDuration, media, newTrackId());
    if (!parts) set({ toast: '播放头不在这条音轨的时段内（离两端至少 0.1 秒），移到要剪的位置再拆分', toastAction: null });
    return parts;
  };
  const cutTrack = (id: string, side: 'before' | 'after') => {
    if (id === SOURCE_TRACK_ID) {
      if (get().currentSpec()?.audio?.source_locked) return;
      const ctx = playheadPost();
      if (!ctx) return;
      if (side === 'before') get().addSourceMute(0, ctx.p);
      else get().addSourceMute(ctx.p, ctx.postDuration);
      set({ toast: side === 'before' ? '已静音播放头左侧的原声' : '已静音播放头右侧的原声', toastAction: { label: '撤销', run: () => get().undo() } });
      return;
    }
    const parts = splitAt(id);
    if (!parts) return;
    const keep = side === 'before' ? parts[1] : parts[0];
    get().updateSpec((spec) => {
      const tracks = spec.audio?.tracks;
      const i = tracks?.findIndex((t) => t.id === id) ?? -1;
      if (tracks && i >= 0) tracks.splice(i, 1, keep);
    });
    set({ selectedTrackId: keep.id, toast: side === 'before' ? '已删除音轨在播放头左侧的部分' : '已删除音轨在播放头右侧的部分', toastAction: { label: '撤销', run: () => get().undo() } });
  };
  const scheduleSave = (videoId: string) => {
    set({ saveState: 'dirty' });
    if (saveTimers[videoId]) window.clearTimeout(saveTimers[videoId]);
    saveTimers[videoId] = window.setTimeout(() => {
      delete saveTimers[videoId];
      void saveNow(videoId);
    }, 1000);
  };

  const saveNow = async (videoId: string) => {
    const spec = get().specs[videoId];
    const video = get().videos.find((v) => v.id === videoId);
    if (!spec || !video) return;
    set({ saveState: 'saving' });
    try {
      const saved = await api.putSpec(videoId, toContractSpec(spec, video.duration));
      if (!get().videos.some((v) => v.id === videoId)) return;
      set((s) => ({
        saveState: 'saved',
        saveError: null,
        videos: s.videos.map((v) => (v.id === videoId ? { ...saved, edit_spec: v.edit_spec ?? saved.edit_spec } : v)),
      }));
    } catch (e) {
      if (!get().videos.some((v) => v.id === videoId)) return;
      set({ saveState: 'error', saveError: e instanceof Error ? e.message : String(e) });
    }
  };

  const startPolling = () => {
    if (pollTimer) return;
    const tick = async () => {
      const ids = get().trackedJobIds;
      if (!ids.length) {
        pollTimer = null;
        return;
      }
      try {
        const jobs = await api.getJobs(ids);
        set({ jobs });
        const unfinished = jobs.some((j) => j.status === 'queued' || j.status === 'running');
        await get().refreshVideos();
        if (!unfinished) {
          pollTimer = null;
          return;
        }
      } catch {
        /* 下一轮重试 */
      }
      pollTimer = window.setTimeout(tick, 1500);
    };
    pollTimer = window.setTimeout(tick, 300);
  };

  /**
   * 换批次前把上一个工程清干净。store 是模块级单例，光靠 load 的 set 覆盖不了
   * 全部字段，模块级定时器和 player 更不会自己复位（HIG-18）。
   */
  /**
   * 源视频上传后是异步预处理的（HIG-24）：只要列表里还有 preparing，就每 2 秒重拉一次批次详情，
   * 让状态、尺寸、封面自己更新，不用刷新页面。refreshVideos 只换服务端字段，草稿 spec 不动。
   */
  const pollPreparingVideos = () => {
    if (videoPollTimer !== null) return;
    const tick = async () => {
      videoPollTimer = null;
      if (!get().batch || !hasPreparingVideos(get().videos)) return;
      await get().refreshVideos(); // 失败时它自己吞掉，下一轮再试
      if (get().batch && hasPreparingVideos(get().videos)) videoPollTimer = window.setTimeout(tick, 2000);
    };
    videoPollTimer = window.setTimeout(tick, 2000);
  };

  const resetForNewBatch = () => {
    for (const id of Object.keys(saveTimers)) {
      window.clearTimeout(saveTimers[id]);
      delete saveTimers[id];
    }
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (assetPollTimer !== null) {
      window.clearTimeout(assetPollTimer);
      assetPollTimer = null;
    }
    if (videoPollTimer !== null) {
      window.clearTimeout(videoPollTimer);
      videoPollTimer = null;
    }
    player.pause();
    player.setPreroll(0); // 封面时长是 player 的跨视频状态，不清会带进新任务的播放头计算
    player.setOutputDuration(null); // 成片时长同理（HIG-50）
    set({ ...PER_BATCH_INITIAL });
  };

  // 朗读素材就绪 / 失败（HIG-50）：替换掉那条视频里已有的朗读轨，加为口播轨；期间换了视频也加到发起时的那条上
  onAssetSettled = (asset) => {
    if (asset.id !== get().posterVoicePending) return;
    const videoId = posterVoiceVideoId;
    posterVoiceVideoId = null;
    set({ posterVoicePending: null });
    if ((asset.status ?? 'ready') !== 'ready') {
      get().setToast(`朗读生成失败：${asset.error ?? '未知原因'}`);
      return;
    }
    if (!videoId || !get().videos.some((v) => v.id === videoId)) return;
    const id = newTrackId();
    const assets = get().assets;
    get().updateSpec(
      (spec) => {
        const audio = ensureAudio(spec);
        audio.tracks = audio.tracks.filter((t) => assets.find((a) => a.id === t.asset_id)?.derived_from?.stem !== 'tts');
        audio.tracks.push(voiceTrack(id, asset.id, asset.duration ?? 0));
      },
      { videoId },
    );
    // 跟随朗读调速（HIG-75）：条目要的是「朗读多少秒，大字报就滚多少秒」。以前这一步要用户
    // 手点「配合朗读调速」，现在生成完自动跑一次；速度滑杆照旧可以再改，开关可以关掉。
    let fitted = false;
    if (loadFeaturePrefs().posterFitVoiceSpeed && (asset.duration ?? 0) > 0) {
      const layer = (get().specs[videoId]?.layers ?? []).find((l): l is TextLayer => l.type === 'text' && !!l.scroll && !l.hidden);
      if (layer) {
        const speed = fitScrollSpeed(layer, asset.duration!);
        if (Math.abs(speed - resolveScroll(layer.scroll).speed) > 1e-6) {
          get().updateSpec(
            (spec) => {
              const l = spec.layers.find((x) => x.id === layer.id);
              if (l?.type === 'text' && l.scroll) l.scroll = { ...l.scroll, speed };
            },
            { videoId },
          );
          fitted = true;
        }
      }
    }
    if (videoId === get().currentVideoId) {
      set({ selectedTrackId: id });
      get().syncPosterDuration();
    }
    get().setToast(fitted ? '朗读已生成，已加为口播轨并按朗读时长调好滚动速度' : '朗读已生成，已加为口播轨');
  };

  return {
    ...PER_BATCH_INITIAL,
    safeZones: [],
    safeZoneKey: 'generic-vertical',
    assets: [],
    safeZoneView: loadSafeZoneView(),
    safeZoneMode: loadSafeZoneMode(loadSafeZoneView()),
    theme: loadTheme(),
    textPresets: BUILTIN_TEXT_PRESETS,
    localizeOptions: null,

    load: async (batchId) => {
      // 切批次时 /batches/:id 的 element 不变，EditorPage 不卸载，它的 cleanup 不跑：
      // 上一个批次的草稿只能在这里写回（否则最后 1 秒的编辑会被静默丢掉），再整份归零
      await get().flushSave();
      resetForNewBatch();
      set({ loading: true, error: null });
      try {
        const [batch, zones] = await Promise.all([api.getBatch(batchId), get().safeZones.length ? Promise.resolve(get().safeZones) : api.safeZones()]);
        const specs: Record<string, EditSpec> = {};
        // 旧 spec 的 outputs 在载入时就规范化（补 9x16、旧多画幅改为跟随视频）；就绪的视频随后自动保存写回（未就绪的后端不收 spec）
        const collapsed: string[] = [];
        for (const v of batch.videos) {
          if (!v.edit_spec) {
            specs[v.id] = emptySpec();
            continue;
          }
          const draft = cloneSpec(v.edit_spec);
          specs[v.id] = normalizeSequenceAudio(normalizeOutputs(draft), v.id);
          if (specs[v.id] !== draft && v.status === 'ready') collapsed.push(v.id);
        }
        const currentVideoId = batch.videos[0]?.id ?? null;
        set({
          batch,
          videos: batch.videos,
          specs,
          history: {},
          safeZones: zones,
          safeZoneKey: zones.find((z) => z.key === get().safeZoneKey)?.key ?? zones[0]?.key ?? 'generic-vertical',
          currentVideoId,
          selectedIds: [],
          selectedLayerId: null, selectedLayerIds: [],
          time: 0,
          loading: false,
          saveState: 'idle',
          lastApply: null,
          outputCalibration: {},
          step: 'trim',
          cropEditing: false,
          previewVariantKey: '9x16',
        });
        for (const id of collapsed) scheduleSave(id);
        pollPreparingVideos();
        void get().loadAssets();
        void get().loadTextPresets();
        // 刷新页面时分离 / 改语言可能还在跑：恢复轮询，结束时照常提示
        for (const v of batch.videos) {
          if (fieldActive(v, 'separation')) pollVideoField(v.id, 'separation', set, get);
          if (fieldActive(v, 'localization')) pollVideoField(v.id, 'localization', set, get);
        }
        // 恢复未完成的渲染任务
        try {
          const jobs = await api.batchJobs(batchId);
          const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
          if (active.length) {
            set({ jobs: active, trackedJobIds: active.map((j) => j.id) });
            startPolling();
          }
        } catch {
          /* ignore */
        }
      } catch (e) {
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },

    refreshVideos: async () => {
      const b = get().batch;
      if (!b) return;
      try {
        const fresh = await api.getBatch(b.id);
        if (get().batch?.id !== b.id) return; // 请求途中换了批次
        set((s) => ({
          batch: fresh,
          videos: fresh.videos,
          specs: Object.fromEntries(fresh.videos.map((v) => [v.id, s.specs[v.id] ?? (v.edit_spec ? normalizeSequenceAudio(normalizeOutputs(cloneSpec(v.edit_spec)), v.id) : emptySpec())])),
          selectedIds: s.selectedIds.filter((id) => fresh.videos.some((v) => v.id === id)),
          currentVideoId: nextCurrentAfterDelete(s.videos, s.currentVideoId, s.videos.filter((v) => !fresh.videos.some((f) => f.id === v.id)).map((v) => v.id)) ?? fresh.videos[0]?.id ?? null,
        }));
      } catch {
        /* ignore */
      }
    },

    appendVideos: async (files) => {
      const b = get().batch;
      if (!b || !files.length || get().appendProgress !== null) return [];
      set({ appendProgress: 0 });
      try {
        const created = await api.uploadVideos(b.id, files, (f) => {
          if (get().batch?.id === b.id) set({ appendProgress: f });
        });
        if (get().batch?.id !== b.id) return [];
        await get().refreshVideos();
        set((s) => ({ appendProgress: null, currentVideoId: s.currentVideoId ?? created[0]?.id ?? null, toast: `已追加 ${created.length} 条视频，预处理完成后即可编辑`, toastAction: null }));
        pollPreparingVideos();
        return created.map((v) => v.id);
      } catch (e) {
        if (get().batch?.id === b.id) set({ appendProgress: null, toast: `追加视频失败：${uploadErrorText(e)}`, toastAction: null });
        return [];
      }
    },

    deleteVideos: async (ids) => {
      const b = get().batch;
      if (!b || !ids.length) return;
      const deleted: string[] = [];
      const failures: string[] = [];
      for (const id of ids) {
        const name = get().videos.find((v) => v.id === id)?.name ?? id;
        try {
          await api.deleteVideo(id);
          deleted.push(id);
        } catch (e) {
          // 404 = 别处已经删了，按删成功处理
          if (e instanceof ApiError && e.status === 404) deleted.push(id);
          else failures.push(`「${name}」${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (get().batch?.id !== b.id) return;
      if (deleted.length) {
        for (const id of deleted) {
          if (saveTimers[id]) {
            window.clearTimeout(saveTimers[id]);
            delete saveTimers[id];
          }
          for (const field of ['separation', 'localization'] as const) {
            const key = `${field}:${id}`;
            if (fieldTimers[key]) window.clearTimeout(fieldTimers[key]);
            delete fieldTimers[key];
          }
          delete dubRequests[id];
          delete quickRequests[id];
          clearLocalizeBgm(id);
        }
        const gone = new Set(deleted);
        const deletedPosterVoice = !!posterVoiceVideoId && gone.has(posterVoiceVideoId);
        if (deletedPosterVoice) posterVoiceVideoId = null;
        const s = get();
        const nextId = nextCurrentAfterDelete(s.videos, s.currentVideoId, deleted);
        if (nextId !== s.currentVideoId) {
          player.pause();
          if (!nextId) {
            player.setPreroll(0);
            player.setOutputDuration(null);
          }
        }
        const omit = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !gone.has(id)));
        const videos = s.videos.filter((v) => !gone.has(v.id));
        set({
          videos,
          batch: s.batch ? { ...s.batch, videos, video_count: videos.length } : s.batch,
          specs: omit(s.specs),
          history: omit(s.history),
          selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
          jobs: s.jobs.filter((j) => !gone.has(j.video_id)),
          trackedJobIds: s.trackedJobIds.filter((id) => !s.jobs.some((j) => j.id === id && gone.has(j.video_id))),
          lastApply: s.lastApply && s.lastApply.targetIds.some((id) => gone.has(id)) ? null : s.lastApply,
          layerClipboard: s.layerClipboardVideoId && gone.has(s.layerClipboardVideoId) ? null : s.layerClipboard,
          layerClipboardVideoId: s.layerClipboardVideoId && gone.has(s.layerClipboardVideoId) ? null : s.layerClipboardVideoId,
          posterVoicePending: deletedPosterVoice ? null : s.posterVoicePending,
          ...(nextId !== s.currentVideoId
            ? { currentVideoId: nextId, selectedLayerId: null, selectedLayerIds: [], selectedClipId: null, replacingLayerId: null, selectedRangeIndex: null, selectedTrackId: null, selectedMuteIndex: null, inPoint: null, time: 0, playing: false, lap: 0, cropEditing: false, timelinePps: null, exportDialog: null, progressOpen: false, saveState: 'idle', saveError: null }
            : {}),
        });
      }
      const ok = deleted.length ? `已删除 ${deleted.length} 条视频` : '';
      const bad = failures.length ? `删除失败：${failures.join('；')}` : '';
      set({ toast: [ok, bad].filter(Boolean).join('。') || null, toastAction: null });
    },

    renameBatch: async (name) => {
      const b = get().batch;
      const nm = name.trim();
      if (!b || !nm) return false;
      if (nm === b.name) return true;
      try {
        const updated = await api.renameBatch(b.id, nm);
        set((s) => (s.batch?.id === b.id ? { batch: { ...s.batch, name: updated.name } } : {}));
        return true;
      } catch (e) {
        set({ toast: `重命名失败：${e instanceof Error ? e.message : String(e)}`, toastAction: null });
        return false;
      }
    },

    renameVideo: async (id, name) => {
      const v = get().videos.find((x) => x.id === id);
      const nm = name.trim();
      if (!v || !nm) return false;
      if (nm === v.name) return true;
      try {
        const updated = await api.renameVideo(id, nm);
        // 只换名字：返回的整条 Video 里的 edit_spec 可能比本地草稿旧
        set((s) => ({ videos: s.videos.map((x) => (x.id === id ? { ...x, name: updated.name } : x)) }));
        return true;
      } catch (e) {
        set({ toast: `重命名失败：${e instanceof Error ? e.message : String(e)}`, toastAction: null });
        return false;
      }
    },

    loadAssets: async () => {
      try {
        const [stickers, fonts, audio] = await Promise.all([api.listAssets('sticker'), api.listAssets('font'), api.listAssets('audio').catch(() => [] as Asset[])]);
        set({ assets: [...stickers, ...fonts, ...audio] });
        void ensureFontsLoaded(fonts);
        pollPreparingAssets(set, get);
      } catch {
        /* ignore */
      }
    },

    loadTextPresets: async () => {
      try {
        const list = await api.listPresets('text_style');
        const user: TextStylePreset[] = list.map((p) => ({ id: p.id, name: p.name, style: p.data as Partial<TextStyle> }));
        set({ textPresets: [...BUILTIN_TEXT_PRESETS, ...user] });
      } catch {
        set({ textPresets: BUILTIN_TEXT_PRESETS });
      }
    },
    saveTextPreset: async (name, style) => {
      const nm = name.trim();
      if (!nm) return;
      try {
        // 预设不带对齐：套用时保留当前图层的对齐方式
        const { align: _align, ...data } = style;
        void _align;
        const p = await api.createPreset({ type: 'text_style', name: nm, data });
        set((s) => ({ textPresets: [...s.textPresets, { id: p.id, name: p.name, style: p.data as Partial<TextStyle> }], toast: `已保存预设「${p.name}」`, toastAction: null }));
      } catch (e) {
        set({ toast: `保存预设失败：${e instanceof Error ? e.message : String(e)}`, toastAction: null });
      }
    },
    deleteTextPreset: async (id) => {
      const target = get().textPresets.find((p) => p.id === id);
      if (!target || target.builtin) return;
      try {
        await api.deletePreset(id);
        set((s) => ({ textPresets: s.textPresets.filter((p) => p.id !== id) }));
      } catch (e) {
        set({ toast: `删除预设失败：${e instanceof Error ? e.message : String(e)}`, toastAction: null });
      }
    },
    loadOutputCalibration: async () => {
      const b = get().batch;
      if (!b) return;
      try {
        const done = await api.batchOutputs(b.id);
        set({ outputCalibration: calibrationFromJobs(done) });
      } catch {
        /* 估算退回码率表 */
      }
    },

    setCurrent: (id) => {
      if (id === get().currentVideoId) return;
      player.pause();
      set({ currentVideoId: id, selectedLayerId: null, selectedLayerIds: [], subtitleSyncEnabled: false, selectedClipId: null, timelineSelection: [], selectedRangeIndex: null, selectedTrackId: null, selectedMuteIndex: null, inPoint: null, time: 0, playing: false, lap: 0, cropEditing: false, timelinePps: null });
    },
    toggleSelected: (id) =>
      set((s) => ({ selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id] })),
    setSelectedAll: (on) => set((s) => ({ selectedIds: on ? s.videos.map((v) => v.id) : [] })),
    setStep: (step) => {
      player.pause();
      // 选中的图层 / 区间 / 音轨只属于原模块：切模块时不保留上个模块的选择
      set({ step, selectedLayerId: null, selectedLayerIds: [], timelineSelection: [], drawingShape: step === 'sticker' ? get().drawingShape : null, selectedRangeIndex: null, selectedTrackId: null, selectedMuteIndex: null, inPoint: null, cropEditing: false });
    },
    setSafeZoneKey: (safeZoneKey) => set({ safeZoneKey }),
    setSelectedLayer: (selectedLayerId) => set({ selectedLayerId, selectedLayerIds: selectedLayerId ? [selectedLayerId] : [] }),
    setSubtitleSyncEnabled: (subtitleSyncEnabled) => set({ subtitleSyncEnabled }),
    selectLayers: (ids, mode = 'replace') => {
      const spec = get().currentSpec();
      if (!spec) return;
      const valid = new Set(spec.layers.filter((l) => !l.hidden && !l.locked).map((l) => l.id));
      const incoming = ids.filter((id) => valid.has(id));
      const old = get().selectedLayerIds.filter((id) => valid.has(id));
      const next = mode === 'add' ? [...new Set([...old, ...incoming])] : mode === 'subtract' ? old.filter((id) => !incoming.includes(id)) : incoming;
      const primary = spec.layers.find((l) => l.id === next[next.length - 1]);
      if (primary && (get().step === 'trim' || get().step === 'audio')) get().setStep(stepForLayer(primary));
      set({ selectedLayerIds: next, selectedLayerId: next[next.length - 1] ?? null });
    },
    selectAllLayers: () => get().selectLayers((get().currentSpec()?.layers ?? []).map((l) => l.id)),
    removeSelectedLayers: () => {
      const ids = new Set(get().selectedLayerIds);
      if (!ids.size && get().selectedLayerId) ids.add(get().selectedLayerId!);
      if (!ids.size) return;
      get().updateSpec((spec) => { spec.layers = spec.layers.filter((l) => !ids.has(l.id) || l.locked); });
      set({ selectedLayerId: null, selectedLayerIds: [] });
      get().syncPosterDuration();
    },
    duplicateSelectedLayers: () => {
      const ids = new Set(get().selectedLayerIds);
      if (!ids.size && get().selectedLayerId) ids.add(get().selectedLayerId!);
      if (!ids.size) return;
      const copies: string[] = [];
      get().updateSpec((spec) => {
        spec.layers = spec.layers.flatMap((l) => {
          if (!ids.has(l.id) || l.locked) return [l];
          const copy = { ...cloneSpec({ ...emptySpec(), layers: [l] }).layers[0], id: newLayerId(), margin: [round4(l.margin[0] + 0.03), round4(l.margin[1] + 0.03)] as [number, number] };
          copies.push(copy.id);
          return [l, copy];
        });
      });
      set({ selectedLayerIds: copies, selectedLayerId: copies[copies.length - 1] ?? null });
    },
    shiftSelectedLayers: (seconds) => {
      const ids = new Set(get().selectedLayerIds);
      const spec = get().currentSpec();
      if (!spec || !ids.size || !Number.isFinite(seconds)) return;
      const timed = spec.layers.filter((l) => ids.has(l.id) && l.t !== 'all');
      if (!timed.length) return;
      const minStart = Math.min(...timed.map((l) => l.t === 'all' ? Infinity : l.t[0]));
      const maxEnd = Math.max(...timed.map((l) => l.t === 'all' ? 0 : l.t[1]));
      const shift = Math.max(-minStart, Math.min(selectPostDuration(get()) - maxEnd, seconds));
      get().updateSpec((s) => { for (const l of s.layers) if (ids.has(l.id) && l.t !== 'all') l.t = [round4(l.t[0] + shift), round4(l.t[1] + shift)]; });
    },
    moveSelectedLayersOnCanvas: (dx, dy) => {
      const ids = new Set(get().selectedLayerIds);
      if (!ids.size) return;
      get().updateSpec((spec) => {
        for (const l of spec.layers) {
          if (!ids.has(l.id) || l.locked) continue;
          const aspect = layerAspect(l, get().assets);
          const box = placeLayer(l, aspect, { W: 1080, H: 1920 });
          const margin = marginFromBox({ ...box, x: box.x + dx * 1080, y: box.y + dy * 1920 }, l.anchor, { W: 1080, H: 1920 });
          l.margin = [round4(margin[0]), round4(margin[1])];
        }
      });
    },
    updateSelectedOpacity: (opacity) => {
      const ids = new Set(get().selectedLayerIds);
      if (!ids.size) return;
      get().updateSpec((spec) => { for (const l of spec.layers) if (ids.has(l.id) && !l.locked) l.opacity = Math.max(0, Math.min(1, opacity)); });
    },
    updateSelectedTextStyle: (patch) => {
      const ids = new Set(get().selectedLayerIds);
      get().updateSpec((spec) => { for (const l of spec.layers) if (l.type === 'text' && ids.has(l.id) && !l.locked) Object.assign(l.style, patch); });
    },
    updateSelectedShapeStyle: (patch) => {
      const ids = new Set(get().selectedLayerIds);
      get().updateSpec((spec) => { for (const l of spec.layers) if (l.type === 'shape' && ids.has(l.id) && !l.locked) { Object.assign(l, patch); l.image_url = null; l.image_size = null; } });
    },
    setDrawingShape: (drawingShape) => set({ drawingShape }),
    focusLayer: (layer) => {
      const next = stepForLayer(layer);
      if (next !== get().step) get().setStep(next);
      set((s) => ({ selectedLayerId: layer.id, selectedLayerIds: [layer.id], selectedTrackId: null, replacingLayerId: null, layerFocusVersion: s.layerFocusVersion + 1 }));
    },
    setSelectedClip: (selectedClipId) => set({ selectedClipId }),
    selectTimelineItems: (keys, mode = 'replace') => {
      const old = get().timelineSelection;
      const next = mode === 'add' ? [...new Set([...old, ...keys])] : mode === 'subtract' ? old.filter((key) => !keys.includes(key)) : [...new Set(keys)];
      const layers = next.filter((key) => key.startsWith('layer:')).map((key) => key.slice(6));
      const clips = next.filter((key) => key.startsWith('clip:')).map((key) => key.slice(5));
      const tracks = next.filter((key) => key.startsWith('track:')).map((key) => key.slice(6));
      set({ timelineSelection: next, selectedLayerIds: layers, selectedLayerId: layers[layers.length - 1] ?? null, selectedClipId: clips[clips.length - 1] ?? null, selectedTrackId: tracks[tracks.length - 1] ?? null });
    },
    copyTimelineItems: () => {
      const spec = get().currentSpec();
      if (!spec) return;
      const keys = new Set(get().timelineSelection);
      const windows = spec.sequence ? clipWindows(spec.sequence).filter((w) => keys.has(`clip:${w.clip.id}`)) : [];
      const clips = windows.map((w) => structuredClone(w.clip));
      const layers = spec.layers.filter((layer) => keys.has(`layer:${layer.id}`)).map((layer) => structuredClone(layer));
      const tracks = (spec.audio?.tracks ?? []).filter((track) => keys.has(`track:${track.id}`)).map((track) => structuredClone(track));
      if (!clips.length && !layers.length && !tracks.length) return;
      const starts = [...windows.map((w) => w.start), ...layers.map((l) => l.t === 'all' ? 0 : l.t[0]), ...tracks.map((t) => t.t === 'all' ? 0 : t.t[0])];
      timelineClipboard = { clips, layers, tracks, origin: Math.min(...starts) };
      set({ hasTimelineClipboard: true });
      get().setToast(`已复制 ${clips.length + layers.length + tracks.length} 个片段`);
    },
    pasteTimelineItems: () => {
      const source = timelineClipboard;
      const video = get().currentVideo();
      const spec = get().currentSpec();
      if (!source || !video || !spec) return;
      let next = cloneSpec(spec);
      const ids: string[] = [];
      const at = Math.max(0, get().time);
      if (source.clips.length && !spec.video_locked) {
        next = materializeSequence(next, video.id, video.duration);
        const windows = clipWindows(next.sequence!);
        const index = windows.findIndex((w) => at < (w.start + w.end) / 2);
        const inserted = pasteClipSet(next, source.clips, index < 0 ? windows.length : index);
        next = inserted.spec;
        ids.push(...inserted.ids.map((id) => `clip:${id}`));
      }
      const timed = [...source.layers, ...source.tracks].map((item) => item.t).filter((window): window is [number, number] => window !== 'all');
      const timelineEnd = next.sequence ? postTrimDuration(sequenceDuration(next.sequence), next.trim.remove) : selectPostDuration(get());
      const delta = timed.length ? Math.max(-Math.min(...timed.map((window) => window[0])), Math.min(timelineEnd - Math.max(...timed.map((window) => window[1])), at - source.origin)) : at - source.origin;
      const moveWindow = (window: [number, number] | 'all'): [number, number] | 'all' => window === 'all' ? 'all' : [Math.max(0, window[0] + delta), Math.max(0.1, window[1] + delta)];
      for (const layer of source.layers) {
        const copy = { ...structuredClone(layer), id: newLayerId(), t: moveWindow(layer.t) };
        next.layers.push(copy);
        ids.push(`layer:${copy.id}`);
      }
      if (source.tracks.length) next.audio ??= { source_volume: 1, tracks: [] };
      for (const track of source.tracks) {
        const copy = { ...structuredClone(track), id: newTrackId(), t: moveWindow(track.t) };
        next.audio!.tracks.push(copy);
        ids.push(`track:${copy.id}`);
      }
      get().replaceSpec(video.id, next, { history: true });
      get().selectTimelineItems(ids);
    },
    deleteTimelineItems: () => {
      const video = get().currentVideo();
      const spec = get().currentSpec();
      if (!video || !spec) return;
      const keys = new Set(get().timelineSelection);
      const clipIds = spec.video_locked ? [] : (spec.sequence?.clips ?? []).filter((clip) => keys.has(`clip:${clip.id}`)).map((clip) => clip.id);
      const clipResult = clipIds.length ? removeClipSet(spec, clipIds) : cloneSpec(spec);
      if (!clipResult) { get().setToast('主轨必须保留至少一个片段'); return; }
      clipResult.layers = clipResult.layers.filter((layer) => !keys.has(`layer:${layer.id}`) || layer.locked);
      if (clipResult.audio) clipResult.audio.tracks = clipResult.audio.tracks.filter((track) => !keys.has(`track:${track.id}`) || track.locked);
      get().replaceSpec(video.id, clipResult, { history: true });
      get().selectTimelineItems([]);
    },
    shiftTimelineItems: (seconds) => {
      const video = get().currentVideo();
      const spec = get().currentSpec();
      if (!video || !spec || !Number.isFinite(seconds) || Math.abs(seconds) < 0.001) return;
      const keys = new Set(get().timelineSelection);
      const clipIds = spec.video_locked ? [] : (spec.sequence?.clips ?? []).filter((clip) => keys.has(`clip:${clip.id}`)).map((clip) => clip.id);
      let next = cloneSpec(spec);
      if (clipIds.length && spec.sequence) {
        const windows = clipWindows(spec.sequence);
        const first = windows.find((w) => clipIds.includes(w.clip.id));
        const destination = Math.max(0, (first?.start ?? 0) + seconds);
        const target = windows.filter((w) => !clipIds.includes(w.clip.id)).findIndex((w) => destination < (w.start + w.end) / 2);
        next = moveClipSet(next, clipIds, target < 0 ? windows.length : target);
        const newFirst = next.sequence ? clipWindows(next.sequence).find((w) => w.clip.id === first?.clip.id) : null;
        const delta = newFirst && first ? newFirst.start - first.start : 0;
        const movedWindow = (old: [number, number] | 'all', current: [number, number] | 'all'): [number, number] | 'all' =>
          old !== 'all' && current !== 'all' && old[0] === current[0] && old[1] === current[1]
            ? [round4(Math.max(0, current[0] + delta)), round4(Math.max(0.1, current[1] + delta))] : current;
        for (const layer of next.layers) {
          if (!keys.has(`layer:${layer.id}`) || layer.locked) continue;
          const old = spec.layers.find((item) => item.id === layer.id);
          if (old) layer.t = movedWindow(old.t, layer.t);
        }
        for (const track of next.audio?.tracks ?? []) {
          if (!keys.has(`track:${track.id}`) || track.locked) continue;
          const old = spec.audio?.tracks.find((item) => item.id === track.id);
          if (old) track.t = movedWindow(old.t, track.t);
        }
      } else {
        const timed = [...next.layers.filter((l) => keys.has(`layer:${l.id}`) && !l.locked && l.t !== 'all'), ...(next.audio?.tracks ?? []).filter((t) => keys.has(`track:${t.id}`) && !t.locked && t.t !== 'all')];
        if (!timed.length) return;
        const min = Math.min(...timed.map((item) => item.t === 'all' ? Infinity : item.t[0]));
        const max = Math.max(...timed.map((item) => item.t === 'all' ? 0 : item.t[1]));
        const delta = Math.max(-min, Math.min(selectPostDuration(get()) - max, seconds));
        for (const item of timed) if (item.t !== 'all') item.t = [round4(item.t[0] + delta), round4(item.t[1] + delta)];
      }
      get().replaceSpec(video.id, next, { history: true });
    },
    setTime: (time) => set({ time }),
    setPlaying: (playing) => set({ playing }),
    setPlayhead: (time, playing, lap) => set({ time, playing, lap }),
    setCropEditing: (cropEditing) => set({ cropEditing }),
    setPreviewVariant: (previewVariantKey) => set({ previewVariantKey }),
    setToast: (toast, action) => set({ toast, toastAction: toast ? action ?? null : null }),
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    toggleSnap: () => set((st) => ({ snapEnabled: !st.snapEnabled, toast: st.snapEnabled ? '吸附已关闭' : '吸附已开启', toastAction: null })),
    toggleTheme: () => {
      const theme: EditorTheme = get().theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        /* ignore */
      }
      set({ theme });
    },
    setSafeZoneView: (safeZoneView) => {
      try {
        localStorage.setItem(SAFE_ZONE_VIEW_KEY, safeZoneView);
        if (safeZoneView !== 'none') localStorage.setItem(SAFE_ZONE_MODE_KEY, safeZoneView);
      } catch {
        /* ignore */
      }
      set(safeZoneView === 'none' ? { safeZoneView } : { safeZoneView, safeZoneMode: safeZoneView });
    },
    toggleSafeZone: () => {
      const { safeZoneView, safeZoneMode } = get();
      get().setSafeZoneView(safeZoneView === 'none' ? safeZoneMode : 'none');
    },
    setTimelinePps: (timelinePps) => set({ timelinePps }),
    setTimelineViewPps: (timelineViewPps) => set({ timelineViewPps }),
    setSelectedRange: (selectedRangeIndex) => set({ selectedRangeIndex }),
    // 封面段（time < 0）不属于源视频：入出点夹到 0
    setInPoint: (inPoint) => set({ inPoint: inPoint === null ? null : Math.max(0, inPoint) }),
    setOutPoint: (t0) => {
      const t = Math.max(0, t0);
      const ip = get().inPoint;
      if (ip === null) {
        set({ inPoint: t });
        return;
      }
      get().addRemoveRange(ip, t);
      set({ inPoint: null });
    },
    canRemoveBefore: () => {
      if (get().currentSpec()?.video_locked) return false;
      const v = get().currentVideo();
      const t = get().time;
      if (!v || t < 0.05) return false;
      return !wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [0, t], selectSourceDuration(get()));
    },
    canRemoveAfter: () => {
      if (get().currentSpec()?.video_locked) return false;
      const v = get().currentVideo();
      const t = get().time;
      const duration = selectSourceDuration(get());
      if (!v || t < 0 || duration - t < 0.05) return false;
      return !wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [t, duration], duration);
    },
    removeBefore: () => {
      if (get().currentSpec()?.video_locked) return;
      const v = get().currentVideo();
      if (!v) return;
      const t = get().time;
      if (t < 0.05) return;
      if (wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [0, t], selectSourceDuration(get()))) {
        set({ toast: '不能删除整条视频', toastAction: null });
        return;
      }
      get().addRemoveRange(0, t);
      set({ inPoint: null, toast: `已删除播放头左侧 ${t.toFixed(2)}s`, toastAction: { label: '撤销', run: () => get().undo() } });
    },
    removeAfter: () => {
      if (get().currentSpec()?.video_locked) return;
      const v = get().currentVideo();
      if (!v) return;
      const t = get().time;
      const duration = selectSourceDuration(get());
      if (t < 0 || duration - t < 0.05) return;
      if (wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [t, duration], duration)) {
        set({ toast: '不能删除整条视频', toastAction: null });
        return;
      }
      get().addRemoveRange(t, duration);
      set({ inPoint: null, toast: `已删除播放头右侧 ${(duration - t).toFixed(2)}s`, toastAction: { label: '撤销', run: () => get().undo() } });
    },

    currentSpec: () => {
      const id = get().currentVideoId;
      return id ? get().specs[id] ?? null : null;
    },
    currentVideo: () => {
      const id = get().currentVideoId;
      return get().videos.find((v) => v.id === id) ?? null;
    },

    updateSpec: (fn, opts) => {
      const videoId = opts?.videoId ?? get().currentVideoId;
      if (!videoId) return;
      const s = get();
      const prev = s.specs[videoId] ?? emptySpec();
      const next = cloneSpec(prev);
      fn(next);
      const history = { ...s.history };
      if (opts?.history !== false) {
        const h = { ...ensureHistory(history, videoId) };
        h.past = [...h.past, prev].slice(-HISTORY_CAP);
        h.future = [];
        history[videoId] = h;
      }
      set({ specs: { ...s.specs, [videoId]: next }, history });
      scheduleSave(videoId);
    },
    replaceSpec: (videoId, spec, opts) => {
      const s = get();
      if (!s.videos.some((v) => v.id === videoId)) return;
      const prev = s.specs[videoId] ?? emptySpec();
      // 后端要求 outputs 至少一个：null 用空 spec 代替
      const next = spec ? normalizeSequenceAudio(cloneSpec(spec), videoId) : emptySpec();
      const history = { ...s.history };
      if (opts?.history) {
        const h = { ...ensureHistory(history, videoId) };
        h.past = [...h.past, prev].slice(-HISTORY_CAP);
        h.future = [];
        history[videoId] = h;
      }
      set({ specs: { ...s.specs, [videoId]: next }, history, selectedLayerId: videoId === s.currentVideoId ? null : s.selectedLayerId, selectedLayerIds: videoId === s.currentVideoId ? [] : s.selectedLayerIds });
      scheduleSave(videoId);
    },
    pushHistorySnapshot: (snapshot, videoId) => {
      const id = videoId ?? get().currentVideoId;
      if (!id) return;
      const s = get();
      const history = { ...s.history };
      const h = { ...ensureHistory(history, id) };
      h.past = [...h.past, cloneSpec(snapshot)].slice(-HISTORY_CAP);
      h.future = [];
      history[id] = h;
      set({ history });
    },
    undo: () => {
      const videoId = get().currentVideoId;
      if (!videoId) return;
      const s = get();
      const h = ensureHistory({ ...s.history }, videoId);
      if (!h.past.length) return;
      const prev = h.past[h.past.length - 1];
      const nh: History = { past: h.past.slice(0, -1), future: [s.specs[videoId], ...h.future].slice(0, HISTORY_CAP) };
      set({ specs: { ...s.specs, [videoId]: prev }, history: { ...s.history, [videoId]: nh }, selectedLayerId: null, selectedLayerIds: [] });
      scheduleSave(videoId);
    },
    redo: () => {
      const videoId = get().currentVideoId;
      if (!videoId) return;
      const s = get();
      const h = ensureHistory({ ...s.history }, videoId);
      if (!h.future.length) return;
      const next = h.future[0];
      const nh: History = { past: [...h.past, s.specs[videoId]].slice(-HISTORY_CAP), future: h.future.slice(1) };
      set({ specs: { ...s.specs, [videoId]: next }, history: { ...s.history, [videoId]: nh }, selectedLayerId: null, selectedLayerIds: [] });
      scheduleSave(videoId);
    },
    canUndo: () => {
      const id = get().currentVideoId;
      return !!id && (get().history[id]?.past.length ?? 0) > 0;
    },
    canRedo: () => {
      const id = get().currentVideoId;
      return !!id && (get().history[id]?.future.length ?? 0) > 0;
    },

    addRemoveRange: (a, b) => {
      if (get().currentSpec()?.video_locked) return;
      const v = get().currentVideo();
      if (!v) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo < 0.05) return;
      if (wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [lo, hi], selectSourceDuration(get()))) {
        get().setToast('不能删除整条视频');
        return;
      }
      get().updateSpec((spec) => {
        spec.trim.remove = normalizeRanges([...spec.trim.remove, [lo, hi]], selectSourceDuration(get()));
      });
      const idx = get().currentSpec()?.trim.remove.findIndex(([x, y]) => x <= lo + 1e-6 && y >= hi - 1e-6) ?? -1;
      set({ selectedRangeIndex: idx >= 0 ? idx : null });
    },
    updateRemoveRange: (index, a, b) => {
      if (get().currentSpec()?.video_locked) return;
      const v = get().currentVideo();
      if (!v) return;
      get().updateSpec((spec) => {
        const rs = spec.trim.remove.map((r, i) => (i === index ? ([Math.min(a, b), Math.max(a, b)] as [number, number]) : r));
        if (postTrimDuration(selectSourceDuration(get()), rs) < 0.1) return;
        spec.trim.remove = normalizeRanges(rs, selectSourceDuration(get()));
      });
    },
    deleteRemoveRange: (index) => {
      if (get().currentSpec()?.video_locked) return;
      get().updateSpec((spec) => {
        spec.trim.remove = spec.trim.remove.filter((_, i) => i !== index);
      });
      set({ selectedRangeIndex: null });
    },

    toggleVideoHidden: () => get().updateSpec((spec) => { spec.video_hidden = !spec.video_hidden; }),
    toggleVideoLocked: () => get().updateSpec((spec) => { spec.video_locked = !spec.video_locked; }),
    setSelectedTrack: (id) => set(id === SOURCE_TRACK_ID ? { selectedTrackId: id } : { selectedTrackId: id, selectedMuteIndex: null }),
    setSourceVolume: (v) => {
      if (get().currentSpec()?.audio?.source_locked) return;
      get().updateSpec((spec) => {
        const audio = ensureAudio(spec);
        audio.source_volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
      });
    },
    addAudioTrack: (assetId, role, init) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!isAssetReady(asset)) return null; // 还在探测时长：加进去也放不出来
      const id = newTrackId();
      get().updateSpec((spec) => {
        ensureAudio(spec).tracks.push({ id, asset_id: assetId, role, t: 'all', ...trackDefaultsFor(role), ...init });
      });
      set({ selectedTrackId: id });
      return id;
    },
    setTrackSpeed: (id, speed) => {
      const spec = get().currentSpec();
      const track = spec?.audio?.tracks.find((t) => t.id === id);
      if (!spec || !track) return;
      const next = clampSpeed(speed);
      const media = get().assets.find((a) => a.id === track.asset_id)?.duration ?? 0;
      const postDuration = outputDuration(selectSourceDuration(get()), spec.trim);
      get().updateAudioTrack(id, { speed: next, t: windowForSpeed(track, postDuration, media, next) });
    },
    updateAudioTrack: (id, patch, history = true) => {
      const current = get().currentSpec()?.audio?.tracks.find((t) => t.id === id);
      if (current?.locked && !Object.keys(patch).every((key) => key === 'locked' || key === 'hidden')) return;
      get().updateSpec(
        (spec) => {
          const t = spec.audio?.tracks.find((x) => x.id === id);
          if (!t) return;
          Object.assign(t, patch);
        },
        { history },
      );
    },
    toggleTrackHidden: (id) => {
      get().updateSpec((spec) => {
        const t = spec.audio?.tracks.find((x) => x.id === id);
        if (!t) return;
        if (t.hidden) delete t.hidden;
        else t.hidden = true;
      });
      get().syncPosterDuration(); // 关掉的可能是朗读轨（HIG-50）：隐藏的不算进成片时长
    },
    toggleTrackLocked: (id) => get().updateSpec((spec) => {
      const track = spec.audio?.tracks.find((t) => t.id === id);
      if (track) track.locked = !track.locked;
    }),
    toggleSourceHidden: () => {
      get().updateSpec((spec) => {
        const audio = ensureAudio(spec);
        if (audio.source_hidden) delete audio.source_hidden;
        else audio.source_hidden = true;
      });
    },
    toggleSourceLocked: () => get().updateSpec((spec) => {
      const audio = ensureAudio(spec);
      audio.source_locked = !audio.source_locked;
    }),
    renameAudioTrack: (id, name) => {
      const clean = cleanTrackName(name);
      const cur = get().currentSpec()?.audio?.tracks.find((x) => x.id === id);
      if (!cur || cur.locked || clean === cleanTrackName(cur.name)) return;
      get().updateSpec((spec) => {
        const t = spec.audio?.tracks.find((x) => x.id === id);
        if (!t) return;
        if (clean) t.name = clean;
        else delete t.name;
      });
    },
    renameSourceAudio: (name) => {
      if (get().currentSpec()?.audio?.source_locked) return;
      const clean = cleanTrackName(name);
      if (clean === cleanTrackName(get().currentSpec()?.audio?.source_name)) return;
      get().updateSpec((spec) => {
        if (clean) ensureAudio(spec).source_name = clean;
        else if (spec.audio) delete spec.audio.source_name;
      });
    },
    removeAudioTrack: (id) => {
      if (get().currentSpec()?.audio?.tracks.find((t) => t.id === id)?.locked) return;
      get().updateSpec((spec) => {
        if (spec.audio) spec.audio.tracks = spec.audio.tracks.filter((t) => t.id !== id);
      });
      if (get().selectedTrackId === id) set({ selectedTrackId: null });
      get().syncPosterDuration(); // 删掉的可能是朗读轨（HIG-50）
    },
    splitAudioTrack: (id) => {
      if (get().currentSpec()?.audio?.tracks.find((t) => t.id === id)?.locked) return;
      const parts = splitAt(id);
      if (!parts) return;
      const [, right] = parts;
      get().updateSpec((spec) => {
        const tracks = spec.audio?.tracks;
        const i = tracks?.findIndex((t) => t.id === id) ?? -1;
        if (tracks && i >= 0) tracks.splice(i, 1, ...parts);
      });
      set({ selectedTrackId: right.id, toast: '已在播放头处拆分音轨', toastAction: { label: '撤销', run: () => get().undo() } });
    },
    cutTrackBefore: (id) => cutTrack(id, 'before'),
    cutTrackAfter: (id) => cutTrack(id, 'after'),

    setSelectedMute: (selectedMuteIndex) => set(selectedMuteIndex === null ? { selectedMuteIndex } : { selectedMuteIndex, selectedTrackId: SOURCE_TRACK_ID }),
    addSourceMute: (a, b) => {
      if (get().currentSpec()?.audio?.source_locked) return;
      const v = get().currentVideo();
      const spec = get().currentSpec();
      if (!v || !spec) return;
      const postDuration = outputDuration(selectSourceDuration(get()), spec.trim);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo < 0.05) return;
      get().updateSpec((sp) => {
        const audio = ensureAudio(sp);
        audio.source_mute = addMuteRange(audio.source_mute, lo, hi, postDuration);
      });
      const idx = get().currentSpec()?.audio?.source_mute?.findIndex(([x, y]) => x <= lo + 1e-3 && y >= Math.min(hi, postDuration) - 1e-3) ?? -1;
      set({ selectedTrackId: SOURCE_TRACK_ID, selectedMuteIndex: idx >= 0 ? idx : null });
    },
    updateSourceMute: (index, a, b) => {
      if (get().currentSpec()?.audio?.source_locked) return;
      const v = get().currentVideo();
      const spec = get().currentSpec();
      if (!v || !spec) return;
      const postDuration = outputDuration(selectSourceDuration(get()), spec.trim);
      get().updateSpec((sp) => {
        const audio = ensureAudio(sp);
        const rest = (audio.source_mute ?? []).filter((_, i) => i !== index);
        audio.source_mute = addMuteRange(rest, a, b, postDuration);
      });
    },
    deleteSourceMute: (index) => {
      if (get().currentSpec()?.audio?.source_locked) return;
      get().updateSpec((spec) => {
        if (spec.audio?.source_mute) spec.audio.source_mute = spec.audio.source_mute.filter((_, i) => i !== index);
      });
      set({ selectedMuteIndex: null });
    },

    separateVideo: async (model) => {
      const video = get().currentVideo();
      if (!video) return;
      try {
        const updated = await api.separateVideo(video.id, model);
        mergeVideoField(set, updated, 'separation');
        pollVideoField(video.id, 'separation', set, get);
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '分离请求失败');
      }
    },
    screenTextOptions: null,
    loadScreenTextOptions: async () => {
      if (get().screenTextOptions) return;
      try {
        set({ screenTextOptions: await api.getScreenTextOptions() });
      } catch {
        // 旧后端没有这个接口：当作没开，界面把入口禁掉
        set({ screenTextOptions: { enabled: false, erase_enabled: false, erase_provider: '', max_seconds: 0, max_frames: 0, max_blocks: 0 } });
      }
    },
    runScreenText: async (body) => {
      const video = get().currentVideo();
      if (!video) return false;
      try {
        const updated = await api.screenText(video.id, body);
        mergeVideoField(set, updated, 'screen_text');
        pollVideoField(video.id, 'screen_text', set, get);
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '画面文字请求失败');
        return false;
      }
    },
    updateScreenBlocks: async (edits) => {
      const video = get().currentVideo();
      if (!video || !edits.length) return false;
      try {
        mergeVideoField(set, await api.updateScreenBlocks(video.id, edits), 'screen_text');
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '保存修正失败');
        return false;
      }
    },
    deleteScreenErase: async () => {
      const video = get().currentVideo();
      if (!video) return false;
      try {
        await api.deleteScreenErase(video.id);
        mergeVideoField(set, await api.getVideo(video.id), 'screen_text');
        // spec 里还写着 clean 的话，渲染会自动回落原片；这里顺手切回来，免得预览和成片不一致。
        if (get().currentSpec()?.source_variant === 'clean') get().updateSpec((sp) => void (sp.source_variant = 'original'));
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '删除无字版失败');
        return false;
      }
    },
    setSourceVariant: (variant) => {
      const video = get().currentVideo();
      const spec = get().currentSpec();
      if (!video || !spec) return false;
      if (variant === 'clean') {
        if (spec.sequence) {
          get().setToast('多片段拼接暂不支持无字版源片');
          return false;
        }
        if (!cleanReady(video.screen_text)) {
          get().setToast(video.screen_text?.erase?.stale ? '无字版对不上当前的识别结果，请重新擦除' : '这条视频还没有可用的无字版');
          return false;
        }
      }
      if (spec.source_variant === variant) return false;
      get().updateSpec((sp) => void (sp.source_variant = variant));
      get().setToast(variant === 'clean' ? '正片已切到无字版' : '正片已切回原片', { label: '撤销', run: () => get().undo() });
      return true;
    },

    useStem: (stem) => {
      if (get().currentSpec()?.audio?.source_locked) return null;
      const video = get().currentVideo();
      const sep = video?.separation;
      const assetId = stem === 'vocals' ? sep?.vocals_asset_id : sep?.instrumental_asset_id;
      if (!video || sep?.status !== 'done' || !assetId) return null;
      const asset = get().assets.find((a) => a.id === assetId);
      if (!isAssetReady(asset)) return null;
      const id = newTrackId();
      get().updateSpec((spec) => {
        setOwnerSourceGain(spec, video.id, 0); // 只替代原片的源音轨，保留插入片段原声
        const audio = ensureAudio(spec);
        audio.tracks.push({ id, asset_id: assetId, role: stem === 'vocals' ? 'voice' : 'bgm', align: 'source', t: 'all', volume: 1, loop: false });
      });
      set({ selectedTrackId: id });
      return id;
    },

    loadLocalizeOptions: async () => {
      if (get().localizeOptions) return;
      try {
        set({ localizeOptions: await api.getLocalizeOptions() });
      } catch {
        // 旧后端没有这个接口 / 网络错误：当作没配置，面板禁用并提示
        set({ localizeOptions: { enabled: false, source_langs: [], target_langs: [] } });
      }
    },
    localizeVideo: async (body, opts) => {
      const video = get().currentVideo();
      if (!video) return false;
      try {
        if (opts?.bgm.mode === 'keep' && video.separation?.status !== 'done' && !fieldActive(video, 'separation')) {
          const separated = await api.separateVideo(video.id, 'htdemucs');
          mergeVideoField(set, separated, 'separation');
          pollVideoField(video.id, 'separation', set, get);
        }
        const updated = await api.localizeVideo(video.id, body);
        if (opts) {
          saveLocalizeBgm(video.id, opts.bgm);
          quickRequests[video.id] = { langs: body.target_langs };
        }
        mergeVideoField(set, updated, 'localization');
        pollVideoField(video.id, 'localization', set, get);
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '改语言请求失败');
        return false;
      }
    },
    updateTranscript: async (edits, sourceLang) => {
      const video = get().currentVideo();
      if (!video) return false;
      try {
        const updated = await api.updateTranscript(video.id, { cues: edits, ...(sourceLang ? { source_lang: sourceLang } : {}) });
        mergeVideoField(set, updated, 'localization');
        const n = Object.keys(updated.localization?.versions ?? {}).length;
        get().setToast(n ? `模板已保存；已有的 ${n} 个版本译文已过时，在版本列表里点「重译」更新` : '模板已保存');
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '保存模板失败');
        return false;
      }
    },
    resynthesizeVersion: async (lang, edits, voice) => {
      const video = get().currentVideo();
      if (!video) return false;
      try {
        const updated = await api.updateVersionCues(video.id, lang, { cues: edits, ...(voice ? { voice } : {}) });
        mergeVideoField(set, updated, 'localization');
        pollVideoField(video.id, 'localization', set, get);
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '重新合成请求失败');
        return false;
      }
    },
    dubVersions: async (items, opts) => {
      const video = get().currentVideo();
      if (!video || !items.length) return false;
      const sourceVoice = !!opts?.useSourceVoice;
      const started: string[] = [];
      for (const { lang, voice } of items) {
        try {
          // 用原声时不发音色：后端从 clone_voice 取，发了也会被忽略。
          const body = sourceVoice ? { cues: [], use_source_voice: true } : { cues: [], ...(voice ? { voice } : {}) };
          const updated = await api.updateVersionCues(video.id, lang, body);
          mergeVideoField(set, updated, 'localization');
          started.push(lang);
        } catch (e) {
          get().setToast(`${langLabel(get().localizeOptions, lang)}口播请求失败：${e instanceof ApiError ? e.message : '网络错误'}`);
        }
      }
      if (!started.length) return false;
      dubRequests[video.id] = [...(dubRequests[video.id] ?? []).filter((l) => !started.includes(l)), ...started];
      pollVideoField(video.id, 'localization', set, get);
      return true;
    },
    deleteVersion: async (lang) => {
      const video = get().currentVideo();
      if (!video) return false;
      try {
        await api.deleteVersion(video.id, lang);
        set((s) => ({
          videos: s.videos.map((v) => {
            if (v.id !== video.id || !v.localization) return v;
            const versions = { ...v.localization.versions };
            delete versions[lang];
            return { ...v, localization: { ...v.localization, versions } };
          }),
        }));
        void get().loadAssets(); // 配音素材随版本一起删了
        const label = langLabel(get().localizeOptions, lang);
        const cur = appliedVersion(get().currentSpec(), video.localization);
        get().setToast(cur?.lang === lang ? `已删除${label}版；已套用的字幕层和配音轨还在，配音素材已失效，可 ⌘Z 撤销套用或手动删除` : `已删除${label}版`);
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : '删除版本失败');
        return false;
      }
    },
    applyVersion: (lang, opts) => {
      const video = get().currentVideo();
      const spec = get().currentSpec();
      if (!video || !spec) return false;
      const check = canApplyVersion(video, lang, get().assets);
      if (!check.ok) {
        get().setToast(check.reason);
        return false;
      }
      const label = langLabel(get().localizeOptions, lang);
      if (!opts?.force) {
        const cur = appliedVersion(spec, video.localization);
        if (cur?.lang === lang && cur.state === 'applied') {
          get().setToast(`${label}版已是当前套用的版本`);
          return false;
        }
      }
      const assets = get().assets;
      const bgm = loadLocalizeBgm(video.id);
      if (bgm.mode === 'keep' && (video.separation?.status !== 'done' || !isAssetReady(assets.find((a) => a.id === video.separation?.instrumental_asset_id)))) {
        get().setToast('原伴奏尚未就绪；请从改语言主操作生成，系统会自动分离');
        return false;
      }
      if (bgm.mode === 'replace' && !isAssetReady(assets.find((a) => a.id === bgm.assetId))) {
        get().setToast('所选 BGM 不可用，请在改语言里重新选择');
        return false;
      }
      let warnings: string[] = [];
      get().updateSpec((s) => {
        // 一次 updateSpec = 一步历史：配音 / 字幕和画面文字一起进去，⌘Z 一次全撤。
        // 两个函数各清各的 origin，互不误伤（HIG-38）。
        warnings = applyLocalizationToSpec(s, lang, { video, assets, bgm, band: bandHint(video.screen_text, lang), langLabel: label, split: loadFeaturePrefs().localizeSplitCues, newLayerId, newTrackId });
        if (video.screen_text?.detect?.status === 'done') {
          warnings = [...warnings, ...applyScreenTextToSpec(s, lang, { screen: video.screen_text, remove: s.trim.remove, postDuration: postTrimDuration(video.duration, s.trim.remove), newLayerId })];
        }
      });
      set({ selectedLayerId: null, selectedLayerIds: [], selectedTrackId: null });
      get().setToast(`已套用${label}版${warnings.length ? `；${warnings.join('；')}` : ''}`, { label: '撤销', run: () => get().undo() });
      return true;
    },

    addPosterLayer: (text) => {
      if (!get().currentVideo()) return null;
      const s = get();
      const inner = s.safeZones.find((z) => z.key === s.safeZoneKey)?.inner;
      const box: ScrollBox = inner && inner.w > 0 && inner.h > 0 ? { x: inner.x, y: inner.y, w: inner.w, h: inner.h } : DEFAULT_SCROLL_BOX;
      // 大字报：比标题小一号、行距松一点，白字黑边（描边沿用缺省）
      const style: TextStyle = { ...defaultTextStyle(), font_size: 0.045, align: 'center', line_height: 1.4, color: '#FFFFFF' };
      const layer = newPosterLayer(newLayerId(), text ?? '', box, style);
      get().addLayer(layer);
      void get().syncPosterLayer(layer.id);
      return layer.id;
    },
    posterLayer: () => {
      const l = get().currentSpec()?.layers.find((x): x is TextLayer => x.type === 'text' && !!x.scroll);
      return l ?? null;
    },
    setScroll: (id, patch, history = true) => {
      const cur = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!cur || cur.type !== 'text') return;
      get().updateLayer(
        id,
        (l) => {
          if (l.type !== 'text') return;
          l.scroll = { ...resolveScroll(l.scroll), ...patch };
          if (patch.box) {
            // 折行宽和图层宽都跟框宽走：PNG 正好填满框，后端也按 min(width, box.w) 缩放
            l.style = { ...l.style, wrap_width: patch.box.w };
            l.width = patch.box.w;
            l.width_manual = true;
          }
        },
        history,
      );
      if (patch.box) void get().syncPosterLayer(id);
      else get().syncPosterDuration();
    },
    setPosterText: (id, text, history = true) => {
      const cur = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!cur || cur.type !== 'text' || cur.text === text) return;
      get().updateLayer(
        id,
        (l) => {
          if (l.type !== 'text') return;
          const moved = adjustSpans(l.spans, l.text, text);
          if (moved.length) l.spans = moved;
          else delete l.spans;
          l.text = text;
        },
        history,
      );
      void get().syncPosterLayer(id);
    },
    syncPosterLayer: async (id) => {
      const videoId = get().currentVideoId;
      const layer = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!videoId || !layer || layer.type !== 'text' || !layer.scroll) return;
      let size: [number, number] | null = null;
      try {
        const r = await ensureTextRendered(layer);
        size = [r.width, r.height];
      } catch {
        /* 渲染不了（字体 / canvas 出错）：时长按已有的 image_size 算 */
      }
      // 渲染是异步的：回来时图层可能已经又改了（文字变了就等下一次），或者换了视频
      const now = get().specs[videoId]?.layers.find((l) => l.id === id);
      if (!now || now.type !== 'text' || !now.scroll) return;
      if (size && (!now.image_size || now.image_size[0] !== size[0] || now.image_size[1] !== size[1])) {
        const sz = size;
        get().updateSpec(
          (spec) => {
            const l = spec.layers.find((x) => x.id === id);
            if (l && l.type === 'text') l.image_size = sz;
          },
          { history: false, videoId },
        );
      }
      if (videoId === get().currentVideoId) get().syncPosterDuration();
    },
    generateVoice: async (text, lang, voice, speechRate = 1) => {
      const videoId = get().currentVideoId;
      if (!videoId) return null;
      let asset: Asset;
      try {
        asset = await api.synthesizeTts({ text, lang, voice, ...(speechRate !== 1 ? { speech_rate: speechRate } : {}) });
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : `朗读生成失败：${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      set((s) => ({ assets: [...s.assets.filter((a) => a.id !== asset.id), asset], posterVoicePending: asset.id }));
      posterVoiceVideoId = videoId;
      if ((asset.status ?? 'ready') === 'preparing') pollPreparingAssets(set, get);
      else onAssetSettled(asset);
      return asset.id;
    },
    autoHighlight: async (id) => {
      const layer = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!layer || layer.type !== 'text') return false;
      if (!layer.text.trim()) {
        get().setToast('先输入文案再挑重点');
        return false;
      }
      try {
        const out = await api.highlight(layer.text);
        const now = get().currentSpec()?.layers.find((l) => l.id === id);
        if (!now || now.type !== 'text' || now.text !== layer.text) return false; // 等待期间文案改了：结果对不上号
        if (!out.phrases.length) {
          get().setToast('没有挑出重点词组');
          return true;
        }
        get().updateLayer(id, { spans: highlightSpans(out.phrases, now.spans, now.text.length) });
        return true;
      } catch (e) {
        get().setToast(e instanceof ApiError ? e.message : `挑重点失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    syncPosterDuration: () => {
      const spec = get().currentSpec();
      if (!spec) return;
      const d = posterDuration(spec, get().assets);
      const cur = typeof spec.trim.duration === 'number' && spec.trim.duration > 0 ? spec.trim.duration : null;
      // 有滚动图层 / 口播轨但暂时算不出（PNG 还没渲染、朗读素材还没就绪）：保持原值，别来回清
      const hasCandidate = spec.layers.some((l) => l.type === 'text' && !!l.scroll && !l.hidden) || (spec.audio?.tracks ?? []).some((t) => t.role === 'voice' && !t.hidden);
      const next = d ?? (hasCandidate ? cur : null);
      if (next === cur) return;
      get().updateSpec(
        (s) => {
          if (next === null) delete s.trim.duration;
          else s.trim.duration = next;
        },
        { history: false },
      );
    },

    setCover: (assetId) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!isCoverAsset(asset) || !isAssetReady(asset)) return;
      get().updateSpec((spec) => {
        spec.cover = { asset_id: assetId, duration: clampCoverDuration(spec.cover?.duration ?? COVER_DEFAULT_DURATION) };
      });
    },
    setCoverDuration: (sec, history = true) => {
      if (!get().currentSpec()?.cover) return;
      get().updateSpec(
        (spec) => {
          if (spec.cover) spec.cover.duration = clampCoverDuration(sec);
        },
        { history },
      );
    },
    clearCover: () => {
      if (!get().currentSpec()?.cover) return;
      get().updateSpec((spec) => {
        delete spec.cover;
      });
    },

    addLayer: (layer, opts) => {
      get().updateSpec((spec) => {
        const at = opts?.belowType ? insertIndexBelow(spec.layers, opts.belowType) : spec.layers.length;
        spec.layers.splice(at, 0, layer);
      });
      set({ selectedLayerId: layer.id, selectedLayerIds: [layer.id] });
    },
    addLayers: (layers) => {
      if (!layers.length) return;
      get().updateSpec((spec) => {
        spec.layers.push(...layers);
      });
      set({ selectedLayerId: layers[0].id, selectedLayerIds: layers.map((l) => l.id) });
    },
    updateLayer: (id, patch, history = true) => {
      const current = get().currentSpec()?.layers.find((l) => l.id === id);
      if (current?.locked && !(typeof patch === 'object' && Object.keys(patch).every((key) => key === 'locked' || key === 'hidden'))) return;
      get().updateSpec(
        (spec) => {
          const l = spec.layers.find((x) => x.id === id);
          if (!l) return;
          const sync = get().subtitleSyncEnabled && l.type === 'text' && (l.origin === 'subtitle' || l.origin === 'localize' || /^字幕\s*\d+/.test(l.name ?? ''));
          const before = sync ? structuredClone(l) : null;
          if (typeof patch === 'function') patch(l);
          else Object.assign(l, patch);
          if (before?.type === 'text' && l.type === 'text') {
            const changedStyle = Object.keys(l.style) as (keyof typeof l.style)[];
            for (const other of spec.layers) {
              if (other.id === id || other.type !== 'text' || other.locked || !(other.origin === 'subtitle' || other.origin === 'localize' || /^字幕\s*\d+/.test(other.name ?? ''))) continue;
              for (const key of changedStyle) {
                if (JSON.stringify(before.style[key]) !== JSON.stringify(l.style[key])) Object.assign(other.style, { [key]: l.style[key] === undefined ? undefined : structuredClone(l.style[key]) });
              }
              for (const key of ['anchor', 'margin', 'width', 'rotate', 'opacity'] as const) {
                if (JSON.stringify(before[key]) !== JSON.stringify(l[key])) Object.assign(other, { [key]: structuredClone(l[key]) });
              }
            }
          }
          if (l.type === 'shape' && !(typeof patch === 'object' && 'image_url' in patch)) {
            l.image_url = null;
            l.image_size = null;
          }
        },
        { history },
      );
      // 眼睛开关（HIG-33）碰到滚动文案（HIG-50）：隐藏的不算进成片时长
      if (typeof patch === 'object' && 'hidden' in patch) get().syncPosterDuration();
    },
    splitLayer: (id) => {
      const ctx = playheadPost();
      const layer = ctx?.spec.layers.find((l) => l.id === id);
      if (!ctx || !layer) return;
      const blocked = splitLayerBlockedReason(layer, ctx.p, ctx.postDuration);
      if (blocked) {
        set({ toast: blocked, toastAction: null });
        return;
      }
      // 字幕类图层连文字一起切（HIG-36）：切点吸附到最近的标点 / 词边界，不是播放头的精确位置
      const textAt = loadFeaturePrefs().localizeSplitCues ? textCutForSplit(layer, ctx.p, ctx.postDuration) : undefined;
      const parts = splitLayerAt(layer, ctx.p, ctx.postDuration, newLayerId(), { textAt });
      if (!parts) return;
      get().updateSpec((spec) => {
        const i = spec.layers.findIndex((l) => l.id === id);
        if (i >= 0) spec.layers.splice(i, 1, parts[0], parts[1]);
      });
      const cutText = parts[0].type === 'text' && parts[1].type === 'text' && parts[0].text !== parts[1].text;
      // 选中右半段：和剪映一样，拆完接着处理后面那截
      set({ selectedLayerId: parts[1].id, selectedLayerIds: [parts[1].id], toast: cutText ? '已在播放头处拆分字幕' : '已在播放头处拆分图层', toastAction: { label: '撤销', run: () => get().undo() } });
    },
    splitLayerAtCaret: (id, offset) => {
      const ctx = playheadPost();
      const layer = ctx?.spec.layers.find((l) => l.id === id);
      if (!ctx || !layer || layer.type !== 'text') return;
      if (offset <= 0 || offset >= layer.text.length) {
        set({ toast: '把光标放到要切开的位置（不能在开头或结尾）', toastAction: null });
        return;
      }
      const [a, b] = windowRange(layer.t, ctx.postDuration);
      if (b - a < 2 * MIN_SPLIT) {
        set({ toast: '这条字幕的时段太短（不足 0.2 秒），不能拆分', toastAction: null });
        return;
      }
      // 时间按光标前后的字数比例分，切点就是用户放光标的地方
      const p = clamp(a + (b - a) * charRatio(layer.text, offset), a + MIN_SPLIT, b - MIN_SPLIT);
      const parts = splitLayerAt(layer, p, ctx.postDuration, newLayerId(), { textAt: offset });
      if (!parts) return;
      get().updateSpec((spec) => {
        const i = spec.layers.findIndex((l) => l.id === id);
        if (i >= 0) spec.layers.splice(i, 1, parts[0], parts[1]);
      });
      set({ selectedLayerId: parts[1].id, selectedLayerIds: [parts[1].id], toast: '已在光标处拆分字幕', toastAction: { label: '撤销', run: () => get().undo() } });
    },
    resplitSubtitleLayers: () => {
      const ctx = playheadPost();
      if (!ctx) return;
      let added = 0;
      let touched = 0;
      get().updateSpec((spec) => {
        spec.layers = spec.layers.flatMap((l) => {
          if (!isSubtitleTextLayer(l) || l.locked) return [l];
          const parts = splitTextLayerByText(l, ctx.postDuration, newLayerId);
          if (parts.length > 1) {
            touched += 1;
            added += parts.length - 1;
          }
          return parts;
        });
      });
      if (!added) {
        set({ toast: '没有超长的字幕，不用拆', toastAction: null });
        return;
      }
      set({ selectedLayerId: null, selectedLayerIds: [], toast: `已把 ${touched} 条长字幕拆成 ${touched + added} 条`, toastAction: { label: '撤销', run: () => get().undo() } });
    },
    removeLayer: (id) => {
      if (get().currentSpec()?.layers.find((l) => l.id === id)?.locked) return;
      get().updateSpec((spec) => {
        spec.layers = spec.layers.filter((l) => l.id !== id);
      });
      if (get().selectedLayerIds.includes(id)) set((s) => ({ selectedLayerIds: s.selectedLayerIds.filter((x) => x !== id), selectedLayerId: s.selectedLayerId === id ? null : s.selectedLayerId }));
      get().syncPosterDuration(); // 删掉的可能是滚动文案（HIG-50）
    },
    moveLayer: (id, dir) => {
      const layers = get().currentSpec()?.layers ?? [];
      const i = indexWithinType(layers, id);
      if (i < 0) return;
      get().moveLayerToIndex(id, i + dir);
    },
    moveLayerTo: (id, where) => {
      const layers = get().currentSpec()?.layers ?? [];
      const layer = layers.find((l) => l.id === id);
      if (!layer) return;
      get().moveLayerToIndex(id, where === 'top' ? layersOfType(layers, layer.type).length - 1 : 0);
    },
    moveLayerToIndex: (id, index) => {
      const layers = get().currentSpec()?.layers ?? [];
      const layer = layers.find((l) => l.id === id);
      if (!layer) return;
      // 越界（到顶了再上移）直接忽略，免得记一条空历史
      if (index < 0 || index >= layersOfType(layers, layer.type).length || moveWithinType(layers, id, index) === layers) return;
      get().updateSpec((spec) => {
        spec.layers = moveWithinType(spec.layers, id, index);
      });
    },
    duplicateLayer: (id) => {
      const src = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!src) return;
      const copy = { ...cloneSpec({ ...emptySpec(), layers: [src] }).layers[0], id: newLayerId() };
      copy.margin = [round4(copy.margin[0] + 0.03), round4(copy.margin[1] + 0.03)];
      get().updateSpec((spec) => {
        const i = spec.layers.findIndex((l) => l.id === id);
        spec.layers.splice(i + 1, 0, copy);
      });
      set({ selectedLayerId: copy.id, selectedLayerIds: [copy.id] });
    },
    setReplacingLayer: (id) => set({ replacingLayerId: id }),
    replaceLayerAsset: (layerId, assetId) => {
      const layer = get().currentSpec()?.layers.find((l) => l.id === layerId);
      if (!layer || layer.type !== 'sticker') return;
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset) return;
      const trim = retrimForAsset(layer, asset.duration ?? 0);
      get().updateLayer(layerId, (l) => {
        const sticker = l as StickerLayer;
        sticker.asset_id = assetId;
        // 裁剪跟着新素材走；放不下就整段播，而不是留一段越界的值
        if (trim.source_in === undefined) delete sticker.source_in;
        else sticker.source_in = trim.source_in;
        if (trim.source_out === undefined) delete sticker.source_out;
        else sticker.source_out = trim.source_out;
        // 换成静态图后播放方式没有意义，但留着不发也无害；换成视频时缺省补 loop
        if (isVideoAsset(asset) && sticker.playback === undefined) sticker.playback = 'loop';
      });
      set({ replacingLayerId: null, selectedLayerId: layerId, selectedLayerIds: [layerId], toast: `已替换为「${asset.name}」` });
    },
    copyLayer: () => {
      const ids = new Set(get().selectedLayerIds);
      if (!ids.size && get().selectedLayerId) ids.add(get().selectedLayerId!);
      const layers = get().currentSpec()?.layers.filter((l) => ids.has(l.id)) ?? [];
      if (!layers.length) return;
      set({ layerClipboard: cloneSpec({ ...emptySpec(), layers }).layers, layerClipboardVideoId: get().currentVideoId, toast: `已复制 ${layers.length} 个图层`, toastAction: null });
    },
    pasteLayer: () => {
      const clip = get().layerClipboard;
      const spec = get().currentSpec();
      if (!clip?.length || !spec) return;
      // 文本 / 贴纸各管各的（字幕管文字 + 遮盖）：粘进来的图层要能在当前模块里选中和编辑
      const want = layerTypesForStep(get().step);
      const stray = clip.find((l) => !want.includes(l.type));
      if (want.length && stray && clip.length === 1) {
        const home = LAYER_HOME[stray.type];
        set({ toast: `剪贴板里是${home.kind}图层，切到「${home.step}」再粘贴`, toastAction: null });
        return;
      }
      const sameVideo = get().layerClipboardVideoId === get().currentVideoId;
      const existing = new Set(spec.layers.map((l) => l.id));
      const pasted = cloneSpec({ ...emptySpec(), layers: clip }).layers.map((l) => {
        const collide = sameVideo || existing.has(l.id);
        const copy: Layer = { ...l, id: newLayerId() };
        if (collide) copy.margin = [round4(l.margin[0] + 0.03), round4(l.margin[1] + 0.03)];
        return copy;
      });
      get().updateSpec((s) => {
        for (const l of pasted) {
          // 遮盖永远压在字幕之下：插到第一个文字图层之前，其它类型照旧放最上层
          if (l.type === 'mask') s.layers.splice(insertIndexBelow(s.layers, 'text'), 0, l);
          else s.layers.push(l);
        }
      });
      // 同一视频里连续粘贴时继续错开：剪贴板里的坐标随之更新
      if (sameVideo) set({ layerClipboard: cloneSpec({ ...emptySpec(), layers: pasted }).layers });
      set({ selectedLayerId: pasted[pasted.length - 1].id, selectedLayerIds: pasted.map((l) => l.id) });
    },
    copyStyle: () => {
      const id = get().selectedLayerId;
      const src = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!src) return;
      if (src.type !== 'text') {
        set({ toast: '只能从文字图层复制样式', toastAction: null });
        return;
      }
      set({ styleClipboard: { ...src.style }, toast: '已复制文字样式', toastAction: null });
    },
    pasteStyle: () => {
      const style = get().styleClipboard;
      const id = get().selectedLayerId;
      const target = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!style) {
        set({ toast: '还没有复制过文字样式', toastAction: null });
        return;
      }
      if (!target) return;
      if (target.type !== 'text') {
        set({ toast: '只能把样式粘贴到文字图层', toastAction: null });
        return;
      }
      // 多选时一次贴到全部选中的文字图层上，包在同一次 updateSpec 里 = 一步撤销
      // （与 HIG-63 的 updateSelectedTextStyle 同一个路子，只是贴的是整份样式而不是某几个字段）
      const ids = new Set(get().selectedLayerIds.length > 1 ? get().selectedLayerIds : [target.id]);
      get().updateSpec((spec) => {
        for (const l of spec.layers) if (l.type === 'text' && ids.has(l.id) && !l.locked) l.style = { ...style };
      });
    },
    nudgeLayer: (id, dx, dy, history = true) => {
      const layer = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!layer || layer.locked) return;
      if (get().editLayerOnPreview(id, ({ box }) => ({ box: { ...box, x: box.x + dx, y: box.y + dy } }), history)) return;
      const m = nudgePlacement(layer, layerAspect(layer, get().assets), { W: 1080, H: 1920 }, dx, dy);
      get().updateLayer(id, { margin: [round4(m[0]), round4(m[1])] }, history);
    },

    setLayerOverride: (key, id, override, history = true) => {
      get().updateSpec(
        (spec) => {
          spec.outputs = ensureVariants(spec, [key]).outputs.map((cur) => {
            if (cur.variant_key !== key) return cur;
            const overrides = { ...(cur.layer_overrides ?? {}) };
            if (override) overrides[id] = override;
            else delete overrides[id];
            const o: OutputVariant = { ...cur, layer_overrides: overrides };
            if (!Object.keys(overrides).length) delete o.layer_overrides;
            return o;
          });
        },
        { history },
      );
    },
    editLayerOnPreview: (id, fn, history = true) => {
      const s = get();
      const key = s.previewVariantKey;
      if (key === '9x16') return false;
      const spec = s.currentSpec();
      const layer = spec?.layers.find((l) => l.id === id);
      const video = s.videos.find((v) => v.id === s.currentVideoId);
      if (!spec || !layer || !video) return true;
      const variant = outputFor(spec, key);
      const box = resolveLayerBox(spec, layer, variant, layerAspect(layer, s.assets), video.width, video.height);
      const anchor = effectiveGeometry(layer, variant).anchor;
      const next = fn({ box, anchor });
      const prev = variant.layer_overrides?.[id];
      const o = overrideFromBox(layer, next.box, next.anchor ?? anchor, key, next.rotate, variant);
      // 旋转 / 不透明度的已有覆盖保留
      if (next.rotate === undefined && prev?.rotate !== undefined) o.rotate = prev.rotate;
      if (prev?.opacity !== undefined) o.opacity = prev.opacity;
      get().setLayerOverride(key, id, o, history);
      return true;
    },

    setExportVariants: (keys) => {
      get().updateSpec((spec) => {
        spec.outputs = setExportKeys(spec, keys).outputs;
      });
    },
    patchOutput: (patch, key = get().previewVariantKey) => {
      get().updateSpec((spec) => {
        spec.outputs = ensureVariants(spec, [key]).outputs.map((cur) => {
          if (cur.variant_key !== key) return cur;
          const o = { ...cur, ...patch };
          if (o.fill !== 'color') delete o.color;
          if (o.fill !== 'crop') delete o.crop;
          if (o.fill !== 'blur') {
            delete o.blur;
            delete o.bg_brightness;
          }
          return o;
        });
      });
    },
    setCrop: (rect, history = true, key = get().previewVariantKey) => {
      get().updateSpec(
        (spec) => {
          spec.outputs = ensureVariants(spec, [key]).outputs.map((cur) => {
            if (cur.variant_key !== key) return cur;
            const o = { ...cur };
            if (rect === null) delete o.crop;
            else o.crop = { ...rect };
            return o;
          });
        },
        { history },
      );
    },

    applyToTargets: async (targetIds, modules, opts) => {
      const s = get();
      const b = s.batch;
      const src = s.currentVideoId;
      if (!b || !src) return;
      const targets = targetIds.filter((id) => id !== src);
      if (!targets.length) return;
      await get().flushSave();
      // 请求前快照：目标当前草稿（没有则 null），用于撤销
      const prevSpecs: Record<string, EditSpec | null> = {};
      for (const id of targets) {
        const cur = get().specs[id];
        prevSpecs[id] = cur ? cloneSpec(cur) : null;
      }
      try {
        const layerMode = opts?.layerMode ?? 'replace';
        const updated = await api.applySpec(b.id, {
          source_video_id: src,
          target_video_ids: targets,
          modules,
          ...(modules.includes('layers') && layerMode !== 'replace' ? { layer_mode: layerMode } : {}),
        });
        set((st) => {
          const history = { ...st.history };
          for (const u of updated) {
            const h = { ...ensureHistory(history, u.id) };
            h.past = [...h.past, prevSpecs[u.id] ?? emptySpec()].slice(-HISTORY_CAP);
            h.future = [];
            history[u.id] = h;
          }
          const lastApply: LastApply = { targetIds: updated.map((u) => u.id), prevSpecs };
          return {
            videos: st.videos.map((v) => updated.find((u) => u.id === v.id) ?? v),
            specs: { ...st.specs, ...Object.fromEntries(updated.map((u) => [u.id, u.edit_spec ? normalizeSequenceAudio(normalizeOutputs(cloneSpec(u.edit_spec)), u.id) : emptySpec()])) },
            history,
            lastApply,
            toast: `已应用到 ${updated.length} 条视频`,
            toastAction: { label: '撤销本次批量应用', run: () => get().undoLastApply() },
          };
        });
      } catch (e) {
        set({ toast: `应用失败：${e instanceof Error ? e.message : String(e)}`, toastAction: null });
      }
    },
    undoLastApply: () => {
      const la = get().lastApply;
      if (!la) return;
      for (const id of la.targetIds) {
        if (!(id in la.prevSpecs)) continue;
        get().replaceSpec(id, la.prevSpecs[id], { history: true });
      }
      set({ lastApply: null, toast: `已撤销批量应用（${la.targetIds.length} 条）`, toastAction: null });
    },

    flushSave: async () => {
      const ids = Object.keys(saveTimers);
      for (const id of ids) {
        window.clearTimeout(saveTimers[id]);
        delete saveTimers[id];
        await saveNow(id);
      }
    },

    saveAndRender: async (targetIds, opts) => {
      const s = get();
      if (!targetIds.length || s.rendering) return;
      const variantKeys: VariantKey[] = opts?.variantKeys?.length ? opts.variantKeys : ['9x16'];
      set({ rendering: true, toast: null });
      try {
        const baked: Record<string, EditSpec> = {};
        for (const id of targetIds) {
          const video = s.videos.find((v) => v.id === id);
          if (!video) continue;
          const spec = ensureVariants(cloneSpec(get().specs[id] ?? (video.edit_spec ? video.edit_spec : emptySpec())), variantKeys);
          // 文字图层 → PNG（每次回传都重新生成，保证与当前文字 / 样式一致）
          for (let i = 0; i < spec.layers.length; i++) {
            const l = spec.layers[i];
            if (l.type === 'text') spec.layers[i] = await bakeTextLayer(l as TextLayer);
            if (l.type === 'shape') spec.layers[i] = await bakeShapeLayer(l);
          }
          // 各画幅上文字的实际像素宽和基准 PNG 差得多时，按该画幅重新渲染一张（HIG-29）；要在基准烤完、宽度定下来之后算
          for (let i = 0; i < spec.layers.length; i++) {
            const l = spec.layers[i];
            if (l.type === 'text') spec.layers[i] = await bakeTextLayerVariants(l as TextLayer, spec, variantKeys, video.width, video.height);
          }
          if (saveTimers[id]) {
            window.clearTimeout(saveTimers[id]);
            delete saveTimers[id];
          }
          set((st) => ({ specs: { ...st.specs, [id]: spec }, saveState: 'saving' }));
          const saved = await api.putSpec(id, toContractSpec(spec, video.duration));
          set((st) => ({ videos: st.videos.map((v) => (v.id === id ? saved : v)), saveState: 'saved' }));
          baked[id] = spec;
        }
        const targets = s.videos.filter((v) => baked[v.id]);
        let items: RenderItem[];
        let skippedText = '';
        if (opts?.langs?.length) {
          // 多语言（HIG-43）：在已烤好的 spec 副本上逐个语言套用，只给新生成的译文字幕烤 PNG
          const assets = get().assets;
          const plan = planLanguageExport(targets, opts.langs, assets);
          items = [];
          for (const it of plan.items) {
            const video = targets.find((v) => v.id === it.video_id)!;
            const spec = cloneSpec(baked[it.video_id]);
            if (it.lang === null) {
              stripLocalization(spec, video.id);
              // HIG-38：原版必须同时去掉画面文字层并切回原片，否则导出的会是
              // 「用了无字版、但画面上一个字都没有」的空画面。
              stripScreenText(spec);
            } else {
              const bgm = loadLocalizeBgm(video.id);
              const bgmAssetId = bgm.mode === 'replace' ? bgm.assetId : video.separation?.status === 'done' ? video.separation.instrumental_asset_id : null;
              if (!isAssetReady(assets.find((a) => a.id === bgmAssetId))) throw new Error(`${video.name} 的 BGM 尚未就绪，未提交多语言导出`);
              // 和预览用同一个开关：否则画面上拆了、导出的成片没拆（HIG-36）
              applyLocalizationToSpec(spec, it.lang, { video, assets, bgm, band: bandHint(video.screen_text, it.lang), langLabel: langLabel(get().localizeOptions, it.lang), split: loadFeaturePrefs().localizeSplitCues, newLayerId, newTrackId });
              if (video.screen_text?.detect?.status === 'done') {
                applyScreenTextToSpec(spec, it.lang, { screen: video.screen_text, remove: spec.trim.remove, postDuration: postTrimDuration(video.duration, spec.trim.remove), newLayerId });
              }
              for (let i = 0; i < spec.layers.length; i++) {
                const l = spec.layers[i];
                if (l.type !== 'text' || (l.origin !== LOCALIZE_ORIGIN && l.origin !== 'screen')) continue;
                const one = await bakeTextLayer(l as TextLayer);
                spec.layers[i] = await bakeTextLayerVariants(one, spec, variantKeys, video.width, video.height);
              }
            }
            items.push({ video_id: it.video_id, lang: it.lang, edit_spec: toContractSpec(spec, video.duration) });
          }
          if (plan.skipped.length) skippedText = `；跳过 ${plan.skipped.length} 个没有该语言的组合`;
          if (!items.length) {
            set({ rendering: false, toast: `没有可导出的语言版本${skippedText}` });
            return;
          }
        } else {
          items = targets.map((v) => ({ video_id: v.id, lang: specLang(baked[v.id], v) }));
        }
        const wanted = new Set(items.map((it) => `${it.video_id}|${it.lang ?? ''}`));
        let jobs: Job[];
        try {
          jobs = await api.render(items, opts?.name, variantKeys, opts?.outputFormat);
          if (skippedText) set({ toast: `已提交 ${jobs.length} 个任务${skippedText}` });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            set({ toast: `有任务仍在进行：${e.message}` });
            const existing = await api.batchJobs(s.batch!.id);
            jobs = existing.filter((j) => wanted.has(`${j.video_id}|${j.lang ?? ''}`) && variantKeys.includes(j.variant_key as VariantKey) && (j.status === 'queued' || j.status === 'running'));
          } else throw e;
        }
        set((st) => ({ jobs, trackedJobIds: Array.from(new Set([...st.trackedJobIds.filter((id) => st.jobs.find((j) => j.id === id && (j.status === 'queued' || j.status === 'running'))), ...jobs.map((j) => j.id)])), progressOpen: true, rendering: false }));
        startPolling();
        await get().refreshVideos();
      } catch (e) {
        set({ rendering: false, toast: `导出失败：${e instanceof Error ? e.message : String(e)}` });
      }
    },

    retryJob: async (id) => {
      try {
        const j = await api.retryJob(id);
        set((s) => ({ jobs: s.jobs.map((x) => (x.id === id ? j : x)), trackedJobIds: Array.from(new Set([...s.trackedJobIds, id])) }));
        startPolling();
      } catch (e) {
        set({ toast: `重试失败：${e instanceof Error ? e.message : String(e)}` });
      }
    },
    closeProgress: () => set({ progressOpen: false }),
    openExport: (req) => set({ exportDialog: req ?? {} }),
    closeExport: () => set({ exportDialog: null }),
    openProgressFor: (jobs) => {
      set({ jobs, trackedJobIds: jobs.map((j) => j.id), progressOpen: true });
      startPolling();
    },
  };
});

// ---- 派生选择器 ----
/** A composition is a single virtual source for every editing tool. */
export function selectSourceDuration(s: EditorState): number {
  const spec = s.currentVideoId ? s.specs[s.currentVideoId] : null;
  return spec?.sequence ? sequenceDuration(spec.sequence) : s.videos.find(v => v.id === s.currentVideoId)?.duration ?? 0;
}
/** 成片正片时长：trim.duration（HIG-50）优先，否则剪后时长。图层 / 音轨的时段可以排到这么长。 */
export function selectPostDuration(s: EditorState): number {
  const v = s.videos.find((x) => x.id === s.currentVideoId);
  const spec = s.currentVideoId ? s.specs[s.currentVideoId] : null;
  if (!v) return 0;
  return outputDuration(selectSourceDuration(s), spec?.trim ?? { remove: [] });
}
export function usePostDuration(): number {
  return useEditor(selectPostDuration);
}

/** 当前视频封面在成片里占的秒数（0 = 没有封面或封面不可用），与 worker 同一套判断。 */
export function useCoverDuration(): number {
  return useEditor((s) => coverDuration(s.currentVideoId ? s.specs[s.currentVideoId]?.cover : null, s.assets));
}

/** 播放头是否处在封面段。 */
export function useInCover(): boolean {
  return useEditor((s) => s.time < 0);
}

/** 播放头的成片时刻（剪后时间轴）：循环补足（HIG-50）时跨遍累加。 */
export function selectPostTime(s: EditorState): number {
  const spec = s.currentVideoId ? s.specs[s.currentVideoId] : null;
  const remove = spec?.trim.remove ?? [];
  return postTimeOf(s.lap, postTrimDuration(selectSourceDuration(s), remove), sourceToPost(s.time, remove));
}
export function usePostTime(): number {
  return useEditor(selectPostTime);
}

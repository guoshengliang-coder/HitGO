// 编辑器全局状态（zustand）。
// - 每条视频一份草稿 spec（specs）+ 历史栈（history，上限 50）
// - 任何 spec 修改后 1 秒防抖自动保存（PUT /api/videos/{id}/spec）
// - "导出"：先把文字图层烘焙成 PNG，再 PUT spec，再 POST /api/render，并轮询任务
// - 编辑器只产出一个 9:16 输出（HIG-8）：载入 / 批量应用 / 导出时用 toSingleOutput 收掉旧 spec 里的其他画幅

import { create } from 'zustand';
import { api, ApiError, type ApplyLayerMode } from '../api';
import type { Asset, AudioRole, AudioSpec, AudioTrack, BatchDetail, CropRect, EditSpec, Job, Layer, OutputVariant, SafeZone, TextLayer, TextStyle, TextStylePreset, Video } from '../types';
import { emptySpec, isAssetReady } from '../types';
import { newTrackId, trackDefaultsFor } from '../lib/audioTracks';
import { cloneSpec, layerAspect, newLayerId, toContractSpec, toSingleOutput } from '../lib/spec';
import { normalizeRanges, postTrimDuration, sourceToPost, wouldRemoveAll } from '../lib/time';
import { nudgePlacement, round4 } from '../lib/layout';
import { indexWithinType, layersOfType, moveWithinType } from '../lib/layerKind';
import { layerTypeForStep, type Step } from '../lib/steps';
import { bakeTextLayer } from '../lib/textImage';
import { player } from '../lib/player';
import { ensureFontsLoaded } from '../lib/fonts';
import { BUILTIN_TEXT_PRESETS } from '../lib/textPresets';
import { calibrationFromJobs, type Calibration } from '../lib/estimate';

export type { Step } from '../lib/steps';
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
export type ApplyModule = 'trim' | 'layers' | 'outputs' | 'audio';
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
  time: number; // 源时间
  playing: boolean;
  saveState: SaveState;
  saveError: string | null;
  /** 剪辑模块里正在调整 9:16 输出的裁切窗口（中栏换成 CropEditor） */
  cropEditing: boolean;
  // 渲染
  jobs: Job[];
  trackedJobIds: string[];
  progressOpen: boolean;
  rendering: boolean;
  toast: string | null;
  toastAction: ToastAction | null;
  // 交互
  shortcutsOpen: boolean;
  safeZoneView: SafeZoneView;
  /** 上次开启时的显示方式，toggleSafeZone 打开时恢复 */
  safeZoneMode: SafeZoneMode;
  /** 整站配色（类名挂在 <html> 上，见 App.tsx）；存本机 */
  theme: EditorTheme;
  timelinePps: number | null; // null = 适应窗口
  layerClipboard: Layer[] | null;
  layerClipboardVideoId: string | null;
  styleClipboard: TextStyle | null;
  // 文字样式预设（内置 + 用户）
  textPresets: TextStylePreset[];
  // 批量应用撤销
  lastApply: LastApply | null;
  // 成片大小估算校准（来自该批次已完成任务的实际码率）
  outputCalibration: Calibration;

  load: (batchId: string) => Promise<void>;
  loadTextPresets: () => Promise<void>;
  saveTextPreset: (name: string, style: TextStyle) => Promise<void>;
  deleteTextPreset: (id: string) => Promise<void>;
  /** 拉取该批次已完成任务，按实际码率校准估算（剪辑面板的「画面」分组挂载时调用）。 */
  loadOutputCalibration: () => Promise<void>;
  refreshVideos: () => Promise<void>;
  loadAssets: () => Promise<void>;
  setCurrent: (id: string) => void;
  toggleSelected: (id: string) => void;
  setSelectedAll: (on: boolean) => void;
  setStep: (s: Step) => void;
  setSafeZoneKey: (k: string) => void;
  setSelectedLayer: (id: string | null) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setCropEditing: (on: boolean) => void;
  setToast: (m: string | null, action?: ToastAction | null) => void;
  setShortcutsOpen: (on: boolean) => void;
  setSafeZoneView: (v: SafeZoneView) => void;
  toggleTheme: () => void;
  /** 安全区开关：开着就关（none），关着就恢复上次的显示方式 */
  toggleSafeZone: () => void;
  setTimelinePps: (pps: number | null) => void;

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
  setSelectedTrack: (id: string | null) => void;
  setSourceVolume: (v: number) => void;
  /** 加一条音轨（素材须 ready）；按角色套默认值，返回新 id。 */
  addAudioTrack: (assetId: string, role: AudioRole) => string | null;
  updateAudioTrack: (id: string, patch: Partial<AudioTrack>, history?: boolean) => void;
  removeAudioTrack: (id: string) => void;

  // 图层
  addLayer: (layer: Layer) => void;
  /** 一次加入多个图层（标题模板），只记一步历史，选中第一个。 */
  addLayers: (layers: Layer[]) => void;
  updateLayer: (id: string, patch: Partial<Layer> | ((l: Layer) => void), history?: boolean) => void;
  removeLayer: (id: string) => void;
  // 层级操作都只在图层自己这一类（文字 / 贴纸）里换序，另一类的位置不动，见 lib/layerKind
  moveLayer: (id: string, dir: -1 | 1) => void;
  moveLayerTo: (id: string, where: 'top' | 'bottom') => void;
  /** 把图层挪到同类里的第 index 位（0 = 同类最下层；越界夹到边界）。 */
  moveLayerToIndex: (id: string, index: number) => void;
  duplicateLayer: (id: string) => void;
  copyLayer: () => void;
  pasteLayer: () => void;
  copyStyle: () => void;
  pasteStyle: () => void;
  /** 按 1080×1920 参考像素平移图层。 */
  nudgeLayer: (id: string, dx: number, dy: number, history?: boolean) => void;

  // 画面（唯一的 9:16 输出）
  patchOutput: (patch: Partial<OutputVariant>) => void;
  /** 写 9:16 输出的裁切窗口；null = 删掉（回到 cover 居中）。 */
  setCrop: (rect: CropRect | null, history?: boolean) => void;

  // 批量 / 渲染
  applyToTargets: (targetIds: string[], modules: ApplyModule[], opts?: { layerMode?: ApplyLayerMode }) => Promise<void>;
  /** 撤销最近一次批量应用：把每个目标恢复到应用前的 spec。 */
  undoLastApply: () => void;
  saveAndRender: (targetIds: string[]) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  closeProgress: () => void;
  openProgressFor: (jobs: Job[]) => void;
  flushSave: () => Promise<void>;
}

const saveTimers: Record<string, number> = {};
let pollTimer: number | null = null;
let assetPollTimer: number | null = null;

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
    }
    if (get().assets.some((a) => (a.status ?? 'ready') === 'preparing')) {
      assetPollTimer = window.setTimeout(tick, 2000);
    }
  };
  assetPollTimer = window.setTimeout(tick, 2000);
}

function ensureAudio(spec: EditSpec): AudioSpec {
  if (!spec.audio) spec.audio = { source_volume: 1, tracks: [] };
  return spec.audio;
}

function ensureHistory(h: Record<string, History>, id: string): History {
  if (!h[id]) h[id] = { past: [], future: [] };
  return h[id];
}

export const useEditor = create<EditorState>((set, get) => {
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
      set((s) => ({
        saveState: 'saved',
        saveError: null,
        videos: s.videos.map((v) => (v.id === videoId ? { ...saved, edit_spec: v.edit_spec ?? saved.edit_spec } : v)),
      }));
    } catch (e) {
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

  return {
    batch: null,
    videos: [],
    loading: false,
    error: null,
    currentVideoId: null,
    selectedIds: [],
    step: 'trim',
    safeZones: [],
    safeZoneKey: 'generic-vertical',
    assets: [],
    specs: {},
    history: {},
    selectedLayerId: null,
    time: 0,
    playing: false,
    saveState: 'idle',
    saveError: null,
    cropEditing: false,
    jobs: [],
    trackedJobIds: [],
    progressOpen: false,
    rendering: false,
    toast: null,
    toastAction: null,
    shortcutsOpen: false,
    safeZoneView: loadSafeZoneView(),
    safeZoneMode: loadSafeZoneMode(loadSafeZoneView()),
    theme: loadTheme(),
    timelinePps: null,
    layerClipboard: null,
    layerClipboardVideoId: null,
    styleClipboard: null,
    textPresets: BUILTIN_TEXT_PRESETS,
    lastApply: null,
    outputCalibration: {},
    selectedRangeIndex: null,
    inPoint: null,

    load: async (batchId) => {
      set({ loading: true, error: null });
      try {
        const [batch, zones] = await Promise.all([api.getBatch(batchId), get().safeZones.length ? Promise.resolve(get().safeZones) : api.safeZones()]);
        const specs: Record<string, EditSpec> = {};
        // 旧 spec 里的其他画幅在载入时就收掉；就绪的视频随后自动保存写回（未就绪的后端不收 spec）
        const collapsed: string[] = [];
        for (const v of batch.videos) {
          if (!v.edit_spec) {
            specs[v.id] = emptySpec();
            continue;
          }
          const draft = cloneSpec(v.edit_spec);
          specs[v.id] = toSingleOutput(draft);
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
          selectedLayerId: null,
          time: 0,
          loading: false,
          saveState: 'idle',
          lastApply: null,
          outputCalibration: {},
          step: 'trim',
          cropEditing: false,
        });
        for (const id of collapsed) scheduleSave(id);
        void get().loadAssets();
        void get().loadTextPresets();
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
        set((s) => ({
          batch: fresh,
          videos: fresh.videos,
          specs: Object.fromEntries(fresh.videos.map((v) => [v.id, s.specs[v.id] ?? (v.edit_spec ? toSingleOutput(cloneSpec(v.edit_spec)) : emptySpec())])),
        }));
      } catch {
        /* ignore */
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
      set({ currentVideoId: id, selectedLayerId: null, selectedRangeIndex: null, selectedTrackId: null, inPoint: null, time: 0, playing: false, cropEditing: false, timelinePps: null });
    },
    toggleSelected: (id) =>
      set((s) => ({ selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id] })),
    setSelectedAll: (on) => set((s) => ({ selectedIds: on ? s.videos.map((v) => v.id) : [] })),
    setStep: (step) => {
      player.pause();
      // 选中的图层 / 区间 / 音轨只属于原模块：文本模块里不能留着一个选中的贴纸
      set({ step, selectedLayerId: null, selectedRangeIndex: null, selectedTrackId: null, cropEditing: false });
    },
    setSafeZoneKey: (safeZoneKey) => set({ safeZoneKey }),
    setSelectedLayer: (selectedLayerId) => set({ selectedLayerId }),
    setTime: (time) => set({ time }),
    setPlaying: (playing) => set({ playing }),
    setCropEditing: (cropEditing) => set({ cropEditing }),
    setToast: (toast, action) => set({ toast, toastAction: toast ? action ?? null : null }),
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
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
    setSelectedRange: (selectedRangeIndex) => set({ selectedRangeIndex }),
    setInPoint: (inPoint) => set({ inPoint }),
    setOutPoint: (t) => {
      const ip = get().inPoint;
      if (ip === null) {
        set({ inPoint: t });
        return;
      }
      get().addRemoveRange(ip, t);
      set({ inPoint: null });
    },
    canRemoveBefore: () => {
      const v = get().currentVideo();
      const t = get().time;
      if (!v || t < 0.05) return false;
      return !wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [0, t], v.duration);
    },
    canRemoveAfter: () => {
      const v = get().currentVideo();
      const t = get().time;
      if (!v || v.duration - t < 0.05) return false;
      return !wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [t, v.duration], v.duration);
    },
    removeBefore: () => {
      const v = get().currentVideo();
      if (!v) return;
      const t = get().time;
      if (t < 0.05) return;
      if (wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [0, t], v.duration)) {
        set({ toast: '不能删除整条视频', toastAction: null });
        return;
      }
      get().addRemoveRange(0, t);
      set({ inPoint: null, toast: `已删除播放头左侧 ${t.toFixed(2)}s`, toastAction: { label: '撤销', run: () => get().undo() } });
    },
    removeAfter: () => {
      const v = get().currentVideo();
      if (!v) return;
      const t = get().time;
      if (v.duration - t < 0.05) return;
      if (wouldRemoveAll(get().currentSpec()?.trim.remove ?? [], [t, v.duration], v.duration)) {
        set({ toast: '不能删除整条视频', toastAction: null });
        return;
      }
      get().addRemoveRange(t, v.duration);
      set({ inPoint: null, toast: `已删除播放头右侧 ${(v.duration - t).toFixed(2)}s`, toastAction: { label: '撤销', run: () => get().undo() } });
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
      const next = spec ? cloneSpec(spec) : emptySpec();
      const history = { ...s.history };
      if (opts?.history) {
        const h = { ...ensureHistory(history, videoId) };
        h.past = [...h.past, prev].slice(-HISTORY_CAP);
        h.future = [];
        history[videoId] = h;
      }
      set({ specs: { ...s.specs, [videoId]: next }, history, selectedLayerId: videoId === s.currentVideoId ? null : s.selectedLayerId });
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
      set({ specs: { ...s.specs, [videoId]: prev }, history: { ...s.history, [videoId]: nh }, selectedLayerId: null });
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
      set({ specs: { ...s.specs, [videoId]: next }, history: { ...s.history, [videoId]: nh }, selectedLayerId: null });
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
      const v = get().currentVideo();
      if (!v) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo < 0.05) return;
      get().updateSpec((spec) => {
        spec.trim.remove = normalizeRanges([...spec.trim.remove, [lo, hi]], v.duration);
      });
      const idx = get().currentSpec()?.trim.remove.findIndex(([x, y]) => x <= lo + 1e-6 && y >= hi - 1e-6) ?? -1;
      set({ selectedRangeIndex: idx >= 0 ? idx : null });
    },
    updateRemoveRange: (index, a, b) => {
      const v = get().currentVideo();
      if (!v) return;
      get().updateSpec((spec) => {
        const rs = spec.trim.remove.map((r, i) => (i === index ? ([Math.min(a, b), Math.max(a, b)] as [number, number]) : r));
        spec.trim.remove = normalizeRanges(rs, v.duration);
      });
    },
    deleteRemoveRange: (index) => {
      get().updateSpec((spec) => {
        spec.trim.remove = spec.trim.remove.filter((_, i) => i !== index);
      });
      set({ selectedRangeIndex: null });
    },

    selectedTrackId: null,
    setSelectedTrack: (id) => set({ selectedTrackId: id }),
    setSourceVolume: (v) => {
      get().updateSpec((spec) => {
        const audio = ensureAudio(spec);
        audio.source_volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
      });
    },
    addAudioTrack: (assetId, role) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!isAssetReady(asset)) return null; // 还在探测时长：加进去也放不出来
      const id = newTrackId();
      get().updateSpec((spec) => {
        ensureAudio(spec).tracks.push({ id, asset_id: assetId, role, t: 'all', ...trackDefaultsFor(role) });
      });
      set({ selectedTrackId: id });
      return id;
    },
    updateAudioTrack: (id, patch, history = true) => {
      get().updateSpec(
        (spec) => {
          const t = spec.audio?.tracks.find((x) => x.id === id);
          if (!t) return;
          Object.assign(t, patch);
          if (t.loop) t.offset = 0; // 契约：循环时起始偏移必须为 0
        },
        { history },
      );
    },
    removeAudioTrack: (id) => {
      get().updateSpec((spec) => {
        if (spec.audio) spec.audio.tracks = spec.audio.tracks.filter((t) => t.id !== id);
      });
      if (get().selectedTrackId === id) set({ selectedTrackId: null });
    },

    addLayer: (layer) => {
      get().updateSpec((spec) => {
        spec.layers.push(layer);
      });
      set({ selectedLayerId: layer.id });
    },
    addLayers: (layers) => {
      if (!layers.length) return;
      get().updateSpec((spec) => {
        spec.layers.push(...layers);
      });
      set({ selectedLayerId: layers[0].id });
    },
    updateLayer: (id, patch, history = true) => {
      get().updateSpec(
        (spec) => {
          const l = spec.layers.find((x) => x.id === id);
          if (!l) return;
          if (typeof patch === 'function') patch(l);
          else Object.assign(l, patch);
        },
        { history },
      );
    },
    removeLayer: (id) => {
      get().updateSpec((spec) => {
        spec.layers = spec.layers.filter((l) => l.id !== id);
      });
      if (get().selectedLayerId === id) set({ selectedLayerId: null });
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
      set({ selectedLayerId: copy.id });
    },
    copyLayer: () => {
      const id = get().selectedLayerId;
      const src = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!src) return;
      set({ layerClipboard: cloneSpec({ ...emptySpec(), layers: [src] }).layers, layerClipboardVideoId: get().currentVideoId, toast: '已复制图层', toastAction: null });
    },
    pasteLayer: () => {
      const clip = get().layerClipboard;
      const spec = get().currentSpec();
      if (!clip?.length || !spec) return;
      // 文本 / 贴纸各管各的：粘进来的图层要能在当前模块里选中和编辑
      const want = layerTypeForStep(get().step);
      if (want && clip.some((l) => l.type !== want)) {
        set({ toast: `剪贴板里是${clip[0].type === 'text' ? '文字' : '贴纸'}图层，切到「${clip[0].type === 'text' ? '文本' : '贴纸'}」再粘贴`, toastAction: null });
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
        s.layers.push(...pasted);
      });
      // 同一视频里连续粘贴时继续错开：剪贴板里的坐标随之更新
      if (sameVideo) set({ layerClipboard: cloneSpec({ ...emptySpec(), layers: pasted }).layers });
      set({ selectedLayerId: pasted[pasted.length - 1].id });
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
      get().updateLayer(target.id, (l) => {
        if (l.type === 'text') l.style = { ...style };
      });
    },
    nudgeLayer: (id, dx, dy, history = true) => {
      const layer = get().currentSpec()?.layers.find((l) => l.id === id);
      if (!layer || layer.locked) return;
      const m = nudgePlacement(layer, layerAspect(layer, get().assets), { W: 1080, H: 1920 }, dx, dy);
      get().updateLayer(id, { margin: [round4(m[0]), round4(m[1])] }, history);
    },

    patchOutput: (patch) => {
      get().updateSpec((spec) => {
        const next = toSingleOutput(spec);
        const o = { ...next.outputs[0], ...patch };
        if (o.fill !== 'color') delete o.color;
        if (o.fill !== 'crop') delete o.crop;
        spec.outputs = [o];
      });
    },
    setCrop: (rect, history = true) => {
      get().updateSpec(
        (spec) => {
          const o = toSingleOutput(spec).outputs[0];
          if (rect === null) delete o.crop;
          else o.crop = { ...rect };
          spec.outputs = [o];
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
            specs: { ...st.specs, ...Object.fromEntries(updated.map((u) => [u.id, u.edit_spec ? toSingleOutput(cloneSpec(u.edit_spec)) : emptySpec()])) },
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

    saveAndRender: async (targetIds) => {
      const s = get();
      if (!targetIds.length || s.rendering) return;
      set({ rendering: true, toast: null });
      try {
        for (const id of targetIds) {
          const video = s.videos.find((v) => v.id === id);
          if (!video) continue;
          const spec = toSingleOutput(cloneSpec(get().specs[id] ?? (video.edit_spec ? video.edit_spec : emptySpec())));
          // 文字图层 → PNG（每次回传都重新生成，保证与当前文字 / 样式一致）
          for (let i = 0; i < spec.layers.length; i++) {
            const l = spec.layers[i];
            if (l.type === 'text') spec.layers[i] = await bakeTextLayer(l as TextLayer);
          }
          if (saveTimers[id]) {
            window.clearTimeout(saveTimers[id]);
            delete saveTimers[id];
          }
          set((st) => ({ specs: { ...st.specs, [id]: spec }, saveState: 'saving' }));
          const saved = await api.putSpec(id, toContractSpec(spec, video.duration));
          set((st) => ({ videos: st.videos.map((v) => (v.id === id ? saved : v)), saveState: 'saved' }));
        }
        let jobs: Job[];
        try {
          jobs = await api.render(targetIds);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            set({ toast: `有任务仍在进行：${e.message}` });
            const existing = await api.batchJobs(s.batch!.id);
            jobs = existing.filter((j) => targetIds.includes(j.video_id) && (j.status === 'queued' || j.status === 'running'));
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
    openProgressFor: (jobs) => {
      set({ jobs, trackedJobIds: jobs.map((j) => j.id), progressOpen: true });
      startPolling();
    },
  };
});

// ---- 派生选择器 ----
export function usePostDuration(): number {
  return useEditor((s) => {
    const v = s.videos.find((x) => x.id === s.currentVideoId);
    const spec = s.currentVideoId ? s.specs[s.currentVideoId] : null;
    if (!v) return 0;
    return postTrimDuration(v.duration, spec?.trim.remove ?? []);
  });
}

export function usePostTime(): number {
  return useEditor((s) => {
    const spec = s.currentVideoId ? s.specs[s.currentVideoId] : null;
    return sourceToPost(s.time, spec?.trim.remove ?? []);
  });
}

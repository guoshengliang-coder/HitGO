// 功能开关类的本机偏好（存 localStorage）：口播生成完自动套用（HIG-56）、用原声配音（HIG-58）、
// 大字报粘贴按标点分行及标点处理（HIG-55）、时间线滚轮方向与大字报跟随朗读调速（HIG-79 / HIG-75）。
// 和 layoutPrefs / sectionPrefs 一样是纯函数 + 可注入 storage；读到坏值逐项回落默认，不把界面卡在错误状态。

export type PunctMode = 'keep' | 'drop-pause' | 'drop-all';

export interface FeaturePrefs {
  /** 「生成口播」完成后自动套用到当前视频。 */
  autoApplyDub: boolean;
  /** 「生成口播」用这条视频复刻出来的原声，而不是系统音色（HIG-58）。 */
  useSourceVoice: boolean;
  /** 大字报文案框粘贴时按标点分行。 */
  posterSplitOnPaste: boolean;
  /** 分行后行尾标点：保留 / 去掉逗号类（，、；：）/ 全部去掉。 */
  posterPunct: PunctMode;
  /** 时间线上裸滚轮上下滚轨道（HIG-79）；关掉回到以前的横向滚动，⌘/Ctrl + 滚轮缩放不受影响。 */
  timelineWheelVertical: boolean;
  /** 生成朗读后自动把大字报滚动速度调成「滚完全程 = 朗读时长」（HIG-75）。 */
  posterFitVoiceSpeed: boolean;
}

export const FEATURE_DEFAULTS: FeaturePrefs = { autoApplyDub: true, useSourceVoice: false, posterSplitOnPaste: true, posterPunct: 'keep', timelineWheelVertical: true, posterFitVoiceSpeed: true };

const KEY = 'hitgo.prefs';

/**
 * 偏好改动的广播（同一套路子见 transportKeys.TIMELINE_ZOOM_EVENT）：开关在一个组件里改，
 * 读它的在另一个组件里（滚轮方向的开关在 Transport，用它的是 Timeline 的 wheel 监听）。
 * localStorage 的 storage 事件只跨标签页发，同页改不通知，所以自己发一条。
 */
export const PREFS_EVENT = 'hitgo:feature-prefs';
const PUNCT_MODES: PunctMode[] = ['keep', 'drop-pause', 'drop-all'];

type Getter = Pick<Storage, 'getItem'> | null;
type Setter = Pick<Storage, 'getItem' | 'setItem'> | null;

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

export function cleanFeaturePrefs(p: unknown): FeaturePrefs {
  const o = p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  return {
    autoApplyDub: typeof o.autoApplyDub === 'boolean' ? o.autoApplyDub : FEATURE_DEFAULTS.autoApplyDub,
    useSourceVoice: typeof o.useSourceVoice === 'boolean' ? o.useSourceVoice : FEATURE_DEFAULTS.useSourceVoice,
    posterSplitOnPaste: typeof o.posterSplitOnPaste === 'boolean' ? o.posterSplitOnPaste : FEATURE_DEFAULTS.posterSplitOnPaste,
    posterPunct: PUNCT_MODES.includes(o.posterPunct as PunctMode) ? (o.posterPunct as PunctMode) : FEATURE_DEFAULTS.posterPunct,
    timelineWheelVertical: typeof o.timelineWheelVertical === 'boolean' ? o.timelineWheelVertical : FEATURE_DEFAULTS.timelineWheelVertical,
    posterFitVoiceSpeed: typeof o.posterFitVoiceSpeed === 'boolean' ? o.posterFitVoiceSpeed : FEATURE_DEFAULTS.posterFitVoiceSpeed,
  };
}

export function loadFeaturePrefs(storage: Getter = defaultStorage()): FeaturePrefs {
  try {
    const raw = storage?.getItem(KEY);
    return cleanFeaturePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...FEATURE_DEFAULTS };
  }
}

/** 只改给出的项，其余沿用已存的；返回合并后的偏好。 */
export function saveFeaturePrefs(patch: Partial<FeaturePrefs>, storage: Setter = defaultStorage()): FeaturePrefs {
  const next = cleanFeaturePrefs({ ...loadFeaturePrefs(storage), ...patch });
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等：忽略，本次会话照常用 next */
  }
  try {
    window.dispatchEvent(new CustomEvent<FeaturePrefs>(PREFS_EVENT, { detail: next }));
  } catch {
    /* 没有 window（测试 / SSR）：广播可有可无，读的一方自己会在挂载时取一次 */
  }
  return next;
}

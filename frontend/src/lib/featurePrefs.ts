// 功能开关类的本机偏好（存 localStorage）：口播生成完自动套用（HIG-56）、用原声配音（HIG-58）、
// 大字报粘贴按标点分行及标点处理（HIG-55）。
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
}

export const FEATURE_DEFAULTS: FeaturePrefs = { autoApplyDub: true, useSourceVoice: false, posterSplitOnPaste: true, posterPunct: 'keep' };

const KEY = 'hitgo.prefs';
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
  return next;
}

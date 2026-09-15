// 编辑器面板尺寸（右栏宽、时间线高）：本机偏好，存 localStorage，纯函数便于测试。

export interface LayoutPrefs {
  rightW: number;
  timelineH: number;
}

export const LAYOUT_DEFAULTS: LayoutPrefs = { rightW: 320, timelineH: 214 };
export const LAYOUT_LIMITS = {
  rightW: [260, 480] as const,
  timelineH: [140, 400] as const,
};
const KEY = 'hitgo.layout';

export function clampPrefs(p: Partial<LayoutPrefs> | null | undefined): LayoutPrefs {
  const pick = (k: keyof LayoutPrefs) => {
    const v = p?.[k];
    const [lo, hi] = LAYOUT_LIMITS[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : LAYOUT_DEFAULTS[k];
  };
  return { rightW: pick('rightW'), timelineH: pick('timelineH') };
}

export function loadLayoutPrefs(storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): LayoutPrefs {
  try {
    const raw = storage?.getItem(KEY);
    return clampPrefs(raw ? (JSON.parse(raw) as Partial<LayoutPrefs>) : null);
  } catch {
    return { ...LAYOUT_DEFAULTS };
  }
}

export function saveLayoutPrefs(p: LayoutPrefs, storage: Pick<Storage, 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): void {
  try {
    storage?.setItem(KEY, JSON.stringify(clampPrefs(p)));
  } catch {
    /* 隐私模式等：忽略 */
  }
}

// 编辑器面板尺寸（左栏宽、右栏宽、时间线高）：本机偏好，存 localStorage，纯函数便于测试。

export interface LayoutPrefs {
  leftW: number;
  rightW: number;
  timelineH: number;
}

// 时间线默认高度在 HIG-67 之后抬高：轨道不再按模块过滤，首屏要放得下三个分组头 + 几条轨道。
// 存过偏好的用户不受影响（loadPrefs 读 localStorage）。
export const LAYOUT_DEFAULTS: LayoutPrefs = { leftW: 236, rightW: 320, timelineH: 268 };
export const LAYOUT_LIMITS = {
  leftW: [180, 420] as const,
  rightW: [260, 480] as const,
  timelineH: [140, 560] as const,
};
/** 窗口放不下时给中栏 / 画面保留的最小空间（HIG-53）。 */
export const CENTER_MIN_W = 480;
export const STAGE_MIN_H = 160;
/** 两条竖向拖动条的列宽 + 顶栏高 + 画面下方工具条与播放条的大致高度。 */
const SPLITTERS_W = 8;
const CHROME_H = 56 + 80;
const KEY = 'hitgo.layout';

export function clampPrefs(p: Partial<LayoutPrefs> | null | undefined): LayoutPrefs {
  const pick = (k: keyof LayoutPrefs) => {
    const v = p?.[k];
    const [lo, hi] = LAYOUT_LIMITS[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : LAYOUT_DEFAULTS[k];
  };
  return { leftW: pick('leftW'), rightW: pick('rightW'), timelineH: pick('timelineH') };
}

/**
 * 按窗口尺寸收紧：左右栏合计不挤掉中栏的 CENTER_MIN_W（先收右栏、再收左栏，都不低于下限），
 * 时间线不挤掉画面的 STAGE_MIN_H。窗口小到下限都放不下时停在下限。
 */
export function fitToViewport(p: LayoutPrefs, viewportW: number, viewportH: number): LayoutPrefs {
  const out = { ...p };
  if (viewportW > 0) {
    let excess = out.leftW + out.rightW + SPLITTERS_W + CENTER_MIN_W - viewportW;
    if (excess > 0) {
      const takeRight = Math.min(excess, out.rightW - LAYOUT_LIMITS.rightW[0]);
      out.rightW -= Math.max(0, takeRight);
      excess -= Math.max(0, takeRight);
      out.leftW -= Math.max(0, Math.min(excess, out.leftW - LAYOUT_LIMITS.leftW[0]));
    }
  }
  if (viewportH > 0) {
    const maxH = viewportH - CHROME_H - STAGE_MIN_H;
    out.timelineH = Math.max(LAYOUT_LIMITS.timelineH[0], Math.min(out.timelineH, maxH));
  }
  return out;
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

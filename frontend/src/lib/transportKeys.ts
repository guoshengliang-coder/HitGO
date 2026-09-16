// 剪映式播放 / 时间轴快捷键的纯逻辑（HIG-30）：↑↓ 跳剪辑点、J/K/L 倍速、⌘= / ⌘- 缩放时间轴。

const EPS = 1e-3;

/** 剪辑点（源时间，升序去重）：0、片尾、删除区间两端，以及调用方给的额外点（入点、图层时段两端等）。 */
export function cutPoints(duration: number, remove: [number, number][], extra: number[] = []): number[] {
  const raw = [0, duration, ...remove.flat(), ...extra].filter((t) => Number.isFinite(t) && t >= -EPS && t <= duration + EPS);
  const out: number[] = [];
  for (const t of raw.map((x) => Math.min(duration, Math.max(0, x))).sort((a, b) => a - b)) {
    if (!out.length || t - out[out.length - 1] > EPS) out.push(t);
  }
  return out;
}

/** 严格在 t 之后（dir=1）/ 之前（dir=-1）的最近剪辑点；没有返回 null。 */
export function adjacentCutPoint(points: number[], t: number, dir: 1 | -1): number | null {
  if (dir > 0) return points.find((p) => p > t + EPS) ?? null;
  for (let i = points.length - 1; i >= 0; i--) if (points[i] < t - EPS) return points[i];
  return null;
}

export const FORWARD_RATES = [1, 2, 4] as const;
export const REVERSE_RATES = [1, 2] as const;

/**
 * J / K / L 穿梭：rate 带符号，0 = 停。
 * L：停 / 倒放时从 1 倍正放开始，正放中逐档加速到上限；J 同理倒放；K 停。
 */
export function nextShuttleRate(current: number, key: 'J' | 'K' | 'L'): number {
  if (key === 'K') return 0;
  const sign = key === 'L' ? 1 : -1;
  const rates: readonly number[] = key === 'L' ? FORWARD_RATES : REVERSE_RATES;
  if (Math.sign(current) !== sign) return sign * rates[0];
  const i = rates.findIndex((r) => r >= Math.abs(current) - EPS);
  return sign * rates[Math.min(rates.length - 1, i < 0 ? rates.length - 1 : i + 1)];
}

/** 快捷键 → 时间轴组件的缩放请求（detail 为 1 放大 / -1 缩小）；缩放要按组件里的实际 pps 与滚动位置算锚点。 */
export const TIMELINE_ZOOM_EVENT = 'hitgo:timeline-zoom';

export const MIN_PPS = 20;
export const MAX_PPS = 400;
const ZOOM_STEP = 1.5;

/** 键盘缩放时间轴：每按一次放大 / 缩小 1.5 倍，夹在上下限内。 */
export function stepZoom(pps: number, dir: 1 | -1): number {
  return Math.min(MAX_PPS, Math.max(MIN_PPS, pps * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
}

// 吸附工具：时间轴（秒）与画布（像素）共用。

import type { SafeZone } from '../types';

export interface SnapResult {
  value: number;
  hit: number | null;
}

export interface GuideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 在候选值中找到与 v 距离最近且不超过 threshold 的那个；没有则原样返回。 */
export function snapValue(v: number, candidates: number[], threshold: number): SnapResult {
  let best: number | null = null;
  let bestD = threshold;
  for (const c of candidates) {
    if (!Number.isFinite(c)) continue;
    const d = Math.abs(c - v);
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best === null ? { value: v, hit: null } : { value: best, hit: best };
}

/** 吸附此刻是否生效：吸附开关（N）与拖动时按住的临时键（时间轴 ⌥ / 画布 ⌘）取异或。 */
export function snapActive(enabled: boolean, bypassHeld: boolean): boolean {
  return enabled !== bypassHeld;
}

function uniqSorted(xs: number[]): number[] {
  const out: number[] = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    if (!out.length || Math.abs(out[out.length - 1] - x) > 1e-6) out.push(x);
  }
  return out;
}

/** 画布参考线（舞台像素）：画布四边、中线，以及安全区每个矩形（含可选 inner / outer）的四边。 */
export function canvasGuides(zone: SafeZone | undefined | null, W: number, H: number): { xs: number[]; ys: number[] } {
  const xs = [0, W / 2, W];
  const ys = [0, H / 2, H];
  if (zone) {
    const rects = [...zone.zones, zone.inner ?? null, zone.outer ?? null];
    for (const r of rects) {
      if (!r) continue;
      xs.push(r.x * W, (r.x + r.w) * W);
      ys.push(r.y * H, (r.y + r.h) * H);
    }
  }
  return { xs: uniqSorted(xs), ys: uniqSorted(ys) };
}

/** 把其他可见元素的左/中/右、上/中/下并入画布参考线。 */
export function elementGuides(base: { xs: number[]; ys: number[] }, rects: GuideRect[]): { xs: number[]; ys: number[] } {
  const xs = [...base.xs];
  const ys = [...base.ys];
  for (const r of rects) {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0) continue;
    xs.push(r.x, r.x + r.width / 2, r.x + r.width);
    ys.push(r.y, r.y + r.height / 2, r.y + r.height);
  }
  return { xs: uniqSorted(xs), ys: uniqSorted(ys) };
}

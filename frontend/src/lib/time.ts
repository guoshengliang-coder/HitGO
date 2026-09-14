// 时间轴换算：源时间轴 ↔ 剪后时间轴。
// trim.remove 基于源时间轴，互不重叠、升序；layers[].t 基于剪后时间轴。

export type Range = [number, number];

const EPS = 1e-6;

/** 规范化删除区间：裁剪到 [0, duration]、去掉空区间、按起点排序并合并重叠 / 相邻区间。 */
export function normalizeRanges(ranges: Range[], duration?: number): Range[] {
  const cleaned: Range[] = [];
  for (const [a0, b0] of ranges) {
    let a = Math.min(a0, b0);
    let b = Math.max(a0, b0);
    if (duration !== undefined) {
      a = Math.max(0, Math.min(a, duration));
      b = Math.max(0, Math.min(b, duration));
    } else {
      a = Math.max(0, a);
      b = Math.max(0, b);
    }
    if (b - a > EPS) cleaned.push([a, b]);
  }
  cleaned.sort((x, y) => x[0] - y[0]);
  const merged: Range[] = [];
  for (const r of cleaned) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + EPS) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

/** 再删掉 extra 后剪后时长是否会低于 minKeep（即"整条视频都没了"）。 */
export function wouldRemoveAll(remove: Range[], extra: Range, duration: number, minKeep = 0.1): boolean {
  return postTrimDuration(duration, [...remove, extra]) < minKeep - EPS;
}

/** 剪后总时长。 */
export function postTrimDuration(duration: number, remove: Range[]): number {
  let removed = 0;
  for (const [a, b] of normalizeRanges(remove, duration)) removed += b - a;
  return Math.max(0, duration - removed);
}

/** 保留段（源时间轴）。 */
export function keepSegments(duration: number, remove: Range[]): Range[] {
  const segs: Range[] = [];
  let cursor = 0;
  for (const [a, b] of normalizeRanges(remove, duration)) {
    if (a - cursor > EPS) segs.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (duration - cursor > EPS) segs.push([cursor, duration]);
  return segs;
}

/** t（源时间）是否落在某删除区间内；返回该区间或 null。 */
export function removedRangeAt(t: number, remove: Range[]): Range | null {
  for (const r of remove) {
    if (t >= r[0] - EPS && t < r[1] - EPS) return r;
  }
  return null;
}

/** 源时间 → 剪后时间。落在删除区间内时映射到该区间起点对应的剪后时间。 */
export function sourceToPost(t: number, remove: Range[]): number {
  let removed = 0;
  for (const [a, b] of normalizeRanges(remove)) {
    if (t <= a) break;
    if (t >= b) removed += b - a;
    else {
      removed += t - a;
      break;
    }
  }
  return Math.max(0, t - removed);
}

/** 剪后时间 → 源时间。 */
export function postToSource(t: number, remove: Range[]): number {
  let src = Math.max(0, t);
  for (const [a, b] of normalizeRanges(remove)) {
    if (src >= a - EPS) src += b - a;
    else break;
  }
  return src;
}

/** 播放时若进入删除区间，应跳到的源时间（区间末尾）；否则原样返回。 */
export function skipRemoved(t: number, remove: Range[]): number {
  let cur = t;
  for (let i = 0; i < 8; i++) {
    const r = removedRangeAt(cur, remove);
    if (!r) return cur;
    cur = r[1];
  }
  return cur;
}

/** 剪后时间轴上的时段是否与当前剪后时间相交（'all' 恒真）。 */
export function windowContains(t: [number, number] | 'all', postTime: number): boolean {
  if (t === 'all') return true;
  return postTime >= t[0] - EPS && postTime <= t[1] + EPS;
}

/** 格式化为 m:ss.cc（百分之一秒）。 */
export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const cs = Math.floor((rest - whole) * 100 + 1e-6);
  return `${m}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** 简短格式：24.6s */
export function formatSeconds(sec: number, digits = 1): string {
  return `${Math.max(0, sec).toFixed(digits)}s`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

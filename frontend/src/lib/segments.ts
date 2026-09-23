// 主轨片段（HIG-85，非拼接视频）：保留段再按 trim.splits 切开，每段可单独选中、按 Delete 删掉（= 加进 trim.remove）。
// 删掉的区间照旧画成斜纹，横轴不收拢。选中键是 `seg:<起>~<止>`（源时间，3 位小数）：按区间而不是下标，
// 剪辑改了之后旧键对不上就什么都不做，不会删错段。

import type { Trim } from '../types';
import { keepSegments, normalizeRanges, postTrimDuration, type Range } from './time';

const EPS = 1e-3;
/** 分割点离保留段两端至少这么远，免得切出比最短片段还短的碎段。 */
export const MIN_SEGMENT = 0.1;
export const SEG_PREFIX = 'seg:';
export const SEG_DRAG = 'application/x-hitgo-main-segment';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 只保留落在保留段内部（离两端 ≥ MIN_SEGMENT）的分割点，升序去重。 */
export function normalizeSplits(splits: number[] | undefined, duration: number, remove: Range[]): number[] {
  const keeps = keepSegments(duration, remove);
  const out: number[] = [];
  for (const t of [...(splits ?? [])].filter(Number.isFinite).sort((a, b) => a - b)) {
    const inside = keeps.some(([a, b]) => t >= a + MIN_SEGMENT - EPS && t <= b - MIN_SEGMENT + EPS);
    if (inside && (!out.length || t - out[out.length - 1] >= MIN_SEGMENT - EPS)) out.push(round3(t));
  }
  return out;
}

/** 主轨片段（源时间，升序）：保留段按分割点切开。 */
export function mainSegments(duration: number, trim: Pick<Trim, 'remove' | 'splits'>): Range[] {
  const splits = normalizeSplits(trim.splits, duration, trim.remove);
  const out: Range[] = [];
  for (const [a, b] of keepSegments(duration, trim.remove)) {
    let cursor = a;
    for (const s of splits) {
      if (s > a && s < b) {
        out.push([cursor, s]);
        cursor = s;
      }
    }
    out.push([cursor, b]);
  }
  return out;
}

export function segKey([a, b]: Range): string {
  return `${SEG_PREFIX}${a.toFixed(3)}~${b.toFixed(3)}`;
}

export function parseSegKey(key: string): Range | null {
  if (!key.startsWith(SEG_PREFIX)) return null;
  const [a, b] = key.slice(SEG_PREFIX.length).split('~').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
}

/** 选中键对应的现存片段；剪辑已经改过、对不上时返回 null。 */
export function segmentForKey(key: string, segments: Range[]): Range | null {
  const r = parseSegKey(key);
  if (!r) return null;
  return segments.find(([a, b]) => Math.abs(a - r[0]) < 2e-3 && Math.abs(b - r[1]) < 2e-3) ?? null;
}

/** 在 t（源时间）处加分割点；不在某个保留段内部、或离已有分割点太近时返回 null。 */
export function addSplit(duration: number, trim: Pick<Trim, 'remove' | 'splits'>, t: number): number[] | null {
  const seg = mainSegments(duration, trim).find(([a, b]) => t > a && t < b);
  if (!seg || t - seg[0] < MIN_SEGMENT - EPS || seg[1] - t < MIN_SEGMENT - EPS) return null;
  return normalizeSplits([...(trim.splits ?? []), t], duration, trim.remove);
}

/**
 * 删掉若干主轨片段：并进 trim.remove，并清掉落进删除区间的分割点。
 * 会把整条视频删光时返回 null（调用方提示），没有可删的片段时原样返回。
 */
export function removeSegments(duration: number, trim: Pick<Trim, 'remove' | 'splits'>, ranges: Range[]): { remove: Range[]; splits: number[] } | null {
  const remove = normalizeRanges([...trim.remove, ...ranges], duration);
  if (postTrimDuration(duration, remove) < MIN_SEGMENT - 1e-6) return null;
  return { remove: remove.map(([a, b]) => [round3(a), round3(b)] as Range), splits: normalizeSplits(trim.splits, duration, remove) };
}

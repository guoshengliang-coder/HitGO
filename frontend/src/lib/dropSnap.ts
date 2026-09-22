// 把视频拖进时间轴时的落点（HIG-93 / HIG-94）：吸附到 0、播放头、主轨片段 / 剪辑点、上层片段、图层与音轨两端，
// 跟随磁吸开关（⌥ 临时取反）；再把横轴落点换算成主轨插入要用的时钟。

import type { EditSpec } from '../types';
import { playheadSnapCandidates, snapPlayhead } from './playheadSnap';
import type { TimelineAxis } from './timelineAxis';

/** 吸附候选（横轴时刻，升序去重）：播放头 + 与拖播放头同一套剪辑点（换算到当前横轴）。 */
export function dropSnapCandidates(spec: EditSpec | null | undefined, axis: TimelineAxis, ctx: { duration: number; srcAxisLen: number; playhead: number }): number[] {
  const points = [...playheadSnapCandidates(spec, { duration: ctx.duration, axisLen: ctx.srcAxisLen }).map(axis.srcToAxis), axis.srcToAxis(Math.max(0, ctx.playhead))];
  const out: number[] = [];
  for (const v of points.sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 1e-6) out.push(v);
  return out;
}

/** 落点吸附：返回吸附后的横轴时刻与命中的候选（没吸上为 null）。 */
export function snapDrop(v: number, candidates: number[], opts: { pps: number; px: number; enabled: boolean; bypassHeld: boolean }): { at: number; hit: number | null } {
  const r = snapPlayhead(v, candidates, opts);
  return { at: r.t, hit: r.hit };
}

/**
 * 横轴落点 → insertClip 的插入位置。已拼接的视频按拼接时钟（trim.remove 之前）；
 * 还没拼接的视频第一次插入会先把保留段（含循环补足）落成片段、清空删除区间，所以按剪后时间。
 * 以前直接拿源时间轴坐标当插入点，有删除区间时新片段会落到松手处后面（HIG-94）。
 */
export function mainInsertPosition(v: number, axis: TimelineAxis, hasSequence: boolean): number {
  return Math.max(0, hasSequence ? axis.axisToSrc(v) : axis.axisToPost(v));
}

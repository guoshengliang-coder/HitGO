// 播放头自动吸附（HIG-85）：拖标尺 / 轨道 / 播放头把手定位时，靠近剪辑点就吸过去（按住 ⌥ 临时取反，N 开关）。
// 候选点都在时间轴横轴上（源时间；非拼接视频的循环补足段延伸到 axisLen），和时间轴画条用的是同一套坐标。

import type { EditSpec } from '../types';
import { clipWindows } from './sequence';
import { mainSegments } from './segments';
import { postToSource } from './time';
import { cutPoints } from './transportKeys';
import { videoTrackClipEnd } from './videoTracks';
import { snapActive, snapValue } from './snap';

export interface PlayheadSnapContext {
  /** 主轨横轴时长：拼接视频是序列时长，否则是源视频时长。 */
  duration: number;
  /** 横轴总长（含循环补足段）；缺省 = duration。 */
  axisLen?: number;
}

/**
 * 吸附候选（横轴时间，升序去重）：0、片尾、主轨片段 / 拼接片段两端、删除区间两端（剪辑点）、
 * 上层视频片段两端、图层与音轨时段两端（剪后时间换算回横轴）。
 */
export function playheadSnapCandidates(spec: EditSpec | null | undefined, ctx: PlayheadSnapContext): number[] {
  const { duration } = ctx;
  const axisLen = Math.max(duration, ctx.axisLen ?? duration);
  if (!spec) return cutPoints(axisLen, []);
  const remove = spec.trim.remove;
  const toAxis = (post: number) => postToSource(post, remove);
  const extra: number[] = [duration];
  if (spec.sequence) extra.push(...clipWindows(spec.sequence).flatMap((w) => [w.start, w.end]));
  else extra.push(...mainSegments(duration, spec.trim).flat());
  for (const track of spec.video_tracks ?? []) for (const clip of track.clips) extra.push(toAxis(clip.start), toAxis(videoTrackClipEnd(clip)));
  for (const layer of spec.layers) if (layer.t !== 'all') extra.push(...layer.t.map(toAxis));
  for (const track of spec.audio?.tracks ?? []) if (track.t !== 'all') extra.push(...track.t.map(toAxis));
  return cutPoints(axisLen, remove, extra);
}

/** 把拖到的横轴时刻 t 吸到阈值（像素 / pps）内最近的候选；吸附没生效时原样返回。 */
export function snapPlayhead(t: number, candidates: number[], opts: { pps: number; px: number; enabled: boolean; bypassHeld: boolean }): { t: number; hit: number | null } {
  if (!snapActive(opts.enabled, opts.bypassHeld) || opts.pps <= 0) return { t, hit: null };
  const r = snapValue(t, candidates, opts.px / opts.pps);
  return { t: r.value, hit: r.hit };
}

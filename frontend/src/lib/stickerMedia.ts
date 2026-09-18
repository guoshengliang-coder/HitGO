// 视频贴纸的播放位置换算。
//
// 画布预览必须和 worker 的 filtergraph 得出同一个结果，否则"所见"不等于"所得"：
//   loop   → -stream_loop -1 + trim=end  ：素材循环播放
//   freeze → overlay eof_action=repeat   ：播完定格最后一帧
//   once   → overlay eof_action=pass     ：播完消失
// 贴纸在时段起点从自己第 0 帧开始播（后端是 setpts=PTS-STARTPTS+a/TB）。
// 有素材内裁剪（HIG-67）时，"自己第 0 帧"换成 source_in，循环的也是裁出来的那一段
// （后端 trim=start:end + loop 滤镜）；调用方把 lib/sourceTrim 算出的段传进来。

import type { Playback, TimeWindow } from '../types';
import type { SourceSegment } from './sourceTrim';

const EPS = 1e-6;

/**
 * 预览时贴纸此刻该不该出声（契约 §2 mix_audio），规则与成片一致：只在时段内、从贴纸自己的
 * 第 0 秒起；loop 随画面循环，freeze / once 只放一遍。暂停、没开合成、素材没音轨一律静音。
 */
export function stickerAudible(opts: {
  postTime: number;
  t: TimeWindow;
  postDuration: number;
  mediaDuration: number;
  playback?: Playback;
  playing: boolean;
  mixAudio?: boolean;
  hasAudio?: boolean | null;
  /** 素材内裁剪（HIG-67）；不传 = 整个素材。 */
  segment?: SourceSegment;
}): boolean {
  const { postTime, t, postDuration, mediaDuration, playback = 'loop', playing, mixAudio, hasAudio, segment } = opts;
  if (!playing || !mixAudio || hasAudio !== true || !(mediaDuration > 0)) return false;
  const usable = segment?.length ?? mediaDuration;
  const [start, end] = windowRange(t, postDuration);
  if (postTime < start - EPS || postTime > end + EPS) return false;
  return playback === 'loop' || postTime - start < usable - EPS;
}

/** 非 loop 的贴纸已经播到头（freeze 定格中）：此时不能再 play()，否则浏览器会从头重播。 */
export function stickerFinished(postTime: number, t: TimeWindow, postDuration: number, mediaDuration: number, playback: Playback = 'loop', segment?: SourceSegment): boolean {
  if (playback === 'loop' || !(mediaDuration > 0)) return false;
  const usable = segment?.length ?? mediaDuration;
  const [start] = windowRange(t, postDuration);
  return postTime - start >= usable - EPS;
}

/** 时段 t 在剪后时间轴上的实际区间；'all' = [0, postDuration]。 */
export function windowRange(t: TimeWindow, postDuration: number): [number, number] {
  if (t === 'all') return [0, Math.max(0, postDuration)];
  return [t[0], Math.min(t[1], postDuration)];
}

/**
 * 贴纸视频在剪后时刻 postTime 应该定位到的自身播放位置（秒）。
 * 返回 null 表示此刻不该显示这个贴纸。
 */
export function stickerMediaTime(
  postTime: number,
  t: TimeWindow,
  postDuration: number,
  mediaDuration: number,
  playback: Playback = 'loop',
  segment?: SourceSegment,
): number | null {
  const [start, end] = windowRange(t, postDuration);
  if (postTime < start - EPS || postTime > end + EPS) return null;
  if (!(mediaDuration > 0)) return 0; // 时长未知（还在 preparing）：停在首帧

  // 裁剪后只有 [seg.start, seg.end) 这一段参与播放，循环的也是它（契约 §2，HIG-67）
  const from = segment?.trimmed ? segment.start : 0;
  const usable = segment?.trimmed ? segment.length : mediaDuration;
  const elapsed = Math.max(0, postTime - start);
  if (elapsed < usable - EPS) return from + elapsed;

  switch (playback) {
    case 'loop':
      return from + (elapsed % usable);
    case 'freeze':
      // 定格最后一帧：钳到末尾，留一点余量避免 seek 越界
      return Math.max(from, from + usable - 0.001);
    case 'once':
      return null;
  }
}

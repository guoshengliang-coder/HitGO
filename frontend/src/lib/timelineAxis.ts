// 时间轴横轴坐标（HIG-93）：默认按剪后时间画，删掉的部分直接收起，后面的内容接上来（剪映式）；
// 本机偏好 timelineCollapseCuts 关掉时回到源时间轴，删除区间以斜纹留在原位。
// 「源」指主轨时钟：普通视频是源时间，拼接视频是拼接后、二次剪辑前的时间（trim.remove 基于它）；
// 「剪后」是 layers[].t / audio.tracks[].t 用的时间。两种模式下，循环补足段（HIG-50）都接在主轨后面。

import { keepSegments, normalizeRanges, postToSource, postTrimDuration, sourceToPost, type Range } from './time';

export interface TimelineAxis {
  collapsed: boolean;
  /** 横轴总长（秒）：收起时 = 剪后时长 + 循环补足，展开时 = 主轨时长 + 循环补足。 */
  length: number;
  /** 主轨时钟 → 横轴。落在删除区间里的时刻（收起时）并到该区间起点。 */
  srcToAxis: (t: number) => number;
  axisToSrc: (v: number) => number;
  /** 剪后时间 → 横轴。 */
  postToAxis: (p: number) => number;
  axisToPost: (v: number) => number;
  /** 主轨上看得见的保留段 [源起, 源止]，按横轴顺序；展开时是整条 [0, duration]。 */
  visibleSpans: Range[];
  /** 收起后删除区间留下的接缝（横轴时刻，升序去重）；展开时为空。 */
  joins: number[];
}

export function makeTimelineAxis({ collapsed, duration, remove, extra = 0 }: { collapsed: boolean; duration: number; remove: Range[]; extra?: number }): TimelineAxis {
  const ranges = normalizeRanges(remove, duration);
  const postLen = postTrimDuration(duration, ranges);
  const tail = Math.max(0, extra);
  // 源 → 剪后，超出主轨的部分是循环补足段，按原样顺延
  const srcToPost = (t: number) => (t <= duration ? sourceToPost(t, ranges) : postLen + (t - duration));
  const postToSrc = (p: number) => (p <= postLen ? Math.min(duration, postToSource(p, ranges)) : duration + (p - postLen));
  if (!collapsed) {
    return {
      collapsed,
      length: duration + tail,
      srcToAxis: (t) => t,
      axisToSrc: (v) => v,
      postToAxis: postToSrc,
      axisToPost: srcToPost,
      visibleSpans: [[0, duration]],
      joins: [],
    };
  }
  const joins: number[] = [];
  for (const [a] of ranges) {
    const v = sourceToPost(a, ranges);
    if (v > 1e-6 && v < postLen - 1e-6 && !joins.some((j) => Math.abs(j - v) < 1e-6)) joins.push(v);
  }
  return {
    collapsed,
    length: postLen + tail,
    srcToAxis: srcToPost,
    axisToSrc: postToSrc,
    postToAxis: (p) => p,
    axisToPost: (v) => v,
    visibleSpans: keepSegments(duration, ranges),
    joins,
  };
}

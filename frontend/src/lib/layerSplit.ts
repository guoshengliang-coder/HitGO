// 拆分图层（HIG-79，契约 §2「拆分图层」）：与 audioTracks.splitTrackAt 对称的纯前端操作。
//
// 拆开之后画面必须和不拆完全一样，所以只动时段，几何、样式、素材、烤好的 PNG 全部两段各留一份。
// 需要判断归属的只有文字动画：入场属于开头、出场属于结尾，逐字显现的字位置是整张 PNG 的，
// 右段拿着它没有意义（会从头再显现一次），所以只留左段。

import { windowRange } from './stickerMedia';
import type { Layer, TextAnimation, TextLayer, TimeWindow } from '../types';

const EPS = 1e-6;

/** 拆分点离两端至少这么远才拆（秒），与音轨同一个值，免得拆出一段点不中的碎片。 */
export const MIN_SPLIT = 0.1;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 有 scroll 的大字报图层不拆：滚动是整张长 PNG 在裁切框里走，切成两段没有语义。 */
export function canSplitLayer(layer: Layer): boolean {
  return !(layer.type === 'text' && layer.scroll);
}

/** 拆不成时的原因，给按钮的 title 和提示用；能拆时 null。 */
export function splitLayerBlockedReason(layer: Layer | null | undefined, p: number, postDuration: number): string | null {
  if (!layer) return '先选中一个图层';
  if (layer.locked) return '图层已锁定';
  if (!canSplitLayer(layer)) return '大字报的滚动文案不能拆分';
  const [a, b] = windowRange(layer.t, postDuration);
  if (!(p - a >= MIN_SPLIT - EPS && b - p >= MIN_SPLIT - EPS)) return '播放头需落在图层时段内部，且离两端不少于 0.1 秒';
  return null;
}

/** 深拷贝一层动画，免得两段共用同一个对象。 */
function cloneAnimation(anim: TextAnimation): TextAnimation {
  return JSON.parse(JSON.stringify(anim)) as TextAnimation;
}

/**
 * 在剪后时刻 p 把一个图层拆成首尾相接的两段（契约 §2「拆分图层」）：
 * - `t = 'all'` 先展开成 [0, 成片时长]；p 离两端不足 MIN_SPLIT 时返回 null。
 * - 文字动画：in 归左、out 归右、loop 两段都留；reveal 与 glyph_layout 只留左段。
 * - 有 scroll 的图层返回 null。
 */
export function splitLayerAt(layer: Layer, p: number, postDuration: number, newId: string): [Layer, Layer] | null {
  if (!canSplitLayer(layer)) return null;
  const [a, b] = windowRange(layer.t, postDuration);
  if (!(p - a >= MIN_SPLIT - EPS && b - p >= MIN_SPLIT - EPS)) return null;
  const at = round3(p);
  const leftWindow: TimeWindow = [round3(a), at];
  const rightWindow: TimeWindow = [at, round3(b)];
  const left = { ...layer, t: leftWindow } as Layer;
  const right = { ...layer, id: newId, t: rightWindow } as Layer;

  if (layer.type === 'text') {
    const l = left as TextLayer;
    const r = right as TextLayer;
    // 样式与局部上色两段各一份，免得改一段影响另一段
    l.style = { ...layer.style };
    r.style = { ...layer.style };
    if (layer.spans) {
      l.spans = layer.spans.map((s) => ({ ...s }));
      r.spans = layer.spans.map((s) => ({ ...s }));
    }
    const anim = layer.animation;
    if (anim) {
      const la = cloneAnimation(anim);
      const ra = cloneAnimation(anim);
      delete la.out; // 出场属于结尾
      delete ra.in; // 入场属于开头，延迟也跟着走
      delete ra.reveal; // 逐字显现的字位置是整张 PNG 的，右段不该从头再显现一次
      l.animation = la;
      r.animation = ra;
      if (!hasAnyPhase(la)) delete l.animation;
      if (!hasAnyPhase(ra)) delete r.animation;
    }
    if (anim?.reveal) delete r.glyph_layout;
  }
  return [left, right];
}

function hasAnyPhase(anim: TextAnimation): boolean {
  return !!(anim.in || anim.out || anim.loop || anim.reveal);
}

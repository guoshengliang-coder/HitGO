import type { Layer } from '../types';
import { enterDelay, hasAnimation, phaseLengths } from './textAnimation';
import { windowRange } from './stickerMedia';

/** 返回要定位的剪后时间；当前已在时段内则保持当前位置。封面用负时间表示。 */
export function layerFocusTime(layer: Layer, current: number, duration: number): number | null {
  const [a, end] = windowRange(layer.t, duration);
  const b = Math.min(end, duration);
  if (!(b > a) || (current >= a && current < b)) return null;
  let offset = 0;
  if (layer.type === 'text' && hasAnimation(layer.animation)) {
    const delay = enterDelay(layer.animation, b - a);
    const [entry] = phaseLengths(layer.animation, b - a);
    // 避开完全透明的首帧，并跨过入场延迟；仍停在这条字幕自己的时段内。
    if (layer.animation.in || layer.animation.reveal) offset = delay + Math.min(0.1, entry > 0 ? entry / 2 : 1 / 30);
  }
  return a + Math.min(offset, (b - a) * 0.99);
}

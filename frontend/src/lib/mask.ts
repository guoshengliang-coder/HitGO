// 遮盖层（契约 §2 type = "mask"）的纯函数：新建、预览模糊像素、按字幕时段、文案。
// 遮盖用来盖住烧进画面的原字幕，所以缺省贴底通栏、高 12%、底边距 10%，与字幕条的落点一致。

import type { Layer, MaskBlur, MaskLayer, MaskMode } from '../types';

/** 与后端 filtergraph 的 MASK_BLUR_LEVELS 一致：档位 → boxblur 半径（1080 宽画布上的像素）。 */
export const MASK_BLUR_RADIUS: Record<MaskBlur, number> = { 1: 10, 2: 20, 3: 40 };

export const MASK_MODE_LABEL: Record<MaskMode, string> = { blur: '模糊', solid: '色块' };
export const MASK_BLUR_LABEL: Record<MaskBlur, string> = { 1: '弱', 2: '中', 3: '强' };

export const DEFAULT_MASK_COLOR = '#000000';

/** 新建一条缺省遮盖：贴底通栏（bottom-center，底边距 10%），高 12%，模糊中档，全程显示。 */
export function newMaskLayer(newId: () => string): MaskLayer {
  return {
    id: newId(),
    type: 'mask',
    mode: 'blur',
    blur: 2,
    color: DEFAULT_MASK_COLOR,
    anchor: 'bottom-center',
    margin: [0, 0.1],
    width: 1,
    height: 0.12,
    rotate: 0,
    opacity: 1,
    t: 'all',
    name: '遮盖',
  };
}

export const maskBlurLevel = (layer: Pick<MaskLayer, 'blur'>): MaskBlur => (layer.blur === 1 || layer.blur === 3 ? layer.blur : 2);

/**
 * 预览用的 CSS 模糊半径（px）：把 boxblur 半径按舞台宽度缩放。boxblur 两三遍叠加接近高斯，
 * 而 CSS blur() 的参数是高斯 σ，约等于盒半径的 0.8 倍——只是近似，成片以 worker 为准。
 */
export function maskBlurPx(level: MaskBlur | undefined, canvasW: number): number {
  const radius = MASK_BLUR_RADIUS[level ?? 2] ?? MASK_BLUR_RADIUS[2];
  if (!(canvasW > 0)) return 0;
  return Math.max(1, Math.round((radius * 0.8 * canvasW) / 1080 * 10) / 10);
}

/**
 * 全部带时段的文字图层（字幕）的首尾：[最早起点, 最晚终点]；没有带时段的文字图层时返回 null。
 * 「按字幕时段」用它把遮盖的显示时段收到字幕出现的范围内。
 */
export function timedTextSpan(layers: Layer[]): [number, number] | null {
  let start = Infinity;
  let end = -Infinity;
  for (const l of layers) {
    if (l.type !== 'text' || l.t === 'all') continue;
    start = Math.min(start, l.t[0]);
    end = Math.max(end, l.t[1]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return [start, end];
}

/** 图层列表 / 时间线上的一句话摘要：「模糊 · 中」「色块 #112233」。 */
export function maskLabel(layer: Pick<MaskLayer, 'mode' | 'blur' | 'color'>): string {
  const mode = layer.mode === 'solid' ? 'solid' : 'blur';
  if (mode === 'solid') return `${MASK_MODE_LABEL.solid} ${(layer.color ?? DEFAULT_MASK_COLOR).toUpperCase()}`;
  return `${MASK_MODE_LABEL.blur} · ${MASK_BLUR_LABEL[maskBlurLevel(layer)]}`;
}

// 源画面裁切窗口（契约第 2 节 outputs[].crop）：x / y / w / h 都是相对源宽 / 高的 0–1 比例。
// 舞台按源视频比例绘制，所以舞台像素比 = 源像素比；窗口的像素比锁定为输出画幅比，
// 这样 worker 端 cover 居中那一步不会再裁掉任何东西，所见即所得。

import type { CropRect } from '../types';
import { round4 } from './layout';

/** 窗口最小边长（相对比例），防止拖到看不见。 */
export const MIN_CROP = 0.05;

/** 输出画幅比 W/H（如 9:16 → 0.5625）。 */
export type AspectRatio = number;

function roundRect(r: CropRect): CropRect {
  return { x: round4(r.x), y: round4(r.y), w: round4(r.w), h: round4(r.h) };
}

/** 缺省窗口 = worker 的 cover 居中裁切：源比画幅宽就取整高、居中的一条；否则取整宽、居中的一段。 */
export function defaultCropRect(srcW: number, srcH: number, aspect: AspectRatio): CropRect {
  if (srcW <= 0 || srcH <= 0 || aspect <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  const srcAspect = srcW / srcH;
  if (srcAspect > aspect) {
    const w = aspect / srcAspect;
    return roundRect({ x: (1 - w) / 2, y: 0, w, h: 1 });
  }
  const h = srcAspect / aspect;
  return roundRect({ x: 0, y: (1 - h) / 2, w: 1, h });
}

/**
 * 把窗口收进源画面内并锁定为画幅比：以 w 为准推出 h；超出 0–1 或小于 MIN_CROP 时按比例缩放，
 * 然后平移 x / y 保证不出界。返回的窗口满足契约校验（0 < w,h ≤ 1，x+w ≤ 1，y+h ≤ 1）。
 */
export function clampCropRect(rect: CropRect, srcW: number, srcH: number, aspect: AspectRatio): CropRect {
  if (srcW <= 0 || srcH <= 0 || aspect <= 0) return roundRect(rect);
  const full = defaultCropRect(srcW, srcH, aspect); // 该画幅比能放进源里的最大窗口
  // h 由 w 推出：(w·srcW) / (h·srcH) = aspect
  const ratio = srcW / (aspect * srcH); // h = w · ratio
  let w = Number.isFinite(rect.w) ? rect.w : full.w;
  const minW = Math.max(MIN_CROP, MIN_CROP / ratio);
  w = Math.min(full.w, Math.max(minW, w));
  let h = w * ratio;
  if (h > 1) {
    h = 1;
    w = h / ratio;
  }
  const x = Math.min(1 - w, Math.max(0, Number.isFinite(rect.x) ? rect.x : 0));
  const y = Math.min(1 - h, Math.max(0, Number.isFinite(rect.y) ? rect.y : 0));
  return roundRect({ x, y, w, h });
}

/** 是否等于缺省（居中 cover）窗口，用于界面显示"居中（默认）"。 */
export function isDefaultCrop(rect: CropRect | undefined, srcW: number, srcH: number, aspect: AspectRatio): boolean {
  if (!rect) return true;
  const d = defaultCropRect(srcW, srcH, aspect);
  const eps = 1e-3;
  return Math.abs(rect.x - d.x) < eps && Math.abs(rect.y - d.y) < eps && Math.abs(rect.w - d.w) < eps && Math.abs(rect.h - d.h) < eps;
}

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 相对窗口 → 舞台像素框（舞台 W×H 按源比例绘制）。 */
export function cropRectToPixels(rect: CropRect, W: number, H: number): PixelBox {
  return { x: rect.x * W, y: rect.y * H, w: rect.w * W, h: rect.h * H };
}

/** 舞台像素框 → 相对窗口（未做钳制，调用方接 clampCropRect）。 */
export function cropRectFromPixels(box: PixelBox, W: number, H: number): CropRect {
  if (W <= 0 || H <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H };
}

/** 面板上的可读说明：源像素尺寸 + 左上角，如 "608×1080 @ 656,0"。 */
export function describeCrop(rect: CropRect, srcW: number, srcH: number): string {
  const w = Math.round(rect.w * srcW);
  const h = Math.round(rect.h * srcH);
  const x = Math.round(rect.x * srcW);
  const y = Math.round(rect.y * srcH);
  return `${w}×${h} @ ${x},${y}`;
}

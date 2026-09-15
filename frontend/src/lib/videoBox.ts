// 变体预览的画面几何：把源画面按 fill 模式摆进输出画幅。
// canvas 侧直接把结果喂 9 参数 drawImage；抽成纯函数是为了能在 vitest 里覆盖，
// 也保证「预览怎么摆」和「worker 怎么摆」只有一份说法（见 docs/CONTRACT.md 第 2 节 outputs[].crop）。

import type { CropRect, FillMode } from '../types';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一次 drawImage 的参数：src 为 null 表示整帧作源。 */
export interface FrameBox {
  src: Box | null;
  dst: Box;
}

function degenerate(W: number, H: number): Box {
  return { x: 0, y: 0, w: Math.max(0, W), h: Math.max(0, H) };
}

function valid(srcW: number, srcH: number, W: number, H: number): boolean {
  return srcW > 0 && srcH > 0 && W > 0 && H > 0 && Number.isFinite(srcW) && Number.isFinite(srcH) && Number.isFinite(W) && Number.isFinite(H);
}

/** 整幅放进画幅内，保持源比例，至少一边贴边（letterbox / pillarbox）。 */
export function containBox(srcW: number, srcH: number, W: number, H: number): Box {
  if (!valid(srcW, srcH, W, H)) return degenerate(W, H);
  const scale = Math.min(W / srcW, H / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/** 铺满画幅，保持源比例，溢出部分被画幅裁掉。zoom 额外放大（模糊底图用 1.05）。 */
export function coverBox(srcW: number, srcH: number, W: number, H: number, zoom = 1): Box {
  if (!valid(srcW, srcH, W, H) || !(zoom > 0)) return degenerate(W, H);
  const scale = Math.max(W / srcW, H / srcH) * zoom;
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/**
 * 裁切窗口：先按 rect 从源上取一块，再把这块 cover 居中到画幅 —— 和 worker 的
 * `crop → scale cover → crop` 顺序一致。rect 缺省时退回整幅 cover。
 */
export function cropCoverBox(rect: CropRect | undefined, srcW: number, srcH: number, W: number, H: number): FrameBox {
  if (!valid(srcW, srcH, W, H)) return { src: null, dst: degenerate(W, H) };
  if (!rect || !Number.isFinite(rect.w) || !Number.isFinite(rect.h) || rect.w <= 0 || rect.h <= 0) {
    return { src: null, dst: coverBox(srcW, srcH, W, H) };
  }
  const sx = rect.x * srcW;
  const sy = rect.y * srcH;
  const sw = Math.max(1, rect.w * srcW);
  const sh = Math.max(1, rect.h * srcH);
  return { src: { x: sx, y: sy, w: sw, h: sh }, dst: coverBox(sw, sh, W, H) };
}

/** 按 fill 模式给出源帧那一次 drawImage 的参数。blur / color 模式下前景是 contain。 */
export function variantFrameBox(fill: FillMode, crop: CropRect | undefined, srcW: number, srcH: number, W: number, H: number): FrameBox {
  if (fill === 'crop') return cropCoverBox(crop, srcW, srcH, W, H);
  return { src: null, dst: containBox(srcW, srcH, W, H) };
}

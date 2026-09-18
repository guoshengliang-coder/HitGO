// 大字报裁切框的画布拖拽（HIG-75，契约 §2 scroll.box）：舞台像素 ↔ 相对画布的比例。
//
// 框的四个值后端要校验（schemas.py ScrollBox：x,y ∈ [0,1)，w,h ∈ (0,1]，且 x+w ≤ 1、y+h ≤ 1），
// 所以拖拽结果必须在这里就夹住——夹晚了用户会在保存时吃一个 400，而他明明只是把框拖出了画面。

import type { ScrollBox } from '../types';

/** 框最小也要留得下一行字，太小的话滚动没有意义，拖的时候也捏不住。 */
export const MIN_BOX = 0.05;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 把一个可能越界的框收进契约允许的范围：先夹尺寸，再夹位置，保证 x + w ≤ 1、y + h ≤ 1。
 * 先尺寸后位置的顺序很重要——反过来会在贴边时把用户刚拖出来的宽度悄悄吃掉。
 */
export function clampScrollBox(box: ScrollBox): ScrollBox {
  const w = Math.max(MIN_BOX, Math.min(1, box.w));
  const h = Math.max(MIN_BOX, Math.min(1, box.h));
  const x = Math.max(0, Math.min(clamp01(box.x), 1 - w));
  const y = Math.max(0, Math.min(clamp01(box.y), 1 - h));
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

/** 舞台像素矩形 → 相对画布的框；stage 是舞台的像素宽高。 */
export function boxFromStage(rect: { x: number; y: number; width: number; height: number }, stage: { w: number; h: number }): ScrollBox {
  if (!(stage.w > 0 && stage.h > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  return clampScrollBox({ x: rect.x / stage.w, y: rect.y / stage.h, w: rect.width / stage.w, h: rect.height / stage.h });
}

/** 相对画布的框 → 舞台像素矩形，画虚线框和摆 Transformer 都用它。 */
export function boxToStage(box: ScrollBox, stage: { w: number; h: number }): { x: number; y: number; width: number; height: number } {
  return { x: box.x * stage.w, y: box.y * stage.h, width: box.w * stage.w, height: box.h * stage.h };
}

/**
 * Konva 缩放后把 scaleX / scaleY 折进宽高（节点本身的 scale 要重置回 1），再换算成框。
 * Transformer 给的是「原尺寸 × 缩放」，直接读 width() 会拿到缩放前的值。
 */
export function boxFromTransform(node: { x(): number; y(): number; width(): number; height(): number; scaleX(): number; scaleY(): number }, stage: { w: number; h: number }): ScrollBox {
  return boxFromStage({ x: node.x(), y: node.y(), width: Math.abs(node.width() * node.scaleX()), height: Math.abs(node.height() * node.scaleY()) }, stage);
}

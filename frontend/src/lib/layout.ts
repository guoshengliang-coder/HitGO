// 图层几何换算（契约第 2 节）。
// 画布 W×H 像素，图层宽 w = width·W，高 h 由素材宽高比推出：
//   x: left → margin.x·W；center → (W−w)/2 + margin.x·W；right → W − w − margin.x·W
//   y: top → margin.y·H；center → (H−h)/2 + margin.y·H；bottom → H − h − margin.y·H
// 旋转绕图层中心。

import type { Anchor } from '../types';

export interface Canvas {
  W: number;
  H: number;
}

export interface LayerBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement {
  anchor: Anchor;
  margin: [number, number];
  width: number; // 相对画布宽
}

export function anchorParts(anchor: Anchor): { ax: 'left' | 'center' | 'right'; ay: 'top' | 'center' | 'bottom' } {
  if (anchor === 'center') return { ax: 'center', ay: 'center' };
  const [ay, ax] = anchor.split('-') as ['top' | 'center' | 'bottom', 'left' | 'center' | 'right'];
  return { ax, ay };
}

export function makeAnchor(ax: 'left' | 'center' | 'right', ay: 'top' | 'center' | 'bottom'): Anchor {
  if (ax === 'center' && ay === 'center') return 'center';
  return `${ay}-${ax}` as Anchor;
}

/** 由 anchor + margin + width 与素材宽高比得到像素框（左上角 + 宽高，未旋转）。 */
export function placeLayer(p: Placement, aspectRatio: number, c: Canvas): LayerBox {
  const w = p.width * c.W;
  const h = aspectRatio > 0 ? w / aspectRatio : 0;
  const { ax, ay } = anchorParts(p.anchor);
  const mx = p.margin[0] * c.W;
  const my = p.margin[1] * c.H;
  let x: number;
  let y: number;
  if (ax === 'left') x = mx;
  else if (ax === 'center') x = (c.W - w) / 2 + mx;
  else x = c.W - w - mx;
  if (ay === 'top') y = my;
  else if (ay === 'center') y = (c.H - h) / 2 + my;
  else y = c.H - h - my;
  return { x, y, w, h };
}

/** 由像素框左上角反推 margin（保持给定 anchor）。 */
export function marginFromBox(box: LayerBox, anchor: Anchor, c: Canvas): [number, number] {
  const { ax, ay } = anchorParts(anchor);
  let mx: number;
  let my: number;
  if (ax === 'left') mx = box.x;
  else if (ax === 'center') mx = box.x - (c.W - box.w) / 2;
  else mx = c.W - box.w - box.x;
  if (ay === 'top') my = box.y;
  else if (ay === 'center') my = box.y - (c.H - box.h) / 2;
  else my = c.H - box.h - box.y;
  return [mx / c.W, my / c.H];
}

/** 切换 anchor 但保持视觉位置不变：重新计算 margin。 */
export function reanchor(p: Placement, aspectRatio: number, c: Canvas, next: Anchor): Placement {
  const box = placeLayer(p, aspectRatio, c);
  return { anchor: next, margin: marginFromBox(box, next, c), width: p.width };
}

/** 按像素平移图层（保持 anchor），返回新的 margin（未做四舍五入）。 */
export function nudgePlacement(p: Placement, aspectRatio: number, c: Canvas, dx: number, dy: number): [number, number] {
  const box = placeLayer(p, aspectRatio, c);
  return marginFromBox({ ...box, x: box.x + dx, y: box.y + dy }, p.anchor, c);
}

/** 图层未旋转外框（相对比例，0–1）与安全区矩形是否重叠。 */
export function boxOverlapsRect(
  box: LayerBox,
  c: Canvas,
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  const bx = box.x / c.W;
  const by = box.y / c.H;
  const bw = box.w / c.W;
  const bh = box.h / c.H;
  return bx < rect.x + rect.w && bx + bw > rect.x && by < rect.y + rect.h && by + bh > rect.y;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

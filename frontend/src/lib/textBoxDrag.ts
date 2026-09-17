// 文字框拖边（HIG-51，对齐剪映）：左右边改自动换行宽度（style.wrap_width），上下边改框高（style.box_height），
// 字号不变。舞台只做换算：拖到的舞台尺寸 → 样式字段；按新样式重画的 PNG 尺寸与拖到的尺寸不一定相等
// （框高不小于文字、换行宽度有上下限），这时挪中心让被拖边的对边保持不动。

import { clampWrapWidth } from './textWrap';

/** 渲染基准画布（与 textImage.TEXT_CANVAS 一致；这里不引 textImage，免得纯函数带上 api / DOM）。 */
const BASE = { W: 1080, H: 1920 };

/** 拖到的舞台框宽 → wrap_width。ratio = 舞台像素 / PNG 像素，pad = PNG 四周为阴影 / 发光留的透明边距。 */
export function wrapWidthFromStage(stageW: number, ratio: number, pad: number): number {
  return clampWrapWidth((stageW / ratio - 2 * pad) / BASE.W);
}

/**
 * 拖到的舞台框高 → box_height。tight 是文字本身的框高（PNG 像素，不含 pad）：
 * 不比它高就返回 null（贴合文字），否则按基准画布高换算，不超过 1。
 */
export function boxHeightFromStage(stageH: number, ratio: number, pad: number, tight: number): number | null {
  const px = stageH / ratio - 2 * pad;
  if (!(px > tight + 0.5)) return null;
  return Math.round(Math.min(1, px / BASE.H) * 10000) / 10000;
}

/**
 * 保持对边不动：沿 axis 拖到的长度是 dragged，实际画出来是 actual，中心（考虑旋转）挪 (actual − dragged) / 2。
 * side = 1 表示拖的是右 / 下边，−1 表示左 / 上边。
 */
export function keepOppositeEdge(center: { x: number; y: number }, rotationDeg: number, axis: 'x' | 'y', side: 1 | -1, dragged: number, actual: number): { x: number; y: number } {
  const d = (side * (actual - dragged)) / 2;
  const dx = axis === 'x' ? d : 0;
  const dy = axis === 'y' ? d : 0;
  const a = (rotationDeg * Math.PI) / 180;
  return { x: center.x + dx * Math.cos(a) - dy * Math.sin(a), y: center.y + dx * Math.sin(a) + dy * Math.cos(a) };
}

/** Transformer 把手名 → 拖边的轴和方向；不是边把手返回 null。 */
export function edgeOfAnchor(anchor: string | null | undefined): { axis: 'x' | 'y'; side: 1 | -1 } | null {
  switch (anchor) {
    case 'middle-left':
      return { axis: 'x', side: -1 };
    case 'middle-right':
      return { axis: 'x', side: 1 };
    case 'top-center':
      return { axis: 'y', side: -1 };
    case 'bottom-center':
      return { axis: 'y', side: 1 };
    default:
      return null;
  }
}

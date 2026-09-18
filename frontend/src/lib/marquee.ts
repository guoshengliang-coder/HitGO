// 框选（HIG-77）：时间线轨道区和画布共用的一套命中判定，不碰 DOM。
//
// 两边的坐标系不同（时间线是「行 × 秒」，画布是舞台像素），但要回答的问题一样：
// 拉出来的这个框压到了哪些东西，以及按住 Shift 时该怎么并进已选中的那一批。

/** 归一化后的矩形：left ≤ right、top ≤ bottom。 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 两个点拉出的框，支持从右下往左上反着拖。 */
export function marqueeRect(from: Point, to: Point): Rect {
  return {
    left: Math.min(from.x, to.x),
    right: Math.max(from.x, to.x),
    top: Math.min(from.y, to.y),
    bottom: Math.max(from.y, to.y),
  };
}

/** 框有没有大到该当成框选（而不是一次点击）。阈值用调用方的坐标单位。 */
export function isMarquee(rect: Rect, threshold = 4): boolean {
  return rect.right - rect.left >= threshold || rect.bottom - rect.top >= threshold;
}

/** 两个矩形是否相交（碰到就算，不要求包住——剪映、PS 都是这个手感）。 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 带 id 的矩形，时间线的行和画布的图层盒都归到这一种形状。 */
export interface IdRect extends Rect {
  id: string;
}

/** 框压到的 id，按传入顺序返回。 */
export function hitRects(rect: Rect, boxes: IdRect[]): string[] {
  return boxes.filter((b) => rectsOverlap(rect, b)).map((b) => b.id);
}

/** 怎么并进已选中的那一批：裸拖替换、Shift 拖追加、Shift 点在选中与否之间翻转。 */
export type MarqueeMode = 'replace' | 'add' | 'toggle';

/** 按 Shift 的状态选模式：拖框时按住 = 追加，点击时按住 = 翻转。 */
export function modeFor(shiftKey: boolean, gesture: 'drag' | 'click'): MarqueeMode {
  if (!shiftKey) return 'replace';
  return gesture === 'drag' ? 'add' : 'toggle';
}

/**
 * 把这一次命中的 id 并进已选中的那一批，结果保持稳定顺序（先已选中的、再新命中的），
 * 这样 ids[0]（主选中）不会因为一次追加就跳到别的图层上。
 */
export function applyMarquee(prev: string[], hits: string[], mode: MarqueeMode): string[] {
  if (mode === 'replace') return [...new Set(hits)];
  if (mode === 'add') return [...new Set([...prev, ...hits])];
  const out = prev.filter((id) => !hits.includes(id));
  for (const id of hits) if (!prev.includes(id)) out.push(id);
  return out;
}

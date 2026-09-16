// 弹层定位：优先放在触发器下方左对齐；下方放不下翻到上方；都放不下就贴视口边限位。

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function placePopover(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8,
): { left: number; top: number } {
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - size.height;
  let top: number;
  if (below + size.height <= viewport.height - margin) top = below;
  else if (above >= margin) top = above;
  else top = viewport.height - margin - size.height;
  top = Math.max(margin, top);
  const maxLeft = viewport.width - margin - size.width;
  const left = Math.max(margin, Math.min(anchor.left, maxLeft));
  return { left, top };
}

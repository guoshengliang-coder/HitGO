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

/**
 * 「?」说明气泡（纯 CSS 的 .tip-wide，定宽换行）朝上还是朝下弹（HIG-57）：默认朝上；按字数估出气泡高度，
 * 上方到裁切它的滚动容器顶放不下就朝下。字数估算偏保守（11px 字号、按全角字符宽度算），宁可早翻。
 */
export function tipSide(anchorTop: number, clipTop: number, text: string, width = 240, gap = 6): 'top' | 'bottom' {
  const perLine = Math.max(1, Math.floor((width - 16) / 11));
  const lines = Math.max(1, Math.ceil(Array.from(text).length / perLine));
  const height = lines * 11 * 1.4 + 8;
  return anchorTop - clipTop >= height + gap ? 'top' : 'bottom';
}

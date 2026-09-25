// 画布拖拽吸附（Stage 里文字 / 贴纸的 LayerNode 与遮盖的 MaskNode 共用）：
// 拖动中把节点外接矩形的左 / 中 / 右、上 / 中 / 下 吸到参考线上，吸附开关（N）关着时不吸，按住 ⌘/Ctrl 临时取反；命中的参考线由 Stage 画在最上层。

import type Konva from 'konva';
import { snapActive, snapValue } from '../../lib/snap';
import { useEditor } from '../../store/editor';

export const SNAP_PX = 6;
export const GUIDE_COLOR = '#d9481f';

export type Guides = { xs: number[]; ys: number[] };
export const NO_GUIDES: Guides = { xs: [], ys: [] };

/** 拖动中调用：就地平移 node 使其贴到最近的参考线，并通过 onGuides 报告命中的线（没命中 / 关闭吸附时清空）。 */
export function snapDraggedNode(node: Konva.Node, evt: MouseEvent | TouchEvent | undefined, guides: Guides, onGuides: (g: Guides) => void): void {
  const me = evt as MouseEvent | undefined;
  if (!snapActive(useEditor.getState().snapEnabled, !!(me?.ctrlKey || me?.metaKey))) {
    onGuides(NO_GUIDES);
    return;
  }
  // 交互舞台外扩后，节点放在带偏移的 Group 里；参考线仍使用画布局部坐标。
  const r = node.getClientRect({ skipStroke: true, relativeTo: node.getParent() ?? undefined });
  const snapAxis = (edges: number[], lines: number[]) => {
    let best: { d: number; delta: number; hit: number } | null = null;
    for (const v of edges) {
      const s = snapValue(v, lines, SNAP_PX);
      if (s.hit === null) continue;
      const d = Math.abs(s.hit - v);
      if (!best || d < best.d) best = { d, delta: s.hit - v, hit: s.hit };
    }
    return best;
  };
  const sx = snapAxis([r.x, r.x + r.width / 2, r.x + r.width], guides.xs);
  const sy = snapAxis([r.y, r.y + r.height / 2, r.y + r.height], guides.ys);
  if (sx) node.x(node.x() + sx.delta);
  if (sy) node.y(node.y() + sy.delta);
  onGuides({ xs: sx ? [sx.hit] : [], ys: sy ? [sy.hit] : [] });
}

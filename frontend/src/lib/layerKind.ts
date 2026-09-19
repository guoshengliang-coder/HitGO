// 文本 / 贴纸分开管理后的图层层级操作。
// spec.layers 仍是一条混排的 z 序（末尾 = 最上层）；在某一类里调层级时，只在这一类占用的位置之间换序，
// 另一类图层的位置原封不动，所以两类之间的相对层级不会被一次「上移 / 置顶」悄悄改掉。

import type { Layer } from '../types';
import { reorder } from './order';
import { layerLane } from './timelineTracks';

export type LayerType = Layer['type'];

/** 某一类图层，保持 z 序（第一个 = 最下层）。 */
export function layersOfType<T extends Layer>(layers: T[], type: LayerType): T[] {
  return layers.filter((l) => l.type === type);
}

/** 编辑分类内的层级：字幕与普通文字独立换序，其他分类的槽位保持不变。 */
export function layersInCategory<T extends Layer>(layers: T[], layer: Layer): T[] {
  return layers.filter((l) => l.type === layer.type && layerLane(l) === layerLane(layer));
}

/**
 * 把图层 id 挪到它这一类里的第 index 位（0 = 这一类最下层；越界夹到边界）。
 * 返回新数组；找不到 id 或位置没变时返回原数组。
 */
export function moveWithinType<T extends Layer>(layers: T[], id: string, index: number): T[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer) return layers;
  const slots: number[] = [];
  layers.forEach((l, i) => {
    if (l.type === layer.type && layerLane(l) === layerLane(layer)) slots.push(i);
  });
  const subset = slots.map((i) => layers[i]);
  const from = subset.indexOf(layer);
  const to = Math.min(subset.length - 1, Math.max(0, Math.trunc(index)));
  if (from === to) return layers;
  const moved = reorder(subset, from, to);
  const next = layers.slice();
  slots.forEach((slot, k) => {
    next[slot] = moved[k];
  });
  return next;
}

/**
 * 新图层要压在某一类之下时的插入下标：第一个该类图层的位置；没有这一类时等于末尾（= 最上层）。
 * 遮盖层用它插到第一个文字图层之前，保证遮盖永远在字幕之下（契约 §2）。
 */
export function insertIndexBelow(layers: Layer[], type: LayerType): number {
  const i = layers.findIndex((l) => l.type === type);
  return i < 0 ? layers.length : i;
}

/** 图层在自己这一类里的位置（0 = 最下层）；找不到返回 -1。 */
export function indexWithinType(layers: Layer[], id: string): number {
  const layer = layers.find((l) => l.id === id);
  if (!layer) return -1;
  return layersInCategory(layers, layer).indexOf(layer);
}

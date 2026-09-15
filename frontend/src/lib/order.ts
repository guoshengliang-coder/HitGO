// 数组元素重排（图层列表拖拽排序用）。

/**
 * 把 arr[from] 挪到最终位置 to，返回新数组（不改原数组）。
 * from / to 越界时夹到 [0, length-1]；两者相同时原样复制。
 */
export function reorder<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  if (next.length === 0) return next;
  const max = next.length - 1;
  const f = Math.min(max, Math.max(0, Math.trunc(from)));
  const t = Math.min(max, Math.max(0, Math.trunc(to)));
  if (f === t) return next;
  const [item] = next.splice(f, 1);
  next.splice(t, 0, item);
  return next;
}

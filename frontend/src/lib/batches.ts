// 批次列表的排序（纯函数，页面只负责调用）。

import type { Batch } from '../types';

export type BatchSort = 'recent' | 'name';

/** 最近创建在前，或按名称（中文按拼音）。不改原数组。 */
export function sortBatches(list: Batch[], sort: BatchSort): Batch[] {
  const copy = [...list];
  if (sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

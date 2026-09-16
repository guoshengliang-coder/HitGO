import { describe, expect, it } from 'vitest';
import { sortBatches } from './batches';
import type { Batch } from '../types';

const b = (name: string, created_at: string): Batch => ({ id: name, name, created_at, video_count: 0, status_counts: { preparing: 0, ready: 0, edited: 0, rendering: 0, done: 0, failed: 0 } });

describe('sortBatches', () => {
  const list = [b('乙', '2026-09-01T00:00:00Z'), b('甲', '2026-09-16T00:00:00Z'), b('Alpha', '2026-09-10T00:00:00Z')];
  it('recent：最近创建在前', () => {
    expect(sortBatches(list, 'recent').map((x) => x.name)).toEqual(['甲', 'Alpha', '乙']);
  });
  it('name：按名称（zh-Hans-CN 排序：中文按拼音，拉丁字母在后）', () => {
    expect(sortBatches(list, 'name').map((x) => x.name)).toEqual(['甲', '乙', 'Alpha']);
  });
  it('不改原数组', () => {
    const before = list.map((x) => x.name);
    sortBatches(list, 'name');
    expect(list.map((x) => x.name)).toEqual(before);
  });
});

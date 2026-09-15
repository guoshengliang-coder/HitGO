import { describe, expect, it } from 'vitest';
import { reorder } from './order';

describe('reorder', () => {
  it('往后挪', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('往前挪', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });
  it('挪到末尾 / 开头', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
  it('from / to 越界时夹到边界', () => {
    expect(reorder(['a', 'b', 'c'], -5, 1)).toEqual(['b', 'a', 'c']);
    expect(reorder(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(reorder(['a', 'b', 'c'], 99, -1)).toEqual(['c', 'a', 'b']);
  });
  it('from === to 时不变', () => {
    expect(reorder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });
  it('总是返回新数组，不改原数组', () => {
    const src = ['a', 'b', 'c'];
    const same = reorder(src, 1, 1);
    const moved = reorder(src, 0, 2);
    expect(same).not.toBe(src);
    expect(moved).not.toBe(src);
    expect(src).toEqual(['a', 'b', 'c']);
    expect(reorder([], 0, 0)).toEqual([]);
  });
});

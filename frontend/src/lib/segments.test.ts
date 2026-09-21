import { describe, expect, it } from 'vitest';
import { addSplit, mainSegments, normalizeSplits, parseSegKey, removeSegments, segKey, segmentForKey } from './segments';

describe('main track segments (HIG-85)', () => {
  it('保留段按分割点切开；落在删除区间里或贴着两端的分割点忽略', () => {
    expect(mainSegments(10, { remove: [[4, 5]], splits: [2, 4.5, 5.05, 8] })).toEqual([[0, 2], [2, 4], [5, 8], [8, 10]]);
    expect(normalizeSplits([8, 2, 2.05, -1], 10, [])).toEqual([2, 8]);
    expect(mainSegments(10, { remove: [] })).toEqual([[0, 10]]);
  });

  it('选中键按区间编码，剪辑改过后对不上返回 null', () => {
    const key = segKey([2, 4]);
    expect(key).toBe('seg:2.000~4.000');
    expect(parseSegKey(key)).toEqual([2, 4]);
    expect(parseSegKey('clip:x')).toBeNull();
    expect(segmentForKey(key, [[0, 2], [2, 4]])).toEqual([2, 4]);
    expect(segmentForKey(key, [[0, 4]])).toBeNull();
  });

  it('只在保留段内部加分割点', () => {
    expect(addSplit(10, { remove: [[4, 5]] }, 3)).toEqual([3]);
    expect(addSplit(10, { remove: [[4, 5]], splits: [3] }, 7)).toEqual([3, 7]);
    expect(addSplit(10, { remove: [[4, 5]] }, 4.5)).toBeNull();
    expect(addSplit(10, { remove: [[4, 5]] }, 3.95)).toBeNull();
    expect(addSplit(10, { remove: [], splits: [3] }, 3)).toBeNull();
  });

  it('删除片段并进 trim.remove，清掉失效的分割点；删光时拒绝', () => {
    expect(removeSegments(10, { remove: [[4, 5]], splits: [2, 8] }, [[2, 4]])).toEqual({ remove: [[2, 5]], splits: [8] });
    expect(removeSegments(10, { remove: [], splits: [5] }, [[0, 5], [5, 10]])).toBeNull();
  });
});

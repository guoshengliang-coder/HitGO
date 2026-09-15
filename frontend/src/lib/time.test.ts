import { describe, expect, it } from 'vitest';
import {
  formatTime,
  formatTimecode,
  frameDuration,
  keepSegments,
  normalizeRanges,
  postToSource,
  postTrimDuration,
  removedRangeAt,
  skipRemoved,
  sourceToPost,
  windowContains,
  wouldRemoveAll,
} from './time';

const remove: [number, number][] = [
  [3.2, 5.8],
  [17.0, 18.4],
];

describe('normalizeRanges', () => {
  it('排序、合并重叠、裁剪到时长', () => {
    expect(normalizeRanges([[5, 8], [1, 3], [2, 4], [9, 30]], 20)).toEqual([
      [1, 4],
      [5, 8],
      [9, 20],
    ]);
  });
  it('丢弃空区间与反向区间修正', () => {
    expect(normalizeRanges([[2, 2], [6, 4]])).toEqual([[4, 6]]);
  });
});

describe('postTrimDuration / keepSegments', () => {
  it('总时长减去删除时长', () => {
    expect(postTrimDuration(24.6, remove)).toBeCloseTo(24.6 - 2.6 - 1.4, 6);
  });
  it('保留段', () => {
    expect(keepSegments(24.6, remove)).toEqual([
      [0, 3.2],
      [5.8, 17.0],
      [18.4, 24.6],
    ]);
  });
  it('删除区间覆盖开头', () => {
    expect(keepSegments(10, [[0, 2]])).toEqual([[2, 10]]);
  });
});

describe('sourceToPost / postToSource', () => {
  it('删除区间之前不变', () => {
    expect(sourceToPost(2, remove)).toBeCloseTo(2);
    expect(postToSource(2, remove)).toBeCloseTo(2);
  });
  it('跨过一个区间', () => {
    expect(sourceToPost(10, remove)).toBeCloseTo(10 - 2.6);
    expect(postToSource(10 - 2.6, remove)).toBeCloseTo(10);
  });
  it('跨过两个区间', () => {
    expect(sourceToPost(20, remove)).toBeCloseTo(20 - 4.0);
    expect(postToSource(16, remove)).toBeCloseTo(20);
  });
  it('区间内映射到区间起点', () => {
    expect(sourceToPost(4, remove)).toBeCloseTo(3.2);
    expect(sourceToPost(5.8, remove)).toBeCloseTo(3.2);
  });
  it('剪后时间落在区间边界时跳到区间末尾', () => {
    expect(postToSource(3.2, remove)).toBeCloseTo(5.8);
  });
  it('往返一致（保留段内）', () => {
    for (const t of [0, 1, 3.1, 6, 12, 18.5, 24]) {
      expect(postToSource(sourceToPost(t, remove), remove)).toBeCloseTo(t, 6);
    }
  });
});

describe('removedRangeAt / skipRemoved', () => {
  it('找到所在区间', () => {
    expect(removedRangeAt(4, remove)).toEqual([3.2, 5.8]);
    expect(removedRangeAt(5.8, remove)).toBeNull();
    expect(removedRangeAt(10, remove)).toBeNull();
  });
  it('播放跳过', () => {
    expect(skipRemoved(4, remove)).toBeCloseTo(5.8);
    expect(skipRemoved(10, remove)).toBeCloseTo(10);
    expect(skipRemoved(3, [[3, 5], [5, 7]])).toBeCloseTo(7);
  });
});

describe('wouldRemoveAll', () => {
  it('删左 / 删右 剩余足够时允许', () => {
    expect(wouldRemoveAll(remove, [0, 10], 24.6)).toBe(false);
    expect(wouldRemoveAll(remove, [10, 24.6], 24.6)).toBe(false);
  });
  it('删掉全部或只剩不到 minKeep 时拒绝', () => {
    expect(wouldRemoveAll([], [0, 24.6], 24.6)).toBe(true);
    expect(wouldRemoveAll([[0, 12]], [12.05, 24.6], 24.6)).toBe(true);
    expect(wouldRemoveAll([[0, 12]], [12.05, 24.6], 24.6, 0.05)).toBe(false);
  });
  it('与已有区间合并后判断', () => {
    expect(wouldRemoveAll([[0, 5], [5, 10]], [10, 20], 20)).toBe(true);
    expect(wouldRemoveAll([[0, 5], [5, 10]], [10, 19], 20)).toBe(false);
  });
});

describe('windowContains / formatTime', () => {
  it('时段判断', () => {
    expect(windowContains('all', 100)).toBe(true);
    expect(windowContains([0, 6], 3)).toBe(true);
    expect(windowContains([0, 6], 6.5)).toBe(false);
  });
  it('格式化', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(65.5)).toBe('1:05.50');
    expect(formatTime(4.2)).toBe('0:04.20');
  });
});

describe('frameDuration / formatTimecode', () => {
  it('帧时长按真实 fps，缺省或非法时回退 30', () => {
    expect(frameDuration(25)).toBeCloseTo(1 / 25, 9);
    expect(frameDuration(60)).toBeCloseTo(1 / 60, 9);
    expect(frameDuration(undefined)).toBe(1 / 30);
    expect(frameDuration(0)).toBe(1 / 30);
    expect(frameDuration(NaN)).toBe(1 / 30);
    expect(frameDuration(-24)).toBe(1 / 30);
  });
  it('HH:MM:SS:FF 基本格式', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(30.1, 30)).toBe('00:00:30:03');
    expect(formatTimecode(65.5, 30)).toBe('00:01:05:15');
    expect(formatTimecode(3600, 30)).toBe('01:00:00:00');
    expect(formatTimecode(-3, 30)).toBe('00:00:00:00');
  });
  it('fps 25 / 60 边界：帧号不超过 fps-1', () => {
    expect(formatTimecode(59.999, 25)).toBe('00:00:59:24');
    expect(formatTimecode(1.04, 25)).toBe('00:00:01:01');
    expect(formatTimecode(0.5, 60)).toBe('00:00:00:30');
    expect(formatTimecode(0.9999, 60)).toBe('00:00:00:59');
    expect(formatTimecode(2.9999, 30)).toBe('00:00:02:29');
  });
  it('fps 缺省按 30', () => {
    expect(formatTimecode(30.1)).toBe('00:00:30:03');
    expect(formatTimecode(30.1, 0)).toBe('00:00:30:03');
  });
});

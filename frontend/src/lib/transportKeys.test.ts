import { describe, expect, it } from 'vitest';
import { adjacentCutPoint, cutPoints, MAX_PPS, MIN_PPS, nextShuttleRate, splitTarget, stepZoom } from './transportKeys';

describe('cutPoints / adjacentCutPoint', () => {
  it('包含 0、片尾、删除区间两端与额外点，排序去重并丢掉越界值', () => {
    expect(cutPoints(10, [[2, 3], [3, 5]], [4, 12, NaN, 0])).toEqual([0, 2, 3, 4, 5, 10]);
  });
  it('跳到严格相邻的剪辑点', () => {
    const pts = [0, 2, 5, 10];
    expect(adjacentCutPoint(pts, 2, 1)).toBe(5);
    expect(adjacentCutPoint(pts, 2.0000001, -1)).toBe(0);
    expect(adjacentCutPoint(pts, 3, -1)).toBe(2);
    expect(adjacentCutPoint(pts, 10, 1)).toBeNull();
    expect(adjacentCutPoint(pts, 0, -1)).toBeNull();
  });
});

describe('nextShuttleRate', () => {
  it('L 从停 / 倒放开始为 1 倍，正放中逐档加速并封顶', () => {
    expect(nextShuttleRate(0, 'L')).toBe(1);
    expect(nextShuttleRate(-2, 'L')).toBe(1);
    expect(nextShuttleRate(1, 'L')).toBe(2);
    expect(nextShuttleRate(2, 'L')).toBe(4);
    expect(nextShuttleRate(4, 'L')).toBe(4);
  });
  it('J 倒放逐档加速并封顶，K 停', () => {
    expect(nextShuttleRate(0, 'J')).toBe(-1);
    expect(nextShuttleRate(2, 'J')).toBe(-1);
    expect(nextShuttleRate(-1, 'J')).toBe(-2);
    expect(nextShuttleRate(-2, 'J')).toBe(-2);
    expect(nextShuttleRate(4, 'K')).toBe(0);
  });
});

describe('stepZoom', () => {
  it('按 1.5 倍放大缩小并夹在上下限', () => {
    expect(stepZoom(100, 1)).toBe(150);
    expect(stepZoom(150, -1)).toBeCloseTo(100);
    expect(stepZoom(MAX_PPS - 1, 1)).toBe(MAX_PPS);
    expect(stepZoom(MIN_PPS + 1, -1)).toBe(MIN_PPS);
  });
});

describe('splitTarget (⌘B, HIG-85)', () => {
  const base = { selection: [] as string[], step: 'trim', selectedTrackId: null as string | null, sourceTrackId: '__source__', selectedLayerId: null as string | null, layerStep: false };
  it('选了视频片段拆所选视频，选了主轨片段或剪辑模块空选分割主轨', () => {
    expect(splitTarget({ ...base, selection: ['vclip:a', 'layer:b'] })).toBe('videos');
    expect(splitTarget({ ...base, selection: ['clip:a'], step: 'text', layerStep: true, selectedLayerId: 'x' })).toBe('videos');
    expect(splitTarget({ ...base, selection: ['seg:0.000~2.000'], step: 'text' })).toBe('main');
    expect(splitTarget(base)).toBe('main');
    expect(splitTarget({ ...base, selection: ['layer:x'] })).toBeNull();
  });
  it('其余沿用音频 / 图层模块原来的拆分', () => {
    expect(splitTarget({ ...base, step: 'audio', selectedTrackId: 't1', selection: ['track:t1'] })).toBe('track');
    expect(splitTarget({ ...base, step: 'audio', selectedTrackId: '__source__' })).toBeNull();
    expect(splitTarget({ ...base, step: 'text', layerStep: true, selectedLayerId: 'l1', selection: ['layer:l1'] })).toBe('layer');
    expect(splitTarget({ ...base, step: 'text', layerStep: true })).toBeNull();
  });
});

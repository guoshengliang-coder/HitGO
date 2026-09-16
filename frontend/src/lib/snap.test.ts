import { describe, expect, it } from 'vitest';
import { canvasGuides, snapActive, snapValue } from './snap';
import type { SafeZone } from '../types';

describe('snapValue', () => {
  it('阈值内吸附到最近候选', () => {
    expect(snapValue(4.9, [0, 5, 10], 0.2)).toEqual({ value: 5, hit: 5 });
    expect(snapValue(7.6, [0, 5, 10], 3)).toEqual({ value: 10, hit: 10 });
  });
  it('阈值外不吸附', () => {
    expect(snapValue(4.5, [0, 5, 10], 0.2)).toEqual({ value: 4.5, hit: null });
  });
  it('候选为空 / 非法值时原样返回', () => {
    expect(snapValue(3, [], 1)).toEqual({ value: 3, hit: null });
    expect(snapValue(3, [NaN, Infinity], 1)).toEqual({ value: 3, hit: null });
  });
  it('候选恰好等于阈值距离也算命中', () => {
    expect(snapValue(1, [2], 1).hit).toBe(2);
  });
});

describe('canvasGuides', () => {
  const zone: SafeZone = {
    key: 'z',
    name: 'z',
    aspect: '9:16',
    zones: [{ label: 'a', x: 0.1, y: 0.2, w: 0.5, h: 0.3 }],
  };
  it('包含画布边缘、中线与安全区四边', () => {
    const g = canvasGuides(zone, 100, 200);
    expect(g.xs).toEqual([0, 10, 50, 60, 100]);
    expect(g.ys).toEqual([0, 40, 100, 200]);
  });
  it('没有安全区时只有边缘与中线', () => {
    expect(canvasGuides(undefined, 100, 200)).toEqual({ xs: [0, 50, 100], ys: [0, 100, 200] });
  });
  it('inner / outer 矩形也加入', () => {
    const g = canvasGuides({ ...zone, zones: [], inner: { label: '', x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, outer: null }, 100, 200);
    expect(g.xs).toEqual([0, 5, 50, 95, 100]);
    expect(g.ys).toEqual([0, 10, 100, 190, 200]);
  });
});

describe('snapActive', () => {
  it('开关与临时键取异或', () => {
    expect(snapActive(true, false)).toBe(true);
    expect(snapActive(true, true)).toBe(false);
    expect(snapActive(false, false)).toBe(false);
    expect(snapActive(false, true)).toBe(true);
  });
});

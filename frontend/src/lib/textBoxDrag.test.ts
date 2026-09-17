import { describe, expect, it } from 'vitest';
import { boxHeightFromStage, edgeOfAnchor, keepOppositeEdge, wrapWidthFromStage } from './textBoxDrag';

describe('wrapWidthFromStage', () => {
  it('舞台宽 ÷ ratio 扣掉两侧 pad，再按 1080 换算', () => {
    // 舞台 0.25 px / PNG px：270 舞台 px = 1080 PNG px，扣 2×20 = 1040 → 0.963
    expect(wrapWidthFromStage(270, 0.25, 20)).toBe(0.963);
  });
  it('可以拖得比画布宽（HIG-37）：540 舞台 px = 2160 PNG px → 2 倍画布宽', () => {
    expect(wrapWidthFromStage(540, 0.25, 0)).toBe(2);
  });
  it('夹在合法范围里（只防 0 宽和超过 3 倍画布宽）', () => {
    expect(wrapWidthFromStage(1, 0.25, 0)).toBe(0.005);
    expect(wrapWidthFromStage(1000, 0.25, 0)).toBe(3);
  });
});

describe('boxHeightFromStage', () => {
  it('不比文字高时贴合文字（null）', () => {
    expect(boxHeightFromStage(50, 0.25, 0, 200)).toBeNull();
    expect(boxHeightFromStage(50.1, 0.25, 0, 200)).toBeNull();
  });
  it('比文字高时按 1920 换算，扣掉 pad', () => {
    // 120 / 0.25 = 480，扣 2×0 → 480 / 1920 = 0.25
    expect(boxHeightFromStage(120, 0.25, 0, 200)).toBe(0.25);
    expect(boxHeightFromStage(125, 0.25, 10, 200)).toBe(0.25);
  });
  it('不超过画布高', () => {
    expect(boxHeightFromStage(10000, 0.25, 0, 200)).toBe(1);
  });
});

describe('keepOppositeEdge', () => {
  it('拖右边、实际比拖到的窄：中心往左挪一半差值，左边不动', () => {
    expect(keepOppositeEdge({ x: 100, y: 50 }, 0, 'x', 1, 80, 60)).toEqual({ x: 90, y: 50 });
  });
  it('拖上边、实际比拖到的高（框不小于文字）：中心往上挪，下边不动', () => {
    expect(keepOppositeEdge({ x: 100, y: 50 }, 0, 'y', -1, 20, 40)).toEqual({ x: 100, y: 40 });
  });
  it('考虑旋转：转 90° 时沿 y 轴拖的差值落到 x 上', () => {
    const c = keepOppositeEdge({ x: 0, y: 0 }, 90, 'y', 1, 0, 20);
    expect(c.x).toBeCloseTo(-10);
    expect(c.y).toBeCloseTo(0);
  });
});

describe('edgeOfAnchor', () => {
  it('四条边对应轴和方向，角和空值不是边', () => {
    expect(edgeOfAnchor('middle-left')).toEqual({ axis: 'x', side: -1 });
    expect(edgeOfAnchor('middle-right')).toEqual({ axis: 'x', side: 1 });
    expect(edgeOfAnchor('top-center')).toEqual({ axis: 'y', side: -1 });
    expect(edgeOfAnchor('bottom-center')).toEqual({ axis: 'y', side: 1 });
    expect(edgeOfAnchor('top-left')).toBeNull();
    expect(edgeOfAnchor(null)).toBeNull();
  });
});

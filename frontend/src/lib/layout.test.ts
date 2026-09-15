import { describe, expect, it } from 'vitest';
import { alignPlacement, anchorParts, boxOverlapsRect, makeAnchor, marginFromBox, nudgePlacement, placeLayer, reanchor, round4 } from './layout';
import { ANCHORS } from '../types';

const c = { W: 1080, H: 1920 };

describe('placeLayer（契约公式）', () => {
  it('top-left', () => {
    const box = placeLayer({ anchor: 'top-left', margin: [0.08, 0.12], width: 0.35 }, 600 / 240, c);
    expect(box.x).toBeCloseTo(0.08 * 1080);
    expect(box.y).toBeCloseTo(0.12 * 1920);
    expect(box.w).toBeCloseTo(0.35 * 1080);
    expect(box.h).toBeCloseTo((0.35 * 1080) / (600 / 240));
  });
  it('top-center', () => {
    const box = placeLayer({ anchor: 'top-center', margin: [0, 0.06], width: 0.5 }, 540 / 130, c);
    expect(box.x).toBeCloseTo((1080 - 540) / 2);
    expect(box.y).toBeCloseTo(0.06 * 1920);
  });
  it('bottom-right', () => {
    const box = placeLayer({ anchor: 'bottom-right', margin: [0.1, 0.1], width: 0.2 }, 1, c);
    expect(box.x).toBeCloseTo(1080 - 216 - 108);
    expect(box.y).toBeCloseTo(1920 - 216 - 192);
  });
  it('center 带偏移', () => {
    const box = placeLayer({ anchor: 'center', margin: [0.1, -0.1], width: 0.2 }, 1, c);
    expect(box.x).toBeCloseTo((1080 - 216) / 2 + 108);
    expect(box.y).toBeCloseTo((1920 - 216) / 2 - 192);
  });
});

describe('marginFromBox 反推', () => {
  it('对所有锚点往返一致', () => {
    for (const anchor of ANCHORS) {
      const p = { anchor, margin: [0.07, -0.03] as [number, number], width: 0.3 };
      const box = placeLayer(p, 1.5, c);
      const m = marginFromBox(box, anchor, c);
      expect(m[0]).toBeCloseTo(0.07, 6);
      expect(m[1]).toBeCloseTo(-0.03, 6);
    }
  });
  it('reanchor 保持视觉位置', () => {
    const p = { anchor: 'top-left' as const, margin: [0.08, 0.12] as [number, number], width: 0.35 };
    const before = placeLayer(p, 2, c);
    const p2 = reanchor(p, 2, c, 'bottom-right');
    const after = placeLayer(p2, 2, c);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(p2.anchor).toBe('bottom-right');
  });
});

describe('nudgePlacement（方向键微移）', () => {
  it('对所有锚点：平移 dx/dy 像素后像素框精确移动，且 round4 往返误差 < 0.5px', () => {
    for (const anchor of ANCHORS) {
      const p = { anchor, margin: [0.07, -0.03] as [number, number], width: 0.3 };
      const before = placeLayer(p, 1.5, c);
      const m = nudgePlacement(p, 1.5, c, 10, -1);
      const after = placeLayer({ ...p, margin: m }, 1.5, c);
      expect(after.x - before.x).toBeCloseTo(10, 6);
      expect(after.y - before.y).toBeCloseTo(-1, 6);
      // 存储时四舍五入到 4 位小数：1080×1920 参考画布上误差不超过 0.1px
      const rounded = placeLayer({ ...p, margin: [round4(m[0]), round4(m[1])] }, 1.5, c);
      expect(Math.abs(rounded.x - after.x)).toBeLessThan(0.1);
      expect(Math.abs(rounded.y - after.y)).toBeLessThan(0.1);
    }
  });
  it('右 / 下锚点方向相反：向右移动使 margin.x 变小', () => {
    const p = { anchor: 'bottom-right' as const, margin: [0.1, 0.1] as [number, number], width: 0.2 };
    const m = nudgePlacement(p, 1, c, 108, 192);
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(0, 6);
  });
});

describe('anchor helpers', () => {
  it('拆分与合成', () => {
    expect(anchorParts('center')).toEqual({ ax: 'center', ay: 'center' });
    expect(anchorParts('bottom-left')).toEqual({ ax: 'left', ay: 'bottom' });
    expect(makeAnchor('center', 'center')).toBe('center');
    expect(makeAnchor('right', 'top')).toBe('top-right');
  });
});

describe('boxOverlapsRect', () => {
  it('安全区重叠判定', () => {
    const box = { x: 0, y: 0, w: 200, h: 100 };
    expect(boxOverlapsRect(box, c, { x: 0, y: 0, w: 1, h: 0.08 })).toBe(true);
    expect(boxOverlapsRect(box, c, { x: 0, y: 0.78, w: 1, h: 0.22 })).toBe(false);
  });
});

describe('alignPlacement（六向对齐）', () => {
  const p = { anchor: 'top-left' as const, margin: [0.1, 0.2] as [number, number], width: 0.3 };
  it('贴左：水平 margin 归零，垂直保持视觉位置', () => {
    const r = alignPlacement(p, 1, c, 'left');
    expect(r.anchor).toBe('top-left');
    expect(r.margin).toEqual([0, 0.2]);
  });
  it('贴右：anchor 换到右列且 margin.x = 0，y 不变', () => {
    const r = alignPlacement(p, 1, c, 'right');
    expect(r.anchor).toBe('top-right');
    expect(r.margin).toEqual([0, 0.2]);
    expect(placeLayer(r, 1, c).x).toBeCloseTo(1080 - 0.3 * 1080);
  });
  it('水平居中后再贴底：变成 bottom-center，两轴都归零', () => {
    const r1 = alignPlacement(p, 1, c, 'center-h');
    expect(r1.anchor).toBe('top-center');
    expect(placeLayer(r1, 1, c).x).toBeCloseTo((1080 - 324) / 2);
    const r2 = alignPlacement(r1, 1, c, 'bottom');
    expect(r2.anchor).toBe('bottom-center');
    expect(r2.margin).toEqual([0, 0]);
  });
  it('垂直居中保留水平视觉位置（center 锚点带偏移）', () => {
    const q = { anchor: 'center' as const, margin: [0.1, 0.3] as [number, number], width: 0.2 };
    const r = alignPlacement(q, 1, c, 'center-v');
    expect(r.anchor).toBe('center');
    expect(r.margin).toEqual([0.1, 0]);
  });
  for (const a of ANCHORS) {
    it(`任意锚点 ${a} 贴上后 y = 0`, () => {
      const r = alignPlacement({ anchor: a, margin: [0.05, 0.05], width: 0.25 }, 2, c, 'top');
      expect(placeLayer(r, 2, c).y).toBeCloseTo(0);
    });
  }
});

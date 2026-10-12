import { describe, expect, it } from 'vitest';
import { FIT_VIEW, wheelPreview, zoomPreview } from './previewView';

describe('preview view (HIG-110)', () => {
  it('keeps the point under the mouse stationary, including after panning', () => {
    const view = { scale: 1.5, x: 25, y: -40 };
    const anchor = { x: 85, y: 110 };
    const local = { x: (anchor.x - view.x) / view.scale, y: (anchor.y - view.y) / view.scale };
    const next = zoomPreview(view, 3, anchor);
    expect(local.x * next.scale + next.x).toBeCloseTo(anchor.x);
    expect(local.y * next.scale + next.y).toBeCloseTo(anchor.y);
    expect(view).toEqual({ scale: 1.5, x: 25, y: -40 });
  });
  it('clamps to 25% and 400%, with no anchor drift when already at the limit', () => {
    const max = zoomPreview(FIT_VIEW, 99, { x: 10, y: 20 });
    expect(max.scale).toBe(4);
    expect(zoomPreview(max, 5, { x: 200, y: 30 })).toBe(max);
    expect(zoomPreview(FIT_VIEW, 0.01, { x: 0, y: 0 }).scale).toBe(0.25);
    expect(zoomPreview(FIT_VIEW, NaN, { x: 0, y: 0 })).toBe(FIT_VIEW);
  });
  it('wheel up enlarges and wheel down shrinks; handles pixels, lines and pages', () => {
    expect(wheelPreview(FIT_VIEW, -60, 0, 600, { x: 0, y: 0 }).scale).toBeGreaterThan(1);
    expect(wheelPreview(FIT_VIEW, 60, 0, 600, { x: 0, y: 0 }).scale).toBeLessThan(1);
    expect(wheelPreview(FIT_VIEW, 3, 1, 600, { x: 0, y: 0 })).toEqual(wheelPreview(FIT_VIEW, 48, 0, 600, { x: 0, y: 0 }));
    expect(wheelPreview(FIT_VIEW, 1, 2, 60, { x: 0, y: 0 })).toEqual(wheelPreview(FIT_VIEW, 60, 0, 600, { x: 0, y: 0 }));
    expect(wheelPreview(FIT_VIEW, 0, 0, 600, { x: 5, y: 5 })).toBe(FIT_VIEW);
  });
});

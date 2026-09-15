import { describe, expect, it } from 'vitest';
import { containBox, coverBox, cropCoverBox, variantFrameBox, type Box } from './videoBox';
import { defaultCropRect } from './crop';

const ratio = (b: Box) => b.w / b.h;
const covers = (b: Box, W: number, H: number) => b.x <= 1e-9 && b.y <= 1e-9 && b.x + b.w >= W - 1e-9 && b.y + b.h >= H - 1e-9;
const inside = (b: Box, W: number, H: number) => b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= W + 1e-9 && b.y + b.h <= H + 1e-9;
const touchesEdge = (b: Box, W: number, H: number) => Math.abs(b.w - W) < 1e-6 || Math.abs(b.h - H) < 1e-6;

describe('containBox', () => {
  it('源比画幅宽时贴左右、上下留白', () => {
    const b = containBox(1920, 1080, 1080, 1920);
    expect(b.w).toBeCloseTo(1080);
    expect(b.h).toBeCloseTo(607.5);
    expect(b.x).toBeCloseTo(0);
    expect(b.y).toBeCloseTo((1920 - 607.5) / 2);
  });

  it('源比画幅窄时贴上下、左右留白', () => {
    const b = containBox(1080, 1920, 1920, 1080);
    expect(b.h).toBeCloseTo(1080);
    expect(b.w).toBeCloseTo(607.5);
  });

  it.each([
    [1920, 1080, 1080, 1920],
    [1080, 1920, 1920, 1080],
    [1080, 1080, 1080, 1350],
    [1080, 1920, 1080, 1920],
  ])('保持源比例、完全落在画幅内且至少一边贴边 (%i×%i → %i×%i)', (sw, sh, W, H) => {
    const b = containBox(sw, sh, W, H);
    expect(ratio(b)).toBeCloseTo(sw / sh, 6);
    expect(inside(b, W, H)).toBe(true);
    expect(touchesEdge(b, W, H)).toBe(true);
  });
});

describe('coverBox', () => {
  it.each([
    [1920, 1080, 1080, 1920],
    [1080, 1920, 1920, 1080],
    [1080, 1080, 1080, 1350],
    [1080, 1920, 1080, 1920],
  ])('保持源比例且完全覆盖画幅 (%i×%i → %i×%i)', (sw, sh, W, H) => {
    const b = coverBox(sw, sh, W, H);
    expect(ratio(b)).toBeCloseTo(sw / sh, 6);
    expect(covers(b, W, H)).toBe(true);
  });

  it('尺寸相等时正好贴合', () => {
    const b = coverBox(1080, 1920, 1080, 1920);
    expect(b).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });

  it('zoom 放大后仍然居中且依旧覆盖', () => {
    const W = 1080;
    const H = 1920;
    const b = coverBox(1920, 1080, W, H, 1.05);
    const base = coverBox(1920, 1080, W, H);
    expect(b.w).toBeCloseTo(base.w * 1.05);
    expect(b.x + b.w / 2).toBeCloseTo(W / 2);
    expect(b.y + b.h / 2).toBeCloseTo(H / 2);
    expect(covers(b, W, H)).toBe(true);
  });
});

describe('cropCoverBox', () => {
  const sw = 1920;
  const sh = 1080;
  const W = 1080;
  const H = 1920;

  it('窗口居中时源矩形就是那块窗口，目标覆盖整个画幅', () => {
    const r = { x: 0.3418, y: 0, w: 0.3164, h: 1 };
    const fb = cropCoverBox(r, sw, sh, W, H);
    expect(fb.src).not.toBeNull();
    expect(fb.src!.x).toBeCloseTo(0.3418 * sw);
    expect(fb.src!.w).toBeCloseTo(0.3164 * sw);
    expect(fb.src!.h).toBeCloseTo(sh);
    expect(covers(fb.dst, W, H)).toBe(true);
  });

  it.each([
    ['贴左上', { x: 0, y: 0, w: 0.4, h: 0.8 }],
    ['贴右下', { x: 0.6, y: 0.2, w: 0.4, h: 0.8 }],
    ['全幅', { x: 0, y: 0, w: 1, h: 1 }],
  ])('%s 的窗口都保持窗口比例并覆盖画幅', (_label, r) => {
    const fb = cropCoverBox(r, sw, sh, W, H);
    expect(ratio(fb.dst)).toBeCloseTo((r.w * sw) / (r.h * sh), 6);
    expect(covers(fb.dst, W, H)).toBe(true);
  });

  it('没有窗口时退回整幅 cover', () => {
    expect(cropCoverBox(undefined, sw, sh, W, H)).toEqual({ src: null, dst: coverBox(sw, sh, W, H) });
  });

  // 契约承诺：缺省窗口 = worker 的 cover 居中裁切，所以「默认裁切」必须所见即所得 ——
  // 用缺省窗口画出来的结果必须正好贴合画幅，不多裁一个像素。
  it.each([
    [1920, 1080, 1080, 1920],
    [1080, 1920, 1080, 1080],
    [1920, 1080, 1920, 1080],
    [1080, 1920, 1080, 1350],
    [1080, 1080, 1920, 1080],
  ])('defaultCropRect 的结果贴合画幅 (源 %i×%i → 画幅 %i×%i)', (srcW, srcH, W, H) => {
    const fb = cropCoverBox(defaultCropRect(srcW, srcH, W / H), srcW, srcH, W, H);
    expect(fb.src).not.toBeNull();
    expect(fb.dst.w).toBeCloseTo(W, 1);
    expect(fb.dst.h).toBeCloseTo(H, 1);
    expect(covers(fb.dst, W, H)).toBe(true);
    // 且不带窗口的整幅 cover 同样覆盖画幅（两条路径都不会露底）
    expect(covers(coverBox(srcW, srcH, W, H), W, H)).toBe(true);
  });
});

describe('variantFrameBox', () => {
  it('crop 模式走裁切窗口', () => {
    const r = { x: 0.1, y: 0, w: 0.5, h: 1 };
    expect(variantFrameBox('crop', r, 1920, 1080, 1080, 1920)).toEqual(cropCoverBox(r, 1920, 1080, 1080, 1920));
  });

  it.each(['blur', 'color'] as const)('%s 模式前景是 contain 且忽略 crop', (fill) => {
    const fb = variantFrameBox(fill, { x: 0.1, y: 0, w: 0.5, h: 1 }, 1920, 1080, 1080, 1920);
    expect(fb.src).toBeNull();
    expect(fb.dst).toEqual(containBox(1920, 1080, 1080, 1920));
  });
});

describe('退化输入', () => {
  it.each([
    [0, 1080, 1080, 1920],
    [1920, 0, 1080, 1920],
    [1920, 1080, 0, 1920],
    [1920, 1080, 1080, 0],
    [-1920, 1080, 1080, 1920],
    [NaN, 1080, 1080, 1920],
  ])('不产生 NaN / Infinity (%f, %f, %f, %f)', (sw, sh, W, H) => {
    for (const b of [containBox(sw, sh, W, H), coverBox(sw, sh, W, H), cropCoverBox({ x: 0, y: 0, w: 1, h: 1 }, sw, sh, W, H).dst]) {
      for (const v of [b.x, b.y, b.w, b.h]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('窗口宽高为 0 时退回整幅 cover', () => {
    expect(cropCoverBox({ x: 0, y: 0, w: 0, h: 1 }, 1920, 1080, 1080, 1920).src).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { MIN_CROP, clampCropRect, cropRectFromPixels, cropRectToPixels, defaultCropRect, describeCrop, isDefaultCrop } from './crop';

const V = 1080 / 1920; // 9:16
const SQ = 1;

describe('defaultCropRect（= worker 的 cover 居中裁切）', () => {
  it('横屏源出 9:16：整高、居中的一条', () => {
    const r = defaultCropRect(1920, 1080, V);
    expect(r.h).toBe(1);
    expect(r.y).toBe(0);
    expect(r.w).toBeCloseTo(607.5 / 1920, 3);
    expect(r.x).toBeCloseTo((1 - 607.5 / 1920) / 2, 3);
  });
  it('竖屏源出 1:1：整宽、居中的一段', () => {
    const r = defaultCropRect(1080, 1920, SQ);
    expect(r.w).toBe(1);
    expect(r.x).toBe(0);
    expect(r.h).toBeCloseTo(1080 / 1920, 4);
    expect(r.y).toBeCloseTo((1 - 1080 / 1920) / 2, 4);
  });
  it('源比例与画幅一致：整幅', () => {
    expect(defaultCropRect(1080, 1920, V)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it('无效尺寸退化为整幅', () => {
    expect(defaultCropRect(0, 0, V)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('clampCropRect', () => {
  it('锁定画幅比：h 由 w 推出', () => {
    const r = clampCropRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.9 }, 1920, 1080, V);
    expect((r.w * 1920) / (r.h * 1080)).toBeCloseTo(V, 3);
    expect(r.w).toBeCloseTo(0.2, 4);
  });
  it('拖出右 / 下边界时平移回画面内', () => {
    const r = clampCropRect({ x: 0.9, y: 0.5, w: 0.3164, h: 1 }, 1920, 1080, V);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBe(0);
  });
  it('放得比源还大时缩到最大可放窗口（位置保持在画面内）', () => {
    const r = clampCropRect({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080, V);
    const d = defaultCropRect(1920, 1080, V);
    expect(r.w).toBeCloseTo(d.w, 4);
    expect(r.h).toBeCloseTo(d.h, 4);
    expect(r.x).toBe(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
  });
  it('不小于 MIN_CROP', () => {
    const r = clampCropRect({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 }, 1920, 1080, V);
    expect(r.w).toBeGreaterThanOrEqual(MIN_CROP - 1e-9);
    expect(r.h).toBeGreaterThanOrEqual(MIN_CROP - 1e-9);
  });
  it('缺省窗口经过 clamp 不变', () => {
    for (const [sw, sh, a] of [
      [1920, 1080, V],
      [1080, 1920, SQ],
      [1080, 1350, 16 / 9],
    ] as const) {
      const d = defaultCropRect(sw, sh, a);
      expect(clampCropRect(d, sw, sh, a)).toEqual(d);
    }
  });
  it('NaN 输入回落到缺省尺寸', () => {
    const r = clampCropRect({ x: NaN, y: NaN, w: NaN, h: NaN }, 1920, 1080, V);
    expect(r.w).toBeCloseTo(defaultCropRect(1920, 1080, V).w, 4);
    expect(r.x).toBe(0);
  });
});

describe('像素框往返', () => {
  it('cropRectToPixels / cropRectFromPixels 互逆', () => {
    const rect = { x: 0.3418, y: 0, w: 0.3164, h: 1 };
    const px = cropRectToPixels(rect, 640, 360);
    expect(px.x).toBeCloseTo(0.3418 * 640);
    const back = cropRectFromPixels(px, 640, 360);
    expect(back.x).toBeCloseTo(rect.x, 6);
    expect(back.w).toBeCloseTo(rect.w, 6);
    expect(back.h).toBeCloseTo(1, 6);
  });
  it('零尺寸舞台不产生 NaN', () => {
    expect(cropRectFromPixels({ x: 0, y: 0, w: 10, h: 10 }, 0, 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('isDefaultCrop / describeCrop', () => {
  it('undefined 与缺省窗口都算默认', () => {
    expect(isDefaultCrop(undefined, 1920, 1080, V)).toBe(true);
    expect(isDefaultCrop(defaultCropRect(1920, 1080, V), 1920, 1080, V)).toBe(true);
    expect(isDefaultCrop({ x: 0, y: 0, w: 0.3164, h: 1 }, 1920, 1080, V)).toBe(false);
  });
  it('describeCrop 给出源像素尺寸与左上角', () => {
    expect(describeCrop({ x: 0.3418, y: 0, w: 0.3164, h: 1 }, 1920, 1080)).toBe('607×1080 @ 656,0');
  });
});

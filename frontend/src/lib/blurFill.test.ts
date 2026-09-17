import { describe, expect, it } from 'vitest';
import { bgBrightnessOf, blurFillFilter, blurOf, blurRadius, isDefaultBlurFill } from './blurFill';

describe('blurRadius（与后端 filtergraph.blur_background_radius 一致）', () => {
  it('按短边比例换算', () => {
    expect(blurRadius(1080, 1920, 60)).toBe(52);
    expect(blurRadius(1920, 1080, 100)).toBe(86);
    expect(blurRadius(1080, 1080, 23)).toBe(20);
    expect(blurRadius(1080, 1920, 0)).toBe(0);
  });
  it('越界与小画布夹紧', () => {
    expect(blurRadius(1080, 1920, 250)).toBe(86);
    expect(blurRadius(100, 100, 100)).toBe(8);
    expect(blurRadius(8, 8, 100)).toBe(1);
    expect(blurRadius(4, 4, 100)).toBe(0);
    expect(blurRadius(0, 0, 60)).toBe(0);
  });
});

describe('缺省值', () => {
  it('缺字段 / 非法值回落到缺省，越界夹紧', () => {
    expect(blurOf({})).toBe(60);
    expect(bgBrightnessOf({})).toBe(50);
    expect(blurOf({ blur: Number.NaN })).toBe(60);
    expect(blurOf({ blur: 120 })).toBe(100);
    expect(bgBrightnessOf({ bg_brightness: 5 })).toBe(20);
  });
  it('isDefaultBlurFill', () => {
    expect(isDefaultBlurFill({})).toBe(true);
    expect(isDefaultBlurFill({ blur: 60, bg_brightness: 50 })).toBe(true);
    expect(isDefaultBlurFill({ blur: 80 })).toBe(false);
    expect(isDefaultBlurFill({ bg_brightness: 100 })).toBe(false);
  });
});

describe('blurFillFilter', () => {
  it('按绘制宽度缩放模糊，并带亮度', () => {
    // 半径 52 → σ 41.6px @1080 宽；画在 270 宽的画布上 = 10.4px
    expect(blurFillFilter({}, 1080, 1920, 270)).toBe('blur(10.4px) brightness(0.5)');
    expect(blurFillFilter({ blur: 60, bg_brightness: 100 }, 1080, 1920, 1080)).toBe('blur(41.6px)');
  });
  it('全关时返回 none', () => {
    expect(blurFillFilter({ blur: 0, bg_brightness: 100 }, 1920, 1080, 960)).toBe('none');
  });
});

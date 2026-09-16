import { describe, expect, it } from 'vitest';
import { alphaToPercent, formatHex, hsvToRgb, normalizeHex, opaqueHex, parseHex, percentToAlpha, rgbToHsv } from './color';

describe('color', () => {
  it('解析 3/6/8 位 hex，非法返回 null', () => {
    expect(parseHex('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseHex('00ff00')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseHex('#0000FF80')?.a).toBeCloseTo(128 / 255);
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('')).toBeNull();
    expect(parseHex(null)).toBeNull();
  });
  it('格式化为大写，alpha=1 省略 AA，withAlpha=false 总是 6 位', () => {
    expect(formatHex({ r: 240, g: 207, b: 20, a: 1 })).toBe('#F0CF14');
    expect(formatHex({ r: 0, g: 0, b: 0, a: 0.6 })).toBe('#00000099');
    expect(formatHex({ r: 0, g: 0, b: 0, a: 0 })).toBe('#00000000');
    expect(formatHex({ r: 0, g: 0, b: 0, a: 0.6 }, false)).toBe('#000000');
  });
  it('normalize / opaque', () => {
    expect(normalizeHex('#abcdefff')).toBe('#ABCDEF');
    expect(normalizeHex('#ffffff00')).toBe('#FFFFFF00');
    expect(normalizeHex('xyz', '#111111')).toBe('#111111');
    expect(opaqueHex('#FFD84DCC')).toBe('#FFD84D');
  });
  it('RGB ↔ HSV 往返', () => {
    for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#F0CF14', '#808080', '#000000', '#FFFFFF', '#E3312B']) {
      const c = parseHex(hex)!;
      expect(formatHex({ ...hsvToRgb(rgbToHsv(c)), a: 1 })).toBe(hex);
    }
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
  });
  it('透明度百分比互转并裁剪', () => {
    expect(alphaToPercent(0.6)).toBe(60);
    expect(alphaToPercent(2)).toBe(100);
    expect(percentToAlpha(150)).toBe(1);
    expect(percentToAlpha(-5)).toBe(0);
    expect(percentToAlpha(NaN)).toBe(1);
  });
});

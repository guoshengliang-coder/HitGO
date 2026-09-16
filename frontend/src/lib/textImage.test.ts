import { describe, expect, it } from 'vitest';
import { bakedWidth } from './textImage';

describe('bakedWidth', () => {
  it('短文字按 PNG 像素宽换算', () => {
    expect(bakedWidth(540, 1080)).toBe(0.5);
  });
  it('比画布还宽的长字幕收到 1（契约 width ≤ 1，否则保存 400）', () => {
    expect(bakedWidth(1300, 1080)).toBe(1);
  });
  it('非法输入回退 1', () => {
    expect(bakedWidth(0, 1080)).toBe(1);
    expect(bakedWidth(NaN, 1080)).toBe(1);
  });
});

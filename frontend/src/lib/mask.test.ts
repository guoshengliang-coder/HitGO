import { describe, expect, it } from 'vitest';
import { maskBlurLevel, maskBlurPx, maskLabel, newMaskLayer, timedTextSpan } from './mask';
import type { Layer } from '../types';

const base = { anchor: 'center', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1 } as const;
const text = (id: string, t: [number, number] | 'all'): Layer => ({ ...base, margin: [0, 0], id, type: 'text', text: id, style: {} as never, t });
const sticker = (id: string, t: [number, number] | 'all'): Layer => ({ ...base, margin: [0, 0], id, type: 'sticker', asset_id: 'a', t });

describe('newMaskLayer', () => {
  it('贴底通栏、高 12%、模糊中档、全程；id 来自传入的生成器', () => {
    let n = 0;
    const l = newMaskLayer(() => `m_${++n}`);
    expect(l).toEqual({
      id: 'm_1', type: 'mask', mode: 'blur', blur: 2, color: '#000000',
      anchor: 'bottom-center', margin: [0, 0.1], width: 1, height: 0.12, rotate: 0, opacity: 1, t: 'all', name: '遮盖',
    });
    expect(newMaskLayer(() => `m_${++n}`).id).toBe('m_2');
  });
});

describe('maskBlurPx', () => {
  it('按舞台宽度缩放 boxblur 半径，档位越高越糊；宽度非法时为 0', () => {
    expect(maskBlurPx(2, 1080)).toBe(16);
    expect(maskBlurPx(1, 1080)).toBe(8);
    expect(maskBlurPx(3, 1080)).toBe(32);
    expect(maskBlurPx(2, 270)).toBe(4);
    expect(maskBlurPx(undefined, 540)).toBe(8); // 缺省中档
    expect(maskBlurPx(2, 0)).toBe(0);
  });
  it('再小的舞台也至少 1px', () => {
    expect(maskBlurPx(1, 20)).toBe(1);
  });
});

describe('timedTextSpan', () => {
  it('取所有带时段文字图层的首尾，忽略全程文字与贴纸', () => {
    expect(timedTextSpan([text('a', [2, 4]), text('b', [1, 3]), text('c', 'all'), sticker('s', [0, 9])])).toEqual([1, 4]);
  });
  it('没有带时段的文字图层时为 null', () => {
    expect(timedTextSpan([])).toBeNull();
    expect(timedTextSpan([text('c', 'all'), sticker('s', [0, 9])])).toBeNull();
  });
});

describe('maskLabel / maskBlurLevel', () => {
  it('模糊带档位，色块带颜色；非法档位回到中', () => {
    expect(maskLabel({ mode: 'blur', blur: 3 })).toBe('模糊 · 强');
    expect(maskLabel({ mode: 'blur' })).toBe('模糊 · 中');
    expect(maskLabel({ mode: 'solid', color: '#a1b2c3' })).toBe('色块 #A1B2C3');
    expect(maskLabel({ mode: 'solid' })).toBe('色块 #000000');
    expect(maskBlurLevel({ blur: 7 as never })).toBe(2);
  });
});

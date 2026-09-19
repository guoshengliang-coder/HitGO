import { describe, expect, it } from 'vitest';
import { defaultTextStyle, type TextLayer } from '../types';
import { mergeSubtitles, nextSubtitle } from './subtitleMerge';

const first: TextLayer = { id: 'a', type: 'text', origin: 'subtitle', text: '第一句', style: defaultTextStyle(), anchor: 'center', margin: [0, 0], width: 0.5, rotate: 0, opacity: 1, t: [1, 3] };
const next: TextLayer = { ...first, id: 'b', text: '第二句', t: [3, 5], spans: [{ start: 0, end: 2, color: '#ff0000' }] };

describe('字幕合并', () => {
  it('按时间找同来源同语言下一句，不受图层层级顺序影响', () => {
    expect(nextSubtitle([next, { ...next, id: 'foreign', lang: 'en', t: [2, 4] }, first], first)).toBe(next);
  });
  it('保留第一句样式、扩展时段、平移局部上色并清除旧烤图', () => {
    const merged = mergeSubtitles({ ...first, image_url: '/old.png', variant_images: {}, glyph_layout: {} as never }, next)!;
    expect(merged.text).toBe('第一句\n第二句');
    expect(merged.t).toEqual([1, 5]);
    expect(merged.style).toEqual(first.style);
    expect(merged.spans).toEqual([{ start: 4, end: 6, color: '#ff0000' }]);
    expect(merged.image_url).toBeUndefined();
    expect(merged.glyph_layout).toBeUndefined();
    expect(first.t).toEqual([1, 3]);
  });
  it('拒绝锁定、重叠、全程、跨语言以及显示状态不同的字幕', () => {
    for (const patch of [{ locked: true }, { t: [2, 5] }, { t: 'all' }, { lang: 'en' }, { hidden: true }]) {
      expect(mergeSubtitles(first, { ...next, ...patch } as TextLayer)).toBeNull();
    }
  });
});

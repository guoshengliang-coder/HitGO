import { describe, expect, it } from 'vitest';
import { canSplitLayer, MIN_SPLIT, splitLayerAt, splitLayerBlockedReason } from './layerSplit';
import { DEFAULT_SCROLL } from './poster';
import type { Layer, TextLayer, TimeWindow } from '../types';

const base = { anchor: 'center' as const, margin: [0, 0] as [number, number], width: 0.5, rotate: 0, opacity: 1 };
const text = (t: TimeWindow, over: Partial<TextLayer> = {}): TextLayer => ({ ...base, id: 'l_1', type: 'text', text: '字', style: { color: '#fff' } as never, t, ...over });
const sticker = (t: TimeWindow): Layer => ({ ...base, id: 'l_s', type: 'sticker', asset_id: 'a_1', t });
const mask = (t: TimeWindow): Layer => ({ ...base, id: 'l_m', type: 'mask', mode: 'blur', height: 0.12, t });

describe('splitLayerAt', () => {
  it('把时段切成首尾相接的两段，后一条换新 id，其余字段照搬', () => {
    const [l, r] = splitLayerAt(text([2, 10]), 6, 20, 'l_new')!;
    expect(l.t).toEqual([2, 6]);
    expect(r.t).toEqual([6, 10]);
    expect(l.id).toBe('l_1');
    expect(r.id).toBe('l_new');
    expect((r as TextLayer).text).toBe('字');
    expect(r.width).toBe(0.5);
  });

  it("t = 'all' 先展开成 [0, 成片时长] 再拆", () => {
    const [l, r] = splitLayerAt(text('all'), 7.5, 20, 'l_new')!;
    expect(l.t).toEqual([0, 7.5]);
    expect(r.t).toEqual([7.5, 20]);
  });

  it('贴纸和遮盖同样能拆', () => {
    expect(splitLayerAt(sticker([0, 5]), 2, 20, 'x')![1].t).toEqual([2, 5]);
    expect(splitLayerAt(mask([0, 5]), 2, 20, 'x')![1].t).toEqual([2, 5]);
  });

  it('播放头离两端不足 0.1 秒时不拆', () => {
    expect(splitLayerAt(text([2, 10]), 2.05, 20, 'x')).toBeNull();
    expect(splitLayerAt(text([2, 10]), 9.95, 20, 'x')).toBeNull();
    expect(splitLayerAt(text([2, 10]), 1, 20, 'x')).toBeNull(); // 时段外
    expect(splitLayerAt(text([2, 10]), 2 + MIN_SPLIT, 20, 'x')).not.toBeNull(); // 正好够
  });

  it('大字报（有 scroll）不拆', () => {
    const poster = text('all', { scroll: { ...DEFAULT_SCROLL } });
    expect(canSplitLayer(poster)).toBe(false);
    expect(splitLayerAt(poster, 5, 20, 'x')).toBeNull();
  });

  it('入场归左、出场归右、循环两段都留', () => {
    const anim = { in: { preset: 'fade', duration: 0.5 }, out: { preset: 'fade', duration: 0.4 }, loop: { preset: 'breathe', period: 1.2 } } as never;
    const [l, r] = splitLayerAt(text([0, 8], { animation: anim }), 4, 20, 'x')! as [TextLayer, TextLayer];
    expect(l.animation?.in).toBeTruthy();
    expect(l.animation?.out).toBeUndefined();
    expect(r.animation?.in).toBeUndefined();
    expect(r.animation?.out).toBeTruthy();
    expect(l.animation?.loop).toBeTruthy();
    expect(r.animation?.loop).toBeTruthy();
  });

  it('只有入场时右段不留空动画对象；逐字显现与字位置只留左段', () => {
    const onlyIn = { in: { preset: 'pop', duration: 0.5 } } as never;
    const [, r1] = splitLayerAt(text([0, 8], { animation: onlyIn }), 4, 20, 'x')! as [TextLayer, TextLayer];
    expect(r1.animation).toBeUndefined();

    const reveal = { reveal: { preset: 'typewriter', duration: 1 } } as never;
    const glyph = { lines: [{ top: 0, bottom: 1, units: [[0, 1]] }] } as never;
    const [l2, r2] = splitLayerAt(text([0, 8], { animation: reveal, glyph_layout: glyph }), 4, 20, 'x')! as [TextLayer, TextLayer];
    expect(l2.animation?.reveal).toBeTruthy();
    expect(l2.glyph_layout).toBeTruthy();
    expect(r2.animation).toBeUndefined();
    expect(r2.glyph_layout).toBeUndefined();
  });

  it('样式和局部上色两段各一份，改一段不影响另一段', () => {
    const src = text([0, 8], { spans: [{ start: 0, end: 1, color: '#f00' }] });
    const [l, r] = splitLayerAt(src, 4, 20, 'x')! as [TextLayer, TextLayer];
    l.style.color = '#0f0';
    l.spans![0].color = '#00f';
    expect(r.style.color).toBe('#fff');
    expect(r.spans![0].color).toBe('#f00');
    expect(src.style.color).toBe('#fff');
  });
});

describe('splitLayerBlockedReason', () => {
  it('分别说明没选中、锁定、大字报、播放头不在时段内部', () => {
    expect(splitLayerBlockedReason(null, 5, 20)).toBe('先选中一个图层');
    expect(splitLayerBlockedReason({ ...text([0, 8]), locked: true }, 4, 20)).toBe('图层已锁定');
    expect(splitLayerBlockedReason(text('all', { scroll: { ...DEFAULT_SCROLL } }), 5, 20)).toBe('大字报的滚动文案不能拆分');
    expect(splitLayerBlockedReason(text([2, 10]), 1, 20)).toContain('播放头');
    expect(splitLayerBlockedReason(text([2, 10]), 6, 20)).toBeNull();
  });
});

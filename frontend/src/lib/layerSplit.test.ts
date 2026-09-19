import { describe, expect, it } from 'vitest';
import { canSplitLayer, isSubtitleTextLayer, MIN_SPLIT, splitLayerAt, splitLayerBlockedReason, splitTextLayerByText, textCutForSplit } from './layerSplit';
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

describe('拆分字幕时文字也跟着切（HIG-36）', () => {
  const cue = (over: Partial<TextLayer> = {}) =>
    text([0, 8], { text: '欢迎来到 HitGO，今天我们从改语言开始。', origin: 'localize', lang: 'zh', ...over });

  it('textAt 把文字分给两段，接缝的空白吃掉', () => {
    const at = '欢迎来到 HitGO，'.length;
    const [l, r] = splitLayerAt(cue(), 4, 20, 'l_new', { textAt: at })! as [TextLayer, TextLayer];
    expect(l.text).toBe('欢迎来到 HitGO，');
    expect(r.text).toBe('今天我们从改语言开始。');
    expect(l.t).toEqual([0, 4]);
    expect(r.t).toEqual([4, 8]);
  });

  it('spans 跟着切，右段下标归零', () => {
    const at = '欢迎来到 HitGO，'.length;
    const spans = [{ start: 0, end: 4, color: '#f00' }, { start: at + 2, end: at + 5, color: '#0f0' }];
    const [l, r] = splitLayerAt(cue({ spans }), 4, 20, 'l_new', { textAt: at })! as [TextLayer, TextLayer];
    expect(l.spans).toEqual([{ start: 0, end: 4, color: '#f00' }]);
    expect(r.spans).toEqual([{ start: 2, end: 5, color: '#0f0' }]);
  });

  it('烤好的 PNG 两段都作废——文字变了，导出时要重烤', () => {
    const baked = cue({ image_url: '/x.png', image_size: [10, 10], glyph_layout: { boxes: [] } as never });
    const [l, r] = splitLayerAt(baked, 4, 20, 'l_new', { textAt: 8 })! as [TextLayer, TextLayer];
    for (const part of [l, r]) {
      expect(part.image_url).toBeUndefined();
      expect(part.image_size).toBeUndefined();
      expect(part.glyph_layout).toBeUndefined();
    }
  });

  it('切点落在首尾、或切出空段时退回只切时段（两段同文）', () => {
    for (const at of [0, 3, 999]) {
      const [l, r] = splitLayerAt(cue({ text: ' 字 ' }), 4, 20, 'l_new', { textAt: at })! as [TextLayer, TextLayer];
      expect(l.text).toBe(r.text);
    }
  });

  it('不传 textAt 时行为和 HIG-36 之前完全一样', () => {
    const [l, r] = splitLayerAt(cue(), 4, 20, 'l_new')! as [TextLayer, TextLayer];
    expect(l.text).toBe(r.text);
  });
});

describe('isSubtitleTextLayer', () => {
  it('认得出译文字幕、导入字幕和「字幕 N」，普通文字和贴纸不算', () => {
    expect(isSubtitleTextLayer(text([0, 1], { origin: 'localize' }))).toBe(true);
    expect(isSubtitleTextLayer(text([0, 1], { origin: 'subtitle' }))).toBe(true);
    expect(isSubtitleTextLayer(text([0, 1], { name: '字幕 3' }))).toBe(true);
    expect(isSubtitleTextLayer(text([0, 1], { name: '印尼语字幕 3', origin: 'localize' }))).toBe(true);
    expect(isSubtitleTextLayer(text([0, 1], { name: '标题' }))).toBe(false);
    expect(isSubtitleTextLayer(sticker([0, 1]))).toBe(false);
    expect(isSubtitleTextLayer(null)).toBe(false);
  });
});

describe('splitTextLayerByText', () => {
  const long = '欢迎来到 HitGO，这是一个面向投放素材的视频后期工作台，今天我们从改语言开始讲起。';
  let n = 0;
  const newId = () => `l_n${(n += 1)}`;

  it('按标点拆成多条：时段首尾相接、合起来还是原文', () => {
    n = 0;
    const parts = splitTextLayerByText(text([2, 12], { text: long, origin: 'localize', lang: 'zh' }), 20, newId);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((l) => l.text).join('')).toBe(long);
    const ts = parts.map((l) => l.t as [number, number]);
    expect(ts[0][0]).toBe(2);
    expect(ts[ts.length - 1][1]).toBe(12);
    ts.forEach(([, end], k) => k + 1 < ts.length && expect(ts[k + 1][0]).toBe(end));
    expect(new Set(parts.map((l) => l.id)).size).toBe(parts.length);
  });

  it('文字够短、或大字报滚动文案，原样返回一条', () => {
    expect(splitTextLayerByText(text([0, 5], { text: '很短' }), 20, newId)).toHaveLength(1);
    expect(splitTextLayerByText(text([0, 5], { text: long, scroll: DEFAULT_SCROLL }), 20, newId)).toHaveLength(1);
  });

  it('时段短到放不下就少拆几刀，不会拆出点不中的碎片', () => {
    const parts = splitTextLayerByText(text([0, 0.25], { text: long, origin: 'localize', lang: 'zh' }), 20, newId);
    parts.forEach((l) => {
      const [a, b] = l.t as [number, number];
      expect(b - a).toBeGreaterThanOrEqual(MIN_SPLIT - 1e-6);
    });
  });
});

describe('textCutForSplit', () => {
  it('把播放头位置吸附到最近的标点', () => {
    const l = text([0, 10], { text: '今天天气很好。我们出去走走。', origin: 'localize', lang: 'zh' });
    expect(textCutForSplit(l, 5.5, 20)).toBe('今天天气很好。'.length);
  });

  it('不是字幕图层就不切文字', () => {
    expect(textCutForSplit(text([0, 10], { text: '今天天气很好。我们出去走走。', name: '标题' }), 5, 20)).toBeUndefined();
  });
});

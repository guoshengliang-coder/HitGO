import { describe, expect, it } from 'vitest';
import cases from './fixtures/scrollCases.json';
import {
  DEFAULT_SCROLL,
  DEFAULT_SCROLL_BOX,
  HIGHLIGHT_PALETTE,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  fitScrollSpeed,
  highlightSpans,
  layerPngHeight,
  newPosterLayer,
  posterDuration,
  resolveScroll,
  sampleScrollY,
  scrollDuration,
  scrollLayerDuration,
  scrollPath,
  scrollSummary,
  voiceTrack,
} from './poster';
import { defaultTextStyle, emptySpec, type Asset, type EditSpec, type TextLayer, type TextScroll } from '../types';

type Case = { name: string; scroll: TextScroll; png_h: number; u: number; expect: { y0: number; y1: number; duration: number; y: number } };

describe('scrollPath / sampleScrollY 对照后端 golden（HIG-50）', () => {
  for (const c of (cases as { cases: Case[] }).cases) {
    it(`${c.name} @ ${c.u}`, () => {
      const p = scrollPath(c.scroll, c.png_h);
      expect(p.y0).toBeCloseTo(c.expect.y0, 5);
      expect(p.y1).toBeCloseTo(c.expect.y1, 5);
      expect(scrollDuration(p)).toBeCloseTo(c.expect.duration, 5);
      expect(sampleScrollY(p, c.u)).toBeCloseTo(c.expect.y, 5);
    });
  }
});

const style = defaultTextStyle();
// 950×3000 的 PNG，宽 = 框宽 0.88 → 高 = 0.88 × 1080 × (3000 / 950) / 1920 ≈ 1.5632 画布高
const layer = (extra: Partial<TextLayer> = {}): TextLayer => ({
  ...newPosterLayer('l1', '第一段\n第二段', DEFAULT_SCROLL_BOX, style),
  image_url: '/media/uploads/p.png',
  image_size: [950, 3000],
  ...extra,
});
const PNG_H = (0.88 * 1080 * (3000 / 950)) / 1920;

describe('resolveScroll', () => {
  it('补齐缺省，非法速度回缺省', () => {
    expect(resolveScroll(undefined)).toEqual(DEFAULT_SCROLL);
    expect(resolveScroll(null)).toEqual(DEFAULT_SCROLL);
    expect(resolveScroll({ speed: 0, start: 'visible', hold_start: 2 })).toEqual({ ...DEFAULT_SCROLL, start: 'visible', hold_start: 2 });
  });
});

describe('layerPngHeight / scrollLayerDuration', () => {
  it('按 width 缩放，超过框宽时按框宽算；没有 PNG 时 null', () => {
    expect(layerPngHeight(layer())).toBeCloseTo(PNG_H, 6);
    expect(layerPngHeight(layer({ width: 0.5 }))).toBeCloseTo(PNG_H * (0.5 / 0.88), 6);
    expect(layerPngHeight(layer({ width: 1 }))).toBeCloseTo(PNG_H, 6);
    expect(layerPngHeight(layer({ image_size: null }))).toBeNull();
    expect(layerPngHeight(layer(), 1080, 1080)).toBeCloseTo((PNG_H * 1920) / 1080, 6);
  });
  it('滚动全程 = (PNG 高 + 框高) / 速度（enter / exit）；非滚动图层 null', () => {
    expect(scrollLayerDuration(layer())).toBeCloseTo((PNG_H + 0.6) / 0.08, 6);
    expect(scrollLayerDuration(layer({ scroll: null }))).toBeNull();
    expect(scrollLayerDuration(layer({ image_size: null }))).toBeNull();
  });
});

describe('fitScrollSpeed', () => {
  it('求出的速度让全程正好是目标秒数（含首尾停留）', () => {
    const l = layer({ scroll: { ...DEFAULT_SCROLL, start: 'visible', end: 'stay', hold_start: 1, hold_end: 2 } });
    const speed = fitScrollSpeed(l, 12.3);
    expect(scrollLayerDuration({ ...l, scroll: { ...l.scroll, speed } })).toBeCloseTo(12.3, 6);
  });
  it('夹在可调范围内；没有距离可走或没有 PNG 时返回当前速度', () => {
    expect(fitScrollSpeed(layer(), 0.01)).toBe(SCROLL_SPEED_MAX);
    expect(fitScrollSpeed(layer(), 10000)).toBe(SCROLL_SPEED_MIN);
    // 目标比停留还短：只能开到最快
    expect(fitScrollSpeed(layer({ scroll: { ...DEFAULT_SCROLL, start: 'visible', hold_start: 5 } }), 3)).toBe(SCROLL_SPEED_MAX);
    // 文案比框矮 + visible / stay：y0 = y1，没有距离
    const short = layer({ image_size: [950, 300], scroll: { ...DEFAULT_SCROLL, speed: 0.3, start: 'visible', end: 'stay' } });
    expect(fitScrollSpeed(short, 5)).toBe(0.3);
    expect(fitScrollSpeed(layer({ image_size: null, scroll: { ...DEFAULT_SCROLL, speed: 0.2 } }), 5)).toBe(0.2);
  });
});

describe('posterDuration', () => {
  const voice: Asset = { id: 'a_tts', type: 'audio', kind: 'audio', status: 'ready', name: '朗读', url: '/media/a.m4a', source: 'derived', duration: 12.34, derived_from: { stem: 'tts' }, created_at: '' };
  it('滚动图层与朗读轨取最大并向上取到 0.1 秒', () => {
    const scrollSec = (PNG_H + 0.6) / 0.08; // ≈ 27.04
    const spec: EditSpec = { ...emptySpec(), layers: [layer()], audio: { source_volume: 1, tracks: [voiceTrack('au1', 'a_tts', 12.34)] } };
    expect(posterDuration(spec, [voice])).toBeCloseTo(Math.ceil(scrollSec * 10) / 10, 6);
    // 朗读更长：以朗读为准，从时段起点算并扣掉 offset
    const long: EditSpec = { ...spec, audio: { source_volume: 1, tracks: [{ ...voiceTrack('au1', 'a_tts', 40), t: [2, 40], offset: 1 }] }, layers: [layer({ scroll: { ...DEFAULT_SCROLL, speed: 1 } })] };
    expect(posterDuration(long, [voice])).toBeCloseTo(13.4, 6);
    expect(posterDuration(long, [{ ...voice, duration: 30.01 }])).toBeCloseTo(31.1, 6);
  });
  it('图层时段起点也算进去；隐藏的、BGM、没时长的素材不算；什么都没有时 null', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [layer({ t: [3, 10], scroll: { ...DEFAULT_SCROLL, speed: 1 } })] };
    expect(posterDuration(spec, [])).toBeCloseTo(Math.ceil((3 + (PNG_H + 0.6)) * 10) / 10, 6);
    expect(posterDuration({ ...spec, layers: [{ ...spec.layers[0], hidden: true }] }, [])).toBeNull();
    const bgm: EditSpec = { ...emptySpec(), audio: { source_volume: 1, tracks: [{ ...voiceTrack('au1', 'a_tts', 12), role: 'bgm' }] } };
    expect(posterDuration(bgm, [voice])).toBeNull();
    const notReady: EditSpec = { ...emptySpec(), audio: { source_volume: 1, tracks: [voiceTrack('au1', 'a_tts', 12)] } };
    expect(posterDuration(notReady, [{ ...voice, status: 'preparing', duration: null }])).toBeNull();
    expect(posterDuration(emptySpec(), [])).toBeNull();
  });
});

describe('highlightSpans', () => {
  it('按顺序轮流取色，第五个回到第一色', () => {
    const phrases = [0, 1, 2, 3, 4].map((i) => ({ text: 'x', start: i * 3, end: i * 3 + 2 }));
    const out = highlightSpans(phrases, null);
    expect(out.map((s) => s.color)).toEqual([...HIGHLIGHT_PALETTE, HIGHLIGHT_PALETTE[0]]);
    expect(out.map((s) => [s.start, s.end])).toEqual([[0, 2], [3, 5], [6, 8], [9, 11], [12, 14]]);
  });
  it('并入已有区间：不重叠的保留，重叠处新的优先，结果升序', () => {
    const existing = [{ start: 0, end: 4, color: '#111111' }, { start: 20, end: 24, color: '#222222' }];
    const out = highlightSpans([{ text: 'a', start: 2, end: 6 }], existing);
    expect(out).toEqual([
      { start: 0, end: 2, color: '#111111' },
      { start: 2, end: 6, color: HIGHLIGHT_PALETTE[0] },
      { start: 20, end: 24, color: '#222222' },
    ]);
  });
  it('越界区间按文本长度裁掉', () => {
    expect(highlightSpans([{ text: 'a', start: 3, end: 9 }], [], 5)).toEqual([{ start: 3, end: 5, color: HIGHLIGHT_PALETTE[0] }]);
  });
});

describe('newPosterLayer / voiceTrack', () => {
  it('滚动文案图层：顶部居中、宽 = 框宽并按框宽折行、全程、缺省滚动 + 指定框', () => {
    const box = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 };
    const l = newPosterLayer('l9', '你好', box, { ...style, align: 'left' });
    expect(l).toMatchObject({ id: 'l9', type: 'text', text: '你好', anchor: 'top-center', margin: [0, 0], width: 0.8, rotate: 0, opacity: 1, t: 'all' });
    expect(l.style).toEqual({ ...style, align: 'center', wrap_width: 0.8 });
    expect(l.scroll).toEqual({ ...DEFAULT_SCROLL, box });
    expect(l.animation).toBeUndefined();
  });
  it('朗读轨：口播、从 0 播到素材结束、原音量、不循环', () => {
    expect(voiceTrack('au9', 'a_tts', 12.3)).toEqual({ id: 'au9', asset_id: 'a_tts', role: 'voice', align: 'post', t: [0, 12.3], offset: 0, volume: 1, loop: false });
  });
});

describe('scrollSummary', () => {
  it('滚动 + 朗读 → 成片取较长者；没有朗读时只写滚动；没烤 PNG 时写待渲染', () => {
    const l = layer({ scroll: { ...DEFAULT_SCROLL, speed: 0.22 } }); // ≈ 9.83 s，向上取到 9.9（与 posterDuration 一致）
    expect(scrollSummary(l, 12.3)).toBe('滚动 9.9 s · 朗读 12.3 s → 成片 12.3 s');
    expect(scrollSummary(l, null)).toBe('滚动 9.9 s → 成片 9.9 s');
    expect(scrollSummary(layer({ image_size: null }), 12.3)).toBe('滚动 待渲染 · 朗读 12.3 s → 成片 12.3 s');
    expect(scrollSummary(layer({ image_size: null }), null)).toBe('滚动 待渲染 → 成片 —');
  });
});

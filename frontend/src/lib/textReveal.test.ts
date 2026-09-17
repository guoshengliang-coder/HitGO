import { describe, expect, it } from 'vitest';
import cases from './fixtures/textRevealCases.json';
import { buildGlyphLayout, cursorRect, inverseEase, isRtlLine, layoutCells, MAX_UNITS, revealAlpha, revealTiming, searchBalanced, wordGroups, type MeasuredLine } from './textReveal';
import type { GlyphLayout, TextReveal } from '../types';

type Case = { name: string; layout: GlyphLayout; reveal: TextReveal; window: number; delay: number; u: number; points: [number, number][]; expect: number[] };

describe('revealAlpha 对照后端 golden（HIG-45）', () => {
  for (const c of (cases as unknown as { cases: Case[] }).cases) {
    it(`${c.name} @ ${c.u}`, () => {
      c.points.forEach(([x, y], i) => expect(revealAlpha(c.layout, c.reveal, c.window, c.delay, c.u, x, y)).toBeCloseTo(c.expect[i], 5));
    });
  }
});

const LAYOUT: GlyphLayout = { lines: [{ top: 0.1, bottom: 0.9, units: [[0.05, 0.3], [0.35, 0.6], [0.65, 0.95]] }] };

describe('textReveal helpers', () => {
  it('反曲线与时间分配', () => {
    expect(inverseEase('ease_in', 0.125)).toBeCloseTo(0.5, 9);
    expect(inverseEase('ease_out', 0.875)).toBeCloseTo(0.5, 9);
    expect(inverseEase('ease_in_out', 0.5)).toBeCloseTo(0.5, 9);
    expect(revealTiming({ preset: 'typewriter', duration: 1 }, 3, 4, 0.5)!.times).toEqual([0.5, 1, 1.5]);
    expect(revealTiming({ preset: 'fade_chars', duration: 1 }, 3, 4, 0)!.times.map((t) => +t.toFixed(6))).toEqual([0, 0.35, 0.7]);
    expect(revealTiming({ preset: 'wipe', duration: 1.5 }, 3, 4, 0)!.times).toEqual([0, 0.5, 1, 1.5]);
    expect(revealTiming({ preset: 'wipe' }, 3, 2, 2)).toBeNull();
  });
  it('格子取相邻字的中点，首尾到 PNG 边', () => {
    const cells = layoutCells(LAYOUT)[0];
    expect(cells.map((c) => [c.cellLeft, c.cellRight].map((v) => +v.toFixed(3)))).toEqual([[0, 0.325], [0.325, 0.625], [0.625, 1]]);
  });
  it('平衡树查找与普通二分在单调分界上一致', () => {
    const splits = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    for (const v of [0, 0.1, 0.15, 0.2, 0.45, 0.69, 0.7, 0.99]) expect(searchBalanced(splits, v)).toBe(splits.filter((s) => v >= s).length);
  });
  it('光标位置与后端一致（400 × 100 画面）', () => {
    const reveal: TextReveal = { preset: 'typewriter', duration: 1.5, cursor: true };
    const at = (u: number) => cursorRect(LAYOUT, reveal, 4, 0, u, 400, 100);
    expect(at(0.2)).toEqual({ x: 123, y: 18, w: 5, h: 64 });
    expect(at(0.9)!.x).toBe(243);
    expect(at(1.6)!.x).toBe(383);
    expect(at(1.7)).not.toBeNull();
    expect(at(2.1)).toBeNull(); // 打完后闪烁：灭的半秒
    expect(cursorRect(LAYOUT, { preset: 'wipe', cursor: true }, 4, 0, 0.2, 400, 100)).toBeNull();
  });
});

describe('buildGlyphLayout', () => {
  const line = (text: string, top: number, rtl = false): MeasuredLine => ({
    top,
    bottom: top + 50,
    rtl,
    glyphs: Array.from(text).map((ch, i) => ({ text: ch, left: 10 + i * 20, right: 28 + i * 20 })),
  });
  it('按字：比例坐标、空行去掉、rtl 行带标记', () => {
    const layout = buildGlyphLayout([line('ab', 0), { top: 50, bottom: 100, rtl: false, glyphs: [] }, line('cd', 100, true)], 200, 150)!;
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0]).toEqual({ top: 0, bottom: 0.3333, units: [[0.05, 0.14], [0.15, 0.24]] });
    expect(layout.lines[1].rtl).toBe(true);
  });
  it('按词：空格和标点并进前一个词', () => {
    expect(wordGroups(Array.from('Hi, you all'))).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10]]);
    expect(wordGroups(Array.from(' go'))).toEqual([[0, 1, 2]]);
    const layout = buildGlyphLayout([line('Hi you', 0)], 200, 50, 'word')!;
    expect(layout.lines[0].units).toEqual([[0.05, 0.34], [0.35, 0.64]]); // 「Hi 」连同空格一组
  });
  it('单位超过上限时两两合并', () => {
    const long = line('x'.repeat(MAX_UNITS + 10), 0);
    const layout = buildGlyphLayout([long], 50000, 50)!;
    expect(layout.lines[0].units.length).toBeLessThanOrEqual(MAX_UNITS);
  });
  it('RTL 判定：纯阿拉伯文是，混排不是', () => {
    expect(isRtlLine('مرحبا بالعالم')).toBe(true);
    expect(isRtlLine('مرحبا hello')).toBe(false);
    expect(isRtlLine('你好')).toBe(false);
  });
});

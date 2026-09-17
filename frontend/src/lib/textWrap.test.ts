import { describe, expect, it } from 'vitest';
import { clampWrapWidth, wrapLineRanges, wrapRuns } from './textWrap';

// 等宽测量：每个 UTF-16 单元宽 1，方便推算断行
const mono = (s: string) => s.length;
const lines = (text: string, max: number) => wrapLineRanges(text, max, mono).map(([a, b]) => text.slice(a, b));

describe('wrapLineRanges', () => {
  it('放得下时不断', () => {
    expect(lines('Hello world', 20)).toEqual(['Hello world']);
  });

  it('拉丁文在空格处断，行尾空格去掉', () => {
    expect(lines('This super handy phone cleaner', 12)).toEqual(['This super', 'handy phone', 'cleaner']);
  });

  it('标点不出现在行首', () => {
    const out = lines('Hello, world, again', 6);
    expect(out.every((l) => !/^[,.\s]/.test(l))).toBe(true);
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe('Hello, world, again');
  });

  it('超长单词按字形硬断', () => {
    expect(lines('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('中文每行不超宽、内容不丢，句读不在行首', () => {
    const text = '只需要打开这个开关，就能一键扫描手机隐藏的顽固垃圾，深度释放手机内存。';
    const out = lines(text, 8);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((l) => l.length <= 9)).toBe(true); // 句读粘在前一段时允许略超一个字
    expect(out.every((l) => !/^[，。]/.test(l))).toBe(true);
    expect(out.join('')).toBe(text);
  });

  it('左括号不留在行尾', () => {
    const out = lines('abc (def) ghi', 5);
    expect(out.every((l) => !/\($/.test(l))).toBe(true);
  });

  it('maxWidth 非正时原样一行', () => {
    expect(lines('Hello world', 0)).toEqual(['Hello world']);
  });
});

describe('wrapRuns', () => {
  it('跨行保留片段颜色', () => {
    const out = wrapRuns([[{ text: 'aa ' }, { text: 'bb cc', color: '#f00' }]], 5, mono);
    expect(out).toEqual([[{ text: 'aa ' }, { text: 'bb', color: '#f00' }], [{ text: 'cc', color: '#f00' }]]);
  });

  it('空行保持为一个空片段', () => {
    expect(wrapRuns([[{ text: '' }], [{ text: 'x' }]], 3, mono)).toEqual([[{ text: '' }], [{ text: 'x' }]]);
  });
});

describe('clampWrapWidth', () => {
  it('限制在 [0.05, 1] 并保留 4 位小数', () => {
    expect(clampWrapWidth(0.01)).toBe(0.05);
    expect(clampWrapWidth(1.4)).toBe(1);
    expect(clampWrapWidth(0.123456)).toBe(0.1235);
    expect(clampWrapWidth(Number.NaN)).toBe(1);
  });
});

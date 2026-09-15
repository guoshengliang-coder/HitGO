import { describe, expect, it } from 'vitest';
import { adjustSpans, normalizeSpans, resolveBackgroundBox, setSpanColor, splitRuns } from './textSpans';

const RED = '#E3312B';
const BLUE = '#0000FF';

describe('normalizeSpans', () => {
  it('裁到文本长度、丢空区间、排序、合并相邻同色', () => {
    expect(normalizeSpans([{ start: 5, end: 9, color: RED }, { start: 2, end: 5, color: RED }, { start: 9, end: 9, color: RED }], 8)).toEqual([{ start: 2, end: 8, color: RED }]);
  });
  it('重叠时后者优先', () => {
    expect(normalizeSpans([{ start: 0, end: 4, color: RED }, { start: 2, end: 6, color: BLUE }], 10)).toEqual([
      { start: 0, end: 2, color: RED },
      { start: 2, end: 6, color: BLUE },
    ]);
  });
  it('空 / 缺省', () => {
    expect(normalizeSpans(undefined, 3)).toEqual([]);
    expect(normalizeSpans([{ start: 0, end: 2, color: '' }], 3)).toEqual([]);
  });
});

describe('setSpanColor', () => {
  it('对选区上色并切开旧区间', () => {
    const base = [{ start: 0, end: 6, color: RED }];
    expect(setSpanColor(base, 2, 4, BLUE, 6)).toEqual([
      { start: 0, end: 2, color: RED },
      { start: 2, end: 4, color: BLUE },
      { start: 4, end: 6, color: RED },
    ]);
  });
  it('清除颜色', () => {
    expect(setSpanColor([{ start: 0, end: 6, color: RED }], 0, 3, null, 6)).toEqual([{ start: 3, end: 6, color: RED }]);
    expect(setSpanColor([{ start: 0, end: 6, color: RED }], 0, 6, null, 6)).toEqual([]);
  });
  it('反向选区与空选区', () => {
    expect(setSpanColor([], 4, 1, RED, 6)).toEqual([{ start: 1, end: 4, color: RED }]);
    expect(setSpanColor([{ start: 0, end: 2, color: RED }], 3, 3, BLUE, 6)).toEqual([{ start: 0, end: 2, color: RED }]);
  });
});

describe('adjustSpans', () => {
  const text = '苹果手机如何清理垃圾内存';
  const spans = [{ start: 8, end: 12, color: RED }]; // 垃圾内存

  it('改动段之前：区间不动', () => {
    expect(adjustSpans(spans, text, '苹果手机如何正确清理垃圾内存')).toEqual([{ start: 10, end: 14, color: RED }]);
  });
  it('区间之后插入 / 删除：不受影响', () => {
    expect(adjustSpans(spans, text, text + '！')).toEqual(spans);
    expect(adjustSpans([{ start: 0, end: 2, color: RED }], text, '苹果手机')).toEqual([{ start: 0, end: 2, color: RED }]);
  });
  it('在上色文字中间打字：区间伸缩', () => {
    expect(adjustSpans(spans, text, '苹果手机如何清理垃圾的内存')).toEqual([{ start: 8, end: 13, color: RED }]);
    expect(adjustSpans(spans, text, '苹果手机如何清理垃内存')).toEqual([{ start: 8, end: 11, color: RED }]);
  });
  it('删掉区间的一侧：裁到改动边界', () => {
    // 删掉「理垃」：区间只剩「圾内存」
    expect(adjustSpans(spans, text, '苹果手机如何清圾内存')).toEqual([{ start: 7, end: 10, color: RED }]);
  });
  it('整段替换：区间消失', () => {
    expect(adjustSpans(spans, text, '全新文案')).toEqual([]);
  });
  it('紧贴区间末尾打字不扩展颜色；紧贴起点打字整体后移', () => {
    expect(adjustSpans(spans, text, text + '呀')).toEqual(spans);
    expect(adjustSpans(spans, text, '苹果手机如何清理好垃圾内存')).toEqual([{ start: 9, end: 13, color: RED }]);
  });
  it('文本不变时原样返回', () => {
    expect(adjustSpans(spans, text, text)).toEqual(spans);
  });
});

describe('splitRuns', () => {
  it('无 spans：每行一个片段', () => {
    expect(splitRuns('主标题\n副标题', [])).toEqual([[{ text: '主标题' }], [{ text: '副标题' }]]);
  });
  it('行内片段', () => {
    expect(splitRuns('主标题\n副标题关键词', [{ start: 7, end: 10, color: RED }])).toEqual([[{ text: '主标题' }], [{ text: '副标题' }, { text: '关键词', color: RED }]]);
  });
  it('覆盖整行与跨行区间', () => {
    expect(splitRuns('主标题\n副标题', [{ start: 0, end: 3, color: RED }])).toEqual([[{ text: '主标题', color: RED }], [{ text: '副标题' }]]);
    expect(splitRuns('ab\ncd', [{ start: 1, end: 4, color: RED }])).toEqual([[{ text: 'a' }, { text: 'b', color: RED }], [{ text: 'c', color: RED }, { text: 'd' }]]);
  });
  it('区间边界落在换行符上', () => {
    expect(splitRuns('ab\ncd', [{ start: 2, end: 3, color: RED }])).toEqual([[{ text: 'ab' }], [{ text: 'cd' }]]);
  });
  it('空行与空文本', () => {
    expect(splitRuns('a\n\nb', [{ start: 0, end: 4, color: RED }])).toEqual([[{ text: 'a', color: RED }], [{ text: '' }], [{ text: 'b', color: RED }]]);
    expect(splitRuns('', [])).toEqual([[{ text: '' }]]);
  });
});

describe('resolveBackgroundBox', () => {
  it('缺省紧贴文字', () => {
    expect(resolveBackgroundBox({ contentW: 300.4, padPx: 10, strokePx: 2, backgroundWidth: null, canvasW: 1080 })).toEqual({ boxW: 325, alignW: 301 });
  });
  it('通栏：拉到画布宽，对齐区随之变宽', () => {
    expect(resolveBackgroundBox({ contentW: 300, padPx: 10, strokePx: 0, backgroundWidth: 1, canvasW: 1080 })).toEqual({ boxW: 1080, alignW: 1060 });
    expect(resolveBackgroundBox({ contentW: 300, padPx: 10, strokePx: 0, backgroundWidth: 0.98, canvasW: 1080 })).toEqual({ boxW: 1058, alignW: 1038 });
  });
  it('指定宽度小于紧贴宽时不裁文字', () => {
    expect(resolveBackgroundBox({ contentW: 900, padPx: 10, strokePx: 0, backgroundWidth: 0.5, canvasW: 1080 })).toEqual({ boxW: 920, alignW: 900 });
  });
});

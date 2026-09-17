import { describe, expect, it } from 'vitest';
import { adjustSpans, normalizeSpans, resolveBackgroundBox, resolveOverflowPad, resolveTextBox, resolveTextBoxHeight, setSpanColor, splitRuns } from './textSpans';

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

describe('resolveTextBox', () => {
  const base = { contentW: 300, padPx: 10, strokePx: 0, backgroundWidth: null, canvasW: 1080 };
  it('没有 wrapWidth 时框就是背景块（旧行为）', () => {
    expect(resolveTextBox({ ...base, wrapWidth: null, align: 'center' })).toEqual({ outerW: 320, bgX: 0, bgW: 320, alignW: 300 });
  });
  it('wrapWidth 固定框宽，背景块按对齐放在框里', () => {
    expect(resolveTextBox({ ...base, wrapWidth: 0.5, align: 'center' })).toEqual({ outerW: 540, bgX: 110, bgW: 320, alignW: 300 });
    expect(resolveTextBox({ ...base, wrapWidth: 0.5, align: 'left' }).bgX).toBe(0);
    expect(resolveTextBox({ ...base, wrapWidth: 0.5, align: 'right' }).bgX).toBe(220);
  });
  it('背景块比换行框宽时取背景块', () => {
    expect(resolveTextBox({ ...base, backgroundWidth: 1, wrapWidth: 0.5, align: 'center' })).toEqual({ outerW: 1080, bgX: 0, bgW: 1080, alignW: 1060 });
  });
});

describe('resolveTextBoxHeight（HIG-51）', () => {
  const base = { contentH: 200, padPx: 10, strokePx: 5, canvasH: 1920 };
  it('没有 boxHeight 时紧贴文字（旧行为）', () => {
    expect(resolveTextBoxHeight({ ...base, boxHeight: null })).toEqual({ boxH: 230, offsetY: 0 });
    expect(resolveTextBoxHeight({ ...base, boxHeight: undefined })).toEqual({ boxH: 230, offsetY: 0 });
  });
  it('boxHeight 比文字矮时框不小于文字本身', () => {
    expect(resolveTextBoxHeight({ ...base, boxHeight: 0.05 })).toEqual({ boxH: 230, offsetY: 0 });
  });
  it('boxHeight 比文字高时框拉高，文字垂直居中', () => {
    expect(resolveTextBoxHeight({ ...base, boxHeight: 0.25 })).toEqual({ boxH: 480, offsetY: 125 });
  });
  it('按渲染高度换算（各画幅重渲染时比例不变）', () => {
    expect(resolveTextBoxHeight({ contentH: 100, padPx: 5, strokePx: 0, boxHeight: 0.25, canvasH: 960 })).toEqual({ boxH: 240, offsetY: 65 });
  });
});

describe('resolveOverflowPad', () => {
  it('无阴影无发光 = 0', () => {
    expect(resolveOverflowPad({ shadowBlurPx: 0, shadowDx: 0, shadowDy: 0, glowBlurPx: 0 })).toBe(0);
  });
  it('阴影：blur + 最大偏移，向上取整', () => {
    expect(resolveOverflowPad({ shadowBlurPx: 19.2, shadowDx: 3.84, shadowDy: -7.68, glowBlurPx: 0 })).toBe(27);
  });
  it('发光：1.5 倍模糊半径，向上取整', () => {
    expect(resolveOverflowPad({ shadowBlurPx: 0, shadowDx: 0, shadowDy: 0, glowBlurPx: 26.88 })).toBe(41);
  });
  it('两者同时存在取较大值', () => {
    expect(resolveOverflowPad({ shadowBlurPx: 19.2, shadowDx: 3.84, shadowDy: 7.68, glowBlurPx: 26.88 })).toBe(41);
    expect(resolveOverflowPad({ shadowBlurPx: 40, shadowDx: 10, shadowDy: 0, glowBlurPx: 10 })).toBe(50);
  });
});

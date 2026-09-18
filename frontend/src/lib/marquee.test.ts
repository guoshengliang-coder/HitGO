import { describe, expect, it } from 'vitest';
import { applyMarquee, hitRects, isMarquee, marqueeRect, modeFor, rectsOverlap, type IdRect } from './marquee';

describe('marqueeRect', () => {
  it('从右下往左上反着拖也归一化成 left ≤ right、top ≤ bottom', () => {
    expect(marqueeRect({ x: 80, y: 60 }, { x: 20, y: 10 })).toEqual({ left: 20, top: 10, right: 80, bottom: 60 });
    expect(marqueeRect({ x: 20, y: 10 }, { x: 80, y: 60 })).toEqual({ left: 20, top: 10, right: 80, bottom: 60 });
  });
});

describe('isMarquee', () => {
  it('只有拉开超过阈值才算框选，没动就是一次点击', () => {
    expect(isMarquee(marqueeRect({ x: 10, y: 10 }, { x: 12, y: 11 }))).toBe(false);
    expect(isMarquee(marqueeRect({ x: 10, y: 10 }, { x: 15, y: 11 }))).toBe(true); // 横向够了
    expect(isMarquee(marqueeRect({ x: 10, y: 10 }, { x: 11, y: 20 }))).toBe(true); // 纵向够了
  });
});

describe('rectsOverlap / hitRects', () => {
  const rows: IdRect[] = [
    { id: 'a', left: 0, right: 10, top: 0, bottom: 10 },
    { id: 'b', left: 20, right: 30, top: 0, bottom: 10 },
    { id: 'c', left: 5, right: 25, top: 20, bottom: 30 },
  ];

  it('碰到就算命中，不要求整个包住', () => {
    expect(hitRects({ left: 8, top: 5, right: 22, bottom: 8 }, rows)).toEqual(['a', 'b']);
  });

  it('只贴着边不算相交', () => {
    expect(rectsOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
  });

  it('跨行的框把三行都圈进来，顺序按传入顺序', () => {
    expect(hitRects({ left: 0, top: 0, right: 30, bottom: 30 }, rows)).toEqual(['a', 'b', 'c']);
  });

  it('框在空白处时谁也不命中', () => {
    expect(hitRects({ left: 40, top: 40, right: 50, bottom: 50 }, rows)).toEqual([]);
  });
});

describe('modeFor', () => {
  it('裸拖替换、Shift 拖追加、Shift 点翻转', () => {
    expect(modeFor(false, 'drag')).toBe('replace');
    expect(modeFor(false, 'click')).toBe('replace');
    expect(modeFor(true, 'drag')).toBe('add');
    expect(modeFor(true, 'click')).toBe('toggle');
  });
});

describe('applyMarquee', () => {
  it('replace 换掉整批并去重', () => {
    expect(applyMarquee(['a', 'b'], ['c', 'c', 'd'], 'replace')).toEqual(['c', 'd']);
  });

  it('add 追加，已选中的排前面——主选中 ids[0] 不会因为加选就跳走', () => {
    expect(applyMarquee(['a', 'b'], ['b', 'c'], 'add')).toEqual(['a', 'b', 'c']);
  });

  it('toggle 把命中里已选中的去掉、没选中的加上', () => {
    expect(applyMarquee(['a', 'b'], ['b'], 'toggle')).toEqual(['a']);
    expect(applyMarquee(['a', 'b'], ['c'], 'toggle')).toEqual(['a', 'b', 'c']);
    expect(applyMarquee(['a'], ['a'], 'toggle')).toEqual([]);
  });
});

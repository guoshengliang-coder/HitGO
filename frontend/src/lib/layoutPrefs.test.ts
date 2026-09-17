import { describe, expect, it } from 'vitest';
import { clampPrefs, fitToViewport, LAYOUT_DEFAULTS, loadLayoutPrefs, saveLayoutPrefs } from './layoutPrefs';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => Object.fromEntries(m) };
}

describe('layoutPrefs', () => {
  it('缺省 / 非法值回退默认', () => {
    expect(clampPrefs(null)).toEqual(LAYOUT_DEFAULTS);
    expect(clampPrefs({ leftW: Infinity, rightW: NaN, timelineH: 'x' as unknown as number })).toEqual(LAYOUT_DEFAULTS);
  });
  it('裁到上下限并取整', () => {
    expect(clampPrefs({ leftW: 1000, rightW: 10, timelineH: 9999 })).toEqual({ leftW: 420, rightW: 260, timelineH: 560 });
    expect(clampPrefs({ leftW: 90, rightW: 300.6, timelineH: 200.2 })).toEqual({ leftW: 180, rightW: 301, timelineH: 200 });
  });
  it('HIG-53 之前存的偏好没有 leftW：取默认，其余保留', () => {
    const s = memStorage({ 'hitgo.layout': JSON.stringify({ rightW: 400, timelineH: 300 }) });
    expect(loadLayoutPrefs(s)).toEqual({ leftW: 236, rightW: 400, timelineH: 300 });
  });
  it('读写 localStorage；坏 JSON 回退默认', () => {
    const s = memStorage();
    saveLayoutPrefs({ leftW: 300, rightW: 400, timelineH: 300 }, s);
    expect(loadLayoutPrefs(s)).toEqual({ leftW: 300, rightW: 400, timelineH: 300 });
    expect(loadLayoutPrefs(memStorage({ 'hitgo.layout': '{bad' }))).toEqual(LAYOUT_DEFAULTS);
    expect(loadLayoutPrefs(null)).toEqual(LAYOUT_DEFAULTS);
  });
});

describe('fitToViewport', () => {
  const wide = { leftW: 400, rightW: 480, timelineH: 500 };
  it('放得下时原样返回', () => {
    expect(fitToViewport(wide, 1920, 1080)).toEqual(wide);
  });
  it('宽度不够先收右栏再收左栏，给中栏留 480', () => {
    // 1300 − 8 − 480 = 812 可分给左右栏：右栏收到 412
    expect(fitToViewport(wide, 1300, 1080)).toEqual({ ...wide, rightW: 412 });
    // 1100 − 488 = 612：右栏到下限 260，左栏收到 352
    expect(fitToViewport(wide, 1100, 1080)).toEqual({ ...wide, leftW: 352, rightW: 260 });
  });
  it('窗口小到下限都放不下时停在下限', () => {
    expect(fitToViewport(wide, 600, 300)).toEqual({ leftW: 180, rightW: 260, timelineH: 140 });
  });
  it('高度不够时收时间线，给画面留 160', () => {
    // 769 − 136 − 160 = 473
    expect(fitToViewport(wide, 1920, 769).timelineH).toBe(473);
  });
  it('尺寸未知（0）时不收', () => {
    expect(fitToViewport(wide, 0, 0)).toEqual(wide);
  });
});

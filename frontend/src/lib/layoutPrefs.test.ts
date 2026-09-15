import { describe, expect, it } from 'vitest';
import { clampPrefs, LAYOUT_DEFAULTS, loadLayoutPrefs, saveLayoutPrefs } from './layoutPrefs';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => Object.fromEntries(m) };
}

describe('layoutPrefs', () => {
  it('缺省 / 非法值回退默认', () => {
    expect(clampPrefs(null)).toEqual(LAYOUT_DEFAULTS);
    expect(clampPrefs({ rightW: NaN, timelineH: 'x' as unknown as number })).toEqual(LAYOUT_DEFAULTS);
  });
  it('裁到上下限并取整', () => {
    expect(clampPrefs({ rightW: 10, timelineH: 9999 })).toEqual({ rightW: 260, timelineH: 400 });
    expect(clampPrefs({ rightW: 300.6, timelineH: 200.2 })).toEqual({ rightW: 301, timelineH: 200 });
  });
  it('读写 localStorage；坏 JSON 回退默认', () => {
    const s = memStorage();
    saveLayoutPrefs({ rightW: 400, timelineH: 300 }, s);
    expect(loadLayoutPrefs(s)).toEqual({ rightW: 400, timelineH: 300 });
    expect(loadLayoutPrefs(memStorage({ 'hitgo.layout': '{bad' }))).toEqual(LAYOUT_DEFAULTS);
    expect(loadLayoutPrefs(null)).toEqual(LAYOUT_DEFAULTS);
  });
});

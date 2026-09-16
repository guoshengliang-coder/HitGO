import { describe, expect, it } from 'vitest';
import { addCustomColor, cleanCustomColors, CUSTOM_LIMIT, loadCustomColors, PRESET_COLORS, removeCustomColor, saveCustomColors } from './colorSwatches';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('colorSwatches', () => {
  it('预设色都是合法大写 6 位 hex 且不重复', () => {
    for (const c of PRESET_COLORS) expect(c).toMatch(/^#[0-9A-F]{6}$/);
    expect(new Set(PRESET_COLORS).size).toBe(PRESET_COLORS.length);
  });
  it('清洗：规范化、丢非法、去重、截上限', () => {
    expect(cleanCustomColors(['#abc', 'xyz', '#AABBCC', 3, '#ff000080'])).toEqual(['#AABBCC', '#FF000080']);
    expect(cleanCustomColors('x')).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`);
    expect(cleanCustomColors(many)).toHaveLength(CUSTOM_LIMIT);
  });
  it('新增放最前，已有的挪到最前；删除', () => {
    const l = addCustomColor(addCustomColor([], '#111111'), '#222222');
    expect(l).toEqual(['#222222', '#111111']);
    expect(addCustomColor(l, '#111111')).toEqual(['#111111', '#222222']);
    expect(addCustomColor(l, 'nope')).toBe(l);
    expect(removeCustomColor(l, '#222222')).toEqual(['#111111']);
  });
  it('读写 storage；坏 JSON 回退空', () => {
    const s = memStorage();
    saveCustomColors(['#123456', '#abcdef'], s);
    expect(loadCustomColors(s)).toEqual(['#123456', '#ABCDEF']);
    expect(loadCustomColors(memStorage({ 'hitgo.colors': '{bad' }))).toEqual([]);
    expect(loadCustomColors(null)).toEqual([]);
  });
});

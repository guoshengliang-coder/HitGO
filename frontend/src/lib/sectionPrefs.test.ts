import { describe, expect, it } from 'vitest';
import { cleanPrefs, loadSectionPrefs, saveSectionOpen, sectionOpen } from './sectionPrefs';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => Object.fromEntries(m) };
}

describe('sectionPrefs', () => {
  it('只收布尔值，其余类型丢掉', () => {
    expect(cleanPrefs({ a: true, b: false, c: 1, d: 'x', e: null })).toEqual({ a: true, b: false });
    expect(cleanPrefs(null)).toEqual({});
    expect(cleanPrefs([true])).toEqual({});
  });

  it('没存过的分组用调用方给的默认值', () => {
    expect(sectionOpen({}, 'trim.cover', false)).toBe(false);
    expect(sectionOpen({}, 'trim.ranges', true)).toBe(true);
    expect(sectionOpen({ 'trim.cover': true }, 'trim.cover', false)).toBe(true);
    // 没有 id 的分组不持久化，永远用默认值
    expect(sectionOpen({ 'trim.cover': true }, undefined, false)).toBe(false);
  });

  it('读写 localStorage，逐个分组合并而不是整表覆盖', () => {
    const s = memStorage();
    saveSectionOpen('trim.cover', true, s);
    saveSectionOpen('trim.frame', false, s);
    expect(loadSectionPrefs(s)).toEqual({ 'trim.cover': true, 'trim.frame': false });
  });

  it('坏 JSON 回退空表，且新的开合仍然存得进去', () => {
    const s = memStorage({ 'hitgo.sections': '{bad' });
    expect(loadSectionPrefs(s)).toEqual({});
    saveSectionOpen('trim.cover', true, s);
    expect(loadSectionPrefs(s)).toEqual({ 'trim.cover': true });
  });

  it('没有 storage（SSR）或 setItem 抛错（隐私模式）时不炸', () => {
    expect(loadSectionPrefs(null)).toEqual({});
    expect(() => saveSectionOpen('trim.cover', true, null)).not.toThrow();
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(() => saveSectionOpen('trim.cover', true, throwing)).not.toThrow();
  });
});

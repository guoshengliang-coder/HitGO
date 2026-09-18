import { describe, expect, it } from 'vitest';
import { cleanFeaturePrefs, FEATURE_DEFAULTS, loadFeaturePrefs, saveFeaturePrefs } from './featurePrefs';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('featurePrefs', () => {
  it('没存过 / 坏值逐项回落默认', () => {
    expect(cleanFeaturePrefs(null)).toEqual(FEATURE_DEFAULTS);
    expect(cleanFeaturePrefs({ autoApplyDub: 'yes', posterSplitOnPaste: false, posterPunct: 'nope' })).toEqual({ ...FEATURE_DEFAULTS, posterSplitOnPaste: false });
    expect(loadFeaturePrefs(memStorage({ 'hitgo.prefs': '{bad json' }))).toEqual(FEATURE_DEFAULTS);
    expect(loadFeaturePrefs(null)).toEqual(FEATURE_DEFAULTS);
  });

  it('按项合并保存', () => {
    const s = memStorage();
    saveFeaturePrefs({ posterPunct: 'drop-all' }, s);
    const merged = { autoApplyDub: false, useSourceVoice: false, posterSplitOnPaste: true, posterPunct: 'drop-all' };
    expect(saveFeaturePrefs({ autoApplyDub: false }, s)).toEqual(merged);
    expect(loadFeaturePrefs(s)).toEqual(merged);
    expect(saveFeaturePrefs({ useSourceVoice: true }, s)).toEqual({ ...merged, useSourceVoice: true });
  });

  it('写入失败不抛，返回合并后的值', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(saveFeaturePrefs({ autoApplyDub: false }, broken).autoApplyDub).toBe(false);
  });
});

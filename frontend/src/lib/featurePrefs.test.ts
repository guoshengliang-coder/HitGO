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
    const merged = { ...FEATURE_DEFAULTS, autoApplyDub: false, posterPunct: 'drop-all' };
    expect(saveFeaturePrefs({ autoApplyDub: false }, s)).toEqual(merged);
    expect(loadFeaturePrefs(s)).toEqual(merged);
    expect(saveFeaturePrefs({ useSourceVoice: true }, s)).toEqual({ ...merged, useSourceVoice: true });
  });

  it('新开关缺省都开着，存过的值照旧生效（HIG-79 滚轮 / HIG-75 跟随朗读）', () => {
    expect(FEATURE_DEFAULTS.timelineWheelVertical).toBe(true);
    expect(FEATURE_DEFAULTS.posterFitVoiceSpeed).toBe(true);
    expect(cleanFeaturePrefs({ timelineWheelVertical: false })).toEqual({ ...FEATURE_DEFAULTS, timelineWheelVertical: false });
    expect(cleanFeaturePrefs({ posterFitVoiceSpeed: 'nope' }).posterFitVoiceSpeed).toBe(true);
    // 旧版本存下的偏好里没有这两项，读出来要补上默认值而不是 undefined
    expect(loadFeaturePrefs(memStorage({ 'hitgo.prefs': '{"autoApplyDub":false}' }))).toEqual({ ...FEATURE_DEFAULTS, autoApplyDub: false });
  });

  it('写入失败不抛，返回合并后的值', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(saveFeaturePrefs({ autoApplyDub: false }, broken).autoApplyDub).toBe(false);
  });
});

describe('localizeSplitCues（HIG-36）', () => {
  it('默认开，坏值回落，改一项不动其它项', () => {
    const store = memStorage();
    expect(loadFeaturePrefs(store).localizeSplitCues).toBe(true);
    store.setItem('hitgo.prefs', JSON.stringify({ localizeSplitCues: 'yes', autoApplyDub: false }));
    const prefs = loadFeaturePrefs(store);
    expect(prefs.localizeSplitCues).toBe(true);
    expect(prefs.autoApplyDub).toBe(false);
    expect(saveFeaturePrefs({ localizeSplitCues: false }, store)).toMatchObject({ localizeSplitCues: false, autoApplyDub: false });
  });
});

import { describe, expect, it } from 'vitest';
import { defaultApplyModules, layerTypeForStep, layerTypesForStep, stepForLayer, STEPS } from './steps';

describe('layerTypesForStep', () => {
  it('文本类模块管文字图层，字幕还管遮盖，贴纸管贴纸', () => {
    expect(layerTypesForStep('text')).toEqual(['text']);
    expect(layerTypesForStep('localize')).toEqual(['text']);
    expect(layerTypesForStep('poster')).toEqual(['text']);
    expect(layerTypesForStep('subtitle')).toEqual(['text', 'mask']);
    expect(layerTypesForStep('sticker')).toEqual(['sticker']);
  });
  it('不管图层的模块返回空', () => {
    expect(layerTypesForStep('trim')).toEqual([]);
    expect(layerTypesForStep('audio')).toEqual([]);
    expect(layerTypeForStep('audio')).toBeNull();
  });
});

describe('stepForLayer（HIG-67）', () => {
  it('当前模块已经管这个类型时不切——字幕 / 改语言 / 大字报都管文字图层', () => {
    expect(stepForLayer('text', 'subtitle')).toBe('subtitle');
    expect(stepForLayer('text', 'localize')).toBe('localize');
    expect(stepForLayer('text', 'poster')).toBe('poster');
    expect(stepForLayer('mask', 'subtitle')).toBe('subtitle');
    expect(stepForLayer('sticker', 'sticker')).toBe('sticker');
  });
  it('当前模块管不到时切到管它的那个', () => {
    expect(stepForLayer('sticker', 'text')).toBe('sticker');
    expect(stepForLayer('text', 'sticker')).toBe('text');
    expect(stepForLayer('mask', 'text')).toBe('subtitle');
  });
  it('从不管图层的模块（剪辑 / 音频）选中图层时也能落到对应模块', () => {
    expect(stepForLayer('text', 'trim')).toBe('text');
    expect(stepForLayer('sticker', 'audio')).toBe('sticker');
    expect(stepForLayer('mask', 'trim')).toBe('subtitle');
  });
  it('返回值一定是真实存在的模块', () => {
    const keys = STEPS.map((s) => s.key);
    for (const type of ['text', 'sticker', 'mask'] as const) {
      for (const cur of keys) expect(keys).toContain(stepForLayer(type, cur));
    }
  });
});

describe('defaultApplyModules', () => {
  it('跟随当前模块', () => {
    expect(defaultApplyModules('audio')).toEqual(['audio']);
    expect(defaultApplyModules('localize')).toEqual(['layers', 'audio']);
    expect(defaultApplyModules('text')).toEqual(['layers']);
    expect(defaultApplyModules('trim')).toEqual(['trim', 'layers', 'outputs', 'audio', 'cover']);
  });
});

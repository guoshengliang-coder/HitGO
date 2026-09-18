import { describe, expect, it } from 'vitest';
import type { Layer } from '../types';
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

describe('stepForLayer（HIG-72）', () => {
  const layer = (type: Layer['type'], extra = {}): Layer => ({ id: type, type, ...extra }) as Layer;

  it('普通文字（含字幕和改语言图层）总到文本属性，滚动文案到大字报', () => {
    expect(stepForLayer(layer('text'))).toBe('text');
    expect(stepForLayer(layer('text', { origin: 'localize' }))).toBe('text');
    expect(stepForLayer(layer('text', { scroll: {} }))).toBe('poster');
  });
  it('贴纸与遮盖分别打开自己的属性面板', () => {
    expect(stepForLayer(layer('sticker'))).toBe('sticker');
    expect(stepForLayer(layer('mask'))).toBe('subtitle');
  });
  it('返回值一定是真实存在的模块', () => {
    const keys = STEPS.map((s) => s.key);
    for (const type of ['text', 'sticker', 'mask'] as const) expect(keys).toContain(stepForLayer(layer(type)));
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

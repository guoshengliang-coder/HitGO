import { describe, expect, it } from 'vitest';
import { defaultApplyModules, layerTypeForStep, layerTypesForStep, STEPS } from './steps';

describe('STEPS', () => {
  it('顶栏顺序：字幕作为贴纸右侧的独立模块（HIG-15），改语言之后是大字报（HIG-50）', () => {
    expect(STEPS.map((s) => s.label)).toEqual(['剪辑', '音频', '文本', '贴纸', '字幕', '改语言', '大字报']);
  });
  it('字幕 / 改语言 / 大字报模块沿用文字图层交互', () => {
    expect(layerTypeForStep('trim')).toBeNull();
    expect(layerTypeForStep('audio')).toBeNull();
    expect(layerTypeForStep('text')).toBe('text');
    expect(layerTypeForStep('sticker')).toBe('sticker');
    expect(layerTypeForStep('subtitle')).toBe('text');
    expect(layerTypeForStep('localize')).toBe('text');
    expect(layerTypeForStep('poster')).toBe('text');
  });
  it('字幕模块同时管文字与遮盖层，其它模块只管自己那一类', () => {
    expect(layerTypesForStep('subtitle')).toEqual(['text', 'mask']);
    expect(layerTypesForStep('text')).toEqual(['text']);
    expect(layerTypesForStep('poster')).toEqual(['text']);
    expect(layerTypesForStep('sticker')).toEqual(['sticker']);
    expect(layerTypesForStep('trim')).toEqual([]);
    expect(layerTypesForStep('audio')).toEqual([]);
  });
});

describe('defaultApplyModules', () => {
  it('跟随当前模块：音频只勾音频，改语言勾图层 + 音频，大字报勾剪辑 + 图层 + 音频，剪辑全勾，其余只勾图层', () => {
    expect(defaultApplyModules('audio')).toEqual(['audio']);
    expect(defaultApplyModules('localize')).toEqual(['layers', 'audio']);
    expect(defaultApplyModules('poster')).toEqual(['trim', 'layers', 'audio']);
    expect(defaultApplyModules('trim')).toEqual(['trim', 'layers', 'outputs', 'audio', 'cover']);
    for (const s of ['text', 'sticker', 'subtitle'] as const) expect(defaultApplyModules(s)).toEqual(['layers']);
  });
});

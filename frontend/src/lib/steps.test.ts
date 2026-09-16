import { describe, expect, it } from 'vitest';
import { layerTypeForStep, layerTypesForStep, STEPS } from './steps';

describe('STEPS', () => {
  it('顶栏顺序：字幕作为贴纸右侧的独立模块（HIG-15），改语言在最后', () => {
    expect(STEPS.map((s) => s.label)).toEqual(['剪辑', '音频', '文本', '贴纸', '字幕', '改语言']);
  });
  it('字幕 / 改语言模块沿用文字图层交互', () => {
    expect(layerTypeForStep('trim')).toBeNull();
    expect(layerTypeForStep('audio')).toBeNull();
    expect(layerTypeForStep('text')).toBe('text');
    expect(layerTypeForStep('sticker')).toBe('sticker');
    expect(layerTypeForStep('subtitle')).toBe('text');
    expect(layerTypeForStep('localize')).toBe('text');
  });
  it('字幕模块同时管文字与遮盖层，其它模块只管自己那一类', () => {
    expect(layerTypesForStep('subtitle')).toEqual(['text', 'mask']);
    expect(layerTypesForStep('text')).toEqual(['text']);
    expect(layerTypesForStep('sticker')).toEqual(['sticker']);
    expect(layerTypesForStep('trim')).toEqual([]);
    expect(layerTypesForStep('audio')).toEqual([]);
  });
});

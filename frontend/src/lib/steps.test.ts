import { describe, expect, it } from 'vitest';
import { layerTypeForStep, STEPS } from './steps';

describe('STEPS', () => {
  it('顶栏顺序：字幕作为贴纸右侧的独立模块（HIG-15）', () => {
    expect(STEPS.map((s) => s.label)).toEqual(['剪辑', '音频', '文本', '贴纸', '字幕']);
  });
  it('字幕模块沿用文字图层交互', () => {
    expect(layerTypeForStep('trim')).toBeNull();
    expect(layerTypeForStep('audio')).toBeNull();
    expect(layerTypeForStep('text')).toBe('text');
    expect(layerTypeForStep('sticker')).toBe('sticker');
    expect(layerTypeForStep('subtitle')).toBe('text');
  });
});

import { describe, expect, it } from 'vitest';
import { layerTypeForStep, STEPS } from './steps';

describe('STEPS', () => {
  it('顶栏顺序：剪辑 / 音频 / 文本 / 贴纸（HIG-10 音频在剪辑右侧）', () => {
    expect(STEPS.map((s) => s.label)).toEqual(['剪辑', '音频', '文本', '贴纸']);
  });
  it('只有文本、贴纸模块管理图层', () => {
    expect(layerTypeForStep('trim')).toBeNull();
    expect(layerTypeForStep('audio')).toBeNull();
    expect(layerTypeForStep('text')).toBe('text');
    expect(layerTypeForStep('sticker')).toBe('sticker');
  });
});

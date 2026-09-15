import { describe, expect, it } from 'vitest';
import { fontChoices, galleryItemKey, galleryLayerSeed, groupPresets } from './textGallery';
import { BUILTIN_FONT_FAMILY } from './fonts';
import type { Asset, TextStylePreset } from '../types';

const preset = (id: string, background: string | null = null): TextStylePreset => ({ id, name: id, style: { color: '#FFFFFF', background } });
const font = (id: string, family?: string, status?: Asset['status']): Asset =>
  ({ id, type: 'font', name: `${id}.ttf`, url: `/a/${id}`, family, status, source: 'upload', created_at: '' }) as Asset;

describe('groupPresets', () => {
  it('带背景的归气泡，其余归花字，保持原顺序', () => {
    const g = groupPresets([preset('a'), preset('b', '#000000B3'), preset('c'), preset('d', '#D9481FFF')]);
    expect(g.text.map((p) => p.id)).toEqual(['a', 'c']);
    expect(g.bubble.map((p) => p.id)).toEqual(['b', 'd']);
  });
});

describe('fontChoices', () => {
  it('内置字体排第一，只收就绪且有 family 的字体素材，按 family 去重', () => {
    const assets = [
      font('f1', '站酷快乐体'),
      font('f2', '站酷快乐体'),
      font('f3'),
      font('f4', '阿里巴巴普惠体', 'preparing'),
      font('f5', BUILTIN_FONT_FAMILY),
      { ...font('s1', '贴纸'), type: 'sticker' } as Asset,
      font('f6', '得意黑'),
    ];
    expect(fontChoices(assets)).toEqual([
      { family: BUILTIN_FONT_FAMILY, builtin: true },
      { family: '站酷快乐体', builtin: false },
      { family: '得意黑', builtin: false },
    ]);
  });
  it('没有上传字体时只有内置字体', () => {
    expect(fontChoices([])).toEqual([{ family: BUILTIN_FONT_FAMILY, builtin: true }]);
  });
});

describe('galleryLayerSeed', () => {
  it('字体卡只带 font_family，默认文字是字体名', () => {
    expect(galleryLayerSeed({ kind: 'font', font: { family: '得意黑', builtin: false } })).toEqual({ style: { font_family: '得意黑' }, text: '得意黑' });
  });
  it('花字 / 气泡卡带预设样式的副本，默认文字按分组', () => {
    const p = preset('x');
    const seed = galleryLayerSeed({ kind: 'preset', preset: p });
    expect(seed).toEqual({ style: { color: '#FFFFFF', background: null }, text: '花字' });
    expect(seed.style).not.toBe(p.style);
    expect(galleryLayerSeed({ kind: 'preset', preset: preset('y', '#000000B3') }).text).toBe('气泡文字');
  });
});

describe('galleryItemKey', () => {
  it('字体与预设的 key 不会互相冲突', () => {
    expect(galleryItemKey({ kind: 'font', font: { family: 'x', builtin: false } })).toBe('font:x');
    expect(galleryItemKey({ kind: 'preset', preset: preset('x') })).toBe('preset:x');
  });
});

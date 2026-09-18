import { describe, expect, it } from 'vitest';
import { fontChoices, galleryItemKey, galleryLayerSeed, groupPresets, missingCatalogFonts, searchFontChoices, type FontChoice } from './textGallery';
import { BUILTIN_FONT_FAMILY } from './fonts';
import type { Asset, TextStylePreset } from '../types';

const preset = (id: string, background: string | null = null): TextStylePreset => ({ id, name: id, style: { color: '#FFFFFF', background } });
const font = (id: string, family?: string, status?: Asset['status']): Asset =>
  ({ id, type: 'font', name: `${id}.ttf`, url: `/a/${id}`, family, status, source: 'upload', created_at: '' }) as Asset;
const choice = (family: string): FontChoice => ({ family, label: family, style: '已上传', sample: '字体', group: 'uploaded', builtin: false });

describe('groupPresets', () => {
  it('带背景的归气泡，其余归花字，保持原顺序', () => {
    const g = groupPresets([preset('a'), preset('b', '#000000B3'), preset('c'), preset('d', '#D9481FFF')]);
    expect(g.text.map((p) => p.id)).toEqual(['a', 'c']);
    expect(g.bubble.map((p) => p.id)).toEqual(['b', 'd']);
  });
});

describe('fontChoices', () => {
  it('开放网页字体可直接选择，其余五款需官方文件', () => {
    const choices = fontChoices([]);
    expect(choices).toHaveLength(11);
    expect(choices.map((f) => f.label)).toContain('抖音美好体');
    expect(choices.map((f) => f.label)).toContain('霞鹜文楷');
    expect(missingCatalogFonts([]).map((f) => f.label)).toEqual(['方正黑体', '方正书宋', '方正楷体', '方正仿宋', '站酷高端黑']);
  });
  it('网页字体排在前面，只收就绪字体素材，并按 family 去重', () => {
    const assets = [
      font('f1', '站酷快乐体'),
      font('f2', '站酷快乐体'),
      font('f3'),
      font('f4', '阿里巴巴普惠体', 'preparing'),
      font('f5', BUILTIN_FONT_FAMILY),
      { ...font('s1', '贴纸'), type: 'sticker' } as Asset,
      font('f6', '得意黑'),
    ];
    const choices = fontChoices(assets);
    expect(choices[0].family).toBe(BUILTIN_FONT_FAMILY);
    expect(choices.filter((f) => f.family === '站酷快乐体')).toEqual([choice('站酷快乐体')]);
    expect(choices.filter((f) => f.family === '得意黑')).toEqual([choice('得意黑')]);
    expect(choices.some((f) => f.family === '阿里巴巴普惠体')).toBe(false);
  });
  it('已选的文件字体仅在上传后出现，未上传时列为待补齐', () => {
    expect(fontChoices([]).some((f) => f.label === '方正黑体')).toBe(false);
    expect(missingCatalogFonts([]).some((f) => f.label === '方正黑体')).toBe(true);
    expect(fontChoices([font('f1', '方正黑体简体')]).find((f) => f.label === '方正黑体')?.family).toBe('方正黑体简体');
    expect(missingCatalogFonts([font('f1', '方正黑体简体')]).some((f) => f.label === '方正黑体')).toBe(false);
  });
  it('字体搜索支持名称、中文风格和别名', () => {
    const choices = fontChoices([font('f1', '方正黑体简体')]);
    expect(searchFontChoices(choices, '方正 黑体').map((f) => f.label)).toEqual(['方正黑体']);
    expect(searchFontChoices(choices, '英文手写').map((f) => f.label)).toEqual(['Caveat']);
  });
});

describe('galleryLayerSeed', () => {
  it('字体卡只带 font_family，默认文字是字体名', () => {
    expect(galleryLayerSeed({ kind: 'font', font: choice('得意黑') })).toEqual({ style: { font_family: '得意黑' }, text: '得意黑' });
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
    expect(galleryItemKey({ kind: 'font', font: choice('x') })).toBe('font:x');
    expect(galleryItemKey({ kind: 'preset', preset: preset('x') })).toBe('preset:x');
  });
});

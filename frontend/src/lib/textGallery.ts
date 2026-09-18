// 文本面板「文字」页（HIG-11）：字体 / 花字 / 气泡三组卡片的数据，以及双击卡片新建图层时带的样式。
// 纯函数，组件只负责渲染与交互。

import type { Asset, TextStyle, TextStylePreset } from '../types';
import { FONT_CATALOG, catalogFontFor, fontMatchesQuery, type FontGroup } from './fontCatalog';

/** 预设分组：带背景的算「气泡」，其余算「花字」。 */
export type PresetGroup = 'text' | 'bubble';

export const presetGroup = (p: TextStylePreset): PresetGroup => (p.style.background ? 'bubble' : 'text');

export function groupPresets(presets: TextStylePreset[]): Record<PresetGroup, TextStylePreset[]> {
  const out: Record<PresetGroup, TextStylePreset[]> = { text: [], bubble: [] };
  for (const p of presets) out[presetGroup(p)].push(p);
  return out;
}

export interface FontChoice {
  family: string;
  label: string;
  style: string;
  sample: string;
  group: FontGroup | 'uploaded';
  builtin: boolean;
  aliases?: string[];
}

const readyFontAssets = (assets: Asset[]) => assets.filter((a) => a.type === 'font' && a.family && (a.status ?? 'ready') === 'ready');

/** 内置网页字体和已加载的素材字体，按清单顺序排列并去重。 */
export function fontChoices(assets: Asset[]): FontChoice[] {
  const ready = readyFontAssets(assets);
  const seen = new Set<string>();
  const out: FontChoice[] = [];
  for (const entry of FONT_CATALOG) {
    const asset = ready.find((a) => catalogFontFor(a.family!) === entry);
    if (entry.delivery === 'asset' && !asset) continue;
    const family = entry.delivery === 'asset' ? asset!.family! : entry.family;
    seen.add(family);
    out.push({ family, label: entry.label, style: entry.style, sample: entry.sample, group: entry.group, builtin: entry.delivery === 'web' || asset?.source === 'builtin', aliases: entry.aliases });
  }
  for (const asset of ready) {
    const family = asset.family!;
    if (seen.has(family) || catalogFontFor(family)) continue;
    seen.add(family);
    out.push({ family, label: family, style: '已上传', sample: '字体', group: 'uploaded', builtin: asset.source === 'builtin' });
  }
  return out;
}

export function searchFontChoices(fonts: FontChoice[], query: string): FontChoice[] {
  return fonts.filter((font) => fontMatchesQuery(font, query));
}

export type GalleryItem = { kind: 'font'; font: FontChoice } | { kind: 'preset'; preset: TextStylePreset };

/** 双击卡片新建文字图层时带的初始样式与默认文字。 */
export function galleryLayerSeed(item: GalleryItem): { style: Partial<TextStyle>; text: string } {
  if (item.kind === 'font') return { style: { font_family: item.font.family }, text: item.font.label };
  return { style: { ...item.preset.style }, text: presetGroup(item.preset) === 'bubble' ? '气泡文字' : '花字' };
}

/** 卡片的稳定 key，用于高亮与 React key。 */
export const galleryItemKey = (item: GalleryItem): string => (item.kind === 'font' ? `font:${item.font.family}` : `preset:${item.preset.id}`);

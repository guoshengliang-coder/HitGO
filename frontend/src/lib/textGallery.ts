// 文本面板「文字」页（HIG-11）：字体 / 花字 / 气泡三组卡片的数据，以及双击卡片新建图层时带的样式。
// 纯函数，组件只负责渲染与交互。

import type { Asset, TextStyle, TextStylePreset } from '../types';
import { BUILTIN_FONT_FAMILY } from './fonts';

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
  builtin: boolean;
}

/** 字体候选：内置字体排第一，其后是已就绪、带 family 的上传字体，按 family 去重。 */
export function fontChoices(assets: Asset[]): FontChoice[] {
  const out: FontChoice[] = [{ family: BUILTIN_FONT_FAMILY, builtin: true }];
  const seen = new Set([BUILTIN_FONT_FAMILY]);
  for (const a of assets) {
    if (a.type !== 'font' || !a.family || (a.status ?? 'ready') !== 'ready' || seen.has(a.family)) continue;
    seen.add(a.family);
    out.push({ family: a.family, builtin: false });
  }
  return out;
}

export type GalleryItem = { kind: 'font'; font: FontChoice } | { kind: 'preset'; preset: TextStylePreset };

/** 双击卡片新建文字图层时带的初始样式与默认文字。 */
export function galleryLayerSeed(item: GalleryItem): { style: Partial<TextStyle>; text: string } {
  if (item.kind === 'font') return { style: { font_family: item.font.family }, text: item.font.family };
  return { style: { ...item.preset.style }, text: presetGroup(item.preset) === 'bubble' ? '气泡文字' : '花字' };
}

/** 卡片的稳定 key，用于高亮与 React key。 */
export const galleryItemKey = (item: GalleryItem): string => (item.kind === 'font' ? `font:${item.font.family}` : `preset:${item.preset.id}`);

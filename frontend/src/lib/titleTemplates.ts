// 「标题模板」：一键添加带样式预设、局部上色与相对位置的文字图层（对应剪映的文字模板）。
// 加入后就是普通文字图层，与模板不再联动；目前只有内置模板，不能保存用户模板。
// 每个组合对应 HIG-2 的一组案例；图层样式引用 textPresets 里的内置预设，只在这里补文案、位置与 spans。

import type { Anchor, TextLayer, TextSpan, TextStyle } from '../types';
import { defaultTextStyle } from '../types';
import { BUILTIN_TEXT_PRESETS } from './textPresets';

export interface TitleTemplateLayer {
  text: string;
  spans?: TextSpan[];
  /** textPresets 里的内置预设 id。 */
  preset: string;
  style?: Partial<TextStyle>;
  anchor: Anchor;
  margin: [number, number];
}

export interface TitleTemplate {
  id: string;
  name: string;
  note: string;
  layers: TitleTemplateLayer[];
}

const RED = '#E3312B';

export const TITLE_TEMPLATES: TitleTemplate[] = [
  {
    id: 'tpl:banner',
    name: '通栏黄底',
    note: '黄色通栏底 · 首行红字',
    layers: [{ text: '主标题\n副标题', spans: [{ start: 0, end: 3, color: RED }], preset: 'builtin:banner-yellow', anchor: 'top-center', margin: [0, 0.07] }],
  },
  {
    id: 'tpl:banner-round',
    name: '圆角黄底',
    note: '黄色圆角底 · 关键词红字',
    layers: [{ text: '主标题\n副标题关键词', spans: [{ start: 7, end: 10, color: RED }], preset: 'builtin:banner-yellow-round', anchor: 'top-center', margin: [0, 0.09] }],
  },
  {
    id: 'tpl:title-subtitle',
    name: '大标题 + 副标题',
    note: '黄字黑边大标题 · 深底青字副标题',
    layers: [
      { text: '大标题', preset: 'builtin:yellow-title', anchor: 'top-center', margin: [0, 0.08] },
      { text: '副标题', preset: 'builtin:pill-subtitle', anchor: 'top-center', margin: [0, 0.185] },
    ],
  },
];

/** 把组合展开成可直接加入 spec 的文字图层（id 由调用方生成）。 */
export function templateToLayers(tpl: TitleTemplate, newId: () => string): TextLayer[] {
  return tpl.layers.map((l) => {
    const preset = BUILTIN_TEXT_PRESETS.find((p) => p.id === l.preset)?.style ?? {};
    const layer: TextLayer = {
      id: newId(),
      type: 'text',
      text: l.text,
      style: { ...defaultTextStyle(), ...preset, ...l.style },
      anchor: l.anchor,
      margin: [l.margin[0], l.margin[1]],
      width: 0.5,
      rotate: 0,
      opacity: 1,
      t: 'all',
    };
    if (l.spans?.length) layer.spans = l.spans.map((s) => ({ ...s }));
    return layer;
  });
}

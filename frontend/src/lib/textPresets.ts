// 内置文字样式预设。只给 Partial<TextStyle>：不带 align，font_size 可选（不设时套用后保留当前字号）。
// 用户自己保存的预设走 /api/presets（type=text_style），在 store 里与这些合并。

import type { TextStylePreset } from '../types';

export const BUILTIN_TEXT_PRESETS: TextStylePreset[] = [
  {
    id: 'builtin:white-black-stroke',
    name: '白字黑边',
    builtin: true,
    style: { color: '#FFFFFF', stroke_color: '#000000', stroke_width: 0.004, background: null, shadow: null, letter_spacing: 0 },
  },
  {
    id: 'builtin:yellow-title',
    name: '黄字黑边标题',
    builtin: true,
    style: { font_weight: 900, font_size: 0.07, color: '#FFD84D', stroke_color: '#1A1A1A', stroke_width: 0.006, background: null, shadow: null, letter_spacing: 0.02 },
  },
  {
    id: 'builtin:subtitle-bar',
    name: '黑底白字字幕条',
    builtin: true,
    style: { font_weight: 500, color: '#FFFFFF', stroke_color: '#000000', stroke_width: 0, background: '#000000B3', padding: 0.012, line_height: 1.3, shadow: null, letter_spacing: 0 },
  },
  {
    id: 'builtin:promo-red',
    name: '红底白字促销',
    builtin: true,
    style: { font_weight: 900, color: '#FFFFFF', stroke_color: '#000000', stroke_width: 0, background: '#D9481FFF', padding: 0.014, shadow: null, letter_spacing: 0.04 },
  },
  {
    id: 'builtin:hollow',
    name: '空心描边',
    builtin: true,
    style: { font_weight: 900, color: '#00000000', stroke_color: '#FFFFFF', stroke_width: 0.004, background: null, shadow: null, letter_spacing: 0.02 },
  },
  {
    id: 'builtin:drop-shadow',
    name: '投影浮起',
    builtin: true,
    style: { color: '#FFFFFF', stroke_color: '#000000', stroke_width: 0, background: null, shadow: { color: '#00000099', blur: 0.012, offset: [0.003, 0.005] }, letter_spacing: 0 },
  },
  {
    id: 'builtin:glow-title',
    name: '发光标题',
    builtin: true,
    style: { font_weight: 900, color: '#FFFFFF', stroke_color: '#000000', stroke_width: 0, background: null, shadow: null, glow: { color: '#FF7A1ACC', blur: 0.014 }, letter_spacing: 0 },
  },
  {
    id: 'builtin:bubble',
    name: '半透明气泡',
    builtin: true,
    style: { font_weight: 700, color: '#1A1A1A', stroke_color: '#000000', stroke_width: 0, background: '#FFFFFFCC', padding: 0.02, line_height: 1.25, shadow: { color: '#00000040', blur: 0.01, offset: [0, 0.003] }, letter_spacing: 0 },
  },
  // 以下三个来自 HIG-2 的标题案例（颜色取自截图近似值）
  {
    id: 'builtin:banner-yellow',
    name: '黄底通栏标题',
    builtin: true,
    style: { font_weight: 900, font_size: 0.05, color: '#111111', stroke_color: '#000000', stroke_width: 0, background: '#F7D308FF', background_width: 1, background_radius: 0, padding: 0.02, line_height: 1.2, shadow: null, letter_spacing: 0 },
  },
  {
    id: 'builtin:banner-yellow-round',
    name: '黄底圆角标题',
    builtin: true,
    style: { font_weight: 700, font_size: 0.035, color: '#111111', stroke_color: '#000000', stroke_width: 0, background: '#F7D308FF', background_width: 0.98, background_radius: 0.01, padding: 0.016, line_height: 1.25, shadow: null, letter_spacing: 0 },
  },
  {
    id: 'builtin:pill-subtitle',
    name: '深底青字副标题',
    builtin: true,
    style: { font_weight: 700, font_size: 0.028, color: '#86F5C4', stroke_color: '#000000', stroke_width: 0, background: '#000000A6', background_width: null, background_radius: 0.01, padding: 0.012, line_height: 1.2, shadow: null, letter_spacing: 0 },
  },
];

// 编辑器顶栏的功能模块（HIG-8；音频模块 HIG-10；字幕模块 HIG-15；改语言模块）。新增模块只需在 STEPS 里追加一项，
// 再在 EditorPage 的右栏里挂上对应面板；模块之间没有先后顺序。

import type { Layer } from '../types';

export type Step = 'trim' | 'audio' | 'text' | 'sticker' | 'subtitle' | 'localize';

export const STEPS: { key: Step; label: string }[] = [
  { key: 'trim', label: '剪辑' },
  { key: 'audio', label: '音频' },
  { key: 'text', label: '文本' },
  { key: 'sticker', label: '贴纸' },
  { key: 'subtitle', label: '字幕' },
  { key: 'localize', label: '改语言' },
];

/**
 * 该模块管理的图层类型（画布上可选中、时间线上有行、⌘V 能粘进来）；不管图层的模块（剪辑、音频）返回 []。
 * 字幕模块除了文字图层，还管遮住原字幕的遮盖层。
 */
export function layerTypesForStep(step: Step): Layer['type'][] {
  // 字幕导入后仍是带时段的文字图层；字幕模块沿用文字图层的画布与时间线交互。
  // 改语言套用后生成的译文字幕也是文字图层，同样沿用。
  if (step === 'text' || step === 'localize') return ['text'];
  if (step === 'subtitle') return ['text', 'mask'];
  if (step === 'sticker') return ['sticker'];
  return [];
}

/** 该模块的主图层类型（第一项）；不管图层的模块返回 null。 */
export function layerTypeForStep(step: Step): Layer['type'] | null {
  return layerTypesForStep(step)[0] ?? null;
}

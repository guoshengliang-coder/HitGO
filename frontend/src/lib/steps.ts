// 编辑器顶栏的功能模块（HIG-8；音频模块 HIG-10）。新增模块（字幕 / 本地化…）只需在 STEPS 里追加一项，
// 再在 EditorPage 的右栏里挂上对应面板；模块之间没有先后顺序。

import type { Layer } from '../types';

export type Step = 'trim' | 'audio' | 'text' | 'sticker';

export const STEPS: { key: Step; label: string }[] = [
  { key: 'trim', label: '剪辑' },
  { key: 'audio', label: '音频' },
  { key: 'text', label: '文本' },
  { key: 'sticker', label: '贴纸' },
];

/** 该模块管理的图层类型；不管图层的模块（剪辑、音频）返回 null。 */
export function layerTypeForStep(step: Step): Layer['type'] | null {
  if (step === 'text') return 'text';
  if (step === 'sticker') return 'sticker';
  return null;
}

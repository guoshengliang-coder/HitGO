// 编辑器顶栏的功能模块（HIG-8；音频模块 HIG-10；字幕模块 HIG-15；改语言模块；大字报 HIG-50）。新增模块只需在 STEPS 里追加一项，
// 再在 EditorPage 的右栏里挂上对应面板；模块之间没有先后顺序。

import type { Layer } from '../types';
import { layerLane } from './timelineTracks';

export type Step = 'trim' | 'audio' | 'text' | 'sticker' | 'subtitle' | 'localize' | 'poster';

export const STEPS: { key: Step; label: string }[] = [
  { key: 'trim', label: '剪辑' },
  { key: 'audio', label: '音频' },
  { key: 'text', label: '文本' },
  { key: 'sticker', label: '贴纸' },
  { key: 'subtitle', label: '字幕' },
  { key: 'localize', label: '改语言' },
  { key: 'poster', label: '大字报' },
];

/**
 * 该模块管理的图层类型（画布选中框、快捷操作与 ⌘V 使用）；不管图层的模块（剪辑、音频）返回 []。
 * 字幕模块除了文字图层，还管遮住原字幕的遮盖层。
 */
export function layerTypesForStep(step: Step): Layer['type'][] {
  // 字幕导入后仍是带时段的文字图层；字幕模块沿用文字图层的画布与时间线交互。
  // 改语言套用后生成的译文字幕、大字报的滚动文案也是文字图层，同样沿用。
  if (step === 'text' || step === 'localize' || step === 'poster') return ['text'];
  if (step === 'subtitle') return ['text', 'mask'];
  if (step === 'sticker') return ['sticker', 'shape'];
  return [];
}

/** 画布和时间线选中图层后，打开实际能编辑该对象的面板（HIG-72）。 */
export function stepForLayer(layer: Layer): Step {
  if (layer.type === 'sticker' || layer.type === 'shape') return 'sticker';
  if (layer.type === 'mask') return 'subtitle';
  if (layer.scroll) return 'poster';
  if (layerLane(layer) === 'subtitle') return 'subtitle';
  return 'text';
}

/** 该模块的主图层类型（第一项）；不管图层的模块返回 null。 */
export function layerTypeForStep(step: Step): Layer['type'] | null {
  return layerTypesForStep(step)[0] ?? null;
}

/** 批量应用可选的模块（与 store 的 ApplyModule 一致；放这里避免 lib 反向依赖 store）。 */
export type ApplyModuleKey = 'trim' | 'layers' | 'outputs' | 'audio' | 'cover';

/**
 * 批量应用弹窗默认勾中的模块跟随当前模块（docs/DESIGN.md §9.2）：
 * 音频只勾音频，改语言勾图层 + 音频，剪辑全勾，大字报勾剪辑（成片时长）+ 图层 + 音频（朗读轨），其余图层类模块只勾图层。弹窗里都能改。
 */
export function defaultApplyModules(step: Step): ApplyModuleKey[] {
  if (step === 'audio') return ['audio'];
  if (step === 'localize') return ['layers', 'audio'];
  if (step === 'poster') return ['trim', 'layers', 'audio'];
  if (step === 'trim') return ['trim', 'layers', 'outputs', 'audio', 'cover'];
  return ['layers'];
}

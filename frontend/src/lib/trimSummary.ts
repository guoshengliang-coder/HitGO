// 剪辑面板各分组折叠时显示在标题行右侧的摘要（HIG-17）。
// 分组一旦收起，摘要就是这块设置唯一的可见信息，所以逻辑放在这里单测，
// 组件只负责把它渲染出来（项目的 vitest 跑在 node 环境，没有组件测试）。

import { estimateOutputBytes, formatBytes, qualityOf, type Calibration } from './estimate';
import { formatSeconds, type Range } from './time';
import { bgBrightnessOf, blurOf, isDefaultBlurFill } from './blurFill';
import type { CoverSpec, FillMode, OutputQuality, OutputVariant } from '../types';

export const FILL_LABEL: Record<FillMode, string> = { blur: '模糊背景', color: '纯色', crop: '裁切' };
export const FILL_TIP: Record<FillMode, string> = {
  blur: '源画面完整缩放放进画幅，空出的部分用放大模糊的画面填满',
  color: '源画面完整缩放放进画幅，空出的部分填纯色',
  crop: '只取源画面里与画幅同比例的一个窗口铺满成片',
};
export const QUALITY_LABEL: Record<OutputQuality, string> = { standard: '标准', high: '高清' };
export const QUALITY_TIP = '标准 = 更快更小（veryfast / crf 20）；高清 = 更慢更清晰（medium / crf 19）';

/** 已删除区间：段数 + 删掉的总时长。一段都没删时返回空串（标题行只留个 0）。 */
export function rangesSummary(remove: Range[]): string {
  if (!remove.length) return '';
  const total = remove.reduce((s, r) => s + Math.max(0, r[1] - r[0]), 0);
  return `${remove.length} 段 · −${formatSeconds(total, 2)}`;
}

/** 封面：没有就是「无」，有就是它占的时长。 */
export function coverSummary(cover: CoverSpec | null | undefined, preroll: number): string {
  return cover ? formatSeconds(preroll, 1) : '无';
}

/** 成片画面：填充方式 · 清晰度 · 估算大小。源已是该画幅比例时不显示填充（那时面板里也没有这个选项）；模糊背景调过强度 / 亮度时带上数值。 */
export function frameSummary(
  out: Pick<OutputVariant, 'variant_key' | 'fill' | 'quality' | 'blur' | 'bg_brightness'>,
  duration: number,
  calibration?: Calibration,
  sameAspect = false,
): string {
  const parts = [QUALITY_LABEL[qualityOf(out)], `约 ${formatBytes(estimateOutputBytes(out, duration, calibration))}`];
  if (!sameAspect) parts.unshift(out.fill === 'blur' && !isDefaultBlurFill(out) ? `${FILL_LABEL.blur} ${blurOf(out)}/${bgBrightnessOf(out)}%` : FILL_LABEL[out.fill]);
  return parts.join(' · ');
}

/** 时长：没有封面时看剪后时长就够；有封面时成片更长，直接给成片时长。 */
export function durationSummary(postDuration: number, preroll: number): string {
  return preroll > 0 ? `成片 ${formatSeconds(postDuration + preroll, 2)}` : `剪后 ${formatSeconds(postDuration, 2)}`;
}

// 成片大小估算：按输出变体的编码档位（契约第 6 节）查码率表，乘以剪后时长。
// 只是给用户一个数量级参考；有已完成任务时可用 calibrationFromJobs 按实际码率校准。

import type { Job, OutputQuality, OutputVariant, VariantKey } from '../types';

/** 视频码率表（kbps）：以 9:16 / 16:9 全画幅为基准。 */
const VIDEO_KBPS: Record<OutputQuality, number> = { standard: 4000, high: 7500 };
/** 画幅系数：像素更少的画幅码率按比例折减。 */
const ASPECT_FACTOR: Record<VariantKey, number> = { '9x16': 1, '16x9': 1, '1x1': 0.6, '4x5': 0.75 };
const AUDIO_KBPS = 128;

export type Calibration = Partial<Record<OutputQuality, number>>;

export function qualityOf(variant: Pick<OutputVariant, 'quality'>): OutputQuality {
  return variant.quality === 'high' ? 'high' : 'standard';
}

/** 估算单个输出变体的成片字节数（含 128 kbps 音频）。 */
export function estimateOutputBytes(
  variant: Pick<OutputVariant, 'variant_key' | 'quality'>,
  postDuration: number,
  calibration?: Calibration,
): number {
  const dur = Math.max(0, postDuration || 0);
  if (!dur) return 0;
  const q = qualityOf(variant);
  const cal = calibration?.[q];
  const factor = ASPECT_FACTOR[variant.variant_key] ?? 1;
  // 校准值来自成片总码率（含音频），已经按实际画幅折算，只再按画幅系数缩放视频部分
  const videoKbps = cal && cal > 0 ? Math.max(0, cal - AUDIO_KBPS) : VIDEO_KBPS[q];
  const kbps = videoKbps * factor + AUDIO_KBPS;
  return Math.round((kbps * 1000 * dur) / 8);
}

/** 从已完成任务里按档位平均出实际码率（kbps，含音频）。没有样本的档位不返回。 */
export function calibrationFromJobs(jobs: Job[], qualityOfJob?: (j: Job) => OutputQuality): Calibration {
  const sum: Record<OutputQuality, { kbps: number; n: number }> = { standard: { kbps: 0, n: 0 }, high: { kbps: 0, n: 0 } };
  for (const j of jobs) {
    if (j.status !== 'done' || !j.output || !j.output.duration || !j.output.size) continue;
    const q = qualityOfJob ? qualityOfJob(j) : qualityFromCallback(j);
    const factor = ASPECT_FACTOR[j.variant_key as VariantKey] ?? 1;
    const total = (j.output.size * 8) / j.output.duration / 1000;
    // 归一到全画幅基准：视频部分除以画幅系数
    const normalized = Math.max(0, total - AUDIO_KBPS) / factor + AUDIO_KBPS;
    sum[q].kbps += normalized;
    sum[q].n += 1;
  }
  const out: Calibration = {};
  for (const q of ['standard', 'high'] as OutputQuality[]) {
    if (sum[q].n) out[q] = Math.round(sum[q].kbps / sum[q].n);
  }
  return out;
}

/** 从 job.callback.edit_spec 里找该变体的 quality；找不到按 standard。 */
function qualityFromCallback(j: Job): OutputQuality {
  const spec = j.callback?.edit_spec as { outputs?: OutputVariant[] } | undefined;
  const o = spec?.outputs?.find((x) => x.variant_key === j.variant_key);
  return o ? qualityOf(o) : 'standard';
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// 封面（契约 §2 cover，HIG-9）：成片最前面插一段图片 / 视频，之后接剪辑后的正片。
// 图层与音轨的时段仍以正片为准，所以封面只是在播放头前面多出一段 [-N, 0)：
// 编辑器的 time（源时间）< 0 就表示正处在封面里，time + N 是封面自己的播放位置。

import type { Asset, CoverSpec } from '../types';
import { sourceToPost, type Range } from './time';

export const COVER_MIN_DURATION = 0.1;
export const COVER_MAX_DURATION = 10;
export const COVER_DEFAULT_DURATION = 1;

/** 能当封面的素材：贴纸库里的图片或视频。 */
export function isCoverAsset(asset: Asset | undefined): boolean {
  return !!asset && asset.type === 'sticker';
}

/** 图片封面时长：夹到 [0.1, 10]，保留一位小数；非法值回到默认 1 秒。 */
export function clampCoverDuration(d: number | undefined): number {
  if (typeof d !== 'number' || !Number.isFinite(d)) return COVER_DEFAULT_DURATION;
  return Math.min(COVER_MAX_DURATION, Math.max(COVER_MIN_DURATION, Math.round(d * 10) / 10));
}

/**
 * 封面在成片里实际占的秒数，和 worker 同一套判断：没有封面、素材不在 / 不是贴纸、视频还没就绪 → 0（worker 跳过封面）；
 * 视频封面取素材自身时长；图片取 cover.duration。
 */
export function coverDuration(cover: CoverSpec | null | undefined, assets: Asset[]): number {
  if (!cover) return 0;
  const asset = assets.find((a) => a.id === cover.asset_id);
  if (!isCoverAsset(asset)) return 0;
  if (asset!.kind === 'video') {
    if ((asset!.status ?? 'ready') !== 'ready') return 0;
    return asset!.duration && asset!.duration > 0 ? asset!.duration : 0;
  }
  return clampCoverDuration(cover.duration);
}

/** 发给后端的 cover：没有就省略（保持旧 spec 形状），有就规范化时长。 */
export function contractCover(cover: CoverSpec | null | undefined): CoverSpec | undefined {
  if (!cover?.asset_id) return undefined;
  return { asset_id: cover.asset_id, duration: clampCoverDuration(cover.duration) };
}

/** 播放头在不在封面里（time 为源时间，封面段为负）。 */
export function inCover(time: number): boolean {
  return time < 0;
}

/** 封面自己的播放位置（秒）；不在封面里返回 null。 */
export function coverMediaTime(time: number, preroll: number): number | null {
  return time < 0 ? Math.max(0, time + preroll) : null;
}

/** 成片时间（含封面）：封面段 = time + N；正片段 = N + 剪后时间。时间码显示用。 */
export function outputTime(time: number, remove: Range[], preroll: number): number {
  if (time < 0) return Math.max(0, time + preroll);
  return preroll + sourceToPost(time, remove);
}

/** 时间轴横坐标（px）：封面块占最前面的 N·pps，正片的源时间整体右移。 */
export function timelineX(time: number, preroll: number, pps: number): number {
  return (time + preroll) * pps;
}

/** 时间轴横坐标 → 播放头时间，夹到 [-N, duration]。 */
export function timelineTime(x: number, preroll: number, pps: number, duration: number): number {
  const t = x / pps - preroll;
  return Math.min(duration, Math.max(-preroll, t));
}

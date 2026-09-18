// 把图片 / 视频拖进编辑器（HIG-46，视频 HIG-67）的纯逻辑：认格式、按落点算贴纸图层。
// 三个落点共用这一套：画布（按落点摆放）、时间线（落点时间作为出现起点）、贴纸面板（默认位置）。
// 都走现有的贴纸链路：上传成 type = sticker 的素材（图片 kind = image，视频 kind = video），
// 再加一个贴纸图层；后端与契约不变。

import { isVideoAsset, type Asset, type StickerLayer, type TimeWindow } from '../types';

/** 图片贴纸（HIG-46）。 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,.png,.jpg,.jpeg';
export const IMAGE_ACCEPT_TEXT = 'JPG / PNG';
/**
 * 拖进编辑器能收的叠加素材（HIG-67）：图片 + 视频，与素材库的 STICKER_ACCEPT 对齐。
 * 此前编辑器只认 JPG / PNG，而素材库早就收 mp4 / mov / webm，两处对不上。
 */
export const OVERLAY_ACCEPT = `${IMAGE_ACCEPT},image/webp,image/gif,video/mp4,video/quicktime,video/webm,.webp,.gif,.mp4,.mov,.webm`;
export const OVERLAY_ACCEPT_TEXT = 'JPG / PNG / WEBP / GIF / MP4 / MOV / WEBM';

/** 与「贴纸」面板点选添加一致的默认值。 */
export const STICKER_DEFAULTS = { anchor: 'top-left', margin: [0.08, 0.12], width: 0.35 } as const;

/** 参考画布（9:16，1080×1920）的宽高比；图层几何按它存（契约 §2）。 */
const REF_ASPECT = 1080 / 1920;
/** 一次拖进多张时，每张往右下错开这么多（相对画布），免得完全叠在一起。 */
export const CASCADE_STEP = 0.03;
const MIN_WINDOW = 0.1;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 新贴纸图层；视频素材默认循环（与贴纸面板一致）。 */
export function newStickerLayer(id: string, asset: Pick<Asset, 'id' | 'kind'>, over: Partial<Pick<StickerLayer, 'anchor' | 'margin' | 'width' | 't'>> = {}): StickerLayer {
  const layer: StickerLayer = {
    id,
    type: 'sticker',
    asset_id: asset.id,
    anchor: over.anchor ?? STICKER_DEFAULTS.anchor,
    margin: over.margin ?? [STICKER_DEFAULTS.margin[0], STICKER_DEFAULTS.margin[1]],
    width: over.width ?? STICKER_DEFAULTS.width,
    rotate: 0,
    opacity: 1,
    t: over.t ?? 'all',
  };
  if (isVideoAsset(asset as Asset)) layer.playback = 'loop';
  return layer;
}

/** 素材宽高比（宽 / 高），未知时按 1。 */
export function assetAspect(asset: Pick<Asset, 'width' | 'height'> | undefined): number {
  const w = asset?.width ?? 0;
  const h = asset?.height ?? 0;
  return w > 0 && h > 0 ? w / h : 1;
}

/**
 * 画布落点 → 左上锚点的 margin：图片中心对准落点（相对画布 0–1），再整体收进画布内。
 * index 为同一次拖入里的第几张，依次往右下错开。
 */
export function canvasDropMargin(point: { x: number; y: number }, aspect: number, index = 0, width: number = STICKER_DEFAULTS.width): [number, number] {
  const w = width;
  const h = (width * REF_ASPECT) / (aspect > 0 ? aspect : 1);
  const cx = clamp(point.x, 0, 1) + index * CASCADE_STEP;
  const cy = clamp(point.y, 0, 1) + index * CASCADE_STEP;
  return [round3(clamp(cx - w / 2, 0, Math.max(0, 1 - w))), round3(clamp(cy - h / 2, 0, Math.max(0, 1 - h)))];
}

/** 面板里添加（没有落点）时的默认 margin，多张依次错开。 */
export function defaultMargin(index = 0): [number, number] {
  return [round3(STICKER_DEFAULTS.margin[0] + index * CASCADE_STEP), round3(STICKER_DEFAULTS.margin[1] + index * CASCADE_STEP)];
}

/**
 * 时间线落点 → 贴纸出现时段（剪后时间）：落在开头（< 0.05 s）为「全程」，与点选添加一致；
 * 其余从落点一直显示到片尾。落点太靠后、剩下不够 0.1 s 时往前挪。
 */
export function timelineDropWindow(start: number, postDuration: number): TimeWindow {
  const post = Math.max(0, postDuration);
  if (post <= MIN_WINDOW) return 'all';
  const a = round2(Math.min(Math.max(0, start), post - MIN_WINDOW));
  if (a < 0.05) return 'all';
  return [a, round2(post)];
}

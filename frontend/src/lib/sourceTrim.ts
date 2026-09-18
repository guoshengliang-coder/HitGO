// 素材内裁剪（契约 §2，HIG-67）的纯逻辑：把 source_in / source_out 夹到素材时长内，
// 算出图层实际用到的那一段。预览对时、属性面板的入点 / 出点输入、替换素材三处共用。
//
// 必须和后端 filtergraph.resolve_source_trim 得出同一段，否则预览与成片不一致：
// 两边都是「夹取 source_out 到素材时长；夹完不足一帧就整个丢弃裁剪，按整段处理」。

import type { StickerLayer } from '../types';

/** 契约给编辑器的下限：schema 会拒绝更短的裁剪（backend MIN_SOURCE_SEGMENT）。 */
export const MIN_SOURCE_SEGMENT = 0.1;
/** 后端 filtergraph.MIN_SEGMENT：夹取后短于它的裁剪被丢弃，两边要一致。 */
const MIN_RENDERABLE = 0.01;

export interface SourceSegment {
  /** 素材内入点（秒）。 */
  start: number;
  /** 素材内出点（秒）。 */
  end: number;
  /** end - start；播放 / 循环都按它算。 */
  length: number;
  /** 这一段是不是裁出来的（false = 整个素材，spec 里不带这两个字段）。 */
  trimmed: boolean;
}

type Trim = Pick<StickerLayer, 'source_in' | 'source_out'>;

/** 图层实际用到的素材片段；没有裁剪、或夹取后不足一帧时就是整个素材。 */
export function sourceSegment(layer: Trim | undefined, mediaDuration: number): SourceSegment {
  const media = Math.max(0, mediaDuration || 0);
  const whole = { start: 0, end: media, length: media, trimmed: false };
  const rawIn = layer?.source_in;
  const rawOut = layer?.source_out;
  if (rawIn == null && rawOut == null) return whole;
  const start = Math.max(0, rawIn ?? 0);
  let end = rawOut ?? media;
  if (media > 0) end = Math.min(end, media);
  if (end - start < MIN_RENDERABLE) return whole; // 与后端一致：裁空了就当没裁
  return { start, end, length: end - start, trimmed: true };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 改入点：留够 MIN_SOURCE_SEGMENT 给出点，且不越过素材头。 */
export function clampSourceIn(value: number, end: number, mediaDuration: number): number {
  const media = Math.max(0, mediaDuration || 0);
  const hi = Math.max(0, Math.min(end, media) - MIN_SOURCE_SEGMENT);
  return round2(clamp(Number.isFinite(value) ? value : 0, 0, hi));
}

/** 改出点：留够 MIN_SOURCE_SEGMENT 给入点，且不越过素材尾。 */
export function clampSourceOut(value: number, start: number, mediaDuration: number): number {
  const media = Math.max(0, mediaDuration || 0);
  const lo = Math.max(0, start) + MIN_SOURCE_SEGMENT;
  const hi = media > 0 ? media : Math.max(lo, value);
  return round2(clamp(Number.isFinite(value) ? value : hi, lo, Math.max(lo, hi)));
}

/**
 * 换素材（HIG-67「替换素材」）后的裁剪：按新素材的时长收紧。
 * 新素材短到放不下原来那一段时，整个去掉裁剪（从头播），而不是留一段越界的值。
 * 返回要写进图层的补丁，两个字段都是 undefined 表示「不裁」。
 */
export function retrimForAsset(layer: Trim, newDuration: number): { source_in?: number; source_out?: number } {
  const seg = sourceSegment(layer, Number.POSITIVE_INFINITY); // 先拿到用户写的原值，不被旧素材时长夹
  if (!seg.trimmed) return {};
  const media = Math.max(0, newDuration || 0);
  if (media <= 0) return {}; // 新素材是图片或时长未知：裁剪没有意义
  // 入点不往回拉：用户要的是素材里的某一段，新素材放不下就整段播，
  // 而不是换成一段他没选过的内容（后端 resolve_source_trim 同理）。
  const start = seg.start;
  const end = Math.min(seg.end, media);
  if (start >= media || end - start < MIN_SOURCE_SEGMENT) return {};
  return { source_in: round2(start), source_out: round2(end) };
}

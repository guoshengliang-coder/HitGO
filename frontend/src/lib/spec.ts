// edit_spec 辅助：清洗本地字段、图层命名、安全区检查、收成单一 9:16 输出。

import type { Asset, EditSpec, Layer, OutputVariant, SafeZone, TextLayer } from '../types';
import { boxOverlapsRect, placeLayer } from './layout';
import { normalizeRanges } from './time';
import { getCachedText } from './textImage';
import { contractAudio } from './audioTracks';
import { contractCover } from './cover';

const LOCAL_LAYER_FIELDS = ['name', 'visible', 'locked', 'width_manual'] as const;

/** 发送给后端前剔除本地 UI 字段并规范化区间；audio / cover 块只在非缺省时带上，保持旧 spec 形状。 */
export function toContractSpec(spec: EditSpec, duration?: number): EditSpec {
  const audio = contractAudio(spec.audio);
  const cover = contractCover(spec.cover);
  return {
    ...(audio ? { audio } : {}),
    ...(cover ? { cover } : {}),
    spec_version: 1,
    trim: { remove: normalizeRanges(spec.trim.remove, duration).map(([a, b]) => [round3(a), round3(b)]) },
    layers: spec.layers.map((l) => {
      // 浅拷贝即可：style（含 shadow / letter_spacing）等嵌套对象原样透传
      const copy: Record<string, unknown> = { ...l };
      for (const f of LOCAL_LAYER_FIELDS) delete copy[f];
      // 没有局部上色时不发 spans，保持旧 spec 形状
      if (l.type === 'text' && !l.spans?.length) delete copy.spans;
      return copy as unknown as Layer;
    }),
    outputs: spec.outputs.map((o) => {
      const copy: OutputVariant = { ...o, quality: o.quality === 'high' ? 'high' : 'standard' };
      if (copy.fill !== 'color') delete copy.color;
      if (copy.fill !== 'crop') delete copy.crop;
      if (copy.layer_overrides && Object.keys(copy.layer_overrides).length === 0) delete copy.layer_overrides;
      return copy;
    }),
  };
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

let seq = 0;
export function newLayerId(): string {
  seq += 1;
  return `l_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function layerName(layer: Layer, assets: Asset[]): string {
  if (layer.name) return layer.name;
  if (layer.type === 'text') return layer.text.replace(/\n/g, ' ').slice(0, 12) || '文字';
  if (layer.type === 'mask') return '遮盖';
  const a = assets.find((x) => x.id === layer.asset_id);
  return a ? a.name.replace(/\.[a-z0-9]+$/i, '') : '贴纸';
}

/** 图层素材宽高比（宽/高）；未知时返回 1。遮盖层没有素材，按 9:16 画布把 width / height 换成比例。 */
export function layerAspect(layer: Layer, assets: Asset[]): number {
  if (layer.type === 'mask') {
    if (!(layer.width > 0) || !(layer.height > 0)) return 1;
    return (layer.width * 1080) / (layer.height * 1920);
  }
  if (layer.type === 'sticker') {
    const a = assets.find((x) => x.id === layer.asset_id);
    if (a?.width && a?.height) return a.width / a.height;
    return 1;
  }
  const t = layer as TextLayer;
  const cached = getCachedText(t);
  if (cached) return cached.width / cached.height;
  if (t.image_size && t.image_size[1] > 0) return t.image_size[0] / t.image_size[1];
  return 4;
}

/**
 * 编辑器只产出一个 9:16 输出（HIG-8）：把旧 spec 里的其他画幅变体和 layer_overrides 清掉。
 * - 有 9x16 变体：保留它的填充 / 颜色 / 裁切 / 清晰度；
 * - 没有：沿用第一个变体的填充 / 颜色 / 清晰度新建 9x16，裁切窗口是按别的画幅比算的，丢掉（回到居中）。
 * 已经是单一 9x16 且没有覆盖时原样返回同一个对象，调用方可以用 === 判断要不要写回。
 */
export function toSingleOutput(spec: EditSpec): EditSpec {
  const outs = spec.outputs ?? [];
  const only = outs.length === 1 ? outs[0] : null;
  if (only && only.variant_key === '9x16' && !(only.layer_overrides && Object.keys(only.layer_overrides).length)) return spec;
  const base = outs.find((o) => o.variant_key === '9x16');
  const src = base ?? outs[0];
  const next: OutputVariant = { variant_key: '9x16', aspect: '9:16', fill: src?.fill ?? 'blur', quality: src?.quality === 'high' ? 'high' : 'standard' };
  if (next.fill === 'color') next.color = src?.color ?? '#000000';
  if (base && next.fill === 'crop' && base.crop) next.crop = { ...base.crop };
  return { ...spec, outputs: [next] };
}

/** 与所选安全区重叠的图层数量（按 9:16 默认画布计算）。 */
export function countSafeZoneOverlaps(spec: EditSpec, zone: SafeZone | undefined, assets: Asset[]): number {
  if (!zone) return 0;
  const c = { W: 1080, H: 1920 };
  let n = 0;
  for (const layer of spec.layers) {
    if (layer.visible === false || layer.type === 'mask') continue; // 遮盖压在画面上，不算遮挡平台 UI
    const box = placeLayer(layer, layerAspect(layer, assets), c);
    if (zone.zones.some((r) => boxOverlapsRect(box, c, r))) n += 1;
  }
  return n;
}

/** 图层时段是否完全落在剪后时长之外（给提示用）。 */
export function layerOutsideDuration(layer: Layer, postDuration: number): boolean {
  if (layer.t === 'all') return false;
  return layer.t[0] >= postDuration;
}

export function cloneSpec(spec: EditSpec): EditSpec {
  return JSON.parse(JSON.stringify(spec)) as EditSpec;
}

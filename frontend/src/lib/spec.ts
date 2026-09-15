// edit_spec 辅助：清洗本地字段、图层命名、安全区检查、变体覆盖合并。

import type { Anchor, Asset, EditSpec, Layer, LayerOverride, OutputVariant, SafeZone, TextLayer } from '../types';
import { boxOverlapsRect, placeLayer } from './layout';
import { normalizeRanges } from './time';
import { getCachedText } from './textImage';

const LOCAL_LAYER_FIELDS = ['name', 'visible', 'locked', 'width_manual'] as const;

/** 发送给后端前剔除本地 UI 字段并规范化区间。 */
export function toContractSpec(spec: EditSpec, duration?: number): EditSpec {
  return {
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
  const a = assets.find((x) => x.id === layer.asset_id);
  return a ? a.name.replace(/\.[a-z0-9]+$/i, '') : '贴纸';
}

/** 图层素材宽高比（宽/高）；未知时返回 1。 */
export function layerAspect(layer: Layer, assets: Asset[]): number {
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

/** 合并变体覆盖后的图层放置参数。 */
export function effectivePlacement(layer: Layer, override?: LayerOverride) {
  return {
    anchor: (override?.anchor ?? layer.anchor) as Anchor,
    margin: (override?.margin ?? layer.margin) as [number, number],
    width: override?.width ?? layer.width,
    rotate: override?.rotate ?? layer.rotate,
    opacity: override?.opacity ?? layer.opacity,
  };
}

/** 与所选安全区重叠的图层数量（按 9:16 默认画布计算）。 */
export function countSafeZoneOverlaps(spec: EditSpec, zone: SafeZone | undefined, assets: Asset[]): number {
  if (!zone) return 0;
  const c = { W: 1080, H: 1920 };
  let n = 0;
  for (const layer of spec.layers) {
    if (layer.visible === false) continue;
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

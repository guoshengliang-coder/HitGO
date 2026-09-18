// edit_spec 辅助：清洗本地字段、图层命名、安全区检查、多画幅 outputs 规范化（HIG-29）。

import { VARIANT_DEFS, variantDef, type Asset, type EditSpec, type Layer, type OutputVariant, type SafeZone, type TextLayer, type VariantKey } from '../types';
import { boxOverlapsRect, placeLayer } from './layout';
import { normalizeRanges } from './time';
import { getCachedText } from './textImage';
import { contractAudio } from './audioTracks';
import { contractCover } from './cover';
import { contractAnimation } from './textAnimation';
import { cleanTrackName } from './trackNames';

const LOCAL_LAYER_FIELDS = ['locked', 'width_manual'] as const;

/** 发送给后端前剔除本地 UI 字段并规范化区间；audio / cover 块只在非缺省时带上，保持旧 spec 形状。 */
export function toContractSpec(spec: EditSpec, duration?: number): EditSpec {
  const audio = contractAudio(spec.audio);
  const cover = contractCover(spec.cover);
  // 成片时长（HIG-50）：只在正数时发送，null / 0 / 缺省 = 剪后时长，保持旧 spec 形状
  const fixedDuration = spec.trim.duration;
  return {
    ...(audio ? { audio } : {}),
    ...(cover ? { cover } : {}),
    ...(spec.sequence ? { sequence: spec.sequence } : {}),
    spec_version: 1,
    trim: {
      remove: normalizeRanges(spec.trim.remove, spec.sequence ? spec.sequence.clips.reduce((n, c) => n + c.out - c.in - (c.transition?.duration ?? 0), 0) : duration).map(([a, b]) => [round3(a), round3(b)]),
      ...(typeof fixedDuration === 'number' && fixedDuration > 0 ? { duration: round3(fixedDuration) } : {}),
    },
    layers: spec.layers.map((l) => {
      // 浅拷贝即可：style（含 shadow / letter_spacing）等嵌套对象原样透传
      const copy: Record<string, unknown> = { ...l };
      for (const f of LOCAL_LAYER_FIELDS) delete copy[f];
      if (!l.hidden) delete copy.hidden;
      // 轨道名（HIG-48）是契约字段：只在非空时发送
      const name = cleanTrackName(l.name);
      if (name) copy.name = name;
      else delete copy.name;
      // 素材内裁剪（HIG-67）只在非缺省时发：入点缺省 0，出点缺省素材时长，保持旧 spec 形状
      if (l.type === 'sticker') {
        if (!l.source_in) delete copy.source_in;
        if (l.source_out == null) delete copy.source_out;
      }
      // 没有局部上色时不发 spans，保持旧 spec 形状
      if (l.type === 'text' && !l.spans?.length) delete copy.spans;
      if (l.type === 'text' && !(l.variant_images && Object.keys(l.variant_images).length)) delete copy.variant_images;
      if (l.type === 'text') {
        const animation = contractAnimation(l.animation, l.t === 'all' ? null : l.t[1] - l.t[0]);
        if (animation) copy.animation = animation;
        else delete copy.animation;
        // 滚动（HIG-50）原样透传；null / 缺省不发。与 animation 互斥由后端校验（编辑器加滚动时清掉动画）
        if (!l.scroll) delete copy.scroll;
        // 逐字显现（HIG-45）的字位置 / 背景图只跟着 reveal 走，没有 reveal 时不发，保持旧 spec 形状
        if (!animation?.reveal || !l.glyph_layout) {
          delete copy.glyph_layout;
          delete copy.background_image;
        }
        if (!copy.background_image) delete copy.background_image;
      }
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
  const own = cleanTrackName(layer.name);
  if (own) return own;
  if (layer.type === 'text') return layer.text.replace(/\n/g, ' ').slice(0, 12) || '文字';
  if (layer.type === 'mask') return '遮盖';
  if (layer.type === 'shape') return ({ rect: '矩形', ellipse: '圆形', triangle: '三角形', line: '直线', arrow: '箭头', star: '星形' })[layer.shape];
  const a = assets.find((x) => x.id === layer.asset_id);
  return a ? a.name.replace(/\.[a-z0-9]+$/i, '') : '贴纸';
}

/** 图层素材宽高比（宽/高）；未知时返回 1。遮盖层没有素材，按 9:16 画布把 width / height 换成比例。 */
export function layerAspect(layer: Layer, assets: Asset[]): number {
  if (layer.type === 'mask') {
    if (!(layer.width > 0) || !(layer.height > 0)) return 1;
    return (layer.width * 1080) / (layer.height * 1920);
  }
  if (layer.type === 'shape') return (layer.width * 1080) / Math.max(1, layer.height * 1920);
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
 * 编辑器里 outputs 的形状（HIG-29）：保存的是「已配置的画幅」，导出时再勾选出哪些。
 * - 始终有 9x16（图层设计用的参考画布），排第一，其余按 VARIANT_DEFS 顺序；
 * - 同一画幅只留第一个，不认识的 variant_key 丢掉，aspect 与 key 对齐；
 * - 非 9x16 画幅没写 layer_fit 的（HIG-8 之前的旧 spec）改成跟随视频，旧的 layer_overrides 是按画布相对写的，一并清掉。
 * 没有变化时原样返回同一个对象，调用方可以用 === 判断要不要写回。
 */
export function normalizeOutputs(spec: EditSpec): EditSpec {
  const outs = spec.outputs ?? [];
  const byKey = new Map<VariantKey, OutputVariant>();
  for (const o of outs) {
    if (!VARIANT_DEFS.some((d) => d.key === o.variant_key) || byKey.has(o.variant_key)) continue;
    const next: OutputVariant = { ...o, aspect: variantDef(o.variant_key).aspect };
    if (o.variant_key === 'custom') {
      const { width, height } = variantDef('custom');
      next.width = Number.isInteger(o.width) && (o.width ?? 0) >= 2 && (o.width ?? 0) % 2 === 0 ? o.width : width;
      next.height = Number.isInteger(o.height) && (o.height ?? 0) >= 2 && (o.height ?? 0) % 2 === 0 ? o.height : height;
    } else {
      delete next.width;
      delete next.height;
    }
    if (o.variant_key !== '9x16' && !o.layer_fit) {
      next.layer_fit = 'video';
      delete next.layer_overrides;
    }
    byKey.set(o.variant_key, next);
  }
  if (!byKey.has('9x16')) {
    const src = outs[0];
    const base: OutputVariant = { variant_key: '9x16', aspect: '9:16', fill: src?.fill ?? 'blur', quality: src?.quality === 'high' ? 'high' : 'standard' };
    if (base.fill === 'color') base.color = src?.color ?? '#000000';
    byKey.set('9x16', base);
  }
  const next = VARIANT_DEFS.flatMap((d) => (byKey.has(d.key) ? [byKey.get(d.key)!] : []));
  return JSON.stringify(next) === JSON.stringify(outs) ? spec : { ...spec, outputs: next };
}

/** 新画幅的缺省设置：模糊铺底、跟随视频、清晰度随 9x16。 */
export function defaultVariant(key: VariantKey, spec: EditSpec): OutputVariant {
  const ref = spec.outputs.find((o) => o.variant_key === '9x16');
  const d = variantDef(key);
  const o: OutputVariant = { variant_key: key, aspect: d.aspect, fill: 'blur', quality: ref?.quality === 'high' ? 'high' : 'standard' };
  if (key === 'custom') { o.width = d.width; o.height = d.height; }
  if (key !== '9x16') o.layer_fit = 'video';
  return o;
}

/** 该画幅的配置；spec 里还没有时给出缺省（不写回）。 */
export function outputFor(spec: EditSpec, key: VariantKey): OutputVariant {
  return spec.outputs.find((o) => o.variant_key === key) ?? defaultVariant(key, spec);
}

/** 确保 keys 里的画幅都在 outputs 里（缺的按缺省补上），已有的原样保留。没补任何东西时返回同一个对象。 */
export function ensureVariants(spec: EditSpec, keys: VariantKey[]): EditSpec {
  const base = normalizeOutputs(spec);
  const missing = keys.filter((k) => !base.outputs.some((o) => o.variant_key === k));
  if (!missing.length) return base;
  return normalizeOutputs({ ...base, outputs: [...base.outputs, ...missing.map((k) => defaultVariant(k, base))] });
}

/** 该画幅是否勾选导出（HIG-35）；没写 export 时 9x16 勾选、其余不勾。 */
export function isExported(o: Pick<OutputVariant, 'variant_key' | 'export'>): boolean {
  return o.export ?? o.variant_key === '9x16';
}

/** spec 里勾选导出的画幅，按画幅顺序；一个都没有时回到 ['9x16']。 */
export function exportKeys(spec: EditSpec): VariantKey[] {
  const keys = VARIANT_DEFS.map((d) => d.key).filter((k) => {
    const o = spec.outputs.find((x) => x.variant_key === k);
    return o ? isExported(o) : false;
  });
  return keys.length ? keys : ['9x16'];
}

/** spec 里有没有明确写过导出勾选（HIG-35 之前的 spec 没有，导出弹窗会退回本机记住的勾选）。 */
export function hasExportChoice(spec: EditSpec): boolean {
  return spec.outputs.some((o) => typeof o.export === 'boolean');
}

/**
 * 把导出勾选写进 outputs：keys 里还没配置的画幅按缺省补上，每个画幅写明 export true / false。
 * keys 为空时按 ['9x16']（至少出一个）。纯函数，返回新 spec。
 */
export function setExportKeys(spec: EditSpec, keys: VariantKey[]): EditSpec {
  const want = keys.length ? keys : (['9x16'] as VariantKey[]);
  const base = ensureVariants(spec, want);
  return { ...base, outputs: base.outputs.map((o) => ({ ...o, export: want.includes(o.variant_key) })) };
}

/** 与所选安全区重叠的图层数量（按 9:16 默认画布计算）。 */
export function countSafeZoneOverlaps(spec: EditSpec, zone: SafeZone | undefined, assets: Asset[]): number {
  if (!zone) return 0;
  const c = { W: 1080, H: 1920 };
  let n = 0;
  for (const layer of spec.layers) {
    if (layer.hidden || layer.type === 'mask') continue; // 遮盖压在画面上，不算遮挡平台 UI
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

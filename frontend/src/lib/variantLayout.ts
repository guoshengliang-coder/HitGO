// 多画幅图层几何（HIG-29，契约第 2 节 outputs[].layer_fit）。
// 图层在 9x16 参考画布上设计；layer_fit = 'video' 的输出上，图层跟着视频画面走：
// 参考画布像素 → 源像素 → 目标画布像素，是一个等比缩放 k 加平移。
// 与 backend/app/services/layout.py、filtergraph.variant_fit_map 同一套规则，
// 两端共用 fixtures/variantLayoutCases.json 做 golden 测试，改规则时两边一起改。

import { outputSize, variantDef, type CropRect, type EditSpec, type FillMode, type Layer, type LayerOverride, type OutputVariant } from '../types';
import { marginFromBox, placeLayer, round4, type Canvas, type LayerBox, type Placement } from './layout';
import { clampTextWidth } from './textWrap';

export interface FrameSpec {
  fill: FillMode;
  crop?: CropRect | null;
  W: number;
  H: number;
}

export interface FitMap {
  k: number;
  ox: number;
  oy: number;
  refW: number;
  refH: number;
  W: number;
  H: number;
}

/** 源画面在画布上的位置：[源矩形 S, 画布矩形 D]（blur / color 为 contain，crop 为裁切窗口后 cover）。 */
export function frameRegion(f: FrameSpec, srcW: number, srcH: number): [LayerBox, LayerBox] {
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  let scale: number;
  if (f.fill === 'crop') {
    if (f.crop) {
      sx = f.crop.x * srcW;
      sy = f.crop.y * srcH;
      sw = Math.max(1, f.crop.w * srcW);
      sh = Math.max(1, f.crop.h * srcH);
    }
    scale = Math.max(f.W / sw, f.H / sh);
  } else {
    scale = Math.min(f.W / sw, f.H / sh);
  }
  const w = sw * scale;
  const h = sh * scale;
  return [
    { x: sx, y: sy, w: sw, h: sh },
    { x: (f.W - w) / 2, y: (f.H - h) / 2, w, h },
  ];
}

export function fitMap(ref: FrameSpec, target: FrameSpec, srcW: number, srcH: number): FitMap {
  const [s9, d9] = frameRegion(ref, srcW, srcH);
  const [sv, dv] = frameRegion(target, srcW, srcH);
  const sc9 = d9.w / s9.w;
  const scv = dv.w / sv.w;
  const k = scv / sc9;
  return {
    k,
    ox: dv.x + (s9.x - sv.x) * scv - d9.x * k,
    oy: dv.y + (s9.y - sv.y) * scv - d9.y * k,
    refW: ref.W,
    refH: ref.H,
    W: target.W,
    H: target.H,
  };
}

/** 参考画布映射到目标画布后、落在画布内的那一块（落空时退回整块画布）。 */
export function visibleBox(m: FitMap): LayerBox {
  const x0 = Math.max(0, m.ox);
  const y0 = Math.max(0, m.oy);
  const x1 = Math.min(m.W, m.ox + m.refW * m.k);
  const y1 = Math.min(m.H, m.oy + m.refH * m.k);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return { x: 0, y: 0, w: m.W, h: m.H };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 遮盖：整体映射，对准烧进画面的原字幕。 */
export function followMaskBox(ref: LayerBox, m: FitMap): LayerBox {
  return { x: m.ox + ref.x * m.k, y: m.oy + ref.y * m.k, w: ref.w * m.k, h: ref.h * m.k };
}

/**
 * 文字 / 贴纸：在可见视频区域内保持锚点，按 min(k, 1) 缩放，最后平移回画布内。aspect = 宽 / 高。
 * clamp = false（文字，HIG-37）不平移：框可以宽于画布、伸出画面，出画部分裁掉，与后端一致。
 */
export function followLayerBox(p: Placement, aspect: number, m: FitMap, clamp = true): LayerBox {
  const s = Math.min(m.k, 1);
  const w = p.width * m.refW * s;
  const h = aspect > 0 ? w / aspect : 0;
  const v = visibleBox(m);
  const placed = placeLayer({ ...p, width: w / v.w }, aspect, { W: v.w, H: v.h });
  const box = { x: v.x + placed.x, y: v.y + placed.y, w, h };
  return clamp ? clampInto(box, m.W, m.H) : box;
}

function clampInto(b: LayerBox, W: number, H: number): LayerBox {
  return {
    ...b,
    x: b.w <= W ? Math.min(Math.max(b.x, 0), W - b.w) : 0,
    y: b.h <= H ? Math.min(Math.max(b.y, 0), H - b.h) : 0,
  };
}

export function referenceOutput(spec: EditSpec): OutputVariant | undefined {
  return spec.outputs.find((o) => o.variant_key === '9x16');
}

function frameOf(o: OutputVariant | undefined): FrameSpec {
  if (!o) return { fill: 'blur', W: 1080, H: 1920 };
  const d = outputSize(o);
  return { fill: o.fill, crop: o.crop ?? null, W: d.width, H: d.height };
}

/** 参考 → 该输出的映射；该输出不跟随视频（或就是参考、或源尺寸未知）时返回 null。 */
export function variantFitMap(spec: EditSpec, variant: OutputVariant, srcW: number, srcH: number): FitMap | null {
  if (variant.layer_fit !== 'video' || !(srcW > 0 && srcH > 0)) return null;
  const ref = referenceOutput(spec);
  if (ref === variant || variant.variant_key === '9x16') return null;
  return fitMap(frameOf(ref), frameOf(variant), srcW, srcH);
}

/** 覆盖里有几何字段（anchor / margin / width / height）= 这个画幅上已手动微调，不再跟随。 */
export function overrideDetaches(o: LayerOverride | undefined): boolean {
  return !!o && (o.anchor !== undefined || o.margin !== undefined || o.width !== undefined || o.height !== undefined);
}

type Geometry = Placement & { height?: number; rotate: number; opacity: number };

/** 图层在某个输出上的有效几何（layer_overrides 合并后，相对该输出画布）。 */
export function effectiveGeometry(layer: Layer, variant: OutputVariant | undefined): Geometry {
  const o = variant?.layer_overrides?.[layer.id];
  return {
    anchor: o?.anchor ?? layer.anchor,
    margin: o?.margin ?? layer.margin,
    width: o?.width ?? layer.width,
    height: layer.type === 'mask' ? o?.height ?? layer.height : undefined,
    rotate: o?.rotate ?? layer.rotate,
    opacity: o?.opacity ?? layer.opacity,
  };
}

/** 该图层在这个输出上是否跟随视频画面。 */
export function layerFollows(spec: EditSpec, layer: Layer, variant: OutputVariant, srcW: number, srcH: number): boolean {
  return !!variantFitMap(spec, variant, srcW, srcH) && !overrideDetaches(variant.layer_overrides?.[layer.id]);
}

/**
 * 图层在某个输出画布上的像素框（未旋转）+ 旋转 / 不透明度。
 * aspect 是素材宽高比（宽 / 高），遮盖层忽略它、用 height。
 */
export function resolveLayerBox(spec: EditSpec, layer: Layer, variant: OutputVariant, aspect: number, srcW: number, srcH: number): LayerBox & { rotate: number; opacity: number } {
  const d = outputSize(variant);
  const canvas: Canvas = { W: d.width, H: d.height };
  const own = effectiveGeometry(layer, variant);
  const m = variantFitMap(spec, variant, srcW, srcH);
  const extra = { rotate: own.rotate, opacity: own.opacity };
  if (m && !overrideDetaches(variant.layer_overrides?.[layer.id])) {
    const ref = effectiveGeometry(layer, referenceOutput(spec));
    if (layer.type === 'mask') {
      const box = placeLayer(ref, (ref.width * m.refW) / ((ref.height ?? 0.12) * m.refH), { W: m.refW, H: m.refH });
      return { ...followMaskBox(box, m), ...extra };
    }
    return { ...followLayerBox(ref, aspect, m, layer.type !== 'text'), ...extra };
  }
  if (layer.type === 'mask') {
    return { ...placeLayer(own, (own.width * canvas.W) / ((own.height ?? 0.12) * canvas.H), canvas), ...extra };
  }
  return { ...placeLayer(own, aspect, canvas), ...extra };
}

/**
 * 把某个输出画布上的像素框（未旋转）写成该输出的覆盖：anchor / margin / width（遮盖加 height）一起写，
 * 于是这个图层在该画幅上脱离跟随（画布上拖动 / 缩放 / 对齐 / 微移都走这里）。rotate 只在给出时写。
 */
export function overrideFromBox(layer: Layer, box: LayerBox, anchor: Layer['anchor'], key: OutputVariant['variant_key'], rotate?: number, output?: OutputVariant): LayerOverride {
  const d = output ? outputSize(output) : variantDef(key);
  const c: Canvas = { W: d.width, H: d.height };
  const m = marginFromBox(box, anchor, c);
  const w = round4(Math.max(1, box.w) / c.W);
  const o: LayerOverride = { anchor, margin: [round4(m[0]), round4(m[1])], width: layer.type === 'text' ? clampTextWidth(w) : w };
  if (layer.type === 'mask') o.height = round4(Math.max(1, box.h) / c.H);
  if (rotate !== undefined) o.rotate = Math.round(rotate * 10) / 10;
  return o;
}

/** 输出画布上的像素框 → 对齐 / 换锚点用的 Placement（相对该画布）与宽高比。 */
export function placementOfBox(box: LayerBox, anchor: Layer['anchor'], key: OutputVariant['variant_key'], output?: OutputVariant): { placement: Placement; aspect: number; canvas: Canvas } {
  const d = output ? outputSize(output) : variantDef(key);
  const canvas: Canvas = { W: d.width, H: d.height };
  return { placement: { anchor, margin: marginFromBox(box, anchor, canvas), width: box.w / canvas.W }, aspect: box.h > 0 ? box.w / box.h : 1, canvas };
}

import { STICKER_DEFAULTS } from './imageDrop';
import type { Anchor, Layer } from '../types';

export type PlacementPatch = {
  anchor: Anchor;
  margin: [number, number];
  width: number;
  height?: number;
  rotate: number;
};

/** 等比收进画布并居中；有独立高度的遮盖/形状同步写回高度。 */
export function fitLayerToCanvas(layer: Layer, aspect: number, canvas: { W: number; H: number }): PlacementPatch {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const width = Math.min(1, (canvas.H * safeAspect) / canvas.W);
  const patch: PlacementPatch = { anchor: 'center', margin: [0, 0], width, rotate: 0 };
  if (layer.type === 'mask' || layer.type === 'shape') patch.height = (width * canvas.W) / safeAspect / canvas.H;
  return patch;
}

/** 只重置位置/尺寸/旋转，保留文字、素材、样式、时段和动画。 */
export function resetLayerPlacement(layer: Layer): PlacementPatch {
  if (layer.type === 'sticker') {
    return { anchor: STICKER_DEFAULTS.anchor, margin: [...STICKER_DEFAULTS.margin], width: STICKER_DEFAULTS.width, rotate: 0 };
  }
  if (layer.type === 'mask') {
    return { anchor: 'bottom-center', margin: [0, 0.1], width: 1, height: 0.12, rotate: 0 };
  }
  if (layer.type === 'shape') {
    return { anchor: 'center', margin: [0, 0], width: 0.3, height: 0.2, rotate: 0 };
  }
  return { anchor: 'center', margin: [0, 0], width: 0.5, rotate: 0 };
}

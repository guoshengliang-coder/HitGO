import type { Layer } from '../types';

export type LayerLane = 'subtitle' | 'text' | 'other';

/** Existing subtitle cues are text layers, so classify by their origin marker. */
export function layerLane(layer: Layer): LayerLane {
  if (layer.type === 'mask') return 'subtitle';
  if (layer.type !== 'text') return 'other';
  if (layer.origin === 'subtitle' || layer.origin === 'localize' || /^字幕\s*\d+/.test(layer.name ?? '')) return 'subtitle';
  return 'text';
}

import type { Layer } from '../types';
import { layerLane } from './timelineTracks';
import { packSubtitleRows, subtitleSourceKey } from './subtitleRows';

export interface VisualTrackRow {
  key: string;
  label: string;
  kind: 'single' | 'subtitle';
  items: { l: Layer; i: number }[];
}

/** Existing z order is authoritative. Pack only consecutive, non-overlapping cues.
 * An intervening layer or overlapping cue is a z boundary, even if it is hidden. */
export function visualTrackRows(layers: Layer[], duration: number, name: (l: Layer) => string): VisualTrackRow[] {
  const rows: VisualTrackRow[] = [];
  let spanStart = Infinity, spanEnd = -Infinity;
  for (const [i, l] of layers.entries()) {
    const subtitle = l.type === 'text' && layerLane(l) === 'subtitle';
    const previous = rows[rows.length - 1];
    const window = (item: Layer): [number, number] => item.t === 'all' ? [0, duration] : item.t;
    const [a, b] = window(l);
    const joins = subtitle && previous?.kind === 'subtitle'
      && subtitleSourceKey(previous.items[0].l) === subtitleSourceKey(l)
      && previous.items[0].l.group === l.group
      && (a >= spanEnd || b <= spanStart || previous.items.every(({ l: other }) => { const [x, y] = window(other); return b <= x || a >= y; }));
    if (joins) { previous.items.push({ l, i }); spanStart = Math.min(spanStart, a); spanEnd = Math.max(spanEnd, b); }
    else { spanStart = a; spanEnd = b; rows.push({ key: `visual:${l.id}`, label: name(l), kind: subtitle ? 'subtitle' : 'single', items: [{ l, i }] }); }
  }
  for (const row of rows) {
    if (row.kind === 'subtitle') row.label = packSubtitleRows(row.items, duration)[0].label;
  }
  return rows.reverse(); // topmost picture first
}

/** Move a whole displayed row without changing any layer object or its edit parameters.
 * before/after are screen directions: before means ABOVE the destination. */
export function moveVisualRow(layers: Layer[], ids: string[], targetIds: string[], side: 'before' | 'after'): Layer[] {
  const selected = new Set(ids);
  const targets = new Set(targetIds);
  const moving = layers.filter(l => selected.has(l.id));
  if (!moving.length || moving.length !== selected.size || moving.some(l => l.locked) || ids.some(id => targets.has(id))) return layers;
  const rest = layers.filter(l => !selected.has(l.id));
  const indices = rest.flatMap((l, i) => targets.has(l.id) ? [i] : []);
  if (!indices.length || indices.length !== targets.size) return layers;
  const at = side === 'before' ? Math.max(...indices) + 1 : Math.min(...indices);
  const result = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return result.every((l, i) => l === layers[i]) ? layers : result;
}

/** Default insertion only: never sort an existing project's array. */
export function defaultVisualIndex(layers: Layer[], layer: Layer): number {
  const rank = (l: Layer) => l.type === 'mask' ? 0 : l.type === 'text' ? 1 : l.type === 'sticker' ? 2 : 3;
  const at = layers.findIndex(l => rank(l) > rank(layer));
  return at < 0 ? layers.length : at;
}

/** A canvas per mask boundary, not per subtitle cue. DOM masks can sit between
 * canvas runs and blur exactly the lower picture, matching the renderer's z order. */
export function previewLayerRuns(layers: Layer[]): { key: string; order: number; layers: Layer[] }[] {
  const runs: { key: string; order: number; layers: Layer[] }[] = [];
  layers.forEach((layer, i) => {
    const previous = runs[runs.length - 1];
    if (layer.type !== 'mask' && previous && previous.layers[0].type !== 'mask') previous.layers.push(layer);
    else runs.push({ key: layer.id, order: 10 + i * 2, layers: [layer] });
  });
  return runs;
}

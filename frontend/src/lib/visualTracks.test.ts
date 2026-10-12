import { describe, expect, it } from 'vitest';
import type { Layer } from '../types';
import { defaultVisualIndex, moveVisualRow, previewLayerRuns, visualTrackRows } from './visualTracks';

const base = { anchor: 'center', margin: [0.1, 0.2], width: 0.5, rotate: 10, opacity: 0.8, t: [0, 2] };
const text = (id: string, extra = {}): Layer => ({ ...base, id, type: 'text', text: id, ...extra } as Layer);
const sticker = (id: string): Layer => ({ ...base, id, type: 'sticker', asset_id: id } as Layer);
const mask = (id: string): Layer => ({ ...base, id, type: 'mask', mode: 'blur' } as Layer);
const ids = (layers: Layer[]) => layers.map(l => l.id);
const name = (l: Layer) => l.id;

describe('visual track rows (HIG-109)', () => {
  it('shows the real z order top first, without rewriting a legacy spec', () => {
    const layers = [sticker('s1'), text('t1'), mask('m'), sticker('s2')];
    expect(visualTrackRows(layers, 10, name).map(r => ids(r.items.map(x => x.l)))).toEqual([['s2'], ['m'], ['t1'], ['s1']]);
    expect(ids(layers)).toEqual(['s1', 't1', 'm', 's2']);
  });
  it('packs contiguous non-overlapping cues, but splits at cross-type/source/group z boundaries', () => {
    const sub = { origin: 'subtitle', auto: true };
    const layers = [text('a', sub), text('b', { ...sub, t: [2, 4] }), sticker('s'), text('c', { ...sub, t: [4, 6] }), text('d', { ...sub, t: [6, 8], group: 'g' })];
    expect(visualTrackRows(layers, 10, name).map(r => ids(r.items.map(x => x.l)))).toEqual([['d'], ['c'], ['s'], ['a', 'b']]);
  });
  it('does not pack overlapping cues into a row that would reverse their picture order', () => {
    const layers = [text('a', { origin: 'subtitle' }), text('b', { origin: 'subtitle', t: [1, 3] }), text('c', { origin: 'subtitle', t: [3, 5] })];
    expect(visualTrackRows(layers, 10, name).map(r => ids(r.items.map(x => x.l)))).toEqual([['b', 'c'], ['a']]);
  });
  it('retains hidden layers as z boundaries', () => {
    const layers = [text('a', { origin: 'subtitle' }), { ...sticker('s'), hidden: true }, text('b', { origin: 'subtitle', t: [2, 4] })];
    expect(visualTrackRows(layers, 10, name)).toHaveLength(3);
  });
});

describe('move whole visual row', () => {
  it('moves cues across types, preserving their objects, internal order and every parameter', () => {
    const layers = [mask('m'), text('a'), text('b'), sticker('s')];
    const next = moveVisualRow(layers, ['b', 'a'], ['s'], 'before');
    expect(ids(next)).toEqual(['m', 's', 'a', 'b']);
    expect(next[2]).toBe(layers[1]);
    expect(next[3]).toBe(layers[2]);
    expect(ids(layers)).toEqual(['m', 'a', 'b', 's']);
    expect(ids(moveVisualRow(next, ['a', 'b'], ['m'], 'after'))).toEqual(['a', 'b', 'm', 's']);
  });
  it('allows masks above text and rejects a partially locked row, unknown IDs and self drops', () => {
    const layers = [mask('m'), text('a'), { ...text('b'), locked: true }];
    expect(ids(moveVisualRow(layers, ['m'], ['b'], 'before'))).toEqual(['a', 'b', 'm']);
    expect(moveVisualRow(layers, ['a', 'b'], ['m'], 'after')).toBe(layers);
    expect(moveVisualRow(layers, ['missing'], ['a'], 'before')).toBe(layers);
    expect(moveVisualRow(layers, ['a'], ['missing'], 'after')).toBe(layers);
    expect(moveVisualRow(layers, ['a'], ['a'], 'before')).toBe(layers);
    expect(moveVisualRow(layers, ['a'], ['m'], 'before')).toBe(layers);
  });
});

it('inserts new defaults without sorting existing layers', () => {
  const layers = [sticker('s'), text('t')];
  expect(defaultVisualIndex(layers, mask('m'))).toBe(0);
  expect(defaultVisualIndex(layers, text('new'))).toBe(0);
  expect(defaultVisualIndex(layers, sticker('new'))).toBe(2);
  expect(ids(layers)).toEqual(['s', 't']);
});

it('splits preview canvases only at masks, giving DOM masks the same z as export', () => {
  const layers = [text('a'), sticker('b'), mask('m'), text('c'), mask('n')];
  const runs = previewLayerRuns(layers);
  expect(runs.map(r => [r.order, ids(r.layers)])).toEqual([[10, ['a', 'b']], [14, ['m']], [16, ['c']], [18, ['n']]]);
});

import { describe, expect, it } from 'vitest';
import type { Layer } from '../types';
import { packSubtitleRows } from './subtitleRows';

const text = (id: string, t: [number, number] | 'all', extra: Partial<Layer> = {}): Layer => ({ id, type: 'text', text: id, anchor: 'bottom-center', margin: [0, 0.1], width: 0.8, rotate: 0, opacity: 1, t, ...extra } as Layer);
const mask = (id: string): Layer => ({ id, type: 'mask', anchor: 'top-left', margin: [0, 0], width: 1, rotate: 0, opacity: 1, t: 'all', name: '遮盖' } as Layer);
const rows = (layers: Layer[]) => layers.map((l, i) => ({ l, i }));

describe('packSubtitleRows (HIG-92)', () => {
  it('puts all recognised cues on one row when they do not overlap', () => {
    const layers = Array.from({ length: 59 }, (_, n) => text(`s${n}`, [n * 2, n * 2 + 2], { origin: 'subtitle', auto: true }));
    const packed = packSubtitleRows(rows(layers), 200);
    expect(packed).toHaveLength(1);
    expect(packed[0]).toMatchObject({ label: '识别字幕', kind: 'subtitle' });
    expect(packed[0].items).toHaveLength(59);
  });

  it('separates sources and languages, keeps masks on their own rows', () => {
    const layers = [
      mask('m'),
      text('a1', [0, 2], { origin: 'subtitle', auto: true }),
      text('en1', [0, 2], { origin: 'localize', lang: 'en' }),
      text('a2', [2, 4], { origin: 'subtitle', auto: true }),
      text('manual', [1, 3], { name: '字幕 1' }),
      text('ja1', [0, 2], { origin: 'localize', lang: 'ja' }),
    ];
    const packed = packSubtitleRows(rows(layers), 10);
    expect(packed.map((r) => [r.label, r.items.map((x) => x.l.id)])).toEqual([
      ['遮盖', ['m']],
      ['识别字幕', ['a1', 'a2']],
      ['译文 · en', ['en1']],
      ['字幕', ['manual']],
      ['译文 · ja', ['ja1']],
    ]);
  });

  it('spills only overlapping cues to an extra row and keeps spec indices', () => {
    const layers = [
      text('a', [0, 3], { origin: 'subtitle', auto: true }),
      text('b', [2, 4], { origin: 'subtitle', auto: true }),
      text('c', [3, 5], { origin: 'subtitle', auto: true }),
      text('all', 'all', { origin: 'subtitle', auto: true }),
    ];
    const packed = packSubtitleRows(rows(layers), 10);
    expect(packed.map((r) => [r.label, r.items.map((x) => `${x.l.id}@${x.i}`)])).toEqual([
      ['识别字幕', ['a@0', 'c@2']],
      ['识别字幕 2', ['all@3']],
      ['识别字幕 3', ['b@1']],
    ]);
    expect(new Set(packed.map((r) => r.key)).size).toBe(packed.length);
  });
});

import { describe, expect, it } from 'vitest';
import type { EditSpec } from '../types';
import { playheadSnapCandidates, snapPlayhead } from './playheadSnap';

const base = (): EditSpec => ({ spec_version: 1, trim: { remove: [] }, layers: [], outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'crop' }] });

describe('playhead snap (HIG-85)', () => {
  it('候选：0、片尾、删除区间 / 分割点、上层片段、图层与音轨两端（剪后换算回源时间）', () => {
    const spec = base();
    spec.trim = { remove: [[2, 3]], splits: [5] };
    spec.video_tracks = [{ id: 'vt', clips: [{ id: 'up', video_id: 'v2', start: 6, in: 0, out: 1 }] }];
    spec.layers = [{ id: 'l', type: 'shape', shape: 'rect', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: [1, 2.5] } as EditSpec['layers'][number]];
    spec.audio = { source_volume: 1, tracks: [{ id: 'a', asset_id: 'x', t: 'all' }] };
    // 剪后 2.5 → 源 3.5；上层片段剪后 6–7 → 源 7–8
    expect(playheadSnapCandidates(spec, { duration: 10 })).toEqual([0, 1, 2, 3, 3.5, 5, 7, 8, 10]);
    expect(playheadSnapCandidates(spec, { duration: 10, axisLen: 12 })).toContain(12);
    expect(playheadSnapCandidates(null, { duration: 4 })).toEqual([0, 4]);
  });

  it('拼接视频用片段两端', () => {
    const spec = base();
    spec.sequence = { clips: [{ id: 'c1', video_id: 'v', in: 0, out: 2 }, { id: 'c2', video_id: 'v', in: 5, out: 8 }] };
    expect(playheadSnapCandidates(spec, { duration: 5 })).toEqual([0, 2, 5]);
  });

  it('阈值按像素换算；开关与 ⌥ 取异或', () => {
    const c = [0, 2, 5];
    expect(snapPlayhead(2.05, c, { pps: 100, px: 6, enabled: true, bypassHeld: false })).toEqual({ t: 2, hit: 2 });
    expect(snapPlayhead(2.1, c, { pps: 100, px: 6, enabled: true, bypassHeld: false })).toEqual({ t: 2.1, hit: null });
    expect(snapPlayhead(2.05, c, { pps: 100, px: 6, enabled: true, bypassHeld: true })).toEqual({ t: 2.05, hit: null });
    expect(snapPlayhead(2.05, c, { pps: 100, px: 6, enabled: false, bypassHeld: true })).toEqual({ t: 2, hit: 2 });
  });
});

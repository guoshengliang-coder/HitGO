import { describe, expect, it } from 'vitest';
import type { EditSpec } from '../types';
import { dropSnapCandidates, mainInsertPosition, snapDrop } from './dropSnap';
import { insertClip } from './sequence';
import { makeTimelineAxis } from './timelineAxis';

const base = (): EditSpec => ({ spec_version: 1, trim: { remove: [] }, layers: [], outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'crop' }] });

describe('drop snap (HIG-93)', () => {
  it('candidates include 0, the playhead, cut joins and upper clip edges on the current axis', () => {
    const spec = base();
    spec.trim = { remove: [[2, 4]] };
    spec.video_tracks = [{ id: 'vt', clips: [{ id: 'up', video_id: 'v2', start: 5, in: 0, out: 1 }] }];
    const axis = makeTimelineAxis({ collapsed: true, duration: 10, remove: spec.trim.remove });
    // 收起后：接缝 2、上层片段剪后 5–6、片尾 8，播放头源 7 → 横轴 5
    expect(dropSnapCandidates(spec, axis, { duration: 10, srcAxisLen: 10, playhead: 7 })).toEqual([0, 2, 5, 6, 8]);
  });

  it('snaps within the pixel threshold and respects the magnet switch', () => {
    const c = [0, 2, 5];
    expect(snapDrop(0.04, c, { pps: 100, px: 6, enabled: true, bypassHeld: false })).toEqual({ at: 0, hit: 0 });
    expect(snapDrop(0.2, c, { pps: 100, px: 6, enabled: true, bypassHeld: false })).toEqual({ at: 0.2, hit: null });
    expect(snapDrop(0.04, c, { pps: 100, px: 6, enabled: false, bypassHeld: false })).toEqual({ at: 0.04, hit: null });
  });
});

describe('main-track insert position (HIG-94)', () => {
  const trimmed = () => {
    const spec = base();
    spec.trim = { remove: [[0, 4]] }; // 删左 4s
    return spec;
  };

  it('collapsed axis: dropping 2s into the kept footage splits the original at source 6s', () => {
    const spec = trimmed();
    const axis = makeTimelineAxis({ collapsed: true, duration: 10, remove: spec.trim.remove });
    const at = mainInsertPosition(2, axis, false);
    const { spec: next, clipId } = insertClip(spec, 'v', 10, 's', 3, at);
    expect(next.sequence!.clips.map((c) => [c.video_id, c.in, c.out])).toEqual([['v', 4, 6], ['s', 0, 3], ['v', 6, 10]]);
    expect(next.sequence!.clips[1].id).toBe(clipId);
  });

  it('expanded axis: dropping at source 6s also splits there instead of appending at the end', () => {
    const spec = trimmed();
    const axis = makeTimelineAxis({ collapsed: false, duration: 10, remove: spec.trim.remove });
    const { spec: next } = insertClip(spec, 'v', 10, 's', 3, mainInsertPosition(6, axis, false));
    expect(next.sequence!.clips.map((c) => [c.video_id, c.in, c.out])).toEqual([['v', 4, 6], ['s', 0, 3], ['v', 6, 10]]);
  });

  it('an already spliced video inserts on the splice clock', () => {
    const spec = base();
    spec.sequence = { clips: [{ id: 'a', video_id: 'v', in: 0, out: 4 }, { id: 'b', video_id: 'w', in: 0, out: 4 }] };
    spec.trim = { remove: [[1, 2]] };
    const axis = makeTimelineAxis({ collapsed: true, duration: 8, remove: spec.trim.remove });
    // 横轴 4 = 拼接时钟 5：第二段内 1s 处
    expect(mainInsertPosition(4, axis, true)).toBeCloseTo(5);
  });
});

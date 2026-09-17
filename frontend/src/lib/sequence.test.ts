import { describe, expect, it } from 'vitest';
import { emptySpec, type EditSpec, type SequenceClip } from '../types';
import { clipAt, clipDisplayGroups, clipWindows, duplicateClip, insertClip, materializeSequence, moveClip, moveClipGroup, removeClip, removeClipGroup, sequenceDuration, updateClip } from './sequence';

const clip = (id: string, videoId: string, start: number, end: number): SequenceClip => ({ id, video_id: videoId, in: start, out: end });
const withSequence = (...clips: SequenceClip[]): EditSpec => ({ ...emptySpec(), sequence: { clips } });

describe('HIG-39 composed timeline', () => {
  it('converts legacy removed ranges and output looping without changing the source footage', () => {
    const spec = { ...emptySpec(), trim: { remove: [[2, 4], [7, 8]] as [number, number][], duration: 11 } };
    const result = materializeSequence(spec, 'owner', 10);
    expect(result.sequence?.clips.map((c) => [c.video_id, c.in, c.out])).toEqual([
      ['owner', 0, 2], ['owner', 4, 7], ['owner', 8, 10],
      ['owner', 0, 2], ['owner', 4, 6],
    ]);
    expect(result.trim).toEqual({ remove: [] });
    expect(spec.trim.remove).toEqual([[2, 4], [7, 8]]);
  });

  it('inserts at the playhead, splits spanning local content, and keeps all-film content global', () => {
    const spec: EditSpec = {
      ...emptySpec(),
      layers: [
        { id: 'local', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: [2, 8] },
        { id: 'global', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: 'all' },
      ],
      audio: { source_volume: 1, source_mute: [[4, 6]], tracks: [{ id: 'voice', asset_id: 'a', t: [3, 7] }] },
    };
    const result = insertClip(spec, 'owner', 10, 'other', 4, 5).spec;
    expect(result.sequence?.clips.map((c) => [c.video_id, c.in, c.out])).toEqual([
      ['owner', 0, 5], ['other', 0, 4], ['owner', 5, 10],
    ]);
    expect(result.layers.map((l) => l.t)).toEqual([[2, 5], [9, 12], 'all']);
    expect(result.audio?.tracks.map((t) => t.t)).toEqual([[3, 5], [9, 11]]);
    expect(result.audio?.source_mute).toEqual([[4, 5], [9, 10]]);
    expect(sequenceDuration(result.sequence!)).toBe(14);
    expect(spec.layers).toHaveLength(2);
  });

  it('shows adjacent keep-ranges of the original as one expandable source row', () => {
    const spec = withSequence(
      clip('owner-a', 'owner', 0, 1.4),
      clip('inserted', 'new', 0, 23.5),
      clip('owner-b', 'owner', 2, 2.6),
      clip('owner-c', 'owner', 4, 30),
    );
    const groups = clipDisplayGroups(spec.sequence!, 'owner');
    expect(groups.map((g) => g.clips.map((w) => w.clip.id))).toEqual([['owner-a'], ['inserted'], ['owner-b', 'owner-c']]);
    expect(groups[2].end - groups[2].start).toBeCloseTo(26.6);
    const moved = moveClipGroup(spec, 'owner', 'owner-b', 0);
    expect(moved.sequence?.clips.map((c) => c.id)).toEqual(['owner-b', 'owner-c', 'owner-a', 'inserted']);
    const removed = removeClipGroup(spec, 'owner', 'owner-b');
    expect(removed?.sequence?.clips.map((c) => c.id)).toEqual(['owner-a', 'inserted']);
    expect(removeClipGroup(withSequence(clip('only', 'owner', 0, 4)), 'owner', 'only')).toBeNull();
  });

  it('deleting a displayed block drops its local overlays and retimes the remaining ones', () => {
    const spec: EditSpec = {
      ...withSequence(clip('owner-a', 'owner', 0, 2), clip('new', 'new', 0, 3), clip('owner-b', 'owner', 4, 6), clip('owner-c', 'owner', 8, 10)),
      layers: [
        { id: 'gone', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: [5.5, 6.5] },
        { id: 'kept', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: [2.5, 3.5] },
      ],
    };
    const next = removeClipGroup(spec, 'owner', 'owner-b')!;
    expect(next.sequence?.clips.map((c) => c.id)).toEqual(['owner-a', 'new']);
    expect(next.layers.map((l) => [l.id, l.t])).toEqual([['kept', [2.5, 3.5]]]);
  });

  it('computes overlap windows and chooses the entering clip for hard-cut preview', () => {
    const spec = withSequence(clip('a', 'one', 0, 4), { ...clip('b', 'two', 0, 3), transition: { type: 'wipe_left', duration: 0.5 } });
    expect(clipWindows(spec.sequence!).map((w) => [w.start, w.end])).toEqual([[0, 4], [3.5, 6.5]]);
    expect(clipAt(spec.sequence!, 3.6)?.clip.id).toBe('b');
    expect(sequenceDuration(spec.sequence!)).toBe(6.5);
  });

  it('moves and deletes local windows with their footage, without moving all-film windows', () => {
    const spec: EditSpec = {
      ...withSequence(clip('a', 'one', 0, 4), clip('b', 'two', 0, 3)),
      audio: { source_volume: 1, tracks: [{ id: 'v', asset_id: 'audio', t: [4.5, 5.5] }, { id: 'bgm', asset_id: 'audio', t: 'all' }] },
    };
    const moved = moveClip(spec, 'b', 0);
    expect(moved.audio?.tracks.map((t) => t.t)).toEqual([[0.5, 1.5], 'all']);
    const removed = removeClip(spec, 'b')!;
    expect(removed.audio?.tracks.map((t) => t.t)).toEqual(['all']);
    expect(removed.sequence?.clips.map((c) => c.id)).toEqual(['a']);
  });

  it('trimming a clip preserves content alignment to raw frames and clips removed content', () => {
    const spec: EditSpec = {
      ...withSequence(clip('a', 'one', 0, 10)),
      audio: { source_volume: 1, tracks: [{ id: 'v', asset_id: 'audio', t: [2, 8] }] },
    };
    const trimmed = updateClip(spec, 'a', { in: 3, out: 7 });
    expect(trimmed.audio?.tracks[0].t).toEqual([0, 4]);
  });

  it('a duplicated source clip gets a distinct identity', () => {
    const original = withSequence(clip('a', 'one', 0, 4));
    const duplicated = duplicateClip(original, 'a')!;
    expect(duplicated.spec.sequence?.clips).toHaveLength(2);
    expect(duplicated.clipId).not.toBe('a');
    expect(duplicated.spec.sequence?.clips[1].video_id).toBe('one');
  });
});

import { describe, expect, it } from 'vitest';
import { emptySpec, type EditSpec, type SequenceClip } from '../types';
import { clipAt, clipDisplayGroups, clipWindows, duplicateClip, insertClip, materializeEditableSegments, materializeSequence, moveClip, moveClipGroup, moveLegacySegment, normalizeSequenceAudio, removeClip, removeClipGroup, sequenceDuration, sequenceSourceGain, sequenceSourceTime, sequenceTrackWindows, splitClip, updateClip } from './sequence';
import { trackMediaTime } from './audioTracks';
import { segKey } from './segments';

const clip = (id: string, videoId: string, start: number, end: number): SequenceClip => ({ id, video_id: videoId, in: start, out: end });
const withSequence = (...clips: SequenceClip[]): EditSpec => ({ ...emptySpec(), sequence: { clips } });

describe('HIG-39 composed timeline', () => {
  it('turns legacy split segments into stable sequence clips before editing', () => {
    const spec: EditSpec = { ...emptySpec(), trim: { remove: [[4, 5]], splits: [2, 7] } };
    const converted = materializeEditableSegments(spec, 'owner', 10);
    expect(converted.spec.sequence?.clips.map((c) => [c.in, c.out])).toEqual([[0, 2], [2, 4], [4, 5], [5, 7], [7, 10]]);
    expect(converted.clipForSegment.get(segKey([5, 7]))).toBe(converted.spec.sequence?.clips[3].id);
    expect(converted.spec.trim.remove).toEqual([[4, 5]]);
    expect({ ...converted.spec, trim: { remove: [] } }.sequence?.clips[2]).toMatchObject({ in: 4, out: 5 });
    expect(spec.sequence).toBeUndefined();
  });

  it('moves a deleted interval with the sequence so it remains restorable', () => {
    const spec: EditSpec = { ...emptySpec(), trim: { remove: [[4, 5]], splits: [2, 7] } };
    const moved = moveLegacySegment(spec, 'owner', 10, segKey([0, 2]), 9);
    expect(moved.spec.sequence?.clips.map((c) => [c.in, c.out])).toEqual([[2, 4], [4, 5], [5, 7], [7, 10], [0, 2]]);
    expect(moved.spec.trim.remove).toEqual([[2, 3]]);
  });

  it('reorders a split clip, moving its local content while a cross-cut item stays at its time', () => {
    const makeLayer = (id: string, t: [number, number]) => ({ id, type: 'shape' as const, shape: 'rect' as const, anchor: 'top-left' as const, margin: [0, 0] as [number, number], width: 0.3, height: 0.2, fill: '#FFFFFF', stroke: '#000000', stroke_width: 0, radius: 0, rotate: 0, opacity: 1, t });
    const spec: EditSpec = {
      ...emptySpec(), trim: { remove: [], splits: [2, 4] },
      layers: [makeLayer('local', [2.2, 3.2]), makeLayer('cross', [1, 3])],
      audio: { source_volume: 0.5, tracks: [{ id: 'voice', asset_id: 'a', t: [2.3, 3] }] },
    };
    const moved = moveLegacySegment(spec, 'owner', 6, segKey([2, 4]), 5.8);
    expect(moved.spec.sequence?.clips.map((c) => [c.in, c.out])).toEqual([[0, 2], [4, 6], [2, 4]]);
    expect(moved.spec.layers.map((l) => l.t)).toEqual([[4.2, 5.2], [1, 3]]);
    expect(moved.spec.audio?.tracks[0].t).toEqual([4.3, 5]);
    expect(sequenceSourceGain(moved.spec, 'owner', 4.5)).toBe(0.5);
    expect(spec.sequence).toBeUndefined();
  });
  it('adding and reordering sources preserves recoverable cuts on the composed source', () => {
    const spec: EditSpec = { ...withSequence(clip('a', 'owner', 0, 5), clip('b', 'other', 0, 5)), trim: { remove: [[2, 3], [7, 8]] } };
    const inserted = insertClip(spec, 'owner', 5, 'new', 2, 4).spec;
    expect(inserted.trim.remove).toEqual([[2, 3], [9, 10]]);
    const moved = moveClip(spec, 'b', 0);
    expect(moved.trim.remove).toEqual([[2, 3], [7, 8]]);
  });
  it.each([0, 4, 8])('inserting at %s preserves owner mute but keeps the inserted original audio', (at) => {
    const spec: EditSpec = { ...emptySpec(), audio: { source_volume: 0, tracks: [{ id: 'dub', asset_id: 'a', align: 'source', t: 'all' }] } };
    const next = insertClip(spec, 'owner', 8, 'inserted', 3, at).spec;
    expect(next.audio?.source_volume).toBe(1);
    expect(sequenceSourceGain(next, 'owner', at + 1)).toBe(1);
    expect(sequenceSourceTime(next.sequence!, 'owner', at + 1)).toBeUndefined();
    const ownerAt = at === 0 ? 4 : 1;
    expect(sequenceSourceGain(next, 'owner', ownerAt)).toBe(0);
    expect(sequenceSourceTime(next.sequence!, 'owner', ownerAt)).toBe(1);
  });

  it('repairs the saved 23.5s insertion without changing order, dubbing or existing gain', () => {
    const spec: EditSpec = { ...withSequence(clip('new', 'inserted', 0, 23.5), clip('a', 'owner', 0, 8.4), clip('b', 'owner', 9.969, 14.917)), audio: { source_volume: 0.3, tracks: [{ id: 'dub', asset_id: 'yue', align: 'source', t: 'all' }] } };
    const next = normalizeSequenceAudio(spec, 'owner');
    expect(next.sequence?.clips.map((c) => c.source_volume)).toEqual([1, 0.3, 0.3]);
    expect(next.audio?.tracks).toEqual(spec.audio?.tracks);
    expect(normalizeSequenceAudio(next, 'owner')).toBe(next);
    expect(spec.audio?.source_volume).toBe(0.3);
    const dub = next.audio!.tracks[0];
    for (const candidate of [spec, next]) {
      expect(sequenceSourceGain(candidate, 'owner', 1)).toBe(1);
      expect(sequenceSourceGain(candidate, 'owner', 24)).toBe(0.3);
      const rawAtStart = sequenceSourceTime(candidate.sequence!, 'owner', 1);
      expect(trackMediaTime(1, dub, 36.848, 14.917, rawAtStart)).toBeNull();
      const rawAfterCut = sequenceSourceTime(candidate.sequence!, 'owner', 32.9);
      expect(rawAfterCut).toBeCloseTo(10.969);
      expect(trackMediaTime(32.9, dub, 36.848, 14.917, rawAfterCut)).toBeCloseTo(10.969);
    }
    expect(sequenceTrackWindows(next.sequence!, 'owner', [0, 36.848])).toEqual([[23.5, 31.9], [31.9, 36.848]]);
  });

  it('keeps clip gains after reorder and respects a new whole-film mute and timed mutes', () => {
    const old: EditSpec = { ...withSequence(clip('a', 'owner', 0, 4), clip('b', 'new', 0, 3)), audio: { source_volume: 0.8, source_hidden: true, tracks: [] } };
    const normalized = normalizeSequenceAudio(old, 'owner');
    const moved = moveClip(normalized, 'b', 0);
    expect(sequenceSourceGain(moved, 'owner', 1)).toBe(1);
    expect(sequenceSourceGain(moved, 'owner', 4)).toBe(0);
    moved.audio!.source_mute = [[1, 2]];
    expect(sequenceSourceGain(moved, 'owner', 1.5)).toBe(0);
    moved.audio!.source_hidden = true;
    expect(sequenceSourceGain(moved, 'owner', 0.5)).toBe(0);
    expect(sequenceSourceGain(moved, 'owner', -0.5)).toBe(0);
  });

  it('changing one clip volume does not split existing timed tracks', () => {
    const spec: EditSpec = { ...withSequence({ ...clip('a', 'owner', 0, 3), source_volume: 1 }, { ...clip('b', 'new', 0, 3), source_volume: 1 }), audio: { source_volume: 1, tracks: [{ id: 'bgm', asset_id: 'a', t: [1, 5] }] } };
    const next = updateClip(spec, 'b', { source_volume: 0.4 });
    expect(next.audio?.tracks).toEqual(spec.audio?.tracks);
    expect(sequenceSourceGain(next, 'owner', 4)).toBe(0.4);
    expect(trackMediaTime(4, next.audio!.tracks[0], 6, 10, undefined)).toBe(3);
  });
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

  it('uses clip speed for composed duration and raw-source mapping', () => {
    const spec = withSequence(
      { ...clip('slow', 'owner', 0, 2), speed: 0.8 },
      { ...clip('fast', 'owner', 2, 4), speed: 1.25 },
    );
    expect(clipWindows(spec.sequence!).map((window) => [window.start, window.end])).toEqual([[0, 2.5], [2.5, 4.1]]);
    expect(sequenceDuration(spec.sequence!)).toBeCloseTo(4.1);
    expect(sequenceSourceTime(spec.sequence!, 'owner', 1)).toBeCloseTo(0.8);
    expect(sequenceSourceTime(spec.sequence!, 'owner', 3.5)).toBeCloseTo(3.25);
  });

  it('keeps a held frame only on the tail when splitting a clip', () => {
    const spec = withSequence({ ...clip('held', 'owner', 0, 2), hold_after: 1 });
    const split = splitClip(spec, 'held', 1)!;
    expect(split.sequence?.clips.map((c) => [c.in, c.out, c.hold_after ?? 0])).toEqual([[0, 1, 0], [1, 2, 1]]);
    expect(sequenceDuration(split.sequence!)).toBe(3);
    expect(sequenceSourceTime(split.sequence!, 'owner', 2.5)).toBe(2);
  });

  it('keeps audio placed over a held frame when the picture speed changes', () => {
    const spec: EditSpec = { ...withSequence({ ...clip('held', 'owner', 0, 2), hold_after: 1 }), audio: { source_volume: 0, tracks: [{ id: 'voice', asset_id: 'a', align: 'post', t: [2.2, 2.8] }] } };
    const changed = updateClip(spec, 'held', { speed: 0.8 });
    expect(changed.audio?.tracks.map((track) => track.t)).toEqual([[2.7, 3.3]]);
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

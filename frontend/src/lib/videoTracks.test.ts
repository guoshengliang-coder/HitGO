import { describe, expect, it } from 'vitest';
import type { EditSpec } from '../types';
import { addVideoTrack, removeVideoTrackClips, splitVideoTrackClip, updateVideoTrackClip, videoTrackClipEnd } from './videoTracks';

const spec = (): EditSpec => ({ spec_version: 1, trim: { remove: [] }, layers: [], outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'crop' }] });

describe('video tracks', () => {
  it('adds a new upper track for each dropped source', () => {
    const value = spec();
    addVideoTrack(value, 'v2', 3, 1);
    addVideoTrack(value, 'v3', 4, 2);
    expect(value.video_tracks).toHaveLength(2);
    expect(value.video_tracks?.map((track) => track.clips[0].video_id)).toEqual(['v2', 'v3']);
  });

  it('moves, trims, splits, and removes upper clips', () => {
    const value = spec();
    const clip = addVideoTrack(value, 'v2', 4, 1);
    updateVideoTrackClip(value, clip.id, { start: 2, in: 0.5, out: 3.5 });
    expect(videoTrackClipEnd(clip)).toBe(5);
    const right = splitVideoTrackClip(value, clip.id, 3.5);
    expect(right).toBeTruthy();
    expect(value.video_tracks?.[0].clips.map((item) => [item.start, item.in, item.out])).toEqual([[2, 0.5, 2], [3.5, 2, 3.5]]);
    removeVideoTrackClips(value, new Set([right!]));
    expect(value.video_tracks?.[0].clips).toHaveLength(1);
  });
});

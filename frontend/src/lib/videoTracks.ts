import type { EditSpec, VideoTrack, VideoTrackClip } from '../types';

const round = (n: number) => Math.round(n * 10000) / 10000;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const videoTrackClipDuration = (clip: VideoTrackClip) => (clip.out - clip.in) / (clip.speed ?? 1);
export const videoTrackClipEnd = (clip: VideoTrackClip) => clip.start + videoTrackClipDuration(clip);

export function addVideoTrack(spec: EditSpec, videoId: string, sourceDuration: number, start: number): VideoTrackClip {
  const clip: VideoTrackClip = { id: uid('vc'), video_id: videoId, start: round(Math.max(0, start)), in: 0, out: round(sourceDuration), speed: 1 };
  const track: VideoTrack = { id: uid('vt'), clips: [clip] };
  (spec.video_tracks ??= []).push(track);
  return clip;
}

export function updateVideoTrackClip(spec: EditSpec, clipId: string, patch: Partial<VideoTrackClip>): boolean {
  for (const track of spec.video_tracks ?? []) {
    if (track.locked) continue;
    const clip = track.clips.find((item) => item.id === clipId);
    if (!clip) continue;
    Object.assign(clip, patch);
    clip.start = round(Math.max(0, clip.start));
    clip.in = round(Math.max(0, clip.in));
    clip.out = round(Math.max(clip.in + 0.1, clip.out));
    clip.speed = Math.max(0.5, Math.min(2, clip.speed ?? 1));
    return true;
  }
  return false;
}

export function removeVideoTrackClips(spec: EditSpec, ids: Set<string>): void {
  if (!spec.video_tracks) return;
  spec.video_tracks = spec.video_tracks
    .map((track) => track.locked ? track : { ...track, clips: track.clips.filter((clip) => !ids.has(clip.id)) })
    .filter((track) => track.clips.length > 0);
}

export function splitVideoTrackClip(spec: EditSpec, clipId: string, at: number): string | null {
  for (const track of spec.video_tracks ?? []) {
    if (track.locked) continue;
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    const clip = track.clips[index];
    if (!clip || at <= clip.start + 0.1 || at >= videoTrackClipEnd(clip) - 0.1) continue;
    const sourceAt = clip.in + (at - clip.start) * (clip.speed ?? 1);
    const right: VideoTrackClip = { ...clip, id: uid('vc'), start: round(at), in: round(sourceAt) };
    clip.out = round(sourceAt);
    track.clips.splice(index + 1, 0, right);
    return right.id;
  }
  return null;
}

export function duplicateVideoTrackClip(spec: EditSpec, clipId: string, at: number): string | null {
  for (const track of spec.video_tracks ?? []) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (!clip) continue;
    const copy = { ...structuredClone(clip), id: uid('vc'), start: round(Math.max(0, at)) };
    (spec.video_tracks ??= []).push({ id: uid('vt'), clips: [copy] });
    return copy.id;
  }
  return null;
}

import type { AudioTrack, EditSpec, Video, VideoTrack, VideoTrackClip } from '../types';
import { newTrackId } from './audioTracks';

const round = (n: number) => Math.round(n * 10000) / 10000;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const videoTrackClipDuration = (clip: VideoTrackClip) => (clip.out - clip.in) / (clip.speed ?? 1);
export const videoTrackClipEnd = (clip: VideoTrackClip) => clip.start + videoTrackClipDuration(clip);

export function linkedVideoAudio(spec: EditSpec, clipId: string): AudioTrack | undefined {
  return spec.audio?.tracks.find((track) => track.source_kind === 'video' && track.linked_clip_id === clipId);
}

export function addLinkedVideoAudio(spec: EditSpec, clip: VideoTrackClip, source: Video): string | null {
  if (!source.has_audio) return null;
  spec.audio ??= { source_volume: 1, tracks: [] };
  const id = newTrackId();
  spec.audio.tracks.push({
    id,
    source_kind: 'video',
    asset_id: source.id,
    linked_clip_id: clip.id,
    role: 'voice',
    align: 'post',
    t: [clip.start, videoTrackClipEnd(clip)],
    offset: clip.in,
    volume: 1,
    loop: false,
    speed: clip.speed ?? 1,
    name: `${source.name.replace(/\.[a-z0-9]+$/i, '')} · 原声`,
  });
  return id;
}

function syncLinkedVideoAudio(spec: EditSpec, clip: VideoTrackClip): void {
  const track = linkedVideoAudio(spec, clip.id);
  if (!track) return;
  track.asset_id = clip.video_id;
  track.t = [clip.start, videoTrackClipEnd(clip)];
  track.offset = clip.in;
  track.speed = clip.speed ?? 1;
  track.loop = false;
  track.align = 'post';
}

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
    syncLinkedVideoAudio(spec, clip);
    return true;
  }
  return false;
}

export function removeVideoTrackClips(spec: EditSpec, ids: Set<string>): void {
  if (!spec.video_tracks) return;
  const removable = new Set(spec.video_tracks
    .filter((track) => !track.locked)
    .flatMap((track) => track.clips)
    .filter((clip) => ids.has(clip.id))
    .map((clip) => clip.id));
  if (spec.audio) spec.audio.tracks = spec.audio.tracks.filter((track) => !track.linked_clip_id || !removable.has(track.linked_clip_id));
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
    const audio = linkedVideoAudio(spec, clip.id);
    if (audio) {
      syncLinkedVideoAudio(spec, clip);
      const rightAudio: AudioTrack = {
        ...structuredClone(audio),
        id: newTrackId(),
        linked_clip_id: right.id,
        t: [right.start, videoTrackClipEnd(right)],
        offset: right.in,
      };
      spec.audio!.tracks.push(rightAudio);
    }
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

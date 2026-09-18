/** Multi-source virtual source; trim.remove cuts its composed clock, overlays use post-cut time. */
import type { AudioTrack, EditSpec, Layer, SequenceClip, SequenceSpec } from '../types';
import { keepSegments, normalizeRanges, postToSource, postTrimDuration, sourceToPost } from './time';
import { cloneSpec } from './spec';

const MIN_CLIP = 0.1;
export const VIDEO_DRAG = 'application/x-hitgo-source-video';
export const CLIP_DRAG = 'application/x-hitgo-sequence-clip';
let activeSourceId: string | null = null;
export const setActiveSourceDrag = (id: string | null) => { activeSourceId = id; };
export const activeSourceDrag = () => activeSourceId;
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 12)}`;

export function clipLength(clip: SequenceClip): number {
  return clip.out - clip.in;
}

export function sequenceDuration(sequence: SequenceSpec): number {
  return sequence.clips.reduce((sum, clip) => sum + clipLength(clip) - (clip.transition?.duration ?? 0), 0);
}

export function clipWindows(sequence: SequenceSpec): { clip: SequenceClip; start: number; end: number }[] {
  let end = 0;
  return sequence.clips.map((clip) => {
    const start = end - (clip.transition?.duration ?? 0);
    end = start + clipLength(clip);
    return { clip, start, end };
  });
}

/** Keep consecutive legacy keep-ranges of the owner visually under one source row.
 * They stay separate render clips, so old deletions are preserved exactly. */
export function clipDisplayGroups(sequence: SequenceSpec, ownerId: string) {
  const groups: { key: string; clips: ReturnType<typeof clipWindows>; start: number; end: number }[] = [];
  for (const window of clipWindows(sequence)) {
    const previous = groups[groups.length - 1];
    if (window.clip.video_id === ownerId && previous?.clips.every((w) => w.clip.video_id === ownerId) && !window.clip.transition) {
      previous.clips.push(window);
      previous.end = window.end;
    } else {
      groups.push({ key: window.clip.id, clips: [window], start: window.start, end: window.end });
    }
  }
  return groups;
}

/** During an overlap preview switches to the entering clip; the render applies the transition. */
export function clipAt(sequence: SequenceSpec, time: number) {
  const windows = clipWindows(sequence);
  return [...windows].reverse().find((w) => time >= w.start - 1e-6) ?? windows[0];
}

/** Legacy owner mute/volume must not silence a newly inserted source. */
export function normalizeSequenceAudio(spec: EditSpec, ownerId: string): EditSpec {
  if (!spec.sequence || spec.sequence.clips.some((c) => c.source_volume != null)) return spec;
  const next = cloneSpec(spec);
  const ownerGain = spec.audio?.source_hidden ? 0 : spec.audio?.source_volume ?? 1;
  for (const clip of next.sequence!.clips) clip.source_volume = clip.video_id === ownerId ? ownerGain : 1;
  if (next.audio) { next.audio.source_volume = 1; next.audio.source_hidden = false; }
  return next;
}

/** Replacing the owner's voice must not mute unrelated inserted footage. Mutates the draft. */
export function setOwnerSourceGain(spec: EditSpec, ownerId: string, gain: number): void {
  Object.assign(spec, normalizeSequenceAudio(spec, ownerId));
  if (spec.sequence) {
    for (const clip of spec.sequence.clips) if (clip.video_id === ownerId) clip.source_volume = gain;
  } else {
    spec.audio ??= { source_volume: 1, tracks: [] };
    spec.audio.source_volume = gain;
  }
}

/** Source-aligned dubbing exists only over the owner's visible raw footage. */
export function sequenceSourceTime(sequence: SequenceSpec, ownerId: string, time: number): number | undefined {
  const window = clipAt(sequence, time);
  if (!window || time < 0 || time >= sequenceDuration(sequence) || window.clip.video_id !== ownerId) return undefined;
  return window.clip.in + time - window.start;
}

/** Visible spans for an owner-aligned track; never paint it over other sources. */
export function sequenceTrackWindows(sequence: SequenceSpec, ownerId: string, range: [number, number]): [number, number][] {
  const windows = clipWindows(sequence);
  return windows.flatMap((w, i) => {
    const start = Math.max(range[0], w.start);
    const end = Math.min(range[1], windows[i + 1]?.start ?? w.end);
    return w.clip.video_id === ownerId && end > start ? [[start, end] as [number, number]] : [];
  });
}

/** Same clip/master gain and legacy fallback as the renderer. */
export function sequenceSourceGain(spec: EditSpec, ownerId: string, time: number): number {
  if (!spec.sequence || time < 0 || time >= sequenceDuration(spec.sequence)) return 0;
  const clip = clipAt(spec.sequence, time)?.clip;
  const postTime = sourceToPost(time, spec.trim.remove);
  if (!clip || spec.audio?.source_mute?.some(([a, b]) => postTime >= a && postTime < b)) return 0;
  const master = spec.audio?.source_hidden ? 0 : spec.audio?.source_volume ?? 1;
  const legacy = spec.sequence.clips.every((c) => c.source_volume == null);
  return legacy ? clip.video_id === ownerId ? master : 1 : master * (clip.source_volume ?? 1);
}

/** Materialize the old trim and optional loop/truncation as clips before the first insertion. */
export function materializeSequence(spec: EditSpec, videoId: string, duration: number): EditSpec {
  if (spec.sequence) return cloneSpec(normalizeSequenceAudio(spec, videoId));
  const next = cloneSpec(spec);
  const segments = keepSegments(duration, next.trim.remove);
  const onePass = postTrimDuration(duration, next.trim.remove);
  const target = next.trim.duration ?? onePass;
  const clips: SequenceClip[] = [];
  let filled = 0;
  while (filled < target - 1e-6 && segments.length) {
    for (const [start, end] of segments) {
      const length = Math.min(end - start, target - filled);
      if (length >= MIN_CLIP - 1e-6) clips.push({ id: id('c'), video_id: videoId, in: start, out: start + length });
      filled += length;
      if (filled >= target - 1e-6) break;
    }
  }
  next.sequence = { clips };
  next.trim = { remove: [] };
  return normalizeSequenceAudio(next, videoId);
}

/** A timed thing crossing an insertion is copied to both old-footage sides. */
function insertWindows<T extends { id: string; t: [number, number] | 'all' }>(items: T[], at: number, length: number, prefix: string): T[] {
  return items.flatMap((item) => {
    if (item.t === 'all') return [item];
    const [start, end] = item.t;
    if (end <= at) return [item];
    if (start >= at) return [{ ...item, t: [start + length, end + length] as [number, number] }];
    return [
      { ...item, t: [start, at] as [number, number] },
      { ...item, id: id(prefix), t: [at + length, end + length] as [number, number] },
    ];
  });
}

function insertMutes(mutes: [number, number][], at: number, length: number): [number, number][] {
  return mutes.flatMap(([start, end]): [number, number][] => {
    if (end <= at) return [[start, end]];
    if (start >= at) return [[start + length, end + length]];
    return [[start, at], [at + length, end + length]];
  });
}

export function insertClip(spec: EditSpec, ownerId: string, ownerDuration: number, sourceId: string, sourceDuration: number, at: number): { spec: EditSpec; clipId: string } {
  const next = materializeSequence(spec, ownerId, ownerDuration);
  const sequence = next.sequence!;
  const position = Math.max(0, Math.min(sequenceDuration(sequence), at));
  const clip: SequenceClip = { id: id('c'), video_id: sourceId, in: 0, out: sourceDuration, source_volume: 1 };
  const windows = clipWindows(sequence);
  // At an overlap the incoming clip owns the preview frame, so an insertion
  // there must split that clip rather than the fading-out predecessor.
  let index = 0;
  for (let i = 1; i < windows.length; i++) {
    if (position >= windows[i].start - 1e-6) index = i;
  }
  const window = windows[index];
  if (position <= window.start + 1e-6) {
    sequence.clips.splice(index, 0, clip);
    // The previous incoming transition belongs to the original clip, not the new one.
    if (index > 0 && window.clip.transition) {
      clip.transition = window.clip.transition;
      window.clip.transition = null;
    }
  } else if (position >= window.end - 1e-6) {
    sequence.clips.splice(index + 1, 0, clip);
  } else {
    const original = sequence.clips[index];
    const cut = Math.max(original.in + MIN_CLIP, Math.min(original.out - MIN_CLIP, original.in + position - window.start));
    const tail: SequenceClip = { ...original, id: id('c'), in: cut, transition: null };
    original.out = cut;
    sequence.clips.splice(index + 1, 0, clip, tail);
  }
  const postPosition = sourceToPost(position, next.trim.remove);
  next.trim.remove = insertMutes(next.trim.remove, position, sourceDuration);
  next.layers = insertWindows(next.layers as (Layer & { t: [number, number] | 'all' })[], postPosition, sourceDuration, 'l');
  if (next.audio) {
    next.audio.tracks = insertWindows(next.audio.tracks as (AudioTrack & { t: [number, number] | 'all' })[], postPosition, sourceDuration, 'au');
    next.audio.source_mute = insertMutes(next.audio.source_mute ?? [], postPosition, sourceDuration);
  }
  return { spec: next, clipId: clip.id };
}

export function updateClip(spec: EditSpec, clipId: string, patch: Partial<SequenceClip>): EditSpec {
  const next = cloneSpec(spec);
  const clip = next.sequence?.clips.find((c) => c.id === clipId);
  if (clip) Object.assign(clip, patch);
  if (next.sequence) sanitizeTransitions(next.sequence);
  return 'in' in patch || 'out' in patch || 'transition' in patch ? retimeContent(spec, next) : next;
}

/** A clip keeps its own timed content when it moves or changes length. */
export function retimeContent(before: EditSpec, after: EditSpec): EditSpec {
  if (!before.sequence || !after.sequence) return after;
  const oldWindows = clipWindows(before.sequence);
  const newWindows = new Map(clipWindows(after.sequence).map((w) => [w.clip.id, w]));
  const oldVisible = oldWindows.map((w, i) => ({ clip: w.clip, start: w.start, end: oldWindows[i + 1]?.start ?? w.end }));
  const mapRawRange = ([a, b]: [number, number]): [number, number][] => oldVisible.flatMap((old) => {
    const next = newWindows.get(old.clip.id);
    if (!next) return [];
    const lo = Math.max(a, old.start);
    const hi = Math.min(b, old.end);
    if (hi - lo < 0.01) return [];
    // Match frames by their raw-source timestamp, so changing a clip's in/out
    // point trims the attached timed content instead of sliding it over new footage.
    const sourceLo = old.clip.in + lo - old.start;
    const sourceHi = old.clip.in + hi - old.start;
    const mappedA = next.start + Math.max(sourceLo, next.clip.in) - next.clip.in;
    const mappedB = next.start + Math.min(sourceHi, next.clip.out) - next.clip.in;
    return mappedB - mappedA >= 0.01 ? [[mappedA, mappedB]] : [];
  });
  after.trim.remove = normalizeRanges(before.trim.remove.flatMap(mapRawRange), sequenceDuration(after.sequence));
  const keeps = keepSegments(sequenceDuration(before.sequence), before.trim.remove);
  const mapRange = ([a, b]: [number, number]): [number, number][] => keeps.flatMap(([start, end]) => {
    const lo = Math.max(start, postToSource(a, before.trim.remove));
    const hi = Math.min(end, postToSource(b, before.trim.remove));
    return hi > lo ? mapRawRange([lo, hi]).map(([x, y]): [number, number] => [sourceToPost(x, after.trim.remove), sourceToPost(y, after.trim.remove)]).filter(([x, y]) => y - x >= 0.01) : [];
  });
  const mapItems = <T extends { id: string; t: [number, number] | 'all' }>(items: T[], prefix: string): T[] => items.flatMap((item) => {
    if (item.t === 'all') return [item];
    return mapRange(item.t).map((t, i) => ({ ...item, id: i ? id(prefix) : item.id, t }));
  });
  after.layers = mapItems(after.layers as (Layer & { t: [number, number] | 'all' })[], 'l');
  if (after.audio) {
    after.audio.tracks = mapItems(after.audio.tracks as (AudioTrack & { t: [number, number] | 'all' })[], 'au');
    after.audio.source_mute = (after.audio.source_mute ?? []).flatMap(mapRange).sort((x, y) => x[0] - y[0]);
  }
  return after;
}

function sanitizeTransitions(sequence: SequenceSpec) {
  sequence.clips[0].transition = null;
  for (let i = 1; i < sequence.clips.length; i++) {
    const clip = sequence.clips[i];
    const tr = clip.transition;
    if (tr && tr.duration >= Math.min(clipLength(clip), clipLength(sequence.clips[i - 1])) - 1e-6) {
      clip.transition = null;
    }
  }
}

export function splitClip(spec: EditSpec, clipId: string, time: number): EditSpec | null {
  if (!spec.sequence) return null;
  const next = cloneSpec(spec);
  const windows = clipWindows(next.sequence!);
  const index = windows.findIndex((w) => w.clip.id === clipId);
  if (index < 0) return null;
  const { clip, start } = windows[index];
  const cut = clip.in + time - start;
  if (cut - clip.in < MIN_CLIP || clip.out - cut < MIN_CLIP) return null;
  const tail: SequenceClip = { ...clip, id: id('c'), in: cut, transition: null };
  clip.out = cut;
  next.sequence!.clips.splice(index + 1, 0, tail);
  return next;
}

export function removeClip(spec: EditSpec, clipId: string): EditSpec | null {
  if (!spec.sequence || spec.sequence.clips.length <= 1) return null;
  const next = cloneSpec(spec);
  const clips = next.sequence!.clips;
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return null;
  clips.splice(index, 1);
  sanitizeTransitions(next.sequence!);
  return retimeContent(spec, next);
}

export function duplicateClip(spec: EditSpec, clipId: string): { spec: EditSpec; clipId: string } | null {
  if (!spec.sequence) return null;
  const next = cloneSpec(spec);
  const index = next.sequence!.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return null;
  const copy: SequenceClip = { ...next.sequence!.clips[index], id: id('c'), transition: null };
  next.sequence!.clips.splice(index + 1, 0, copy);
  sanitizeTransitions(next.sequence!);
  return { spec: retimeContent(spec, next), clipId: copy.id };
}

export function moveClip(spec: EditSpec, clipId: string, to: number): EditSpec {
  const next = cloneSpec(spec);
  const clips = next.sequence?.clips;
  if (!clips) return next;
  const from = clips.findIndex((clip) => clip.id === clipId);
  if (from < 0) return next;
  const [clip] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(clips.length, to)), 0, clip);
  sanitizeTransitions(next.sequence!);
  return retimeContent(spec, next);
}

/** Reorder a visible source block, including its internal legacy keep-ranges. */
export function moveClipGroup(spec: EditSpec, ownerId: string, groupKey: string, to: number): EditSpec {
  const next = cloneSpec(spec);
  if (!next.sequence) return next;
  const groups = clipDisplayGroups(next.sequence, ownerId);
  const from = groups.findIndex((g) => g.key === groupKey);
  if (from < 0) return next;
  const [group] = groups.splice(from, 1);
  groups.splice(Math.max(0, Math.min(groups.length, to)), 0, group);
  next.sequence.clips = groups.flatMap((g) => g.clips.map((w) => w.clip));
  sanitizeTransitions(next.sequence);
  return retimeContent(spec, next);
}

/** Move several selected clips together, keeping their original relative order. */
export function moveClipSet(spec: EditSpec, ids: string[], to: number): EditSpec {
  const next = cloneSpec(spec);
  if (!next.sequence || !ids.length) return next;
  const selected = new Set(ids);
  const moving = next.sequence.clips.filter((clip) => selected.has(clip.id));
  if (!moving.length) return next;
  const remaining = next.sequence.clips.filter((clip) => !selected.has(clip.id));
  const index = Math.max(0, Math.min(remaining.length, to));
  next.sequence.clips = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
  sanitizeTransitions(next.sequence);
  return retimeContent(spec, next);
}

export function removeClipSet(spec: EditSpec, ids: string[]): EditSpec | null {
  const next = cloneSpec(spec);
  if (!next.sequence) return null;
  const selected = new Set(ids);
  next.sequence.clips = next.sequence.clips.filter((clip) => !selected.has(clip.id));
  if (!next.sequence.clips.length) return null;
  sanitizeTransitions(next.sequence);
  return retimeContent(spec, next);
}

export function pasteClipSet(spec: EditSpec, clips: SequenceClip[], to: number): { spec: EditSpec; ids: string[] } {
  const next = cloneSpec(spec);
  if (!next.sequence || !clips.length) return { spec: next, ids: [] };
  const copies = clips.map((clip) => ({ ...structuredClone(clip), id: id('c'), transition: null }));
  const index = Math.max(0, Math.min(next.sequence.clips.length, to));
  next.sequence.clips.splice(index, 0, ...copies);
  sanitizeTransitions(next.sequence);
  return { spec: retimeContent(spec, next), ids: copies.map((clip) => clip.id) };
}

/** Delete a visible video block as one unit, including legacy keep-ranges. */
export function removeClipGroup(spec: EditSpec, ownerId: string, groupKey: string): EditSpec | null {
  if (!spec.sequence) return null;
  const groups = clipDisplayGroups(spec.sequence, ownerId);
  if (groups.length <= 1) return null;
  const group = groups.find((g) => g.key === groupKey);
  if (!group) return null;
  const next = cloneSpec(spec);
  const ids = new Set(group.clips.map((w) => w.clip.id));
  next.sequence!.clips = next.sequence!.clips.filter((clip) => !ids.has(clip.id));
  sanitizeTransitions(next.sequence!);
  return retimeContent(spec, next);
}

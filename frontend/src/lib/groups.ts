// 复合片段（HIG-85）：时间线上的片段靠可选的 `group` 字段组成一组，选中任一成员即选中整组，
// 之后的移动 / 删除 / 复制走现有的多选路径。只给编辑器用，worker 忽略该字段（契约 §2）。
//
// 能带 group 的是有 id 的时间线片段：拼接主轨片段 `clip:`、上层视频片段 `vclip:`、图层 `layer:`、音轨 `track:`。
// 非拼接视频的主轨片段 `seg:`（lib/segments）只是保留段，没有地方存 group，所以不进组。
//
// 一键复合「按画面来复合」的规则（buildCompoundGroups）：
// - 画面片段：拼接视频的每个主轨片段、非拼接视频的每个保留段（含分割点切出来的段）、每个上层视频片段；都换算到剪后时间。
// - 成员：有具体时段（不是全程）的图层与独立音轨，各自归到与它重叠最长的那个画面片段，且重叠至少占它自身时长的一半
//   （横跨多个片段的长 BGM 不硬塞进某一段）；重叠一样长时归上层视频片段（画面上看到的是它）。
// - 关联原声（linked_clip_id）跟着它的上层片段进组。
// - 一组至少两个成员（含画面片段自己）；非拼接视频的保留段不能进组，所以它那一组至少要有两个图层 / 音轨。
// - 用户 ⌘G 手动建的组（id 前缀 grp_）原样保留、不参与重算；自动组（前缀 cg_）每次一键复合全部重算。

import type { EditSpec } from '../types';
import { clipWindows } from './sequence';
import { mainSegments } from './segments';
import { sourceToPost } from './time';
import { updateVideoTrackClip, videoTrackClipDuration } from './videoTracks';
import { cloneSpec } from './spec';

export const AUTO_GROUP_PREFIX = 'cg_';
export const MANUAL_GROUP_PREFIX = 'grp_';

interface Entry {
  key: string;
  group?: string;
  /** 剪后时间；全程 / 无时段为 null。 */
  window: [number, number] | null;
  set: (group: string | undefined) => void;
}

/** 一条可进组的片段；set 同时改 spec 里的对象（原地）和 entry 自己的 group。 */
function entry(key: string, target: { group?: string }, window: [number, number] | null): Entry {
  const e: Entry = {
    key,
    group: target.group,
    window,
    set: (g) => {
      if (g) target.group = g;
      else delete target.group;
      e.group = g;
    },
  };
  return e;
}

/** spec 里所有能进组的时间线片段（直接引用 spec 里的对象）。 */
function entries(spec: EditSpec): Entry[] {
  const remove = spec.trim.remove;
  const out: Entry[] = [];
  if (spec.sequence) {
    for (const { clip, start, end } of clipWindows(spec.sequence)) out.push(entry(`clip:${clip.id}`, clip, [sourceToPost(start, remove), sourceToPost(end, remove)]));
  }
  for (const track of spec.video_tracks ?? []) {
    for (const clip of track.clips) out.push(entry(`vclip:${clip.id}`, clip, [clip.start, clip.start + videoTrackClipDuration(clip)]));
  }
  for (const layer of spec.layers) out.push(entry(`layer:${layer.id}`, layer, layer.t === 'all' ? null : layer.t));
  for (const track of spec.audio?.tracks ?? []) out.push(entry(`track:${track.id}`, track, track.t === 'all' ? null : track.t));
  return out;
}

export interface CompoundLane {
  id: string;
  keys: string[];
  window: [number, number];
}

/**
 * 时间线的“复合片段”虚拟单轨：不改 worker 契约，只把同组成员的可见范围合成一个条。
 * 全程成员按成片全长计；手动复合允许一个成员，自动组仍须至少两个。
 */
export function compoundLanes(spec: EditSpec, postDuration: number): CompoundLane[] {
  const grouped = new Map<string, Entry[]>();
  for (const e of entries(spec)) if (e.group) grouped.set(e.group, [...(grouped.get(e.group) ?? []), e]);
  const out: CompoundLane[] = [];
  for (const [id, members] of grouped) {
    if (members.length < 2 && id.startsWith(AUTO_GROUP_PREFIX)) continue;
    const windows = members.map((m) => m.window ?? [0, postDuration] as [number, number]);
    out.push({
      id,
      keys: members.map((m) => m.key),
      window: [Math.min(...windows.map((w) => w[0])), Math.max(...windows.map((w) => w[1]))],
    });
  }
  return out.sort((a, b) => a.window[0] - b.window[0] || a.id.localeCompare(b.id));
}

/** 片段的组 id；没有组或不是可进组的片段时为 undefined。 */
export function groupOf(spec: EditSpec, key: string): string | undefined {
  return entries(spec).find((e) => e.key === key)?.group;
}

/** 选中键 → 补上与其中任一键同组的全部片段（原有顺序在前）。 */
export function expandGroupSelection(spec: EditSpec, keys: string[]): string[] {
  const all = entries(spec);
  const groups = new Set(all.filter((e) => e.group && keys.includes(e.key)).map((e) => e.group!));
  if (!groups.size) return keys;
  return [...new Set([...keys, ...all.filter((e) => e.group && groups.has(e.group)).map((e) => e.key)])];
}

/** 新的手动组 id。 */
export function newGroupId(): string {
  return `${MANUAL_GROUP_PREFIX}${crypto.randomUUID().slice(0, 12)}`;
}

/** ⌘G：把选中的片段编成一个新组（原来属于别的组的一并并进来）。单个成员也可复合。 */
export function groupItems(spec: EditSpec, keys: string[], id: string = newGroupId()): EditSpec | null {
  const next = cloneSpec(spec);
  const wanted = new Set(expandGroupSelection(next, keys));
  const members = entries(next).filter((e) => wanted.has(e.key));
  if (!members.length) return null;
  for (const m of members) m.set(id);
  return next;
}

/** ⇧⌘G：解散选中片段所在的组（整组成员都去掉 group）。没有可解散的组时返回 null。 */
export function ungroupItems(spec: EditSpec, keys: string[]): EditSpec | null {
  const next = cloneSpec(spec);
  const all = entries(next);
  const groups = new Set(all.filter((e) => e.group && keys.includes(e.key)).map((e) => e.group!));
  if (!groups.size) return null;
  for (const e of all) if (e.group && groups.has(e.group)) e.set(undefined);
  return next;
}

/** 自动组拆剩一个时解散；手动复合保留单成员。原地修改。 */
export function pruneSingletonGroups(spec: EditSpec): void {
  const all = entries(spec);
  const count = new Map<string, number>();
  for (const e of all) if (e.group) count.set(e.group, (count.get(e.group) ?? 0) + 1);
  for (const e of all) if (e.group?.startsWith(AUTO_GROUP_PREFIX) && (count.get(e.group) ?? 0) < 2) e.set(undefined);
}

export interface CompoundContext {
  /** 主视频源时长（非拼接视频切保留段用；拼接视频忽略）。 */
  duration: number;
}

const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/**
 * 一键复合：按画面片段把对应的图层 / 音轨编组（规则见文件头）。返回新 spec 与组数；
 * 一组都没编出来时 groups 为 0（spec 仍会清掉旧的自动组）。
 */
export function buildCompoundGroups(spec: EditSpec, ctx: CompoundContext): { spec: EditSpec; groups: number } {
  const next = cloneSpec(spec);
  const all = entries(next);
  // 旧的自动组全部重算；手动组不动，其成员也不参与
  for (const e of all) if (e.group?.startsWith(AUTO_GROUP_PREFIX)) e.set(undefined);
  const free = (e: Entry) => !e.group;
  const remove = next.trim.remove;

  type Segment = { id: string; window: [number, number]; owner: Entry | null; upper: boolean };
  const segments: Segment[] = [];
  if (next.sequence) {
    for (const e of all) if (e.key.startsWith('clip:') && free(e) && e.window) segments.push({ id: `${AUTO_GROUP_PREFIX}${e.key.slice(5)}`, window: e.window, owner: e, upper: false });
  } else {
    for (const [a, b] of mainSegments(ctx.duration, next.trim)) {
      segments.push({ id: `${AUTO_GROUP_PREFIX}seg${Math.round(a * 1000)}`, window: [sourceToPost(a, remove), sourceToPost(b, remove)], owner: null, upper: false });
    }
  }
  for (const e of all) if (e.key.startsWith('vclip:') && free(e) && e.window) segments.push({ id: `${AUTO_GROUP_PREFIX}${e.key.slice(6)}`, window: e.window, owner: e, upper: true });

  const linkedTracks = new Map((next.audio?.tracks ?? []).filter((t) => t.linked_clip_id).map((t) => [`track:${t.id}`, `vclip:${t.linked_clip_id}`]));
  const members = new Map<Segment, Entry[]>();
  for (const e of all) {
    if (!free(e) || !e.window || e.key.startsWith('clip:') || e.key.startsWith('vclip:') || linkedTracks.has(e.key)) continue;
    const len = e.window[1] - e.window[0];
    if (len <= 1e-6) continue;
    let best: Segment | null = null;
    let bestOverlap = 0;
    for (const s of segments) {
      const o = overlap(e.window, s.window);
      if (o > bestOverlap + 1e-6 || (best && !best.upper && s.upper && Math.abs(o - bestOverlap) <= 1e-6 && o > 0)) {
        best = s;
        bestOverlap = o;
      }
    }
    if (!best || bestOverlap < len / 2 - 1e-6) continue;
    members.set(best, [...(members.get(best) ?? []), e]);
  }

  let groups = 0;
  for (const s of segments) {
    const list = [...(s.owner ? [s.owner] : []), ...(members.get(s) ?? [])];
    if (s.owner) {
      for (const e of all) if (free(e) && linkedTracks.get(e.key) === s.owner.key) list.push(e);
    }
    if (list.length < 2) continue;
    for (const e of list) e.set(s.id);
    groups += 1;
  }
  return { spec: next, groups };
}

/** 组 id → 稳定的标记色（同组同色）。 */
export function groupColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 60%)`;
}

/** ⌘A：当前视频时间线上所有可选片段（主轨拼接片段、上层视频片段、图层、音轨；关联原声跟着片段走，不单列）。 */
export function allTimelineKeys(spec: EditSpec): string[] {
  return entries(spec).filter((e) => !(e.key.startsWith('track:') && spec.audio?.tracks.find((t) => `track:${t.id}` === e.key)?.linked_clip_id)).map((e) => e.key);
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 整体平移选中的上层视频片段、图层、音轨（剪后时间 seconds 秒）。全程 / 锁定的不动，关联原声随片段同步。
 * 位移夹在 [0, postDuration] 内（上层片段只夹起点 ≥ 0）。没有可动的或位移为 0 时返回 null。
 */
export function shiftTimedItems(spec: EditSpec, keys: Set<string>, seconds: number, postDuration: number): EditSpec | null {
  if (!Number.isFinite(seconds)) return null;
  const next = cloneSpec(spec);
  const layers = next.layers.filter((l) => keys.has(`layer:${l.id}`) && !l.locked && l.t !== 'all');
  const tracks = (next.audio?.tracks ?? []).filter((t) => keys.has(`track:${t.id}`) && !t.locked && t.t !== 'all' && !t.linked_clip_id);
  const clips = (next.video_tracks ?? []).filter((track) => !track.locked).flatMap((track) => track.clips).filter((c) => keys.has(`vclip:${c.id}`));
  const timed = [...layers, ...tracks].map((item) => item.t as [number, number]);
  if (!timed.length && !clips.length) return null;
  let lo = -Infinity;
  let hi = Infinity;
  if (timed.length) {
    lo = -Math.min(...timed.map((w) => w[0]));
    hi = postDuration - Math.max(...timed.map((w) => w[1]));
  }
  if (clips.length) lo = Math.max(lo, -Math.min(...clips.map((c) => c.start)));
  const delta = Math.max(lo, Math.min(hi, seconds));
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.001) return null;
  for (const item of [...layers, ...tracks]) {
    const [a, b] = item.t as [number, number];
    item.t = [round4(a + delta), round4(b + delta)];
  }
  for (const clip of clips.map((c) => ({ id: c.id, start: c.start }))) updateVideoTrackClip(next, clip.id, { start: clip.start + delta });
  return next;
}

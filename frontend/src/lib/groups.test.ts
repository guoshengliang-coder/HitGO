import { describe, expect, it } from 'vitest';
import type { AudioTrack, EditSpec, Layer } from '../types';
import { allTimelineKeys, buildCompoundGroups, compoundLanes, expandGroupSelection, groupColor, groupItems, pruneSingletonGroups, shiftTimedItems, ungroupItems } from './groups';

const layer = (id: string, t: Layer['t'], extra: Partial<Layer> = {}): Layer =>
  ({ id, type: 'shape', shape: 'rect', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t, ...extra }) as Layer;
const track = (id: string, t: AudioTrack['t'], extra: Partial<AudioTrack> = {}): AudioTrack => ({ id, asset_id: 'a1', t, ...extra });
const base = (): EditSpec => ({ spec_version: 1, trim: { remove: [] }, layers: [], outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'crop' }] });

describe('buildCompoundGroups', () => {
  it('非拼接视频：按保留段把文字 / 音频归到重叠最长的一段，一组至少两个成员', () => {
    const spec = base();
    spec.trim = { remove: [[4, 5]], splits: [2] };
    // 保留段（剪后）：[0,2] [2,4] [4,9]
    spec.layers = [layer('a', [0.2, 1.8]), layer('b', [0.5, 2.2]), layer('c', [4.5, 8]), layer('full', 'all'), layer('long', [0.5, 6])];
    spec.audio = { source_volume: 1, tracks: [track('bgm', [4, 9])] };
    const { spec: out, groups } = buildCompoundGroups(spec, { duration: 10 });
    expect(groups).toBe(2);
    const g = (id: string) => out.layers.find((l) => l.id === id)?.group;
    expect(g('a')).toBe('cg_seg0');
    expect(g('b')).toBe('cg_seg0');
    expect(g('c')).toBe('cg_seg5000');
    expect(out.audio!.tracks[0].group).toBe('cg_seg5000');
    // 全程的、跨多段没有一段过半的，不进组
    expect(g('full')).toBeUndefined();
    expect(g('long')).toBeUndefined();
    // 原 spec 不被修改
    expect(spec.layers[0].group).toBeUndefined();
  });

  it('上层视频片段带着自己的关联原声和上面的文字成组；平局归上层片段', () => {
    const spec = base();
    spec.video_tracks = [{ id: 'vt', clips: [{ id: 'up', video_id: 'v2', start: 2, in: 0, out: 2 }] }];
    spec.layers = [layer('t', [2, 4])];
    spec.audio = { source_volume: 1, tracks: [track('linked', [2, 4], { source_kind: 'video', asset_id: 'v2', linked_clip_id: 'up' })] };
    const { spec: out, groups } = buildCompoundGroups(spec, { duration: 6 });
    expect(groups).toBe(1);
    expect(out.video_tracks![0].clips[0].group).toBe('cg_up');
    expect(out.layers[0].group).toBe('cg_up');
    expect(out.audio!.tracks[0].group).toBe('cg_up');
  });

  it('拼接视频：每个主轨片段是组主；手动组保留，旧自动组重算', () => {
    const spec = base();
    spec.sequence = { clips: [{ id: 'c1', video_id: 'v', in: 0, out: 3, group: 'cg_old' }, { id: 'c2', video_id: 'v', in: 3, out: 6 }] };
    spec.layers = [layer('x', [0, 2]), layer('y', [3.5, 5]), layer('m', [0, 1], { group: 'grp_keep' }), layer('n', [4, 5], { group: 'grp_keep' })];
    const { spec: out, groups } = buildCompoundGroups(spec, { duration: 6 });
    expect(groups).toBe(2);
    expect(out.sequence!.clips.map((c) => c.group)).toEqual(['cg_c1', 'cg_c2']);
    expect(out.layers.map((l) => l.group)).toEqual(['cg_c1', 'cg_c2', 'grp_keep', 'grp_keep']);
  });

  it('没有可组合的内容时返回 0 组', () => {
    expect(buildCompoundGroups(base(), { duration: 5 }).groups).toBe(0);
  });
});

describe('group selection / group / ungroup', () => {
  const grouped = () => {
    const spec = base();
    spec.layers = [layer('a', [0, 1], { group: 'g1' }), layer('b', [1, 2]), layer('c', [2, 3], { group: 'g1' })];
    spec.audio = { source_volume: 1, tracks: [track('t', [0, 2], { group: 'g1' })] };
    return spec;
  };

  it('选中任一成员即选中整组', () => {
    expect(expandGroupSelection(grouped(), ['layer:a'])).toEqual(['layer:a', 'layer:c', 'track:t']);
    expect(expandGroupSelection(grouped(), ['layer:b'])).toEqual(['layer:b']);
    expect(expandGroupSelection(grouped(), ['seg:0.000~1.000'])).toEqual(['seg:0.000~1.000']);
  });

  it('⌘G 编新组并吞并已有组；少于两个成员时拒绝', () => {
    const out = groupItems(grouped(), ['layer:b', 'layer:a'], 'grp_new')!;
    expect(out.layers.map((l) => l.group)).toEqual(['grp_new', 'grp_new', 'grp_new']);
    expect(out.audio!.tracks[0].group).toBe('grp_new');
    expect(groupItems(grouped(), ['layer:b'])).toBeNull();
    expect(groupItems(grouped(), ['layer:b', 'seg:0.000~1.000'])).toBeNull();
  });

  it('⇧⌘G 解散整组，字段被删掉', () => {
    const out = ungroupItems(grouped(), ['track:t'])!;
    expect(out.layers.every((l) => !('group' in l))).toBe(true);
    expect(out.audio!.tracks[0].group).toBeUndefined();
    expect(ungroupItems(grouped(), ['layer:b'])).toBeNull();
  });

  it('只剩一个成员的组被拆掉', () => {
    const spec = grouped();
    spec.layers = spec.layers.filter((l) => l.id !== 'c');
    spec.audio!.tracks = [];
    pruneSingletonGroups(spec);
    expect(spec.layers[0].group).toBeUndefined();
  });

  it('全选列出所有片段但不单列关联原声', () => {
    const spec = grouped();
    spec.video_tracks = [{ id: 'vt', clips: [{ id: 'up', video_id: 'v2', start: 0, in: 0, out: 1 }] }];
    spec.audio!.tracks.push(track('lk', [0, 1], { linked_clip_id: 'up' }));
    expect(allTimelineKeys(spec)).toEqual(['vclip:up', 'layer:a', 'layer:b', 'layer:c', 'track:t']);
  });

  it('组色稳定', () => {
    expect(groupColor('g1')).toBe(groupColor('g1'));
    expect(groupColor('g1')).toMatch(/^hsl\(/);
  });

  it('同组成员折叠成一条复合轨，范围取成员并集且全程成员覆盖成片', () => {
    const spec = grouped();
    expect(compoundLanes(spec, 8)).toEqual([{ id: 'g1', keys: ['layer:a', 'layer:c', 'track:t'], window: [0, 3] }]);
    spec.layers[0].t = 'all';
    expect(compoundLanes(spec, 8)[0].window).toEqual([0, 8]);
  });
});

describe('shiftTimedItems', () => {
  it('上层片段、图层、音轨一起平移，夹在时间轴内；关联原声随片段同步', () => {
    const spec = base();
    spec.video_tracks = [{ id: 'vt', clips: [{ id: 'up', video_id: 'v2', start: 1, in: 0, out: 2 }] }];
    spec.layers = [layer('a', [1, 3]), layer('locked', [1, 2], { locked: true }), layer('all', 'all')];
    spec.audio = { source_volume: 1, tracks: [track('lk', [1, 3], { linked_clip_id: 'up', source_kind: 'video', asset_id: 'v2' })] };
    const keys = new Set(['vclip:up', 'layer:a', 'layer:locked', 'layer:all']);
    const out = shiftTimedItems(spec, keys, 5, 6)!;
    // 图层右端到 6 为止：只能移 3
    expect(out.layers.map((l) => l.t)).toEqual([[4, 6], [1, 2], 'all']);
    expect(out.video_tracks![0].clips[0].start).toBe(4);
    expect(out.audio!.tracks[0].t).toEqual([4, 6]);
    expect(shiftTimedItems(spec, keys, -5, 6)!.layers[0].t).toEqual([0, 2]);
    expect(shiftTimedItems(spec, new Set(['layer:all']), 1, 6)).toBeNull();
  });
});

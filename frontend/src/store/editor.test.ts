// 历史栈：文字这类「输入期间 history=false、提交时才记一条」的编辑，
// 提交时必须压入编辑前的快照（pushHistorySnapshot），否则 ⌘Z 回不到编辑前。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectPostDuration, selectPostTime, useEditor } from './editor';
import { defaultTextStyle, emptySpec, type Asset, type BatchDetail, type EditSpec, type Job, type LocalizationVersion, type SafeZone, type TextLayer, type Video } from '../types';
import { api, ApiError } from '../api';
import { cloneSpec } from '../lib/spec';
import { ensureTextRendered } from '../lib/textImage';
import { DEFAULT_SCROLL_BOX, posterDuration } from '../lib/poster';

// node 环境没有 canvas：滚动文案的预览渲染换成固定尺寸（950 × 3000 px，相当于 1080 画布上 0.88 宽的一篇长文案）
vi.mock('../lib/textImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/textImage')>()),
  ensureTextRendered: vi.fn(async () => ({ canvas: null as unknown as HTMLCanvasElement, width: 950, height: 3000, pad: 0 })),
}));

const VIDEO = { id: 'v1', name: 'a.mp4', duration: 10, width: 1080, height: 1920 } as Video;

function textLayer(text: string): TextLayer {
  return { id: 'L1', type: 'text', text, style: defaultTextStyle(), anchor: 'center', margin: [0, 0], width: 0.5, rotate: 0, opacity: 1, t: 'all' };
}

function currentText(): string {
  const l = useEditor.getState().currentSpec()?.layers[0];
  return l?.type === 'text' ? l.text : '';
}

beforeEach(() => {
  // store 的自动保存用 window.setTimeout；node 环境没有 window，指到 globalThis 并用假定时器让保存不真的发出去
  vi.stubGlobal('window', globalThis);
  vi.useFakeTimers();
  const spec: EditSpec = { ...emptySpec(), layers: [textLayer('原文')] };
  useEditor.setState({ videos: [VIDEO], currentVideoId: 'v1', specs: {}, history: {}, subtitleSyncEnabled: false, timelineSelection: [], hasTimelineClipboard: false });
  useEditor.getState().replaceSpec('v1', spec);
});

describe('字幕同步与跨轨群组（HIG-70 / HIG-60）', () => {
  it('只同步本次样式和位置属性，保留各条文字与时段；关闭后恢复单条编辑', () => {
    const a = { ...textLayer('甲'), origin: 'subtitle' as const, t: [0, 1] as [number, number] };
    const b = { ...textLayer('乙'), id: 'L2', origin: 'subtitle' as const, t: [2, 3] as [number, number] };
    useEditor.getState().replaceSpec('v1', { ...emptySpec(), layers: [a, b] });
    useEditor.getState().setSubtitleSyncEnabled(true);
    useEditor.getState().updateLayer('L1', (layer) => { if (layer.type === 'text') { layer.style.background = '#00000066'; layer.margin = [0.1, 0.2]; } });
    const layers = useEditor.getState().currentSpec()!.layers as TextLayer[];
    expect(layers.map((layer) => layer.style.background)).toEqual(['#00000066', '#00000066']);
    expect(layers.map((layer) => layer.margin)).toEqual([[0.1, 0.2], [0.1, 0.2]]);
    expect(layers.map((layer) => [layer.text, layer.t])).toEqual([['甲', [0, 1]], ['乙', [2, 3]]]);
    useEditor.getState().setSubtitleSyncEnabled(false);
    useEditor.getState().updateLayer('L1', (layer) => { if (layer.type === 'text') layer.style.background = '#00000022'; });
    expect((useEditor.getState().currentSpec()!.layers[1] as TextLayer).style.background).toBe('#00000066');
  });

  it('同一次复制、粘贴和删除覆盖视频、字幕、音频且可撤销', () => {
    const spec: EditSpec = { ...emptySpec(), sequence: { clips: [{ id: 'c1', video_id: 'v1', in: 0, out: 5 }, { id: 'c2', video_id: 'v1', in: 5, out: 10 }] }, layers: [{ ...textLayer('字幕'), t: [1, 2] }], audio: { source_volume: 1, tracks: [{ id: 't1', asset_id: 'a1', role: 'bgm', align: 'post', t: [1, 3], volume: 1, loop: false }] } };
    useEditor.getState().replaceSpec('v1', spec);
    useEditor.getState().selectTimelineItems(['clip:c2', 'layer:L1', 'track:t1']);
    useEditor.getState().copyTimelineItems();
    useEditor.getState().setTime(4);
    useEditor.getState().pasteTimelineItems();
    expect(useEditor.getState().currentSpec()!.sequence!.clips).toHaveLength(3);
    expect(useEditor.getState().currentSpec()!.layers).toHaveLength(2);
    expect(useEditor.getState().currentSpec()!.audio!.tracks).toHaveLength(2);
    useEditor.getState().deleteTimelineItems();
    expect(useEditor.getState().currentSpec()!.sequence!.clips).toHaveLength(2);
    expect(useEditor.getState().currentSpec()!.layers).toHaveLength(1);
    expect(useEditor.getState().currentSpec()!.audio!.tracks).toHaveLength(1);
    useEditor.getState().undo();
    expect(useEditor.getState().currentSpec()!.sequence!.clips).toHaveLength(3);
  });

  it('多选字幕和音频后整体平移，并保留锁定图层', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [{ ...textLayer('字幕'), t: [1, 2] }, { ...textLayer('锁定'), id: 'L2', locked: true, t: [2, 3] }], audio: { source_volume: 1, tracks: [{ id: 't1', asset_id: 'a1', t: [3, 4] }] } };
    useEditor.getState().replaceSpec('v1', spec);
    useEditor.getState().selectTimelineItems(['layer:L1', 'layer:L2', 'track:t1']);
    useEditor.getState().shiftTimelineItems(2);
    const moved = useEditor.getState().currentSpec()!;
    expect(moved.layers.map((layer) => layer.t)).toEqual([[3, 4], [2, 3]]);
    expect(moved.audio!.tracks[0].t).toEqual([5, 6]);
    useEditor.getState().deleteTimelineItems();
    expect(useEditor.getState().currentSpec()!.layers).toHaveLength(1);
    expect(useEditor.getState().currentSpec()!.layers[0].id).toBe('L2');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('focusLayer（HIG-72）', () => {
  it('跨模块切到图层的编辑面板，并在重复点选时继续发出属性聚焦意图', () => {
    const layer = useEditor.getState().currentSpec()!.layers[0];
    useEditor.setState({ step: 'audio', selectedTrackId: 'track', layerFocusVersion: 0 });
    useEditor.getState().focusLayer(layer);
    expect(useEditor.getState()).toMatchObject({ step: 'text', selectedLayerId: layer.id, selectedTrackId: null, layerFocusVersion: 1 });
    useEditor.getState().focusLayer(layer);
    expect(useEditor.getState().layerFocusVersion).toBe(2);
  });
});

describe('多图层框选操作（HIG-63）', () => {
  it('追加和排除后，批量移动与删除各只记一次撤销', () => {
    const s = useEditor.getState();
    const first = textLayer('第一条');
    const second = { ...textLayer('第二条'), id: 'L2', t: [2, 4] as [number, number] };
    s.replaceSpec('v1', { ...emptySpec(), layers: [{ ...first, t: [1, 3] }, second] });
    s.selectLayers(['L1']);
    s.selectLayers(['L2'], 'add');
    expect(useEditor.getState().selectedLayerIds).toEqual(['L1', 'L2']);
    s.selectLayers(['L1'], 'subtract');
    expect(useEditor.getState().selectedLayerIds).toEqual(['L2']);
    s.selectLayers(['L1'], 'add');
    useEditor.getState().shiftSelectedLayers(1);
    expect(useEditor.getState().currentSpec()?.layers.map((l) => l.t)).toEqual([[2, 4], [3, 5]]);
    useEditor.getState().undo();
    expect(useEditor.getState().currentSpec()?.layers.map((l) => l.t)).toEqual([[1, 3], [2, 4]]);
    useEditor.getState().selectLayers(['L1', 'L2']);
    useEditor.getState().removeSelectedLayers();
    expect(useEditor.getState().currentSpec()?.layers).toEqual([]);
    useEditor.getState().undo();
    expect(useEditor.getState().currentSpec()?.layers).toHaveLength(2);
  });
});

describe('pushHistorySnapshot', () => {
  it('HIG-39 合成后 I/O、删左/右、拖动删除区间与撤销都使用完整合成时长', () => {
    const spec: EditSpec = { ...emptySpec(), sequence: { clips: [{ id: '1', video_id: 'v1', in: 0, out: 10 }, { id: '2', video_id: 'v2', in: 0, out: 20 }] } };
    const state = () => useEditor.getState();
    state().replaceSpec('v1', spec);
    state().setInPoint(12);
    state().setOutPoint(18);
    expect(state().currentSpec()?.trim.remove).toEqual([[12, 18]]);
    expect(selectPostDuration(state())).toBe(24);
    state().updateRemoveRange(0, 11, 19);
    expect(state().currentSpec()?.trim.remove).toEqual([[11, 19]]);
    state().undo();
    expect(state().currentSpec()?.trim.remove).toEqual([[12, 18]]);
    state().deleteRemoveRange(0);
    expect(selectPostDuration(state())).toBe(30);
    state().setPlayhead(22, false, 0);
    state().removeAfter();
    expect(state().currentSpec()?.trim.remove).toEqual([[22, 30]]);
    state().undo();
    state().removeBefore();
    expect(state().currentSpec()?.trim.remove).toEqual([[0, 22]]);
    state().addRemoveRange(22, 30);
    expect(state().currentSpec()?.trim.remove).toEqual([[0, 22]]);
  });
  it('提交时压入编辑前的快照，undo 回到原文、redo 重新应用', () => {
    const s = useEditor.getState();
    expect(s.canUndo()).toBe(false);
    const before = cloneSpec(s.currentSpec()!);

    s.updateLayer('L1', { text: '原文改' }, false);
    s.updateLayer('L1', { text: '原文改完' }, false);
    expect(useEditor.getState().canUndo()).toBe(false); // 逐键输入不记历史
    expect(currentText()).toBe('原文改完');

    useEditor.getState().pushHistorySnapshot(before);
    expect(useEditor.getState().canUndo()).toBe(true);

    useEditor.getState().undo();
    expect(currentText()).toBe('原文');
    expect(useEditor.getState().canRedo()).toBe(true);

    useEditor.getState().redo();
    expect(currentText()).toBe('原文改完');
  });

  it('压入的是快照副本，之后改动传入对象不影响历史；并清空 redo 栈', () => {
    const s = useEditor.getState();
    const before = cloneSpec(s.currentSpec()!);
    s.updateLayer('L1', { text: 'x' }, false);
    s.pushHistorySnapshot(before);
    (before.layers[0] as TextLayer).text = '被外部改坏';
    useEditor.getState().undo();
    expect(currentText()).toBe('原文');
    expect(useEditor.getState().canRedo()).toBe(true);

    // undo 后再压一条新快照 → future 被清掉
    useEditor.getState().pushHistorySnapshot(cloneSpec(useEditor.getState().currentSpec()!));
    expect(useEditor.getState().canRedo()).toBe(false);
  });

  it('遵守 50 条上限', () => {
    const s = useEditor.getState();
    const snap = cloneSpec(s.currentSpec()!);
    for (let i = 0; i < 60; i++) s.pushHistorySnapshot(snap);
    expect(useEditor.getState().history.v1.past.length).toBe(50);
  });

  it('没有当前视频且未指定 videoId 时不做任何事', () => {
    useEditor.setState({ currentVideoId: null });
    useEditor.getState().pushHistorySnapshot(emptySpec());
    expect(useEditor.getState().history.v1?.past.length ?? 0).toBe(0);
  });
});

// 安全区开关（HIG-13）：QuickBar 按钮只开 / 关，打开时恢复上次的显示方式。
describe('toggleSafeZone', () => {
  it('开着就关，关着就恢复上次的显示方式', () => {
    useEditor.setState({ safeZoneView: 'frames', safeZoneMode: 'frames' });
    const s = useEditor.getState();
    s.setSafeZoneView('overlay');
    expect(useEditor.getState().safeZoneMode).toBe('overlay');

    s.toggleSafeZone();
    expect(useEditor.getState().safeZoneView).toBe('none');
    expect(useEditor.getState().safeZoneMode).toBe('overlay'); // 关闭不改记住的方式

    s.toggleSafeZone();
    expect(useEditor.getState().safeZoneView).toBe('overlay');
  });

  it('默认打开为框线', () => {
    useEditor.setState({ safeZoneView: 'none', safeZoneMode: 'frames' });
    useEditor.getState().toggleSafeZone();
    expect(useEditor.getState().safeZoneView).toBe('frames');
  });
});

describe('封面（HIG-9）', () => {
  const base = { url: '/media/x', source: 'upload', created_at: '' } as const;
  const assets: Asset[] = [
    { ...base, id: 'a_img', type: 'sticker', name: 'c.jpg', kind: 'image', width: 720, height: 1280 },
    { ...base, id: 'a_prep', type: 'sticker', name: 'c.mp4', kind: 'video', status: 'preparing' },
    { ...base, id: 'a_font', type: 'font', name: 'f.ttf' },
  ];

  it('只接受就绪的贴纸素材；默认 1 秒，调时长夹到 [0.1, 10]；可撤销', () => {
    useEditor.setState({ assets });
    const s = useEditor.getState();
    s.setCover('a_font');
    s.setCover('a_prep');
    expect(useEditor.getState().currentSpec()?.cover).toBeUndefined();

    s.setCover('a_img');
    expect(useEditor.getState().currentSpec()?.cover).toEqual({ asset_id: 'a_img', duration: 1 });
    useEditor.getState().setCoverDuration(42);
    expect(useEditor.getState().currentSpec()?.cover?.duration).toBe(10);

    useEditor.getState().clearCover();
    expect(useEditor.getState().currentSpec()?.cover).toBeUndefined();
    useEditor.getState().undo();
    expect(useEditor.getState().currentSpec()?.cover).toEqual({ asset_id: 'a_img', duration: 10 });
  });

  it('封面段里（time < 0）入点夹到 0，删左 / 删右不可用', () => {
    useEditor.setState({ time: -0.5 });
    const s = useEditor.getState();
    expect(s.canRemoveBefore()).toBe(false);
    expect(s.canRemoveAfter()).toBe(false);
    s.setInPoint(-0.5);
    expect(useEditor.getState().inPoint).toBe(0);
  });
});

describe('切换任务时重置（HIG-18）', () => {
  const BATCH_B = {
    id: 'b2',
    name: '新任务',
    videos: [{ id: 'v9', name: 'b.mp4', duration: 8, width: 1080, height: 1920, status: 'ready' } as Video],
  } as unknown as BatchDetail;

  const ZONES = [{ key: 'generic-vertical', name: '通用竖版', aspect: '9x16', zones: [] }] as SafeZone[];
  const STICKER = { id: 'a1', type: 'sticker', kind: 'image', status: 'ready', name: 's.png', url: '/s.png' } as unknown as Asset;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('load 清掉上一个任务的残余，跨任务的偏好和全局素材库留着', async () => {
    vi.spyOn(api, 'getBatch').mockResolvedValue(BATCH_B);
    vi.spyOn(api, 'batchJobs').mockResolvedValue([]);
    vi.spyOn(api, 'putSpec').mockResolvedValue(VIDEO);
    // 让这两个请求一直挂着：loadAssets / loadTextPresets 是 fire-and-forget，
    // 若让它们完成就分不清 assets 是「没被重置清掉」还是「被重新拉回来了」
    vi.spyOn(api, 'listAssets').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'listPresets').mockReturnValue(new Promise(() => {}));

    useEditor.setState({
      batch: { id: 'b1', name: '上一个任务', videos: [VIDEO] } as unknown as BatchDetail,
      safeZones: ZONES,
      assets: [STICKER],
      theme: 'light',
      // 上一个任务留下的残余
      layerClipboard: [textLayer('上个任务的图层')],
      layerClipboardVideoId: 'v1',
      styleClipboard: defaultTextStyle(),
      toast: '上个任务的提示',
      toastAction: { label: '撤销', run: () => {} },
      progressOpen: true,
      rendering: true,
      jobs: [{ id: 'j1', status: 'running' } as unknown as Job],
      trackedJobIds: ['j1'],
      selectedIds: ['v1'],
      selectedLayerId: 'L1',
      selectedRangeIndex: 2,
      selectedTrackId: 't1',
      inPoint: 3,
      timelinePps: 40,
      playing: true,
      step: 'sticker',
      cropEditing: true,
    });

    await useEditor.getState().load('b2');
    const s = useEditor.getState();

    expect(s.batch?.id).toBe('b2');
    expect(Object.keys(s.specs)).toEqual(['v9']);
    expect(s.currentVideoId).toBe('v9');

    // 残余全部归零：剪贴板是最要命的一个，它能把上个任务的图层粘进新工程
    expect(s.layerClipboard).toBeNull();
    expect(s.layerClipboardVideoId).toBeNull();
    expect(s.styleClipboard).toBeNull();
    expect(s.toast).toBeNull();
    expect(s.toastAction).toBeNull();
    expect(s.progressOpen).toBe(false);
    expect(s.rendering).toBe(false);
    expect(s.jobs).toEqual([]);
    expect(s.trackedJobIds).toEqual([]);
    expect(s.selectedIds).toEqual([]);
    expect(s.selectedLayerId).toBeNull();
    expect(s.selectedRangeIndex).toBeNull();
    expect(s.selectedTrackId).toBeNull();
    expect(s.inPoint).toBeNull();
    expect(s.timelinePps).toBeNull();
    expect(s.playing).toBe(false);
    expect(s.time).toBe(0);
    expect(s.step).toBe('trim');
    expect(s.cropEditing).toBe(false);
    expect(s.history).toEqual({});

    // 跨任务的东西不该被一把梭清掉
    expect(s.safeZones).toEqual(ZONES);
    expect(s.theme).toBe('light');
    expect(s.assets).toEqual([STICKER]);
  });

  it('load 前把上一个任务的草稿写回，不丢最后 1 秒的编辑', async () => {
    vi.spyOn(api, 'getBatch').mockResolvedValue(BATCH_B);
    vi.spyOn(api, 'batchJobs').mockResolvedValue([]);
    vi.spyOn(api, 'listAssets').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'listPresets').mockReturnValue(new Promise(() => {}));
    const putSpec = vi.spyOn(api, 'putSpec').mockResolvedValue(VIDEO);

    // beforeEach 的 replaceSpec 已经排了一次防抖保存，此时还没到点
    expect(putSpec).not.toHaveBeenCalled();
    await useEditor.getState().load('b2');

    expect(putSpec).toHaveBeenCalledTimes(1);
    expect(putSpec.mock.calls[0][0]).toBe('v1');
  });
});

// 遮盖层（契约 §2 type = "mask"）：新建 / 粘贴都压在第一个文字图层之下。
describe('遮盖层的插入位置', () => {
  const mask = (id: string) => ({ id, type: 'mask' as const, mode: 'blur' as const, anchor: 'bottom-center' as const, margin: [0, 0.1] as [number, number], width: 1, height: 0.12, rotate: 0, opacity: 1, t: 'all' as const });
  const sticker = (id: string) => ({ id, type: 'sticker' as const, asset_id: 'a', anchor: 'center' as const, margin: [0, 0] as [number, number], width: 0.3, rotate: 0, opacity: 1, t: 'all' as const });
  const ids = () => useEditor.getState().currentSpec()!.layers.map((l) => l.id);

  it('addLayer 缺省放最上层；belowType 指定时插到该类第一个之前', () => {
    const s = useEditor.getState();
    s.addLayer(sticker('S1'));
    expect(ids()).toEqual(['L1', 'S1']);
    useEditor.getState().addLayer(mask('M1'), { belowType: 'text' });
    expect(ids()).toEqual(['M1', 'L1', 'S1']);
    expect(useEditor.getState().selectedLayerId).toBe('M1');
    // 没有该类图层时等于放最上层
    useEditor.getState().addLayer(mask('M2'), { belowType: 'sticker' });
    expect(ids()).toEqual(['M1', 'L1', 'M2', 'S1']);
    // 一步历史，可撤销
    useEditor.getState().undo();
    expect(ids()).toEqual(['M1', 'L1', 'S1']);
  });

  it('pasteLayer：字幕模块里粘贴遮盖插到文字之下，文字仍放最上层', () => {
    useEditor.setState({ step: 'subtitle' });
    let s = useEditor.getState();
    s.addLayer(mask('M1'), { belowType: 'text' });
    useEditor.getState().setSelectedLayer('M1');
    useEditor.getState().copyLayer();
    useEditor.getState().pasteLayer();
    s = useEditor.getState();
    const layers = s.currentSpec()!.layers;
    expect(layers.map((l) => l.type)).toEqual(['mask', 'mask', 'text']);
    expect(layers[1].margin).toEqual([0.03, 0.13]); // 同一视频里粘贴错开 3%
    expect(s.selectedLayerId).toBe(layers[1].id);

    useEditor.getState().setSelectedLayer('L1');
    useEditor.getState().copyLayer();
    useEditor.getState().pasteLayer();
    expect(useEditor.getState().currentSpec()!.layers.map((l) => l.type)).toEqual(['mask', 'mask', 'text', 'text']);
  });

  it('pasteLayer：遮盖只能粘到字幕模块，提示切模块', () => {
    useEditor.setState({ step: 'subtitle' });
    useEditor.getState().addLayer(mask('M1'), { belowType: 'text' });
    useEditor.getState().setSelectedLayer('M1');
    useEditor.getState().copyLayer();
    useEditor.setState({ step: 'text' });
    useEditor.getState().pasteLayer();
    expect(useEditor.getState().toast).toContain('遮盖');
    expect(useEditor.getState().toast).toContain('字幕');
    expect(ids()).toEqual(['M1', 'L1']);
    // 贴纸粘到字幕模块同样拦下
    useEditor.setState({ step: 'sticker' });
    useEditor.getState().addLayer(sticker('S1'));
    useEditor.getState().setSelectedLayer('S1');
    useEditor.getState().copyLayer();
    useEditor.setState({ step: 'subtitle' });
    useEditor.getState().pasteLayer();
    expect(useEditor.getState().toast).toContain('贴纸');
    expect(ids()).toEqual(['M1', 'L1', 'S1']);
  });
});

// 改语言：套用一个语言版本 = 一步历史；换版本替换上一版的层 / 轨；不可用时不入历史。
describe('改语言套用（applyVersion）', () => {
  const dubbed = (id: string, lang: string): Asset => ({ id, type: 'audio', kind: 'audio', status: 'ready', name: `${lang}.m4a`, url: '/media/x', source: 'derived', derived_from: { video_id: 'v1', video_name: 'a.mp4', stem: 'dubbed', lang }, created_at: '' });
  const ver = (assetId: string, translated: string): LocalizationVersion => ({ status: 'done', stage: null, voice: null, terms: [], cues: [{ i: 0, translated }], stale: false, error: null, warnings: [], voice_asset_id: assetId, updated_at: 'x' });
  const LOC_VIDEO = {
    ...VIDEO,
    has_audio: true,
    status: 'ready',
    separation: { status: 'done', model: 'htdemucs', vocals_asset_id: 'a_voc', instrumental_asset_id: 'a_inst' },
    localization: {
      source_lang: 'en',
      transcript: { status: 'done', cues: [{ i: 0, start: 1, end: 3, text: 'Hello.' }] },
      versions: { ko: ver('a_ko', '안녕.'), ja: ver('a_ja', 'こんにちは。'), de: { ...ver('a_de', 'Hallo.'), status: 'running' } },
    },
  } as Video;
  const assets: Asset[] = [dubbed('a_ko', 'ko'), dubbed('a_ja', 'ja'), { ...dubbed('a_inst', ''), derived_from: { video_id: 'v1', video_name: 'a.mp4', stem: 'instrumental' } }];

  beforeEach(() => {
    useEditor.setState({ videos: [LOC_VIDEO], assets, localizeOptions: null, toast: null, toastAction: null });
    // 用户自己的东西：一个文字层、一条 BGM 轨
    useEditor.getState().replaceSpec('v1', { ...emptySpec(), layers: [textLayer('用户标题')], audio: { source_volume: 1, tracks: [{ id: 'au_user', asset_id: 'a_up', role: 'bgm', t: 'all' }] } });
  });

  const spec = () => useEditor.getState().currentSpec()!;
  const localizeLayers = () => spec().layers.filter((l) => l.origin === 'localize');
  const localizeTracks = () => spec().audio!.tracks.filter((t) => t.origin === 'localize');

  it('套用 = 一步历史，toast 带撤销；再套同一版本是空操作', () => {
    const before = cloneSpec(spec());
    expect(useEditor.getState().applyVersion('ko')).toBe(true);
    const st = useEditor.getState();
    expect(st.history.v1.past).toHaveLength(1);
    expect(st.toast).toContain('已套用韩语版');
    expect(st.toastAction?.label).toBe('撤销');
    expect(spec().audio!.source_volume).toBe(0);
    expect(localizeTracks().map((t) => [t.role, t.asset_id, t.align])).toEqual([
      ['voice', 'a_ko', 'source'],
      ['bgm', 'a_inst', 'source'],
    ]);
    expect(localizeLayers().map((l) => (l as TextLayer).text)).toEqual(['안녕.']);
    // 字幕层在最后（压在其它层之上），用户的层 / 轨原样保留
    expect(spec().layers[0].id).toBe('L1');
    expect(spec().layers[spec().layers.length - 1].origin).toBe('localize');
    expect(spec().audio!.tracks[0].id).toBe('au_user');

    // 幂等：已是当前版本 → 不改 spec、不记历史
    const applied = cloneSpec(spec());
    expect(useEditor.getState().applyVersion('ko')).toBe(false);
    expect(useEditor.getState().history.v1.past).toHaveLength(1);
    expect(spec()).toEqual(applied);

    // 撤销回到套用前
    st.toastAction!.run();
    expect(spec()).toEqual(before);
    expect(useEditor.getState().canRedo()).toBe(true);
  });

  it('切换语言：上一版的层 / 轨被替换，用户的层 / 轨不动，还是一步历史', () => {
    useEditor.getState().applyVersion('ko');
    expect(useEditor.getState().applyVersion('ja')).toBe(true);
    expect(useEditor.getState().history.v1.past).toHaveLength(2);
    expect(localizeLayers().map((l) => [l.lang, (l as TextLayer).text])).toEqual([['ja', 'こんにちは。']]);
    expect(localizeTracks().map((t) => [t.lang, t.asset_id])).toEqual([
      ['ja', 'a_ja'],
      ['ja', 'a_inst'],
    ]);
    expect(spec().layers.filter((l) => l.id === 'L1')).toHaveLength(1);
    expect(spec().audio!.tracks.filter((t) => t.id === 'au_user')).toHaveLength(1);
    expect(spec().audio!.tracks).toHaveLength(3);
    useEditor.getState().undo();
    expect(localizeLayers()[0].lang).toBe('ko');
  });

  it('不可用（没这个版本 / 生成中 / 素材不存在）时返回 false、不入历史、toast 原因', () => {
    const before = cloneSpec(spec());
    expect(useEditor.getState().applyVersion('fr')).toBe(false);
    expect(useEditor.getState().toast).toBe('还没有这个语言的版本');
    expect(useEditor.getState().applyVersion('de')).toBe(false);
    expect(useEditor.getState().toast).toBe('这个版本还在生成中');
    useEditor.setState({ assets: [] });
    expect(useEditor.getState().applyVersion('ko')).toBe(false);
    expect(useEditor.getState().toast).toContain('不存在');
    expect(useEditor.getState().history.v1?.past ?? []).toHaveLength(0);
    expect(spec()).toEqual(before);
    expect(useEditor.getState().toastAction).toBeNull();
  });

  it('force 重新套用：沿用已调过的字幕样式，记一步历史', () => {
    useEditor.getState().applyVersion('ko');
    const l = localizeLayers()[0];
    useEditor.getState().updateLayer(l.id, (x) => {
      if (x.type === 'text') x.style.color = '#123456';
    });
    expect(useEditor.getState().applyVersion('ko', { force: true })).toBe(true);
    expect(useEditor.getState().history.v1.past).toHaveLength(3);
    const nl = localizeLayers()[0] as TextLayer;
    expect(nl.id).not.toBe(l.id);
    expect(nl.style.color).toBe('#123456');
  });

  it('没有伴奏时不套用，避免成片丢失原 BGM', () => {
    useEditor.setState({ videos: [{ ...LOC_VIDEO, separation: null }] });
    expect(useEditor.getState().applyVersion('ko')).toBe(false);
    expect(localizeTracks()).toEqual([]);
    expect(useEditor.getState().toast).toContain('原伴奏尚未就绪');
  });
});

describe('转语言主流程（HIG-74）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('自动分离与口播并行；口播先完成时等待伴奏就绪再套用', async () => {
    const base = { ...VIDEO, id: 'v_quick', has_audio: true, status: 'ready' } as Video;
    const queued = { source_lang: 'en', transcript: { status: 'queued', cues: [] }, versions: { ko: { status: 'queued', stage: null, voice_asset_id: null, cues: [] } } } as unknown as Video['localization'];
    const done = { source_lang: 'en', transcript: { status: 'done', cues: [{ i: 0, start: 0, end: 2, text: 'Hello' }] }, versions: { ko: { status: 'done', stage: null, voice: 'kyong', terms: [], cues: [{ i: 0, translated: '안녕' }], stale: false, error: null, warnings: [], voice_asset_id: 'a_quick', updated_at: 'done' } } } as Video['localization'];
    const sepQueued = { status: 'queued', model: 'htdemucs' } as Video['separation'];
    const sepRunning = { status: 'running', model: 'htdemucs' } as Video['separation'];
    const sepDone = { status: 'done', model: 'htdemucs', vocals_asset_id: 'a_voc', instrumental_asset_id: 'a_inst' } as Video['separation'];
    const asset = (id: string, stem: 'dubbed' | 'instrumental'): Asset => ({ id, type: 'audio', kind: 'audio', status: 'ready', name: `${id}.m4a`, url: '/media/x', source: 'derived', derived_from: { video_id: base.id, video_name: base.name, stem }, created_at: '' });
    useEditor.setState({ videos: [base], currentVideoId: base.id, assets: [], specs: {}, history: {},
      loadAssets: vi.fn(async () => useEditor.setState({ assets: [asset('a_quick', 'dubbed'), asset('a_inst', 'instrumental')] })) });
    useEditor.getState().replaceSpec(base.id, emptySpec());
    const separate = vi.spyOn(api, 'separateVideo').mockResolvedValue({ ...base, separation: sepQueued });
    vi.spyOn(api, 'localizeVideo').mockResolvedValue({ ...base, separation: sepQueued, localization: queued });
    const states = [
      { ...base, separation: sepRunning, localization: queued },
      { ...base, separation: sepRunning, localization: done },
      { ...base, separation: sepDone, localization: done },
    ];
    let read = 0;
    vi.spyOn(api, 'getVideo').mockImplementation(async () => states[Math.min(read++, states.length - 1)]);

    expect(await useEditor.getState().localizeVideo({ target_langs: ['ko'], voices: { ko: 'kyong' }, dub: true }, { bgm: { mode: 'keep' } })).toBe(true);
    expect(separate).toHaveBeenCalledWith(base.id, 'htdemucs');
    await vi.advanceTimersByTimeAsync(2000);
    expect(useEditor.getState().currentSpec()?.audio?.tracks ?? []).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useEditor.getState().currentSpec()?.audio?.tracks.map((t) => t.asset_id)).toEqual(['a_quick', 'a_inst']);
  });
});

describe('上传后的预处理状态自动刷新（HIG-24）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('还有 preparing 的视频就轮询批次详情，就绪后更新状态且不动草稿', async () => {
    const preparing = { id: 'v7', name: 'new.mp4', duration: 0, width: 0, height: 0, status: 'preparing' } as Video;
    const ready = { ...preparing, duration: 12, width: 1080, height: 1920, status: 'ready' } as Video;
    const batch = (v: Video) => ({ id: 'b7', name: '批次', videos: [v] }) as unknown as BatchDetail;
    const getBatch = vi.spyOn(api, 'getBatch').mockResolvedValueOnce(batch(preparing)).mockResolvedValueOnce(batch(preparing)).mockResolvedValue(batch(ready));
    vi.spyOn(api, 'batchJobs').mockResolvedValue([]);
    vi.spyOn(api, 'putSpec').mockResolvedValue(VIDEO);
    vi.spyOn(api, 'listAssets').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'listPresets').mockReturnValue(new Promise(() => {}));
    useEditor.setState({ safeZones: [{ key: 'generic-vertical', name: '通用竖版', aspect: '9x16', zones: [] }] as SafeZone[] });

    await useEditor.getState().load('b7');
    expect(useEditor.getState().videos[0].status).toBe('preparing');
    const draft = useEditor.getState().specs.v7;

    await vi.advanceTimersByTimeAsync(2000); // 第 1 轮：还在准备
    expect(useEditor.getState().videos[0].status).toBe('preparing');
    await vi.advanceTimersByTimeAsync(2000); // 第 2 轮：就绪
    expect(useEditor.getState().videos[0].status).toBe('ready');
    expect(useEditor.getState().specs.v7).toBe(draft);

    const calls = getBatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000); // 没有 preparing 了就停
    expect(getBatch.mock.calls.length).toBe(calls);
  });
});

describe('删除视频（HIG-20）', () => {
  const v = (id: string) => ({ id, name: `${id}.mp4`, duration: 10, width: 1080, height: 1920, status: 'ready' }) as Video;

  beforeEach(() => {
    useEditor.setState({
      batch: { id: 'b1', name: '批次', videos: [v('v1'), v('v2'), v('v3')], video_count: 3 } as unknown as BatchDetail,
      videos: [v('v1'), v('v2'), v('v3')],
      currentVideoId: 'v2',
      selectedIds: ['v2', 'v3'],
      specs: { v1: emptySpec(), v2: emptySpec(), v3: emptySpec() },
      history: { v2: { past: [emptySpec()], future: [] } },
      jobs: [{ id: 'j2', video_id: 'v2', status: 'done' } as unknown as Job],
      trackedJobIds: ['j2'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('删掉的视频从列表 / 草稿 / 历史 / 勾选里拿掉，当前切到后一条', async () => {
    const del = vi.spyOn(api, 'deleteVideo').mockResolvedValue(undefined);
    await useEditor.getState().deleteVideos(['v2']);
    const s = useEditor.getState();
    expect(del).toHaveBeenCalledWith('v2');
    expect(s.videos.map((x) => x.id)).toEqual(['v1', 'v3']);
    expect(s.batch?.videos.map((x) => x.id)).toEqual(['v1', 'v3']);
    expect(Object.keys(s.specs)).toEqual(['v1', 'v3']);
    expect(s.history.v2).toBeUndefined();
    expect(s.selectedIds).toEqual(['v3']);
    expect(s.currentVideoId).toBe('v3');
    expect(s.jobs).toEqual([]);
    expect(s.trackedJobIds).toEqual([]);
    expect(s.toast).toBe('已删除 1 条视频');
  });

  it('删掉最后的视频后清空关联的编辑选择和弹窗状态（HIG-78）', async () => {
    useEditor.setState({
      batch: { id: 'b1', name: '批次', videos: [v('v2')], video_count: 1 } as unknown as BatchDetail,
      videos: [v('v2')],
      currentVideoId: 'v2',
      selectedClipId: 'clip-old',
      selectedLayerId: 'layer-old',
      replacingLayerId: 'layer-old',
      selectedMuteIndex: 0,
      exportDialog: { scope: 'current' },
      saveState: 'dirty',
      saveError: '旧视频保存失败',
      time: 4,
      timelinePps: 400,
    });
    vi.spyOn(api, 'deleteVideo').mockResolvedValue(undefined);
    await useEditor.getState().deleteVideos(['v2']);
    const s = useEditor.getState();
    expect(s.videos).toEqual([]);
    expect(s.currentVideoId).toBeNull();
    expect(s.currentSpec()).toBeNull();
    expect([s.selectedClipId, s.selectedLayerId, s.replacingLayerId, s.selectedMuteIndex, s.exportDialog]).toEqual([null, null, null, null, null]);
    expect(s.time).toBe(0);
    expect(s.timelinePps).toBeNull();
    expect(s.saveState).toBe('idle');
    expect(s.saveError).toBeNull();
  });

  it('删除后晚到的草稿保存响应不恢复旧视频状态', async () => {
    useEditor.setState({ batch: { id: 'b1', name: '批次', videos: [v('v2')], video_count: 1 } as unknown as BatchDetail,
      videos: [v('v2')], currentVideoId: 'v2' });
    let resolveSave!: (video: Video) => void;
    vi.spyOn(api, 'putSpec').mockReturnValue(new Promise<Video>((resolve) => { resolveSave = resolve; }));
    vi.spyOn(api, 'deleteVideo').mockResolvedValue(undefined);
    useEditor.getState().replaceSpec('v2', emptySpec());
    await vi.advanceTimersByTimeAsync(1000);
    expect(useEditor.getState().saveState).toBe('saving');
    await useEditor.getState().deleteVideos(['v2']);
    resolveSave(v('v2'));
    await Promise.resolve();
    expect(useEditor.getState().videos).toEqual([]);
    expect(useEditor.getState().saveState).toBe('idle');
  });

  it('接口拒绝（有渲染在跑）的那条留着，并提示原因', async () => {
    const { ApiError } = await import('../api');
    vi.spyOn(api, 'deleteVideo').mockImplementation(async (id) => {
      if (id === 'v3') throw new ApiError(409, '这条视频有进行中的渲染任务，等任务结束后再删除');
    });
    await useEditor.getState().deleteVideos(['v1', 'v3']);
    const s = useEditor.getState();
    expect(s.videos.map((x) => x.id)).toEqual(['v2', 'v3']);
    expect(s.currentVideoId).toBe('v2');
    expect(s.toast).toContain('已删除 1 条视频');
    expect(s.toast).toContain('「v3.mp4」这条视频有进行中的渲染任务');
  });
});

// 大字报（HIG-50）：滚动文案图层、朗读轨与成片时长 trim.duration 的联动
describe('大字报（HIG-50）', () => {
  const ZONE = { key: 'douyin', name: '抖音', aspect: '9x16', zones: [], inner: { x: 0.1, y: 0.2, w: 0.8, h: 0.5, label: '内' } } as SafeZone;
  const spec = () => useEditor.getState().currentSpec()!;
  const poster = () => useEditor.getState().posterLayer();

  beforeEach(() => {
    useEditor.setState({ assets: [], safeZones: [ZONE], safeZoneKey: 'douyin', toast: null, posterVoicePending: null, lap: 0 });
    useEditor.getState().replaceSpec('v1', emptySpec());
    vi.mocked(ensureTextRendered).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addPosterLayer：框取当前安全区的内安全框，按框宽折行、宽 = 框宽，选中并返回 id；没有内安全框时用缺省框', async () => {
    const id = useEditor.getState().addPosterLayer('第一行\n第二行');
    expect(id).not.toBeNull();
    const l = poster()!;
    expect(l.id).toBe(id);
    expect(l.text).toBe('第一行\n第二行');
    expect(l.scroll?.box).toEqual({ x: 0.1, y: 0.2, w: 0.8, h: 0.5 });
    expect(l.style.wrap_width).toBe(0.8);
    expect(l.width).toBe(0.8);
    expect(l.width_manual).toBe(true);
    expect(l.style.font_size).toBe(0.045);
    expect(l.style.line_height).toBe(1.4);
    expect(l.style.align).toBe('center');
    expect(useEditor.getState().selectedLayerId).toBe(id);
    // 预览渲染回来后 image_size 写进图层、成片时长跟着算出来
    await vi.advanceTimersByTimeAsync(0);
    expect(poster()!.image_size).toEqual([950, 3000]);
    expect(spec().trim.duration).toBe(posterDuration(spec(), []));
    expect(spec().trim.duration).toBeGreaterThan(0);

    useEditor.setState({ safeZoneKey: 'generic-vertical' });
    useEditor.getState().replaceSpec('v1', emptySpec());
    useEditor.getState().addPosterLayer();
    expect(poster()!.scroll?.box).toEqual(DEFAULT_SCROLL_BOX);
    expect(poster()!.text).toBe('');
  });

  it('setScroll：合并进缺省值；改框时折行宽 / 图层宽跟着框宽走并重算成片时长', async () => {
    const id = useEditor.getState().addPosterLayer('文案')!;
    await vi.advanceTimersByTimeAsync(0);
    const before = spec().trim.duration!;
    useEditor.getState().setScroll(id, { speed: 0.16 });
    expect(poster()!.scroll).toMatchObject({ speed: 0.16, start: 'enter', end: 'exit', hold_start: 0, hold_end: 0 });
    expect(spec().trim.duration).toBeLessThan(before); // 快一倍，滚动时长减半

    useEditor.getState().setScroll(id, { box: { x: 0.2, y: 0.1, w: 0.6, h: 0.7 } });
    await vi.advanceTimersByTimeAsync(0);
    const l = poster()!;
    expect(l.scroll?.box).toEqual({ x: 0.2, y: 0.1, w: 0.6, h: 0.7 });
    expect(l.scroll?.speed).toBe(0.16);
    expect(l.style.wrap_width).toBe(0.6);
    expect(l.width).toBe(0.6);
    expect(spec().trim.duration).toBe(posterDuration(spec(), []));
  });

  it('setPosterText：上色区间随文字平移；autoHighlight 把后端挑出的词组并入区间', async () => {
    const id = useEditor.getState().addPosterLayer('今天大促')!;
    useEditor.getState().updateLayer(id, { spans: [{ start: 2, end: 4, color: '#FF0000' }] });
    useEditor.getState().setPosterText(id, '明天今天大促');
    expect(poster()!.text).toBe('明天今天大促');
    expect(poster()!.spans).toEqual([{ start: 4, end: 6, color: '#FF0000' }]);

    vi.spyOn(api, 'highlight').mockResolvedValue({ phrases: [{ text: '明天', start: 0, end: 2 }] });
    expect(await useEditor.getState().autoHighlight(id)).toBe(true);
    expect(poster()!.spans!.map((s) => [s.start, s.end])).toEqual([[0, 2], [4, 6]]);

    vi.spyOn(api, 'highlight').mockRejectedValue(new ApiError(503, '重点提取未配置'));
    expect(await useEditor.getState().autoHighlight(id)).toBe(false);
    expect(useEditor.getState().toast).toBe('重点提取未配置');
  });

  it('syncPosterDuration：按滚动 / 朗读写 trim.duration，不记历史；没变不写；什么都没有时清掉', async () => {
    const id = useEditor.getState().addPosterLayer('文案')!;
    await vi.advanceTimersByTimeAsync(0);
    const past = useEditor.getState().history.v1.past.length;
    const d = spec().trim.duration!;
    expect(d).toBe(posterDuration(spec(), []));
    const snapshot = spec();
    useEditor.getState().syncPosterDuration();
    expect(spec()).toBe(snapshot); // 没变：不写、不排保存
    expect(useEditor.getState().history.v1.past.length).toBe(past);

    // 删掉滚动图层 → 清掉成片时长
    useEditor.getState().removeLayer(id);
    expect(spec().trim.duration).toBeUndefined();
    expect(useEditor.getState().history.v1.past.length).toBe(past + 1);
  });

  it('generateVoice：素材就绪后替换旧朗读轨、加为口播轨并写成片时长；失败 toast 后端 detail 并返回 null', async () => {
    const tts = (id: string, status: 'preparing' | 'ready', duration?: number): Asset => ({ id, type: 'audio', kind: 'audio', status, name: '朗读', url: '/media/tts.m4a', source: 'derived', duration, derived_from: { stem: 'tts', lang: 'zh', voice: 'v1' }, created_at: '' });
    // 上一次生成的朗读轨（tts 派生素材）应被替换；用户自己的 BGM 轨留着
    const old = tts('a_old', 'ready', 5);
    useEditor.setState({ assets: [old] });
    useEditor.getState().replaceSpec('v1', { ...emptySpec(), audio: { source_volume: 1, tracks: [{ id: 'au_bgm', asset_id: 'a_bgm', role: 'bgm', t: 'all' }, { id: 'au_old', asset_id: 'a_old', role: 'voice', align: 'post', t: [0, 5] }] } });
    vi.spyOn(api, 'synthesizeTts').mockResolvedValue(tts('a_new', 'preparing'));
    vi.spyOn(api, 'getAsset').mockResolvedValue(tts('a_new', 'ready', 12.34));

    const id = await useEditor.getState().generateVoice('文案', 'zh', 'v1', 1.2);
    expect(id).toBe('a_new');
    expect(api.synthesizeTts).toHaveBeenCalledWith({ text: '文案', lang: 'zh', voice: 'v1', speech_rate: 1.2 });
    expect(useEditor.getState().posterVoicePending).toBe('a_new');
    expect(useEditor.getState().assets.map((a) => a.id)).toEqual(['a_old', 'a_new']);

    await vi.advanceTimersByTimeAsync(2000); // 轮询到就绪
    const st = useEditor.getState();
    expect(st.posterVoicePending).toBeNull();
    expect(st.assets.find((a) => a.id === 'a_new')?.status).toBe('ready');
    const tracks = spec().audio!.tracks;
    expect(tracks.map((t) => [t.id === 'au_bgm' ? 'au_bgm' : 'new', t.role, t.asset_id])).toEqual([
      ['au_bgm', 'bgm', 'a_bgm'],
      ['new', 'voice', 'a_new'],
    ]);
    expect(tracks[1]).toMatchObject({ align: 'post', t: [0, 12.34], offset: 0, volume: 1, loop: false });
    expect(st.selectedTrackId).toBe(tracks[1].id);
    expect(spec().trim.duration).toBe(12.4);
    expect(st.toast).toContain('已加为口播轨');

    vi.spyOn(api, 'synthesizeTts').mockRejectedValue(new ApiError(503, '朗读服务未配置'));
    expect(await useEditor.getState().generateVoice('文案', 'zh', 'v1')).toBeNull();
    expect(useEditor.getState().toast).toBe('朗读服务未配置');
  });

  it('generateVoice：素材处理失败时清掉 pending 并提示', async () => {
    vi.spyOn(api, 'synthesizeTts').mockResolvedValue({ id: 'a_bad', type: 'audio', kind: 'audio', status: 'preparing', name: '朗读', url: '', source: 'derived', derived_from: { stem: 'tts' }, created_at: '' });
    vi.spyOn(api, 'getAsset').mockResolvedValue({ id: 'a_bad', type: 'audio', kind: 'audio', status: 'failed', error: '合成超时', name: '朗读', url: '', source: 'derived', derived_from: { stem: 'tts' }, created_at: '' });
    await useEditor.getState().generateVoice('文案', 'zh', 'v1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(useEditor.getState().posterVoicePending).toBeNull();
    expect(useEditor.getState().toast).toBe('朗读生成失败：合成超时');
    expect(spec().audio?.tracks ?? []).toEqual([]);
  });

  it('usePostDuration 优先取 trim.duration；usePostTime 按第几遍累加剪后时刻', () => {
    useEditor.getState().updateSpec((s) => {
      s.trim.remove = [[2, 4]]; // 剪后 8 秒
    });
    expect(selectPostDuration(useEditor.getState())).toBe(8);
    useEditor.getState().updateSpec((s) => {
      s.trim.duration = 20;
    });
    expect(selectPostDuration(useEditor.getState())).toBe(20);
    useEditor.setState({ time: 5, lap: 0 });
    expect(selectPostTime(useEditor.getState())).toBe(3);
    useEditor.setState({ time: 5, lap: 2 });
    expect(selectPostTime(useEditor.getState())).toBe(19);
    // 短于剪后时长：成片截到这里
    useEditor.getState().updateSpec((s) => {
      s.trim.duration = 3;
    });
    expect(selectPostDuration(useEditor.getState())).toBe(3);
  });
});

// --- 多选下的样式粘贴（HIG-77 在 HIG-63 的多选之上补的一点）----------------------

describe('多选时粘贴文字样式', () => {
  it('贴到全部选中的文字图层，只记一步历史', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [textLayer('一'), { ...textLayer('二'), id: 'L2' }, { ...textLayer('三'), id: 'L3' }] };
    useEditor.getState().replaceSpec('v1', spec);
    useEditor.getState().setSelectedLayer('L1');
    useEditor.getState().updateLayer('L1', (l) => {
      if (l.type === 'text') l.style.color = '#00ff00';
    });
    useEditor.getState().copyStyle();
    useEditor.getState().selectLayers(['L2', 'L3']);
    const undoDepthBefore = useEditor.getState().canUndo();
    useEditor.getState().pasteStyle();
    const colors = () => (useEditor.getState().currentSpec()!.layers as TextLayer[]).map((l) => l.style.color);
    expect(colors()).toEqual(['#00ff00', '#00ff00', '#00ff00']);
    expect(undoDepthBefore).toBe(true);
    useEditor.getState().undo(); // 一步就回到只有 L1 是绿的
    expect(colors().slice(1).every((c) => c !== '#00ff00')).toBe(true);
  });

  it('单选时只贴当前一条', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [textLayer('一'), { ...textLayer('二'), id: 'L2' }] };
    useEditor.getState().replaceSpec('v1', spec);
    useEditor.getState().setSelectedLayer('L1');
    useEditor.getState().updateLayer('L1', (l) => {
      if (l.type === 'text') l.style.color = '#123456';
    });
    useEditor.getState().copyStyle();
    useEditor.getState().setSelectedLayer('L2');
    useEditor.getState().pasteStyle();
    const colors = (useEditor.getState().currentSpec()!.layers as TextLayer[]).map((l) => l.style.color);
    expect(colors[1]).toBe('#123456');
  });
});

// --- 拆分图层（HIG-79）-------------------------------------------------------------

describe('splitLayer', () => {
  const at = (sourceTime: number) => useEditor.setState({ time: sourceTime, lap: 0 });

  it('在播放头处拆成两条，选中右半段，可一步撤销', () => {
    useEditor.getState().replaceSpec('v1', { ...emptySpec(), layers: [{ ...textLayer('字'), t: [0, 8] }] });
    at(4);
    useEditor.getState().splitLayer('L1');
    const layers = useEditor.getState().currentSpec()!.layers;
    expect(layers.map((l) => l.t)).toEqual([[0, 4], [4, 8]]);
    expect(useEditor.getState().selectedLayerId).toBe(layers[1].id);
    useEditor.getState().undo();
    expect(useEditor.getState().currentSpec()!.layers).toHaveLength(1);
  });

  it("t = 'all' 的图层先展开成成片时段再拆", () => {
    at(4);
    useEditor.getState().splitLayer('L1');
    expect(useEditor.getState().currentSpec()!.layers.map((l) => l.t)).toEqual([[0, 4], [4, 10]]);
  });

  it('播放头在时段外时不拆，给出可照做的提示', () => {
    useEditor.getState().replaceSpec('v1', { ...emptySpec(), layers: [{ ...textLayer('字'), t: [5, 9] }] });
    at(1);
    useEditor.getState().splitLayer('L1');
    expect(useEditor.getState().currentSpec()!.layers).toHaveLength(1);
    expect(useEditor.getState().toast).toContain('播放头');
  });

  it('大字报不拆，提示说明原因', () => {
    useEditor.getState().replaceSpec('v1', { ...emptySpec(), layers: [{ ...textLayer('文案'), scroll: { speed: 0.08, box: DEFAULT_SCROLL_BOX } }] });
    at(4);
    useEditor.getState().splitLayer('L1');
    expect(useEditor.getState().currentSpec()!.layers).toHaveLength(1);
    expect(useEditor.getState().toast).toContain('大字报');
  });
});

// --- 音轨变速（HIG-75）-------------------------------------------------------------

describe('setTrackSpeed', () => {
  const withTrack = (t: [number, number] | 'all') => {
    useEditor.setState({ assets: [{ id: 'a_v', name: 'v.wav', type: 'audio', status: 'ready', duration: 8 } as Asset] });
    useEditor.getState().replaceSpec('v1', { ...emptySpec(), audio: { source_volume: 1, tracks: [{ id: 'au_1', asset_id: 'a_v', t }] } });
  };

  it('提速时时段跟着缩短，播的素材内容不变', () => {
    withTrack([0, 8]);
    useEditor.getState().setTrackSpeed('au_1', 2);
    const track = useEditor.getState().currentSpec()!.audio!.tracks[0];
    expect(track.speed).toBe(2);
    expect(track.t).toEqual([0, 4]);
  });

  it('速度夹在契约范围内', () => {
    withTrack([0, 8]);
    useEditor.getState().setTrackSpeed('au_1', 9);
    expect(useEditor.getState().currentSpec()!.audio!.tracks[0].speed).toBe(2);
    useEditor.getState().setTrackSpeed('au_1', 0.01);
    expect(useEditor.getState().currentSpec()!.audio!.tracks[0].speed).toBe(0.5);
  });

  it("t = 'all' 的轨只改速度不动时段", () => {
    withTrack('all');
    useEditor.getState().setTrackSpeed('au_1', 1.5);
    const track = useEditor.getState().currentSpec()!.audio!.tracks[0];
    expect(track.speed).toBe(1.5);
    expect(track.t).toBe('all');
  });
});

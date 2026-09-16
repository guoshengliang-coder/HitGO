// 历史栈：文字这类「输入期间 history=false、提交时才记一条」的编辑，
// 提交时必须压入编辑前的快照（pushHistorySnapshot），否则 ⌘Z 回不到编辑前。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from './editor';
import { defaultTextStyle, emptySpec, type Asset, type BatchDetail, type EditSpec, type Job, type LocalizationVersion, type SafeZone, type TextLayer, type Video } from '../types';
import { api } from '../api';
import { cloneSpec } from '../lib/spec';

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
  useEditor.setState({ videos: [VIDEO], currentVideoId: 'v1', specs: {}, history: {} });
  useEditor.getState().replaceSpec('v1', spec);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pushHistorySnapshot', () => {
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

  it('没有伴奏时只加配音轨，toast 里带提示', () => {
    useEditor.setState({ videos: [{ ...LOC_VIDEO, separation: null }] });
    expect(useEditor.getState().applyVersion('ko')).toBe(true);
    expect(localizeTracks().map((t) => t.role)).toEqual(['voice']);
    expect(useEditor.getState().toast).toContain('伴奏');
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

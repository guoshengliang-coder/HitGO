// 历史栈：文字这类「输入期间 history=false、提交时才记一条」的编辑，
// 提交时必须压入编辑前的快照（pushHistorySnapshot），否则 ⌘Z 回不到编辑前。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from './editor';
import { defaultTextStyle, emptySpec, type EditSpec, type TextLayer, type Video } from '../types';
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

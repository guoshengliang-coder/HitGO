import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from '../../store/editor';
import { emptySpec, type Video } from '../../types';
import { TrimPanel } from './TrimPanel';

// SSR checks the real panel markup; selector reads current fixture rather than Zustand's initial SSR snapshot.
vi.mock('../../store/editor', async (load) => {
  const original = await load<typeof import('../../store/editor')>();
  return { ...original, useEditor: Object.assign(
    (selector: Parameters<typeof original.useEditor>[0]) => selector(original.useEditor.getState()),
    original.useEditor,
  ) };
});
vi.mock('./SequenceSection', () => ({ SequenceSection: () => createElement('section', null, '视频片段入口') }));
vi.mock('./CoverSection', () => ({ CoverSection: () => createElement('section', null, '封面入口') }));

beforeEach(() => {
  useEditor.setState({ currentVideoId: 'v1', videos: [{ id: 'v1', width: 1080, height: 1920, duration: 10 } as Video], specs: { v1: emptySpec() }, inPoint: null });
});

describe('HIG-39 trim inspector tabs', () => {
  it('defaults to 剪辑 and gives both tabs distinct associated panels', () => {
    const html = renderToStaticMarkup(createElement(TrimPanel));
    expect(html).toContain('aria-label="剪辑操作区"');
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>剪辑<\/button>/);
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*tabindex="-1"[^>]*>视频拼接<\/button>/);
    expect(html).toMatch(/id="[^"]+-sequence-panel" role="tabpanel" aria-labelledby="[^"]+-sequence-tab" hidden=""/);
    expect(html).toMatch(/id="[^"]+-edit-panel" role="tabpanel" aria-labelledby="[^"]+-edit-tab" class=/);
  });

  it('keeps removal/frame/duration in edit and mounts cover/sequence only in the other panel', () => {
    const html = renderToStaticMarkup(createElement(TrimPanel));
    const split = html.indexOf('role="tabpanel"', html.indexOf('role="tabpanel"') + 1);
    const edit = html.slice(0, split), sequence = html.slice(split);
    for (const label of ['已删除区间', '成片画面', '原始时长']) expect(edit).toContain(label);
    for (const label of ['封面入口', '视频片段入口']) {
      expect(edit).not.toContain(label);
      expect(sequence).toContain(label);
    }
    expect(sequence).not.toContain('已删除区间');
  });
});

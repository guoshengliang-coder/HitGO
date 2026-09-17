import { describe, expect, it } from 'vitest';
import { cleanExportVariants, defaultExportScope, dialogExportKeys, loadExportVariants, resolveExportTargets, toggleExportVariant } from './exportScope';
import { emptySpec, type Video } from '../types';

const VIDEOS: Pick<Video, 'id' | 'status'>[] = [
  { id: 'v1', status: 'ready' },
  { id: 'v2', status: 'preparing' },
  { id: 'v3', status: 'ready' },
  { id: 'v4', status: 'failed' },
];

describe('resolveExportTargets', () => {
  it('这一批：全部就绪的视频，按批次顺序；未就绪的计入跳过', () => {
    expect(resolveExportTargets(VIDEOS, 'batch', [], 'v1')).toEqual({ ids: ['v1', 'v3'], skipped: ['v2', 'v4'] });
  });
  it('勾选：按批次顺序而不是勾选顺序，忽略不在批次里的 id', () => {
    expect(resolveExportTargets(VIDEOS, 'selected', ['v3', 'gone', 'v2', 'v1'], 'v1')).toEqual({ ids: ['v1', 'v3'], skipped: ['v2'] });
    expect(resolveExportTargets(VIDEOS, 'selected', [], 'v1')).toEqual({ ids: [], skipped: [] });
  });
  it('仅当前：当前未就绪时跳过，没有当前视频时为空', () => {
    expect(resolveExportTargets(VIDEOS, 'current', [], 'v3')).toEqual({ ids: ['v3'], skipped: [] });
    expect(resolveExportTargets(VIDEOS, 'current', [], 'v2')).toEqual({ ids: [], skipped: ['v2'] });
    expect(resolveExportTargets(VIDEOS, 'current', [], null)).toEqual({ ids: [], skipped: [] });
  });
});

describe('导出画幅勾选（HIG-29）', () => {
  it('拼接成片默认只导出当前视频；当前视频的勾选不会被本机旧记录扩成多个画幅', () => {
    const plain = emptySpec();
    const joined = { ...emptySpec(), sequence: { clips: [{ id: 'a', video_id: 'v1', in: 0, out: 4 }] } };
    expect(defaultExportScope(plain)).toBe('batch');
    expect(defaultExportScope(joined)).toBe('current');
    expect(dialogExportKeys(joined, ['9x16', '1x1', '4x5', '16x9'])).toEqual(['9x16']);
  });
  it('清洗：按画幅顺序、去掉不认识的、空时回到 9x16', () => {
    expect(cleanExportVariants(['16x9', 'x', '9x16', '1x1'])).toEqual(['9x16', '1x1', '16x9']);
    expect(cleanExportVariants([])).toEqual(['9x16']);
    expect(cleanExportVariants('bad')).toEqual(['9x16']);
  });
  it('切换：不能取消最后一个', () => {
    expect(toggleExportVariant(['9x16'], '4x5')).toEqual(['9x16', '4x5']);
    expect(toggleExportVariant(['9x16', '4x5'], '9x16')).toEqual(['4x5']);
    expect(toggleExportVariant(['4x5'], '4x5')).toEqual(['4x5']);
  });
  it('读本机旧记录（老 spec 兜底）；坏 JSON 回退 9x16', () => {
    const m = new Map<string, string>([['hitgo.exportVariants', JSON.stringify(['1x1', '9x16'])]]);
    const s = { getItem: (k: string) => m.get(k) ?? null };
    expect(loadExportVariants(s)).toEqual(['9x16', '1x1']);
    m.set('hitgo.exportVariants', '{bad');
    expect(loadExportVariants(s)).toEqual(['9x16']);
    expect(loadExportVariants(null)).toEqual(['9x16']);
  });
});

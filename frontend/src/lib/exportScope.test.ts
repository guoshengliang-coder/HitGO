import { describe, expect, it } from 'vitest';
import { resolveExportTargets } from './exportScope';
import type { Video } from '../types';

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

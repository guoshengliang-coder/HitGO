import { describe, expect, it } from 'vitest';
import { downloadableIds, headState, isDownloadable, pruneSelection, selectionSummary, toggleAll, toggleOne } from './outputSelection';
import type { Job } from '../types';

const job = (id: string, over: Partial<Job> = {}): Job =>
  ({ id, batch_id: 'b', video_id: 'v', variant_key: '9x16', status: 'done', progress: 1, error: null, output_url: `/media/outputs/${id}.mp4`, output: { width: 1080, height: 1920, duration: 10, size: 100, codec: 'h264' }, callback: null, created_at: '', ...over }) as Job;

const jobs = [job('a'), job('b', { output: null }), job('c', { status: 'running', output_url: null }), job('d', { output_url: null })];

describe('outputSelection', () => {
  it('只有已完成且有成片地址的行可以下载', () => {
    expect(isDownloadable(jobs[0])).toBe(true);
    expect(isDownloadable(jobs[2])).toBe(false);
    expect(isDownloadable(jobs[3])).toBe(false);
    expect(downloadableIds(jobs)).toEqual(['a', 'b']);
  });
  it('单行勾选来回切换', () => {
    expect(toggleOne([], 'a')).toEqual(['a']);
    expect(toggleOne(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('表头：无 / 部分 / 全部，点击时全选或清空', () => {
    expect(headState([], jobs)).toBe('none');
    expect(headState(['a'], jobs)).toBe('some');
    expect(headState(['b', 'a'], jobs)).toBe('all');
    expect(toggleAll(['a'], jobs)).toEqual(['a', 'b']);
    expect(toggleAll(['a', 'b'], jobs)).toEqual([]);
    expect(headState([], [])).toBe('none');
  });
  it('列表变了去掉看不见 / 不可下载的勾；没变时返回同一个数组', () => {
    const sel = ['a', 'b'];
    expect(pruneSelection(sel, jobs)).toBe(sel);
    expect(pruneSelection(['a', 'c', 'gone'], jobs)).toEqual(['a']);
  });
  it('汇总按列表顺序给 id，大小只加已知的', () => {
    expect(selectionSummary(['b', 'a', 'c'], jobs)).toEqual({ ids: ['a', 'b'], bytes: 100 });
  });
});

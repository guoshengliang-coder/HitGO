import { describe, expect, it } from 'vitest';
import { latestJobIds, outputFileName, sortByFinishedDesc } from './outputs';
import type { Job } from '../types';

function job(
  id: string,
  video_id: string,
  variant_key: string,
  finished_at: string | null,
  created_at = '2026-09-16T00:00:00Z',
): Job {
  return {
    id,
    batch_id: 'b_1',
    video_id,
    variant_key,
    status: 'done',
    progress: 100,
    error: null,
    output_url: `/media/outputs/${id}.mp4`,
    output: { width: 1080, height: 1920, duration: 20, size: 1, codec: 'h264/aac' },
    callback: null,
    created_at,
    started_at: null,
    finished_at,
  };
}

describe('latestJobIds', () => {
  it('marks the newest job per (video, variant)', () => {
    const jobs = [
      job('j_old', 'v_1', '9x16', '2026-09-16T10:00:00Z'),
      job('j_new', 'v_1', '9x16', '2026-09-16T12:00:00Z'),
    ];
    expect([...latestJobIds(jobs)]).toEqual(['j_new']);
  });

  it('keeps one per group rather than one overall', () => {
    const jobs = [
      job('j_a1', 'v_1', '9x16', '2026-09-16T10:00:00Z'),
      job('j_a2', 'v_1', '9x16', '2026-09-16T11:00:00Z'),
      job('j_b1', 'v_2', '9x16', '2026-09-16T09:00:00Z'),
      job('j_c1', 'v_1', '1x1', '2026-09-16T08:00:00Z'),
    ];
    expect(latestJobIds(jobs)).toEqual(new Set(['j_a2', 'j_b1', 'j_c1']));
  });

  it('falls back to created_at when finished_at is missing', () => {
    const jobs = [
      job('j_a', 'v_1', '9x16', null, '2026-09-16T10:00:00Z'),
      job('j_b', 'v_1', '9x16', null, '2026-09-16T11:00:00Z'),
    ];
    expect([...latestJobIds(jobs)]).toEqual(['j_b']);
  });

  it('prefers a job that finished over one that has no finish time', () => {
    const jobs = [
      job('j_unfinished', 'v_1', '9x16', null, '2026-09-16T23:00:00Z'),
      job('j_finished', 'v_1', '9x16', '2026-09-16T10:00:00Z', '2026-09-16T09:00:00Z'),
    ];
    expect([...latestJobIds(jobs)]).toEqual(['j_finished']);
  });

  it('is stable when timestamps tie', () => {
    const jobs = [
      job('j_a', 'v_1', '9x16', '2026-09-16T10:00:00Z'),
      job('j_b', 'v_1', '9x16', '2026-09-16T10:00:00Z'),
    ];
    expect([...latestJobIds(jobs)]).toEqual(['j_b']);
    expect([...latestJobIds([...jobs].reverse())]).toEqual(['j_b']);
  });

  it('handles an empty list', () => {
    expect(latestJobIds([])).toEqual(new Set());
  });
});

describe('sortByFinishedDesc', () => {
  it('puts the newest finished job first', () => {
    const jobs = [
      job('j_a', 'v_1', '1x1', '2026-09-15T12:00:00Z'),
      job('j_b', 'v_2', '9x16', '2026-09-16T13:00:00Z'),
      job('j_c', 'v_1', '9x16', '2026-09-15T22:00:00Z'),
    ];
    expect(sortByFinishedDesc(jobs).map((j) => j.id)).toEqual(['j_b', 'j_c', 'j_a']);
  });

  it('falls back to created_at when finished_at is missing', () => {
    const jobs = [
      job('j_done', 'v_1', '9x16', '2026-09-16T10:00:00Z'),
      job('j_nofin', 'v_2', '9x16', null, '2026-09-16T11:00:00Z'),
    ];
    expect(sortByFinishedDesc(jobs).map((j) => j.id)).toEqual(['j_nofin', 'j_done']);
  });

  it('breaks ties by id so the order is stable, and does not mutate input', () => {
    const jobs = [job('j_1', 'v_1', '9x16', '2026-09-16T10:00:00Z'), job('j_2', 'v_2', '9x16', '2026-09-16T10:00:00Z')];
    expect(sortByFinishedDesc(jobs).map((j) => j.id)).toEqual(['j_2', 'j_1']);
    expect(jobs.map((j) => j.id)).toEqual(['j_1', 'j_2']);
  });
});

describe('outputFileName', () => {
  it('uses the export name, the video name without extension and the variant', () => {
    const j = { ...job('j_1', 'v_1', '9x16', null), name: '九月投放 A', batch_name: '批次', video_name: 'V01 开场.mp4' };
    expect(outputFileName(j)).toBe('九月投放 A_V01 开场_9x16.mp4');
  });

  it('falls back to the batch name, and takes names passed in for per-batch jobs', () => {
    expect(outputFileName({ ...job('j_1', 'v_1', '9x16', null), batch_name: '九月批次', video_name: 'a.MOV' })).toBe('九月批次_a_9x16.mp4');
    expect(outputFileName(job('j_1', 'v_1', '9x16', null), { batchName: '批次 B', videoName: 'b.mp4' })).toBe('批次 B_b_9x16.mp4');
  });

  it('replaces characters a file system would refuse', () => {
    const j = { ...job('j_1', 'v_1', '9x16', null), name: 'a/b:c*?"<>|d', video_name: 'x.mp4' };
    expect(outputFileName(j)).toBe('a_b_c_d_x_9x16.mp4');
  });

  it('falls back to the job id when there is nothing to name it by', () => {
    expect(outputFileName(job('j_9', 'v_1', '', null))).toBe('j_9.mp4');
  });
});

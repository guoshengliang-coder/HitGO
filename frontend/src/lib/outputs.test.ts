import { describe, expect, it } from 'vitest';
import { latestJobIds, sortByFinishedDesc } from './outputs';
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

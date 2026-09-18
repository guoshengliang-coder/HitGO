import { describe, expect, it } from 'vitest';
import { audioMixSummary, jobWarning, latestJobIds, outputFileName, sortByFinishedDesc, versionTags } from './outputs';
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
  it('uses the actual output extension and removes an image source extension', () => {
    const j = { ...job('j_png', 'v_1', '9x16', null), output_format: 'png' as const, name: '图片', video_name: '封面.jpeg' };
    expect(outputFileName(j)).toBe('图片_封面_9x16.png');
  });
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

describe('HIG-43：多语言成片', () => {
  it('文件名在视频名和画幅之间插入语言中文名；原版不加', () => {
    const j = { ...job('j_1', 'v_1', '9x16', null), name: '投放', video_name: 'V01.mp4' };
    expect(outputFileName({ ...j, lang: 'ko' })).toBe('投放_V01_韩语_9x16.mp4');
    expect(outputFileName({ ...j, lang: null })).toBe('投放_V01_9x16.mp4');
  });
  it('同视频同画幅的不同语言各算各的，不互相标成旧版本', () => {
    const ko = { ...job('j_ko', 'v_1', '9x16', '2026-09-17T01:00:00Z'), lang: 'ko' };
    const en = { ...job('j_en', 'v_1', '9x16', '2026-09-17T02:00:00Z'), lang: 'en' };
    const ko2 = { ...job('j_ko2', 'v_1', '9x16', '2026-09-17T03:00:00Z'), lang: 'ko' };
    const tags = versionTags([ko, en, ko2]);
    expect(tags.get('j_en')).toBeNull();
    expect(tags.get('j_ko')).toBe('older');
    expect(tags.get('j_ko2')).toBe('latest');
    expect(latestJobIds([ko, en, ko2])).toEqual(new Set(['j_en', 'j_ko2']));
  });
});

describe('HIG-26：产物页看清成片混了什么', () => {
  it('versionTags：同组多条时标最新 / 旧版本，单条不打标', () => {
    const jobs = [
      job('j1', 'v1', '9x16', '2026-09-16T08:38:58Z'),
      job('j2', 'v1', '9x16', '2026-09-16T08:45:51Z'),
      job('j3', 'v1', '9x16', '2026-09-16T08:47:43Z'),
      job('j4', 'v2', '9x16', '2026-09-16T08:47:43Z'),
    ];
    const tags = versionTags(jobs);
    expect([tags.get('j1'), tags.get('j2'), tags.get('j3'), tags.get('j4')]).toEqual(['older', 'older', 'latest', null]);
  });

  it('jobWarning：只取完成任务的警告，去掉前缀', () => {
    expect(jobWarning({ status: 'done', error: '警告：音轨 au_1：音频素材 a_x 不存在或未就绪，已跳过' })).toBe('音轨 au_1：音频素材 a_x 不存在或未就绪，已跳过');
    expect(jobWarning({ status: 'failed', error: 'ffmpeg 退出码 1' })).toBeNull();
    expect(jobWarning({ status: 'done', error: null })).toBeNull();
  });

  it('audioMixSummary：音轨名 + 原声状态 + 静音段 + 跳过数；没有记录时为 null', () => {
    expect(audioMixSummary(undefined)).toBeNull();
    expect(
      audioMixSummary({
        source_volume: 0,
        source_mute: 0,
        tracks: [
          { id: 'a', asset_id: 'a_1', name: '口播.mp3', role: 'bgm' },
          { id: 'b', asset_id: 'a_2', name: 'TikTok Original.m4a', role: 'bgm' },
        ],
        skipped: [],
      }),
    ).toBe('音轨：口播.mp3、TikTok Original.m4a · 原声静音');
    expect(audioMixSummary({ source_volume: 0.6, source_mute: 2, tracks: [], skipped: ['x'] })).toBe('没有叠加音轨 · 原声 60% · 原声静音 2 段 · 跳过 1 条（素材失效）');
    expect(audioMixSummary({ source_volume: 1, source_mute: 0, tracks: [{ id: 'a', asset_id: 'a_1', name: '', role: 'voice' }], skipped: [] })).toBe('音轨：a_1 · 原声保留');
  });
});

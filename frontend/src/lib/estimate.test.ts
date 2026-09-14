import { describe, expect, it } from 'vitest';
import { calibrationFromJobs, estimateOutputBytes, formatBytes, qualityOf } from './estimate';
import type { Job } from '../types';

function job(partial: Partial<Job> & { size: number; duration: number }): Job {
  return {
    id: 'j',
    batch_id: 'b',
    video_id: 'v',
    variant_key: '9x16',
    status: 'done',
    progress: 100,
    error: null,
    output_url: null,
    output: { width: 1080, height: 1920, duration: partial.duration, size: partial.size, codec: 'h264/aac' },
    callback: null,
    created_at: '',
    started_at: null,
    finished_at: null,
    ...partial,
  };
}

describe('estimateOutputBytes', () => {
  it('标准档 9:16：4000 + 128 kbps', () => {
    // (4128 kbps × 1000 × 10 s) / 8 = 5 160 000 B
    expect(estimateOutputBytes({ variant_key: '9x16' }, 10)).toBe(5_160_000);
    expect(estimateOutputBytes({ variant_key: '9x16', quality: 'standard' }, 10)).toBe(5_160_000);
  });
  it('高清档 16:9：7500 + 128 kbps', () => {
    expect(estimateOutputBytes({ variant_key: '16x9', quality: 'high' }, 10)).toBe(9_535_000);
  });
  it('1:1 与 4:5 按画幅系数折减视频码率，音频不变', () => {
    expect(estimateOutputBytes({ variant_key: '1x1' }, 10)).toBe(Math.round(((4000 * 0.6 + 128) * 1000 * 10) / 8));
    expect(estimateOutputBytes({ variant_key: '4x5', quality: 'high' }, 10)).toBe(Math.round(((7500 * 0.75 + 128) * 1000 * 10) / 8));
  });
  it('时长为 0 / 负数时返回 0', () => {
    expect(estimateOutputBytes({ variant_key: '9x16' }, 0)).toBe(0);
    expect(estimateOutputBytes({ variant_key: '9x16' }, -3)).toBe(0);
  });
  it('有校准值时用校准码率（含音频）替换表值', () => {
    // 校准 5128 kbps → 视频 5000，1:1 折 0.6 → 3000 + 128
    expect(estimateOutputBytes({ variant_key: '1x1' }, 10, { standard: 5128 })).toBe(Math.round(((3000 + 128) * 1000 * 10) / 8));
    // 高清没有校准值时回退表值
    expect(estimateOutputBytes({ variant_key: '9x16', quality: 'high' }, 10, { standard: 5128 })).toBe(9_535_000);
  });
});

describe('calibrationFromJobs', () => {
  it('按档位平均实际码率，忽略未完成 / 无输出的任务', () => {
    const jobs = [
      job({ id: 'a', size: 5_160_000, duration: 10 }), // 4128 kbps
      job({ id: 'b', size: 6_160_000, duration: 10 }), // 4928 kbps
      job({ id: 'c', size: 1, duration: 10, status: 'running' }),
      job({ id: 'd', size: 1, duration: 10, output: null }),
    ];
    expect(calibrationFromJobs(jobs)).toEqual({ standard: 4528 });
  });
  it('从 callback.edit_spec 读取变体质量，1:1 归一到全画幅基准', () => {
    const jobs = [
      job({
        id: 'a',
        variant_key: '1x1',
        size: Math.round(((7500 * 0.6 + 128) * 1000 * 10) / 8),
        duration: 10,
        callback: { edit_spec: { outputs: [{ variant_key: '1x1', aspect: '1:1', fill: 'blur', quality: 'high' }] } },
      }),
    ];
    expect(calibrationFromJobs(jobs)).toEqual({ high: 7628 });
  });
  it('没有样本时返回空对象', () => {
    expect(calibrationFromJobs([])).toEqual({});
  });
});

describe('qualityOf / formatBytes', () => {
  it('缺省视为 standard', () => {
    expect(qualityOf({})).toBe('standard');
    expect(qualityOf({ quality: 'high' })).toBe('high');
  });
  it('格式化 MB / KB', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(5_160_000)).toBe('4.9 MB');
    expect(formatBytes(52_000_000)).toBe('50 MB');
    expect(formatBytes(520_000_000)).toBe('496 MB');
  });
});

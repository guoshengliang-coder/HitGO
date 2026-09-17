import { describe, expect, it } from 'vitest';
import { coverSummary, durationSummary, frameSummary, rangesSummary } from './trimSummary';
import type { Range } from './time';

describe('rangesSummary（已删除区间摘要）', () => {
  it('没删过返回空串', () => {
    expect(rangesSummary([])).toBe('');
  });
  it('段数与删除合计', () => {
    const remove: Range[] = [[3.2, 5.8], [17, 18.4]];
    expect(rangesSummary(remove)).toBe('2 段 · −4.00s');
    expect(rangesSummary([[0, 1.5]])).toBe('1 段 · −1.50s');
  });
});

describe('coverSummary（封面摘要）', () => {
  it('没有封面是「无」', () => {
    expect(coverSummary(null, 0)).toBe('无');
    expect(coverSummary(undefined, 0)).toBe('无');
  });
  it('有封面显示它占的时长', () => {
    expect(coverSummary({ asset_id: 'a_1' }, 1)).toBe('1.0s');
    expect(coverSummary({ asset_id: 'a_1', duration: 2.5 }, 2.5)).toBe('2.5s');
  });
});

describe('frameSummary（成片画面摘要）', () => {
  const base = { variant_key: '9x16' } as const;
  it('填充 · 清晰度 · 估算大小', () => {
    expect(frameSummary({ ...base, fill: 'crop', quality: 'high' }, 47.5)).toBe('裁切 · 高清 · 约 43 MB');
    expect(frameSummary({ ...base, fill: 'blur', quality: 'standard' }, 10)).toBe('模糊背景 · 标准 · 约 4.9 MB');
  });
  it('模糊背景调过强度 / 亮度时带上数值', () => {
    expect(frameSummary({ ...base, fill: 'blur', blur: 60, bg_brightness: 50 }, 10)).toBe('模糊背景 · 标准 · 约 4.9 MB');
    expect(frameSummary({ ...base, fill: 'blur', blur: 80, bg_brightness: 35 }, 10)).toBe('模糊背景 80/35% · 标准 · 约 4.9 MB');
  });
  it('quality 缺省按标准', () => {
    expect(frameSummary({ ...base, fill: 'color' }, 10)).toContain('纯色 · 标准');
  });
  it('源已是 9:16 时不显示填充方式', () => {
    expect(frameSummary({ ...base, fill: 'blur', quality: 'high' }, 10, undefined, true)).toBe('高清 · 约 9.1 MB');
  });
  it('有校准码率时按校准值估算', () => {
    const plain = frameSummary({ ...base, fill: 'crop', quality: 'high' }, 60);
    const calibrated = frameSummary({ ...base, fill: 'crop', quality: 'high' }, 60, { high: 3000 });
    expect(calibrated).not.toBe(plain);
  });
});

describe('durationSummary（时长摘要）', () => {
  it('没有封面给剪后时长', () => {
    expect(durationSummary(44.1, 0)).toBe('剪后 44.10s');
  });
  it('有封面给成片时长（剪后 + 封面）', () => {
    expect(durationSummary(44.1, 1)).toBe('成片 45.10s');
  });
});

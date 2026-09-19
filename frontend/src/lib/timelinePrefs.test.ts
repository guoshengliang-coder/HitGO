import { describe, expect, it } from 'vitest';
import { clampTrackLabelWidth, TRACK_LABEL_DEFAULT } from './timelinePrefs';

describe('轨道名称栏宽度', () => {
  it('限制宽度，为时间轴保留至少 55% 空间', () => {
    expect(clampTrackLabelWidth(900)).toBe(360);
    expect(clampTrackLabelWidth(360, 500)).toBe(225);
    expect(clampTrackLabelWidth(20)).toBe(112);
    expect(clampTrackLabelWidth(NaN)).toBe(TRACK_LABEL_DEFAULT);
  });
});

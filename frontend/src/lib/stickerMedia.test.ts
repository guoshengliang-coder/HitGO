import { describe, expect, it } from 'vitest';
import { stickerAudible, stickerFinished, stickerMediaTime, windowRange } from './stickerMedia';

describe('windowRange', () => {
  it("'all' 覆盖整条剪后时间轴", () => {
    expect(windowRange('all', 20.6)).toEqual([0, 20.6]);
  });
  it('区间被剪后时长钳住', () => {
    expect(windowRange([4, 99], 20.6)).toEqual([4, 20.6]);
  });
});

describe('stickerMediaTime', () => {
  const D = 20.6; // 剪后时长
  const M = 3; // 素材时长

  it('时段外不显示', () => {
    expect(stickerMediaTime(3.9, [4, 9], D, M)).toBeNull();
    expect(stickerMediaTime(9.2, [4, 9], D, M)).toBeNull();
  });

  it('时段起点从素材第 0 帧开始播', () => {
    expect(stickerMediaTime(4, [4, 9], D, M)).toBeCloseTo(0);
    expect(stickerMediaTime(5.5, [4, 9], D, M)).toBeCloseTo(1.5);
  });

  it('loop 播完取模循环', () => {
    expect(stickerMediaTime(7.5, [4, 9], D, M, 'loop')).toBeCloseTo(0.5);
    expect(stickerMediaTime(8.9, [4, 9], D, M, 'loop')).toBeCloseTo(1.9);
  });

  it('freeze 播完定格最后一帧', () => {
    const t = stickerMediaTime(8.9, [4, 9], D, M, 'freeze');
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(M - 0.01);
    expect(t!).toBeLessThan(M);
  });

  it('once 播完就消失', () => {
    expect(stickerMediaTime(6.9, [4, 9], D, M, 'once')).toBeCloseTo(2.9);
    expect(stickerMediaTime(7.5, [4, 9], D, M, 'once')).toBeNull();
  });

  it("'all' 时段按剪后时长计算", () => {
    expect(stickerMediaTime(0, 'all', D, M)).toBeCloseTo(0);
    expect(stickerMediaTime(4, 'all', D, M, 'loop')).toBeCloseTo(1);
    expect(stickerMediaTime(D + 0.5, 'all', D, M)).toBeNull();
  });

  it('素材时长未知时停在首帧', () => {
    expect(stickerMediaTime(5, [4, 9], D, 0)).toBe(0);
    expect(stickerMediaTime(5, [4, 9], D, NaN)).toBe(0);
  });

  it('素材比时段长时照常按经过时间走', () => {
    expect(stickerMediaTime(8, [4, 9], D, 30, 'loop')).toBeCloseTo(4);
  });
});

describe('stickerAudible', () => {
  const base = { t: [4, 9] as [number, number], postDuration: 20.6, mediaDuration: 3, playing: true, mixAudio: true, hasAudio: true };

  it('时段内、播放中、开了合成、素材有音轨才出声', () => {
    expect(stickerAudible({ ...base, postTime: 5 })).toBe(true);
    expect(stickerAudible({ ...base, postTime: 5, playing: false })).toBe(false);
    expect(stickerAudible({ ...base, postTime: 5, mixAudio: false })).toBe(false);
    expect(stickerAudible({ ...base, postTime: 5, mixAudio: undefined })).toBe(false);
    expect(stickerAudible({ ...base, postTime: 5, hasAudio: false })).toBe(false);
    expect(stickerAudible({ ...base, postTime: 5, hasAudio: null })).toBe(false);
  });

  it('时段外静音', () => {
    expect(stickerAudible({ ...base, postTime: 3.9 })).toBe(false);
    expect(stickerAudible({ ...base, postTime: 9.1 })).toBe(false);
  });

  it('loop 随画面循环；freeze / once 只放一遍', () => {
    expect(stickerAudible({ ...base, postTime: 8, playback: 'loop' })).toBe(true);
    expect(stickerAudible({ ...base, postTime: 6.9, playback: 'freeze' })).toBe(true);
    expect(stickerAudible({ ...base, postTime: 8, playback: 'freeze' })).toBe(false);
    expect(stickerAudible({ ...base, postTime: 8, playback: 'once' })).toBe(false);
  });

  it('素材时长未知（还在预处理）时静音', () => {
    expect(stickerAudible({ ...base, postTime: 5, mediaDuration: 0 })).toBe(false);
  });
});

describe('stickerFinished', () => {
  it('只有非 loop 且播到头才算结束', () => {
    expect(stickerFinished(7.5, [4, 9], 20.6, 3, 'freeze')).toBe(true);
    expect(stickerFinished(6.5, [4, 9], 20.6, 3, 'freeze')).toBe(false);
    expect(stickerFinished(7.5, [4, 9], 20.6, 3, 'loop')).toBe(false);
    expect(stickerFinished(7.5, [4, 9], 20.6, 0, 'freeze')).toBe(false);
  });
});

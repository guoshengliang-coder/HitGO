import { describe, expect, it } from 'vitest';
import { audibleSpan, contractAudio, isDefaultAudio, resolveTrack, trackDefaultsFor, trackGain, trackMediaTime } from './audioTracks';
import type { AudioTrack } from '../types';

const D = 20.6; // 剪后时长

describe('resolveTrack / defaults', () => {
  it('补齐契约缺省值', () => {
    expect(resolveTrack({ id: 'a', asset_id: 'x', t: 'all' })).toEqual({ id: 'a', asset_id: 'x', t: 'all', role: 'bgm', offset: 0, volume: 1, loop: false, fade_in: 0, fade_out: 0 });
    expect(resolveTrack({ id: 'a', asset_id: 'x', t: 'all', volume: 0.5, loop: true })).toMatchObject({ volume: 0.5, loop: true, offset: 0 });
  });
  it('BGM 循环压低淡出，口播原音量播一遍', () => {
    expect(trackDefaultsFor('bgm')).toEqual({ loop: true, volume: 0.6, fade_out: 1 });
    expect(trackDefaultsFor('voice')).toEqual({ loop: false, volume: 1 });
  });
});

describe('isDefaultAudio / contractAudio', () => {
  it('没有块或全是缺省值时省略', () => {
    expect(isDefaultAudio(undefined)).toBe(true);
    expect(isDefaultAudio({ source_volume: 1, tracks: [] })).toBe(true);
    expect(isDefaultAudio({ source_volume: 0.5, tracks: [] })).toBe(false);
    expect(contractAudio({ source_volume: 1, tracks: [] })).toBeUndefined();
  });
  it('区间取三位小数，其它字段原样透传', () => {
    const out = contractAudio({ source_volume: 0.33333, tracks: [{ id: 'a', asset_id: 'x', t: [1.23456, 4], volume: 0.7 }] });
    expect(out).toEqual({ source_volume: 0.333, tracks: [{ id: 'a', asset_id: 'x', t: [1.235, 4], volume: 0.7 }] });
  });
});

describe('trackMediaTime', () => {
  const voice: AudioTrack = { id: 'v', asset_id: 'x', t: [2, 12], offset: 1 }; // 4 s 素材，从第 1 秒起
  it('时段外与时长未知时不出声', () => {
    expect(trackMediaTime(1.9, voice, D, 4)).toBeNull();
    expect(trackMediaTime(12.1, voice, D, 4)).toBeNull();
    expect(trackMediaTime(3, voice, D, 0)).toBeNull();
  });
  it('从 offset 起播，播完素材即静音', () => {
    expect(trackMediaTime(2, voice, D, 4)).toBeCloseTo(1);
    expect(trackMediaTime(4.5, voice, D, 4)).toBeCloseTo(3.5);
    expect(trackMediaTime(5, voice, D, 4)).toBeNull(); // 3 s 可用时长已播完
    expect(trackMediaTime(2, { ...voice, offset: 4 }, D, 4)).toBeNull(); // 偏移不小于素材时长
  });
  it('循环时对素材时长取模，并被剪后时长钳住', () => {
    const bgm: AudioTrack = { id: 'b', asset_id: 'x', t: 'all', loop: true };
    expect(trackMediaTime(7.5, bgm, D, 3)).toBeCloseTo(1.5);
    expect(trackMediaTime(20.5, bgm, D, 3)).toBeCloseTo(20.5 % 3);
    expect(trackMediaTime(20.7, bgm, D, 3)).toBeNull();
  });
});

describe('audibleSpan / trackGain', () => {
  it('循环时出声长度等于时段长，否则受素材剩余时长限制', () => {
    expect(audibleSpan({ id: 'a', asset_id: 'x', t: 'all', loop: true }, D, 3)).toBeCloseTo(D);
    expect(audibleSpan({ id: 'a', asset_id: 'x', t: [2, 12], offset: 1 }, D, 4)).toBeCloseTo(3);
    expect(audibleSpan({ id: 'a', asset_id: 'x', t: [2, 12] }, D, 30)).toBeCloseTo(10);
  });
  it('淡入淡出是线性包络，淡出落在实际出声结束处', () => {
    const t: AudioTrack = { id: 'a', asset_id: 'x', t: [2, 12], offset: 1, volume: 0.8, fade_in: 0.2, fade_out: 0.5 }; // 出声 3 s
    expect(trackGain(1.9, t, D, 4)).toBe(0);
    expect(trackGain(2, t, D, 4)).toBeCloseTo(0);
    expect(trackGain(2.1, t, D, 4)).toBeCloseTo(0.4);
    expect(trackGain(3, t, D, 4)).toBeCloseTo(0.8);
    expect(trackGain(4.75, t, D, 4)).toBeCloseTo(0.4); // 淡出从 2.5 s 起，不是时段末尾
    expect(trackGain(5, t, D, 4)).toBeCloseTo(0);
  });
  it('循环 BGM 的淡出贴着时段末尾', () => {
    const bgm: AudioTrack = { id: 'b', asset_id: 'x', t: 'all', loop: true, volume: 0.6, fade_out: 1 };
    expect(trackGain(10, bgm, D, 3)).toBeCloseTo(0.6);
    expect(trackGain(D - 0.5, bgm, D, 3)).toBeCloseTo(0.3);
  });
  it('淡入淡出比时段长时钳到时段长', () => {
    const t: AudioTrack = { id: 'a', asset_id: 'x', t: [0, 2], fade_in: 5, loop: true };
    expect(trackGain(1, t, D, 3)).toBeCloseTo(0.5);
  });
});

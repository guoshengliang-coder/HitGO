import { describe, expect, it } from 'vitest';
import { audioTrackName, cleanTrackName, sourceAudioLabel, sourceAudioName, TRACK_NAME_MAX } from './trackNames';
import type { Asset, AudioTrack } from '../types';

const assets = [{ id: 'a_bgm', name: '夏日.mp3' }] as Asset[];
const track: AudioTrack = { id: 'au_1', asset_id: 'a_bgm', t: 'all' };

describe('cleanTrackName', () => {
  it('去掉首尾空白，空白视为清空', () => {
    expect(cleanTrackName('  开场 BGM ')).toBe('开场 BGM');
    expect(cleanTrackName('   ')).toBeUndefined();
    expect(cleanTrackName(undefined)).toBeUndefined();
  });
  it('超过上限截断到 64 个字符', () => {
    expect(cleanTrackName('长'.repeat(80))).toHaveLength(TRACK_NAME_MAX);
  });
});

describe('audioTrackName', () => {
  it('优先用户名字，否则素材文件名去扩展名，素材不在时叫「音频」', () => {
    expect(audioTrackName({ ...track, name: '开场' }, assets)).toBe('开场');
    expect(audioTrackName(track, assets)).toBe('夏日');
    expect(audioTrackName({ ...track, name: ' ' }, assets)).toBe('夏日');
    expect(audioTrackName({ ...track, asset_id: 'gone' }, assets)).toBe('音频');
  });
});

describe('sourceAudioName / sourceAudioLabel', () => {
  it('缺省叫「源音轨」，改过名用新名字', () => {
    expect(sourceAudioName(undefined)).toBe('源音轨');
    expect(sourceAudioName({ source_volume: 1, tracks: [], source_name: '原声' })).toBe('原声');
  });
  it('状态后缀跟在名字后面，与改名前的文案一致', () => {
    expect(sourceAudioLabel(undefined, true)).toBe('源音轨');
    expect(sourceAudioLabel(undefined, false)).toBe('源音轨（无）');
    expect(sourceAudioLabel({ source_volume: 0.8, tracks: [] }, true)).toBe('源音轨 80%');
    expect(sourceAudioLabel({ source_volume: 0, tracks: [], source_name: '原声' }, true)).toBe('原声（已静音）');
    expect(sourceAudioLabel({ source_volume: 1, tracks: [], source_hidden: true, source_name: '原声' }, true)).toBe('原声（已隐藏）');
  });
});

import { describe, expect, it } from 'vitest';
import { addMuteRange, audibleSpan, continuationOffset, contractAudio, isDefaultAudio, resolveTrack, sourceGainAt, sourceMutedAt, splitTrackAt, stickerAudioLayers, toggleTrackWindow, trackAssetProblem, trackDefaultsFor, trackGain, trackMediaTime, trackSnapCandidates } from './audioTracks';
import type { Asset, AudioTrack, Layer } from '../types';

const D = 20.6; // 剪后时长

describe('resolveTrack / defaults', () => {
  it('补齐契约缺省值', () => {
    expect(resolveTrack({ id: 'a', asset_id: 'x', t: 'all' })).toEqual({ id: 'a', asset_id: 'x', t: 'all', role: 'bgm', align: 'post', offset: 0, volume: 1, loop: false, fade_in: 0, fade_out: 0 });
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
  it('轨道名（HIG-48）：source_name 单独也算非缺省；空名字不发', () => {
    expect(isDefaultAudio({ source_volume: 1, tracks: [], source_name: '原声' })).toBe(false);
    expect(isDefaultAudio({ source_volume: 1, tracks: [], source_name: ' ' })).toBe(true);
    expect(contractAudio({ source_volume: 1, tracks: [], source_name: ' 原声 ' })).toEqual({ source_volume: 1, source_name: '原声', tracks: [] });
    const out = contractAudio({ source_volume: 0.5, tracks: [{ id: 'a', asset_id: 'x', t: 'all', name: '开场' }, { id: 'b', asset_id: 'x', t: 'all', name: '' }] });
    expect(out?.tracks[0]).toHaveProperty('name', '开场');
    expect(out?.tracks[1]).not.toHaveProperty('name');
  });
  it('拆分音轨两段都沿用原名（HIG-48）', () => {
    const parts = splitTrackAt({ id: 'a', asset_id: 'x', t: [0, 10], name: '开场' }, 4, D, 30, 'b');
    expect(parts?.map((p) => p.name)).toEqual(['开场', '开场']);
  });
  it('隐藏（HIG-33）：source_hidden 单独也算非缺省；hidden 只在为 true 时带上', () => {
    expect(isDefaultAudio({ source_volume: 1, tracks: [], source_hidden: true })).toBe(false);
    expect(contractAudio({ source_volume: 1, tracks: [], source_hidden: true })).toEqual({ source_volume: 1, source_hidden: true, tracks: [] });
    expect(contractAudio({ source_volume: 1, tracks: [], source_hidden: false })).toBeUndefined();
    const out = contractAudio({ source_volume: 0.5, tracks: [{ id: 'a', asset_id: 'x', t: 'all', hidden: true }, { id: 'b', asset_id: 'y', t: 'all', hidden: false }] });
    expect(out?.tracks).toEqual([{ id: 'a', asset_id: 'x', t: 'all', hidden: true }, { id: 'b', asset_id: 'y', t: 'all' }]);
    expect(out).not.toHaveProperty('source_hidden');
  });
  it('源音轨隐藏时增益为 0，音量设置保留', () => {
    expect(sourceGainAt({ source_volume: 0.8, tracks: [], source_hidden: true }, 3)).toBe(0);
    expect(sourceGainAt({ source_volume: 0.8, tracks: [] }, 3)).toBe(0.8);
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

describe('音频模块（HIG-10）', () => {
  const base = { anchor: 'center', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1 } as const;
  const sticker = (id: string, assetId: string, t: Layer['t'] = 'all'): Layer => ({ ...base, margin: [0, 0], id, type: 'sticker', asset_id: assetId, t });
  const text = (id: string, t: Layer['t']): Layer => ({ ...base, margin: [0, 0], id, type: 'text', text: id, style: {} as never, t });
  const asset = (id: string, extra: Partial<Asset>): Asset => ({ id, type: 'sticker', name: `${id}.mp4`, url: '', source: 'upload', created_at: '', ...extra });

  it('stickerAudioLayers 只保留带音轨的视频贴纸', () => {
    const assets = [asset('v1', { kind: 'video', has_audio: true }), asset('v2', { kind: 'video', has_audio: false }), asset('v3', { kind: 'video', has_audio: null }), asset('img', { kind: 'image' })];
    const layers = [sticker('s1', 'v1'), sticker('s2', 'v2'), sticker('s3', 'v3'), sticker('s4', 'img'), sticker('s5', 'gone'), text('t1', 'all')];
    expect(stickerAudioLayers(layers, assets).map((l) => l.id)).toEqual(['s1']);
  });

  it('trackSnapCandidates 含 0、时长、播放头与其他音轨 / 图层端点，排除自身和全程', () => {
    const tracks: AudioTrack[] = [
      { id: 'a', asset_id: 'x', t: [1, 4] },
      { id: 'b', asset_id: 'x', t: [5, 8] },
      { id: 'c', asset_id: 'x', t: 'all' },
    ];
    const layers = [text('t1', [2, 3]), sticker('s1', 'v', 'all')];
    expect(trackSnapCandidates({ tracks, layers, excludeTrackId: 'a', postDuration: D, playhead: 6.5 })).toEqual([0, D, 6.5, 5, 8, 2, 3]);
  });

  it('toggleTrackWindow：全程 → 播放头起 3 秒并截到时长；区间 → 全程', () => {
    expect(toggleTrackWindow([1, 2], 5, D)).toBe('all');
    expect(toggleTrackWindow('all', 5.123, D)).toEqual([5.12, 8.12]);
    expect(toggleTrackWindow('all', 19, D)).toEqual([19, D]);
    // 播放头在末尾：往前留出至少 0.1 秒，区间不会退化成一个点
    expect(toggleTrackWindow('all', D, D)).toEqual([20.5, D]);
    expect(toggleTrackWindow('all', -1, D)).toEqual([0, 3]);
  });
});

describe('align = source（分离出的人声 / 伴奏）', () => {
  const D = 20.6;
  const stem: AudioTrack = { id: 's', asset_id: 'x', align: 'source', t: 'all' };
  it('按源时间定位，不看时段起点', () => {
    expect(trackMediaTime(4, stem, D, 24.6, 6.6)).toBeCloseTo(6.6);
    expect(trackMediaTime(4, { ...stem, t: [2, 12] }, D, 24.6, 6.6)).toBeCloseTo(6.6);
    expect(trackMediaTime(1, { ...stem, t: [2, 12] }, D, 24.6, 1)).toBeNull(); // 时段外
    expect(trackMediaTime(4, stem, D, 24.6)).toBeNull(); // 没给源时间
    expect(trackMediaTime(4, stem, D, 3, 6.6)).toBeNull(); // 素材比源片短，已播完
  });
  it('出声长度按时段长算，淡出贴着时段末尾', () => {
    expect(audibleSpan({ ...stem, t: [2, 12] }, D, 24.6)).toBeCloseTo(10);
    const faded: AudioTrack = { ...stem, t: [2, 12], fade_out: 1 };
    expect(trackGain(11.5, faded, D, 24.6)).toBeCloseTo(0.5);
  });
  it('缺省 align 为 post', () => {
    expect(resolveTrack({ id: 'a', asset_id: 'x', t: 'all' }).align).toBe('post');
  });
});

describe('剪切音轨（HIG-25）', () => {
  const bgm: AudioTrack = { id: 'b', asset_id: 'x', t: 'all', loop: true, volume: 0.6, fade_in: 0.5, fade_out: 1 };

  it('全程轨在播放头处拆成首尾相接的两段，淡入留前、淡出留后，循环轨接着放', () => {
    const parts = splitTrackAt(bgm, 7, D, 3, 'b2');
    expect(parts).toEqual([
      { id: 'b', asset_id: 'x', t: [0, 7], loop: true, volume: 0.6, fade_in: 0.5 },
      { id: 'b2', asset_id: 'x', t: [7, D], loop: true, volume: 0.6, fade_out: 1, offset: 1 }, // 7 mod 3
    ]);
  });

  it('拆开后每一刻的素材位置和增益都和拆之前一样（淡变除外的中段）', () => {
    const [l, r] = splitTrackAt(bgm, 7, D, 3, 'b2')!;
    for (const t of [2, 6.9, 7.2, 12.3, 19]) {
      const whole = trackMediaTime(t, bgm, D, 3);
      const half = t < 7 ? trackMediaTime(t, l, D, 3) : trackMediaTime(t, r, D, 3);
      expect(half).toBeCloseTo(whole!, 6);
      expect(t < 7 ? trackGain(t, l, D, 3) : trackGain(t, r, D, 3)).toBeCloseTo(trackGain(t, bgm, D, 3), 6);
    }
  });

  it('不循环的口播：后一段 offset 顺延，播完素材后仍静音', () => {
    const voice: AudioTrack = { id: 'v', asset_id: 'x', role: 'voice', t: [2, 12], offset: 1 };
    const [l, r] = splitTrackAt(voice, 3.5, D, 4, 'v2')!;
    expect(l).toEqual({ id: 'v', asset_id: 'x', role: 'voice', t: [2, 3.5], offset: 1 });
    expect(r).toEqual({ id: 'v2', asset_id: 'x', role: 'voice', t: [3.5, 12], offset: 2.5 });
    expect(trackMediaTime(4, r, D, 4)).toBeCloseTo(3);
    expect(trackMediaTime(6, r, D, 4)).toBeNull(); // 4 s 素材从 1 s 起只够到 5 s
    // 素材早已播完时拆分：offset 夹在素材时长内
    expect(splitTrackAt(voice, 10, D, 4, 'v3')![1].offset).toBe(4);
  });

  it('align = source 只拆时段，不加 offset', () => {
    const stem: AudioTrack = { id: 's', asset_id: 'x', align: 'source', t: [1, 9] };
    expect(splitTrackAt(stem, 4, D, 24, 's2')).toEqual([
      { id: 's', asset_id: 'x', align: 'source', t: [1, 4] },
      { id: 's2', asset_id: 'x', align: 'source', t: [4, 9] },
    ]);
  });

  it('播放头离两端不足 0.1 秒或在时段外时不拆；淡变按新时段长收紧', () => {
    const w: AudioTrack = { id: 'w', asset_id: 'x', t: [2, 6], fade_in: 3, fade_out: 3 };
    expect(splitTrackAt(w, 2.05, D, 10, 'n')).toBeNull();
    expect(splitTrackAt(w, 5.95, D, 10, 'n')).toBeNull();
    expect(splitTrackAt(w, 8, D, 10, 'n')).toBeNull();
    const [l, r] = splitTrackAt(w, 3, D, 10, 'n')!;
    expect(l.fade_in).toBe(1);
    expect(r.fade_out).toBe(3);
  });

  it('continuationOffset：找紧挨在前面的同素材轨，算出「接着放」的起点', () => {
    const [l, r] = splitTrackAt(bgm, 7, D, 3, 'b2')!;
    const reset = { ...r, offset: 0 };
    expect(continuationOffset(reset, [l, reset], D, 3)).toBe(1);
    expect(continuationOffset(l, [l, reset], D, 3)).toBeNull(); // 前面没有
    expect(continuationOffset({ ...reset, asset_id: 'other' }, [l, reset], D, 3)).toBeNull();
    expect(continuationOffset({ ...reset, align: 'source' }, [l, reset], D, 3)).toBeNull();
  });

  it('原声静音区间：加入时排序合并、裁到剪后时长，预览增益在区间内为 0', () => {
    let m = addMuteRange(undefined, 5, 3, D);
    expect(m).toEqual([[3, 5]]);
    m = addMuteRange(m, 4.5, 8, D);
    expect(m).toEqual([[3, 8]]);
    m = addMuteRange(m, 19, 40, D);
    expect(m).toEqual([[3, 8], [19, 20.6]]);
    expect(addMuteRange(m, 10, 10.01, D)).toBe(m); // 太短不加
    const audio = { source_volume: 0.8, source_mute: m, tracks: [] };
    expect(sourceMutedAt(audio, 3)).toBe(true);
    expect(sourceMutedAt(audio, 8)).toBe(false); // 区间右端开
    expect(sourceGainAt(audio, 5)).toBe(0);
    expect(sourceGainAt(audio, 9)).toBe(0.8);
    expect(sourceGainAt(undefined, 9)).toBe(1);
  });

  it('contractAudio / isDefaultAudio 认 source_mute；空数组不发', () => {
    expect(isDefaultAudio({ source_volume: 1, source_mute: [[1, 2]], tracks: [] })).toBe(false);
    expect(isDefaultAudio({ source_volume: 1, source_mute: [], tracks: [] })).toBe(true);
    expect(contractAudio({ source_volume: 1, source_mute: [[1.23456, 2]], tracks: [] })).toEqual({ source_volume: 1, source_mute: [[1.235, 2]], tracks: [] });
    expect(contractAudio({ source_volume: 0.5, source_mute: [], tracks: [] })).toEqual({ source_volume: 0.5, tracks: [] });
  });

  it('循环轨带 offset：第一遍从 offset 起，之后对素材时长取模', () => {
    const loop: AudioTrack = { id: 'l', asset_id: 'x', t: [4, 10], loop: true, offset: 2.5 };
    expect(trackMediaTime(4, loop, D, 3)).toBeCloseTo(2.5);
    expect(trackMediaTime(4.6, loop, D, 3)).toBeCloseTo(0.1);
  });
});

describe('trackAssetProblem（HIG-26）', () => {
  const assets = [
    { id: 'a_ok', type: 'audio', kind: 'audio', status: 'ready' },
    { id: 'a_wait', type: 'audio', kind: 'audio', status: 'preparing' },
  ] as Asset[];
  it('素材不在 → missing；还在处理 → not-ready；就绪 → null', () => {
    expect(trackAssetProblem({ id: 't', asset_id: 'a_gone', t: 'all' }, assets)).toBe('missing');
    expect(trackAssetProblem({ id: 't', asset_id: 'a_wait', t: 'all' }, assets)).toBe('not-ready');
    expect(trackAssetProblem({ id: 't', asset_id: 'a_ok', t: 'all' }, assets)).toBeNull();
  });
});

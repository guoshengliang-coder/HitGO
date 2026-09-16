// 音轨（契约 §2 audio）：预览与成片共用的一套规则。
// 成片端（filtergraph.py）对每条 track：atrim=start=offset → atrim=end=时段长 → volume → afade in/out → adelay；
// 这里给编辑器算"此刻素材该播到哪一秒 / 此刻的增益"，让 <audio> 的 currentTime / volume 跟成片一致。

import { isVideoAsset, type Asset, type AudioRole, type AudioSpec, type AudioTrack, type Layer, type StickerLayer, type TimeWindow } from '../types';
import { windowRange } from './stickerMedia';

const EPS = 1e-6;

export const TRACK_DEFAULTS = { role: 'bgm', align: 'post', offset: 0, volume: 1, loop: false, fade_in: 0, fade_out: 0 } as const satisfies Omit<AudioTrack, 'id' | 'asset_id' | 't'>;

export type ResolvedTrack = Required<AudioTrack>;

/** 把契约里的可选字段补齐成缺省值。 */
export function resolveTrack(track: AudioTrack): ResolvedTrack {
  return {
    ...TRACK_DEFAULTS,
    ...Object.fromEntries(Object.entries(track).filter(([, v]) => v !== undefined)),
  } as ResolvedTrack;
}

/** 新音轨按角色的默认值：BGM 循环、压低并淡出；口播原音量、播一遍。 */
export function trackDefaultsFor(role: AudioRole): Partial<AudioTrack> {
  return role === 'bgm' ? { loop: true, volume: 0.6, fade_out: 1 } : { loop: false, volume: 1 };
}

let seq = 0;
export function newTrackId(): string {
  seq += 1;
  return `au_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function sourceVolume(audio: AudioSpec | null | undefined): number {
  return audio ? Math.max(0, Math.min(1, audio.source_volume)) : 1;
}

/** 没有 audio 块，或源音量 1 且没有音轨：等价于契约缺省，发给后端时省略。 */
export function isDefaultAudio(audio: AudioSpec | null | undefined): boolean {
  return !audio || (audio.source_volume === 1 && audio.tracks.length === 0);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 发送给后端的 audio 块；缺省时返回 undefined（不带此字段）。 */
export function contractAudio(audio: AudioSpec | null | undefined): AudioSpec | undefined {
  if (isDefaultAudio(audio) || !audio) return undefined;
  return {
    source_volume: round3(audio.source_volume),
    tracks: audio.tracks.map((t) => {
      const copy: AudioTrack = { ...t };
      if (copy.t !== 'all') copy.t = [round3(copy.t[0]), round3(copy.t[1])];
      return copy;
    }),
  };
}

/**
 * 素材实际出声的长度（秒，从时段起点算）：循环时等于时段长；否则受素材剩余时长（素材时长 − offset）限制。
 * 淡出以它为终点——成片端同一条规则（filtergraph 里的 effective）。
 */
export function audibleSpan(track: AudioTrack, postDuration: number, mediaDuration: number): number {
  const r = resolveTrack(track);
  const [start, end] = windowRange(r.t, postDuration);
  const window = Math.max(0, end - start);
  if (r.loop || r.align === 'source') return window; // 对齐源时间轴：素材覆盖整条源片，按时段长算
  if (!(mediaDuration > 0)) return 0;
  return Math.max(0, Math.min(window, mediaDuration - r.offset));
}

/**
 * 剪后时刻 postTime 这条音轨应该定位到素材的第几秒；null = 此刻不出声（时段外、素材已播完、时长未知）。
 * 循环时对素材时长取模（-stream_loop 从文件头重复，所以循环要求 offset = 0）。
 * align = 'source' 的音轨（分离出的人声 / 伴奏）按源时间定位：传入 sourceTime（播放头的源时间），
 * 成片端对它套用同样的剪辑，所以素材位置 = 源时间。
 */
export function trackMediaTime(postTime: number, track: AudioTrack, postDuration: number, mediaDuration: number, sourceTime?: number): number | null {
  const r = resolveTrack(track);
  const [start, end] = windowRange(r.t, postDuration);
  if (postTime < start - EPS || postTime > end + EPS) return null;
  if (!(mediaDuration > 0)) return null;
  if (r.align === 'source') {
    if (sourceTime === undefined || sourceTime < 0 || sourceTime >= mediaDuration - EPS) return null;
    return sourceTime;
  }
  const elapsed = Math.max(0, postTime - start);
  if (r.loop) return elapsed % mediaDuration;
  const available = mediaDuration - r.offset;
  if (available <= EPS || elapsed >= available - EPS) return null;
  return r.offset + elapsed;
}

/** 此刻的增益（0–1）：音量 × 线性淡入淡出包络（ffmpeg afade 默认曲线 tri 也是线性）。时段外为 0。 */
export function trackGain(postTime: number, track: AudioTrack, postDuration: number, mediaDuration: number): number {
  const r = resolveTrack(track);
  const [start, end] = windowRange(r.t, postDuration);
  if (postTime < start - EPS || postTime > end + EPS) return 0;
  const effective = audibleSpan(track, postDuration, mediaDuration);
  if (effective <= EPS) return 0;
  const elapsed = Math.max(0, postTime - start);
  let gain = Math.max(0, Math.min(1, r.volume));
  const fadeIn = Math.min(r.fade_in, effective);
  const fadeOut = Math.min(r.fade_out, effective);
  if (fadeIn > 0) gain *= Math.max(0, Math.min(1, elapsed / fadeIn));
  if (fadeOut > 0) gain *= Math.max(0, Math.min(1, (effective - elapsed) / fadeOut));
  return gain;
}

// ---- 音频模块（HIG-10）----

/** 带声音的视频贴纸图层：音频模块的「贴纸音轨」分组和时间线共用。只有这些图层的 mix_audio 才有意义。 */
export function stickerAudioLayers(layers: Layer[], assets: Asset[]): StickerLayer[] {
  return layers.filter((l): l is StickerLayer => {
    if (l.type !== 'sticker') return false;
    const asset = assets.find((a) => a.id === l.asset_id);
    return isVideoAsset(asset) && asset?.has_audio === true;
  });
}

/** 时间线上拖动音轨时的吸附点（剪后时间）：0、剪后时长、播放头、其他音轨和图层的区间端点。 */
export function trackSnapCandidates(opts: { tracks: AudioTrack[]; layers: Layer[]; excludeTrackId: string; postDuration: number; playhead: number }): number[] {
  const { tracks, layers, excludeTrackId, postDuration, playhead } = opts;
  const ends = (t: TimeWindow) => (t === 'all' ? [] : t);
  return [0, postDuration, playhead, ...tracks.flatMap((t) => (t.id === excludeTrackId ? [] : ends(t.t))), ...layers.flatMap((l) => ends(l.t))];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 时间线轨道头的「全程 / 区间」切换：全程 → 从播放头起 3 秒（截到剪后时长，至少 0.1 秒）；区间 → 全程。 */
export function toggleTrackWindow(t: TimeWindow, playhead: number, postDuration: number): TimeWindow {
  if (t !== 'all') return 'all';
  const d = Math.max(0.1, postDuration);
  const start = Math.max(0, Math.min(playhead, d - 0.1));
  return [round2(start), round2(Math.max(start + 0.1, Math.min(d, start + 3)))];
}

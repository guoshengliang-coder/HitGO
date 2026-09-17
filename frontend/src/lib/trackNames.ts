// 时间线轨道名（HIG-48）：图层 / 音轨 / 源音轨的显示名。用户改过的名字存在 spec 里（layers[].name、audio.tracks[].name、
// audio.source_name，契约 §2），没改过时按原来的规则自动命名；清空即恢复自动名。视频轨没有单独的字段，改的是 Video.name。

import type { Asset, AudioSpec, AudioTrack } from '../types';

/** 契约上限：名字最长 64 个字符。 */
export const TRACK_NAME_MAX = 64;

/** 用户输入 → 存进 spec 的名字；空白视为清空（恢复自动名），超长截断。 */
export function cleanTrackName(input: string | null | undefined): string | undefined {
  const v = (input ?? '').trim().slice(0, TRACK_NAME_MAX).trim();
  return v || undefined;
}

/** BGM / 口播轨的显示名：用户名字，否则素材文件名去扩展名，素材不在时叫「音频」。 */
export function audioTrackName(track: AudioTrack, assets: Asset[]): string {
  const own = cleanTrackName(track.name);
  if (own) return own;
  const asset = assets.find((a) => a.id === track.asset_id);
  return asset?.name.replace(/\.[a-z0-9]+$/i, '') ?? '音频';
}

/** 源音轨的名字（不含状态），可编辑的就是它。 */
export function sourceAudioName(audio: AudioSpec | null | undefined): string {
  return cleanTrackName(audio?.source_name) ?? '源音轨';
}

/** 源音轨轨道头上的完整文字：名字 + 状态（无 / 已隐藏 / 已静音 / 音量）。 */
export function sourceAudioLabel(audio: AudioSpec | null | undefined, hasAudio: boolean): string {
  const name = sourceAudioName(audio);
  if (!hasAudio) return `${name}（无）`;
  if (audio?.source_hidden) return `${name}（已隐藏）`;
  const volume = audio ? Math.max(0, Math.min(1, audio.source_volume)) : 1;
  if (volume === 0) return `${name}（已静音）`;
  return volume < 1 ? `${name} ${Math.round(volume * 100)}%` : name;
}

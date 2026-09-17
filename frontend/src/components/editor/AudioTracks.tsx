// 预览里的音轨播放（契约 §2 audio.tracks）：每条音轨一个 <audio>，跟着 player 的播放头走，
// 定位 / 增益全部由 lib/audioTracks 按成片同一套规则算出来（预览 == 成片）。不画任何东西。
//
// 按 track.id 各建一个元素（不按 URL 复用）：两条音轨用同一段素材时各放各的。
// 播放中只在明显漂移时纠正 currentTime（BGM 0.25 s，口播 0.1 s——口播漂移会听出来），暂停 / 拖动后精确对齐。

import { useEffect, useRef } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { player } from '../../lib/player';
import { resolveTrack, trackGain, trackMediaTime } from '../../lib/audioTracks';
import { sequenceSourceTime } from '../../lib/sequence';
import { isAssetReady, type AudioTrack } from '../../types';

function TrackAudio({ track }: { track: AudioTrack }) {
  const ownerId = useEditor((s) => s.currentVideoId);
  const sequence = useEditor((s) => s.currentVideoId ? s.specs[s.currentVideoId]?.sequence : null);
  const asset = useEditor((s) => s.assets.find((a) => a.id === track.asset_id));
  const postDuration = usePostDuration();
  const elRef = useRef<HTMLAudioElement | null>(null);
  const url = asset && isAssetReady(asset) ? asset.url : undefined;
  const mediaDuration = asset?.duration ?? 0;

  useEffect(() => {
    if (!url) return;
    const el = new Audio(url);
    el.preload = 'auto';
    elRef.current = el;
    return () => {
      el.pause();
      el.removeAttribute('src');
      el.load();
      elRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const r = resolveTrack(track);
    const tolerance = r.role === 'voice' ? 0.1 : 0.25;
    const sync = (postTime: number, playing: boolean, sourceTime: number) => {
      // align = source 的音轨（分离出的人声 / 伴奏）按源时间定位，剪辑跳过的段它也跳过
      const rawTime = sequence && ownerId ? sequenceSourceTime(sequence, ownerId, sourceTime) : sourceTime;
      const at = trackMediaTime(postTime, r, postDuration, mediaDuration, rawTime);
      el.volume = Math.max(0, Math.min(1, trackGain(postTime, r, postDuration, mediaDuration)));
      if (at === null || !playing) {
        if (!el.paused) el.pause();
        if (at !== null && Math.abs(el.currentTime - at) > 0.01) el.currentTime = at;
        return;
      }
      if (el.playbackRate !== player.mediaRate) el.playbackRate = player.mediaRate;
      if (Math.abs(el.currentTime - at) > tolerance * player.mediaRate) el.currentTime = at;
      if (el.paused) void el.play().catch(() => undefined);
    };
    // 封面段（t < 0）不放 BGM / 口播：按暂停对齐（契约 §2 cover）
    // 倒放（mediaRate = 0）按暂停对齐（HIG-30）
    // 成片时刻跨遍累加（HIG-50 循环补足）：朗读轨排到源片之后也能接着放
    sync(player.postTime, player.mediaRate > 0 && player.currentTime >= 0, player.currentTime);
    const unsub = player.subscribe((t) => sync(player.postTime, player.mediaRate > 0 && t >= 0, t));
    return () => {
      unsub();
      el.pause();
    };
  }, [url, track, mediaDuration, postDuration, sequence, ownerId]);

  return null;
}

/** 挂在舞台里；裁切编辑时舞台只是隐藏、仍然挂着，所以播放照常出声。 */
export function AudioTracks() {
  const tracks = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.audio?.tracks : undefined)) ?? [];
  return (
    <>
      {/* 关掉眼睛的音轨（HIG-33）不挂元素，卸载时 pause，和成片一样不出声 */}
      {tracks.filter((t) => !t.hidden).map((t) => (
        <TrackAudio key={t.id} track={t} />
      ))}
    </>
  );
}

import type { Asset, AudioTrack, Video } from '../types';
import { isAssetReady } from '../types';

export interface ResolvedAudioTrackSource {
  name: string;
  duration: number;
  url?: string;
  ready: boolean;
  isVideo: boolean;
}

export function resolveAudioTrackSource(track: AudioTrack, assets: Asset[], videos: Video[]): ResolvedAudioTrackSource | null {
  if (track.source_kind === 'video') {
    const video = videos.find((item) => item.id === track.asset_id);
    if (!video) return null;
    return {
      name: `${video.name.replace(/\.[a-z0-9]+$/i, '')} · 原声`,
      duration: video.duration,
      url: video.proxy_url || video.source_url,
      ready: video.status === 'ready' && video.has_audio,
      isVideo: true,
    };
  }
  const asset = assets.find((item) => item.id === track.asset_id);
  if (!asset) return null;
  return {
    name: asset.name.replace(/\.[a-z0-9]+$/i, ''),
    duration: asset.duration ?? 0,
    url: asset.url,
    ready: isAssetReady(asset),
    isVideo: false,
  };
}

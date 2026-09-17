import type { SequenceSpec, Video } from '../types';
import { clipWindows } from './sequence';

/** Use the same sprite-strip geometry for a real or composed source. No interactive clip blocks. */
export function timelineThumbnails(video: Video | null, sequence: SequenceSpec | null | undefined, videos: Video[], pps: number) {
  const windows = sequence ? clipWindows(sequence) : video ? [{ clip: { video_id: video.id, in: 0, out: video.duration }, start: 0, end: video.duration }] : [];
  return windows.flatMap((w, index) => {
    const source = videos.find(v => v.id === w.clip.video_id);
    const sprite = source?.sprite;
    const end = windows[index + 1]?.start ?? w.end;
    if (!sprite || sprite.interval <= 0) return [];
    const slot = sprite.interval * pps;
    const scale = Math.max(64 / sprite.tile_height, slot / sprite.tile_width);
    const tileW = sprite.tile_width * scale, tileH = sprite.tile_height * scale;
    const tiles = [];
    for (let t = w.start; t < end - 1e-6;) {
      const raw = w.clip.in + (t - w.start);
      const sourceTile = Math.floor(raw / sprite.interval + 1e-6);
      const i = Math.min(sprite.count - 1, sourceTile);
      const next = Math.min(end, t + (sourceTile + 1) * sprite.interval - raw);
      if (next <= t + 1e-6) break;
      tiles.push({ left: t * pps, width: (next - t) * pps, backgroundImage: `url("${sprite.url}")`, backgroundSize: `${sprite.columns * tileW}px auto`, backgroundPosition: `-${(i % sprite.columns) * tileW}px ${-Math.floor(i / sprite.columns) * tileH + (64 - tileH) / 2}px` });
      t = next;
    }
    return tiles;
  });
}

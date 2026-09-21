import type { FillMode, VideoTransform } from '../types';

export interface VideoBox { x: number; y: number; w: number; h: number }

export const DEFAULT_VIDEO_TRANSFORM: Required<Pick<VideoTransform, 'fit' | 'scale' | 'x' | 'y'>> = {
  fit: 'auto', scale: 1, x: 0.5, y: 0.5,
};

export function resolveVideoTransform(value?: VideoTransform | null): Required<Pick<VideoTransform, 'fit' | 'scale' | 'x' | 'y'>> & Pick<VideoTransform, 'crop'> {
  return {
    fit: value?.fit ?? 'auto',
    scale: Math.max(0.05, Math.min(20, value?.scale ?? 1)),
    x: Math.max(-2, Math.min(3, value?.x ?? 0.5)),
    y: Math.max(-2, Math.min(3, value?.y ?? 0.5)),
    crop: value?.crop ?? null,
  };
}

export function videoBox(transform: VideoTransform | null | undefined, sourceW: number, sourceH: number, canvasW: number, canvasH: number, fill: FillMode): VideoBox {
  const t = resolveVideoTransform(transform);
  const cropW = Math.max(1, sourceW * (t.crop?.w ?? 1));
  const cropH = Math.max(1, sourceH * (t.crop?.h ?? 1));
  const fit = t.fit === 'auto' ? (fill === 'crop' ? 'cover' : 'contain') : t.fit;
  const base = fit === 'original' ? 1 : fit === 'cover'
    ? Math.max(canvasW / cropW, canvasH / cropH)
    : Math.min(canvasW / cropW, canvasH / cropH);
  const w = cropW * base * t.scale;
  const h = cropH * base * t.scale;
  return { x: t.x * canvasW - w / 2, y: t.y * canvasH - h / 2, w, h };
}

export function transformFromBox(box: VideoBox, previous: VideoTransform | null | undefined, sourceW: number, sourceH: number, canvasW: number, canvasH: number, fill: FillMode): VideoTransform {
  const current = resolveVideoTransform(previous);
  const base = videoBox({ ...current, scale: 1 }, sourceW, sourceH, canvasW, canvasH, fill);
  return {
    ...current,
    scale: Math.max(0.05, Math.min(20, box.w / Math.max(1, base.w))),
    x: (box.x + box.w / 2) / canvasW,
    y: (box.y + box.h / 2) / canvasH,
  };
}

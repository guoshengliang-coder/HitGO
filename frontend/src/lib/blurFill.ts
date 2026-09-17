// 模糊背景（契约 §2 outputs[].blur / bg_brightness，HIG-54）的纯函数：缺省值、boxblur 半径、预览滤镜。
// 半径公式与后端 filtergraph.blur_background_radius 一致；预览只是近似，成片以 worker 为准。

import type { OutputVariant } from '../types';

export const BLUR_DEFAULT = 60;
export const BG_BRIGHTNESS_DEFAULT = 50;
export const BLUR_MIN = 0;
export const BLUR_MAX = 100;
export const BG_BRIGHTNESS_MIN = 20;
export const BG_BRIGHTNESS_MAX = 100;

const RADIUS_PER_SHORT_SIDE = 0.08;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 变体上生效的模糊强度（缺省 / 非法值回落到 60）。 */
export function blurOf(out: Pick<OutputVariant, 'blur'>): number {
  return Number.isFinite(out.blur) ? clamp(Math.round(out.blur as number), BLUR_MIN, BLUR_MAX) : BLUR_DEFAULT;
}

/** 变体上生效的背景亮度（%，缺省 / 非法值回落到 50）。 */
export function bgBrightnessOf(out: Pick<OutputVariant, 'bg_brightness'>): number {
  return Number.isFinite(out.bg_brightness) ? clamp(Math.round(out.bg_brightness as number), BG_BRIGHTNESS_MIN, BG_BRIGHTNESS_MAX) : BG_BRIGHTNESS_DEFAULT;
}

/** 两项都是缺省值（摘要、「已有自定义」判断用）。 */
export function isDefaultBlurFill(out: Pick<OutputVariant, 'blur' | 'bg_brightness'>): boolean {
  return blurOf(out) === BLUR_DEFAULT && bgBrightnessOf(out) === BG_BRIGHTNESS_DEFAULT;
}

/** 成片画布 W×H 上的 boxblur 半径：短边 × 强度 × 0.08，收到短边 / 4 − 1 以内（与后端一致）。 */
export function blurRadius(W: number, H: number, strength: number): number {
  const short = Math.min(W, H);
  if (!(short > 0)) return 0;
  const r = Math.round((short * clamp(strength, BLUR_MIN, BLUR_MAX)) / 100 * RADIUS_PER_SHORT_SIDE);
  return Math.max(0, Math.min(r, Math.floor(short / 4) - 1));
}

/**
 * 预览用的 CSS 滤镜字符串。boxblur power 2 近似高斯，σ ≈ 0.8 × 半径（同 lib/mask 的遮盖预览），
 * 再按「绘制画布宽 / 成片宽」缩放；亮度直接对应 CSS brightness()。
 */
export function blurFillFilter(out: Pick<OutputVariant, 'blur' | 'bg_brightness'>, W: number, H: number, drawW: number): string {
  const r = blurRadius(W, H, blurOf(out));
  const px = W > 0 && drawW > 0 ? Math.round(((r * 0.8 * drawW) / W) * 10) / 10 : 0;
  const parts: string[] = [];
  if (px > 0) parts.push(`blur(${px}px)`);
  const b = bgBrightnessOf(out);
  if (b < 100) parts.push(`brightness(${b / 100})`);
  return parts.length ? parts.join(' ') : 'none';
}

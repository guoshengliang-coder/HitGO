// 文字图层动画（HIG-40，契约 §2 layers[type=text].animation）：入场 / 出场 / 循环三栏预设。
// 曲线和成片端 backend/app/services/animation.py 同一套定义，两端都对照 fixtures/textAnimationCases.json。
// 一帧动画 = 透明度倍数 opacity、中心偏移 dx / dy（相对画布高，所以各画幅、预览与成片看起来一样）、绕中心缩放 scale。
// 时段长 L：入场 [0, di]，di = min(in, L)；出场 [L − do, L]，do = min(out, L − di)；循环从 di 到 L（与出场叠加）。

import type { TextAnimation, TextAnimLoopPreset, TextAnimMovePreset } from '../types';

export const SLIDE = 0.05;
export const POP_FROM = 0.5;
const BACK = 1.70158;
const BREATHE = 0.03;
const FLOAT = 0.008;
const BLINK = 0.35;

export interface AnimFrame {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
}

export const REST: AnimFrame = { opacity: 1, dx: 0, dy: 0, scale: 1 };

export const MOVE_PRESETS: { v: TextAnimMovePreset; label: string }[] = [
  { v: 'fade', label: '渐显' },
  { v: 'slide_up', label: '向上滑' },
  { v: 'slide_down', label: '向下滑' },
  { v: 'slide_left', label: '向左滑' },
  { v: 'slide_right', label: '向右滑' },
  { v: 'pop', label: '弹入' },
];
/** 出场里 fade / pop 的叫法不同，其余同名。 */
export const OUT_LABEL: Partial<Record<TextAnimMovePreset, string>> = { fade: '渐隐', pop: '缩小' };
export const LOOP_PRESETS: { v: TextAnimLoopPreset; label: string }[] = [
  { v: 'breathe', label: '呼吸' },
  { v: 'float', label: '浮动' },
  { v: 'blink', label: '闪烁' },
];

export const DEFAULT_PHASE_DURATION = 0.5;
export const DEFAULT_LOOP_PERIOD = 1.2;
export const MAX_ANIM_SECONDS = 10;

const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

export function hasAnimation(anim: TextAnimation | null | undefined): anim is TextAnimation {
  return !!anim && !!(anim.in || anim.out || anim.loop);
}

/** 时段长 window 里入场 / 出场实际用的时长。 */
export function phaseLengths(anim: TextAnimation, window: number): [number, number] {
  const L = Math.max(0, window);
  const di = anim.in ? Math.min(anim.in.duration ?? DEFAULT_PHASE_DURATION, L) : 0;
  const d = anim.out ? Math.min(anim.out.duration ?? DEFAULT_PHASE_DURATION, Math.max(0, L - di)) : 0;
  return [di, d];
}

/** 时段内本地时间 u（秒）这一刻的动画状态。 */
export function sampleAnimation(anim: TextAnimation | null | undefined, u: number, window: number): AnimFrame {
  if (!hasAnimation(anim) || window <= 0) return { ...REST };
  const L = window;
  const [di, d] = phaseLengths(anim, L);
  const f: AnimFrame = { ...REST };

  if (anim.in && di > 0) {
    const p = clip(u / di, 0, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    const rest = 1 - ease;
    switch (anim.in.preset) {
      case 'pop': {
        f.opacity *= clip(3 * p, 0, 1);
        const back = 1 + (BACK + 1) * Math.pow(p - 1, 3) + BACK * Math.pow(p - 1, 2);
        f.scale *= POP_FROM + (1 - POP_FROM) * back;
        break;
      }
      case 'slide_up':
        f.opacity *= ease;
        f.dy += SLIDE * rest;
        break;
      case 'slide_down':
        f.opacity *= ease;
        f.dy -= SLIDE * rest;
        break;
      case 'slide_left':
        f.opacity *= ease;
        f.dx += SLIDE * rest;
        break;
      case 'slide_right':
        f.opacity *= ease;
        f.dx -= SLIDE * rest;
        break;
      default:
        f.opacity *= ease;
    }
  }

  if (anim.out && d > 0) {
    const q = clip((u - (L - d)) / d, 0, 1);
    const ease = Math.pow(q, 3);
    f.opacity *= 1 - ease;
    switch (anim.out.preset) {
      case 'pop':
        f.scale *= 1 - (1 - POP_FROM) * ease;
        break;
      case 'slide_up':
        f.dy -= SLIDE * ease;
        break;
      case 'slide_down':
        f.dy += SLIDE * ease;
        break;
      case 'slide_left':
        f.dx -= SLIDE * ease;
        break;
      case 'slide_right':
        f.dx += SLIDE * ease;
        break;
    }
  }

  if (anim.loop && L - di > 0 && u >= di && u <= L) {
    const w = (2 * Math.PI * (u - di)) / (anim.loop.period ?? DEFAULT_LOOP_PERIOD);
    switch (anim.loop.preset) {
      case 'breathe':
        f.scale *= 1 + BREATHE * (1 - Math.cos(w));
        break;
      case 'float':
        f.dy -= FLOAT * Math.sin(w);
        break;
      case 'blink':
        f.opacity *= 1 - BLINK * (1 - Math.cos(w));
        break;
    }
  }
  return f;
}

/**
 * 发给后端的 animation：空的不发；时长 / 周期补齐缺省并取两位小数。
 * 时段是区间（window 非 null）时按 phaseLengths 把入场 + 出场压进时段——契约要求两者之和不超过时段长，
 * 用户事后把时段拖短也不会让保存失败；压过的时长和成片 / 预览实际用的一致。
 */
export function contractAnimation(anim: TextAnimation | null | undefined, window: number | null): TextAnimation | undefined {
  if (!hasAnimation(anim)) return undefined;
  const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
  const [di, d] = window === null ? [anim.in?.duration ?? DEFAULT_PHASE_DURATION, anim.out?.duration ?? DEFAULT_PHASE_DURATION] : phaseLengths(anim, window);
  const out: TextAnimation = {};
  if (anim.in) out.in = { preset: anim.in.preset, duration: Math.max(0.01, floor2(di)) };
  if (anim.out) out.out = { preset: anim.out.preset, duration: Math.max(0.01, floor2(d)) };
  if (anim.loop) out.loop = { preset: anim.loop.preset, period: Math.round((anim.loop.period ?? DEFAULT_LOOP_PERIOD) * 100) / 100 };
  if (window !== null && out.in && out.out && (out.in.duration ?? 0) + (out.out.duration ?? 0) > window) {
    // 两边都被压到 0.01 的极端情况（时段本身不到 0.02 秒）：出场让给入场
    delete out.out;
  }
  return out;
}

export type AnimTab = 'in' | 'out' | 'loop';

/** 分组收起时的摘要，如「入场 弹入 · 循环 呼吸」；没有动画时「无」。 */
export function animationSummary(anim: TextAnimation | null | undefined): string {
  if (!hasAnimation(anim)) return '无';
  const parts: string[] = [];
  const move = (v: TextAnimMovePreset, out: boolean) => (out && OUT_LABEL[v]) || MOVE_PRESETS.find((p) => p.v === v)?.label || v;
  if (anim.in) parts.push(`入场 ${move(anim.in.preset, false)}`);
  if (anim.out) parts.push(`出场 ${move(anim.out.preset, true)}`);
  if (anim.loop) parts.push(`循环 ${LOOP_PRESETS.find((p) => p.v === anim.loop!.preset)?.label ?? anim.loop.preset}`);
  return parts.join(' · ');
}

/**
 * 「试播」这一栏要放的剪后区间 [from, to]：入场从时段开头放到入场结束后一点；出场从出场开始前一点放到时段结束；
 * 循环从入场结束放两个周期（不超过时段）。window = 图层时段 [a, b]（已按剪后时长裁过）。
 */
export function previewSpan(anim: TextAnimation, tab: AnimTab, window: [number, number]): [number, number] {
  const [a, b] = window;
  const [di, d] = phaseLengths(anim, b - a);
  const lead = 0.3;
  if (tab === 'in') return [a, Math.min(b, a + di + lead)];
  if (tab === 'out') return [Math.max(a, b - d - lead), b];
  const period = anim.loop?.period ?? DEFAULT_LOOP_PERIOD;
  return [a + di, Math.min(b, a + di + 2 * period)];
}

// 文字图层动画（HIG-40 / HIG-44，契约 §2 layers[type=text].animation）：入场 / 出场 / 循环三栏预设，外加默认收起的高级项。
// 曲线和成片端 backend/app/services/animation.py 同一套定义，两端都对照 fixtures/textAnimationCases.json。
// 一帧动画 = 透明度倍数 opacity、中心偏移 dx / dy（相对画布高，所以各画幅、预览与成片看起来一样）、绕中心缩放 scale。
// 时段长 L、入场延迟 dl = min(delay, L)：入场 [dl, dl + di]，di = min(in, L − dl)；出场 [L − do, L]，do = min(out, L − dl − di)；
// 循环从 dl + di 到 L（与出场叠加）。逐字显现（HIG-45）见 lib/textReveal。

import type { TextAnimEasing, TextAnimation, TextAnimLoopPreset, TextAnimMovePreset, TextAnimPhase, TextRevealPreset } from '../types';

export const SLIDE = 0.05;
export const POP_FROM = 0.5;
export const BACK = 1.70158;
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
export const REVEAL_PRESETS: { v: TextRevealPreset; label: string }[] = [
  { v: 'typewriter', label: '打字机' },
  { v: 'fade_chars', label: '逐字渐显' },
  { v: 'wipe', label: '逐字擦除' },
];
export const EASINGS: { v: TextAnimEasing; label: string }[] = [
  { v: 'linear', label: '线性' },
  { v: 'ease_in', label: '缓入' },
  { v: 'ease_out', label: '缓出' },
  { v: 'ease_in_out', label: '缓入缓出' },
  { v: 'back', label: '回弹' },
  { v: 'elastic', label: '弹性' },
  { v: 'bounce', label: '弹跳' },
];

export const DEFAULT_PHASE_DURATION = 0.5;
export const DEFAULT_LOOP_PERIOD = 1.2;
export const DEFAULT_REVEAL_DURATION = 1;
export const MAX_ANIM_SECONDS = 10;
export const MAX_REVEAL_SECONDS = 30;

/**
 * 编辑器里新选一个滑动预设时写进 spec 的距离（HIG-44）。契约缺省仍是 v0.16.0 的 SLIDE，老 spec 导出不变；
 * 新选的按这里更明显的幅度（本机按帧对比 0.05 / 0.10 / 0.15 后定）。
 */
export const NEW_PRESET_DEFAULTS: Partial<Record<TextAnimMovePreset, Partial<TextAnimPhase>>> = {
  slide_up: { distance: 0.1 },
  slide_down: { distance: 0.1 },
  slide_left: { distance: 0.1 },
  slide_right: { distance: 0.1 },
};

export const isSlide = (p: TextAnimMovePreset) => p.startsWith('slide_');

const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const MONOTONE: TextAnimEasing[] = ['linear', 'ease_in', 'ease_out', 'ease_in_out'];

export function hasAnimation(anim: TextAnimation | null | undefined): anim is TextAnimation {
  return !!anim && !!(anim.in || anim.out || anim.loop || anim.reveal);
}

/** 这一栏实际用的曲线（没写 easing 时按预设）。 */
export function easingName(phase: TextAnimPhase, which: 'in' | 'out'): TextAnimEasing {
  if (phase.easing) return phase.easing;
  if (which === 'in' && phase.preset === 'pop') return 'back';
  return which === 'in' ? 'ease_out' : 'ease_in';
}

function bounceOut(p: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) return n1 * (p - 1.5 / d1) ** 2 + 0.75;
  if (p < 2.5 / d1) return n1 * (p - 2.25 / d1) ** 2 + 0.9375;
  return n1 * (p - 2.625 / d1) ** 2 + 0.984375;
}

/** 进度 0 → 1。settle = 入场的回弹 / 弹性 / 弹跳（在结尾）；出场的在开头。 */
export function ease(name: TextAnimEasing, p: number, settle: boolean, overshoot = BACK): number {
  switch (name) {
    case 'linear':
      return p;
    case 'ease_in':
      return p ** 3;
    case 'ease_out':
      return 1 - (1 - p) ** 3;
    case 'ease_in_out':
      return p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2;
    case 'back':
      return settle ? 1 + (overshoot + 1) * (p - 1) ** 3 + overshoot * (p - 1) ** 2 : (overshoot + 1) * p ** 3 - overshoot * p ** 2;
    case 'elastic': {
      const c = (2 * Math.PI) / 3;
      if (p >= 1) return 1;
      if (settle) return 2 ** (-10 * p) * Math.sin((10 * p - 0.75) * c) + 1;
      return p >= 0.000001 ? -(2 ** (10 * p - 10)) * Math.sin((10 * p - 10.75) * c) : 0;
    }
    case 'bounce':
      return settle ? bounceOut(p) : 1 - bounceOut(1 - p);
  }
}

/** 时段长 window 里入场延迟实际用的时长。 */
export function enterDelay(anim: TextAnimation, window: number): number {
  return Math.min(anim.in?.delay ?? 0, Math.max(0, window));
}

/** 时段长 window 里入场 / 出场实际用的时长。 */
export function phaseLengths(anim: TextAnimation, window: number): [number, number] {
  const L = Math.max(0, window);
  const dl = enterDelay(anim, L);
  const di = anim.in ? Math.min(anim.in.duration ?? DEFAULT_PHASE_DURATION, L - dl) : 0;
  const d = anim.out ? Math.min(anim.out.duration ?? DEFAULT_PHASE_DURATION, Math.max(0, L - dl - di)) : 0;
  return [di, d];
}

function moveBy(f: AnimFrame, preset: TextAnimMovePreset, amount: number) {
  if (preset === 'slide_up') f.dy += amount;
  else if (preset === 'slide_down') f.dy -= amount;
  else if (preset === 'slide_left') f.dx += amount;
  else if (preset === 'slide_right') f.dx -= amount;
}

/** 时段内本地时间 u（秒）这一刻的动画状态（不含逐字显现）。 */
export function sampleAnimation(anim: TextAnimation | null | undefined, u: number, window: number): AnimFrame {
  if (!anim || !(anim.in || anim.out || anim.loop) || window <= 0) return { ...REST };
  const L = window;
  const dl = enterDelay(anim, L);
  const [di, d] = phaseLengths(anim, L);
  const f: AnimFrame = { ...REST };

  if (anim.in && di > 0) {
    const ph = anim.in;
    const p = clip((u - dl) / di, 0, 1);
    const name = easingName(ph, 'in');
    const e = ease(name, p, true, ph.overshoot ?? BACK);
    if (ph.preset === 'pop') {
      f.opacity *= clip(3 * p, 0, 1);
      const from = ph.scale ?? POP_FROM;
      f.scale *= from + (1 - from) * e;
    } else {
      if (ph.preset === 'fade' || ph.fade !== false) f.opacity *= MONOTONE.includes(name) ? e : clip(e, 0, 1);
      moveBy(f, ph.preset, (ph.distance ?? SLIDE) * (1 - e));
    }
  }

  if (anim.out && d > 0) {
    const ph = anim.out;
    const q = clip((u - (L - d)) / d, 0, 1);
    const name = easingName(ph, 'out');
    const e = ease(name, q, false, ph.overshoot ?? BACK);
    if (ph.preset === 'fade' || ph.preset === 'pop' || ph.fade !== false) f.opacity *= MONOTONE.includes(name) ? 1 - e : clip(1 - e, 0, 1);
    if (ph.preset === 'pop') f.scale *= 1 - (1 - (ph.scale ?? POP_FROM)) * e;
    else moveBy(f, ph.preset, -(ph.distance ?? SLIDE) * e);
  }

  const start = dl + di;
  if (anim.loop && L - start > 0 && u >= start && u <= L) {
    const w = (2 * Math.PI * (u - start)) / (anim.loop.period ?? DEFAULT_LOOP_PERIOD);
    const k = anim.loop.amount ?? 1;
    switch (anim.loop.preset) {
      case 'breathe':
        f.scale *= 1 + BREATHE * k * (1 - Math.cos(w));
        break;
      case 'float':
        f.dy -= FLOAT * k * Math.sin(w);
        break;
      case 'blink':
        f.opacity *= clip(1 - BLINK * k * (1 - Math.cos(w)), 0, 1);
        break;
    }
  }
  return f;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function contractPhase(ph: TextAnimPhase, duration: number, which: 'in' | 'out', delay: number): TextAnimPhase {
  const out: TextAnimPhase = { preset: ph.preset, duration };
  if (ph.easing && ph.easing !== easingName({ preset: ph.preset }, which)) out.easing = ph.easing;
  if (isSlide(ph.preset)) {
    if (ph.distance !== undefined && Math.abs(ph.distance - SLIDE) > 1e-9) out.distance = Math.round(ph.distance * 1000) / 1000;
    if (ph.fade === false) out.fade = false;
  }
  if (ph.preset === 'pop' && ph.scale !== undefined && Math.abs(ph.scale - POP_FROM) > 1e-9) out.scale = round2(ph.scale);
  if (easingName(ph, which) === 'back' && ph.overshoot !== undefined && Math.abs(ph.overshoot - BACK) > 1e-9) out.overshoot = round2(ph.overshoot);
  if (which === 'in' && delay > 0) out.delay = delay;
  return out;
}

/**
 * 发给后端的 animation：空的不发；时长 / 周期补齐缺省并取两位小数，高级项等于契约缺省时不发（保持老 spec 形状）。
 * 时段是区间（window 非 null）时按 phaseLengths 把入场延迟 + 入场 + 出场压进时段——契约要求三者之和不超过时段长，
 * 用户事后把时段拖短也不会让保存失败；压过的时长和成片 / 预览实际用的一致。
 */
export function contractAnimation(anim: TextAnimation | null | undefined, window: number | null): TextAnimation | undefined {
  if (!hasAnimation(anim)) return undefined;
  const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
  const [di, d] = window === null ? [anim.in?.duration ?? DEFAULT_PHASE_DURATION, anim.out?.duration ?? DEFAULT_PHASE_DURATION] : phaseLengths(anim, window);
  let delay = floor2(window === null ? anim.in?.delay ?? 0 : enterDelay(anim, window));
  const out: TextAnimation = {};
  if (anim.in) {
    const inDur = Math.max(0.01, floor2(di));
    if (window !== null && delay + inDur > window) delay = Math.max(0, floor2(window - inDur));
    out.in = contractPhase(anim.in, inDur, 'in', delay);
  }
  if (anim.out) out.out = contractPhase(anim.out, Math.max(0.01, floor2(d)), 'out', 0);
  if (anim.loop) {
    out.loop = { preset: anim.loop.preset, period: round2(anim.loop.period ?? DEFAULT_LOOP_PERIOD) };
    if (anim.loop.amount !== undefined && Math.abs(anim.loop.amount - 1) > 1e-9) out.loop.amount = round2(anim.loop.amount);
  }
  if (anim.reveal) {
    const r = anim.reveal;
    out.reveal = { preset: r.preset, duration: Math.max(0.01, round2(r.duration ?? DEFAULT_REVEAL_DURATION)) };
    if (r.unit === 'word') out.reveal.unit = 'word';
    if (r.cursor && r.preset === 'typewriter') out.reveal.cursor = true;
    if (r.easing && r.easing !== 'linear') out.reveal.easing = r.easing;
  }
  if (window !== null && out.in && out.out && (out.in.delay ?? 0) + (out.in.duration ?? 0) + (out.out.duration ?? 0) > window) {
    // 都被压到 0.01 的极端情况（时段本身不到 0.02 秒）：出场让给入场
    delete out.out;
  }
  return out;
}

/**
 * 在这一栏换预设：时长、曲线、延迟、淡入淡出沿用；距离 / 倍数只在同类预设之间沿用，
 * 换成滑动类时用 NEW_PRESET_DEFAULTS 的新幅度。
 */
export function switchPreset(prev: TextAnimPhase | undefined, preset: TextAnimMovePreset): TextAnimPhase {
  const next: TextAnimPhase = { preset, duration: prev?.duration ?? DEFAULT_PHASE_DURATION };
  if (prev?.easing) next.easing = prev.easing;
  if (prev?.delay) next.delay = prev.delay;
  if (prev?.overshoot !== undefined) next.overshoot = prev.overshoot;
  if (isSlide(preset)) {
    next.distance = prev && isSlide(prev.preset) && prev.distance !== undefined ? prev.distance : NEW_PRESET_DEFAULTS[preset]?.distance;
    if (prev?.fade === false) next.fade = false;
  }
  if (preset === 'pop' && prev?.preset === 'pop' && prev.scale !== undefined) next.scale = prev.scale;
  if (next.distance === undefined) delete next.distance;
  return next;
}

/** 曲线缩略图用的采样点（x = 进度，y = 曲线值），入场口径。 */
export function easingPoints(name: TextAnimEasing, settle: boolean, n = 32): [number, number][] {
  return Array.from({ length: n + 1 }, (_, i) => [i / n, ease(name, i / n, settle)]);
}

export type AnimTab = 'in' | 'out' | 'loop' | 'reveal';

/** 分组收起时的摘要，如「入场 弹入 · 循环 呼吸」；没有动画时「无」。 */
export function animationSummary(anim: TextAnimation | null | undefined): string {
  if (!hasAnimation(anim)) return '无';
  const parts: string[] = [];
  const move = (v: TextAnimMovePreset, out: boolean) => (out && OUT_LABEL[v]) || MOVE_PRESETS.find((p) => p.v === v)?.label || v;
  if (anim.in) parts.push(`入场 ${move(anim.in.preset, false)}`);
  if (anim.out) parts.push(`出场 ${move(anim.out.preset, true)}`);
  if (anim.loop) parts.push(`循环 ${LOOP_PRESETS.find((p) => p.v === anim.loop!.preset)?.label ?? anim.loop.preset}`);
  if (anim.reveal) parts.push(`逐字 ${REVEAL_PRESETS.find((p) => p.v === anim.reveal!.preset)?.label ?? anim.reveal.preset}`);
  return parts.join(' · ');
}

/**
 * 「试播」这一栏要放的剪后区间 [from, to]：入场 / 逐字从时段开头放到结束后一点（含入场延迟）；出场从出场开始前一点放到时段结束；
 * 循环从入场结束放两个周期（不超过时段）。window = 图层时段 [a, b]（已按剪后时长裁过）。
 */
export function previewSpan(anim: TextAnimation, tab: AnimTab, window: [number, number]): [number, number] {
  const [a, b] = window;
  const dl = enterDelay(anim, b - a);
  const [di, d] = phaseLengths(anim, b - a);
  const lead = 0.3;
  if (tab === 'in') return [a, Math.min(b, a + dl + di + lead)];
  if (tab === 'reveal') return [a, Math.min(b, a + dl + (anim.reveal?.duration ?? DEFAULT_REVEAL_DURATION) + lead)];
  if (tab === 'out') return [Math.max(a, b - d - lead), b];
  const period = anim.loop?.period ?? DEFAULT_LOOP_PERIOD;
  return [a + dl + di, Math.min(b, a + dl + di + 2 * period)];
}

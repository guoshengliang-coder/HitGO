// 大字报（HIG-50，契约 §2 layers[type=text].scroll / trim.duration）：滚动几何、成片时长、重点上色、新图层 / 音轨的缺省——不碰 DOM 的纯函数。
//
// 几何全部用「相对画布高」的比例：同一组数字既描述任意画幅的成片，也描述编辑器预览；后端 services/scroll.py
// 是同一套公式（乘画布高写进 ffmpeg 的 crop 表达式），两端共用 fixtures/scrollCases.json 做 golden。
// 模型：PNG（高 pngH）放进一张上下各留 box.h 透明边的高图里，一个高 box.h 的窗口沿高图向下滑，
// 窗口顶边 y 从 y0 走到 y1——观众看到的就是文案从框里向上滚过。

import { TRACK_DEFAULTS } from './audioTracks';
import { normalizeSpans } from './textSpans';
import type { Asset, AudioTrack, EditSpec, HighlightPhrase, ScrollBox, ScrollCue, TextLayer, TextScroll, TextSpan, TextStyle, TtsSegment } from '../types';

/** 通用竖版安全区：避开顶部状态栏和底部的文案 / 操作条（契约 §2 scroll.box 缺省）。 */
export const DEFAULT_SCROLL_BOX: ScrollBox = { x: 0.06, y: 0.14, w: 0.88, h: 0.6 };

export type ResolvedTextScroll = Required<Omit<TextScroll, 'cues'>> & { cues?: ScrollCue[] };
export const DEFAULT_SCROLL: ResolvedTextScroll = { speed: 0.08, box: DEFAULT_SCROLL_BOX, start: 'enter', end: 'exit', hold_start: 0, hold_end: 0 };

/** 滚动速度（画布高 / 秒）的可调范围：契约 (0, 2]，下限留个能看见在动的值。 */
export const SCROLL_SPEED_MIN = 0.01;
export const SCROLL_SPEED_MAX = 2;

/** 把契约里的可选字段补齐成缺省值。 */
export function resolveScroll(s?: TextScroll | null): ResolvedTextScroll {
  return {
    speed: s?.speed && s.speed > 0 ? s.speed : DEFAULT_SCROLL.speed,
    box: s?.box ?? DEFAULT_SCROLL_BOX,
    start: s?.start ?? DEFAULT_SCROLL.start,
    end: s?.end ?? DEFAULT_SCROLL.end,
    hold_start: Math.max(0, s?.hold_start ?? 0),
    hold_end: Math.max(0, s?.hold_end ?? 0),
    ...(s?.cues?.length ? { cues: s.cues } : {}),
  };
}

// ---- 滚动曲线（与后端 scroll.py 逐行对应）----

/** 裁切窗口的起止位置（相对画布高）与速度、首尾停留（秒）。 */
export type ScrollPath = { y0: number; y1: number; speed: number; holdStart: number; holdEnd: number; cues?: ScrollCue[] };

/** pngH = PNG 按 width 缩放后的高，相对画布高。 */
export function scrollPath(scroll: TextScroll, pngH: number): ScrollPath {
  const s = resolveScroll(scroll);
  const bh = s.box.h;
  const y0 = s.start === 'enter' ? 0 : bh;
  const y1 = s.end === 'exit' ? pngH + bh : Math.max(y0, pngH);
  // 停留只在那一端文案确实在框里时才有意义
  return { y0, y1, speed: s.speed, holdStart: s.start === 'visible' ? s.hold_start : 0, holdEnd: s.end === 'stay' ? s.hold_end : 0, cues: s.cues };
}

/** 窗口要走的距离（相对画布高）。 */
export function scrollTravel(p: ScrollPath): number {
  return Math.max(0, p.y1 - p.y0);
}

/** 全程时长（秒）：开头停留 + 滚动 + 结尾停留。 */
export function scrollDuration(p: ScrollPath): number {
  if (p.cues?.length) return p.cues[p.cues.length - 1].at;
  return p.holdStart + scrollTravel(p) / p.speed + p.holdEnd;
}

/** 图层时段内本地时刻 u（秒）的窗口顶边位置（相对画布高）。 */
export function sampleScrollY(p: ScrollPath, u: number): number {
  if (p.cues?.length) {
    const cues = p.cues;
    let progress = u <= cues[0].at ? cues[0].progress : cues[cues.length - 1].progress;
    for (let i = 1; i < cues.length && u > cues[0].at; i++) {
      if (u <= cues[i].at) {
        const before = cues[i - 1];
        progress = before.progress + (cues[i].progress - before.progress) * (u - before.at) / (cues[i].at - before.at);
        break;
      }
    }
    return p.y0 + scrollTravel(p) * Math.max(0, Math.min(1, progress));
  }
  const y = p.y0 + (u - p.holdStart) * p.speed;
  return Math.min(Math.max(y, p.y0), p.y1);
}

/** TTS clause clock → monotonic poster progress clock; speed scales measured audio time. */
export function scrollCuesForSegments(segments: TtsSegment[] | null | undefined, speed = 1): ScrollCue[] | undefined {
  const valid = (segments ?? []).filter((s) => s.text.length > 0 && s.end > s.start);
  const chars = valid.reduce((sum, s) => sum + [...s.text].length, 0);
  if (!valid.length || chars <= 0) return undefined;
  let seen = 0;
  const cues: ScrollCue[] = [{ at: 0, progress: 0 }];
  for (const segment of valid) {
    seen += [...segment.text].length;
    cues.push({ at: Math.round((segment.end / Math.max(0.01, speed)) * 1000) / 1000, progress: seen / chars });
  }
  cues[cues.length - 1].progress = 1;
  return cues;
}

// ---- 图层 → 几何 ----

/** 与后端一致：PNG 宽 = width × 画布宽，超过框宽时缩到框宽（契约 §2 scroll）。 */
function scrollLayerWidth(layer: TextLayer): number {
  const box = resolveScroll(layer.scroll).box;
  return Math.min(layer.width > 0 ? layer.width : box.w, box.w);
}

/** PNG 缩放后的高，相对画布高；还没烤出 PNG（没有 image_size）时 null。滚动图层只用基准 image_size，不看 variant_images。 */
export function layerPngHeight(layer: TextLayer, canvasW = 1080, canvasH = 1920): number | null {
  const size = layer.image_size;
  if (!size || !(size[0] > 0) || !(size[1] > 0)) return null;
  const wPx = scrollLayerWidth(layer) * canvasW;
  return (wPx * (size[1] / size[0])) / canvasH;
}

/** 滚动全程时长（秒）；不是滚动图层或还没烤 PNG 时 null。 */
export function scrollLayerDuration(layer: TextLayer): number | null {
  if (!layer.scroll) return null;
  const h = layerPngHeight(layer);
  if (h === null) return null;
  return scrollDuration(scrollPath(layer.scroll, h));
}

export function clampScrollSpeed(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SCROLL.speed;
  return Math.max(SCROLL_SPEED_MIN, Math.min(SCROLL_SPEED_MAX, v));
}

/**
 * 让滚动全程正好 seconds 秒的速度（例如对齐朗读时长）：扣掉首尾停留，距离 / 剩余时间，夹在可调范围内。
 * 没有距离可走（文案比框矮且 visible + stay）或还没烤 PNG 时返回当前速度。
 */
export function fitScrollSpeed(layer: TextLayer, seconds: number): number {
  const s = resolveScroll(layer.scroll);
  const h = layerPngHeight(layer);
  if (h === null) return s.speed;
  const p = scrollPath(s, h);
  const travel = scrollTravel(p);
  if (!(travel > 0)) return s.speed;
  const remaining = seconds - p.holdStart - p.holdEnd;
  if (!(remaining > 0)) return SCROLL_SPEED_MAX;
  return clampScrollSpeed(travel / remaining);
}

// ---- 成片时长 ----

const ceil1 = (n: number) => Math.ceil(n * 10 - 1e-6) / 10;

/**
 * 大字报成片应有的正片时长（秒，向上取到 0.1）：滚动图层的「时段起点 + 滚动全程」与朗读轨（role = voice）
 * 的「时段起点 + 素材时长 − offset」取最大；两者都没有时 null。时段起点按剪后时间轴，t = 'all' 视为 0 起。
 * 隐藏的图层 / 音轨不算。assets 用来查朗读素材的时长（还没 ready 的没有时长，不算）。
 */
export function posterDuration(spec: EditSpec, assets: Asset[]): number | null {
  let best: number | null = null;
  const consider = (v: number) => {
    if (!Number.isFinite(v) || v <= 0) return;
    best = best === null ? v : Math.max(best, v);
  };
  const startOf = (t: AudioTrack['t']) => (t === 'all' ? 0 : Math.max(0, t[0]));
  for (const l of spec.layers) {
    if (l.type !== 'text' || !l.scroll || l.hidden) continue;
    const d = scrollLayerDuration(l);
    if (d !== null) consider(startOf(l.t) + d);
  }
  for (const t of spec.audio?.tracks ?? []) {
    if (t.role !== 'voice' || t.hidden) continue;
    const asset = assets.find((a) => a.id === t.asset_id);
    const media = asset?.duration;
    if (!(typeof media === 'number' && media > 0)) continue;
    consider(startOf(t.t) + media - (t.offset ?? TRACK_DEFAULTS.offset));
  }
  return best === null ? null : ceil1(best);
}

// ---- 重点上色 ----

/** 参考成片里的四种高亮色：黄 / 绿 / 红 / 蓝，按词组顺序轮流用。 */
export const HIGHLIGHT_PALETTE = ['#FFE14D', '#7CFC7C', '#FF7A7A', '#7AD7FF'];

/**
 * 把 POST /api/highlight 挑出的词组变成上色区间：按顺序轮流取色，并入已有的 spans（重叠处新的优先），
 * 结果升序、互不重叠。textLength 用来裁掉越界区间（缺省不裁）。
 */
export function highlightSpans(phrases: HighlightPhrase[], existing: TextSpan[] | null | undefined, textLength = Number.MAX_SAFE_INTEGER): TextSpan[] {
  const fresh = phrases.map((p, i) => ({ start: p.start, end: p.end, color: HIGHLIGHT_PALETTE[i % HIGHLIGHT_PALETTE.length] }));
  // normalizeSpans 遇到重叠时后来的优先：把已有的排前面，新的排后面
  return normalizeSpans([...(existing ?? []), ...fresh], textLength);
}

// ---- 新图层 / 音轨 ----

/**
 * 大字报的滚动文案图层：顶部居中、无边距（worker 忽略 anchor / margin，仍需合法），宽 = 框宽并按框宽自动折行，
 * 全程显示，滚动参数取缺省 + 指定的框。
 */
export function newPosterLayer(id: string, text: string, box: ScrollBox, style: TextStyle): TextLayer {
  return {
    id,
    type: 'text',
    text,
    style: { ...style, align: 'center', wrap_width: box.w },
    anchor: 'top-center',
    margin: [0, 0],
    width: box.w,
    width_manual: true,
    rotate: 0,
    opacity: 1,
    t: 'all',
    scroll: { ...DEFAULT_SCROLL, box },
  };
}

/** 朗读轨：口播角色、从 0 起播到素材结束、原音量、不循环。 */
export function voiceTrack(id: string, assetId: string, duration: number): AudioTrack {
  return { id, asset_id: assetId, role: 'voice', align: 'post', t: [0, Math.max(0, duration)], offset: 0, volume: 1, loop: false };
}

// ---- 摘要 ----

/** 与 posterDuration 同一种取整（向上到 0.1），摘要里的数和实际写进 trim.duration 的一致。 */
const fmt = (s: number) => `${ceil1(s).toFixed(1)} s`;

/** 面板里的一行摘要：`滚动 9.8 s · 朗读 12.3 s → 成片 12.3 s`；还没烤 PNG 时滚动那段写「待渲染」。 */
export function scrollSummary(layer: TextLayer, voiceSeconds: number | null): string {
  const scroll = scrollLayerDuration(layer);
  const parts: string[] = [];
  parts.push(scroll === null ? '滚动 待渲染' : `滚动 ${fmt(scroll)}`);
  if (voiceSeconds !== null && voiceSeconds > 0) parts.push(`朗读 ${fmt(voiceSeconds)}`);
  const total = Math.max(scroll ?? 0, voiceSeconds ?? 0);
  return `${parts.join(' · ')} → 成片 ${total > 0 ? fmt(total) : '—'}`;
}

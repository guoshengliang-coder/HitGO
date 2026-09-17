// 逐字显现（HIG-45，契约 §2 animation.reveal / glyph_layout）：打字机、逐字渐显、逐字擦除。
// 文字仍是一整张 PNG；烤图时记下每个「单位」（字形，或按词时的一个词）在 PNG 里的位置（glyph_layout），
// 成片按时间给 PNG 的透明度乘一张遮罩。遮罩与成片端 backend/app/services/reveal.py 同一套定义，
// 两端对照 fixtures/textRevealCases.json。
//
// 每个单位占一个「格子」：所在行的带（上下相邻行之间取中点）里，左右相邻单位之间取中点，
// 这样两个字之间的发光 / 阴影跟着字一起出现。
// 时间：显现与入场同起点 s = 入场延迟；D = min(duration, L − s)。
//   打字机 t_k = s + D·inv(k/(N−1))，到点整字出现；
//   逐字渐显 F = min(0.3, D/2)，t_k = s + (D − F)·inv(k/(N−1))，从 t_k 起 F 秒淡入；
//   逐字擦除 t_k = s + D·inv(k/N)，[t_k, t_{k+1}] 内边缘扫过该字的墨迹（rtl 行从右往左），软边 0.01 PNG 宽。
// inv 是曲线（linear / ease_in / ease_out / ease_in_out）的反函数，N 为单位数。

import type { GlyphLayout, TextReveal, TextRevealEasing } from '../types';
import { DEFAULT_REVEAL_DURATION } from './textAnimation';

export const FADE_SECONDS = 0.3;
export const WIPE_FEATHER = 0.01;
export const CURSOR_TAIL = 1;
export const MAX_UNITS = 1000;

export function inverseEase(name: TextRevealEasing | undefined, y: number): number {
  const v = Math.min(Math.max(y, 0), 1);
  const cbrt = (x: number) => Math.cbrt(Math.max(0, x));
  if (name === 'ease_in') return cbrt(v);
  if (name === 'ease_out') return 1 - cbrt(1 - v);
  if (name === 'ease_in_out') return v < 0.5 ? cbrt(v / 4) : 1 - cbrt(2 * (1 - v)) / 2;
  return v;
}

export const fadeSeconds = (duration: number) => Math.min(FADE_SECONDS, duration / 2);

export interface RevealTiming {
  start: number;
  duration: number;
  end: number;
  /** t_k；擦除多一个 t_N = end。 */
  times: number[];
}

export function revealTiming(reveal: TextReveal, count: number, window: number, delay: number): RevealTiming | null {
  const start = Math.min(Math.max(delay, 0), window);
  const duration = Math.min(reveal.duration ?? DEFAULT_REVEAL_DURATION, window - start);
  if (!(duration > 0) || count <= 0) return null;
  const inv = (y: number) => inverseEase(reveal.easing, y);
  let times: number[];
  if (reveal.preset === 'wipe') {
    times = Array.from({ length: count + 1 }, (_, k) => start + duration * inv(k / count));
  } else {
    const span = duration - (reveal.preset === 'fade_chars' ? fadeSeconds(duration) : 0);
    times = Array.from({ length: count }, (_, k) => start + span * (count > 1 ? inv(k / (count - 1)) : 0));
  }
  return { start, duration, end: start + duration, times };
}

export interface Cell {
  index: number;
  line: number;
  left: number;
  right: number;
  cellLeft: number;
  cellRight: number;
}

export const unitCount = (layout: GlyphLayout) => layout.lines.reduce((n, l) => n + l.units.length, 0);

/** 每行的单位按从左到右排好，带上格子。 */
export function layoutCells(layout: GlyphLayout): Cell[][] {
  let index = 0;
  return layout.lines.map((line, li) => {
    const row = line.units.map(([left, right]) => ({ k: index++, left, right }));
    row.sort((a, b) => a.left - b.left || a.right - b.right);
    return row.map((r, i) => {
      const cellLeft = i === 0 ? 0 : (row[i - 1].right + r.left) / 2;
      const cr = i === row.length - 1 ? 1 : (r.right + row[i + 1].left) / 2;
      return { index: r.k, line: li, left: r.left, right: r.right, cellLeft, cellRight: Math.max(cellLeft, cr) };
    });
  });
}

/** 行与行之间的分界（y 比例）。 */
export function lineBands(layout: GlyphLayout): [number, number][] {
  const ls = layout.lines;
  return ls.map((_, i) => [i === 0 ? 0 : (ls[i - 1].bottom + ls[i].top) / 2, i === ls.length - 1 ? 1 : (ls[i].bottom + ls[i + 1].top) / 2]);
}

/** 单位 cell 在本地时间 u 的值；x 仅擦除用。 */
function leafAlpha(cell: Cell, reveal: TextReveal, t: RevealTiming, rtl: boolean, u: number, x: number): number {
  const tk = t.times[cell.index];
  if (reveal.preset === 'typewriter') return u >= tk ? 1 : 0;
  if (reveal.preset === 'fade_chars') return Math.min(Math.max((u - tk) / fadeSeconds(t.duration), 0), 1);
  const t1 = t.times[cell.index + 1];
  if (u >= t1) return 1;
  if (u < tk) return 0;
  const s0 = Math.max(cell.cellLeft, cell.left);
  const s1 = Math.max(s0, Math.min(cell.cellRight, cell.right));
  const span = s1 - s0 + WIPE_FEATHER;
  const prog = Math.min(Math.max((u - tk) / Math.max(t1 - tk, 1e-6), 0), 1);
  const v = rtl ? (x - (s1 - span * prog)) / WIPE_FEATHER : (s0 + span * prog - x) / WIPE_FEATHER;
  return Math.min(Math.max(v, 0), 1);
}

/** PNG 内一点 (x, y)（比例）在本地时间 u 的透明度倍数；查找方式与后端表达式的平衡二叉树一致。 */
export function revealAlpha(layout: GlyphLayout, reveal: TextReveal, window: number, delay: number, u: number, x: number, y: number): number {
  const t = revealTiming(reveal, unitCount(layout), window, delay);
  if (!t || u >= t.end) return 1;
  const rows = layoutCells(layout);
  const ls = layout.lines;
  const li = searchBalanced(ls.slice(0, -1).map((_, i) => (ls[i].bottom + ls[i + 1].top) / 2), y);
  const cells = rows[li];
  const ci = searchBalanced(cells.slice(0, -1).map((c) => c.cellRight), x);
  return leafAlpha(cells[ci], reveal, t, !!ls[li].rtl, u, x);
}

/**
 * 与后端 _search 完全一致的平衡树查找：items 从中间一分为二，v < splits[mid − 1] 走左半。
 * 分界单调时等价于普通二分；分界不单调（字位置重叠）时两端仍给出同一个段。
 */
export function searchBalanced(splits: number[], v: number): number {
  const walk = (lo: number, n: number): number => {
    if (n === 1) return lo;
    const mid = Math.floor(n / 2);
    return v < splits[lo + mid - 1] ? walk(lo, mid) : walk(lo + mid, n - mid);
  };
  return walk(0, splits.length + 1);
}

export interface CursorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 打字机光标（w × h 为该 PNG 的像素尺寸）：最新出现的单位之后一条竖线（第一个字出现前在它前面），
 * 打字时常亮，打完后闪烁 CURSOR_TAIL 秒（每秒一次）。不显示时返回 null。
 */
export function cursorRect(layout: GlyphLayout, reveal: TextReveal, window: number, delay: number, u: number, w: number, h: number): CursorRect | null {
  if (reveal.preset !== 'typewriter' || !reveal.cursor) return null;
  const n = unitCount(layout);
  const t = revealTiming(reveal, n, window, delay);
  if (!t) return null;
  const tail = Math.min(window, t.end + CURSOR_TAIL);
  const on = (u >= t.start && u <= t.end) || (u >= t.end && u <= tail && ((u - t.end) % 1) < 0.5);
  if (!on) return null;
  const line0 = layout.lines[0];
  const linePx = (line0.bottom - line0.top) * h;
  const cw = Math.max(2, Math.round(linePx * 0.06));
  const ch = Math.max(2, Math.round(linePx * 0.8));
  const gap = cw * 0.6;
  const byIndex = new Map(layoutCells(layout).flat().map((c) => [c.index, c]));
  // spots[i]：u < times[i] 时有效；spots[0] 在第一个字之前，spots[k + 1] 在第 k 个字之后
  const i = searchBalanced(t.times.slice(0, n), u);
  const k = i === 0 ? 0 : i - 1;
  const after = i > 0;
  const c = byIndex.get(k)!;
  const line = layout.lines[c.line];
  const rtl = !!line.rtl;
  const edgeRight = (after && !rtl) || (!after && rtl);
  const x = edgeRight ? c.right * w + gap : c.left * w - gap - cw;
  const top = line.top * h + ((line.bottom - line.top) * h - ch) / 2;
  const clampRound = (v: number, hi: number) => Math.min(Math.max(0, pyRound(v)), Math.max(0, hi));
  return { x: clampRound(x, w - cw), y: clampRound(top, h - ch), w: cw, h: ch };
}

/** Python round()（银行家舍入），与后端像素位置一致。 */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (Math.abs(diff - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}

// ---- 生成 glyph_layout ----

/** 烤图时量到的一行：像素坐标；glyphs 是按书写顺序的字形（Intl.Segmenter 字形切分，emoji 不拆）。 */
export interface MeasuredLine {
  top: number;
  bottom: number;
  rtl: boolean;
  glyphs: { text: string; left: number; right: number }[];
}

const RTL_CHARS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
const LTR_LETTERS = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

/** 一行是否按从右到左显现：含 RTL 字符且没有 LTR 字母（混排按 LTR 处理）。 */
export function isRtlLine(text: string): boolean {
  return RTL_CHARS.test(text) && !LTR_LETTERS.test(text);
}

export function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (!Seg) return Array.from(text);
  return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
}

/** 把一行字形按词分组：词（isWordLike）开新组，空白 / 标点并进前一个词（行首的并进后一个）。返回每组的字形下标。 */
export function wordGroups(glyphTexts: string[]): number[][] {
  const text = glyphTexts.join('');
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> } }).Segmenter;
  const starts: number[] = [];
  let off = 0;
  for (const g of glyphTexts) {
    starts.push(off);
    off += g.length;
  }
  const segs = Seg ? Array.from(new Seg(undefined, { granularity: 'word' }).segment(text)) : text.split(/(\s+)/).reduce<{ segment: string; index: number; isWordLike: boolean }[]>((acc, part) => {
    const index = acc.length ? acc[acc.length - 1].index + acc[acc.length - 1].segment.length : 0;
    if (part) acc.push({ segment: part, index, isWordLike: /\S/.test(part) });
    return acc;
  }, []);
  const groups: number[][] = [];
  let pending: number[] = [];
  let gi = 0;
  for (const s of segs) {
    const end = s.index + s.segment.length;
    const members: number[] = [];
    while (gi < glyphTexts.length && starts[gi] < end) members.push(gi++);
    if (!members.length) continue;
    if (s.isWordLike) {
      groups.push([...pending, ...members]);
      pending = [];
    } else if (groups.length) {
      groups[groups.length - 1].push(...members);
    } else {
      pending.push(...members);
    }
  }
  if (pending.length) groups.push(pending);
  return groups;
}

/** 量到的行 → glyph_layout（PNG 宽高比例，4 位小数）。空行去掉；单位总数超过上限时相邻两两合并。 */
export function buildGlyphLayout(lines: MeasuredLine[], width: number, height: number, unit: 'char' | 'word' = 'char'): GlyphLayout | null {
  const r4 = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 10000) / 10000;
  let out = lines
    .map((line) => {
      const groups = unit === 'word' ? wordGroups(line.glyphs.map((g) => g.text)) : line.glyphs.map((_, i) => [i]);
      const units = groups
        .map((idx) => {
          const gs = idx.map((i) => line.glyphs[i]);
          return [Math.min(...gs.map((g) => g.left)), Math.max(...gs.map((g) => g.right))] as [number, number];
        })
        .map(([l, r]) => [r4(l / width), r4(r / width)] as [number, number]);
      return { top: r4(line.top / height), bottom: r4(line.bottom / height), rtl: line.rtl, units };
    })
    .filter((l) => l.units.length && l.bottom > l.top);
  if (!out.length) return null;
  while (out.reduce((n, l) => n + l.units.length, 0) > MAX_UNITS) {
    out = out.map((l) => ({ ...l, units: l.units.reduce<[number, number][]>((acc, u, i) => (i % 2 ? (acc[acc.length - 1] = [Math.min(acc[acc.length - 1][0], u[0]), Math.max(acc[acc.length - 1][1], u[1])], acc) : [...acc, u]), []) }));
  }
  return { lines: out.map((l) => (l.rtl ? l : { top: l.top, bottom: l.bottom, units: l.units })) };
}

// ---- 预览绘制 ----

/**
 * 把文字 PNG 按遮罩画到 target 上（target 与 PNG 同尺寸）：先画完整的背景块（若有），再逐格画字，最后画光标。
 * 擦除的软边在预览里不画渐变，只按边缘位置裁剪；成片端是 0.01 PNG 宽的软边。
 */
export function paintReveal(
  ctx: CanvasRenderingContext2D,
  text: CanvasImageSource,
  background: CanvasImageSource | null,
  layout: GlyphLayout,
  reveal: TextReveal,
  window: number,
  delay: number,
  u: number,
  w: number,
  h: number,
  cursorColor: string,
) {
  ctx.clearRect(0, 0, w, h);
  const t = revealTiming(reveal, unitCount(layout), window, delay);
  if (background) ctx.drawImage(background, 0, 0, w, h);
  if (!t || u >= t.end) {
    ctx.drawImage(text, 0, 0, w, h);
  } else {
    const bands = lineBands(layout);
    layoutCells(layout).forEach((cells, li) => {
      const [y0, y1] = bands[li];
      const rtl = !!layout.lines[li].rtl;
      for (const c of cells) {
        let x0 = c.cellLeft;
        let x1 = c.cellRight;
        let alpha: number;
        if (reveal.preset === 'wipe') {
          const tk = t.times[c.index];
          const t1 = t.times[c.index + 1];
          if (u < tk) continue;
          if (u < t1) {
            const s0 = Math.max(c.cellLeft, c.left);
            const s1 = Math.max(s0, Math.min(c.cellRight, c.right));
            const prog = Math.min(Math.max((u - tk) / Math.max(t1 - tk, 1e-6), 0), 1);
            const span = s1 - s0 + WIPE_FEATHER;
            if (rtl) x0 = Math.max(x0, s1 - span * prog + WIPE_FEATHER / 2);
            else x1 = Math.min(x1, s0 + span * prog - WIPE_FEATHER / 2);
            if (x1 <= x0) continue;
          }
          alpha = 1;
        } else {
          alpha = leafAlpha(c, reveal, t, rtl, u, 0);
        }
        if (alpha <= 0) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.rect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
        ctx.clip();
        ctx.drawImage(text, 0, 0, w, h);
        ctx.restore();
      }
    });
  }
  const cur = cursorRect(layout, reveal, window, delay, u, Math.round(w), Math.round(h));
  if (cur) {
    ctx.fillStyle = cursorColor;
    ctx.fillRect(cur.x, cur.y, cur.w, cur.h);
  }
}

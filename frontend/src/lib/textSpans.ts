// 文字图层的局部上色（spans）与背景块宽度换算——不碰 canvas 的纯函数。
//
// spans 是 text 的 UTF-16 字符区间 [start, end)，每段一个填充色（契约 §2）；
// 与 textarea 的 selectionStart / selectionEnd 同一套索引，直接 slice 即可。
// 这里负责：区间规范化、对选区上色 / 清除、文本编辑后的区间平移、按行拆成绘制片段、
// 通栏背景的宽度换算。drawTextImage 只消费这里的结果。

import type { TextSpan } from '../types';

/** 一行里的一个绘制片段；color 缺省时用图层 style.color。 */
export interface TextRun {
  text: string;
  color?: string;
}

/** 裁到文本长度、丢弃空区间、按起点排序、切掉重叠（后者优先）、合并相邻同色。 */
export function normalizeSpans(spans: readonly TextSpan[] | null | undefined, textLength: number): TextSpan[] {
  const out: TextSpan[] = [];
  const sorted = (spans ?? [])
    .map((s) => ({ start: clamp(s.start, 0, textLength), end: clamp(s.end, 0, textLength), color: s.color }))
    .filter((s) => s.end > s.start && !!s.color)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) {
      prev.end = s.start;
      if (prev.end <= prev.start) out.pop();
    }
    const last = out[out.length - 1];
    if (last && last.end === s.start && last.color === s.color) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/** 给 [start, end) 上色（color 为 null 时清除该段颜色）；覆盖到的旧区间被切开。 */
export function setSpanColor(spans: readonly TextSpan[] | null | undefined, start: number, end: number, color: string | null, textLength: number): TextSpan[] {
  const a = clamp(Math.min(start, end), 0, textLength);
  const b = clamp(Math.max(start, end), 0, textLength);
  const base = normalizeSpans(spans, textLength);
  if (b <= a) return base;
  const out: TextSpan[] = [];
  for (const s of base) {
    if (s.end <= a || s.start >= b) {
      out.push(s);
      continue;
    }
    if (s.start < a) out.push({ start: s.start, end: a, color: s.color });
    if (s.end > b) out.push({ start: b, end: s.end, color: s.color });
  }
  if (color) out.push({ start: a, end: b, color });
  return normalizeSpans(out, textLength);
}

/**
 * 文本从 oldText 改成 newText 后平移区间：按公共前缀 / 后缀找出改动段，
 * 改动段之前的不动、之后的整体平移；完全包住改动段的区间随之伸缩（在上色文字中间打字仍保持颜色），
 * 只碰到一侧的区间被裁到改动段边界。
 */
export function adjustSpans(spans: readonly TextSpan[] | null | undefined, oldText: string, newText: string): TextSpan[] {
  const base = normalizeSpans(spans, oldText.length);
  if (oldText === newText || base.length === 0) return normalizeSpans(base, newText.length);
  const maxP = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < maxP && oldText.charCodeAt(p) === newText.charCodeAt(p)) p += 1;
  const maxS = maxP - p;
  let s = 0;
  while (s < maxS && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s += 1;
  const oldEnd = oldText.length - s;
  const delta = newText.length - oldText.length;

  const out: TextSpan[] = [];
  for (const sp of base) {
    if (sp.end <= p) out.push(sp);
    else if (sp.start >= oldEnd) out.push({ ...sp, start: sp.start + delta, end: sp.end + delta });
    else if (sp.start < p && sp.end > oldEnd) out.push({ ...sp, end: sp.end + delta });
    else {
      if (sp.start < p) out.push({ start: sp.start, end: p, color: sp.color });
      if (sp.end > oldEnd) out.push({ start: oldEnd + delta, end: sp.end + delta, color: sp.color });
    }
  }
  return normalizeSpans(out, newText.length);
}

/** 按 \n 分行，把全局区间映射到每行，产出片段序列；每行至少一个片段（空行为 { text: '' }）。 */
export function splitRuns(text: string, spans: readonly TextSpan[] | null | undefined): TextRun[][] {
  const norm = normalizeSpans(spans, text.length);
  const out: TextRun[][] = [];
  let offset = 0;
  let si = 0;
  for (const line of text.split('\n')) {
    const ls = offset;
    const le = offset + line.length;
    const runs: TextRun[] = [];
    let cursor = ls;
    while (si < norm.length && norm[si].end <= ls) si += 1;
    for (let j = si; j < norm.length && norm[j].start < le; j += 1) {
      const a = Math.max(norm[j].start, ls);
      const b = Math.min(norm[j].end, le);
      if (a > cursor) runs.push({ text: text.slice(cursor, a) });
      if (b > a) runs.push({ text: text.slice(a, b), color: norm[j].color });
      cursor = Math.max(cursor, b);
    }
    if (cursor < le) runs.push({ text: text.slice(cursor, le) });
    if (runs.length === 0) runs.push({ text: '' });
    out.push(runs);
    offset = le + 1;
  }
  return out;
}

/**
 * 背景块宽度：缺省紧贴文字（内容宽 + 内边距 + 描边），指定 backgroundWidth（相对画布宽）时
 * 拉到该宽度但不小于紧贴宽。alignW 是文字对齐用的内容区宽（块宽减去内边距与描边）。
 */
export function resolveBackgroundBox(o: { contentW: number; padPx: number; strokePx: number; backgroundWidth: number | null | undefined; canvasW: number }): { boxW: number; alignW: number } {
  const tight = Math.ceil(o.contentW + o.padPx * 2 + o.strokePx * 2);
  const boxW = o.backgroundWidth && o.backgroundWidth > 0 ? Math.max(tight, Math.round(o.backgroundWidth * o.canvasW)) : tight;
  return { boxW, alignW: boxW - o.padPx * 2 - o.strokePx * 2 };
}

/**
 * 自动换行（HIG-51）时的文字框：框宽固定为 wrapWidth × 画布宽（不小于背景块），背景块仍按 resolveBackgroundBox
 * 贴合文字（或拉到 background_width），并按对齐方式放在框里；没有 wrapWidth 时框就是背景块，与旧行为一致。
 * 返回框宽 outerW、背景块的左边 bgX 与宽 bgW、文字对齐用的内容区宽 alignW（相对背景块）。
 */
export function resolveTextBox(o: {
  contentW: number;
  padPx: number;
  strokePx: number;
  backgroundWidth: number | null | undefined;
  wrapWidth: number | null | undefined;
  canvasW: number;
  align: 'left' | 'center' | 'right';
}): { outerW: number; bgX: number; bgW: number; alignW: number } {
  const { boxW, alignW } = resolveBackgroundBox(o);
  const wrapPx = o.wrapWidth && o.wrapWidth > 0 ? Math.round(o.wrapWidth * o.canvasW) : 0;
  const outerW = Math.max(boxW, wrapPx);
  const slack = outerW - boxW;
  const bgX = o.align === 'center' ? Math.round(slack / 2) : o.align === 'right' ? slack : 0;
  return { outerW, bgX, bgW: boxW, alignW };
}

/**
 * 文字框四周需要预留的溢出边距（px）：阴影要 blur + |offset|，发光是无偏移的光晕，
 * 模糊半径按 1.5 倍留（多遍叠画后光晕拖尾比 shadowBlur 名义值更长），取两者较大值。
 */
export function resolveOverflowPad(o: { shadowBlurPx: number; shadowDx: number; shadowDy: number; glowBlurPx: number }): number {
  const shadowPad = o.shadowBlurPx > 0 || o.shadowDx !== 0 || o.shadowDy !== 0 ? Math.ceil(o.shadowBlurPx + Math.max(Math.abs(o.shadowDx), Math.abs(o.shadowDy))) : 0;
  const glowPad = o.glowBlurPx > 0 ? Math.ceil(o.glowBlurPx * 1.5) : 0;
  return Math.max(0, shadowPad, glowPad);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

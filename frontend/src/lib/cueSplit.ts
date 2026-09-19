// 译文字幕断句（HIG-36）：一条听写句子译出来常常长到一个字幕框装不下（契约 §6：韩语约为英文 2 倍），
// 整段同时显示会盖住半个画面。这里把它切成几段依次显示，并把该句的时段按字数摊给各段。
//
// 纯函数，不碰 DOM / store。标点规则从 lib/posterSplit 复用（同一套半角标点例外：3.5 / 10:30 / HitGO.com
// 不断句），词边界复用 lib/textWrap 的 wrapTokens（已经处理好标点不入行首、左括号不留行尾）。
// 切点按「句末标点 > 从句标点 > 词边界 > 字形」排优先级，靠罚分体现：远的强切点不会赢过近的弱切点。

import { isCloser, punctBreakAt } from './posterSplit';
import { wrapTokens } from './textWrap';

export type Range = [number, number];
export type BreakKind = 'newline' | 'sentence' | 'clause' | 'word';

/** 一个可切位置：在下标 `at` 之前切开，左段 = slice(0, at)。 */
export interface BreakPoint {
  at: number;
  kind: BreakKind;
}

/** 中日韩 / 泰文等不靠空格分词，一行放得下的字数少得多。 */
export const CJK_MAX_CHARS = 16;
export const LATIN_MAX_CHARS = 30;
/** 拆出来的每段至少显示这么久（秒），否则一闪而过来不及读。 */
export const MIN_CUE_SECONDS = 0.7;
/**
 * 只能在词 / 字形处下刀时，允许一段超出上限到这个倍数再切。
 * 在标点处切总是划算的；把「……面向投放素材」和「的视频后期工作台，」切开就不划算了——
 * 宁可让这一行长两三个字（自动换行会折成两行），也不要在词组中间断开。
 */
const OVERFLOW = 1.25;
/** 递归切分的深度上限，防止病态文本切不完。 */
const MAX_DEPTH = 8;

const KIND_RANK: Record<BreakKind, number> = { newline: 0, sentence: 0, clause: 1, word: 2 };
/**
 * 罚分（按字数计，乘以每段上限）：档次越低越吃亏。词边界的罚分要明显高于从句标点，否则
 * 中点恰好落在词缝上时会把「……工作台，」这样的自然停顿让给半个词组。
 */
const PENALTY: Record<BreakKind, number> = { newline: 0, sentence: 0, clause: 0.2, word: 0.8 };
/** 没有任何标点 / 词边界时按字形硬切的罚分。 */
const GRAPHEME_PENALTY = 1.6;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

const NO_SPACE_SCRIPT = /[぀-ヿ㐀-鿿豈-﫿가-힯฀-๿ក-៿຀-໿က-႟]/u;
const HAS_LETTER = /\p{L}/u;
const NO_SPACE_LANGS = new Set(['zh', 'yue', 'ja', 'ko', 'th']);

/** 可见字符数：空白不算。时间摊分和长度判断都用它，免得缩进 / 换行把权重算歪。 */
export function visibleLength(text: string, start = 0, end = text.length): number {
  let n = 0;
  for (let i = start; i < end; i += 1) if (!/\s/.test(text[i])) n += 1;
  return n;
}

/**
 * 每段字数上限：按文本里占多数的脚本判定，不按语言码——同一条韩语字幕里混英文品牌名时
 * 按比例判定更稳，也不用跟 `GET /localize/options` 的语言表同步。文本里没有字母类字符时才看 `lang`。
 */
export function cueCharLimit(text: string, lang?: string): number {
  let noSpace = 0;
  let letters = 0;
  const upto = Math.min(text.length, 200);
  for (let i = 0; i < upto; i += 1) {
    const ch = text[i];
    if (NO_SPACE_SCRIPT.test(ch)) noSpace += 1;
    if (HAS_LETTER.test(ch)) letters += 1;
  }
  if (!letters) return lang && NO_SPACE_LANGS.has(lang) ? CJK_MAX_CHARS : LATIN_MAX_CHARS;
  return noSpace / letters >= 0.3 ? CJK_MAX_CHARS : LATIN_MAX_CHARS;
}

function graphemeStarts(text: string): number[] {
  const Ctor = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ index: number }> } }).Segmenter;
  const out: number[] = [];
  if (Ctor) {
    for (const s of new Ctor(undefined, { granularity: 'grapheme' }).segment(text)) out.push(s.index);
    return out;
  }
  for (const m of text.matchAll(/[\s\S]/gu)) out.push(m.index ?? 0); // 没有 Intl.Segmenter 的退路
  return out;
}

/**
 * 所有可切位置，按下标升序、同一下标只留最强的一档。
 * 标点切点落在「标点 + 连续标点 + 收尾引号 / 括号」之后，所以「？！」「。」」不会被拆开。
 */
export function breakPoints(text: string): BreakPoint[] {
  const best = new Map<number, BreakKind>();
  const put = (at: number, kind: BreakKind) => {
    if (at <= 0 || at >= text.length) return;
    const had = best.get(at);
    if (had === undefined || KIND_RANK[kind] < KIND_RANK[had]) best.set(at, kind);
  };
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      put(i + 1, 'newline');
      continue;
    }
    const kind = punctBreakAt(text, i);
    if (!kind) continue;
    let j = i;
    while (j + 1 < text.length && (punctBreakAt(text, j + 1) !== null || isCloser(text[j + 1]))) j += 1;
    put(j + 1, kind);
  }
  for (const [a] of wrapTokens(text)) put(a, 'word');
  return [...best.entries()].map(([at, kind]) => ({ at, kind })).sort((x, y) => x.at - y.at);
}

interface Cut {
  at: number;
  kind: BreakKind | 'grapheme';
}

/** 在 (a, b) 内代价最小的切点：离 ideal 越近越好，档次越低罚分越重；字形硬切是最后的兜底。 */
function bestCut(text: string, points: BreakPoint[], a: number, b: number, ideal: number, unit: number): Cut | null {
  let best: Cut | null = null;
  let bestCost = Infinity;
  for (const p of points) {
    if (p.at <= a) continue;
    if (p.at >= b) break;
    const cost = Math.abs(p.at - ideal) + PENALTY[p.kind] * unit;
    if (cost < bestCost) {
      bestCost = cost;
      best = { at: p.at, kind: p.kind };
    }
  }
  for (const at of graphemeStarts(text)) {
    if (at <= a) continue;
    if (at >= b) break;
    const cost = Math.abs(at - ideal) + GRAPHEME_PENALTY * unit;
    if (cost < bestCost) {
      bestCost = cost;
      best = { at, kind: 'grapheme' };
    }
  }
  return best;
}

/** 在标点 / 换行处切总是划算；在词或字形处切要先看这一段超了多少。 */
const isNatural = (kind: Cut['kind']) => kind === 'newline' || kind === 'sentence' || kind === 'clause';

function trimRange(text: string, [a, b]: Range): Range | null {
  let s = a;
  let e = b;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return e > s ? [s, e] : null;
}

/**
 * 把一条译文切成若干段的下标区间（按原文下标，段间的空白 / 换行被丢掉）。
 * 整条不超上限时原样返回一段——译者或用户手写的两行排版不去动它。
 * 超限时对半递归：每次在中点附近挑代价最小的切点，所以段与段长度均衡，不会切出「30 字 + 2 字」的尾巴。
 */
export function splitCueRanges(text: string, opts?: { maxChars?: number; lang?: string }): Range[] {
  const whole = trimRange(text, [0, text.length]);
  if (!whole) return [];
  const max = Math.max(4, opts?.maxChars || cueCharLimit(text, opts?.lang));
  const points = breakPoints(text);
  const out: Range[] = [];

  const cut = (a: number, b: number, depth: number): void => {
    const seen = visibleLength(text, a, b);
    if (seen <= max || depth >= MAX_DEPTH) {
      out.push([a, b]);
      return;
    }
    const best = bestCut(text, points, a, b, (a + b) / 2, max);
    if (best === null || (!isNatural(best.kind) && seen <= max * OVERFLOW)) {
      out.push([a, b]);
      return;
    }
    cut(a, best.at, depth + 1);
    cut(best.at, b, depth + 1);
  };
  cut(whole[0], whole[1], 0);

  const trimmed = out.map((r) => trimRange(text, r)).filter((r): r is Range => r !== null);
  return mergeShort(text, trimmed, max);
}

/** 把过短的碎片并回相邻段（并完仍不超上限才并），避免出现「好的。」这种一闪而过的一行。 */
function mergeShort(text: string, ranges: Range[], max: number): Range[] {
  const out = ranges.map((r) => [...r] as Range);
  for (let k = 0; k < out.length; k += 1) {
    if (out.length < 2) break;
    if (visibleLength(text, out[k][0], out[k][1]) >= max * 0.35) continue;
    const prev = k > 0 ? visibleLength(text, out[k - 1][0], out[k][1]) : Infinity;
    const next = k + 1 < out.length ? visibleLength(text, out[k][0], out[k + 1][1]) : Infinity;
    if (Math.min(prev, next) > max * OVERFLOW) continue;  // 并起来就太长了，宁可留着这个短段
    if (prev <= next) {
      out[k - 1][1] = out[k][1];
      out.splice(k, 1);
      k -= 1;
    } else {
      out[k + 1][0] = out[k][0];
      out.splice(k, 1);
      k -= 1;
    }
  }
  return out;
}

/**
 * 把一个时段按权重摊成首尾相接的若干段：每段不短于 `minSeconds`（钉住之后其余按权重重分），
 * 整个时段短到摊不开时等分。末段的终点严格等于窗口终点，段与段严格相接。
 */
export function sliceWindow([a, b]: Range, weights: number[], minSeconds = MIN_CUE_SECONDS): Range[] {
  const n = weights.length;
  if (!n) return [];
  const total = b - a;
  if (total <= 0) return weights.map(() => [round3(a), round3(a)] as Range);
  if (n === 1) return [[round3(a), round3(b)]];
  if (total < n * minSeconds) {
    return weights.map((_, k) => [round3(a + (total * k) / n), round3(a + (total * (k + 1)) / n)] as Range);
  }
  const w = weights.map((x) => (x > 0 ? x : 0));
  const lengths = new Array<number>(n).fill(0);
  const pinned = new Array<boolean>(n).fill(false);
  for (let round = 0; round <= n; round += 1) {
    const freeTotal = total - lengths.reduce((s, x, k) => s + (pinned[k] ? x : 0), 0);
    const freeWeight = w.reduce((s, x, k) => s + (pinned[k] ? 0 : x), 0);
    let changed = false;
    for (let k = 0; k < n; k += 1) {
      if (pinned[k]) continue;
      lengths[k] = freeWeight > 0 ? (freeTotal * w[k]) / freeWeight : freeTotal / w.filter((_, j) => !pinned[j]).length;
      if (lengths[k] < minSeconds) {
        lengths[k] = minSeconds;
        pinned[k] = true;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const out: Range[] = [];
  let cursor = a;
  for (let k = 0; k < n; k += 1) {
    const end = k === n - 1 ? b : cursor + lengths[k];
    out.push([round3(cursor), round3(end)]);
    cursor = end;
  }
  return out;
}

/** 文本里到 `offset` 为止占全文的比例（只数可见字符）；给「按光标分时间」用。 */
export function charRatio(text: string, offset: number): number {
  const all = visibleLength(text);
  if (!all) return 0;
  const before = visibleLength(text, 0, Math.max(0, Math.min(offset, text.length)));
  return before / all;
}

/**
 * 把一个 0–1 的位置吸附到最近的可切下标（标点 > 词边界 > 字形）；切不动时返回 null。
 * 时间轴上按播放头拆分字幕用它——用户按的位置未必正好在标点上。
 */
export function snapBreakOffset(text: string, ratio: number, opts?: { maxChars?: number; lang?: string }): number | null {
  if (text.length < 2) return null;
  const max = Math.max(4, opts?.maxChars || cueCharLimit(text, opts?.lang));
  const ideal = Math.max(0, Math.min(1, ratio)) * text.length;
  return bestCut(text, breakPoints(text), 0, text.length, ideal, max)?.at ?? null;
}

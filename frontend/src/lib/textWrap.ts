// 文字图层自动换行（HIG-51，style.wrap_width）：按实际测量宽度把每一行折成多行——不碰 canvas 的纯函数。
//
// 断行机会用 Intl.Segmenter（word）找：拉丁文在词间断，中日韩 / 泰文在词或字间断；
// 句读、右括号、空格粘在前一段上（不出现在行首），左括号粘在后一段上（不留在行尾）。
// 单个词比整行还宽时按字形（grapheme）硬断。手动 \n 由调用方先分好行，这里只在行内折。
// 宽度由调用方注入的 measure 算（drawTextImage 用 canvas measureText + 字距），这里只决定在哪断。

import type { TextRun } from './textSpans';

type Range = [number, number];

/** 不能出现在行首的：空白、句读、右括号 / 右引号、破折号。 */
const NO_LINE_START = /^[\s,.!?;:%)\]}>'"’”，。、！？；：％）》」』】〕〉…·‧—–-]+$/u;
/** 不能留在行尾的：左括号 / 左引号。 */
const NO_LINE_END = /[([{<（《「『【〔〈“‘]$/u;

type SegmenterLike = { segment(s: string): Iterable<{ segment: string; index: number }> };
let wordSeg: SegmenterLike | null | undefined;
let graphemeSeg: SegmenterLike | null | undefined;

function segmenter(granularity: 'word' | 'grapheme'): SegmenterLike | null {
  const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, o?: { granularity: string }) => SegmenterLike }).Segmenter;
  if (!Ctor) return null;
  return new Ctor(undefined, { granularity });
}

function segments(text: string, a: number, b: number, granularity: 'word' | 'grapheme'): Range[] {
  if (granularity === 'word' && wordSeg === undefined) wordSeg = segmenter('word');
  if (granularity === 'grapheme' && graphemeSeg === undefined) graphemeSeg = segmenter('grapheme');
  const seg = granularity === 'word' ? wordSeg : graphemeSeg;
  const part = text.slice(a, b);
  const out: Range[] = [];
  if (seg) {
    for (const s of seg.segment(part)) out.push([a + s.index, a + s.index + s.segment.length]);
    return out;
  }
  // 没有 Intl.Segmenter 的退路：拉丁词 / 连续空白成段，其余按码点
  const re = granularity === 'word' ? /\s+|[A-Za-z0-9À-ɏЀ-ӿ'’_]+|[\s\S]/gu : /[\s\S]/gu;
  for (const m of part.matchAll(re)) out.push([a + (m.index ?? 0), a + (m.index ?? 0) + m[0].length]);
  return out;
}

/** 断行单元：词段合并上粘连规则后的区间。 */
export function wrapTokens(text: string): Range[] {
  const tokens: Range[] = [];
  for (const [a, b] of segments(text, 0, text.length, 'word')) {
    const prev = tokens[tokens.length - 1];
    if (prev && (NO_LINE_START.test(text.slice(a, b)) || NO_LINE_END.test(text.slice(prev[0], prev[1])))) prev[1] = b;
    else tokens.push([a, b]);
  }
  return tokens;
}

/** runs 在 [a, b) 上的切片，保留每段颜色；空时返回一个空片段。 */
function sliceRuns(runs: TextRun[], a: number, b: number): TextRun[] {
  const out: TextRun[] = [];
  let off = 0;
  for (const r of runs) {
    const ra = off;
    const rb = off + r.text.length;
    off = rb;
    const x = Math.max(a, ra);
    const y = Math.min(b, rb);
    if (y > x) out.push(r.color ? { text: r.text.slice(x - ra, y - ra), color: r.color } : { text: r.text.slice(x - ra, y - ra) });
  }
  return out.length ? out : [{ text: '' }];
}

/** 一行折成若干 [start, end)（行尾空白已去掉）。 */
export function wrapLineRanges(text: string, maxWidth: number, measure: (s: string) => number): Range[] {
  if (!text || !(maxWidth > 0) || measure(text) <= maxWidth) return [[0, text.length]];
  const width = (a: number, b: number) => measure(text.slice(a, b).trimEnd());
  const lines: Range[] = [];
  let ls = -1;
  let le = -1;
  const flush = () => {
    const end = ls + text.slice(ls, le).trimEnd().length;
    if (end > ls) lines.push([ls, end]);
  };
  for (const [a, b] of wrapTokens(text)) {
    if (ls < 0) ls = le = a;
    if (width(ls, b) <= maxWidth) {
      le = b;
      continue;
    }
    if (le > ls) {
      flush();
      ls = le = a;
      if (width(a, b) <= maxWidth) {
        le = b;
        continue;
      }
    }
    // 单个词比整行还宽：按字形硬断
    for (const [ga, gb] of segments(text, a, b, 'grapheme')) {
      if (le > ls && width(ls, gb) > maxWidth) {
        flush();
        ls = ga;
      }
      le = gb;
    }
  }
  if (ls >= 0 && le > ls) flush();
  return lines.length ? lines : [[0, text.length]];
}

/** 每一行（splitRuns 的结果）按 maxWidth 折行，保留片段颜色；maxWidth 非正时原样返回。 */
export function wrapRuns(lines: TextRun[][], maxWidth: number, measure: (s: string) => number): TextRun[][] {
  if (!(maxWidth > 0)) return lines;
  const out: TextRun[][] = [];
  for (const runs of lines) {
    const text = runs.map((r) => r.text).join('');
    for (const [a, b] of wrapLineRanges(text, maxWidth, measure)) out.push(sliceRuns(runs, a, b));
  }
  return out;
}

/** 换行框宽度（相对画布宽）的合法范围：太窄每行放不下一个字，超过 1 契约不允许。 */
export const WRAP_WIDTH_MIN = 0.05;
export const WRAP_WIDTH_MAX = 1;

export function clampWrapWidth(v: number): number {
  if (!Number.isFinite(v)) return WRAP_WIDTH_MAX;
  return Math.round(Math.max(WRAP_WIDTH_MIN, Math.min(WRAP_WIDTH_MAX, v)) * 10000) / 10000;
}

// 大字报文案按标点分行（HIG-55）：粘贴整篇文案时在断句标点后换行，行尾标点按用户设置保留或去掉。
// 纯函数；原有换行保留（连续空行并成一个），不改标点以外的任何字。

import type { PunctMode } from './featurePrefs';

/** 句末标点：一句话到此为止。 */
const SENTENCE = new Set(Array.from('。！？…．!?.'));
/** 从句标点：语义停顿，但话没说完。 */
const CLAUSE = new Set(Array.from('；，、：;,:'));
/** 断句标点：出现在这里之后换行。 */
const BREAK = new Set([...SENTENCE, ...CLAUSE]);
/** 半角标点：后面紧跟非空白的 ASCII 字符时不算断句（3.5、1,000、10:30、HitGO.com、e.g.x）。 */
const ASCII_PUNCT = new Set(Array.from('!?;,:.'));
/** 跟在标点后面的收尾符号：留在同一行。 */
const CLOSERS = new Set(Array.from('"\'”’」』）)]】》〉'));

const CLOSER_CLASS = '"\'”’」』）)\\]】》〉';
const PAUSE_TAIL = new RegExp(`[，、；：,;:]+([${CLOSER_CLASS}]*)$`);
const ALL_TAIL = new RegExp(`[。！？；，、：…．!?;,:.]+([${CLOSER_CLASS}]*)$`);

/**
 * 下标 i 的字符是不是断句标点，是哪一档。字幕断句（lib/cueSplit）和大字报分行共用这一套规则，
 * 免得两处的标点判定各写一份、慢慢漂移。
 */
export function punctBreakAt(line: string, i: number): 'sentence' | 'clause' | null {
  const ch = line[i];
  if (!BREAK.has(ch)) return null;
  if (ASCII_PUNCT.has(ch)) {
    const next = line[i + 1];
    const standalone = next === undefined || /\s/.test(next) || next.charCodeAt(0) > 0x7f;
    if (!standalone) return null;
  }
  return SENTENCE.has(ch) ? 'sentence' : 'clause';
}

/** 跟在标点后面、要留在同一行的收尾符号（右引号 / 右括号）。 */
export function isCloser(ch: string): boolean {
  return CLOSERS.has(ch);
}

function breaksAfter(line: string, i: number): boolean {
  return punctBreakAt(line, i) !== null;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < line.length) {
    buf += line[i];
    if (breaksAfter(line, i)) {
      // 连续标点（？！、……）和收尾引号 / 括号跟着这一行走
      while (i + 1 < line.length && (BREAK.has(line[i + 1]) || CLOSERS.has(line[i + 1]))) buf += line[++i];
      out.push(buf);
      buf = '';
    }
    i++;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 按 mode 处理一行的行尾标点；去完只剩空的行返回空串。 */
export function trimTailPunct(line: string, mode: PunctMode): string {
  if (mode === 'keep') return line;
  return line.replace(mode === 'drop-pause' ? PAUSE_TAIL : ALL_TAIL, '$1').trim();
}

export function splitByPunctuation(text: string, mode: PunctMode = 'keep'): string {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const parts = splitLine(raw)
      .map((l) => trimTailPunct(l, mode))
      .filter(Boolean);
    if (parts.length) lines.push(...parts);
    else if (lines.length && lines[lines.length - 1] !== '') lines.push(''); // 原文空行保留一个
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

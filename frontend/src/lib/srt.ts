// SRT 字幕解析：对应剪映「导入本地字幕」。把 .srt 文件里的每条字幕变成一个带时段的文字图层。
// 纯函数，不依赖 DOM / store；时间单位为秒，落在剪后时间轴上（见 lib/time.ts）。

import type { TextLayer, TextStyle } from '../types';

/** 一条字幕：start / end 为秒（浮点），text 多行用 \n 连接。 */
export interface SrtCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

/** 字幕最短时长（秒）：end 至少比 start 晚这么多，避免零长度时段。 */
const MIN_CUE_DURATION = 0.1;

// `HH:MM:SS,mmm --> HH:MM:SS.mmm`；毫秒分隔符逗号 / 点都接受，小时可省略（WebVTT 风格），
// 箭头后面允许跟 SRT 扩展的坐标或 VTT 的 cue settings（忽略）。
const TIMING_RE = /^\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/** 把时间戳各段拼成秒。 */
function toSeconds(h: string | undefined, m: string, s: string, ms: string): number {
  const hours = h ? parseInt(h, 10) : 0;
  const millis = parseInt(ms.padEnd(3, '0'), 10);
  return hours * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + millis / 1000;
}

/** 去掉 `<i>` `<b>` `<font ...>` 这类 HTML 标签和 `{\an8}` 这类 ASS 覆盖标签，折叠多余空白。 */
export function stripSubtitleTags(line: string): string {
  return line
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 解析 SRT 文本为字幕列表。
 * 兼容：UTF-8 BOM、CRLF、空行分隔的块、可选的数字序号行、逗号或点作毫秒分隔符、
 * 多行文本、简单 HTML / ASS 标签、开头的 `WEBVTT` 头（WebVTT 文件顺带能读）。
 * 格式不对的块直接跳过；结果按 start 升序，end 至少为 start + 0.1s。
 */
export function parseSrt(text: string): SrtCue[] {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const cues: SrtCue[] = [];
  let seq = 0;
  for (const raw of blocks) {
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (!lines.length) continue;
    // WebVTT 头 / NOTE 块：没有时间行，会在下面自然跳过
    let i = 0;
    if (/^\d+$/.test(lines[i]) && i + 1 < lines.length && TIMING_RE.test(lines[i + 1])) i += 1;
    const m = TIMING_RE.exec(lines[i] ?? '');
    if (!m) continue;
    const start = toSeconds(m[1], m[2], m[3], m[4]);
    let end = toSeconds(m[5], m[6], m[7], m[8]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end < start + MIN_CUE_DURATION) end = start + MIN_CUE_DURATION;
    const body = lines
      .slice(i + 1)
      .map(stripSubtitleTags)
      .filter((l) => l.length > 0)
      .join('\n');
    if (!body) continue;
    seq += 1;
    cues.push({ index: seq, start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  cues.forEach((c, k) => {
    c.index = k + 1;
  });
  return cues;
}

export interface CuesToLayersOptions {
  /** 套用到每条字幕的完整样式；会逐条拷贝，互不共享引用。 */
  style: TextStyle;
  newId: () => string;
  /** 剪后时长：start >= maxEnd 的字幕丢弃，end 裁到 maxEnd。 */
  maxEnd?: number;
}

/**
 * 字幕 → 文字图层：贴底居中（bottom-center，底边距 12%），宽 80%，时段 t = [start, end]。
 * 图层名「字幕 N」按最终保留顺序编号。
 */
export function cuesToTextLayers(cues: SrtCue[], opts: CuesToLayersOptions): TextLayer[] {
  const { style, newId, maxEnd } = opts;
  const layers: TextLayer[] = [];
  for (const cue of cues) {
    let end = cue.end;
    if (maxEnd !== undefined) {
      if (cue.start >= maxEnd) continue;
      end = Math.min(end, maxEnd);
    }
    layers.push({
      id: newId(),
      type: 'text',
      text: cue.text,
      style: { ...style, shadow: style.shadow ? { ...style.shadow, offset: [...style.shadow.offset] } : style.shadow },
      anchor: 'bottom-center',
      margin: [0, 0.12],
      width: 0.8,
      rotate: 0,
      opacity: 1,
      t: [cue.start, end],
      name: `字幕 ${layers.length + 1}`,
    });
  }
  return layers;
}

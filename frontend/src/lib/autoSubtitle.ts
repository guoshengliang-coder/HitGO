// 「自动识别字幕」（HIG-84）：把听写模板（transcript.cues，源视频自己的时间轴）拆成短句，
// 换算到成片时间轴，生成可编辑的字幕文字图层。纯函数，不依赖 DOM / store。
// 拼接序列（契约 §2 sequence）里每个源视频各听写一次，句子落到引用它的每个片段上；
// 上层视频轨（V2/V3）的声音不听写。

import type { EditSpec, Layer, TextLayer, TextStyle, TranscriptCue } from '../types';
import { defaultTextStyle } from '../types';
import { cleanCueText, MAX_SUBTITLE_LAYERS, normalizeCueWindows } from './localize';
import { sliceWindow, splitCueRanges, visibleLength } from './cueSplit';
import { clipWindows } from './sequence';
import { cuesToTextLayers, type SrtCue } from './srt';
import { BUILTIN_TEXT_PRESETS } from './textPresets';
import { sourceRangeToPost, type Range } from './time';

/** 换算后短于这个长度的碎片丢掉（被删除区 / 片段边界切剩的一点点）。 */
export const MIN_AUTO_PIECE = 0.1;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * 视频 videoId 自己源时间轴上的一段 → 成片（剪后）时间轴，可能是多段。
 * 没有 sequence：只认 owner 自己，按 trim.remove 换算（跨删除区的缩短，整段删掉的丢弃）。
 * 有 sequence：对每个引用 videoId 的片段，取与片段 in/out 的交集，按片段在拼接时钟上的位置和
 * speed 换算，再套 trim.remove（它作用在拼接后的时钟上）。转场重叠处归后一个片段，和预览一致。
 */
export function ownerSourceRangeToPost(spec: EditSpec, videoId: string, [a0, b0]: Range, ownerId = videoId): Range[] {
  const a = Math.min(a0, b0);
  const b = Math.max(a0, b0);
  const onClock: Range[] = [];
  if (!spec.sequence) {
    if (videoId === ownerId) onClock.push([a, b]);
  } else {
    const windows = clipWindows(spec.sequence);
    windows.forEach((w, i) => {
      if (w.clip.video_id !== videoId) return;
      const speed = w.clip.speed ?? 1;
      const visibleEnd = Math.min(w.end, windows[i + 1]?.start ?? w.end);
      const lo = Math.max(a, w.clip.in);
      const hi = Math.min(b, w.clip.in + (visibleEnd - w.start) * speed);
      if (hi - lo <= 1e-6) return;
      onClock.push([w.start + (lo - w.clip.in) / speed, w.start + (hi - w.clip.in) / speed]);
    });
  }
  return onClock
    .map((r) => sourceRangeToPost(r, spec.trim.remove, 0))
    .filter((r): r is Range => !!r && r[1] - r[0] >= MIN_AUTO_PIECE - 1e-6)
    .map(([x, y]): Range => [round3(x), round3(y)]);
}

/** 一个源视频的听写结果。 */
export interface VideoTranscript {
  videoId: string;
  cues: TranscriptCue[];
  /** 听写出的源语言；拆句按它定每行字数。 */
  lang?: string;
}

export interface AutoSubtitleOptions {
  /** 当前（owner）视频；spec 没有 sequence 时只有它的听写有效。 */
  ownerId: string;
  /** 成片正片时长：超出的丢掉 / 截掉。 */
  postDuration: number;
  newId: () => string;
  /** 缺省 true：长句按标点 / 字数拆成短句（与改语言字幕同一套规则）。 */
  split?: boolean;
}

/** 自动字幕的样式：和导入 .srt 一样，默认样式 + 「黑底白字字幕条」。 */
export function autoSubtitleStyle(): TextStyle {
  const preset = BUILTIN_TEXT_PRESETS.find((p) => p.id === 'builtin:subtitle-bar');
  return { ...defaultTextStyle(), ...(preset?.style ?? {}) };
}

/** 听写结果 → 字幕文字图层（origin 'subtitle'、auto true），按时间排序，最多 MAX_SUBTITLE_LAYERS 条。 */
export function transcriptToSubtitleLayers(transcripts: VideoTranscript[], spec: EditSpec, opts: AutoSubtitleOptions): TextLayer[] {
  const build = (split: boolean): SrtCue[] => {
    const out: SrtCue[] = [];
    for (const tr of transcripts) {
      for (const cue of tr.cues) {
        const text = cleanCueText(cue.text);
        if (!text || !(cue.end > cue.start)) continue;
        const ranges = split ? splitCueRanges(text, { lang: tr.lang }) : [[0, text.length] as Range];
        const slices = sliceWindow([cue.start, cue.end], ranges.map(([x, y]) => visibleLength(text, x, y) || 1));
        ranges.forEach(([x, y], k) => {
          const piece = text.slice(x, y).trim();
          if (!piece) return;
          for (const [start, end] of ownerSourceRangeToPost(spec, tr.videoId, slices[k], opts.ownerId)) {
            out.push({ index: 0, start, end, text: piece });
          }
        });
      }
    }
    return out;
  };
  let cues = build(opts.split !== false);
  // 拆得太碎会把预览烤图和导出拖垮：回到一句一条，再不行就截断。
  if (cues.length > MAX_SUBTITLE_LAYERS) cues = build(false);
  cues.sort((x, y) => x.start - y.start || x.end - y.end);
  // The transcript service can return overlapping source cues. Conversion,
  // splitting and millisecond rounding can also introduce a shared frame.
  // Apply the next cue's start as a hard boundary after all three steps.
  cues = normalizeCueWindows(cues).slice(0, MAX_SUBTITLE_LAYERS).map((c, k) => ({ ...c, index: k + 1 }));
  const layers = cuesToTextLayers(cues, { style: autoSubtitleStyle(), newId: opts.newId, maxEnd: opts.postDuration > 0 ? opts.postDuration : undefined });
  layers.forEach((layer) => {
    layer.origin = 'subtitle';
    layer.auto = true;
  });
  return layers;
}

/** 这层是不是上一批自动识别出的字幕。 */
export function isAutoSubtitle(layer: Layer): boolean {
  return layer.type === 'text' && layer.origin === 'subtitle' && layer.auto === true;
}

/** 换掉上一批自动字幕（锁定的留着），手动添加 / .srt 导入的不动，新的一批追加在后面。 */
export function replaceAutoSubtitles(layers: Layer[], next: Layer[]): Layer[] {
  return [...layers.filter((l) => !isAutoSubtitle(l) || l.locked), ...next];
}

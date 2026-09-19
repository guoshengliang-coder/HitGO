import type { Layer, TextLayer } from '../types';
import { isSubtitleTextLayer } from './layerSplit';
import { normalizeSpans } from './textSpans';

/** 同一来源、同一语言的下一句；不跳过被锁定的字幕。 */
export function nextSubtitle(layers: Layer[], current: TextLayer): TextLayer | undefined {
  if (current.t === 'all') return undefined;
  const start = current.t[0];
  return layers.filter(isSubtitleTextLayer)
    .filter((l) => l.id !== current.id && l.origin === current.origin && l.lang === current.lang && l.t !== 'all' && l.t[0] >= start)
    .sort((a, b) => (a.t === 'all' ? 0 : a.t[0]) - (b.t === 'all' ? 0 : b.t[0]))[0];
}

export function mergeSubtitles(first: TextLayer, next: TextLayer): TextLayer | null {
  if (!isSubtitleTextLayer(first) || !isSubtitleTextLayer(next) || first.id === next.id
    || first.locked || next.locked || first.scroll || next.scroll
    || first.origin !== next.origin || first.lang !== next.lang || !!first.hidden !== !!next.hidden
    || first.t === 'all' || next.t === 'all' || next.t[0] < first.t[1] - 1e-6) return null;
  const merged = structuredClone(first);
  const offset = first.text.length + 1;
  merged.text = `${first.text}\n${next.text}`;
  merged.t = [first.t[0], next.t[1]];
  merged.spans = normalizeSpans([...(first.spans ?? []), ...(next.spans ?? []).map(s => ({ ...s, start: s.start + offset, end: s.end + offset }))], merged.text.length);
  delete merged.image_url;
  delete merged.image_size;
  delete merged.variant_images;
  delete merged.glyph_layout;
  delete merged.background_image;
  return merged;
}

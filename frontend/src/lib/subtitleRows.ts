// 字幕同轨（HIG-92）：每句字幕仍是一个文字图层，时间轴上按来源 / 语种各放一行，一行里排多句（剪映式）。
// 同一来源里时间重叠的句子才溢出到下一行；遮盖（mask）各占一行。只影响时间轴显示，spec 不变。

import type { Layer } from '../types';

export interface SubtitleRow {
  /** 稳定键：来源键 + 行号（遮盖用图层 id）。 */
  key: string;
  /** 轨道头显示名：识别字幕 / 译文 · en / 字幕 / 遮盖名，溢出行带序号。 */
  label: string;
  kind: 'subtitle' | 'mask';
  /** 本行的图层（按起点升序），附在 spec.layers 里的下标，拖动时按它写回。 */
  items: { l: Layer; i: number }[];
}

const EPS = 1e-6;

function sourceKey(l: Layer): string {
  if (l.type === 'text' && l.origin === 'localize') return `localize:${l.lang ?? ''}`;
  if (l.type === 'text' && l.origin === 'subtitle' && l.auto) return 'auto';
  return 'manual';
}

function sourceLabel(key: string): string {
  if (key === 'auto') return '识别字幕';
  if (key.startsWith('localize:')) return key.length > 9 ? `译文 · ${key.slice(9)}` : '译文';
  return '字幕';
}

function span(l: Layer, postDuration: number): [number, number] {
  return l.t === 'all' ? [0, postDuration] : l.t;
}

/**
 * 把字幕车道里的图层（layerLane === 'subtitle'）排成行。
 * 行的先后按各来源在 spec.layers 里第一次出现的顺序（与原来一层一行的上下顺序一致）。
 */
export function packSubtitleRows(rows: { l: Layer; i: number }[], postDuration: number, maskName: (l: Layer) => string = (l) => l.name ?? '遮盖'): SubtitleRow[] {
  const order: string[] = [];
  const groups = new Map<string, { l: Layer; i: number }[]>();
  for (const row of rows) {
    const key = row.l.type === 'mask' ? `mask:${row.l.id}` : sourceKey(row.l);
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(row);
  }
  const out: SubtitleRow[] = [];
  for (const key of order) {
    const items = groups.get(key)!;
    if (key.startsWith('mask:')) {
      out.push({ key, label: maskName(items[0].l), kind: 'mask', items });
      continue;
    }
    const sorted = [...items].sort((a, b) => span(a.l, postDuration)[0] - span(b.l, postDuration)[0] || a.i - b.i);
    const lanes: { end: number; items: { l: Layer; i: number }[] }[] = [];
    for (const item of sorted) {
      const [start, end] = span(item.l, postDuration);
      const lane = lanes.find((x) => x.end <= start + EPS);
      if (lane) { lane.items.push(item); lane.end = end; }
      else lanes.push({ end, items: [item] });
    }
    const label = sourceLabel(key);
    lanes.forEach((lane, n) => out.push({ key: `${key}#${n}`, label: n === 0 ? label : `${label} ${n + 1}`, kind: 'subtitle', items: lane.items }));
  }
  return out;
}

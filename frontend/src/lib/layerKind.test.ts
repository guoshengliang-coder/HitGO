import { describe, expect, it } from 'vitest';
import { indexWithinType, layersOfType, moveWithinType } from './layerKind';
import type { Layer } from '../types';

const base = { anchor: 'center', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: 'all' } as const;
const text = (id: string): Layer => ({ ...base, margin: [0, 0], id, type: 'text', text: id, style: {} as never });
const sticker = (id: string): Layer => ({ ...base, margin: [0, 0], id, type: 'sticker', asset_id: `a_${id}` });

// z 序从下到上：s1 t1 s2 t2 t3
const MIXED: Layer[] = [sticker('s1'), text('t1'), sticker('s2'), text('t2'), text('t3')];
const ids = (ls: Layer[]) => ls.map((l) => l.id);

describe('layersOfType', () => {
  it('按类型过滤并保持 z 序', () => {
    expect(ids(layersOfType(MIXED, 'text'))).toEqual(['t1', 't2', 't3']);
    expect(ids(layersOfType(MIXED, 'sticker'))).toEqual(['s1', 's2']);
  });
});

describe('moveWithinType', () => {
  it('只在同类占用的位置之间换序，另一类原地不动', () => {
    // t1 挪到文字里的最上层
    expect(ids(moveWithinType(MIXED, 't1', 2))).toEqual(['s1', 't2', 's2', 't3', 't1']);
    // s2 挪到贴纸里的最下层
    expect(ids(moveWithinType(MIXED, 's2', 0))).toEqual(['s2', 't1', 's1', 't2', 't3']);
  });
  it('index 越界夹到边界', () => {
    expect(ids(moveWithinType(MIXED, 't3', -5))).toEqual(['s1', 't3', 's2', 't1', 't2']);
    expect(ids(moveWithinType(MIXED, 't1', 99))).toEqual(['s1', 't2', 's2', 't3', 't1']);
  });
  it('位置没变或找不到 id 时返回原数组', () => {
    expect(moveWithinType(MIXED, 't2', 1)).toBe(MIXED);
    expect(moveWithinType(MIXED, 'nope', 0)).toBe(MIXED);
  });
  it('不改入参', () => {
    const copy = MIXED.slice();
    moveWithinType(MIXED, 't1', 2);
    expect(MIXED).toEqual(copy);
  });
});

describe('indexWithinType', () => {
  it('返回在同类里的位置', () => {
    expect(indexWithinType(MIXED, 't2')).toBe(1);
    expect(indexWithinType(MIXED, 's2')).toBe(1);
    expect(indexWithinType(MIXED, 'nope')).toBe(-1);
  });
});

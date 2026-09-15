import { describe, expect, it } from 'vitest';
import { toContractSpec } from './spec';
import { emptySpec, type EditSpec } from '../types';

describe('toContractSpec · audio', () => {
  it('没有 audio 块、或全是缺省值时不带此字段（保持旧 spec 形状）', () => {
    expect('audio' in toContractSpec(emptySpec())).toBe(false);
    const spec: EditSpec = { ...emptySpec(), audio: { source_volume: 1, tracks: [] } };
    expect('audio' in toContractSpec(spec)).toBe(false);
  });
  it('有设置时原样透传，区间取三位小数', () => {
    const spec: EditSpec = {
      ...emptySpec(),
      audio: { source_volume: 0, tracks: [{ id: 'au_1', asset_id: 'a_bgm', role: 'bgm', t: [0.12345, 3], loop: true, volume: 0.6, fade_out: 1 }] },
    };
    expect(toContractSpec(spec).audio).toEqual({
      source_volume: 0,
      tracks: [{ id: 'au_1', asset_id: 'a_bgm', role: 'bgm', t: [0.123, 3], loop: true, volume: 0.6, fade_out: 1 }],
    });
  });
  it('本地图层字段仍被剔除', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [{ id: 'l', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: 'all', name: 'x', locked: true }] };
    expect(toContractSpec(spec).layers[0]).not.toHaveProperty('name');
  });
});

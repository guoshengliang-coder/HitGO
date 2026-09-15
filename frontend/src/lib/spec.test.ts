import { describe, expect, it } from 'vitest';
import { toContractSpec, toSingleOutput } from './spec';
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

describe('toSingleOutput', () => {
  it('已经是单一 9x16 时原样返回同一个对象', () => {
    const spec = emptySpec();
    expect(toSingleOutput(spec)).toBe(spec);
  });
  it('多画幅：只留 9x16，保留它的填充、裁切与清晰度', () => {
    const spec: EditSpec = {
      ...emptySpec(),
      outputs: [
        { variant_key: '9x16', aspect: '9:16', fill: 'crop', crop: { x: 0.2, y: 0, w: 0.3, h: 1 }, quality: 'high' },
        { variant_key: '1x1', aspect: '1:1', fill: 'blur', layer_overrides: { l1: { width: 0.4 } } },
      ],
    };
    const out = toSingleOutput(spec);
    expect(out).not.toBe(spec);
    expect(out.outputs).toEqual([{ variant_key: '9x16', aspect: '9:16', fill: 'crop', crop: { x: 0.2, y: 0, w: 0.3, h: 1 }, quality: 'high' }]);
    expect(spec.outputs).toHaveLength(2); // 不改入参
  });
  it('没有 9x16：沿用第一个变体的填充 / 颜色 / 清晰度，裁切窗口丢掉', () => {
    const color: EditSpec = { ...emptySpec(), outputs: [{ variant_key: '16x9', aspect: '16:9', fill: 'color', color: '#112233', quality: 'high' }] };
    expect(toSingleOutput(color).outputs).toEqual([{ variant_key: '9x16', aspect: '9:16', fill: 'color', color: '#112233', quality: 'high' }]);
    const crop: EditSpec = { ...emptySpec(), outputs: [{ variant_key: '1x1', aspect: '1:1', fill: 'crop', crop: { x: 0.1, y: 0, w: 0.5, h: 1 } }] };
    expect(toSingleOutput(crop).outputs).toEqual([{ variant_key: '9x16', aspect: '9:16', fill: 'crop', quality: 'standard' }]);
  });
  it('单一 9x16 但带 layer_overrides：清掉覆盖', () => {
    const spec: EditSpec = { ...emptySpec(), outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'blur', layer_overrides: { l1: { opacity: 0.5 } } }] };
    expect(toSingleOutput(spec).outputs[0]).not.toHaveProperty('layer_overrides');
  });
  it('outputs 为空时补一个默认 9x16', () => {
    const spec: EditSpec = { ...emptySpec(), outputs: [] };
    expect(toSingleOutput(spec).outputs).toEqual([{ variant_key: '9x16', aspect: '9:16', fill: 'blur', quality: 'standard' }]);
  });
  it('其他字段不动', () => {
    const spec: EditSpec = { ...emptySpec(), trim: { remove: [[1, 2]] }, outputs: [{ variant_key: '4x5', aspect: '4:5', fill: 'blur' }] };
    expect(toSingleOutput(spec).trim).toBe(spec.trim);
  });
});

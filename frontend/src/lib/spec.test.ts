import { describe, expect, it } from 'vitest';
import { countSafeZoneOverlaps, ensureVariants, exportKeys, hasExportChoice, layerAspect, layerName, normalizeOutputs, outputFor, setExportKeys, toContractSpec } from './spec';
import { emptySpec, type EditSpec, type MaskLayer, type SafeZone } from '../types';

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
  it('本地图层字段仍被剔除；name 是契约字段（HIG-48），非空时发送', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [{ id: 'l', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0, 0], width: 0.3, rotate: 0, opacity: 1, t: 'all', name: ' 角标 ', locked: true }] };
    const out = toContractSpec(spec).layers[0];
    expect(out).not.toHaveProperty('locked');
    expect(out).toHaveProperty('name', '角标');
    const blank: EditSpec = { ...spec, layers: [{ ...spec.layers[0], name: '  ' }] };
    expect(toContractSpec(blank).layers[0]).not.toHaveProperty('name');
  });
  it('hidden 是契约字段（HIG-33）：true 时发给后端，false / 缺省时不发', () => {
    const base = { type: 'sticker' as const, asset_id: 'a', anchor: 'top-left' as const, margin: [0, 0] as [number, number], width: 0.3, rotate: 0, opacity: 1, t: 'all' as const };
    const spec: EditSpec = { ...emptySpec(), layers: [{ ...base, id: 'l1', hidden: true }, { ...base, id: 'l2', hidden: false }, { ...base, id: 'l3' }] };
    const layers = toContractSpec(spec).layers;
    expect(layers[0]).toHaveProperty('hidden', true);
    expect(layers[1]).not.toHaveProperty('hidden');
    expect(layers[2]).not.toHaveProperty('hidden');
  });
});

describe('toContractSpec · cover（HIG-9）', () => {
  it('没有封面时不带此字段，有封面时带上并规范化时长；normalizeOutputs 保留封面', () => {
    expect('cover' in toContractSpec(emptySpec())).toBe(false);
    expect('cover' in toContractSpec({ ...emptySpec(), cover: null })).toBe(false);
    const spec: EditSpec = { ...emptySpec(), cover: { asset_id: 'a_img', duration: 1.26 } };
    expect(toContractSpec(spec).cover).toEqual({ asset_id: 'a_img', duration: 1.3 });
    const multi: EditSpec = { ...spec, outputs: [...spec.outputs, { variant_key: '1x1', aspect: '1:1', fill: 'blur' }] };
    expect(normalizeOutputs(multi).cover).toEqual(spec.cover);
  });
});

describe('normalizeOutputs / ensureVariants（HIG-29）', () => {
  it('已规范时原样返回同一个对象', () => {
    const spec = emptySpec();
    expect(normalizeOutputs(spec)).toBe(spec);
    const multi: EditSpec = { ...emptySpec(), outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'blur' }, { variant_key: '1x1', aspect: '1:1', fill: 'crop', layer_fit: 'video' }] };
    expect(normalizeOutputs(multi)).toBe(multi);
  });
  it('补 9x16 并排第一、按画幅顺序排、去重、丢掉不认识的 key', () => {
    const spec = {
      ...emptySpec(),
      outputs: [
        { variant_key: '16x9', aspect: '16:9', fill: 'color', color: '#112233', quality: 'high', layer_fit: 'video' },
        { variant_key: 'custom', aspect: '1:1', fill: 'blur' },
        { variant_key: '16x9', aspect: '16:9', fill: 'blur', layer_fit: 'video' },
      ],
    } as unknown as EditSpec;
    const out = normalizeOutputs(spec);
    expect(out.outputs.map((o) => o.variant_key)).toEqual(['9x16', '16x9']);
    expect(out.outputs[0]).toEqual({ variant_key: '9x16', aspect: '9:16', fill: 'color', color: '#112233', quality: 'high' });
    expect(out.outputs[1].color).toBe('#112233');
    expect(spec.outputs).toHaveLength(3); // 不改入参
  });
  it('HIG-8 之前的旧多画幅：改为跟随视频并清掉画布相对的覆盖', () => {
    const spec: EditSpec = { ...emptySpec(), outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'blur' }, { variant_key: '1x1', aspect: '1:1', fill: 'blur', layer_overrides: { l1: { width: 0.4 } } }] };
    expect(normalizeOutputs(spec).outputs[1]).toEqual({ variant_key: '1x1', aspect: '1:1', fill: 'blur', layer_fit: 'video' });
  });
  it('ensureVariants 只补缺的画幅（缺省模糊铺底、清晰度随 9x16），已有设置不动', () => {
    const spec: EditSpec = { ...emptySpec(), outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'blur', quality: 'high' }, { variant_key: '4x5', aspect: '4:5', fill: 'crop', layer_fit: 'video', layer_overrides: { l1: { rotate: 3 } } }] };
    expect(ensureVariants(spec, ['9x16', '4x5'])).toBe(spec);
    const out = ensureVariants(spec, ['16x9', '4x5']);
    expect(out.outputs.map((o) => o.variant_key)).toEqual(['9x16', '4x5', '16x9']);
    expect(out.outputs[1]).toEqual(spec.outputs[1]);
    expect(out.outputs[2]).toEqual({ variant_key: '16x9', aspect: '16:9', fill: 'blur', quality: 'high', layer_fit: 'video' });
    expect(outputFor(spec, '1x1')).toEqual({ variant_key: '1x1', aspect: '1:1', fill: 'blur', quality: 'high', layer_fit: 'video' });
  });
});

describe('遮盖层', () => {
  const mask: MaskLayer = { id: 'm', type: 'mask', mode: 'blur', anchor: 'bottom-center', margin: [0, 0.1], width: 1, height: 0.12, rotate: 0, opacity: 1, t: 'all' };
  it('layerAspect 按 9:16 画布把 width / height 换成宽高比，非法尺寸回 1', () => {
    expect(layerAspect(mask, [])).toBeCloseTo((1 * 1080) / (0.12 * 1920));
    expect(layerAspect({ ...mask, width: 0.5, height: 0.5 }, [])).toBeCloseTo(1080 / 1920);
    expect(layerAspect({ ...mask, height: 0 }, [])).toBe(1);
  });
  it('layerName 缺省「遮盖」，本地 name 优先', () => {
    expect(layerName(mask, [])).toBe('遮盖');
    expect(layerName({ ...mask, name: '遮原字幕' }, [])).toBe('遮原字幕');
  });
  it('安全区重叠统计跳过遮盖层', () => {
    const zone: SafeZone = { key: 'z', name: 'z', aspect: '9:16', zones: [{ label: '', x: 0, y: 0.8, w: 1, h: 0.2 }] };
    const spec: EditSpec = { ...emptySpec(), layers: [mask] };
    expect(countSafeZoneOverlaps(spec, zone, [])).toBe(0);
  });
  it('toContractSpec 剔除本地字段后原样透传遮盖字段', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [{ ...mask, locked: true, blur: 3, color: '#112233' }] };
    expect(toContractSpec(spec).layers[0]).toEqual({ ...mask, blur: 3, color: '#112233' });
  });
});

describe('导出勾选 exportKeys / setExportKeys（HIG-35）', () => {
  const multi = (): EditSpec => ({
    ...emptySpec(),
    outputs: [
      { variant_key: '9x16', aspect: '9:16', fill: 'blur' },
      { variant_key: '16x9', aspect: '16:9', fill: 'crop', layer_fit: 'video' },
    ],
  });
  it('没写 export 时只有 9x16 算勾选（老 spec 行为不变）', () => {
    expect(exportKeys(multi())).toEqual(['9x16']);
    expect(hasExportChoice(multi())).toBe(false);
  });
  it('按 export 取勾选，按画幅顺序；全部取消时回到 9x16', () => {
    const spec = multi();
    spec.outputs[0].export = false;
    spec.outputs[1].export = true;
    expect(exportKeys(spec)).toEqual(['16x9']);
    expect(hasExportChoice(spec)).toBe(true);
    spec.outputs[1].export = false;
    expect(exportKeys(spec)).toEqual(['9x16']);
  });
  it('写回时补上缺的画幅、保留已有设置，并逐个写明 export', () => {
    const next = setExportKeys(multi(), ['1x1', '16x9']);
    expect(next.outputs.map((o) => [o.variant_key, o.export])).toEqual([
      ['9x16', false],
      ['1x1', true],
      ['16x9', true],
    ]);
    expect(next.outputs[2].fill).toBe('crop');
    expect(next.outputs[1]).toMatchObject({ fill: 'blur', layer_fit: 'video' });
    expect(exportKeys(next)).toEqual(['1x1', '16x9']);
  });
  it('空勾选按 9x16 处理；export 原样发给后端', () => {
    const next = setExportKeys(multi(), []);
    expect(exportKeys(next)).toEqual(['9x16']);
    expect(toContractSpec(next).outputs.map((o) => o.export)).toEqual([true, false]);
  });
});

import { describe, expect, it } from 'vitest';
import cases from './fixtures/variantLayoutCases.json';
import { fitMap, followLayerBox, followMaskBox, layerFollows, overrideDetaches, overrideFromBox, placementOfBox, resolveLayerBox, variantFitMap } from './variantLayout';
import { placeLayer } from './layout';
import { emptySpec, variantDef, type AspectKey, type EditSpec, type FillMode, type MaskLayer, type StickerLayer, type VariantKey } from '../types';

const keyOf = (a: string) => a.replace(':', 'x') as VariantKey;

describe('variantLayout · golden（与后端共用）', () => {
  it.each(cases.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const frame = (o: { aspect: string; fill: string; crop?: { x: number; y: number; w: number; h: number } }) => {
      const d = variantDef(keyOf(o.aspect));
      return { fill: o.fill as FillMode, crop: o.crop ?? null, W: d.width, H: d.height };
    };
    const ref = frame(c.ref);
    const m = fitMap(ref, frame(c.target), c.src[0], c.src[1]);
    const l = c.layer as { kind: string; anchor: MaskLayer['anchor']; margin: [number, number]; width: number; height?: number; image?: [number, number] };
    const box =
      l.kind === 'mask'
        ? followMaskBox(placeLayer(l, (l.width * ref.W) / (l.height! * ref.H), { W: ref.W, H: ref.H }), m)
        : followLayerBox(l, l.image![0] / l.image![1], m, l.kind !== 'text');
    const e = c.expected;
    expect(m.k).toBeCloseTo(e.k, 3);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(box[k]).toBeCloseTo(e[k], 2);
  });
});

function specWith(target: { key: VariantKey; aspect: AspectKey; fill: FillMode }, layers: EditSpec['layers'], overrides?: Record<string, object>): EditSpec {
  return {
    ...emptySpec(),
    layers,
    outputs: [
      { variant_key: '9x16', aspect: '9:16', fill: 'blur' },
      { variant_key: target.key, aspect: target.aspect, fill: target.fill, layer_fit: 'video', ...(overrides ? { layer_overrides: overrides } : {}) },
    ],
  };
}

const mask: MaskLayer = { id: 'm', type: 'mask', mode: 'solid', anchor: 'bottom-center', margin: [0, 0.1], width: 0.9, height: 0.08, rotate: 0, opacity: 1, t: 'all' };
const sticker: StickerLayer = { id: 's', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0.1, 0.1], width: 0.3, rotate: 15, opacity: 0.8, t: 'all' };

describe('variantLayout · resolveLayerBox', () => {
  it('自定义尺寸用于图层几何和覆盖写回', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [sticker], outputs: [
      { variant_key: '9x16', aspect: '9:16', fill: 'blur' },
      { variant_key: 'custom', aspect: 'custom', width: 1000, height: 1400, fill: 'blur', layer_fit: 'canvas' },
    ] };
    const custom = spec.outputs[1];
    const box = resolveLayerBox(spec, sticker, custom, 2, 1080, 1920);
    expect(box.w).toBe(300);
    const override = overrideFromBox(sticker, { x: 100, y: 140, w: 300, h: 150 }, 'top-left', 'custom', undefined, custom);
    expect(override.margin).toEqual([0.1, 0.1]);
    expect(placementOfBox({ x: 100, y: 140, w: 300, h: 150 }, 'top-left', 'custom', custom).canvas).toEqual({ W: 1000, H: 1400 });
  });
  it('跟随视频：1:1 blur 上遮盖按 0.5625 缩放并平移', () => {
    const spec = specWith({ key: '1x1', aspect: '1:1', fill: 'blur' }, [mask]);
    const b = resolveLayerBox(spec, mask, spec.outputs[1], 1, 1080, 1920);
    expect(b.x).toBeCloseTo(266.625);
    expect(b.y).toBeCloseTo(885.6);
    expect(b.w).toBeCloseTo(546.75);
  });
  it('9x16 本身、canvas 模式、源尺寸未知都按画布相对', () => {
    const spec = specWith({ key: '1x1', aspect: '1:1', fill: 'blur' }, [mask]);
    expect(variantFitMap(spec, spec.outputs[0], 1080, 1920)).toBeNull();
    expect(variantFitMap(spec, spec.outputs[1], 0, 0)).toBeNull();
    const canvas = { ...spec.outputs[1], layer_fit: 'canvas' as const };
    expect(resolveLayerBox(spec, mask, canvas, 1, 1080, 1920).w).toBeCloseTo(972);
  });
  it('几何覆盖脱离跟随；只改旋转 / 不透明度仍跟随', () => {
    const rot = specWith({ key: '1x1', aspect: '1:1', fill: 'blur' }, [sticker], { s: { rotate: 0, opacity: 0.5 } });
    expect(layerFollows(rot, sticker, rot.outputs[1], 1080, 1920)).toBe(true);
    const b = resolveLayerBox(rot, sticker, rot.outputs[1], 2, 1080, 1920);
    expect(b.rotate).toBe(0);
    expect(b.opacity).toBe(0.5);
    expect(b.w).toBeCloseTo(324 * 0.5625);
    const moved = specWith({ key: '1x1', aspect: '1:1', fill: 'blur' }, [sticker], { s: { margin: [0, 0] } });
    expect(overrideDetaches(moved.outputs[1].layer_overrides!.s)).toBe(true);
    const d = resolveLayerBox(moved, sticker, moved.outputs[1], 2, 1080, 1920);
    expect([d.x, d.y, d.w]).toEqual([0, 0, 324]);
  });
});

describe('variantLayout · 写回覆盖', () => {
  it('像素框写成覆盖后再解析回同一个框（脱离跟随）', () => {
    const spec = specWith({ key: '16x9', aspect: '16:9', fill: 'blur' }, [mask]);
    const box = { x: 300, y: 700, w: 900, h: 120 };
    const o = overrideFromBox(mask, box, 'bottom-center', '16x9');
    expect(o).toEqual({ anchor: 'bottom-center', margin: [-0.1094, 0.2407], width: 0.4688, height: 0.1111 });
    const next = { ...spec, outputs: [spec.outputs[0], { ...spec.outputs[1], layer_overrides: { m: o } }] };
    const r = resolveLayerBox(next, mask, next.outputs[1], 1, 1080, 1920);
    expect(r.x).toBeCloseTo(300, 0);
    expect(r.y).toBeCloseTo(700, 0);
    expect(r.w).toBeCloseTo(900, 0);
    expect(r.h).toBeCloseTo(120, 0);
    expect(overrideFromBox(sticker, box, 'top-left', '1x1', 12.34)).toMatchObject({ rotate: 12.3 });
    expect('height' in overrideFromBox(sticker, box, 'top-left', '1x1')).toBe(false);
  });
  it('placementOfBox 与 placeLayer 互逆', () => {
    const box = { x: 100, y: 200, w: 400, h: 100 };
    const { placement, aspect, canvas } = placementOfBox(box, 'center-right', '4x5');
    const back = placeLayer(placement, aspect, canvas);
    expect(back.x).toBeCloseTo(100);
    expect(back.y).toBeCloseTo(200);
    expect(back.h).toBeCloseTo(100);
  });
});

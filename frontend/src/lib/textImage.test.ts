import { describe, expect, it } from 'vitest';
import { bakedWidth, variantTextScales } from './textImage';
import { defaultTextStyle, emptySpec, type EditSpec, type TextLayer } from '../types';

describe('bakedWidth', () => {
  it('短文字按 PNG 像素宽换算', () => {
    expect(bakedWidth(540, 1080)).toBe(0.5);
  });
  it('比画布还宽的长字幕收到 1（契约 width ≤ 1，否则保存 400）', () => {
    expect(bakedWidth(1300, 1080)).toBe(1);
  });
  it('开了自动换行的框可以宽于画布，收到给定上限（HIG-37）', () => {
    expect(bakedWidth(2160, 1080, 3)).toBe(2);
    expect(bakedWidth(3400, 1080, 3)).toBe(3);
  });
  it('非法输入回退 1', () => {
    expect(bakedWidth(0, 1080)).toBe(1);
    expect(bakedWidth(NaN, 1080)).toBe(1);
  });
});

describe('variantTextScales（HIG-29）', () => {
  const layer: TextLayer = { id: 't', type: 'text', text: '标题', style: defaultTextStyle(), image_url: '/media/uploads/u.png', image_size: [540, 130], anchor: 'top-center', margin: [0, 0.06], width: 0.5, rotate: 0, opacity: 1, t: 'all' };
  const spec: EditSpec = {
    ...emptySpec(),
    layers: [layer],
    outputs: [
      { variant_key: '9x16', aspect: '9:16', fill: 'blur' },
      { variant_key: '1x1', aspect: '1:1', fill: 'blur', layer_fit: 'video' },
      { variant_key: '16x9', aspect: '16:9', fill: 'blur', layer_fit: 'video' },
      { variant_key: '4x5', aspect: '4:5', fill: 'crop', layer_fit: 'video' },
    ],
  };
  it('跳过 9x16 与倍率接近 1 的画幅，相近倍率合并', () => {
    // 1:1 / 16:9 blur 都是 0.5625 → 合成一张；4:5 crop 下 k = 1 → 用基准
    expect(variantTextScales(spec, layer, ['9x16', '1x1', '16x9', '4x5'], 1080, 1920)).toEqual([[0.5625, ['1x1', '16x9']]]);
  });
  it('手动微调放大时按放大倍率渲染；没有基准尺寸时不渲染', () => {
    const tuned: EditSpec = { ...spec, outputs: spec.outputs.map((o) => (o.variant_key === '4x5' ? { ...o, layer_overrides: { t: { width: 1 } } } : o)) };
    expect(variantTextScales(tuned, layer, ['4x5'], 1080, 1920)).toEqual([[2, ['4x5']]]);
    expect(variantTextScales(spec, { ...layer, image_size: null }, ['1x1'], 1080, 1920)).toEqual([]);
  });
});

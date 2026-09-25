import { describe, expect, it } from 'vitest';
import { fitLayerToCanvas, resetLayerPlacement } from './canvasPlacement';
import type { Layer } from '../types';

const sticker = { id: 's', type: 'sticker', asset_id: 'a', anchor: 'top-left', margin: [0.2, 0.3], width: 0.8, rotate: 12, opacity: 1, t: 'all' } as Layer;

describe('fitLayerToCanvas', () => {
  it('宽素材适应画布宽并居中', () => {
    expect(fitLayerToCanvas(sticker, 2, { W: 100, H: 200 })).toEqual({ anchor: 'center', margin: [0, 0], width: 1, rotate: 0 });
  });

  it('窄素材受画布高度约束', () => {
    expect(fitLayerToCanvas(sticker, 0.25, { W: 100, H: 200 }).width).toBe(0.5);
  });

  it('形状同步保持高宽比', () => {
    const shape = { ...sticker, type: 'shape', shape: 'rect', height: 0.3 } as Layer;
    expect(fitLayerToCanvas(shape, 1, { W: 100, H: 200 })).toMatchObject({ width: 1, height: 0.5 });
  });
});

describe('resetLayerPlacement', () => {
  it('贴纸回到新增时的默认位置和尺寸', () => {
    expect(resetLayerPlacement(sticker)).toEqual({ anchor: 'top-left', margin: [0.08, 0.12], width: 0.35, rotate: 0 });
  });
});

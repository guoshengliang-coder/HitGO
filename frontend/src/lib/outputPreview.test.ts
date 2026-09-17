import { describe, expect, it } from 'vitest';
import { fitPlayerBox } from './outputPreview';

describe('fitPlayerBox', () => {
  it('竖版 9:16 受高度限制', () => {
    expect(fitPlayerBox(1080, 1920, 900, 640)).toEqual({ width: 360, height: 640 });
  });

  it('横版 16:9 受宽度限制', () => {
    expect(fitPlayerBox(1920, 1080, 800, 700)).toEqual({ width: 800, height: 450 });
  });

  it('方形取两边较小的', () => {
    expect(fitPlayerBox(1080, 1080, 500, 600)).toEqual({ width: 500, height: 500 });
  });

  it('没有宽高时按 16:9', () => {
    expect(fitPlayerBox(undefined, 0, 1600, 2000)).toEqual({ width: 1600, height: 900 });
  });

  it('可用区域非法时不返回 0', () => {
    const box = fitPlayerBox(1080, 1920, 0, -10);
    expect(box.width).toBeGreaterThanOrEqual(1);
    expect(box.height).toBeGreaterThanOrEqual(1);
  });
});

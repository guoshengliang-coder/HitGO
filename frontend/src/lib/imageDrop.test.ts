import { describe, expect, it } from 'vitest';
import { assetAspect, canvasDropMargin, defaultMargin, IMAGE_ACCEPT, newStickerLayer, timelineDropWindow } from './imageDrop';
import { splitByAccept } from './fileDrop';

describe('IMAGE_ACCEPT', () => {
  it('只收 JPG / PNG（按扩展名或 MIME）', () => {
    const files = [
      { name: 'a.PNG', type: '' },
      { name: 'b.jpeg', type: 'image/jpeg' },
      { name: 'c', type: 'image/png' },
      { name: 'd.webp', type: 'image/webp' },
      { name: 'e.mp4', type: 'video/mp4' },
    ];
    const { accepted, rejected } = splitByAccept(files, IMAGE_ACCEPT);
    expect(accepted.map((f) => f.name)).toEqual(['a.PNG', 'b.jpeg', 'c']);
    expect(rejected.map((f) => f.name)).toEqual(['d.webp', 'e.mp4']);
  });
});

describe('newStickerLayer', () => {
  it('默认值与贴纸面板点选添加一致', () => {
    expect(newStickerLayer('l_1', { id: 'a_1', kind: 'image' })).toEqual({ id: 'l_1', type: 'sticker', asset_id: 'a_1', anchor: 'top-left', margin: [0.08, 0.12], width: 0.35, rotate: 0, opacity: 1, t: 'all' });
  });
  it('视频贴纸默认循环；可覆盖位置与时段', () => {
    const l = newStickerLayer('l_2', { id: 'a_2', kind: 'video' }, { margin: [0.1, 0.2], t: [1, 5] });
    expect(l).toMatchObject({ playback: 'loop', margin: [0.1, 0.2], t: [1, 5] });
  });
});

describe('assetAspect', () => {
  it('宽高已知时取宽 / 高，否则按 1', () => {
    expect(assetAspect({ width: 600, height: 300 })).toBe(2);
    expect(assetAspect({ width: 0, height: 300 })).toBe(1);
    expect(assetAspect(undefined)).toBe(1);
  });
});

describe('canvasDropMargin', () => {
  it('图片中心对准落点', () => {
    // 宽 0.35；方图在 9:16 画布上高 0.35×1080/1920 = 0.196875
    expect(canvasDropMargin({ x: 0.5, y: 0.5 }, 1)).toEqual([0.325, 0.402]);
  });
  it('落在边上时收进画布内', () => {
    expect(canvasDropMargin({ x: 0, y: 0 }, 1)).toEqual([0, 0]);
    expect(canvasDropMargin({ x: 1.2, y: 1 }, 1)).toEqual([0.65, 0.803]);
  });
  it('多张依次往右下错开', () => {
    const [x0, y0] = canvasDropMargin({ x: 0.5, y: 0.5 }, 1, 0);
    const [x1, y1] = canvasDropMargin({ x: 0.5, y: 0.5 }, 1, 1);
    expect(x1 - x0).toBeCloseTo(0.03);
    expect(y1 - y0).toBeCloseTo(0.03);
  });
  it('defaultMargin 从面板默认位置开始错开', () => {
    expect(defaultMargin()).toEqual([0.08, 0.12]);
    expect(defaultMargin(2)).toEqual([0.14, 0.18]);
  });
});

describe('timelineDropWindow', () => {
  it('落在开头为全程，其余从落点显示到片尾', () => {
    expect(timelineDropWindow(0.02, 20)).toBe('all');
    expect(timelineDropWindow(3.456, 20)).toEqual([3.46, 20]);
  });
  it('太靠后时往前挪够 0.1 s；片子太短时全程', () => {
    expect(timelineDropWindow(25, 20)).toEqual([19.9, 20]);
    expect(timelineDropWindow(0, 0.05)).toBe('all');
  });
});

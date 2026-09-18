import { describe, expect, it } from 'vitest';
import { boxFromStage, boxFromTransform, boxToStage, clampScrollBox, MIN_BOX } from './scrollBoxDrag';

describe('clampScrollBox', () => {
  it('框在范围内时原样返回（只做四位取整）', () => {
    expect(clampScrollBox({ x: 0.06, y: 0.14, w: 0.88, h: 0.6 })).toEqual({ x: 0.06, y: 0.14, w: 0.88, h: 0.6 });
  });

  it('拖出画面右下角时把位置收回来，宽高不缩水', () => {
    expect(clampScrollBox({ x: 0.5, y: 0.6, w: 0.8, h: 0.7 })).toEqual({ x: 0.2, y: 0.3, w: 0.8, h: 0.7 });
  });

  it('拖出画面左上角时夹到 0', () => {
    expect(clampScrollBox({ x: -0.3, y: -0.1, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  it('捏得太小时给到下限，超过整屏时夹到 1', () => {
    expect(clampScrollBox({ x: 0.1, y: 0.1, w: 0.001, h: 0.001 })).toMatchObject({ w: MIN_BOX, h: MIN_BOX });
    expect(clampScrollBox({ x: 0, y: 0, w: 1.4, h: 2 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('满宽满高的框位置只能是 0（x + w ≤ 1 的边界）', () => {
    expect(clampScrollBox({ x: 0.3, y: 0.2, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('boxFromStage / boxToStage', () => {
  const stage = { w: 540, h: 960 };

  it('像素与比例互为逆运算', () => {
    const box = { x: 0.06, y: 0.14, w: 0.88, h: 0.6 };
    expect(boxFromStage(boxToStage(box, stage), stage)).toEqual(box);
  });

  it('舞台尺寸未知时退回整屏，不抛', () => {
    expect(boxFromStage({ x: 0, y: 0, width: 10, height: 10 }, { w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('拖到画面外的像素同样被夹住', () => {
    expect(boxFromStage({ x: -50, y: 0, width: 270, height: 480 }, stage)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });
});

describe('boxFromTransform', () => {
  const node = (x: number, y: number, w: number, h: number, sx: number, sy: number) => ({
    x: () => x, y: () => y, width: () => w, height: () => h, scaleX: () => sx, scaleY: () => sy,
  });

  it('把 scaleX / scaleY 折进宽高——直接读 width() 会拿到缩放前的值', () => {
    expect(boxFromTransform(node(0, 0, 270, 480, 2, 1), { w: 540, h: 960 })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  it('负缩放（把手拖过了对边）按绝对值算', () => {
    expect(boxFromTransform(node(0, 0, 270, 480, -1, 1), { w: 540, h: 960 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });
});

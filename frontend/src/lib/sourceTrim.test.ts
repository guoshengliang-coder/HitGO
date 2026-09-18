import { describe, expect, it } from 'vitest';
import { clampSourceIn, clampSourceOut, MIN_SOURCE_SEGMENT, retrimForAsset, sourceSegment } from './sourceTrim';

describe('sourceSegment', () => {
  it('没有裁剪时就是整个素材', () => {
    expect(sourceSegment({}, 6)).toEqual({ start: 0, end: 6, length: 6, trimmed: false });
    expect(sourceSegment(undefined, 6).trimmed).toBe(false);
  });
  it('只写出点时入点按 0', () => {
    expect(sourceSegment({ source_out: 2.5 }, 6)).toEqual({ start: 0, end: 2.5, length: 2.5, trimmed: true });
  });
  it('只写入点时出点按素材时长', () => {
    expect(sourceSegment({ source_in: 1.5 }, 6)).toEqual({ start: 1.5, end: 6, length: 4.5, trimmed: true });
  });
  it('出点超出素材时长时夹到素材尾（与后端一致）', () => {
    expect(sourceSegment({ source_in: 1, source_out: 99 }, 6)).toEqual({ start: 1, end: 6, length: 5, trimmed: true });
  });
  it('入点落在素材之外时整个丢弃裁剪，按整段处理（与后端 resolve_source_trim 一致）', () => {
    expect(sourceSegment({ source_in: 9, source_out: 9.5 }, 6).trimmed).toBe(false);
    expect(sourceSegment({ source_in: 9, source_out: 9.5 }, 6).length).toBe(6);
  });
  it('素材时长未知（还在预处理）时不夹出点', () => {
    expect(sourceSegment({ source_in: 1, source_out: 3 }, 0)).toEqual({ start: 1, end: 3, length: 2, trimmed: true });
  });
});

describe('clampSourceIn / clampSourceOut', () => {
  it('入点给出点留够最短片段', () => {
    expect(clampSourceIn(5, 2.5, 6)).toBe(2.5 - MIN_SOURCE_SEGMENT);
    expect(clampSourceIn(-3, 2.5, 6)).toBe(0);
    expect(clampSourceIn(1.234, 6, 6)).toBe(1.23);
  });
  it('出点给入点留够最短片段，且不越过素材尾', () => {
    expect(clampSourceOut(0, 1.5, 6)).toBe(1.5 + MIN_SOURCE_SEGMENT);
    expect(clampSourceOut(99, 1.5, 6)).toBe(6);
    expect(clampSourceOut(3.456, 1, 6)).toBe(3.46);
  });
  it('非数值退回边界，不产生 NaN', () => {
    expect(clampSourceIn(NaN, 3, 6)).toBe(0);
    expect(clampSourceOut(NaN, 1, 6)).toBe(6);
  });
});

describe('retrimForAsset（替换素材）', () => {
  it('新素材放得下时原样保留', () => {
    expect(retrimForAsset({ source_in: 1, source_out: 3 }, 10)).toEqual({ source_in: 1, source_out: 3 });
  });
  it('新素材更短时收到新时长内', () => {
    expect(retrimForAsset({ source_in: 1, source_out: 8 }, 4)).toEqual({ source_in: 1, source_out: 4 });
  });
  it('新素材短到放不下那一段时整个去掉裁剪', () => {
    expect(retrimForAsset({ source_in: 5, source_out: 8 }, 2)).toEqual({});
  });
  it('原本就没裁剪、或新素材是图片时都不写字段', () => {
    expect(retrimForAsset({}, 10)).toEqual({});
    expect(retrimForAsset({ source_in: 1, source_out: 3 }, 0)).toEqual({});
  });
});

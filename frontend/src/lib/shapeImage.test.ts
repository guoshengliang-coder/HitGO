import { describe, expect, it } from 'vitest';
import { shapePixelSize } from './shapeImage';

describe('shapePixelSize', () => {
  it('keeps independent width and height on the reference canvas', () => {
    expect(shapePixelSize({ width: 0.3, height: 0.1 })).toEqual([324, 192]);
    expect(shapePixelSize({ width: 0.1, height: 0.3 })).toEqual([108, 576]);
  });
});

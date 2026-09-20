import { describe, expect, it } from 'vitest';
import { timelineAutoScrollDelta } from './timelineAutoScroll';

describe('timelineAutoScrollDelta', () => {
  it('stays still in the safe centre', () => {
    expect(timelineAutoScrollDelta(300, 100, 500, 16)).toBe(0);
  });

  it('scrolls left/right and gets faster toward the edge', () => {
    const nearLeft = timelineAutoScrollDelta(140, 100, 500, 16);
    const atLeft = timelineAutoScrollDelta(100, 100, 500, 16);
    expect(nearLeft).toBeLessThan(0);
    expect(atLeft).toBeLessThan(nearLeft);
    expect(timelineAutoScrollDelta(500, 100, 500, 16)).toBeCloseTo(-atLeft);
  });

  it('caps long frames so a resumed tab cannot jump across the timeline', () => {
    expect(timelineAutoScrollDelta(500, 100, 500, 1000)).toBe(
      timelineAutoScrollDelta(500, 100, 500, 50),
    );
  });
});

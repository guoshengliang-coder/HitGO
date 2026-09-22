import { describe, expect, it } from 'vitest';
import { makeTimelineAxis } from './timelineAxis';

describe('makeTimelineAxis', () => {
  const remove: [number, number][] = [[2, 4], [6, 7]];

  it('collapsed: removed footage takes no room and later content closes up', () => {
    const axis = makeTimelineAxis({ collapsed: true, duration: 10, remove });
    expect(axis.length).toBeCloseTo(7);
    expect(axis.srcToAxis(1)).toBeCloseTo(1);
    expect(axis.srcToAxis(3)).toBeCloseTo(2); // inside a cut → the join
    expect(axis.srcToAxis(5)).toBeCloseTo(3);
    expect(axis.srcToAxis(10)).toBeCloseTo(7);
    expect(axis.postToAxis(4.5)).toBe(4.5);
    expect(axis.visibleSpans).toEqual([[0, 2], [4, 6], [7, 10]]);
    expect(axis.joins).toEqual([2, 4]);
  });

  it('collapsed: axis → source lands on kept footage and round-trips', () => {
    const axis = makeTimelineAxis({ collapsed: true, duration: 10, remove });
    expect(axis.axisToSrc(2)).toBeCloseTo(4); // a join resumes after the cut
    for (const v of [0, 1, 2.5, 3.9, 5, 6.5, 7]) expect(axis.srcToAxis(axis.axisToSrc(v))).toBeCloseTo(v);
  });

  it('collapsed: a cut at the very start or end leaves no join', () => {
    const axis = makeTimelineAxis({ collapsed: true, duration: 10, remove: [[0, 3], [8, 10]] });
    expect(axis.length).toBeCloseTo(5);
    expect(axis.joins).toEqual([]);
    expect(axis.srcToAxis(3)).toBeCloseTo(0);
  });

  it('expanded keeps the source clock and maps post-cut windows back onto it', () => {
    const axis = makeTimelineAxis({ collapsed: false, duration: 10, remove });
    expect(axis.length).toBe(10);
    expect(axis.srcToAxis(3)).toBe(3);
    expect(axis.postToAxis(3)).toBeCloseTo(5);
    expect(axis.axisToPost(5)).toBeCloseTo(3);
    expect(axis.visibleSpans).toEqual([[0, 10]]);
    expect(axis.joins).toEqual([]);
  });

  it('loop fill continues after the main track in both modes', () => {
    const collapsed = makeTimelineAxis({ collapsed: true, duration: 10, remove, extra: 3 });
    expect(collapsed.length).toBeCloseTo(10);
    expect(collapsed.srcToAxis(12)).toBeCloseTo(9);
    expect(collapsed.axisToSrc(9)).toBeCloseTo(12);
    const expanded = makeTimelineAxis({ collapsed: false, duration: 10, remove, extra: 3 });
    expect(expanded.length).toBe(13);
    expect(expanded.postToAxis(9)).toBeCloseTo(12);
    expect(expanded.axisToPost(12)).toBeCloseTo(9);
  });
});

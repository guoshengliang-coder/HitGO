import { describe, expect, it } from 'vitest';
import { shouldSeekTimelineClip } from './timelinePointer';

const pointer = (over: Partial<Parameters<typeof shouldSeekTimelineClip>[0]> = {}) => ({
  button: 0, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...over,
});

describe('shouldSeekTimelineClip', () => {
  it('普通左键点击定位，Option 仍可单选并定位', () => {
    expect(shouldSeekTimelineClip(pointer())).toBe(true);
    expect(shouldSeekTimelineClip(pointer({ altKey: true }))).toBe(true);
  });

  it('组合选择与非左键不改变播放头', () => {
    expect(shouldSeekTimelineClip(pointer({ metaKey: true }))).toBe(false);
    expect(shouldSeekTimelineClip(pointer({ ctrlKey: true }))).toBe(false);
    expect(shouldSeekTimelineClip(pointer({ shiftKey: true }))).toBe(false);
    expect(shouldSeekTimelineClip(pointer({ button: 2 }))).toBe(false);
  });
});

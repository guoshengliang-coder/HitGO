import { describe, expect, it } from 'vitest';
import { isDue, previewIntervalMs, SELECTED_INTERVAL_MS, UNSELECTED_INTERVAL_MS } from './previewClock';

describe('previewIntervalMs', () => {
  it('不在视口里就不画', () => {
    expect(previewIntervalMs({ playing: true, selected: true, visible: false })).toBeNull();
    expect(previewIntervalMs({ playing: false, selected: true, visible: false })).toBeNull();
  });

  it('暂停时立刻画（间隔 0），不区分选中与否', () => {
    expect(previewIntervalMs({ playing: false, selected: true, visible: true })).toBe(0);
    expect(previewIntervalMs({ playing: false, selected: false, visible: true })).toBe(0);
  });

  it('播放时选中变体每帧画，未选中变体降频', () => {
    expect(previewIntervalMs({ playing: true, selected: true, visible: true })).toBe(SELECTED_INTERVAL_MS);
    expect(previewIntervalMs({ playing: true, selected: false, visible: true })).toBe(UNSELECTED_INTERVAL_MS);
    expect(UNSELECTED_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('isDue', () => {
  it('从未画过时立刻到期', () => {
    expect(isDue(0, -Infinity, 125)).toBe(true);
    expect(isDue(1000, -Infinity, 0)).toBe(true);
  });

  it('间隔为 0 时每次都到期', () => {
    expect(isDue(1000, 1000, 0)).toBe(true);
  });

  it('恰好等于间隔算到期，差一点不算', () => {
    expect(isDue(1125, 1000, 125)).toBe(true);
    expect(isDue(1124.9, 1000, 125)).toBe(false);
  });

  it('时钟回退时不卡死', () => {
    expect(isDue(500, 1000, 125)).toBe(true);
  });
});

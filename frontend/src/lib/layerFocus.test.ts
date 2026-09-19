import { describe, expect, it } from 'vitest';
import { defaultTextStyle, type TextLayer } from '../types';
import { layerFocusTime } from './layerFocus';

const layer: TextLayer = { id: 'subtitle', type: 'text', origin: 'subtitle', text: '字幕', style: defaultTextStyle(), anchor: 'center', margin: [0, 0], width: 0.5, rotate: 0, opacity: 1, t: [3, 5] };

describe('主动选中定位', () => {
  it('时段外定位到开始，时段内保留原来的画面，结束边界属于时段外', () => {
    expect(layerFocusTime(layer, 0, 10)).toBe(3);
    expect(layerFocusTime(layer, 3, 10)).toBeNull();
    expect(layerFocusTime(layer, 4, 10)).toBeNull();
    expect(layerFocusTime(layer, 5, 10)).toBe(3);
  });
  it('全程图层保留当前帧，但选中时离开封面', () => {
    expect(layerFocusTime({ ...layer, t: 'all' }, 4, 10)).toBeNull();
    expect(layerFocusTime({ ...layer, t: 'all' }, -1, 10)).toBe(0);
  });
  it('跨过透明首帧和入场延迟，不越出很短的字幕时段', () => {
    const animated = { ...layer, animation: { in: { preset: 'fade' as const, duration: 0.5, delay: 1.2 } } };
    expect(layerFocusTime(animated, 0, 10)).toBeCloseTo(4.3);
    expect(layerFocusTime({ ...animated, t: [3, 3.05] }, 0, 10)).toBeLessThan(3.05);
    expect(layerFocusTime(animated, 4.5, 10)).toBeNull();
  });
  it('超出成片的图层不能定位到成片之外', () => {
    expect(layerFocusTime(layer, 0, 2)).toBeNull();
  });
});

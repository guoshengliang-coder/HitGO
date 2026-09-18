import { describe, expect, it } from 'vitest';
import { layerLane } from './timelineTracks';
import { defaultTextStyle, type Layer } from '../types';

const text = (overrides: Record<string, unknown> = {}): Layer => ({
  id: 'l', type: 'text', text: 'test', style: defaultTextStyle(), anchor: 'center',
  margin: [0, 0], width: 0.5, rotate: 0, opacity: 1, t: 'all', ...overrides,
} as Layer);

describe('timeline layer lanes', () => {
  it('keeps imported and localized captions separate from ordinary text', () => {
    expect(layerLane(text({ origin: 'subtitle' }))).toBe('subtitle');
    expect(layerLane(text({ origin: 'localize' }))).toBe('subtitle');
    expect(layerLane(text({ name: '字幕 3' }))).toBe('subtitle');
    expect(layerLane(text())).toBe('text');
  });
  it('keeps masks with subtitles and other visual layers visible', () => {
    expect(layerLane({ id: 'm', type: 'mask' } as Layer)).toBe('subtitle');
    expect(layerLane({ id: 's', type: 'sticker' } as Layer)).toBe('other');
  });
});

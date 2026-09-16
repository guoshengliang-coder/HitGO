import { describe, expect, it } from 'vitest';
import { hasPreparingVideos, nextCurrentAfterDelete } from './videos';

const vs = (...ids: string[]) => ids.map((id) => ({ id }));

describe('hasPreparingVideos', () => {
  it('is true only while some video is still preparing', () => {
    expect(hasPreparingVideos([{ status: 'ready' }, { status: 'preparing' }])).toBe(true);
    expect(hasPreparingVideos([{ status: 'ready' }, { status: 'failed' }])).toBe(false);
    expect(hasPreparingVideos([])).toBe(false);
  });
});

describe('nextCurrentAfterDelete', () => {
  it('keeps the current video when it survives', () => {
    expect(nextCurrentAfterDelete(vs('a', 'b', 'c'), 'a', ['b'])).toBe('a');
  });

  it('moves to the next surviving video after the deleted current one', () => {
    expect(nextCurrentAfterDelete(vs('a', 'b', 'c', 'd'), 'b', ['b', 'c'])).toBe('d');
  });

  it('falls back to the previous one when the tail was deleted', () => {
    expect(nextCurrentAfterDelete(vs('a', 'b', 'c'), 'c', ['b', 'c'])).toBe('a');
  });

  it('returns null when nothing is left', () => {
    expect(nextCurrentAfterDelete(vs('a', 'b'), 'a', ['a', 'b'])).toBeNull();
  });

  it('picks the first survivor when there was no current video', () => {
    expect(nextCurrentAfterDelete(vs('a', 'b'), null, ['a'])).toBe('b');
  });
});

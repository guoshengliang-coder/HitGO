import { describe, expect, it } from 'vitest';
import { timelineThumbnails } from './timelineThumbnails';
import type { Video } from '../types';

const a = { id: 'a', duration: 4, sprite: { url: '/a.jpg', interval: 1, tile_width: 90, tile_height: 160, columns: 4, count: 4 } } as Video;
const b = { ...a, id: 'b', sprite: { ...a.sprite!, url: '/b.jpg' } };
describe('same thumbnail strip for single and composed videos', () => {
  it('one full clip has exactly the same style geometry as a single source', () => {
    expect(timelineThumbnails(a, { clips: [{ id: '1', video_id: 'a', in: 0, out: 4 }] }, [a], 40)).toEqual(timelineThumbnails(a, null, [a], 40));
  });
  it('uses each source sprite and stays continuous across trimmed clips and transitions', () => {
    const tiles = timelineThumbnails(a, { clips: [{ id: '1', video_id: 'a', in: 0.5, out: 2 }, { id: '2', video_id: 'b', in: 1, out: 3, transition: { type: 'fade', duration: 0.2 } }] }, [a, b], 100);
    expect(tiles[0].backgroundImage).toContain('/a.jpg');
    expect(tiles[tiles.length - 1].backgroundImage).toContain('/b.jpg');
    expect(tiles.reduce((n, t) => n + t.width, 0)).toBeCloseTo(330);
    tiles.slice(1).forEach((t, i) => expect(t.left).toBeCloseTo(tiles[i].left + tiles[i].width));
  });
  it('repeats the final source tile across a held frame', () => {
    const tiles = timelineThumbnails(a, { clips: [{ id: 'held', video_id: 'a', in: 0, out: 1, hold_after: 1 }] }, [a], 100);
    expect(tiles.reduce((n, tile) => n + tile.width, 0)).toBeCloseTo(200);
    expect(tiles.every((tile) => tile.backgroundPosition === tiles[0].backgroundPosition)).toBe(true);
  });
});

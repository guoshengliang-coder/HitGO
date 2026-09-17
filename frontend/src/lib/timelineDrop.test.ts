import { describe, expect, it } from 'vitest';
import { ASSET_DRAG_MIME, dropRole, dropWindow, encodeAssetDrag, isAssetDrag, parseAssetDrag } from './timelineDrop';

describe('asset drag payload', () => {
  it('round-trips and rejects foreign data', () => {
    expect(parseAssetDrag(encodeAssetDrag({ id: 'a_1', type: 'audio' }))).toEqual({ id: 'a_1', type: 'audio' });
    expect(parseAssetDrag('l_123')).toBeNull(); // 图层排序写的 text/plain
    expect(parseAssetDrag('{"id":""}')).toBeNull();
    expect(parseAssetDrag(undefined)).toBeNull();
  });
  it('recognises card drags by type only (dragover cannot read data)', () => {
    expect(isAssetDrag([ASSET_DRAG_MIME])).toBe(true);
    expect(isAssetDrag(['Files'])).toBe(false);
    expect(isAssetDrag(['text/plain'])).toBe(false);
    expect(isAssetDrag(null)).toBe(false);
  });
});

describe('dropRole', () => {
  it('voice only on a voice row', () => {
    expect(dropRole('voice')).toBe('voice');
    expect(dropRole('bgm')).toBe('bgm');
    expect(dropRole(null)).toBe('bgm');
  });
});

describe('dropWindow', () => {
  it('bgm dropped at the start covers the whole video like "+ BGM"', () => {
    expect(dropWindow({ start: 0.02, role: 'bgm', postDuration: 20 })).toBe('all');
  });
  it('bgm dropped later runs from the drop point to the end', () => {
    expect(dropWindow({ start: 3.456, role: 'bgm', postDuration: 20, mediaDuration: 5 })).toEqual([3.46, 20]);
  });
  it('voice plays once from the drop point, clipped to the post-trim end', () => {
    expect(dropWindow({ start: 2, role: 'voice', postDuration: 20, mediaDuration: 4 })).toEqual([2, 6]);
    expect(dropWindow({ start: 18, role: 'voice', postDuration: 20, mediaDuration: 4 })).toEqual([18, 20]);
    expect(dropWindow({ start: 0, role: 'voice', postDuration: 20, mediaDuration: 4 })).toEqual([0, 4]);
  });
  it('voice with unknown duration runs to the end', () => {
    expect(dropWindow({ start: 5, role: 'voice', postDuration: 20 })).toEqual([5, 20]);
  });
  it('keeps a valid window when dropped at or past the end', () => {
    expect(dropWindow({ start: 25, role: 'voice', postDuration: 20, mediaDuration: 4 })).toEqual([19.9, 20]);
    expect(dropWindow({ start: -3, role: 'voice', postDuration: 20, mediaDuration: 4 })).toEqual([0, 4]);
  });
  it('falls back to all for a degenerate post-trim duration', () => {
    expect(dropWindow({ start: 0, role: 'voice', postDuration: 0.05 })).toBe('all');
  });
});

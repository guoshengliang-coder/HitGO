import { describe, expect, it } from 'vitest';
import { ASSET_DRAG_MIME, assetDragType, assetDragTypeMime, dropKind, dropRole, dropWindow, encodeAssetDrag, isAssetDrag, parseAssetDrag } from './timelineDrop';

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

describe('dropKind（HIG-46）', () => {
  it('卡片看类型标记', () => {
    expect(assetDragType([ASSET_DRAG_MIME, assetDragTypeMime('sticker')])).toBe('sticker');
    expect(assetDragType([ASSET_DRAG_MIME])).toBeNull();
    expect(dropKind([ASSET_DRAG_MIME, assetDragTypeMime('sticker')], [])).toBe('sticker');
    expect(dropKind([ASSET_DRAG_MIME, assetDragTypeMime('audio')], [])).toBe('audio');
  });
  it('系统文件全是图片或视频才算叠加素材（视频 HIG-67）', () => {
    const file = (type: string) => ({ kind: 'file', type });
    expect(dropKind(['Files'], [file('image/png'), file('image/jpeg')])).toBe('sticker');
    expect(dropKind(['Files'], [file('video/mp4')])).toBe('sticker');
    expect(dropKind(['Files'], [file('image/png'), file('video/quicktime')])).toBe('sticker');
    expect(dropKind(['Files'], [file('image/png'), file('audio/mpeg')])).toBe('audio');
    expect(dropKind(['Files'], [file('video/mp4'), file('audio/mpeg')])).toBe('audio');
    expect(dropKind(['Files'], [file('')])).toBe('audio');
    expect(dropKind(['Files'], [])).toBe('audio');
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

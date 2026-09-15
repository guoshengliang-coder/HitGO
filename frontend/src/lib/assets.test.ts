import { describe, expect, it } from 'vitest';
import type { Asset } from '../types';
import { bucketOf, canDelete, filterAssets, oversizedUpload, uploadLimit, UPLOAD_LIMITS } from './assets';

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id,
  type: 'sticker',
  name: `${id}.png`,
  url: `/media/assets/${id}.png`,
  source: 'upload',
  created_at: '2026-09-15T00:00:00Z',
  ...over,
});

const ALL: Asset[] = [
  asset('a_mine', { name: '限时免费.png' }),
  asset('a_builtin', { name: '内置示例.png', source: 'builtin' }),
  asset('a_library', { name: '物料库来的.png', source: 'library' }),
  asset('a_font', { type: 'font', name: 'Alibaba PuHuiTi.ttf', family: 'Alibaba PuHuiTi' }),
];

describe('bucketOf', () => {
  it('只有 upload 归「我上传的」，builtin 与 library 都归「原料库」', () => {
    expect(bucketOf(ALL[0])).toBe('mine');
    expect(bucketOf(ALL[1])).toBe('library');
    expect(bucketOf(ALL[2])).toBe('library');
  });
});

describe('canDelete', () => {
  it('只有自己上传的能删', () => {
    expect(ALL.map(canDelete)).toEqual([true, false, false, true]);
  });
});

describe('filterAssets', () => {
  it('不给条件时原样返回', () => {
    expect(filterAssets(ALL)).toHaveLength(4);
  });

  it('按类型筛选', () => {
    expect(filterAssets(ALL, { type: 'font' }).map((a) => a.id)).toEqual(['a_font']);
  });

  it('「我上传的」不含 builtin —— 这正是修掉的缺陷', () => {
    expect(filterAssets(ALL, { type: 'sticker', bucket: 'mine' }).map((a) => a.id)).toEqual(['a_mine']);
  });

  it('「原料库」同时含 builtin 与 library，为正式物料库接入预留', () => {
    expect(filterAssets(ALL, { type: 'sticker', bucket: 'library' }).map((a) => a.id)).toEqual([
      'a_builtin',
      'a_library',
    ]);
  });

  it('关键词大小写不敏感、忽略前后空白', () => {
    expect(filterAssets(ALL, { q: '  alibaba ' }).map((a) => a.id)).toEqual(['a_font']);
  });

  it('空关键词不参与筛选', () => {
    expect(filterAssets(ALL, { bucket: 'mine', q: '   ' })).toHaveLength(2);
  });

  it('筛不到时返回空数组而不是抛错', () => {
    expect(filterAssets(ALL, { type: 'font', bucket: 'library' })).toEqual([]);
    expect(filterAssets([], { bucket: 'mine' })).toEqual([]);
  });
});

describe('上传大小校验', () => {
  const MiB = 1024 * 1024;

  it('视频贴纸 1 GiB，图片贴纸 10 MiB，字体 20 MiB', () => {
    expect(uploadLimit('sticker', '片头.MP4')).toBe(UPLOAD_LIMITS.video);
    expect(uploadLimit('sticker', 'a.mov')).toBe(1024 * MiB);
    expect(uploadLimit('sticker', 'a.webm')).toBe(1024 * MiB);
    // 多帧 gif / webp 在后端仍按图片上限
    expect(uploadLimit('sticker', 'a.gif')).toBe(10 * MiB);
    expect(uploadLimit('font', 'a.ttf')).toBe(20 * MiB);
  });

  it('100 多 MB 的视频贴纸不再被挡（HIG-6）', () => {
    expect(oversizedUpload('sticker', [{ name: 'big.mp4', size: 130 * MiB }])).toBeNull();
  });

  it('返回第一个超限文件的提示', () => {
    expect(
      oversizedUpload('sticker', [
        { name: 'ok.png', size: 1 * MiB },
        { name: 'huge.mov', size: 1025 * MiB },
        { name: 'big.png', size: 11 * MiB },
      ]),
    ).toBe('huge.mov：文件超过 1 GiB 上限');
    expect(oversizedUpload('sticker', [{ name: 'big.png', size: 11 * MiB }])).toBe('big.png：文件超过 10 MiB 上限');
  });
});

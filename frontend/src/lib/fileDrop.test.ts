import { describe, expect, it } from 'vitest';
import { VIDEO_ACCEPT, isFileDrag, mergeFiles, rejectedText, splitByAccept } from './fileDrop';

const f = (name: string, type = '') => ({ name, type });

describe('isFileDrag', () => {
  it('only reacts to drags that carry files', () => {
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag(['text/plain'])).toBe(false); // 图层排序
    expect(isFileDrag([])).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe('splitByAccept', () => {
  it('matches by extension case-insensitively even without a MIME type', () => {
    const { accepted, rejected } = splitByAccept([f('A.MP4'), f('b.mov'), f('c.avi', 'video/x-msvideo'), f('d.txt', 'text/plain')], VIDEO_ACCEPT);
    expect(accepted.map((x) => x.name)).toEqual(['A.MP4', 'b.mov']);
    expect(rejected.map((x) => x.name)).toEqual(['c.avi', 'd.txt']);
  });

  it('matches exact MIME types and wildcards', () => {
    expect(splitByAccept([f('clip', 'video/quicktime')], VIDEO_ACCEPT).accepted).toHaveLength(1);
    const { accepted } = splitByAccept([f('x.png', 'image/png'), f('y.mp3', 'audio/mpeg')], 'image/*');
    expect(accepted.map((x) => x.name)).toEqual(['x.png']);
  });

  it('accepts everything when accept is empty', () => {
    expect(splitByAccept([f('any.bin')], '').accepted).toHaveLength(1);
  });
});

describe('rejectedText', () => {
  it('is null when nothing was skipped', () => {
    expect(rejectedText([], 'mp4 / mov')).toBeNull();
  });

  it('lists up to three names and counts the rest', () => {
    expect(rejectedText([f('a.avi')], 'mp4 / mov')).toBe('已跳过「a.avi」：只支持 mp4 / mov');
    expect(rejectedText([f('1'), f('2'), f('3'), f('4')], 'mp4 / mov')).toBe('已跳过「1」「2」「3」等 4 个文件：只支持 mp4 / mov');
  });
});

describe('mergeFiles', () => {
  it('appends new files and skips ones with the same name and size', () => {
    const a = { name: 'a.mp4', size: 1 };
    const b = { name: 'b.mp4', size: 2 };
    const a2 = { name: 'a.mp4', size: 9 }; // 同名不同大小 = 另一个文件
    expect(mergeFiles([a], [a, b, a2, b])).toEqual([a, b, a2]);
  });
});

import { describe, expect, it } from 'vitest';
import type { Asset } from '../types';
import {
  clampCoverDuration,
  contractCover,
  coverDuration,
  coverMediaTime,
  inCover,
  isCoverAsset,
  outputTime,
  timelineTime,
  timelineX,
} from './cover';

const base = { url: '/media/x', source: 'upload', created_at: '' } as const;
const image: Asset = { ...base, id: 'a_img', type: 'sticker', name: '封面.jpg', kind: 'image', width: 720, height: 1280 };
const video: Asset = { ...base, id: 'a_vid', type: 'sticker', name: '片头.mp4', kind: 'video', status: 'ready', duration: 2.4 };
const preparing: Asset = { ...base, id: 'a_prep', type: 'sticker', name: 'p.mp4', kind: 'video', status: 'preparing' };
const font: Asset = { ...base, id: 'a_font', type: 'font', name: 'f.ttf' };
const assets = [image, video, preparing, font];

describe('coverDuration（与 worker 同一套判断）', () => {
  it('没有封面是 0', () => {
    expect(coverDuration(null, assets)).toBe(0);
    expect(coverDuration(undefined, assets)).toBe(0);
  });

  it('图片封面取 duration，缺省 1 秒并夹到 [0.1, 10]', () => {
    expect(coverDuration({ asset_id: 'a_img', duration: 2.5 }, assets)).toBe(2.5);
    expect(coverDuration({ asset_id: 'a_img' }, assets)).toBe(1);
    expect(coverDuration({ asset_id: 'a_img', duration: 30 }, assets)).toBe(10);
    expect(coverDuration({ asset_id: 'a_img', duration: 0.01 }, assets)).toBe(0.1);
  });

  it('视频封面取素材自身时长，忽略 duration；没就绪时 worker 会跳过，所以是 0', () => {
    expect(coverDuration({ asset_id: 'a_vid', duration: 9 }, assets)).toBe(2.4);
    expect(coverDuration({ asset_id: 'a_prep' }, assets)).toBe(0);
  });

  it('素材不存在或不是贴纸素材是 0', () => {
    expect(coverDuration({ asset_id: 'a_nope' }, assets)).toBe(0);
    expect(coverDuration({ asset_id: 'a_font' }, assets)).toBe(0);
    expect(isCoverAsset(font)).toBe(false);
    expect(isCoverAsset(image) && isCoverAsset(video)).toBe(true);
  });
});

describe('clampCoverDuration / contractCover', () => {
  it('保留一位小数，非法值回到 1', () => {
    expect(clampCoverDuration(1.26)).toBe(1.3);
    expect(clampCoverDuration(Number.NaN)).toBe(1);
    expect(clampCoverDuration(undefined)).toBe(1);
  });

  it('没有封面时省略字段，有封面时规范化时长', () => {
    expect(contractCover(null)).toBeUndefined();
    expect(contractCover({ asset_id: '' })).toBeUndefined();
    expect(contractCover({ asset_id: 'a_img' })).toEqual({ asset_id: 'a_img', duration: 1 });
    expect(contractCover({ asset_id: 'a_img', duration: 12 })).toEqual({ asset_id: 'a_img', duration: 10 });
  });
});

describe('封面段的时间换算', () => {
  const remove: [number, number][] = [[2, 3]];

  it('time < 0 表示在封面里，封面自己的位置是 time + N', () => {
    expect(inCover(-0.5)).toBe(true);
    expect(inCover(0)).toBe(false);
    expect(coverMediaTime(-1.5, 2)).toBe(0.5);
    expect(coverMediaTime(0, 2)).toBeNull();
  });

  it('成片时间 = 封面段 time + N，正片段 N + 剪后时间', () => {
    expect(outputTime(-2, remove, 2)).toBe(0);
    expect(outputTime(-0.5, remove, 2)).toBe(1.5);
    expect(outputTime(0, remove, 2)).toBe(2);
    expect(outputTime(4, remove, 2)).toBe(5); // 源 4s 剪后 3s
    expect(outputTime(4, remove, 0)).toBe(3); // 没封面时就是剪后时间
  });

  it('时间轴横坐标与播放头互逆，并夹到 [-N, duration]', () => {
    expect(timelineX(-2, 2, 50)).toBe(0);
    expect(timelineX(0, 2, 50)).toBe(100);
    expect(timelineTime(100, 2, 50, 10)).toBe(0);
    expect(timelineTime(25, 2, 50, 10)).toBe(-1.5);
    expect(timelineTime(-40, 2, 50, 10)).toBe(-2);
    expect(timelineTime(9999, 2, 50, 10)).toBe(10);
    expect(timelineTime(-40, 0, 50, 10)).toBeCloseTo(0); // 没封面时最左就是 0
  });
});

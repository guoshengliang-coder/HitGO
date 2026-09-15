import { describe, expect, it } from 'vitest';
import { cuesToTextLayers, parseSrt, stripSubtitleTags, type SrtCue } from './srt';
import { defaultTextStyle } from '../types';

describe('parseSrt', () => {
  it('基础两条：BOM + CRLF + 多行文本', () => {
    const src = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n你好\r\n世界\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n第二条\r\n';
    expect(parseSrt(src)).toEqual<SrtCue[]>([
      { index: 1, start: 1, end: 2.5, text: '你好\n世界' },
      { index: 2, start: 3, end: 4, text: '第二条' },
    ]);
  });

  it('毫秒分隔符点与逗号都接受，小时可省略', () => {
    const src = '1\n00:00:01.250 --> 00:00:02,750\nA\n\n2\n00:03.000 --> 00:04.000\nB\n';
    const cues = parseSrt(src);
    expect(cues[0].start).toBeCloseTo(1.25, 6);
    expect(cues[0].end).toBeCloseTo(2.75, 6);
    expect(cues[1].start).toBeCloseTo(3, 6);
    expect(cues[1].end).toBeCloseTo(4, 6);
  });

  it('去掉 HTML 与 ASS 标签', () => {
    const src = '1\n00:00:00,000 --> 00:00:01,000\n<i>斜体</i> <font color="#fff">彩色</font>{\\an8}顶部\n';
    expect(parseSrt(src)[0].text).toBe('斜体 彩色顶部');
    expect(stripSubtitleTags('<b>粗</b>  体')).toBe('粗 体');
  });

  it('跳过格式错误的块，序号行可省略，WEBVTT 头被忽略', () => {
    const src = 'WEBVTT\n\n坏块没有时间\n\n00:00:05,000 --> 00:00:06,000\n无序号\n\n3\n00:00:07,000 -> 00:00:08,000\n箭头错误\n\n4\n00:00:09,000 --> 00:00:10,000\n\n';
    const cues = parseSrt(src);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ index: 1, start: 5, end: 6, text: '无序号' });
  });

  it('按 start 排序并重新编号，end 至少 start + 0.1', () => {
    const src = '1\n00:00:10,000 --> 00:00:11,000\n后\n\n2\n00:00:02,000 --> 00:00:02,000\n前\n';
    const cues = parseSrt(src);
    expect(cues.map((c) => c.text)).toEqual(['前', '后']);
    expect(cues.map((c) => c.index)).toEqual([1, 2]);
    expect(cues[0].end).toBeCloseTo(2.1, 6);
  });

  it('空文本返回空数组', () => {
    expect(parseSrt('')).toEqual([]);
    expect(parseSrt('\r\n\r\n')).toEqual([]);
  });
});

describe('cuesToTextLayers', () => {
  const cues: SrtCue[] = [
    { index: 1, start: 1, end: 2, text: 'A' },
    { index: 2, start: 3, end: 6, text: 'B' },
    { index: 3, start: 8, end: 9, text: 'C' },
  ];

  it('图层形状：贴底居中、宽 0.8、时段与名字', () => {
    let n = 0;
    const style = defaultTextStyle();
    const layers = cuesToTextLayers(cues.slice(0, 1), { style, newId: () => `id${++n}` });
    expect(layers).toHaveLength(1);
    const l = layers[0];
    expect(l.id).toBe('id1');
    expect(l.type).toBe('text');
    expect(l.text).toBe('A');
    expect(l.anchor).toBe('bottom-center');
    expect(l.margin).toEqual([0, 0.12]);
    expect(l.width).toBe(0.8);
    expect(l.rotate).toBe(0);
    expect(l.opacity).toBe(1);
    expect(l.t).toEqual([1, 2]);
    expect(l.name).toBe('字幕 1');
    expect(l).not.toHaveProperty('width_manual');
    expect(l.style).toEqual(style);
    expect(l.style).not.toBe(style);
  });

  it('maxEnd：丢弃 start >= maxEnd 的字幕，裁剪 end，并按保留顺序编号', () => {
    let n = 0;
    const layers = cuesToTextLayers(cues, { style: defaultTextStyle(), newId: () => `id${++n}`, maxEnd: 5 });
    expect(layers.map((l) => l.t)).toEqual([
      [1, 2],
      [3, 5],
    ]);
    expect(layers.map((l) => l.name)).toEqual(['字幕 1', '字幕 2']);
  });
});

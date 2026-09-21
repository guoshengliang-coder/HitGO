import { describe, expect, it } from 'vitest';
import { emptySpec, type EditSpec, type Layer, type SequenceClip } from '../types';
import { autoSubtitleStyle, isAutoSubtitle, ownerSourceRangeToPost, replaceAutoSubtitles, transcriptToSubtitleLayers } from './autoSubtitle';
import { MAX_SUBTITLE_LAYERS } from './localize';

const specWith = (patch: Partial<EditSpec>): EditSpec => ({ ...emptySpec(), ...patch });

// B[0,4] → A[10,14] at 2x (2 s on the clock) → A[0,4]: clock windows [0,4] [4,6] [6,10]
const clips: SequenceClip[] = [
  { id: 'c1', video_id: 'B', in: 0, out: 4 },
  { id: 'c2', video_id: 'A', in: 10, out: 14, speed: 2 },
  { id: 'c3', video_id: 'A', in: 0, out: 4 },
];
const seqSpec = (remove: [number, number][] = []) => specWith({ sequence: { clips }, trim: { remove } });

let n = 0;
const newId = () => `l_${++n}`;

describe('ownerSourceRangeToPost', () => {
  it('没有 sequence：按 trim.remove 平移', () => {
    const spec = specWith({ trim: { remove: [[2, 4]] } });
    expect(ownerSourceRangeToPost(spec, 'A', [5, 6])).toEqual([[3, 4]]);
    expect(ownerSourceRangeToPost(spec, 'A', [0.5, 1.5])).toEqual([[0.5, 1.5]]);
  });

  it('整句落在删除区里丢弃，跨删除区的缩短', () => {
    const spec = specWith({ trim: { remove: [[2, 4]] } });
    expect(ownerSourceRangeToPost(spec, 'A', [2.5, 3.5])).toEqual([]);
    expect(ownerSourceRangeToPost(spec, 'A', [1, 3])).toEqual([[1, 2]]);
    expect(ownerSourceRangeToPost(spec, 'A', [1, 5])).toEqual([[1, 3]]);
    // 切剩不到 0.1s 的碎片也丢掉
    expect(ownerSourceRangeToPost(spec, 'A', [1.95, 3])).toEqual([]);
  });

  it('没有 sequence 时别的视频的时间不算', () => {
    expect(ownerSourceRangeToPost(emptySpec(), 'B', [0, 1], 'A')).toEqual([]);
  });

  it('sequence：按片段顺序和 2 倍速换算，重复引用的源落到每个片段', () => {
    expect(ownerSourceRangeToPost(seqSpec(), 'A', [11, 13])).toEqual([[4.5, 5.5]]);
    expect(ownerSourceRangeToPost(seqSpec(), 'A', [2, 12])).toEqual([[4, 5], [8, 10]]);
    expect(ownerSourceRangeToPost(seqSpec(), 'B', [1, 2])).toEqual([[1, 2]]);
    // 片段 in/out 之外的源不出现
    expect(ownerSourceRangeToPost(seqSpec(), 'A', [5, 9])).toEqual([]);
  });

  it('sequence：不在序列里的视频被忽略', () => {
    expect(ownerSourceRangeToPost(seqSpec(), 'C', [0, 3])).toEqual([]);
  });

  it('sequence：trim.remove 作用在拼接后的时钟上', () => {
    expect(ownerSourceRangeToPost(seqSpec([[4, 5]]), 'A', [11, 13])).toEqual([[4, 4.5]]);
    expect(ownerSourceRangeToPost(seqSpec([[4, 5]]), 'A', [0, 2])).toEqual([[5, 7]]);
  });

  it('sequence：转场重叠处归后一个片段', () => {
    const spec = specWith({ sequence: { clips: [{ id: 'x', video_id: 'A', in: 0, out: 4 }, { id: 'y', video_id: 'B', in: 0, out: 4, transition: { type: 'fade', duration: 1 } }] } });
    expect(ownerSourceRangeToPost(spec, 'A', [2, 4])).toEqual([[2, 3]]);
    expect(ownerSourceRangeToPost(spec, 'B', [0, 1])).toEqual([[3, 4]]);
  });
});

describe('transcriptToSubtitleLayers', () => {
  it('每个视频各自换算，按时间排序，打上 subtitle / auto 标记并套字幕条样式', () => {
    const layers = transcriptToSubtitleLayers(
      [
        { videoId: 'A', cues: [{ i: 0, start: 0.5, end: 1.5, text: '第一句' }, { i: 1, start: 11, end: 13, text: '快放那句' }], lang: 'zh' },
        { videoId: 'B', cues: [{ i: 0, start: 1, end: 2, text: 'hello' }] },
      ],
      seqSpec(),
      { ownerId: 'A', postDuration: 10, newId },
    );
    expect(layers.map((l) => [l.text, l.t])).toEqual([
      ['hello', [1, 2]],
      ['快放那句', [4.5, 5.5]],
      ['第一句', [6.5, 7.5]],
    ]);
    expect(layers.every((l) => l.origin === 'subtitle' && l.auto === true && l.type === 'text')).toBe(true);
    expect(layers[0].style.background).toBe(autoSubtitleStyle().background);
    expect(layers.map((l) => l.name)).toEqual(['字幕 1', '字幕 2', '字幕 3']);
  });

  it('长句拆成短句并摊开时段；空句、删掉的句子不生成，超出成片时长的截掉', () => {
    const text = '这是一段很长很长的话，需要拆成好几条短字幕才放得下，否则一屏放不下';
    const spec = specWith({ trim: { remove: [[20, 30]] } });
    const layers = transcriptToSubtitleLayers(
      [{ videoId: 'A', cues: [{ i: 0, start: 0, end: 6, text }, { i: 1, start: 7, end: 8, text: '  ' }, { i: 2, start: 21, end: 22, text: '删掉了' }, { i: 3, start: 31, end: 40, text: '尾巴' }], lang: 'zh' }],
      spec,
      { ownerId: 'A', postDuration: 25, newId },
    );
    const pieces = layers.filter((l) => l.text !== '尾巴');
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((l) => l.text).join('')).toBe(text.replace(/\s/g, ''));
    expect(pieces[0].t).toEqual([0, expect.any(Number)]);
    expect(pieces[pieces.length - 1].t).toEqual([expect.any(Number), 6]);
    expect(layers.find((l) => l.text === '尾巴')?.t).toEqual([21, 25]);
    expect(layers.some((l) => l.text === '删掉了')).toBe(false);
    // split: false 一句一条
    const whole = transcriptToSubtitleLayers([{ videoId: 'A', cues: [{ i: 0, start: 0, end: 6, text }] }], spec, { ownerId: 'A', postDuration: 25, newId, split: false });
    expect(whole.map((l) => l.text)).toEqual([text]);
  });

  it('条数封顶', () => {
    const cues = Array.from({ length: MAX_SUBTITLE_LAYERS + 50 }, (_, i) => ({ i, start: i, end: i + 0.8, text: `第${i}句` }));
    const layers = transcriptToSubtitleLayers([{ videoId: 'A', cues }], emptySpec(), { ownerId: 'A', postDuration: 0, newId });
    expect(layers.length).toBe(MAX_SUBTITLE_LAYERS);
  });
});

describe('replaceAutoSubtitles', () => {
  it('只换掉上一批自动字幕，手动 / .srt / 锁定的留着，新的追加在后面', () => {
    const base = transcriptToSubtitleLayers([{ videoId: 'A', cues: [{ i: 0, start: 0, end: 1, text: 'x' }] }], emptySpec(), { ownerId: 'A', postDuration: 10, newId })[0];
    const manual: Layer = { ...base, id: 'manual', auto: undefined };
    const oldAuto: Layer = { ...base, id: 'old' };
    const lockedAuto: Layer = { ...base, id: 'locked', locked: true };
    const plainText: Layer = { ...base, id: 'text', origin: undefined, auto: true };
    const fresh: Layer = { ...base, id: 'new' };
    const out = replaceAutoSubtitles([manual, oldAuto, lockedAuto, plainText], [fresh]);
    expect(out.map((l) => l.id)).toEqual(['manual', 'locked', 'text', 'new']);
    expect(isAutoSubtitle(oldAuto)).toBe(true);
    expect(isAutoSubtitle(manual)).toBe(false);
  });
});

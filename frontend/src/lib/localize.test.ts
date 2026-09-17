import { describe, expect, it } from 'vitest';
import {
  cleanCueText,
  LOCALIZE_WRAP_WIDTH,
  appliedVersion,
  applyCrossVideoWarnings,
  applyLocalizationToSpec,
  canApplyVersion,
  FONT_BY_LANG,
  fontForLang,
  isLocalizationActive,
  isVersionActive,
  langLabel,
  localizationFinishText,
  localizedCuesToLayers,
  localizeTextStyle,
  mergedCues,
  parseTerms,
  termsToText,
  transcriptStatusText,
  versionStatusText,
  voiceLabel,
} from './localize';
import { defaultTextStyle, emptySpec, type Asset, type EditSpec, type Localization, type LocalizationVersion, type LocalizeOptions, type TextLayer, type Transcript, type Video } from '../types';

const OPTIONS: LocalizeOptions = {
  enabled: true,
  source_langs: [{ code: 'en', label: '英语' }],
  target_langs: [
    { code: 'ko', label: '韩语', voices: [{ id: 'kyong', label: '韩语女声' }] },
    { code: 'ja', label: '日语', voices: [] },
  ],
};

const TRANSCRIPT: Transcript = {
  status: 'done',
  cues: [
    { i: 0, start: 0.4, end: 2.4, text: 'Welcome.' },
    { i: 1, start: 3.4, end: 5.4, text: 'Second.' },
    { i: 2, start: 6.4, end: 8.4, text: 'Third.' },
  ],
  updated_at: 't1',
};

function version(over: Partial<LocalizationVersion> = {}): LocalizationVersion {
  return {
    status: 'done',
    stage: null,
    voice: 'kyong',
    terms: [],
    cues: [
      { i: 0, translated: '환영합니다.' },
      { i: 1, translated: '두 번째.' },
      { i: 2, translated: '세 번째.' },
    ],
    stale: false,
    error: null,
    warnings: [],
    voice_asset_id: 'a_ko',
    updated_at: 'v1',
    ...over,
  };
}

const ASSET_BASE = { type: 'audio', kind: 'audio', status: 'ready', url: '/media/x', source: 'derived', created_at: '' } as const;
const ASSETS: Asset[] = [
  { ...ASSET_BASE, id: 'a_ko', name: 'ko.m4a', derived_from: { video_id: 'v1', video_name: 'a.mp4', stem: 'dubbed', lang: 'ko' } },
  { ...ASSET_BASE, id: 'a_ja', name: 'ja.m4a', derived_from: { video_id: 'v1', video_name: 'a.mp4', stem: 'dubbed', lang: 'ja' } },
  { ...ASSET_BASE, id: 'a_inst', name: 'inst.m4a', derived_from: { video_id: 'v1', video_name: 'a.mp4', stem: 'instrumental' } },
  { ...ASSET_BASE, id: 'a_voc', name: 'voc.m4a', derived_from: { video_id: 'v1', video_name: 'a.mp4', stem: 'vocals' } },
];

function video(over: Partial<Video> = {}): Video {
  return {
    id: 'v1',
    name: 'a.mp4',
    duration: 10,
    has_audio: true,
    status: 'ready',
    localization: { source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version(), ja: version({ voice: null, voice_asset_id: 'a_ja', cues: [{ i: 0, translated: 'ようこそ。' }] }) } },
    separation: { status: 'done', model: 'htdemucs', vocals_asset_id: 'a_voc', instrumental_asset_id: 'a_inst' },
    ...over,
  } as Video;
}

let seq = 0;
const ids = () => {
  seq += 1;
  return `id${seq}`;
};
const ctx = (v: Video, label = '韩语') => ({ video: v, assets: ASSETS, langLabel: label, newLayerId: ids, newTrackId: ids });

describe('文案与状态', () => {
  it('langLabel：options 优先，其次内置兜底，最后原样返回码', () => {
    expect(langLabel(OPTIONS, 'ko')).toBe('韩语');
    expect(langLabel(null, 'ja')).toBe('日语');
    expect(langLabel(OPTIONS, 'xx')).toBe('xx');
    expect(voiceLabel(OPTIONS, 'ko', 'kyong')).toBe('韩语女声');
    expect(voiceLabel(OPTIONS, 'ko', 'nope')).toBe('nope');
    expect(voiceLabel(OPTIONS, 'ko', null)).toBe('默认音色');
  });
  it('transcriptStatusText / versionStatusText', () => {
    expect(transcriptStatusText(null)).toBe('未听写');
    expect(transcriptStatusText({ status: 'running', cues: [] })).toBe('听写中…');
    expect(transcriptStatusText(TRANSCRIPT)).toBe('已听写 3 句');
    expect(versionStatusText(version({ status: 'queued' }))).toBe('排队中…');
    expect(versionStatusText(version({ status: 'queued', stage: 'tts' }))).toBe('排队中（重新合成）…');
    expect(versionStatusText(version({ status: 'running', stage: 'translate' }))).toBe('翻译中…');
    expect(versionStatusText(version({ status: 'running', stage: 'mix' }))).toBe('混音中…');
    expect(versionStatusText(version({ status: 'failed' }))).toBe('生成失败');
    expect(versionStatusText(version())).toBe('已生成');
  });
  it('isLocalizationActive：听写或任一版本 queued / running', () => {
    expect(isLocalizationActive(null)).toBe(false);
    expect(isLocalizationActive({ source_lang: 'en', transcript: TRANSCRIPT, versions: {} })).toBe(false);
    expect(isLocalizationActive({ source_lang: 'en', transcript: { status: 'queued', cues: [] }, versions: {} })).toBe(true);
    expect(isLocalizationActive({ source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version({ status: 'running' }) } })).toBe(true);
    expect(isVersionActive(version({ status: 'failed' }))).toBe(false);
  });
  it('localizationFinishText：只报告这轮变过的版本', () => {
    const before: Localization = { source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version(), ja: version({ status: 'running' }) } };
    const after: Localization = { source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version(), ja: version({ status: 'done', updated_at: 'v2' }) } };
    expect(localizationFinishText(before, after, OPTIONS)).toBe('日语版已生成，可在「改语言」模块套用');
    const failed: Localization = { ...after, versions: { ...after.versions, ja: version({ status: 'failed', error: '429' }) } };
    expect(localizationFinishText(before, failed, OPTIONS)).toBe('日语（429）生成失败');
    expect(localizationFinishText(after, after, OPTIONS)).toBeNull();
    expect(localizationFinishText(null, { source_lang: 'en', transcript: { status: 'failed', error: '没声音', cues: [] }, versions: {} }, OPTIONS)).toBe('听写失败：没声音');
    expect(localizationFinishText(null, { source_lang: 'en', transcript: TRANSCRIPT, versions: {} }, OPTIONS)).toBe('已听写 3 句，可以修正模板或直接生成语言版本');
  });
});

describe('parseTerms', () => {
  it('每行 原词=译词；空行、没分隔符、空原词跳过；同原词后写覆盖先写', () => {
    expect(parseTerms('HitGO=힛고\n\n没有分隔符\n =x\nA → B\nHitGO＝히트고\n')).toEqual([
      { source: 'HitGO', target: '히트고' },
      { source: 'A', target: 'B' },
    ]);
    expect(parseTerms('')).toEqual([]);
  });
  it('termsToText 与 parseTerms 互逆', () => {
    const terms = [{ source: 'a', target: 'b' }, { source: 'c d', target: 'e f' }];
    expect(parseTerms(termsToText(terms))).toEqual(terms);
    expect(termsToText(null)).toBe('');
  });
});

describe('字体', () => {
  it('韩 / 日 / 泰有专门字体，其它回退内置 SC', () => {
    expect(fontForLang('ko')).toBe(FONT_BY_LANG.ko);
    expect(fontForLang('ja')).toBe('Noto Sans JP');
    expect(fontForLang('en')).toBe('Noto Sans SC');
    expect(fontForLang('zz')).toBe('Noto Sans SC');
  });
  it('localizeTextStyle：字幕条预设 + 目标语言字体', () => {
    const st = localizeTextStyle('ko');
    expect(st.font_family).toBe('Noto Sans KR');
    expect(st.background).toBe('#000000B3');
    expect(st.align).toBe('center');
  });
});

describe('mergedCues', () => {
  it('按 i 对齐，缺译文补空串，版本多出的 i 丢掉，按 i 排序', () => {
    const t: Transcript = { status: 'done', cues: [TRANSCRIPT.cues[1], TRANSCRIPT.cues[0]] };
    const v = version({ cues: [{ i: 1, translated: '둘' }, { i: 9, translated: '多余' }] });
    expect(mergedCues(t, v)).toEqual([
      { i: 0, start: 0.4, end: 2.4, text: 'Welcome.', translated: '' },
      { i: 1, start: 3.4, end: 5.4, text: 'Second.', translated: '둘' },
    ]);
    expect(mergedCues(null, v)).toEqual([]);
    expect(mergedCues(t, null)[0].translated).toBe('');
  });
});

describe('localizedCuesToLayers', () => {
  const cues = mergedCues(TRANSCRIPT, version());
  it('每句一个文字图层：origin / lang / 名字 / 时段换算到剪后时间轴，空译文与删除区里的句子跳过', () => {
    const layers = localizedCuesToLayers(cues.map((c, k) => (k === 2 ? { ...c, translated: '  ' } : c)), { lang: 'ko', langLabel: '韩语', remove: [[3, 6]], postDuration: 7, newId: ids });
    expect(layers.map((l) => l.name)).toEqual(['韩语字幕 1']);
    expect(layers[0].origin).toBe('localize');
    expect(layers[0].lang).toBe('ko');
    expect(layers[0].text).toBe('환영합니다.');
    expect(layers[0].t).toEqual([0.4, 2.4]);
    expect(layers[0].style.font_family).toBe('Noto Sans KR');
    expect(layers[0].anchor).toBe('bottom-center');
    expect(layers[0].style.wrap_width).toBe(LOCALIZE_WRAP_WIDTH);
  });
  it('自动换行宽度：样式里调过的沿用，关掉（null）的保持关闭', () => {
    const one = cues.slice(0, 1);
    const tuned = localizedCuesToLayers(one, { lang: 'ko', langLabel: '韩语', remove: [], postDuration: 0, style: { ...defaultTextStyle(), wrap_width: 0.6 }, newId: ids });
    expect(tuned[0].style.wrap_width).toBe(0.6);
    const off = localizedCuesToLayers(one, { lang: 'ko', langLabel: '韩语', remove: [], postDuration: 0, style: { ...defaultTextStyle(), wrap_width: null }, newId: ids });
    expect(off[0].style.wrap_width).toBeNull();
  });
  it('跨删除区的句子缩短；超出剪后时长的裁掉；沿用给定样式与位置', () => {
    const style = { ...defaultTextStyle(), color: '#FF0000' };
    const layers = localizedCuesToLayers(cues, { lang: 'ko', langLabel: '韩语', remove: [[4, 5]], postDuration: 6.5, style, placement: { anchor: 'top-center', margin: [0, 0.2] }, newId: ids });
    expect(layers.map((l) => l.t)).toEqual([
      [0.4, 2.4],
      [3.4, 4.4],
      [5.4, 6.5],
    ]);
    expect(layers.every((l) => l.style.color === '#FF0000' && l.anchor === 'top-center' && l.margin[1] === 0.2)).toBe(true);
    // 样式逐条拷贝，互不共享引用
    expect(layers[0].style).not.toBe(layers[1].style);
  });
});

describe('canApplyVersion', () => {
  it('done + 配音素材就绪才能套用，其它情况给中文原因', () => {
    expect(canApplyVersion(video(), 'ko', ASSETS)).toEqual({ ok: true });
    expect(canApplyVersion(video(), 'de', ASSETS)).toMatchObject({ ok: false, reason: '还没有这个语言的版本' });
    expect(canApplyVersion(video({ localization: { source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version({ status: 'running' }) } } }), 'ko', ASSETS)).toMatchObject({ ok: false, reason: '这个版本还在生成中' });
    expect(canApplyVersion(video({ localization: { source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version({ status: 'failed', error: '429' }) } } }), 'ko', ASSETS)).toMatchObject({ ok: false, reason: '这个版本生成失败：429' });
    expect(canApplyVersion(video(), 'ko', [])).toMatchObject({ ok: false, reason: expect.stringContaining('不存在') });
    expect(canApplyVersion(video(), 'ko', [{ ...ASSETS[0], status: 'preparing' }])).toMatchObject({ ok: false, reason: expect.stringContaining('处理中') });
    expect(canApplyVersion(null, 'ko', ASSETS).ok).toBe(false);
  });
});

describe('applyLocalizationToSpec', () => {
  const userText: TextLayer = { id: 'user', type: 'text', text: '用户的标题', style: defaultTextStyle(), anchor: 'top-center', margin: [0, 0.1], width: 0.5, rotate: 0, opacity: 1, t: 'all' };
  const base = (): EditSpec => ({ ...emptySpec(), trim: { remove: [[3, 6]] }, layers: [userText], audio: { source_volume: 0.8, tracks: [{ id: 'bgm_user', asset_id: 'a_up', role: 'bgm', t: 'all' }] } });

  it('源音轨静音、配音轨 + 伴奏轨对齐源时间轴、字幕层 append 到末尾；用户的层 / 轨不动', () => {
    const spec = base();
    const warnings = applyLocalizationToSpec(spec, 'ko', ctx(video()));
    expect(warnings).toEqual([]);
    expect(spec.audio!.source_volume).toBe(0);
    const tracks = spec.audio!.tracks;
    expect(tracks[0].id).toBe('bgm_user');
    expect(tracks.slice(1).map((t) => [t.role, t.asset_id, t.align, t.t, t.origin, t.lang])).toEqual([
      ['voice', 'a_ko', 'source', 'all', 'localize', 'ko'],
      ['bgm', 'a_inst', 'source', 'all', 'localize', 'ko'],
    ]);
    expect(spec.layers[0]).toBe(userText);
    // [3,6] 删掉 → 第 2 句整句落在删除区，第 3 句前移 3 秒
    expect(spec.layers.slice(1).map((l) => [l.origin, (l as TextLayer).text, l.t])).toEqual([
      ['localize', '환영합니다.', [0.4, 2.4]],
      ['localize', '세 번째.', [3.4, 5.4]],
    ]);
  });

  it('没有分离伴奏：只加配音轨并返回警告；用户已用「只留伴奏」时不重复加；原人声轨仍在时提醒', () => {
    const spec = base();
    const w = applyLocalizationToSpec(spec, 'ko', ctx(video({ separation: null })));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('伴奏');
    expect(spec.audio!.tracks.filter((t) => t.origin === 'localize').map((t) => t.role)).toEqual(['voice']);

    const spec2 = base();
    spec2.audio!.tracks.push({ id: 'inst_user', asset_id: 'a_inst', role: 'bgm', align: 'source', t: 'all' }, { id: 'voc_user', asset_id: 'a_voc', role: 'voice', align: 'source', t: 'all' });
    const w2 = applyLocalizationToSpec(spec2, 'ko', ctx(video()));
    expect(spec2.audio!.tracks.filter((t) => t.asset_id === 'a_inst')).toHaveLength(1);
    expect(w2.some((x) => x.includes('原人声'))).toBe(true);
  });

  it('切换语言：旧语言的层 / 轨整批替换，样式与位置沿用，自动字体换成新语言的；用户改过的上传字体保留', () => {
    const spec = base();
    applyLocalizationToSpec(spec, 'ko', ctx(video()));
    const koLayer = spec.layers.find((l) => l.origin === 'localize') as TextLayer;
    koLayer.style.color = '#00FF00';
    koLayer.style.wrap_width = 0.7;
    koLayer.anchor = 'center';
    koLayer.margin = [0.1, 0.2];
    const before = spec.layers.length;

    const w = applyLocalizationToSpec(spec, 'ja', ctx(video(), '日语'));
    expect(w).toEqual([]);
    const jaLayers = spec.layers.filter((l) => l.origin === 'localize') as TextLayer[];
    expect(spec.layers.some((l) => l.lang === 'ko')).toBe(false);
    expect(jaLayers).toHaveLength(1);
    expect(jaLayers[0].text).toBe('ようこそ。');
    expect(jaLayers[0].name).toBe('日语字幕 1');
    expect(jaLayers[0].style.color).toBe('#00FF00');
    expect(jaLayers[0].style.wrap_width).toBe(0.7);
    expect(jaLayers[0].style.font_family).toBe('Noto Sans JP');
    expect(jaLayers[0].anchor).toBe('center');
    expect(jaLayers[0].margin).toEqual([0.1, 0.2]);
    expect(spec.layers.length).toBe(before - 1);
    const loc = spec.audio!.tracks.filter((t) => t.origin === 'localize');
    expect(loc.map((t) => [t.role, t.asset_id, t.lang])).toEqual([
      ['voice', 'a_ja', 'ja'],
      ['bgm', 'a_inst', 'ja'],
    ]);
    expect(spec.audio!.tracks[0].id).toBe('bgm_user');
    expect(spec.layers[0]).toBe(userText);

    // 用户换成了自己上传的字体：换语言时保留
    jaLayers[0].style.font_family = 'MyBrandFont';
    applyLocalizationToSpec(spec, 'ko', ctx(video()));
    expect((spec.layers.find((l) => l.origin === 'localize') as TextLayer).style.font_family).toBe('MyBrandFont');
  });

  it('版本不可用时不改动 spec', () => {
    const spec = base();
    const snapshot = JSON.stringify(spec);
    const w = applyLocalizationToSpec(spec, 'de', ctx(video()));
    expect(w).toHaveLength(1);
    expect(JSON.stringify(spec)).toBe(snapshot);
  });

  it('没有 audio 块的 spec 也能套', () => {
    const spec = emptySpec();
    applyLocalizationToSpec(spec, 'ko', ctx(video()));
    expect(spec.audio?.source_volume).toBe(0);
    expect(spec.audio?.tracks).toHaveLength(2);
  });
});

describe('appliedVersion', () => {
  it('没有 localize 层 / 轨 → null；配音轨素材与版本一致 → applied；版本重生成 / 被删 / 轨被删 → stale', () => {
    const v = video();
    const spec = emptySpec();
    expect(appliedVersion(spec, v.localization)).toBeNull();
    applyLocalizationToSpec(spec, 'ko', ctx(v));
    expect(appliedVersion(spec, v.localization)).toEqual({ lang: 'ko', state: 'applied' });
    const regenerated = video({ localization: { ...v.localization!, versions: { ...v.localization!.versions, ko: version({ voice_asset_id: 'a_ko2' }) } } });
    expect(appliedVersion(spec, regenerated.localization)).toEqual({ lang: 'ko', state: 'stale' });
    expect(appliedVersion(spec, { ...v.localization!, versions: {} })).toEqual({ lang: 'ko', state: 'stale' });
    spec.audio!.tracks = spec.audio!.tracks.filter((t) => t.role !== 'voice');
    expect(appliedVersion(spec, v.localization)).toEqual({ lang: 'ko', state: 'stale' });
    expect(appliedVersion(null, v.localization)).toBeNull();
  });
});

describe('applyCrossVideoWarnings', () => {
  it('对齐源时间轴的音轨 / 改语言字幕各给一条提示', () => {
    expect(applyCrossVideoWarnings(emptySpec())).toEqual([]);
    expect(applyCrossVideoWarnings(null)).toEqual([]);
    const spec = emptySpec();
    applyLocalizationToSpec(spec, 'ko', ctx(video()));
    expect(applyCrossVideoWarnings(spec)).toHaveLength(2);
    const onlySource: EditSpec = { ...emptySpec(), audio: { source_volume: 0, tracks: [{ id: 'x', asset_id: 'a_inst', align: 'source', t: 'all' }] } };
    expect(applyCrossVideoWarnings(onlySource)).toHaveLength(1);
  });
});

describe('cleanCueText', () => {
  it('不再插硬换行：长句保持一行，交给 style.wrap_width 自动折', () => {
    const long = 'Welcome to HitGO the fastest way to localize your video ads in minutes and export';
    expect(cleanCueText(long)).toBe(long);
  });
  it('保留已有换行、去掉空行和首尾空白', () => {
    expect(cleanCueText('  a \n\n b  ')).toBe('a\nb');
  });
});

describe('新增语言', () => {
  it('阿拉伯语用 Noto Sans Arabic，西葡法用内置字体', () => {
    expect(fontForLang('ar')).toBe('Noto Sans Arabic');
    expect(fontForLang('es')).toBe(fontForLang('fr'));
  });
});

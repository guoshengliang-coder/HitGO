import { describe, expect, it } from 'vitest';
import {
  cleanCueText,
  setLayerWrapWidth,
  unwrapLegacyCueText,
  LOCALIZE_WRAP_WIDTH,
  appliedVersion,
  applyCrossVideoWarnings,
  applyLocalizationToSpec,
  autoApplyLang,
  canApplyVersion,
  dubbableLangs,
  hasDub,
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
  stripLocalization,
  termsToText,
  transcriptStatusText,
  versionStatusText,
  voiceLabel,
  voiceOptionLabel,
  groupVoices,
  voiceSupportsRate,
  cloneStatusText,
  cloneSupported,
  splitByClone,
  versionVoiceText,
} from './localize';
import { defaultTextStyle, emptySpec, type Asset, type EditSpec, type Localization, type LocalizationVersion, type LocalizeOptions, type TextLayer, type Transcript, type Video, type VoiceOption } from '../types';

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
  { ...ASSET_BASE, id: 'a_new', name: 'new-bgm.m4a', source: 'upload' },
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
    expect(versionStatusText(version({ status: 'queued', stage: 'tts' }))).toBe('排队中（生成口播）…');
    expect(versionStatusText(version({ status: 'running', stage: 'translate' }))).toBe('翻译中…');
    expect(versionStatusText(version({ status: 'running', stage: 'mix' }))).toBe('混音中…');
    expect(versionStatusText(version({ status: 'failed' }))).toBe('生成失败');
    expect(versionStatusText(version())).toBe('已生成口播');
    expect(versionStatusText(version({ voice_asset_id: null }))).toBe('已翻译');
    expect(versionStatusText(version({ voice_stale: true }))).toBe('已翻译 · 口播待更新');
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
    expect(localizationFinishText(before, after, OPTIONS)).toBe('日语口播已生成，可在「改语言」模块套用');
    const translated: Localization = { ...after, versions: { ...after.versions, ja: version({ status: 'done', voice_asset_id: null, dub: false, updated_at: 'v2' }) } };
    expect(localizationFinishText(before, translated, OPTIONS)).toBe('日语已翻译，可在「生成口播」里合成配音');
    const failed: Localization = { ...after, versions: { ...after.versions, ja: version({ status: 'failed', error: '429' }) } };
    expect(localizationFinishText(before, failed, OPTIONS)).toBe('日语（429）生成失败');
    expect(localizationFinishText(after, after, OPTIONS)).toBeNull();
    expect(localizationFinishText(null, { source_lang: 'en', transcript: { status: 'failed', error: '没声音', cues: [] }, versions: {} }, OPTIONS)).toBe('听写失败：没声音');
    expect(localizationFinishText(null, { source_lang: 'en', transcript: TRANSCRIPT, versions: {} }, OPTIONS)).toBe('已听写 3 句，可以修正模板或直接翻译');
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

describe('口播（HIG-56）', () => {
  const loc = (versions: Record<string, LocalizationVersion>): Localization => ({ source_lang: 'en', transcript: TRANSCRIPT, versions });
  it('hasDub：done + 有配音素材 + 不是旧配音', () => {
    expect(hasDub(version())).toBe(true);
    expect(hasDub(version({ voice_asset_id: null }))).toBe(false);
    expect(hasDub(version({ voice_stale: true }))).toBe(false);
    expect(hasDub(version({ status: 'running' }))).toBe(false);
    expect(hasDub(null)).toBe(false);
  });
  it('dubbableLangs：已翻译完的版本，按 options 顺序', () => {
    const l = loc({
      ja: version({ voice_asset_id: null }),
      ko: version(),
      de: version({ status: 'running' }),
      fr: version({ cues: [{ i: 0, translated: '  ' }] }),
    });
    expect(dubbableLangs(l, OPTIONS)).toEqual([{ lang: 'ko', dubbed: true }, { lang: 'ja', dubbed: false }]);
    expect(dubbableLangs(null, OPTIONS)).toEqual([]);
  });
  it('autoApplyLang：按发起顺序取第一个新出口播的语言', () => {
    const before = loc({ ko: version({ status: 'queued', stage: 'tts', voice_asset_id: null }), ja: version({ status: 'queued', stage: 'tts', voice_stale: true }) });
    const after = loc({ ko: version({ status: 'failed', error: 'x', voice_asset_id: null }), ja: version({ voice_asset_id: 'a_new' }) });
    expect(autoApplyLang(before, after, ['ko', 'ja'])).toBe('ja');
    expect(autoApplyLang(before, loc({ ko: version(), ja: version({ voice_asset_id: 'a_new' }) }), ['ko', 'ja'])).toBe('ko');
    // 口播没变（同一个素材）不算新出
    expect(autoApplyLang(loc({ ko: version() }), loc({ ko: version() }), ['ko'])).toBeNull();
    expect(autoApplyLang(before, after, [])).toBeNull();
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
    expect(canApplyVersion(video({ localization: { source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version({ voice_asset_id: null }) } } }), 'ko', ASSETS)).toMatchObject({ ok: false, reason: expect.stringContaining('还没有口播') });
    expect(canApplyVersion(video({ localization: { source_lang: 'en', transcript: TRANSCRIPT, versions: { ko: version({ voice_stale: true }) } } }), 'ko', ASSETS)).toMatchObject({ ok: false, reason: expect.stringContaining('口播还没更新') });
  });
});

describe('applyLocalizationToSpec', () => {
  it('拼接后重新套用配音只静音原片；导出原版不改插入片段的音量', () => {
    const v = video();
    const spec: EditSpec = { ...emptySpec(), sequence: { clips: [
      { id: 'insert', video_id: 'other', in: 0, out: 3, source_volume: 0.7 },
      { id: 'owner', video_id: v.id, in: 0, out: 3, source_volume: 0.3 },
    ] }, audio: { source_volume: 1, tracks: [] } };
    applyLocalizationToSpec(spec, 'ko', ctx(v));
    expect(spec.audio?.source_volume).toBe(1);
    expect(spec.sequence?.clips.map(c => c.source_volume)).toEqual([0.7, 0]);
    stripLocalization(spec, v.id);
    expect(spec.sequence?.clips.map(c => c.source_volume)).toEqual([0.7, 1]);
  });
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

  it('替换 BGM 时移除旧 BGM，不依赖分离伴奏；切换语言后仍只留一条新 BGM', () => {
    const spec = base();
    spec.audio!.tracks.push({ id: 'legacy_bgm', asset_id: 'a_up', t: 'all' });
    const bgm = { mode: 'replace' as const, assetId: 'a_new' };
    const v = video({ separation: null });
    expect(applyLocalizationToSpec(spec, 'ko', { ...ctx(v), bgm })).toEqual([]);
    expect(spec.audio!.tracks.map((t) => [t.role, t.asset_id])).toEqual([['voice', 'a_ko'], ['bgm', 'a_new']]);
    expect(spec.audio!.tracks[1]).toMatchObject({ align: 'post', loop: true, volume: 0.6, origin: 'localize' });
    expect(applyLocalizationToSpec(spec, 'ja', { ...ctx(v, '日语'), bgm })).toEqual([]);
    expect(spec.audio!.tracks.map((t) => [t.role, t.asset_id])).toEqual([['voice', 'a_ja'], ['bgm', 'a_new']]);
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

describe('unwrapLegacyCueText / setLayerWrapWidth（旧译文字幕的硬换行）', () => {
  const layer = (text: string, extra: Partial<TextLayer> = {}): TextLayer => ({
    id: 'l', type: 'text', t: 'all', anchor: 'bottom-center', margin: [0, 0.12], width: 0.8, rotate: 0, opacity: 1,
    text, style: defaultTextStyle(), origin: 'localize', lang: 'en', ...extra,
  }) as TextLayer;

  it('拉丁文按空格接回，中日文直接接', () => {
    expect(unwrapLegacyCueText('Walk just 1,000\nsteps to receive a\n5-yuan red envelope').text).toBe('Walk just 1,000 steps to receive a 5-yuan red envelope');
    expect(unwrapLegacyCueText('只需要打开这个开关，\n就能一键扫描').text).toBe('只需要打开这个开关，就能一键扫描');
    expect(unwrapLegacyCueText('ようこそ\nHitGO へ').text).toBe('ようこそHitGO へ');
  });

  it('下标映射：换行后的字符前移到接好的位置', () => {
    const { text, map } = unwrapLegacyCueText('ab\ncd');
    expect(text).toBe('ab cd');
    expect(map(0)).toBe(0);
    expect(map(2)).toBe(2);
    expect(map(3)).toBe(3);
    expect(map(5)).toBe(5);
  });

  it('旧译文字幕第一次开自动换行时并回一段，spans 跟着平移', () => {
    const l = layer('Hurry—use your\nHuawei phone', { spans: [{ start: 15, end: 21, color: '#FF0000' }] });
    setLayerWrapWidth(l, 0.6);
    expect(l.text).toBe('Hurry—use your Huawei phone');
    expect(l.style.wrap_width).toBe(0.6);
    expect(l.text.slice(l.spans![0].start, l.spans![0].end)).toBe('Huawei');
  });

  it('已经开过自动换行、非改语言图层、关闭换行时都不动文字', () => {
    const wrapped = layer('a\nb', { style: { ...defaultTextStyle(), wrap_width: 0.9 } });
    setLayerWrapWidth(wrapped, 0.5);
    expect(wrapped.text).toBe('a\nb');
    const typed = layer('a\nb', { origin: undefined, lang: undefined });
    setLayerWrapWidth(typed, 0.5);
    expect(typed.text).toBe('a\nb');
    expect(typed.style.wrap_width).toBe(0.5);
    const off = layer('a\nb');
    setLayerWrapWidth(off, null);
    expect(off.text).toBe('a\nb');
    expect(off.style.wrap_width).toBeNull();
  });
});

describe('新增语言', () => {
  it('阿拉伯语用 Noto Sans Arabic，西葡法用内置字体', () => {
    expect(fontForLang('ar')).toBe('Noto Sans Arabic');
    expect(fontForLang('es')).toBe(fontForLang('fr'));
  });
});

describe('stripLocalization（HIG-43 导出原版）', () => {
  const userText: TextLayer = { id: 'user', type: 'text', text: '用户的标题', style: defaultTextStyle(), anchor: 'top-center', margin: [0, 0.1], width: 0.5, rotate: 0, opacity: 1, t: 'all' };
  it('去掉套用出来的层 / 轨，源音量从 0 恢复成 1；用户的层 / 轨不动', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [userText], audio: { source_volume: 0.8, tracks: [{ id: 'bgm_user', asset_id: 'a_up', role: 'bgm', t: 'all' }] } };
    applyLocalizationToSpec(spec, 'ko', ctx(video()));
    stripLocalization(spec);
    expect(spec.layers).toEqual([userText]);
    expect(spec.audio!.tracks.map((t) => t.id)).toEqual(['bgm_user']);
    expect(spec.audio!.source_volume).toBe(1);
  });
  it('没套用过：原样；用户自己把原声调成 0 也不动', () => {
    const spec: EditSpec = { ...emptySpec(), layers: [userText], audio: { source_volume: 0, tracks: [] } };
    stripLocalization(spec);
    expect(spec.layers).toEqual([userText]);
    expect(spec.audio!.source_volume).toBe(0);
    const bare = emptySpec();
    stripLocalization(bare);
    expect(bare).toEqual(emptySpec());
  });
});

describe('音色（HIG-42）', () => {
  const V: VoiceOption[] = [
    { id: 'env', label: 'env' },
    { id: 'a', label: '龙小淳', gender: 'female', style: '知性积极', speech_rate: true },
    { id: 'b', label: '龙橙', gender: 'male', style: '智慧青年', speech_rate: true },
    { id: 'c', label: 'Bella', gender: 'female', style: '精准干练' },
    { id: 'd', label: '龙机器', gender: 'neutral', style: '呆萌机器人' },
    { id: 'e', label: 'Cherry', gender: 'female', style: null, speech_rate: false },
  ];

  it('voiceOptionLabel：名字 · 风格，没有风格只有名字', () => {
    expect(voiceOptionLabel(V[1])).toBe('龙小淳 · 知性积极');
    expect(voiceOptionLabel(V[0])).toBe('env');
    expect(voiceOptionLabel(V[5])).toBe('Cherry');
  });

  it('groupVoices：女声 / 男声 / 特色，组内保持顺序，没 gender 的单独排最前', () => {
    const groups = groupVoices(V);
    expect(groups.map((g) => [g.key, g.label, g.voices.map((v) => v.id)])).toEqual([
      ['all', '', ['env']],
      ['female', '女声', ['a', 'c', 'e']],
      ['male', '男声', ['b']],
      ['neutral', '特色', ['d']],
    ]);
    expect(groupVoices(V.slice(1, 3)).map((g) => g.key)).toEqual(['female', 'male']); // 空组不出
  });

  it('groupVoices：全都没有 gender 时不分组；空列表没有组', () => {
    expect(groupVoices([{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }])).toEqual([{ key: 'all', label: '', voices: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }] }]);
    expect(groupVoices([])).toEqual([]);
  });

  it('voiceSupportsRate：只有明确 false 才算不支持', () => {
    const options: LocalizeOptions = { enabled: true, source_langs: [], target_langs: [{ code: 'zh', label: '中文', voices: V }] };
    expect(voiceSupportsRate(options, 'zh', 'a')).toBe(true);
    expect(voiceSupportsRate(options, 'zh', 'c')).toBe(true); // 没标
    expect(voiceSupportsRate(options, 'zh', 'e')).toBe(false);
    expect(voiceSupportsRate(options, 'zh', 'nope')).toBe(true);
    expect(voiceSupportsRate(null, 'zh', 'e')).toBe(true);
  });
});

describe('原声配音（HIG-58）', () => {
  const options: LocalizeOptions = {
    enabled: true,
    source_langs: [],
    target_langs: [
      { code: 'ja', label: '日语', clone: true, voices: [{ id: 'loongtomoka_v3', label: 'Tomoka' }] },
      { code: 'it', label: '意大利语', clone: false, voices: [{ id: 'Cherry', label: 'Cherry' }] },
      { code: 'ko', label: '韩语', voices: [] }, // 旧后端：没有 clone 字段
    ],
  };

  it('cloneSupported：只有后端明确标了 true 才算支持', () => {
    expect(cloneSupported(options, 'ja')).toBe(true);
    expect(cloneSupported(options, 'it')).toBe(false);
    expect(cloneSupported(options, 'ko')).toBe(false); // 没标 → 不给开关，好过请求回来 400
    expect(cloneSupported(options, 'zz')).toBe(false);
    expect(cloneSupported(null, 'ja')).toBe(false);
  });

  it('splitByClone：把一批语言分成能用原声的和不能的，保持原顺序', () => {
    expect(splitByClone(options, ['ja', 'it', 'ko'])).toEqual({ ok: ['ja'], unsupported: ['it', 'ko'] });
    expect(splitByClone(options, [])).toEqual({ ok: [], unsupported: [] });
  });

  it('versionVoiceText：用原声的显示「原声」，其余走音色名', () => {
    const base: LocalizationVersion = { status: 'done', cues: [], voice: 'loongtomoka_v3' };
    expect(versionVoiceText(options, 'ja', base)).toBe('Tomoka');
    expect(versionVoiceText(options, 'ja', { ...base, source_voice: true, voice: 'hitgo-abc123' })).toBe('原声');
    // 复刻 id 不在音色表里：不显示「原声」就会把这串 id 摊在界面上
    expect(versionVoiceText(options, 'ja', { ...base, voice: 'hitgo-abc123' })).toBe('hitgo-abc123');
  });

  it('cloneStatusText：只在复刻中或复刻失败时出声', () => {
    expect(cloneStatusText(null)).toBe('');
    expect(cloneStatusText({ status: 'done', voice_id: 'x' })).toBe('');
    expect(cloneStatusText({ status: 'queued' })).toBe('正在复刻原声…');
    expect(cloneStatusText({ status: 'running' })).toBe('正在复刻原声…');
    expect(cloneStatusText({ status: 'failed', error: '样本太短' })).toBe('原声复刻失败：样本太短');
    expect(cloneStatusText({ status: 'failed' })).toBe('原声复刻失败：未知原因');
  });
});

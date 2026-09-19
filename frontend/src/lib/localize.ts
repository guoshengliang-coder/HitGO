// 改语言（契约 §1 localization、§3 localize 端点）的纯函数：状态文案、术语表解析、按语言选字体、
// 模板 + 版本合并、译文 → 字幕层、一键套用（origin = 'localize' 的层 / 轨整批替换）。
// 不碰 store / DOM，全部可用 vitest 直接测。时间换算基于 lib/time.sourceRangeToPost：
// 模板句子在源时间轴上，字幕层的 t 在剪后时间轴上。

import type { Anchor, Asset, AudioTrack, CloneVoice, EditSpec, Localization, LocalizationTerm, LocalizationVersion, LocalizeOptions, SequenceClip, TextLayer, TextStyle, Transcript, Video, VoiceGender, VoiceOption } from '../types';
import { defaultTextStyle, isAssetReady } from '../types';
import { BUILTIN_FONT_FAMILY } from './fonts';
import { BUILTIN_TEXT_PRESETS } from './textPresets';
import { MIN_CUE_SECONDS, sliceWindow, splitCueRanges, visibleLength } from './cueSplit';
import { cuesToTextLayers, type SrtCue } from './srt';
import { postTrimDuration, sourceRangeToPost, type Range } from './time';
import { normalizeSequenceAudio, retimeContent, sequenceDuration, setOwnerSourceGain } from './sequence';
import { cloneSpec } from './spec';

export const LOCALIZE_ORIGIN = 'localize' as const;

/**
 * 语言码 → 中文名的兜底表。正式名称由 GET /api/localize/options 下发（前端不写死可选语言）；
 * 这张表只在 options 还没加载、或素材页这类拿不到 options 的地方给个可读的名字。
 */
const LANG_LABEL_FALLBACK: Record<string, string> = {
  zh: '中文',
  yue: '粤语',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  de: '德语',
  fr: '法语',
  ru: '俄语',
  pt: '葡萄牙语',
  es: '西班牙语',
  th: '泰语',
  id: '印尼语',
  vi: '越南语',
  auto: '自动识别',
  it: '意大利语',
  ar: '阿拉伯语',
};

/** 语言码 → 中文名：优先 options 里的 label，其次兜底表，再不行原样返回码。 */
export function langLabel(options: LocalizeOptions | null | undefined, code: string): string {
  const hit = options?.target_langs.find((l) => l.code === code) ?? options?.source_langs.find((l) => l.code === code);
  return hit?.label ?? LANG_LABEL_FALLBACK[code] ?? code;
}

/** 目标语言按勾选顺序提交；接口一轮最多接收 5 种语言。 */
export function toggleTargetLang(selected: string[], code: string): string[] {
  if (selected.includes(code)) return selected.filter((lang) => lang !== code);
  return selected.length < 5 ? [...selected, code] : selected;
}

/** 某目标语言某音色的显示名；找不到时原样返回 id。 */
export function voiceLabel(options: LocalizeOptions | null | undefined, lang: string, voiceId: string | null | undefined): string {
  if (!voiceId) return '默认音色';
  return options?.target_langs.find((l) => l.code === lang)?.voices.find((v) => v.id === voiceId)?.label ?? voiceId;
}

// ---- 音色（HIG-42）----

/** 下拉里一个音色的文字：「龙小淳 · 知性积极」；没有风格就只有名字。 */
export function voiceOptionLabel(v: Pick<VoiceOption, 'label' | 'style'>): string {
  return v.style ? `${v.label} · ${v.style}` : v.label;
}

export interface VoiceGroup {
  /** 'all'（没有 gender 的那组）或 `${provider}:${gender}`。 */
  key: string;
  /** optgroup 标题；'all' 时为空串（不分组）。 */
  label: string;
  voices: VoiceOption[];
}

const GENDER_LABEL: Record<VoiceGender, string> = { female: '女声', male: '男声', neutral: '特色' };
const GENDER_ORDER: VoiceGender[] = ['female', 'male', 'neutral'];

/** 音色厂商的显示名（HIG-59）；没列出来的原样显示，新后端 + 旧前端不会炸。 */
export const PROVIDER_LABEL: Record<string, string> = { aliyun: '阿里云', minimax: 'MiniMax' };

const providerLabel = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;
const providerOf = (v: VoiceOption): string => v.provider || 'aliyun';

/**
 * 按性别把音色分成 optgroup：女声 / 男声 / 特色，组内保持后端顺序，空组不出。
 * 没有任何音色带 gender（旧后端 / 全是 env 加的）时只有一组 'all'，不分组；
 * 部分没有 gender 的（LOCALIZE_VOICES 加的）排在最前面单独一组 'all'，别把它们藏进某个性别里。
 *
 * 一种语言同时有两家厂商的音色时（HIG-59），组名前面加厂商：「MiniMax · 女声」。**只有多家时才加**——
 * 只有一家的语言（今天绝大多数）组名仍是纯「女声」，下拉与接 MiniMax 之前逐字相同。厂商的先后按它
 * 在后端列表里首次出现的顺序，所以原有音色在前、MiniMax 在后，缺省音色一眼就能看到。
 */
export function groupVoices(voices: VoiceOption[]): VoiceGroup[] {
  const tagged = voices.filter((v) => !!v.gender);
  if (!tagged.length) return voices.length ? [{ key: 'all', label: '', voices }] : [];
  const out: VoiceGroup[] = [];
  const untagged = voices.filter((v) => !v.gender);
  if (untagged.length) out.push({ key: 'all', label: '', voices: untagged });
  const providers = [...new Set(tagged.map(providerOf))];
  for (const p of providers) {
    for (const g of GENDER_ORDER) {
      const vs = tagged.filter((v) => providerOf(v) === p && v.gender === g);
      if (!vs.length) continue;
      const label = providers.length > 1 ? `${providerLabel(p)} · ${GENDER_LABEL[g]}` : GENDER_LABEL[g];
      out.push({ key: `${p}:${g}`, label, voices: vs });
    }
  }
  return out;
}

// ---- 原声配音（HIG-58）----

/** 该语言能不能用复刻的原声：后端没标（旧后端）按不能算，宁可少给一个开关也不要请求回来 400。 */
export function cloneSupported(options: LocalizeOptions | null | undefined, lang: string): boolean {
  return options?.target_langs.find((l) => l.code === lang)?.clone === true;
}

/** 把一批语言分成能用原声的和不能的，面板据此提交前者、提示后者。 */
export function splitByClone(options: LocalizeOptions | null | undefined, langs: string[]): { ok: string[]; unsupported: string[] } {
  const ok: string[] = [];
  const unsupported: string[] = [];
  for (const lang of langs) (cloneSupported(options, lang) ? ok : unsupported).push(lang);
  return { ok, unsupported };
}

/** 版本行上音色那一栏的文字：用原声合成的显示「原声」，其余走音色名。 */
export function versionVoiceText(options: LocalizeOptions | null | undefined, lang: string, v: LocalizationVersion): string {
  return v.source_voice ? '原声' : voiceLabel(options, lang, v.voice);
}

/** 复刻这一步的状态提示；没在做、也没失败时返回空串（面板不显示这一行）。 */
export function cloneStatusText(clone: CloneVoice | null | undefined): string {
  if (!clone) return '';
  if (clone.status === 'queued' || clone.status === 'running') return '正在复刻原声…';
  if (clone.status === 'failed') return `原声复刻失败：${clone.error ?? '未知原因'}`;
  return '';
}

/** 该音色能不能调语速：后端没标（旧后端）按能算。 */
export function voiceSupportsRate(options: LocalizeOptions | null | undefined, lang: string, voiceId: string | null | undefined): boolean {
  const v = options?.target_langs.find((l) => l.code === lang)?.voices.find((x) => x.id === voiceId);
  return v?.speech_rate !== false;
}

// ---- 状态 ----

export function transcriptStatusText(t: Transcript | null | undefined): string {
  if (!t) return '未听写';
  if (t.status === 'queued') return '排队中…';
  if (t.status === 'running') return '听写中…';
  if (t.status === 'failed') return '听写失败';
  return `已听写 ${t.cues.length} 句`;
}

const STAGE_TEXT: Record<string, string> = { translate: '翻译中…', tts: '生成口播中…', mix: '混音中…' };

/** 有能用的口播：done、有配音素材、且不是只翻译后留下的旧配音（HIG-56）。 */
export function hasDub(v: LocalizationVersion | null | undefined): boolean {
  return v?.status === 'done' && !!v.voice_asset_id && !v.voice_stale;
}

export function versionStatusText(v: LocalizationVersion): string {
  if (v.status === 'queued') return v.stage === 'tts' ? '排队中（生成口播）…' : '排队中…';
  if (v.status === 'running') return STAGE_TEXT[v.stage ?? ''] ?? '处理中…';
  if (v.status === 'failed') return '生成失败';
  if (!v.voice_asset_id) return '已翻译';
  return v.voice_stale ? '已翻译 · 口播待更新' : '已生成口播';
}

export function isVersionActive(v: LocalizationVersion | null | undefined): boolean {
  return v?.status === 'queued' || v?.status === 'running';
}

/** 听写或任一版本在 queued / running：面板要禁掉会 409 的操作，store 要继续轮询。 */
export function isLocalizationActive(loc: Localization | null | undefined): boolean {
  if (!loc) return false;
  const t = loc.transcript;
  if (t && (t.status === 'queued' || t.status === 'running')) return true;
  return Object.values(loc.versions ?? {}).some(isVersionActive);
}

/** 「生成口播」可选的语言：已翻译完（done 且有译文）的版本，按 options 里的语言顺序；dubbed = 已有能用的口播。 */
export function dubbableLangs(loc: Localization | null | undefined, options: LocalizeOptions | null | undefined): { lang: string; dubbed: boolean }[] {
  const order = options?.target_langs.map((t) => t.code) ?? [];
  const rank = (code: string) => order.indexOf(code) + 1 || 999;
  return Object.entries(loc?.versions ?? {})
    .filter(([, v]) => v.status === 'done' && v.cues.some((c) => c.translated.trim()))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([lang, v]) => ({ lang, dubbed: hasDub(v) }));
}

/**
 * 口播生成完后自动套用哪个语言（HIG-56）：按发起时的顺序，取第一个这轮新出了能用口播的语言；
 * 同一时间只能套用一个语言，其余留给多语言导出。没有返回 null。
 */
export function autoApplyLang(before: Localization | null | undefined, after: Localization | null | undefined, requested: string[]): string | null {
  for (const lang of requested) {
    const v = after?.versions?.[lang];
    if (!hasDub(v)) continue;
    const b = before?.versions?.[lang];
    if (!hasDub(b) || b!.voice_asset_id !== v!.voice_asset_id) return lang;
  }
  return null;
}

/**
 * 一轮轮询结束时的提示：只报告这轮里状态变过的版本（之前就 done 的不再重复报），听写失败单独说。
 * before 是发起轮询时的快照；after 是结束时的。返回 null 表示没什么可说的。
 */
export function localizationFinishText(before: Localization | null | undefined, after: Localization | null | undefined, options: LocalizeOptions | null | undefined): string | null {
  if (!after) return null;
  const t = after.transcript;
  if (t?.status === 'failed' && before?.transcript?.status !== 'failed') return `听写失败：${t.error ?? '未知原因'}`;
  const done: string[] = [];
  const translated: string[] = [];
  const failed: string[] = [];
  for (const [lang, v] of Object.entries(after.versions ?? {})) {
    const b = before?.versions?.[lang];
    const changed = !b || b.status !== v.status || (b.updated_at ?? null) !== (v.updated_at ?? null);
    if (!changed) continue;
    if (v.status === 'done') (hasDub(v) ? done : translated).push(langLabel(options, lang));
    else if (v.status === 'failed') failed.push(`${langLabel(options, lang)}（${v.error ?? '未知原因'}）`);
  }
  const parts: string[] = [];
  if (translated.length) parts.push(`${translated.join('、')}已翻译，可在「生成口播」里合成配音`);
  if (done.length) parts.push(`${done.join('、')}口播已生成，可在「改语言」模块套用`);
  if (failed.length) parts.push(`${failed.join('、')}生成失败`);
  if (!parts.length && t?.status === 'done' && before?.transcript?.status !== 'done') return `已听写 ${t.cues.length} 句，可以修正模板或直接翻译`;
  return parts.length ? parts.join('；') : null;
}

// ---- 术语表 ----

/** 每行一条 `原词=译词`（也接受全角「＝」和「→」）；没有分隔符、原词为空的行跳过；同一原词后写的覆盖先写的。 */
export function parseTerms(text: string): LocalizationTerm[] {
  const map = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?)\s*(?:=|＝|→)\s*(.*)$/.exec(line);
    if (!m) continue;
    const source = m[1].trim();
    const target = m[2].trim();
    if (!source || !target) continue;
    map.set(source, target);
  }
  return Array.from(map, ([source, target]) => ({ source, target }));
}

export function termsToText(terms: LocalizationTerm[] | null | undefined): string {
  return (terms ?? []).map((t) => `${t.source}=${t.target}`).join('\n');
}

// ---- 字体 ----

/** 目标语言 → 内置 web 字体（index.html 引入的 Google Fonts）；没列的语言（拉丁 / 西里尔 / 中文）用内置 SC 就能显示。 */
export const FONT_BY_LANG: Record<string, string> = {
  ko: 'Noto Sans KR',
  ja: 'Noto Sans JP',
  th: 'Noto Sans Thai',
  ar: 'Noto Sans Arabic',
  // 越南语的预组合变音（ế ộ ữ）不在 Noto Sans SC 的子集里，必须用带 vietnamese 子集的拉丁 Noto。
  vi: 'Noto Sans',
};

export function fontForLang(lang: string): string {
  return FONT_BY_LANG[lang] ?? BUILTIN_FONT_FAMILY;
}

/** 是不是我们按语言自动选的字体（而非用户上传的字体）：换语言重新套用时只替换这类字体。 */
function isAutoFont(family: string): boolean {
  return family === BUILTIN_FONT_FAMILY || Object.values(FONT_BY_LANG).includes(family);
}

/** 译文字幕的初始样式：与「字幕」模块一样的「黑底白字字幕条」预设，字体按目标语言。 */
export function localizeTextStyle(lang: string): TextStyle {
  const preset = BUILTIN_TEXT_PRESETS.find((p) => p.id === 'builtin:subtitle-bar');
  return { ...defaultTextStyle(), ...(preset?.style ?? {}), font_family: fontForLang(lang) };
}

// ---- 模板 + 版本 ----

export interface MergedCue {
  i: number;
  /** 源时间轴秒。 */
  start: number;
  end: number;
  text: string;
  /** 该语言的译文；版本里没有这句时为空串。 */
  translated: string;
  /** 这句配音实际占用的起点与时长；adaptive 时是成片时间轴，否则是源时间轴。 */
  dubStart?: number;
  dubDuration?: number;
  videoSpeed?: number;
  adaptive?: boolean;
}

/**
 * 按 i 把模板句子和版本译文对上；版本里多出来的 i（模板句子已被删）丢掉。
 * 配音时段（HIG-36）只在「这一版的配音确实是照当前译文合成的」时才带出来——这是唯一一处判断，
 * 下游拿到 dubStart / dubDuration 就可以直接信。
 */
export function mergedCues(transcript: Transcript | null | undefined, version: LocalizationVersion | null | undefined): MergedCue[] {
  if (!transcript) return [];
  const dubTrusted = !!version && version.status === 'done' && version.dub !== false && !version.voice_stale;
  const byI = new Map((version?.cues ?? []).map((c) => [c.i, c]));
  return [...transcript.cues]
    .sort((a, b) => a.i - b.i)
    .map((c) => {
      const v = byI.get(c.i);
      const out: MergedCue = { i: c.i, start: c.start, end: c.end, text: c.text, translated: v?.translated ?? '' };
      const start = v?.dub_start;
      const duration = v?.dub_duration;
      if (dubTrusted && typeof start === 'number' && Number.isFinite(start) && start >= 0 && typeof duration === 'number' && duration > 0) {
        out.dubStart = start;
        out.dubDuration = duration;
        if (version?.adaptive_timing && typeof v?.video_speed === 'number') {
          out.videoSpeed = v.video_speed;
          out.adaptive = true;
        }
      }
      return out;
    });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface LocalizedLayersOptions {
  lang: string;
  /** 图层名用：「韩语字幕 N」。 */
  langLabel: string;
  /** 当前 trim.remove（源时间轴），句子时段经它换算到剪后时间轴。 */
  remove: Range[];
  /** 剪后时长；> 0 时超出的字幕截掉。 */
  postDuration: number;
  /** 缺省用 localizeTextStyle(lang)。 */
  style?: TextStyle;
  /** 缺省贴底居中（cuesToTextLayers 的位置）；重新套用时沿用上次的位置。 */
  placement?: Pick<TextLayer, 'anchor' | 'margin'>;
  /** 长句拆成多段（HIG-36）；缺省拆。关掉就是一条听写句一条字幕（HIG-36 之前的行为）。 */
  split?: boolean;
  newId: () => string;
}

/**
 * 拆完的字幕层总数上限（HIG-36）：模板最多 400 句，一句拆成几段还能接受，再多就会把预览烤图
 * 和导出拖垮。超过就整条视频都不拆，保底回到原来的一句一条。
 */
export const MAX_SUBTITLE_LAYERS = 1200;

/** 译文字幕默认的自动换行框宽（相对画布宽，HIG-51）；折行交给 drawTextImage 按实际字宽算。 */
export const LOCALIZE_WRAP_WIDTH = 0.9;

/** 译文清理：每行去首尾空白、去掉空行；已有换行保留（自动换行只在行内再折）。 */
export function cleanCueText(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** 行首 / 行尾是这些文字时，合并行不加空格（中日文、泰文本来就不以空格分词）。 */
const NO_SPACE_JOIN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\u3000-\u303F\uFF00-\uFFEF]/u;

/**
 * 把 v0.18.0 之前套用时 wrapCueText 硬插的换行并回一段（HIG-51）：拉丁 / 韩文 / 阿拉伯文等用空格接，
 * 接缝两边任一是中日文 / 泰文 / 全角标点时直接接。返回新文本和旧下标 → 新下标的映射（给 spans 平移用）。
 */
export function unwrapLegacyCueText(text: string): { text: string; map: (i: number) => number } {
  const lines = text.split('\n');
  let out = '';
  const starts: number[] = []; // 每行在新文本里的起点
  const oldStarts: number[] = [];
  let oldOff = 0;
  lines.forEach((line, k) => {
    if (k > 0 && out && line) {
      const joinNoSpace = NO_SPACE_JOIN.test(out[out.length - 1]) || NO_SPACE_JOIN.test(line[0]) || /\s$/.test(out) || /^\s/.test(line);
      if (!joinNoSpace) out += ' ';
    }
    starts.push(out.length);
    oldStarts.push(oldOff);
    out += line;
    oldOff += line.length + 1;
  });
  const map = (i: number) => {
    let k = oldStarts.length - 1;
    while (k > 0 && oldStarts[k] > i) k -= 1;
    return Math.min(out.length, starts[k] + Math.min(i - oldStarts[k], lines[k].length));
  };
  return { text: out, map };
}

/**
 * 设置文字图层的自动换行宽度（原地修改，给 updateLayer 的回调用）。
 * 改语言套用出来、还没开过自动换行的旧译文字幕（style 里没有 wrap_width）第一次开启时，
 * 先把旧版硬插的换行并回一段，否则自动换行只会拆长行、并不回短行，拖宽拖窄都看不出变化。
 */
export function setLayerWrapWidth(layer: TextLayer, wrap: number | null): void {
  if (wrap && layer.origin === LOCALIZE_ORIGIN && layer.style.wrap_width === undefined && layer.text.includes('\n')) {
    const { text, map } = unwrapLegacyCueText(layer.text);
    if (layer.spans?.length) {
      const spans = layer.spans.map((sp) => ({ ...sp, start: map(sp.start), end: map(sp.end) })).filter((sp) => sp.end > sp.start);
      if (spans.length) layer.spans = spans;
      else delete layer.spans;
    }
    layer.text = text;
  }
  layer.style = { ...layer.style, wrap_width: wrap };
}

/**
 * 一条译文在当前版本时间轴上的显示窗口：有配音时段就用它——这才是和语音同步的那一段；
 * 没有就回落到模板句子的时段。配音比原句短时不提前收尾（听感上句子还没说完就没字了很怪），
 * 比原句长并压到下一句时用下一句的起点收住，两条字幕不重叠。
 */
export function cueSourceWindow(cue: MergedCue, nextStart?: number): Range {
  const a = cue.dubStart ?? cue.start;
  if (cue.adaptive && cue.dubDuration) {
    const b = nextStart === undefined ? a + cue.dubDuration : Math.min(a + cue.dubDuration, Math.max(nextStart, a + MIN_CUE_SECONDS));
    return [round3(a), round3(Math.max(b, a + MIN_CUE_SECONDS))];
  }
  let b = cue.dubDuration ? a + cue.dubDuration : cue.end;
  b = Math.max(b, cue.end);
  if (nextStart !== undefined) b = Math.min(b, Math.max(nextStart, a + MIN_CUE_SECONDS));
  return [round3(a), round3(Math.max(b, a))];
}

/**
 * 译文 → 文字图层：复用 SRT 导入的 cuesToTextLayers，再打上 origin / lang 标记。
 * 译文为空的句子和整句落在删除区里的句子不生成图层。
 * 样式没写过 wrap_width（新套用、或 HIG-51 之前套用的旧样式）时开自动换行；用户关掉过（null）就不再打开。
 */
export function localizedCuesToLayers(cues: MergedCue[], opts: LocalizedLayersOptions): TextLayer[] {
  const spoken = cues.map((c) => ({ cue: c, text: cleanCueText(c.translated) })).filter((x) => x.text);
  // 两趟：先定每句的显示起点，再用下一句的起点收住这一句的终点（配音可能溢出到下一句，见契约 §6 的 warnings）。
  const starts = spoken.map(({ cue }) => cue.dubStart ?? cue.start);
  const windows = spoken.map(({ cue }, k) => cueSourceWindow(cue, starts[k + 1]));
  const split = opts.split !== false;
  const pieces: { text: string; window: Range }[] = [];
  spoken.forEach(({ text }, k) => {
    const ranges = split ? splitCueRanges(text, { lang: opts.lang }) : [[0, text.length] as Range];
    const slices = sliceWindow(windows[k], ranges.map(([a, b]) => visibleLength(text, a, b) || 1));
    ranges.forEach(([a, b], j) => pieces.push({ text: text.slice(a, b), window: slices[j] }));
  });
  // 拆得太碎会把预览烤图和导出拖垮：整条回到一句一条，宁可长也不要几千个图层。
  const kept = pieces.length > MAX_SUBTITLE_LAYERS ? spoken.map(({ text }, k) => ({ text, window: windows[k] })) : pieces;

  const srtCues: SrtCue[] = [];
  const adaptive = cues.some((cue) => cue.adaptive);
  for (const piece of kept) {
    const r = adaptive ? piece.window : sourceRangeToPost(piece.window, opts.remove);
    if (!r) continue;
    srtCues.push({ index: srtCues.length + 1, start: round3(r[0]), end: round3(r[1]), text: piece.text });
  }
  const base = opts.style ?? localizeTextStyle(opts.lang);
  const style = base.wrap_width === undefined ? { ...base, wrap_width: LOCALIZE_WRAP_WIDTH } : base;
  const layers = cuesToTextLayers(srtCues, { style, newId: opts.newId, maxEnd: opts.postDuration > 0 ? opts.postDuration : undefined });
  layers.forEach((l, k) => {
    l.origin = LOCALIZE_ORIGIN;
    l.lang = opts.lang;
    l.name = `${opts.langLabel}字幕 ${k + 1}`;
    if (opts.placement) {
      l.anchor = opts.placement.anchor;
      l.margin = [opts.placement.margin[0], opts.placement.margin[1]];
    }
  });
  return layers;
}

// ---- 套用 ----

export function localizeLayers(spec: EditSpec): TextLayer[] {
  return spec.layers.filter((l): l is TextLayer => l.type === 'text' && l.origin === LOCALIZE_ORIGIN);
}

export function localizeTracks(spec: EditSpec): AudioTrack[] {
  return spec.audio?.tracks.filter((t) => t.origin === LOCALIZE_ORIGIN) ?? [];
}

/** 改语言时的配乐选择；缺省保留原伴奏。 */
export type LocalizeBgmChoice = { mode: 'keep' } | { mode: 'replace'; assetId: string };

export interface ApplyContext {
  video: Video;
  assets: Asset[];
  /** 可选（HIG-38）：识别出来的硬字幕带，只在没有上一版译文字幕可参照时使用。 */
  band?: SubtitleBandHint | null;
  bgm?: LocalizeBgmChoice;
  /** 语言的中文名（图层名用）。 */
  langLabel: string;
  /** 长句拆成多段（HIG-36）；缺省拆。调用方从 featurePrefs 取，纯函数不读 localStorage。 */
  split?: boolean;
  newLayerId: () => string;
  newTrackId: () => string;
  newClipId?: () => string;
}

const retimeWindow = (window: [number, number], segments: { sourceStart: number; sourceEnd: number; outputStart: number; speed: number }[]): [number, number] => {
  const map = (t: number) => {
    const hit = segments.find((s, i) => t < s.sourceEnd - 1e-6 || i === segments.length - 1)!;
    return hit.outputStart + (Math.max(hit.sourceStart, Math.min(hit.sourceEnd, t)) - hit.sourceStart) / hit.speed;
  };
  return [round3(map(window[0])), round3(map(window[1]))];
};

/** Apply HIG-73's cue timing to the owner picture. Returns a warning when an edited sequence cannot be replaced safely. */
export function applyAdaptiveTiming(spec: EditSpec, video: Video, version: LocalizationVersion, newClipId?: () => string): string | null {
  if (!version.adaptive_timing) {
    if (spec.sequence?.origin === LOCALIZE_ORIGIN && spec.sequence.clips.some((clip) => Math.abs((clip.speed ?? 1) - 1) > 1e-6)) {
      const before = cloneSpec(spec);
      const after = cloneSpec(spec);
      for (const clip of after.sequence!.clips) clip.speed = 1;
      Object.assign(spec, retimeContent(before, after));
    }
    return null;
  }
  const speeds = new Map(version.cues.filter((c) => typeof c.video_speed === 'number').map((c) => [c.i, c.video_speed!]));
  const transcript = video.localization?.transcript?.cues ?? [];
  if (!speeds.size || !transcript.length) return '缺少画面适配数据，已保留当前画面时序';

  if (spec.sequence) {
    if (spec.sequence.origin !== LOCALIZE_ORIGIN) return '当前已有手工视频拼接，未自动改动画面速度';
    const before = cloneSpec(spec);
    const after = cloneSpec(spec);
    for (const clip of after.sequence!.clips) clip.speed = clip.localize_cue === undefined ? 1 : speeds.get(clip.localize_cue) ?? 1;
    Object.assign(spec, retimeContent(before, after));
    return null;
  }
  if (spec.trim.remove.length || spec.trim.duration != null) return '当前已有剪辑或固定成片时长，未自动改动画面速度';

  const makeId = newClipId ?? (() => `c_${crypto.randomUUID().slice(0, 12)}`);
  const clips: SequenceClip[] = [];
  const segments: { sourceStart: number; sourceEnd: number; outputStart: number; speed: number }[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;
  const add = (sourceStart: number, sourceEnd: number, speed: number, cue?: number) => {
    if (sourceEnd - sourceStart < 0.01) return;
    clips.push({ id: makeId(), video_id: video.id, in: round3(sourceStart), out: round3(sourceEnd), speed: round3(speed), source_volume: 1, ...(cue === undefined ? {} : { localize_cue: cue }) });
    segments.push({ sourceStart, sourceEnd, outputStart: outputCursor, speed });
    outputCursor += (sourceEnd - sourceStart) / speed;
  };
  for (const cue of [...transcript].sort((a, b) => a.i - b.i)) {
    const start = Math.max(sourceCursor, cue.start);
    if (start > sourceCursor) add(sourceCursor, start, 1);
    const end = Math.max(start, Math.min(video.duration, cue.end));
    add(start, end, speeds.get(cue.i) ?? 1, cue.i);
    sourceCursor = end;
  }
  if (sourceCursor < video.duration) add(sourceCursor, video.duration, 1);
  if (!clips.length) return '没有可用于画面适配的片段';

  spec.layers = spec.layers.map((layer) => layer.t === 'all' ? layer : { ...layer, t: retimeWindow(layer.t, segments) });
  if (spec.audio) {
    spec.audio.tracks = spec.audio.tracks.map((track) => track.t === 'all' ? track : { ...track, t: retimeWindow(track.t, segments) });
    spec.audio.source_mute = (spec.audio.source_mute ?? []).map((window) => retimeWindow(window, segments));
  }
  spec.sequence = { clips, origin: LOCALIZE_ORIGIN };
  spec.trim = { remove: [] };
  return null;
}

/**
 * 识别出来的硬字幕带（HIG-38）：第一次套用时让译文字幕落在原字幕的位置和样式上，
 * 而不是固定贴底 12%。人调过之后由 localizeLayerTemplate 接管，这里不再插手。
 */
export interface SubtitleBandHint {
  anchor: Anchor;
  margin: [number, number];
  style?: Partial<TextStyle>;
}

/**
 * 上一次生成的译文字幕层带着的样式与位置：重新套用 / 重新拆分时沿用，用户调过的不丢。
 * 换语言时只把「自动」选出来的字体换成新语言的，手选过的字体保留。
 */
export function localizeLayerTemplate(spec: EditSpec, lang: string): { style?: TextStyle; placement?: Pick<TextLayer, 'anchor' | 'margin'> } {
  const prev = localizeLayers(spec)[0];
  if (!prev) return {};
  const style: TextStyle = {
    ...prev.style,
    shadow: prev.style.shadow ? { ...prev.style.shadow, offset: [prev.style.shadow.offset[0], prev.style.shadow.offset[1]] } : prev.style.shadow,
    glow: prev.style.glow ? { ...prev.style.glow } : prev.style.glow,
  };
  if (prev.lang !== lang && isAutoFont(style.font_family)) style.font_family = fontForLang(lang);
  return { style, placement: { anchor: prev.anchor, margin: [prev.margin[0], prev.margin[1]] } };
}

/** 该语言版本现在能不能套用；不能时给出中文原因（面板按钮的 title / toast）。 */
export function canApplyVersion(video: Video | null | undefined, lang: string, assets: Asset[]): { ok: true } | { ok: false; reason: string } {
  const v = video?.localization?.versions?.[lang];
  if (!v) return { ok: false, reason: '还没有这个语言的版本' };
  if (isVersionActive(v)) return { ok: false, reason: '这个版本还在生成中' };
  if (v.status !== 'done' || !v.voice_asset_id) return { ok: false, reason: v.error ? `这个版本生成失败：${v.error}` : '这个版本还没有口播，先在「生成口播」里生成' };
  if (v.voice_stale) return { ok: false, reason: '译文已重新翻译，口播还没更新：先在「生成口播」里重新生成' };
  const asset = assets.find((a) => a.id === v.voice_asset_id);
  if (!asset) return { ok: false, reason: '配音素材不存在（可能已被删除），请重新生成' };
  if (!isAssetReady(asset)) return { ok: false, reason: '配音素材还在处理中，稍后再试' };
  return { ok: true };
}

/**
 * 把某个语言版本套用到 spec 上（原地修改，给 updateSpec 的回调用，一次调用 = 一步历史）：
 * 1. 先删掉所有 origin = 'localize' 的层 / 轨——不管是哪种语言，同一时间只能套用一个版本；
 * 2. 源音轨静音，加配音轨（对齐源时间轴、全程）；
 * 3. 有 Demucs 伴奏就加一条 bgm 轨（混音只出「配音 + 静音」，BGM 由这里补），否则记警告；
 * 4. 译文字幕层 append 到 layers 末尾（压在任何遮盖层之上），样式沿用上一次生成的译文字幕层
 *    （用户调过的样式 / 位置不丢；换语言时只把自动选的字体换成新语言的）。
 * 返回警告列表；版本不可用时不改动 spec，只返回原因。调用方应先过 canApplyVersion。
 */
export function applyLocalizationToSpec(spec: EditSpec, lang: string, ctx: ApplyContext): string[] {
  const { video, assets } = ctx;
  const version = video.localization?.versions?.[lang];
  if (!version || version.status !== 'done' || !version.voice_asset_id) return ['该语言版本还没有配音，不能套用'];
  const warnings: string[] = [];

  // 上一次生成的译文字幕：样式与位置沿用；没有上一版时才用识别出来的字幕带（HIG-38）
  const template = localizeLayerTemplate(spec, lang);
  const style = template.style ?? (ctx.band?.style ? { ...localizeTextStyle(lang), ...ctx.band.style } : undefined);
  const placement = template.placement ?? (ctx.band ? { anchor: ctx.band.anchor, margin: ctx.band.margin } : undefined);
  const timingWarning = applyAdaptiveTiming(spec, video, version, ctx.newClipId);
  if (timingWarning) warnings.push(timingWarning);

  // 1. 清掉旧的层 / 轨；明确替换配乐时也移除已有 BGM，避免叠音。
  spec.layers = spec.layers.filter((l) => l.origin !== LOCALIZE_ORIGIN);
  if (!spec.audio) spec.audio = { source_volume: 1, tracks: [] };
  spec.audio.tracks = spec.audio.tracks.filter((t) => t.origin !== LOCALIZE_ORIGIN && !(ctx.bgm?.mode === 'replace' && (t.role ?? 'bgm') === 'bgm'));

  // 2. 源音轨静音 + 配音轨
  setOwnerSourceGain(spec, video.id, 0);
  spec.audio.tracks.push({ id: ctx.newTrackId(), asset_id: version.voice_asset_id, role: 'voice', align: version.adaptive_timing ? 'post' : 'source', t: 'all', volume: 1, loop: false, origin: LOCALIZE_ORIGIN, lang });

  // 3. 原伴奏或指定的新 BGM
  const sep = video.separation;
  const instId = sep?.status === 'done' ? sep.instrumental_asset_id : null;
  const instAsset = instId ? assets.find((a) => a.id === instId) : undefined;
  const userTracks = spec.audio.tracks.filter((t) => t.origin !== LOCALIZE_ORIGIN);
  if (ctx.bgm?.mode === 'replace') {
    const replacementId = ctx.bgm.assetId;
    const replacement = assets.find((a) => a.id === replacementId);
    if (replacement && isAssetReady(replacement)) {
      spec.audio.tracks.push({ id: ctx.newTrackId(), asset_id: replacement.id, role: 'bgm', align: 'post', t: 'all', volume: 0.6, loop: true, fade_out: 1, origin: LOCALIZE_ORIGIN, lang });
    } else warnings.push('所选 BGM 不可用，请重新选择');
  } else if (instId && instAsset && isAssetReady(instAsset)) {
    // 用户已经用「只留伴奏」加过这条伴奏轨：不重复叠一份
    if (!userTracks.some((t) => t.asset_id === instId)) {
      spec.audio.tracks.push({ id: ctx.newTrackId(), asset_id: instId, role: 'bgm', align: 'source', t: 'all', volume: 1, loop: false, origin: LOCALIZE_ORIGIN, lang });
    }
  } else {
    warnings.push('还没有分离出的伴奏，成片只有配音没有背景音乐；到「音频」模块分离人声 / 伴奏后重新套用即可补上');
  }
  const vocalsId = sep?.status === 'done' ? sep.vocals_asset_id : null;
  if (vocalsId && userTracks.some((t) => t.asset_id === vocalsId)) warnings.push('音频里还有分离出的原人声轨，会和配音重叠，建议删掉');

  // 4. 译文字幕层
  const cues = mergedCues(video.localization?.transcript, version);
  const postDuration = spec.sequence ? sequenceDuration(spec.sequence) : postTrimDuration(video.duration, spec.trim.remove);
  const layers = localizedCuesToLayers(cues, { lang, langLabel: ctx.langLabel, remove: spec.trim.remove, postDuration, style, placement, split: ctx.split, newId: ctx.newLayerId });
  spec.layers.push(...layers);
  if (!layers.length) warnings.push('这个版本没有可显示的译文字幕');
  return warnings;
}

/**
 * 当前 spec 套用的是哪个语言版本：applied = 配音轨用的正是该版本现在的配音素材；
 * stale = 版本重新生成过（素材 id 变了）/ 版本被删 / 配音轨被用户删掉只剩字幕层——提示「重新套用」。
 * 没有任何 origin = 'localize' 的层 / 轨时返回 null。
 */
export function appliedVersion(spec: EditSpec | null | undefined, loc: Localization | null | undefined): { lang: string; state: 'applied' | 'stale' } | null {
  if (!spec) return null;
  const tracks = localizeTracks(spec);
  const layers = localizeLayers(spec);
  const lang = tracks.find((t) => t.lang)?.lang ?? layers.find((l) => l.lang)?.lang;
  if (!lang) return null;
  const version = loc?.versions?.[lang];
  const voice = tracks.find((t) => t.role === 'voice' && t.lang === lang);
  const fresh = !!version && version.status === 'done' && !!voice && voice.asset_id === version.voice_asset_id;
  return { lang, state: fresh ? 'applied' : 'stale' };
}

/**
 * 去掉改语言套用出来的层 / 轨（原地修改），给多语言导出里的「原版」用（HIG-43）。
 * 套用时把源音轨静了音、spec 里没记原来的音量：删掉过配音轨且源音量为 0 时恢复成 1（默认值）。
 */
export function stripLocalization(spec: EditSpec, ownerId?: string): void {
  if (ownerId) Object.assign(spec, normalizeSequenceAudio(spec, ownerId));
  spec.layers = spec.layers.filter((l) => l.origin !== LOCALIZE_ORIGIN);
  if (!spec.audio) return;
  const hadVoice = spec.audio.tracks.some((t) => t.origin === LOCALIZE_ORIGIN && t.role === 'voice');
  spec.audio.tracks = spec.audio.tracks.filter((t) => t.origin !== LOCALIZE_ORIGIN);
  if (hadVoice && spec.sequence && ownerId) {
    for (const clip of spec.sequence.clips) if (clip.video_id === ownerId && clip.source_volume === 0) clip.source_volume = 1;
  } else if (hadVoice && spec.audio.source_volume === 0) spec.audio.source_volume = 1;
}

/** 批量套用对话框的提示：对齐源时间轴的音轨 / 改语言生成的字幕都是按这条视频算的，套到别的视频会错位。 */
export function applyCrossVideoWarnings(spec: EditSpec | null | undefined): string[] {
  if (!spec) return [];
  const out: string[] = [];
  if (spec.audio?.tracks.some((t) => t.align === 'source')) out.push('当前音频里有对齐源时间轴的音轨（分离结果 / 配音），它们是按这条视频生成的，套到别的视频会错位。');
  if (spec.layers.some((l) => l.origin === LOCALIZE_ORIGIN)) out.push('当前图层里有改语言生成的译文字幕，时段按这条视频的听写结果排的，套到别的视频会错位。');
  // HIG-38：画面文字的框和时段是这条视频画面独有的，换一条视频必然对不上。
  if (spec.layers.some((l) => l.origin === 'screen')) out.push('当前图层里有画面文字本地化生成的层，位置和时段按这条视频的画面识别出来的，套到别的视频会错位。');
  if (spec.source_variant === 'clean') out.push('当前正片用的是这条视频的无字版源片，别的视频没有对应的无字版，套过去会自动回落到原片。');
  return out;
}

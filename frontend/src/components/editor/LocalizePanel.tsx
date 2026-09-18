// 「改语言」模块（需求 5）：听写一次出模板 → 按目标语言翻译 → 生成口播（合成 + 混音，HIG-56 拆成单独一步）→ 套用到本条视频。
// 五个可折叠分组，与剪辑面板（HIG-17）同一套 Section。状态都在 video.localization 上，后台任务由 store 轮询；
// 这里只管展示、编辑草稿（逐句文本 / 音色 / 术语表）、发请求。语言与音色列表来自 GET /api/localize/options，不写死。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../../store/editor';
import { player } from '../../lib/player';
import { formatTime } from '../../lib/time';
import { appliedVersion, canApplyVersion, dubbableLangs, isLocalizationActive, isVersionActive, langLabel, mergedCues, parseTerms, termsToText, transcriptStatusText, versionStatusText, voiceLabel } from '../../lib/localize';
import { loadFeaturePrefs, saveFeaturePrefs } from '../../lib/featurePrefs';
import { IconChevron } from '../ui/Icons';
import { Section } from '../ui/Section';
import { Field } from '../ui/Num';
import { VoiceSelect } from './VoiceSelect';
import type { Localization, LocalizationVersion, LocalizeIn, LocalizeOptions, Video } from '../../types';

const TRANSCRIPT_HELP = '听写只做一次，结果是所有语言版本的模板：先在这里把识别错的句子改对，再翻译，译文质量最好。时间点击可跳播放头；播放时当前句高亮。保存修正不会自动重译，已有版本会标「需重译」。';
const GENERATE_HELP = '勾选目标语言后一键翻译：模板没听写过时同一个任务会先听写。术语表每行「原词=译词」，翻译时强制替换（品牌名、产品名）。已有版本的语言再翻译会覆盖旧译文；旧口播保留但标「口播待更新」，要在「生成口播」里重新生成。';
const DUB_HELP = '按译文合成目标语言口播：每种语言选一个音色，逐句合成后按原句时间铺好混成一条配音。打开「生成后自动套用」时，口播生成完会直接套用到这条视频（原声静音、加配音轨和译文字幕，⌘Z 可撤销）；一次选多种语言时只自动套用排在最前、成功的那个，其余在「套用」里切换或「导出多语言」。';
const VERSIONS_HELP = '每个语言版本独立：展开可逐句改译文、换音色，「重新合成」只重跑口播（不重新翻译）。「需重译」表示模板改过之后译文没更新，点「重译」对该语言再翻译一遍。';
const APPLY_HELP = '套用把当前视频的源音轨静音，加一条配音轨（对齐源时间轴）和一条 Demucs 伴奏轨（如果分离过），再把译文按句变成字幕层贴底居中（按画布宽 90% 自动换行，画布上拖字幕框左右边可调换行宽度），⌘Z 一步撤销。同一时间只能套用一个语言版本，换版本会替换上一版的层和轨；用户自己加的文字 / 贴纸 / 音轨不动，字幕样式可在「文本」模块里调、重新套用时保留。结果只对本条视频有效：要导出多个语言的成片，套用一版 → 导出 → 换另一版再导出。';

interface SectionProps {
  video: Video;
  loc: Localization | null;
  options: LocalizeOptions | null;
  /** 没配 key / 没音轨 / 视频没就绪 / 有任务在跑：会 400 / 409 的操作都禁掉。 */
  blocked: boolean;
}

/** 「生成版本」里的选择（目标语言 / 音色 / 术语表），提到面板层：听写按钮也要用它们组请求。 */
interface GenerateDraft {
  selected: string[];
  setSelected: (fn: (s: string[]) => string[]) => void;
  voices: Record<string, string>;
  setVoices: (fn: (v: Record<string, string>) => Record<string, string>) => void;
  termsText: string;
  setTermsText: (v: string) => void;
}

/** 听写（模板）：源语言、听写按钮、逐句可编辑列表、保存修正。 */
function TranscriptSection({ video, loc, options, blocked, sourceLang, setSourceLang, requestFor }: SectionProps & { sourceLang: string; setSourceLang: (v: string) => void; requestFor: (retranscribe: boolean) => LocalizeIn | null }) {
  const localizeVideo = useEditor((s) => s.localizeVideo);
  const updateTranscript = useEditor((s) => s.updateTranscript);
  const setToast = useEditor((s) => s.setToast);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const t = loc?.transcript ?? null;
  const cues = t?.status === 'done' ? t.cues : [];
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  // 换视频 / 服务器回了新模板：本地草稿作废
  useEffect(() => setDrafts({}), [video.id, t?.updated_at]);
  const currentRef = useRef<HTMLDivElement>(null);
  const currentI = useMemo(() => cues.find((c) => time >= c.start && time < c.end)?.i ?? null, [cues, time]);
  useEffect(() => {
    if (playing) currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentI, playing]);

  const transcribing = t?.status === 'queued' || t?.status === 'running';
  const changed = cues.filter((c) => drafts[c.i] !== undefined && drafts[c.i] !== c.text);
  const langChanged = !!loc && t?.status === 'done' && sourceLang !== 'auto' && sourceLang !== loc.source_lang;
  const versionCount = Object.keys(loc?.versions ?? {}).length;
  // 听写和生成是同一个任务（契约：target_langs 1–5 个），没有目标语言就不能单独听写
  const transcribe = (retranscribe: boolean) => {
    const req = requestFor(retranscribe);
    if (!req) {
      setToast('听写和翻译是同一个任务：先在「翻译」里勾选至少一种目标语言');
      return;
    }
    void localizeVideo(req);
  };
  const save = () => void updateTranscript(changed.map((c) => ({ i: c.i, text: drafts[c.i] })), langChanged ? sourceLang : undefined);
  const summary = `${transcriptStatusText(t)}${loc && t?.status === 'done' ? ` · ${langLabel(options, loc.source_lang)}` : ''}`;

  return (
    <Section id="localize.transcript" title="听写（模板）" bodyClass="stack" summary={<span>{summary}</span>} help={TRANSCRIPT_HELP}>
      <Field label="源语言">
        <select className="select sm" value={sourceLang} disabled={blocked} onChange={(e) => setSourceLang(e.target.value)} aria-label="源语言">
          {/* 后端的 source_langs 也含 auto：这里固定放第一个，列表里的去重 */}
          <option value="auto">自动识别</option>
          {options?.source_langs.filter((l) => l.code !== 'auto').map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </Field>
      <div className="inline">
        <button className="btn action" disabled={blocked} title={t?.status === 'done' ? '丢掉现在的模板重新听写，并重新翻译已有的（或已勾选的）语言版本' : '把源音轨听写成文字模板并翻译成勾选的语言（后台任务）'} onClick={() => transcribe(t?.status === 'done')}>
          {transcribing ? '听写中…' : t?.status === 'done' ? '重新听写' : '听写'}
        </button>
        <span className={`small ${t?.status === 'failed' ? 'error-text' : 'muted'}`}>{transcriptStatusText(t)}</span>
      </div>
      {t?.status === 'failed' && t.error && <div className="error-text">{t.error}</div>}
      {t?.status === 'done' && cues.length === 0 && <div className="hint">没有听写到任何句子：源音轨里可能没有人声。</div>}
      {cues.length > 0 && (
        <>
          <div className="cue-list">
            {cues.map((c) => {
              const val = drafts[c.i] ?? c.text;
              const edited = drafts[c.i] !== undefined && drafts[c.i] !== c.text;
              const cur = c.i === currentI;
              return (
                <div key={c.i} className={`cue-item ${cur ? 'current' : ''}`} ref={cur ? currentRef : undefined}>
                  <button type="button" className="cue-time" title="跳到这句（源时间）" onClick={() => player.seek(c.start)}>
                    {formatTime(c.start)}
                  </button>
                  <textarea className={`cue-text ${edited ? 'edited' : ''}`} rows={2} value={val} disabled={blocked} aria-label={`第 ${c.i + 1} 句`} onChange={(e) => setDrafts((d) => ({ ...d, [c.i]: e.target.value }))} />
                </div>
              );
            })}
          </div>
          <div className="inline">
            <button className="btn sm" disabled={blocked || (!changed.length && !langChanged)} onClick={save}>
              保存修正{changed.length ? `（${changed.length} 句）` : ''}
            </button>
            {changed.length > 0 && (
              <button className="btn ghost sm" onClick={() => setDrafts({})}>
                放弃修改
              </button>
            )}
            {(changed.length > 0 || langChanged) && versionCount > 0 && <span className="hint">保存后已有的 {versionCount} 个版本需要重译</span>}
          </div>
        </>
      )}
    </Section>
  );
}

/** 音色：这次选的 > 已有版本用的 > 该语言第一个。 */
function pickVoice(code: string, voices: Record<string, string>, loc: Localization | null, options: LocalizeOptions | null): string {
  return voices[code] ?? loc?.versions?.[code]?.voice ?? options?.target_langs.find((t) => t.code === code)?.voices[0]?.id ?? '';
}

/** 翻译：目标语言多选、术语表、一键翻译（只翻译不合成，HIG-56）。 */
function GenerateSection({ loc, options, blocked, requestFor, draft }: SectionProps & { requestFor: (retranscribe: boolean) => LocalizeIn | null; draft: GenerateDraft }) {
  const localizeVideo = useEditor((s) => s.localizeVideo);
  const targets = options?.target_langs ?? [];
  const { selected, setSelected, termsText, setTermsText } = draft;
  const toggle = (code: string) => setSelected((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]));
  const n = selected.length;
  const transcriptDone = loc?.transcript?.status === 'done';
  const generate = () => {
    const req = requestFor(false);
    if (req) void localizeVideo(req);
  };

  return (
    <Section id="localize.generate" title="翻译" bodyClass="stack" summary={<span>{n ? `已选 ${n} 种语言` : `${targets.length} 种可选`}</span>} help={GENERATE_HELP}>
      <div className="chips" role="group" aria-label="目标语言">
        {targets.map((t) => {
          const has = !!loc?.versions?.[t.code];
          const on = selected.includes(t.code);
          return (
            <button key={t.code} className={`chip ${on ? 'active' : ''}`} aria-pressed={on} disabled={blocked} title={has ? '已有这个语言的译文，再翻译会覆盖' : undefined} onClick={() => toggle(t.code)}>
              {t.label}
              {has ? ' ·' : ''}
            </button>
          );
        })}
        {targets.length === 0 && <span className="hint">没有可用的目标语言。</span>}
      </div>
      <div className="stack-2">
        <span className="small muted">术语表 · 每行「原词=译词」，翻译时强制替换</span>
        <textarea className="textarea" rows={3} placeholder="HitGO=힛고" value={termsText} disabled={blocked} aria-label="术语表" onChange={(e) => setTermsText(e.target.value)} />
      </div>
      <button className="btn action" disabled={blocked || !n} onClick={generate} title="后台任务：每种语言十几秒，翻译期间可以继续编辑">
        {n === 0 ? '先勾选目标语言' : transcriptDone ? `翻译 ${n} 种语言` : `听写并翻译 ${n} 种语言`}
      </button>
    </Section>
  );
}

/** 生成口播（HIG-56）：已翻译的语言各选音色、勾选后合成；完成后可自动套用。 */
function DubSection({ loc, options, blocked, voices, setVoices }: SectionProps & Pick<GenerateDraft, 'voices' | 'setVoices'>) {
  const dubVersions = useEditor((s) => s.dubVersions);
  const langs = useMemo(() => dubbableLangs(loc, options), [loc, options]);
  // 勾选：用户点过的以用户为准，没点过的默认勾「还没有能用口播」的语言
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [autoApply, setAutoApply] = useState(() => loadFeaturePrefs().autoApplyDub);
  const isOn = (lang: string, dubbed: boolean) => picked[lang] ?? !dubbed;
  const chosen = langs.filter((l) => isOn(l.lang, l.dubbed));
  const n = chosen.length;
  const dubbing = Object.values(loc?.versions ?? {}).filter((v) => isVersionActive(v) && v.stage !== 'translate' && v.cues.length > 0 && v.dub !== false).length;
  const start = () => {
    void dubVersions(chosen.map(({ lang }) => ({ lang, voice: pickVoice(lang, voices, loc, options) })));
    setPicked({});
  };
  const summary = dubbing ? `生成中 ${dubbing} 种` : langs.length ? `${langs.filter((l) => l.dubbed).length} / ${langs.length} 已有口播` : '先翻译';

  return (
    <Section id="localize.dub" title="生成口播" bodyClass="stack" summary={<span>{summary}</span>} help={DUB_HELP}>
      {langs.length === 0 ? (
        <div className="hint">还没有翻译好的语言。先在上面「翻译」里勾选目标语言并翻译。</div>
      ) : (
        <div className="dub-list">
          {langs.map(({ lang, dubbed }) => {
            const t = options?.target_langs.find((x) => x.code === lang);
            const label = langLabel(options, lang);
            const v = loc!.versions[lang];
            return (
              <div key={lang} className="dub-row">
                <label className="inline dub-check" title={dubbed ? '已有口播，勾上会按当前译文和音色重新生成' : '还没有能用的口播'}>
                  <input type="checkbox" checked={isOn(lang, dubbed)} disabled={blocked} onChange={(e) => setPicked((p) => ({ ...p, [lang]: e.target.checked }))} />
                  <span className="dub-lang">{label}</span>
                </label>
                <VoiceSelect lang={lang} voices={t?.voices ?? []} value={pickVoice(lang, voices, loc, options)} onChange={(id) => setVoices((m) => ({ ...m, [lang]: id }))} disabled={blocked} ariaLabel={`${label}音色`} />
                <span className={`small ${dubbed ? 'muted' : 'warn-text'}`}>{dubbed ? '已有口播' : v.voice_stale ? '待更新' : '无口播'}</span>
              </div>
            );
          })}
        </div>
      )}
      <label className="inline small">
        <input
          type="checkbox"
          checked={autoApply}
          onChange={(e) => {
            setAutoApply(e.target.checked);
            saveFeaturePrefs({ autoApplyDub: e.target.checked });
          }}
        />
        生成后自动套用到这条视频
      </label>
      <button className="btn action" disabled={blocked || !n} onClick={start} title="后台任务：每种语言约半分钟，生成期间可以继续编辑">
        {n === 0 ? '先勾选要生成口播的语言' : `生成 ${n} 种语言口播`}
      </button>
    </Section>
  );
}

/** 版本列表里的一行：状态 / stale / 展开后逐句译文 + 音色 + 重新合成 + 删除。 */
function VersionRow({ loc, lang, version: v, options, blocked }: SectionProps & { lang: string; version: LocalizationVersion }) {
  const localizeVideo = useEditor((s) => s.localizeVideo);
  const resynthesizeVersion = useEditor((s) => s.resynthesizeVersion);
  const deleteVersion = useEditor((s) => s.deleteVersion);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [voice, setVoice] = useState(v.voice ?? '');
  useEffect(() => {
    setDrafts({});
    setVoice(v.voice ?? '');
  }, [v.updated_at, v.voice]);
  const cues = useMemo(() => mergedCues(loc?.transcript, v), [loc?.transcript, v]);
  const changed = cues.filter((c) => drafts[c.i] !== undefined && drafts[c.i] !== c.translated);
  const voiceChanged = !!voice && voice !== (v.voice ?? '');
  const active = isVersionActive(v);
  const label = langLabel(options, lang);
  const voiceOpts = options?.target_langs.find((t) => t.code === lang)?.voices ?? [];
  const hasTranslation = cues.some((c) => c.translated.trim());
  // 重译沿用这一版有没有口播：有就连口播一起重出，只翻译过的仍只翻译
  const retranslate = () => void localizeVideo({ source_lang: loc?.source_lang, target_langs: [lang], ...(v.voice ? { voices: { [lang]: v.voice } } : {}), terms: v.terms ?? [], dub: !!v.voice_asset_id });
  const resynth = () => void resynthesizeVersion(lang, changed.map((c) => ({ i: c.i, translated: drafts[c.i] })), voiceChanged ? voice : undefined);
  const remove = () => {
    if (window.confirm(`删除${label}版及其配音素材？已套用到视频上的层 / 轨不会自动删除。`)) void deleteVersion(lang);
  };

  return (
    <div className="track-item version-item">
      <div className="track-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen((o) => !o)} onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}>
        <span className="role lang">{label}</span>
        <span className={`tname small ${v.status === 'failed' ? 'error-text' : 'muted'}`}>
          {versionStatusText(v)}
          {v.status === 'done' && v.voice ? ` · ${voiceLabel(options, lang, v.voice)}` : ''}
        </span>
        {v.stale && <span className="badge-stale" title="模板改过之后译文没有更新">需重译</span>}
        <IconChevron open={open} />
      </div>
      {v.status === 'failed' && v.error && <div className="error-text">{v.error}</div>}
      {v.stale && !active && (
        <div className="inline">
          <span className="hint">模板已改，这版译文不是最新的。</span>
          <button className="btn sm" disabled={blocked} onClick={retranslate} title={v.voice_asset_id ? '按最新模板重新翻译并重新生成口播' : '按最新模板重新翻译'}>重译</button>
        </div>
      )}
      {(v.warnings?.length ?? 0) > 0 && (
        <ul className="warn-list">
          {v.warnings!.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {open && (
        <>
          {cues.length === 0 ? (
            <div className="hint">还没有译文。</div>
          ) : (
            <div className="cue-list">
              {cues.map((c) => {
                const val = drafts[c.i] ?? c.translated;
                const edited = drafts[c.i] !== undefined && drafts[c.i] !== c.translated;
                return (
                  <div key={c.i} className="cue-item">
                    <button type="button" className="cue-time" title="跳到这句（源时间）" onClick={() => player.seek(c.start)}>
                      {formatTime(c.start)}
                    </button>
                    <div className="cue-src" title="模板原文">{c.text}</div>
                    <textarea className={`cue-text ${edited ? 'edited' : ''}`} rows={2} value={val} disabled={blocked} aria-label={`第 ${c.i + 1} 句译文`} placeholder="（无译文）" onChange={(e) => setDrafts((d) => ({ ...d, [c.i]: e.target.value }))} />
                  </div>
                );
              })}
            </div>
          )}
          <Field label="音色">
            <VoiceSelect lang={lang} voices={voiceOpts} value={voice} onChange={setVoice} disabled={blocked} ariaLabel={`${label}音色`} keepUnknown />
          </Field>
          <div className="inline">
            <button className="btn sm" disabled={blocked || !hasTranslation || (!changed.length && !voiceChanged)} onClick={resynth} title="只重新生成口播，不重新翻译；只传改过的句子">
              重新合成{changed.length ? `（${changed.length} 句）` : voiceChanged ? '（换音色）' : ''}
            </button>
            {changed.length > 0 && (
              <button className="btn ghost sm" onClick={() => setDrafts({})}>
                放弃修改
              </button>
            )}
            <span className="spacer" />
            <button className="btn ghost sm danger" disabled={active} onClick={remove}>
              删除版本
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function VersionsSection(props: SectionProps) {
  const { loc, options } = props;
  const order = options?.target_langs.map((t) => t.code) ?? [];
  const rank = (code: string) => (order.indexOf(code) + 1 || 999);
  const versions = Object.entries(loc?.versions ?? {}).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  const summary = versions.length ? versions.map(([l, v]) => `${langLabel(options, l)}${v.status === 'done' ? '' : ` ${versionStatusText(v)}`}`).join(' · ') : '无';
  return (
    <Section id="localize.versions" title="版本列表" bodyClass="stack" summary={<span>{summary}</span>} help={VERSIONS_HELP}>
      {versions.length === 0 ? (
        <div className="hint">还没有语言版本。在「翻译」里勾选目标语言后翻译。</div>
      ) : (
        <div className="track-list">
          {versions.map(([lang, v]) => (
            <VersionRow key={lang} {...props} lang={lang} version={v} />
          ))}
        </div>
      )}
    </Section>
  );
}

/** 套用：当前套用的版本与状态、每个 done 版本一个按钮、没伴奏的提示。 */
function ApplySection({ video, loc, options }: SectionProps) {
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const assets = useEditor((s) => s.assets);
  const applyVersion = useEditor((s) => s.applyVersion);
  const openExport = useEditor((s) => s.openExport);
  const applied = appliedVersion(spec, loc);
  const versions = Object.entries(loc?.versions ?? {}).filter(([, v]) => v.status === 'done');
  const sepDone = video.separation?.status === 'done' && !!video.separation.instrumental_asset_id;
  const summary = applied ? `${langLabel(options, applied.lang)}版${applied.state === 'applied' ? '' : '（需重新套用）'}` : '未套用';

  return (
    <Section id="localize.apply" title="套用" bodyClass="stack" summary={<span>{summary}</span>} help={APPLY_HELP}>
      <Field label="当前">
        {applied ? (
          <>
            <b>{langLabel(options, applied.lang)}版</b>
            {applied.state === 'applied' ? <span className="badge-ok">已套用</span> : <span className="badge-stale">配音已更新，请重新套用</span>}
          </>
        ) : (
          <span className="muted small">未套用（原声 + 原字幕）</span>
        )}
      </Field>
      {versions.length === 0 ? (
        <div className="hint">生成了口播的版本会出现在这里，点一下就套用到这条视频。</div>
      ) : (
        <div className="inline">
          {versions.map(([lang]) => {
            const check = canApplyVersion(video, lang, assets);
            const isCur = applied?.lang === lang && applied.state === 'applied';
            const label = langLabel(options, lang);
            return (
              <button key={lang} className={`btn ${isCur ? 'on' : ''}`} disabled={!check.ok || isCur} title={!check.ok ? check.reason : isCur ? '已是当前套用的版本' : `把配音轨和译文字幕换成${label}版（替换上一版的层 / 轨）`} onClick={() => applyVersion(lang)}>
                {isCur ? `已套用${label}版` : `套用${label}版`}
              </button>
            );
          })}
          {applied?.state === 'applied' && (
            <button className="btn ghost sm" title="按当前版本重建字幕层和配音轨（沿用已调过的字幕样式与位置）" onClick={() => applyVersion(applied.lang, { force: true })}>
              重新套用
            </button>
          )}
        </div>
      )}
      {versions.some(([lang]) => canApplyVersion(video, lang, assets).ok) && (
        <div className="inline">
          <button
            className="btn sm"
            title="一次导出多个语言版本：每个语言各出一份成片（不改当前套用）"
            onClick={() => openExport({ scope: 'current', langs: versions.map(([lang]) => lang).filter((lang) => canApplyVersion(video, lang, assets).ok) })}
          >
            导出多语言…
          </button>
        </div>
      )}
      {!sepDone && <div className="hint">还没有分离出的伴奏：套用后成片只有配音没有背景音乐。到「音频」模块分离后再点一次套用即可补上。</div>}
    </Section>
  );
}

export function LocalizePanel() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const options = useEditor((s) => s.localizeOptions);
  const loadLocalizeOptions = useEditor((s) => s.loadLocalizeOptions);
  useEffect(() => {
    void loadLocalizeOptions();
  }, [loadLocalizeOptions]);
  const loc = video?.localization ?? null;
  const [sourceLang, setSourceLang] = useState(loc?.source_lang ?? 'auto');
  // 换视频 / 服务器识别出语言后跟着更新
  useEffect(() => {
    setSourceLang(loc?.source_lang ?? 'auto');
  }, [video?.id, loc?.source_lang]);
  // 「翻译」「生成口播」的选择：换视频时清掉，术语表预填已有版本的
  const [selected, setSelected] = useState<string[]>([]);
  const [voices, setVoices] = useState<Record<string, string>>({});
  const [termsText, setTermsText] = useState('');
  useEffect(() => {
    setSelected([]);
    setVoices({});
    setTermsText(termsToText(Object.values(video?.localization?.versions ?? {})[0]?.terms));
  }, [video?.id]);
  const draft: GenerateDraft = { selected, setSelected, voices, setVoices, termsText, setTermsText };
  /**
   * 组一次 POST localize 的请求。目标语言 = 勾选的；重新听写且没勾选时 = 已有的所有版本（重听写后它们都得重译）。
   * 一个都没有返回 null（契约要求 target_langs 至少一个）。
   */
  const requestFor = (retranscribe: boolean): LocalizeIn | null => {
    const langs = selected.length ? selected : retranscribe ? Object.keys(loc?.versions ?? {}) : [];
    if (!langs.length) return null;
    return {
      source_lang: sourceLang,
      target_langs: langs,
      voices: Object.fromEntries(langs.map((c) => [c, pickVoice(c, voices, loc, options)]).filter(([, v]) => v)),
      terms: parseTerms(termsText),
      retranscribe,
      dub: false,
    };
  };

  const active = isLocalizationActive(loc);
  const enabled = !!options?.enabled;
  const hasAudio = !!video?.has_audio;
  const ready = video?.status === 'ready';
  const blocked = !enabled || !hasAudio || !ready || active;

  return (
    <div className="panel">
      <div className="panel-head">
        <span>改语言</span>
        {active && <span className="small muted">处理中…</span>}
      </div>
      <div className="panel-body inspector">
        {options === null ? (
          <div className="hint">正在读取可用语言…</div>
        ) : !options.enabled ? (
          <div className="error-text">服务器没有配置百炼 API Key（DASHSCOPE_API_KEY），改语言功能不可用；配置后重启后端即可。</div>
        ) : null}
        {video && !hasAudio && <div className="error-text">源视频没有音轨，没法听写。</div>}
        {video && !ready && <div className="error-text">视频还在预处理，就绪后再来。</div>}
        {video && (
          <>
            <TranscriptSection video={video} loc={loc} options={options} blocked={blocked} sourceLang={sourceLang} setSourceLang={setSourceLang} requestFor={requestFor} />
            <GenerateSection video={video} loc={loc} options={options} blocked={blocked} requestFor={requestFor} draft={draft} />
            <DubSection video={video} loc={loc} options={options} blocked={blocked} voices={voices} setVoices={setVoices} />
            <VersionsSection video={video} loc={loc} options={options} blocked={blocked} />
            <ApplySection video={video} loc={loc} options={options} blocked={blocked} />
          </>
        )}
      </div>
    </div>
  );
}

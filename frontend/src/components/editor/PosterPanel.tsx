// 「大字报」模块（HIG-50）：整篇文案在安全区框里向上滚 + 可选朗读 + 自动挑重点词上色。
// 面板只管一条滚动文字图层（当前 spec 里第一条带 scroll 的文字图层；选中的那条带 scroll 时优先）。
// 几何 / 时长都是 lib/poster 的纯函数；改 spec、合成朗读、同步成片时长在 store（addPosterLayer / setScroll /
// setPosterText / generateVoice / autoHighlight）。样式分组直接复用文本模块的 TextSections。

import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { useEditor, type ApplyModule } from '../../store/editor';
import { fitScrollSpeed, resolveScroll, SCROLL_SPEED_MAX, SCROLL_SPEED_MIN, scrollLayerDuration, scrollSummary } from '../../lib/poster';
import { normalizeSpans } from '../../lib/textSpans';
import { splitByPunctuation } from '../../lib/posterSplit';
import { loadFeaturePrefs, saveFeaturePrefs, type FeaturePrefs, type PunctMode } from '../../lib/featurePrefs';
import { VIDEO_ACCEPT, VIDEO_ACCEPT_LABEL } from '../../lib/fileDrop';
import { formatSeconds } from '../../lib/time';
import { voiceSupportsRate } from '../../lib/localize';
import type { Asset, AudioTrack, EditSpec, ScrollBox, TextLayer, Video } from '../../types';
import { IconSpinner, IconTrash } from '../ui/Icons';
import { Section } from '../ui/Section';
import { Field, Num } from '../ui/Num';
import { TextSections } from './LayerParts';
import { VoiceSelect } from './VoiceSelect';

const COPY_HELP = '整篇文案烘焙成一张高图，按框宽自动折行（手动换行保留），在框里向上滚过。改字后成片时长会跟着滚动全程重新算；文案越长滚得越久。打开「粘贴时按标点分行」后，粘进来的文案在，。！？；、：等标点后自动换行，行尾标点按右边的设置保留或去掉；已经在框里的文案可以点「按标点重新分行」。';
const BACKGROUND_HELP = '一条文案配多个背景一起出片：在这里勾选本批次里的其它素材（或直接上传多个视频 / 图片，上传完自动勾上），点「应用到所选背景」把当前这条的滚动文字、成片时长、画面和朗读轨复制过去，再「导出」把当前这条和所选背景一次提交。勾选和左栏的勾选是同一份。';
const PUNCT_OPTIONS: { key: PunctMode; label: string }[] = [
  { key: 'keep', label: '保留标点' },
  { key: 'drop-pause', label: '去掉逗号类' },
  { key: 'drop-all', label: '去掉全部标点' },
];
/** 铺到其它背景时带上的模块：滚动文字（图层）、成片时长（剪辑）、画面、朗读轨（音频）。 */
const BACKGROUND_MODULES: ApplyModule[] = ['trim', 'layers', 'outputs', 'audio'];
const SCROLL_HELP = '速度单位是「画布高 / 秒」：0.08 表示每秒滚过画布高的 8%。框是文案露出的区域，缺省取当前安全区。「开头就有字」= 第一屏不从底边滚入而是直接显示首行，可停留几秒再滚；「结尾停留」= 末行到框底就停住，不再滚出。';
const VOICE_HELP = '把当前文案交给百炼 TTS 合成一条朗读音轨（素材库里 stem = tts 的派生音频），加到音频轨；成片时长取滚动与朗读较长者。「配合朗读调速」把滚动全程调成和朗读一样长。';
const HIGHLIGHT_HELP = '交给大模型从文案里挑重点词组，按黄 / 绿 / 红 / 蓝轮流上色（合并进已有的上色区间）。想手动挑：到「文本」模块的文本框里选中文字再「上色」。';
const RATES = [0.8, 0.9, 1.0, 1.1, 1.2];
const fmt1 = (n: number) => `${n.toFixed(1)} s`;

/** 当前的大字报图层：选中的带 scroll 优先，否则第一条带 scroll 的文字图层。 */
function posterLayerOf(spec: EditSpec | null, selectedId: string | null): TextLayer | null {
  if (!spec) return null;
  const isPoster = (l: EditSpec['layers'][number]): l is TextLayer => l.type === 'text' && !!l.scroll;
  const sel = selectedId ? spec.layers.find((l) => l.id === selectedId) : undefined;
  if (sel && isPoster(sel)) return sel;
  return spec.layers.find(isPoster) ?? null;
}

/** 朗读轨：role = voice 且素材是 TTS 派生的那条（改语言的配音轨 stem = dubbed，不算）。 */
function voiceTrackOf(spec: EditSpec | null, assets: Asset[]): { track: AudioTrack; asset: Asset | undefined } | null {
  for (const t of spec?.audio?.tracks ?? []) {
    if (t.role !== 'voice') continue;
    const asset = assets.find((a) => a.id === t.asset_id);
    if (asset?.derived_from?.stem === 'tts') return { track: t, asset };
  }
  return null;
}

const charCount = (text: string) => Array.from(text.replace(/\s+/g, '')).length;

/** 粘贴分行的两项本机偏好（HIG-55）：面板里两处文案框共用。 */
function usePastePrefs(): [FeaturePrefs, (patch: Partial<FeaturePrefs>) => void] {
  const [prefs, setPrefs] = useState(loadFeaturePrefs);
  return [prefs, (patch) => setPrefs(saveFeaturePrefs(patch))];
}

/**
 * 粘贴时按标点分行：分完和原文一样就交给浏览器；否则自己插入。优先 execCommand('insertText')，
 * 这样 textarea 的原生撤销和 onChange 都照常；浏览器不支持时退回拼字符串交给 onChange。
 */
function pasteSplit(e: ClipboardEvent<HTMLTextAreaElement>, prefs: FeaturePrefs, onChange: (v: string) => void) {
  if (!prefs.posterSplitOnPaste) return;
  const raw = e.clipboardData.getData('text/plain');
  if (!raw) return;
  const text = splitByPunctuation(raw, prefs.posterPunct);
  if (text === raw) return;
  e.preventDefault();
  const ta = e.currentTarget;
  if (document.execCommand?.('insertText', false, text)) return;
  const { selectionStart: a, selectionEnd: b, value } = ta;
  onChange(value.slice(0, a) + text + value.slice(b));
}

/** 粘贴分行开关 + 标点处理。 */
function PasteSplitPrefs({ prefs, setPrefs, onResplit }: { prefs: FeaturePrefs; setPrefs: (patch: Partial<FeaturePrefs>) => void; onResplit?: () => void }) {
  return (
    <div className="paste-prefs">
      <label className="inline small">
        <input type="checkbox" checked={prefs.posterSplitOnPaste} onChange={(e) => setPrefs({ posterSplitOnPaste: e.target.checked })} />
        粘贴时按标点分行
      </label>
      <select className="select sm" value={prefs.posterPunct} aria-label="分行后的标点" title="分行后行尾的标点怎么处理" onChange={(e) => setPrefs({ posterPunct: e.target.value as PunctMode })}>
        {PUNCT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      {onResplit && (
        <button className="btn ghost sm" title="把框里现有的文案按标点重新分行（用右边的标点设置）；已上色的区间可能要重新挑" onClick={onResplit}>
          按标点重新分行
        </button>
      )}
    </div>
  );
}

/** 还没有滚动文字：贴文案 → 生成。 */
function EmptyState() {
  const addPosterLayer = useEditor((s) => s.addPosterLayer);
  const [text, setText] = useState('');
  const [prefs, setPrefs] = usePastePrefs();
  return (
    <Section id="poster.copy" title="文案" bodyClass="stack" help={COPY_HELP}>
      <textarea className="textarea" rows={8} value={text} placeholder="把整篇文案粘到这里…" aria-label="文案" onChange={(e) => setText(e.target.value)} onPaste={(e) => pasteSplit(e, prefs, setText)} />
      <PasteSplitPrefs prefs={prefs} setPrefs={setPrefs} />
      <div className="inline">
        <button className="btn action" disabled={!text.trim()} onClick={() => addPosterLayer(text.trim())}>
          生成滚动文字
        </button>
        <span className="hint">{charCount(text)} 字</span>
      </div>
      <div className="hint">按当前安全区建一个滚动框，文案按框宽自动折行；手动换行保留。</div>
    </Section>
  );
}

/** 文案：textarea 绑定 layer.text，停 300 ms 再写进 store（每次写都会重新烤 PNG）。 */
function CopySection({ layer }: { layer: TextLayer }) {
  const setPosterText = useEditor((s) => s.setPosterText);
  const removeLayer = useEditor((s) => s.removeLayer);
  const [draft, setDraft] = useState(layer.text);
  const timer = useRef<number | null>(null);
  const latest = useRef({ id: layer.id, text: layer.text });
  // 外部改了字（撤销、换视频）且本地没有待提交的输入时跟过来
  useEffect(() => {
    if (timer.current === null) setDraft(layer.text);
  }, [layer.id, layer.text]);
  const flush = () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    setPosterText(latest.current.id, latest.current.text);
  };
  const onChange = (v: string) => {
    setDraft(v);
    latest.current = { id: layer.id, text: v };
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 300);
  };
  // 卸载（切模块）时把没来得及提交的字写回
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = () => {
    // 图层马上没了，待提交的字作废
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    removeLayer(layer.id);
  };
  const n = charCount(draft);
  const [prefs, setPrefs] = usePastePrefs();
  const resplit = () => {
    const next = splitByPunctuation(draft, prefs.posterPunct);
    if (next !== draft) {
      onChange(next);
      flush();
    }
  };
  return (
    <Section id="poster.copy" title="文案" bodyClass="stack" summary={<span>{n} 字</span>} help={COPY_HELP}>
      <textarea className="textarea" rows={8} value={draft} placeholder="把整篇文案粘到这里…" aria-label="文案" onChange={(e) => onChange(e.target.value)} onBlur={flush} onPaste={(e) => pasteSplit(e, prefs, onChange)} />
      <PasteSplitPrefs prefs={prefs} setPrefs={setPrefs} onResplit={resplit} />
      <div className="inline">
        <span className="hint" style={{ flex: 1 }}>{prefs.posterSplitOnPaste ? '粘贴时按标点分行' : '按框宽自动折行'}；手动换行保留 · {n} 字</span>
        <button className="btn ghost sm danger" title="删除这条滚动文字图层（朗读轨不动）" onClick={remove}>
          <IconTrash /> 删除
        </button>
      </div>
    </Section>
  );
}

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`sw ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

/** 滚动：速度、框、首尾行为。 */
function ScrollSection({ layer }: { layer: TextLayer }) {
  const setScroll = useEditor((s) => s.setScroll);
  const safeZones = useEditor((s) => s.safeZones);
  const safeZoneKey = useEditor((s) => s.safeZoneKey);
  const s = resolveScroll(layer.scroll);
  const seconds = scrollLayerDuration(layer);
  const inner = safeZones.find((z) => z.key === safeZoneKey)?.inner ?? null;
  const setBox = (patch: Partial<ScrollBox>) => setScroll(layer.id, { box: { ...s.box, ...patch } });
  const useSafeZone = () => inner && setScroll(layer.id, { box: { x: inner.x, y: inner.y, w: inner.w, h: inner.h } });
  const summary = `${s.speed.toFixed(2)} 高/秒 · ${seconds === null ? '待渲染' : fmt1(seconds)}`;
  return (
    <Section id="poster.scroll" title="滚动" bodyClass="stack" summary={<span>{summary}</span>} help={SCROLL_HELP}>
      <span className="slider">
        <span className="l">速度</span>
        <input type="range" min={SCROLL_SPEED_MIN} max={SCROLL_SPEED_MAX} step={0.01} value={s.speed} aria-label="滚动速度" onChange={(e) => setScroll(layer.id, { speed: parseFloat(e.target.value) })} />
        <Num value={s.speed} min={SCROLL_SPEED_MIN} max={SCROLL_SPEED_MAX} step={0.01} scale={1} suffix="高/s" onChange={(v) => setScroll(layer.id, { speed: v })} className="compact" />
      </span>
      <div className="hint">{seconds === null ? '文案还没渲染成图，滚完的时长稍后显示。' : `按这个速度滚完全程约 ${fmt1(seconds)}。`}</div>
      {s.cues?.length ? <div className="hint">已按朗读短句时间轴同步；手动调整速度会切回匀速。</div> : null}
      <div className="g2">
        <Num label="框 X" value={s.box.x} min={0} max={1} step={0.01} onChange={(v) => setBox({ x: v })} />
        <Num label="框 Y" value={s.box.y} min={0} max={1} step={0.01} onChange={(v) => setBox({ y: v })} />
        <Num label="框宽" value={s.box.w} min={0.05} max={1} step={0.01} onChange={(v) => setBox({ w: v })} />
        <Num label="框高" value={s.box.h} min={0.05} max={1} step={0.01} onChange={(v) => setBox({ h: v })} />
      </div>
      <div className="inline">
        <button className="btn sm" disabled={!inner} title={inner ? '把框设成当前安全区方案的内安全框' : '当前安全区方案没有内安全框'} onClick={useSafeZone}>
          用当前安全区
        </button>
        <span className="hint">框宽也是折行宽度。</span>
      </div>
      <Field label="开头就有字">
        <Switch on={s.start === 'visible'} label="开头就有字" onChange={(on) => setScroll(layer.id, { start: on ? 'visible' : 'enter' })} />
      </Field>
      {s.start === 'visible' && <Num label="开头停留" value={s.hold_start} min={0} max={60} step={0.1} scale={1} suffix="s" onChange={(v) => setScroll(layer.id, { hold_start: Math.max(0, v) })} />}
      <Field label="结尾停留">
        <Switch on={s.end === 'stay'} label="结尾停留" onChange={(on) => setScroll(layer.id, { end: on ? 'stay' : 'exit' })} />
      </Field>
      {s.end === 'stay' && <Num label="结尾停留" value={s.hold_end} min={0} max={60} step={0.1} scale={1} suffix="s" onChange={(v) => setScroll(layer.id, { hold_end: Math.max(0, v) })} />}
    </Section>
  );
}

/** 朗读：语言 / 音色 / 语速 → 合成；状态；配合朗读调速。 */
function VoiceSection({ layer, voice }: { layer: TextLayer; voice: { track: AudioTrack; asset: Asset | undefined } | null }) {
  const options = useEditor((s) => s.localizeOptions);
  const loadLocalizeOptions = useEditor((s) => s.loadLocalizeOptions);
  const generateVoice = useEditor((s) => s.generateVoice);
  const pending = useEditor((s) => s.posterVoicePending);
  const assets = useEditor((s) => s.assets);
  const removeAudioTrack = useEditor((s) => s.removeAudioTrack);
  const setScroll = useEditor((s) => s.setScroll);
  // 生成朗读后自动按朗读时长调滚动速度（HIG-75）；实际调速在 store 的素材就绪回调里
  const [fitVoice, setFitVoice] = useState(() => loadFeaturePrefs().posterFitVoiceSpeed);
  useEffect(() => {
    void loadLocalizeOptions();
  }, [loadLocalizeOptions]);
  const langs = useMemo(() => (options?.target_langs ?? []).filter((t) => t.voices.length > 0), [options]);
  const [lang, setLang] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [rate, setRate] = useState(1.0);
  // 语言 / 音色列表到了再定缺省：中文优先，音色取该语言第一个
  useEffect(() => {
    if (!langs.length || langs.some((t) => t.code === lang)) return;
    setLang(langs.find((t) => t.code.startsWith('zh'))?.code ?? langs[0].code);
  }, [langs, lang]);
  const cur = langs.find((t) => t.code === lang);
  useEffect(() => {
    if (cur && !cur.voices.some((v) => v.id === voiceId)) setVoiceId(cur.voices[0].id);
  }, [cur, voiceId]);
  // 最近一次合成的素材 id：失败时它不会进音轨，只能从素材列表里看状态
  const [lastId, setLastId] = useState<string | null>(null);
  const lastAsset = lastId ? assets.find((a) => a.id === lastId) : undefined;
  const failed = lastAsset?.status === 'failed' && !pending ? lastAsset : null;

  const enabled = !!options?.enabled;
  // qwen3-tts 的音色没有语速参数（HIG-42）：下拉禁掉、请求按 1.0 发，而不是让后端静默丢掉
  const rateOk = voiceSupportsRate(options, lang, voiceId);
  const readyAsset = voice?.asset && (voice.asset.status ?? 'ready') === 'ready' && typeof voice.asset.duration === 'number' && voice.asset.duration > 0 ? voice.asset : null;
  const voiceSeconds = readyAsset?.duration ?? null;
  const ready = voiceSeconds !== null;
  const busy = !!pending;
  const canGenerate = enabled && !busy && !!layer.text.trim() && !!lang && !!voiceId;
  const generate = async () => {
    const id = await generateVoice(layer.text, lang, voiceId, rateOk ? rate : 1.0);
    if (id) setLastId(id);
  };
  const summary = busy ? '合成中…' : readyAsset ? `${readyAsset.name} · ${fmt1(voiceSeconds!)}` : failed ? '合成失败' : '未生成';

  return (
    <Section id="poster.voice" title="朗读" bodyClass="stack" summary={<span>{summary}</span>} help={VOICE_HELP}>
      {options === null ? (
        <div className="hint">正在读取可用音色…</div>
      ) : !enabled ? (
        <div className="hint hatched">服务器没有配置百炼 API Key（DASHSCOPE_API_KEY），朗读不可用；配置后重启后端即可。</div>
      ) : null}
      <Field label="语言">
        <select className="select sm" value={lang} disabled={!enabled || busy} aria-label="朗读语言" onChange={(e) => setLang(e.target.value)}>
          {langs.map((t) => (
            <option key={t.code} value={t.code}>{t.label}</option>
          ))}
        </select>
      </Field>
      <Field label="音色">
        <VoiceSelect lang={lang} voices={cur?.voices ?? []} value={voiceId} onChange={setVoiceId} disabled={!enabled || busy || !cur} ariaLabel="音色" />
      </Field>
      <Field label="语速" title={rateOk ? undefined : '这个音色不支持调语速'}>
        <select className="select sm" value={rateOk ? String(rate) : '1'} disabled={!enabled || busy || !rateOk} aria-label="语速" onChange={(e) => setRate(parseFloat(e.target.value))}>
          {RATES.map((r) => (
            <option key={r} value={String(r)}>{r.toFixed(1)}×</option>
          ))}
        </select>
      </Field>
      <div className="inline">
        <button className="btn action" disabled={!canGenerate} title={ready ? '重新合成，替换现在的朗读轨' : '把当前文案合成一条朗读音轨（后台任务）'} onClick={() => void generate()}>
          {busy ? (
            <>
              <IconSpinner /> 合成中…
            </>
          ) : ready ? '重新生成朗读' : '生成朗读'}
        </button>
        <button className="btn sm" disabled={voiceSeconds === null} title={voiceSeconds !== null ? `把滚动全程调成 ${fmt1(voiceSeconds)}` : '先生成朗读'} onClick={() => voiceSeconds !== null && setScroll(layer.id, { speed: fitScrollSpeed(layer, voiceSeconds) })}>
          配合朗读调速
        </button>
      </div>
      <label className="inline small" title="生成朗读后自动把滚动全程调成朗读时长；之后改音频速度或拖速度滑杆都不会再被覆盖，要重调按上面的按钮">
        <input
          type="checkbox"
          checked={fitVoice}
          onChange={(e) => {
            setFitVoice(e.target.checked);
            saveFeaturePrefs({ posterFitVoiceSpeed: e.target.checked });
          }}
        />
        生成朗读后自动调速
      </label>
      {readyAsset && voice && (
        <div className="inline">
          <span className="small muted ellip" title={readyAsset.name}>
            {readyAsset.name} · {fmt1(readyAsset.duration!)}
          </span>
          <button className="btn ghost sm danger" title="从音频轨删掉这条朗读（素材留在素材库）" onClick={() => removeAudioTrack(voice.track.id)}>
            删除
          </button>
        </div>
      )}
      {voice && !ready && !busy && <div className="hint">朗读轨的素材还没就绪或已失效。</div>}
      {failed && <div className="error-text">合成失败：{failed.error ?? '未知原因'}</div>}
    </Section>
  );
}

/** 高亮：自动挑重点词 + 当前上色区间的 chip 列表。 */
function HighlightSection({ layer }: { layer: TextLayer }) {
  const autoHighlight = useEditor((s) => s.autoHighlight);
  const updateLayer = useEditor((s) => s.updateLayer);
  const [busy, setBusy] = useState(false);
  const spans = normalizeSpans(layer.spans, layer.text.length);
  const remove = (start: number, end: number) =>
    updateLayer(layer.id, (l) => {
      if (l.type !== 'text') return;
      const rest = (l.spans ?? []).filter((sp) => !(sp.start === start && sp.end === end));
      if (rest.length) l.spans = rest;
      else delete l.spans;
    });
  const run = async () => {
    setBusy(true);
    try {
      await autoHighlight(layer.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="poster.highlight" title="高亮" bodyClass="stack" summary={<span>{spans.length ? `${spans.length} 处` : '无'}</span>} help={HIGHLIGHT_HELP}>
      <div className="inline">
        <button className="btn sm" disabled={busy || !layer.text.trim()} title="让大模型从文案里挑重点词组并轮流上色（约几秒）" onClick={() => void run()}>
          {busy ? (
            <>
              <IconSpinner /> 挑选中…
            </>
          ) : '自动挑重点词'}
        </button>
      </div>
      {spans.length > 0 && (
        <div className="span-chips">
          {spans.map((sp) => (
            <span key={`${sp.start}-${sp.end}`} className="span-chip hl-chip">
              <i style={{ background: sp.color }} />
              <span className="stext">{layer.text.slice(sp.start, sp.end).replace(/\n/g, ' ')}</span>
              <button type="button" className="hl-x" aria-label={`去掉「${layer.text.slice(sp.start, sp.end)}」的高亮`} title="去掉这一处高亮" onClick={() => remove(sp.start, sp.end)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="hint">也可以在画布上选中文字后手动上色（文本模块）。</div>
    </Section>
  );
}

/** 背景（HIG-55）：勾选本批次的其它素材 / 上传多个背景，一键铺过去并一起导出。 */
function BackgroundSection() {
  const videos = useEditor((s) => s.videos);
  const currentId = useEditor((s) => s.currentVideoId);
  const selectedIds = useEditor((s) => s.selectedIds);
  const toggleSelected = useEditor((s) => s.toggleSelected);
  const appendVideos = useEditor((s) => s.appendVideos);
  const appendProgress = useEditor((s) => s.appendProgress);
  const applyToTargets = useEditor((s) => s.applyToTargets);
  const openExport = useEditor((s) => s.openExport);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const others = videos.filter((v) => v.id !== currentId);
  const targets = others.filter((v) => selectedIds.includes(v.id));
  const notReady = targets.filter((v) => v.status !== 'ready');
  const upload = async (files: File[]) => {
    const ids = await appendVideos(files);
    // 读最新的勾选：上传期间用户可能又点了别的
    const picked = useEditor.getState().selectedIds;
    for (const id of ids) if (!picked.includes(id)) toggleSelected(id);
  };
  const apply = async () => {
    setBusy(true);
    try {
      await applyToTargets(targets.map((v) => v.id), BACKGROUND_MODULES);
    } finally {
      setBusy(false);
    }
  };
  const exportAll = () => {
    if (currentId && !selectedIds.includes(currentId)) toggleSelected(currentId);
    openExport({ scope: 'selected' });
  };
  const applyReason = !targets.length ? '先勾选要铺文案的背景' : notReady.length ? `${notReady.length} 个背景还在预处理，就绪后再应用` : '';
  const rowMeta = (v: Video) => `${v.kind === 'blank' ? '空白 · ' : v.kind === 'image' ? '图 · ' : ''}${formatSeconds(v.duration)}${v.status === 'ready' ? '' : v.status === 'failed' ? ' · 预处理失败' : ' · 预处理中'}`;

  return (
    <Section id="poster.backgrounds" title="背景" bodyClass="stack" summary={<span>{targets.length ? `已选 ${targets.length} 个` : '只有当前'}</span>} help={BACKGROUND_HELP}>
      <div className="bg-list" role="group" aria-label="背景">
        {videos.map((v) => {
          const isCur = v.id === currentId;
          const on = isCur || selectedIds.includes(v.id);
          return (
            <label key={v.id} className={`bg-row ${on ? 'on' : ''}`} title={isCur ? '当前正在编辑的这条，总会一起导出' : v.name}>
              <input type="checkbox" checked={on} disabled={isCur} onChange={() => toggleSelected(v.id)} aria-label={`背景 ${v.name}`} />
              <span className="bg-thumb" style={{ backgroundImage: v.poster_url ? `url("${v.poster_url}")` : undefined }} />
              <span className="bg-name">{v.name}</span>
              <span className={`bg-meta small ${v.status === 'failed' ? 'error-text' : 'muted'}`}>{isCur ? '当前' : rowMeta(v)}</span>
            </label>
          );
        })}
      </div>
      <div className="inline">
        <button className="btn sm" disabled={appendProgress !== null} title={`一次选多个文件（${VIDEO_ACCEPT_LABEL}），上传完自动勾上`} onClick={() => fileRef.current?.click()}>
          {appendProgress !== null ? `上传中 ${Math.round(appendProgress * 100)}%` : '上传背景…'}
        </button>
        {others.length > 0 && (
          <button
            className="btn ghost sm"
            onClick={() => {
              // 全选了就全部取消，否则把没勾的补上
              const allOn = targets.length === others.length;
              for (const v of others) if (selectedIds.includes(v.id) === allOn) toggleSelected(v.id);
            }}
          >
            {targets.length === others.length ? '全不选' : '全选'}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={VIDEO_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void upload(files);
          }}
        />
      </div>
      <div className="inline">
        <button className="btn action sm" disabled={busy || !!applyReason} title={applyReason || '把滚动文字、成片时长、画面和朗读轨复制到所选背景（覆盖它们原有的这几项，可撤销）'} onClick={() => void apply()}>
          {busy ? '应用中…' : `应用到所选 ${targets.length} 个背景`}
        </button>
        <button className="btn sm" disabled={!targets.length} title="打开导出：范围是当前这条 + 所选背景" onClick={exportAll}>
          导出 {targets.length + 1} 条…
        </button>
      </div>
      {targets.length > 0 && <div className="hint">先「应用」再「导出」；应用后改了文案，要再应用一次。</div>}
    </Section>
  );
}

export function PosterPanel() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] ?? null : null));
  const selectedId = useEditor((s) => s.selectedLayerId);
  const setSelectedLayer = useEditor((s) => s.setSelectedLayer);
  const assets = useEditor((s) => s.assets);
  const layer = useMemo(() => posterLayerOf(spec, selectedId), [spec, selectedId]);
  const voice = useMemo(() => voiceTrackOf(spec, assets), [spec, assets]);
  // 面板打开 / 图层出现时把它选中：画布上能直接拖框、样式分组作用在它身上
  const layerId = layer?.id ?? null;
  useEffect(() => {
    if (layerId) setSelectedLayer(layerId);
  }, [layerId, setSelectedLayer]);
  const voiceSeconds = voice?.asset && (voice.asset.status ?? 'ready') === 'ready' && typeof voice.asset.duration === 'number' ? voice.asset.duration : null;

  return (
    <div className="panel">
      <div className="panel-head">
        <span>大字报</span>
      </div>
      <div className="panel-body inspector">
        {!video && <div className="hint">先在左栏选一条素材（空白素材或视频都行）。</div>}
        {video && !layer && (
          <>
            <EmptyState />
            <div className="hint">建好后：调速度和框 → 可选生成朗读并「配合朗读调速」→ 自动挑重点词 → 在「背景」里勾选或上传其它背景，应用后一起导出。</div>
          </>
        )}
        {video && layer && (
          <>
            <CopySection key={layer.id} layer={layer} />
            <ScrollSection layer={layer} />
            <TextSections layer={layer} sel={null} poster />
            <VoiceSection layer={layer} voice={voice} />
            <HighlightSection layer={layer} />
            <BackgroundSection />
            <div className="poster-foot">
              <div className="mono small">{scrollSummary(layer, voiceSeconds)}</div>
              <div className="hint">做好后在上面「背景」里选好其它背景，应用后一起导出。</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

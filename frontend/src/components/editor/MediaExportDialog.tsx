import { useState } from 'react';
import { api } from '../../api';
import { useEditor } from '../../store/editor';
import { exportableLangs, ORIGINAL_LANG } from '../../lib/langExport';
import { langLabel } from '../../lib/localize';
import { resolveExportTargets, type ExportScope } from '../../lib/exportScope';
import { Modal } from '../ui/Modal';

export type MediaExportKind = 'video' | 'subtitle' | 'audio' | 'batch';
const KINDS: { key: MediaExportKind; title: string }[] = [
  { key: 'video', title: '导出视频' }, { key: 'subtitle', title: '导出字幕' },
  { key: 'audio', title: '导出音频' }, { key: 'batch', title: '批量导出' },
];

export function MediaExportTabs({ kind, onKind }: { kind: MediaExportKind; onKind: (kind: MediaExportKind) => void }) {
  return <div className="chips" role="tablist" aria-label="导出类型" style={{ marginBottom: 12 }}>
    {KINDS.map((item) => <button type="button" key={item.key} role="tab" aria-selected={kind === item.key} className={`chip ${kind === item.key ? 'active' : ''}`} onClick={() => onKind(item.key)}>{item.title}</button>)}
  </div>;
}

export function MediaExportDialog({ kind, onKind, onClose }: { kind: Exclude<MediaExportKind, 'video'>; onKind: (kind: MediaExportKind) => void; onClose: () => void }) {
  const videos = useEditor((s) => s.videos);
  const assets = useEditor((s) => s.assets);
  const selectedIds = useEditor((s) => s.selectedIds);
  const currentId = useEditor((s) => s.currentVideoId);
  const selectedLayerIds = useEditor((s) => s.selectedLayerIds);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const inPoint = useEditor((s) => s.inPoint);
  const time = useEditor((s) => s.time);
  const [scope, setScope] = useState<ExportScope>('current');
  const [languages, setLanguages] = useState<string[]>([ORIGINAL_LANG]);
  const [subtitleMode, setSubtitleMode] = useState('edited');
  const [subtitleFormat, setSubtitleFormat] = useState('srt');
  const [audioStem, setAudioStem] = useState('original');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [rangeMode, setRangeMode] = useState('whole');
  const [speaker, setSpeaker] = useState('');
  const [keepTimecodes, setKeepTimecodes] = useState(true);
  const [keepSpeaker, setKeepSpeaker] = useState(true);
  const [mergeShort, setMergeShort] = useState(false);
  const [includeBackground, setIncludeBackground] = useState(true);
  const [sampleRate, setSampleRate] = useState(48000);
  const [bitrate, setBitrate] = useState(192);
  const [channels, setChannels] = useState(2);
  const [normalizeLoudness, setNormalizeLoudness] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targets = resolveExportTargets(videos, scope, selectedIds, currentId);
  const targetVideos = videos.filter((v) => targets.ids.includes(v.id));
  const langChoices = [...new Set([
    ...exportableLangs(targetVideos, assets),
    ...targetVideos.flatMap((video) => Object.entries(video.localization?.versions ?? {}).filter(([, version]) => version.status === 'done' && version.cues.length > 0).map(([lang]) => lang)),
  ])];
  const toggleLang = (lang: string) => setLanguages((old) => old.includes(lang) ? old.filter((value) => value !== lang) : [...old, lang]);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.downloadMediaFiles({
        video_ids: targets.ids, kind, languages, subtitle_mode: subtitleMode, subtitle_format: subtitleFormat,
        audio_stem: audioStem, audio_format: audioFormat, range_mode: rangeMode,
        start: rangeMode === 'in_out' ? Math.min(inPoint ?? time, time) : null,
        end: rangeMode === 'in_out' ? Math.max(inPoint ?? time, time) : null,
        selected_layer_ids: selectedLayerIds, selected_track_id: selectedTrackId, speaker,
        keep_timecodes: keepTimecodes, keep_speaker: keepSpeaker, merge_short: mergeShort,
        include_background: includeBackground, sample_rate: sampleRate, bitrate, channels,
        normalize_loudness: normalizeLoudness,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };
  const subtitle = kind === 'subtitle' || kind === 'batch';
  const audio = kind === 'audio' || kind === 'batch';
  return <Modal title="导出" onClose={onClose} width={520} footer={<>
    <button className="btn" onClick={onClose}>取消</button>
    <button className="btn primary" disabled={busy || !targets.ids.length || !languages.length || (rangeMode === 'in_out' && inPoint === null) || ((rangeMode === 'speaker' || (audio && audioStem === 'speaker')) && !speaker.trim()) || ((rangeMode === 'selected' || rangeMode === 'single') && !selectedLayerIds.length && !selectedTrackId)} onClick={() => void submit()}>{busy ? '正在生成…' : '生成并下载 ZIP'}</button>
  </>}>
    <MediaExportTabs kind={kind} onKind={onKind} />
    <div className="field">导出视频范围<select className="input" value={scope} onChange={(e) => setScope(e.target.value as ExportScope)}>
      <option value="current">仅当前视频</option><option value="selected">左侧勾选的视频</option><option value="batch">这一批全部</option>
    </select></div>
    <div className="field">语言<div className="chips">
      <button className={`chip ${languages.includes('all') ? 'active' : ''}`} onClick={() => setLanguages(['all'])}>全部语言</button>
      {[ORIGINAL_LANG, ...langChoices].map((lang) => <button key={lang} className={`chip ${languages.includes(lang) ? 'active' : ''}`} onClick={() => { if (languages.includes('all')) setLanguages([lang]); else toggleLang(lang); }}>{lang === ORIGINAL_LANG ? '原语言' : langLabel(null, lang)}</button>)}
    </div></div>
    {subtitle && <>
      <div className="inline"><label className="field">字幕版本<select className="input" value={subtitleMode} onChange={(e) => setSubtitleMode(e.target.value)}>
        <option value="original">原始语言</option><option value="translated">翻译后</option><option value="edited">当前编辑后</option><option value="bilingual">双语</option>
      </select></label><label className="field">字幕格式<select className="input" value={subtitleFormat} onChange={(e) => setSubtitleFormat(e.target.value)}>
        {['srt', 'vtt', 'ass', 'txt', 'json'].map((format) => <option key={format} value={format}>.{format}</option>)}
      </select></label></div>
      <div className="inline"><label title={subtitleFormat === 'txt' ? undefined : 'SRT、VTT、ASS 和 JSON 格式始终保留时间轴'}><input type="checkbox" checked={subtitleFormat === 'txt' ? keepTimecodes : true} disabled={subtitleFormat !== 'txt'} onChange={(e) => setKeepTimecodes(e.target.checked)} />保留时间码</label><label><input type="checkbox" checked={keepSpeaker} onChange={(e) => setKeepSpeaker(e.target.checked)} />保留说话人</label><label><input type="checkbox" checked={mergeShort} onChange={(e) => setMergeShort(e.target.checked)} />合并过短字幕</label></div>
    </>}
    {audio && <>
      <div className="inline"><label className="field">音频轨<select className="input" value={audioStem} onChange={(e) => setAudioStem(e.target.value)}>
        <option value="original">原视频完整音频</option><option value="vocals">原语言人声</option><option value="instrumental">背景音乐／环境声</option><option value="dubbing">目标语言配音</option><option value="mixed">配音与背景声混合</option><option value="speaker">指定说话人</option><option value="selected_track">选中音频片段</option>
      </select></label><label className="field">格式<select className="input" value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)}>
        {['mp3', 'wav', 'm4a', 'aac'].map((format) => <option key={format} value={format}>.{format}</option>)}
      </select></label></div>
      <div className="inline"><label className="field">采样率<select className="input" value={sampleRate} onChange={(e) => setSampleRate(Number(e.target.value))}>{[16000, 22050, 44100, 48000].map((rate) => <option key={rate} value={rate}>{rate} Hz</option>)}</select></label><label className="field">码率<select className="input" value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}>{[64, 96, 128, 192, 256, 320].map((rate) => <option key={rate} value={rate}>{rate} kbps</option>)}</select></label><label className="field">声道<select className="input" value={channels} onChange={(e) => setChannels(Number(e.target.value))}><option value={1}>单声道</option><option value={2}>立体声</option></select></label></div>
      <div className="inline"><label><input type="checkbox" checked={includeBackground} onChange={(e) => setIncludeBackground(e.target.checked)} />混音包含背景声</label><label><input type="checkbox" checked={normalizeLoudness} onChange={(e) => setNormalizeLoudness(e.target.checked)} />响度标准化</label></div>
    </>}
    <div className="field">导出片段范围<select className="input" value={rangeMode} onChange={(e) => setRangeMode(e.target.value)}>
      <option value="whole">整个项目</option><option value="selected">当前选中的字幕／音频片段</option><option value="in_out">时间轴入点至出点</option><option value="single">单条字幕／单个音频片段</option><option value="speaker">指定说话人的全部内容</option>
    </select></div>
    {(rangeMode === 'speaker' || audioStem === 'speaker') && <label className="field">说话人名称<input className="input" value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="使用项目已有的说话人标签" /></label>}
    <div className="hint">只导出已经生成且就绪的字幕和音轨。没有对应语言、分离轨或说话人标签时会提示。多个文件按语言命名并打成 ZIP。</div>
    {error && <div className="error-text" role="alert">{error}</div>}
  </Modal>;
}

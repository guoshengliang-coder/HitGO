import { useState } from 'react';
import { useEditor } from '../../store/editor';
import { player } from '../../lib/player';
import { clipWindows, duplicateClip, insertClip, moveClip, removeClip, sequenceDuration, splitClip, updateClip } from '../../lib/sequence';
import { formatSeconds, formatTime } from '../../lib/time';
import { VIDEO_ACCEPT, VIDEO_ACCEPT_LABEL, splitByAccept } from '../../lib/fileDrop';
import type { ClipTransitionType, SequenceClip } from '../../types';
import { Section } from '../ui/Section';
import { Modal } from '../ui/Modal';

const EFFECTS: { value: ClipTransitionType; label: string }[] = [
  { value: 'cut', label: '硬切' },
  { value: 'fade', label: '交叉淡化' },
  { value: 'slide_left', label: '向左滑动' },
  { value: 'slide_right', label: '向右滑动' },
  { value: 'wipe_left', label: '向左擦除' },
  { value: 'wipe_right', label: '向右擦除' },
];

export function SequenceSection() {
  const current = useEditor((s) => s.currentVideo());
  const spec = useEditor((s) => s.currentSpec());
  const videos = useEditor((s) => s.videos);
  const selectedId = useEditor((s) => s.selectedClipId);
  const setSelected = useEditor((s) => s.setSelectedClip);
  const replaceSpec = useEditor((s) => s.replaceSpec);
  const appendVideos = useEditor((s) => s.appendVideos);
  const appendProgress = useEditor((s) => s.appendProgress);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const sequence = spec?.sequence;
  const clips = sequence?.clips ?? [];
  const selected = clips.find((clip) => clip.id === selectedId) ?? null;
  const selectedIndex = clips.findIndex((clip) => clip.id === selectedId);
  const selectedSource = selected ? videos.find((v) => v.id === selected.video_id) : null;
  const duration = sequence ? sequenceDuration(sequence) : current?.duration ?? 0;

  const save = (next: typeof spec) => { if (current && next) replaceSpec(current.id, next, { history: true }); };
  const add = (sourceId: string) => {
    if (!current || !spec) return;
    const source = videos.find((v) => v.id === sourceId);
    if (!source || source.status !== 'ready') return;
    const at = Math.max(0, Math.min(duration, player.currentTime));
    const inserted = insertClip(spec, current.id, current.duration, source.id, source.duration, at);
    save(inserted.spec);
    setSelected(inserted.clipId);
    player.seek(at);
    setPicker(false);
  };
  const patchClip = (patch: Partial<SequenceClip>) => {
    if (!spec || !selected) return;
    save(updateClip(spec, selected.id, patch));
  };
  const editEdge = (edge: 'in' | 'out', value: number) => {
    if (!selected || !selectedSource || !Number.isFinite(value)) return;
    const lo = edge === 'in' ? Math.max(0, Math.min(value, selected.out - 0.1)) : selected.in;
    const hi = edge === 'out' ? Math.min(selectedSource.duration, Math.max(value, selected.in + 0.1)) : selected.out;
    if ((selected.transition?.duration ?? 0) >= hi - lo) { setError('片段时长必须大于转场时长'); return; }
    patchClip({ in: lo, out: hi });
  };
  const changeEffect = (type: ClipTransitionType) => {
    if (!selected || selectedIndex <= 0) return;
    const previous = clips[selectedIndex - 1];
    const duration = type === 'cut' ? 0 : Math.min(0.4, Math.max(0.1, Math.min(selected.out - selected.in, previous.out - previous.in) / 2));
    patchClip({ transition: { type, duration } });
  };

  return (
    <>
      <Section id="trim.sequence" title="视频片段" summary={<span className="mono">{clips.length ? `${clips.length} 段 · ${formatSeconds(duration)}` : '当前仅一条源视频'}</span>} bodyClass="stack">
        <div className="hint">在播放头插入本批次视频；也可以在视频轨上拖动片段调整顺序。插入使用来源的原始画面与声音。</div>
        <button className="btn" onClick={() => setPicker(true)} disabled={!current || current.status !== 'ready' || (current.kind ?? 'video') !== 'video'}>＋ 添加视频片段</button>
        {clips.length > 0 && (
          <div className="sequence-list">
            {clipWindows(sequence!).map(({ clip, start }, index) => {
              const source = videos.find((v) => v.id === clip.video_id);
              return <button key={clip.id} className={`sequence-row ${clip.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelected(clip.id); player.seek(start); }}>
                <span>{index + 1}. {source?.name ?? '源视频已缺失'}</span>
                <small>{formatTime(start)} · {formatSeconds(clip.out - clip.in)}</small>
              </button>;
            })}
          </div>
        )}
        {selected && selectedSource && (
          <>
            <div className="inline"><label className="field">源片入点<input className="input sm" type="number" min="0" max={selected.out - 0.1} step="0.01" key={`${selected.id}:in:${selected.in}`} defaultValue={selected.in} onBlur={(e) => editEdge('in', Number(e.target.value))} /></label><label className="field">源片出点<input className="input sm" type="number" min={selected.in + 0.1} max={selectedSource.duration} step="0.01" key={`${selected.id}:out:${selected.out}`} defaultValue={selected.out} onBlur={(e) => editEdge('out', Number(e.target.value))} /></label></div>
            <div className="inline"><button className="btn sm" onClick={() => { const next = splitClip(spec!, selected.id, Math.max(0, player.currentTime)); if (next) save(next); else setError('播放头需位于选中片段内部'); }}>在播放头拆分</button><button className="btn sm" onClick={() => { const result = duplicateClip(spec!, selected.id); if (result) { save(result.spec); setSelected(result.clipId); } }}>复制</button><button className="btn sm danger" disabled={clips.length <= 1} onClick={() => { const next = removeClip(spec!, selected.id); if (next) { save(next); setSelected(next.sequence?.clips[Math.max(0, selectedIndex - 1)]?.id ?? null); } }}>删除</button></div>
            <div className="inline"><button className="btn sm" disabled={selectedIndex <= 0} onClick={() => save(moveClip(spec!, selected.id, selectedIndex - 1))}>前移</button><button className="btn sm" disabled={selectedIndex >= clips.length - 1} onClick={() => save(moveClip(spec!, selected.id, selectedIndex + 1))}>后移</button></div>
            {selectedIndex > 0 && <div className="field">与上一段的转场<select className="input" value={selected.transition?.type ?? 'cut'} onChange={(e) => changeEffect(e.target.value as ClipTransitionType)}>{EFFECTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select>{selected.transition && selected.transition.type !== 'cut' && <label className="field">转场时长（秒）<input className="input sm" type="number" min="0.1" max={Math.min(1.5, selected.out - selected.in - 0.01, clips[selectedIndex - 1].out - clips[selectedIndex - 1].in - 0.01)} step="0.1" key={`${selected.id}:transition:${selected.transition.duration}`} defaultValue={selected.transition.duration} onBlur={(e) => { const n = Number(e.target.value); if (n >= 0.1 && n < Math.min(selected.out - selected.in, clips[selectedIndex - 1].out - clips[selectedIndex - 1].in)) patchClip({ transition: { type: selected.transition!.type, duration: n } }); }} /> </label>}</div>}
          </>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
      </Section>
      {picker && <Modal title="添加视频片段" onClose={() => setPicker(false)} width={510}>
        <div className="hint">选择本批次已就绪的视频，插入到当前播放头位置。来源视频已有的字幕、音频等编辑不会带入。</div>
        <input className="input" type="search" placeholder="搜索本批次视频" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: '100%', margin: '10px 0' }} />
        <div className="sequence-picker-list">{videos.filter((v) => (v.kind ?? 'video') === 'video' && v.name.toLowerCase().includes(query.toLowerCase())).map((v) => <button key={v.id} className="sequence-pick" disabled={v.status !== 'ready'} onClick={() => add(v.id)}><span>{v.name}</span><small>{v.status === 'ready' ? formatSeconds(v.duration) : v.status === 'preparing' ? '预处理中…' : '预处理失败'}</small></button>)}</div>
        <label className="btn" style={{ cursor: 'pointer', marginTop: 12 }}>{appendProgress === null ? '上传视频到本批次' : `上传中 ${Math.round(appendProgress * 100)}%`}<input type="file" className="sr-only" multiple accept={VIDEO_ACCEPT} disabled={appendProgress !== null} onChange={(e) => { const { accepted, rejected } = splitByAccept(Array.from(e.target.files ?? []), VIDEO_ACCEPT); if (rejected.length) setError(`只支持 ${VIDEO_ACCEPT_LABEL}`); if (accepted.length) void appendVideos(accepted); e.target.value = ''; }} /></label>
      </Modal>}
    </>
  );
}

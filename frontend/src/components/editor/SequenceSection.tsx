import { useState } from 'react';
import { useEditor, usePostDuration, selectSourceDuration } from '../../store/editor';
import { player } from '../../lib/player';
import { CLIP_DRAG, clipDisplayGroups, duplicateClip, insertClip, moveClipGroup, removeClip, splitClip, updateClip } from '../../lib/sequence';
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
  const [insertMode, setInsertMode] = useState<'playhead' | 'start' | 'end'>('playhead');
  const [insertionTime, setInsertionTime] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const sequence = spec?.sequence;
  const clips = sequence?.clips ?? [];
  const groups = sequence && current ? clipDisplayGroups(sequence, current.id) : [];
  const selected = clips.find((clip) => clip.id === selectedId) ?? null;
  const selectedIndex = clips.findIndex((clip) => clip.id === selectedId);
  const selectedGroupIndex = groups.findIndex((g) => g.clips.some((w) => w.clip.id === selectedId));
  const selectedSource = selected ? videos.find((v) => v.id === selected.video_id) : null;
  const duration = usePostDuration();
  const sourceDuration = useEditor(selectSourceDuration);
  const insertionDuration = sequence ? sourceDuration : duration;
  const insertAt = insertMode === 'start' ? 0 : insertMode === 'end' ? insertionDuration : Math.max(0, Math.min(insertionDuration, insertionTime));

  const save = (next: typeof spec) => { if (current && next) replaceSpec(current.id, next, { history: true }); };
  const add = (sourceId: string) => {
    if (!current || !spec) return;
    const source = videos.find((v) => v.id === sourceId);
    if (!source || source.status !== 'ready') return;
    const at = insertAt;
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
      <Section id="trim.sequence" title="视频片段" summary={<span className="mono">{clips.length ? `${new Set(clips.map((c) => c.video_id)).size} 条来源 · ${formatSeconds(duration)}` : '当前仅一条源视频'}</span>} bodyClass="stack">
        <div className="hint">添加后作为一条视频剪辑，下方仍用入点/出点、删左/删右和删除区间拖拽。这里管理来源片段与转场，可拖动列表调整顺序；插入使用来源的原始画面与声音。</div>
        <button className="btn action action-wide" onClick={() => { player.pause(); setInsertionTime(sequence ? player.currentTime : player.postTime); setInsertMode('playhead'); setPicker(true); }} disabled={!current || current.status !== 'ready' || (current.kind ?? 'video') !== 'video'}>＋ 添加视频片段</button>
        {clips.length > 0 && (
          <div className="sequence-list">
            {groups.map((group, index) => {
              const first = group.clips[0];
              const source = videos.find((v) => v.id === first.clip.video_id);
              const multi = group.clips.length > 1;
              return <div key={group.key}>
                <button draggable onDragStart={(e) => { e.dataTransfer.setData(CLIP_DRAG, group.key); e.dataTransfer.effectAllowed = 'move'; }} onDragOver={(e) => { if (e.dataTransfer.types.includes(CLIP_DRAG)) e.preventDefault(); }} onDrop={(e) => { const key = e.dataTransfer.getData(CLIP_DRAG); if (key && spec && current) { e.preventDefault(); save(moveClipGroup(spec, current.id, key, index)); } }} className={`sequence-row ${group.clips.some((w) => w.clip.id === selectedId) ? 'selected' : ''}`} onClick={() => { setSelected(first.clip.id); player.seek(group.start); if (multi) setExpandedGroup(expandedGroup === group.key ? null : group.key); }}>
                  <span>{index + 1}. {source?.name ?? '源视频已缺失'}{multi ? ` · 原有剪辑 ${group.clips.length} 段 ${expandedGroup === group.key ? '▴' : '▾'}` : ''}</span>
                  <small>{formatTime(group.start)} · {formatSeconds(group.end - group.start)}</small>
                </button>
                {multi && expandedGroup === group.key && group.clips.map(({ clip, start }, sub) => <button key={clip.id} className={`sequence-row sequence-subrow ${clip.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelected(clip.id); player.seek(start); }}><span>区间 {sub + 1} · 源片 {formatTime(clip.in)}–{formatTime(clip.out)}</span><small>{formatSeconds(clip.out - clip.in)}</small></button>)}
              </div>;
            })}
          </div>
        )}
        {selected && selectedSource && (
          <>
            <label className="field">本片段原声（%）<input className="input sm" aria-label="本片段原声音量" type="number" min="0" max="100" step="5" disabled={!selectedSource.has_audio} key={`${selected.id}:volume:${selected.source_volume}`} defaultValue={Math.round((selected.source_volume ?? 1) * 100)} onBlur={(e) => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 0 && value <= 100) patchClip({ source_volume: value / 100 }); }} /><span className="hint">{selectedSource.has_audio ? '只调整选中片段；原视频的配音只随原视频播放。' : '这段源视频没有原声音轨。'}</span></label>
            <div className="inline"><label className="field">源片入点<input className="input sm" type="number" min="0" max={selected.out - 0.1} step="0.01" key={`${selected.id}:in:${selected.in}`} defaultValue={selected.in} onBlur={(e) => editEdge('in', Number(e.target.value))} /></label><label className="field">源片出点<input className="input sm" type="number" min={selected.in + 0.1} max={selectedSource.duration} step="0.01" key={`${selected.id}:out:${selected.out}`} defaultValue={selected.out} onBlur={(e) => editEdge('out', Number(e.target.value))} /></label></div>
            <div className="inline"><button className="btn sm" onClick={() => { const next = splitClip(spec!, selected.id, Math.max(0, player.currentTime)); if (next) save(next); else setError('播放头需位于选中片段内部'); }}>在播放头拆分</button><button className="btn sm" onClick={() => { const result = duplicateClip(spec!, selected.id); if (result) { save(result.spec); setSelected(result.clipId); } }}>复制</button><button className="btn sm danger" disabled={clips.length <= 1} onClick={() => { const next = removeClip(spec!, selected.id); if (next) { save(next); setSelected(next.sequence?.clips[Math.max(0, selectedIndex - 1)]?.id ?? null); } }}>删除</button></div>
            <div className="inline"><button className="btn sm" disabled={selectedGroupIndex <= 0} onClick={() => save(moveClipGroup(spec!, current!.id, groups[selectedGroupIndex].key, selectedGroupIndex - 1))}>前移</button><button className="btn sm" disabled={selectedGroupIndex >= groups.length - 1} onClick={() => save(moveClipGroup(spec!, current!.id, groups[selectedGroupIndex].key, selectedGroupIndex + 1))}>后移</button></div>
            {selectedIndex > 0 && <div className="field">与上一段的转场<select className="input" value={selected.transition?.type ?? 'cut'} onChange={(e) => changeEffect(e.target.value as ClipTransitionType)}>{EFFECTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select>{selected.transition && selected.transition.type !== 'cut' && <label className="field">转场时长（秒）<input className="input sm" type="number" min="0.1" max={Math.min(1.5, selected.out - selected.in - 0.01, clips[selectedIndex - 1].out - clips[selectedIndex - 1].in - 0.01)} step="0.1" key={`${selected.id}:transition:${selected.transition.duration}`} defaultValue={selected.transition.duration} onBlur={(e) => { const n = Number(e.target.value); if (n >= 0.1 && n < Math.min(selected.out - selected.in, clips[selectedIndex - 1].out - clips[selectedIndex - 1].in)) patchClip({ transition: { type: selected.transition!.type, duration: n } }); }} /> </label>}</div>}
          </>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
      </Section>
      {picker && <Modal title="添加视频片段" onClose={() => setPicker(false)} width={510}>
        <label className="field">插入位置<select className="input" value={insertMode} onChange={(e) => setInsertMode(e.target.value as typeof insertMode)}><option value="playhead">播放头（{formatTime(insertionTime)}）</option><option value="start">片头</option><option value="end">片尾</option></select></label>
        <div className="hint">将插入到 {formatTime(insertAt)}{insertAt === 0 ? '，成为第一段' : insertAt === insertionDuration ? '，接在现有内容之后' : ''}。使用所选 MP4 自己的原始画面和声音，已有编辑不会带入。</div>
        <input className="input" type="search" placeholder="搜索本批次视频" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: '100%', margin: '10px 0' }} />
        <div className="sequence-picker-list">{videos.filter((v) => (v.kind ?? 'video') === 'video' && v.name.toLowerCase().includes(query.toLowerCase())).map((v) => <button key={v.id} className="sequence-pick" disabled={v.status !== 'ready'} onClick={() => add(v.id)}><span>{v.name}</span><small>{v.status === 'ready' ? formatSeconds(v.duration) : v.status === 'preparing' ? '预处理中…' : '预处理失败'}</small></button>)}</div>
        <label className="btn" style={{ cursor: 'pointer', marginTop: 12 }}>{appendProgress === null ? '上传视频到本批次' : `上传中 ${Math.round(appendProgress * 100)}%`}<input type="file" className="sr-only" multiple accept={VIDEO_ACCEPT} disabled={appendProgress !== null} onChange={(e) => { const { accepted, rejected } = splitByAccept(Array.from(e.target.files ?? []), VIDEO_ACCEPT); if (rejected.length) setError(`只支持 ${VIDEO_ACCEPT_LABEL}`); if (accepted.length) void appendVideos(accepted); e.target.value = ''; }} /></label>
      </Modal>}
    </>
  );
}

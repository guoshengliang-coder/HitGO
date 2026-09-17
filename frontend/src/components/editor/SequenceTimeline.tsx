import { useRef, type DragEvent, type MouseEvent } from 'react';
import { useEditor, useCoverDuration } from '../../store/editor';
import { player } from '../../lib/player';
import { clipWindows, insertClip, moveClip, sequenceDuration } from '../../lib/sequence';
import { formatTime } from '../../lib/time';

const VIDEO_DRAG = 'application/x-hitgo-source-video';
const CLIP_DRAG = 'application/x-hitgo-sequence-clip';

/** The composed timeline replaces the single-source sprite/range view after first insertion. */
export function SequenceTimeline() {
  const spec = useEditor((s) => s.currentSpec());
  const current = useEditor((s) => s.currentVideo());
  const videos = useEditor((s) => s.videos);
  const time = useEditor((s) => s.time);
  const selected = useEditor((s) => s.selectedClipId);
  const select = useEditor((s) => s.setSelectedClip);
  const replace = useEditor((s) => s.replaceSpec);
  const pps = useEditor((s) => s.timelinePps);
  const preroll = useCoverDuration();
  const track = useRef<HTMLDivElement>(null);
  const sequence = spec?.sequence;
  if (!sequence || !current) return null;
  const windows = clipWindows(sequence);
  const duration = sequenceDuration(sequence);
  const minWidth = pps ? Math.max(0, duration * pps) : 0;

  const timeAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    return rect ? Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration)) : 0;
  };
  const seek = (e: MouseEvent) => player.seek(timeAt(e.clientX));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const clipId = e.dataTransfer.getData(CLIP_DRAG);
    const at = timeAt(e.clientX);
    if (clipId) {
      const index = windows.findIndex((w) => at < (w.start + w.end) / 2);
      replace(current.id, moveClip(spec, clipId, index < 0 ? windows.length - 1 : index), { history: true });
      return;
    }
    const sourceId = e.dataTransfer.getData(VIDEO_DRAG);
    const source = videos.find((v) => v.id === sourceId && v.status === 'ready');
    if (!source) return;
    const inserted = insertClip(spec, current.id, current.duration, source.id, source.duration, at);
    replace(current.id, inserted.spec, { history: true });
    select(inserted.clipId);
    player.seek(at);
  };

  return <div className="timeline sequence-timeline">
    <div className="sequence-axis" onClick={seek}>
      <span>拼接时间</span><span>00:00</span><span>{formatTime(duration / 2)}</span><span>{formatTime(duration)}</span>
    </div>
    <div className="sequence-track-scroll">
      {preroll > 0 && <div className="sequence-cover" onClick={() => player.seek(-preroll)}>封面 · {formatTime(preroll)}</div>}
      <div className="sequence-track" ref={track} style={{ minWidth }} onClick={seek} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {windows.map(({ clip, start, end }, index) => {
          const source = videos.find((v) => v.id === clip.video_id);
          return <div key={clip.id} className={`sequence-clip ${selected === clip.id ? 'selected' : ''}`} style={{ width: `${((end - start) / duration) * 100}%`, marginLeft: index ? `${-((clip.transition?.duration ?? 0) / duration) * 100}%` : 0, zIndex: index + 1 }} title={`${source?.name ?? clip.video_id} · ${formatTime(clip.in)}–${formatTime(clip.out)}`} draggable onDragStart={(e) => e.dataTransfer.setData(CLIP_DRAG, clip.id)} onClick={(e) => { e.stopPropagation(); select(clip.id); player.seek(start); }}>
            {index > 0 && <span className="sequence-transition" title={clip.transition?.type ?? '硬切'}>{clip.transition && clip.transition.type !== 'cut' ? '◇' : '│'}</span>}
            <span className="sequence-clip-name">{source?.name ?? '源片缺失'}</span>
            <small>{formatTime(end - start)}</small>
          </div>;
        })}
        <div className="sequence-playhead" style={{ left: `${(Math.max(0, Math.min(duration, time)) / duration) * 100}%` }} />
      </div>
    </div>
    <div className="sequence-mini-tracks">
      <div><span>字幕 / 图层</span><span>{spec.layers.length ? `${spec.layers.length} 个图层` : '尚未添加'}</span></div>
      <div><span>配音 / 音乐</span><span>{spec.audio?.tracks.length ? `${spec.audio.tracks.length} 条音轨` : '源片声音'}</span></div>
    </div>
    <div className="sequence-hint">拖动片段可排序；从左侧视频列表拖入，可在落点插入。转场预览按切点显示，导出应用所设效果。</div>
  </div>;
}

export { VIDEO_DRAG };

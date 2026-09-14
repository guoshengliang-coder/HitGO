import { useEditor, usePostDuration } from '../../store/editor';
import { formatSeconds, formatTime } from '../../lib/time';
import { hintFor } from '../../lib/shortcuts';
import { IconClose, IconCutLeft, IconCutRight } from '../ui/Icons';

export function TrimPanel() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const time = useEditor((s) => s.time);
  const inPoint = useEditor((s) => s.inPoint);
  const setInPoint = useEditor((s) => s.setInPoint);
  const setOutPoint = useEditor((s) => s.setOutPoint);
  const selected = useEditor((s) => s.selectedRangeIndex);
  const setSelected = useEditor((s) => s.setSelectedRange);
  const deleteRange = useEditor((s) => s.deleteRemoveRange);
  const removeBefore = useEditor((s) => s.removeBefore);
  const removeAfter = useEditor((s) => s.removeAfter);
  const canRemoveBefore = useEditor((s) => s.canRemoveBefore());
  const canRemoveAfter = useEditor((s) => s.canRemoveAfter());
  const postDuration = usePostDuration();
  const remove = spec?.trim.remove ?? [];

  return (
    <div className="panel">
      <div className="panel-head">① 剪辑 · 删除区间</div>
      <div className="panel-body">
        <div className="inline">
          <button className="btn" onClick={() => setInPoint(time)} title={hintFor('in')}>
            设入点 <span className="mono muted">I</span>
          </button>
          <button className="btn" onClick={() => setOutPoint(time)} title={hintFor('out')} disabled={inPoint === null}>
            设出点 <span className="mono muted">O</span>
          </button>
          <button className="btn" onClick={removeBefore} disabled={!canRemoveBefore} title={hintFor('remove-before')}>
            <IconCutLeft /> 删左 <span className="mono muted">Q</span>
          </button>
          <button className="btn" onClick={removeAfter} disabled={!canRemoveAfter} title={hintFor('remove-after')}>
            <IconCutRight /> 删右 <span className="mono muted">W</span>
          </button>
          <button className="btn danger" onClick={() => selected !== null && deleteRange(selected)} disabled={selected === null} title={hintFor('delete-range')}>
            删除选中区间
          </button>
        </div>
        {inPoint !== null && (
          <div className="hint">
            入点已设在 <span className="mono">{formatTime(inPoint)}</span>（源时间），移动播放头后按 O 设出点。
            <button className="btn ghost sm" onClick={() => setInPoint(null)} style={{ marginLeft: 6 }}>
              取消
            </button>
          </div>
        )}

        <div className="section">
          <div className="section-title">
            <span>已删除区间（源时间轴）</span>
            <span className="mono muted">{remove.length}</span>
          </div>
          {remove.length === 0 ? (
            <div className="hint">暂无。播放到要删除的起点按 I，再到终点按 O；Q / W 一键删掉播放头左侧 / 右侧；也可以直接在时间轴上拖动区间边缘调整。</div>
          ) : (
            <div className="range-list">
              {remove.map((r, i) => (
                <div key={i} className={`range-item ${selected === i ? 'selected' : ''}`} onClick={() => setSelected(i)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(i)}>
                  <span>
                    {formatTime(r[0])} → {formatTime(r[1])}
                  </span>
                  <span className="muted">−{formatSeconds(r[1] - r[0])}</span>
                  <button className="btn ghost icon sm" aria-label="删除区间" onClick={(e) => { e.stopPropagation(); deleteRange(i); }}>
                    <IconClose />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <dl className="kv">
          <dt>原始时长</dt>
          <dd>{formatSeconds(video?.duration ?? 0, 2)}</dd>
          <dt>剪后时长</dt>
          <dd>{formatSeconds(postDuration, 2)}</dd>
          <dt>删除合计</dt>
          <dd>−{formatSeconds((video?.duration ?? 0) - postDuration, 2)}</dd>
        </dl>

        <div className="hint">
          删除区间基于源视频时间轴；图层出现时段基于剪后时间轴。修改剪辑不会自动改动图层时段，图层步骤会对落在剪后时长之外的图层给出提示。
        </div>
      </div>
    </div>
  );
}

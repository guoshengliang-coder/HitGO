// 时间线工具条左侧的剪辑工具（对齐剪映：与被操作的轨道就近）：撤销 / 重做、删左 / 删右（剪辑）、
// 拆分 / 删左 / 删右（音频：作用于选中的音轨；选中源音轨行时删左 / 删右是给原声加静音区间，HIG-25）、
// 删除（剪辑删区间 / 音频删音轨或原声静音区间 / 文本、贴纸、字幕删图层）。
// 提示文案走 lib/shortcuts 的 hintFor；这里用原生 title 而非 data-tip——.timeline 是 overflow: hidden，
// 纯 CSS tooltip 从表头向上弹出会被裁掉。

import { useEditor } from '../../store/editor';
import { hintFor } from '../../lib/shortcuts';
import { SOURCE_TRACK_ID } from '../../lib/audioTracks';
import { IconCutLeft, IconCutRight, IconRedo, IconSplit, IconTrash, IconUndo } from '../ui/Icons';

export function TimelineTools() {
  const step = useEditor((s) => s.step);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.canUndo());
  const canRedo = useEditor((s) => s.canRedo());
  const removeBefore = useEditor((s) => s.removeBefore);
  const removeAfter = useEditor((s) => s.removeAfter);
  const canRemoveBefore = useEditor((s) => s.canRemoveBefore());
  const canRemoveAfter = useEditor((s) => s.canRemoveAfter());
  const selectedRange = useEditor((s) => s.selectedRangeIndex);
  const deleteRange = useEditor((s) => s.deleteRemoveRange);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const removeLayer = useEditor((s) => s.removeLayer);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const removeTrack = useEditor((s) => s.removeAudioTrack);
  const splitTrack = useEditor((s) => s.splitAudioTrack);
  const cutTrackBefore = useEditor((s) => s.cutTrackBefore);
  const cutTrackAfter = useEditor((s) => s.cutTrackAfter);
  const selectedMute = useEditor((s) => s.selectedMuteIndex);
  const deleteMute = useEditor((s) => s.deleteSourceMute);
  const onSource = selectedTrackId === SOURCE_TRACK_ID;

  const canDelete = step === 'trim' ? selectedRange !== null : step === 'audio' ? (onSource ? selectedMute !== null : !!selectedTrackId) : !!selectedLayerId;
  const onDelete = () => {
    if (step === 'trim') {
      if (selectedRange !== null) deleteRange(selectedRange);
    } else if (step === 'audio') {
      if (onSource) {
        if (selectedMute !== null) deleteMute(selectedMute);
      } else if (selectedTrackId) removeTrack(selectedTrackId);
    } else if (selectedLayerId) removeLayer(selectedLayerId);
  };
  const deleteHint = step === 'trim' ? 'delete-range' : step === 'audio' ? 'delete-track' : 'delete-layer';

  return (
    <div className="tl-tools">
      <button className="btn icon" onClick={undo} disabled={!canUndo} aria-label="撤销" title={hintFor('undo')}>
        <IconUndo />
      </button>
      <button className="btn icon" onClick={redo} disabled={!canRedo} aria-label="重做" title={hintFor('redo')}>
        <IconRedo />
      </button>
      {step === 'trim' && (
        <>
          <button className="btn" onClick={removeBefore} disabled={!canRemoveBefore} title={hintFor('remove-before')}>
            <IconCutLeft /> 删左
          </button>
          <button className="btn" onClick={removeAfter} disabled={!canRemoveAfter} title={hintFor('remove-after')}>
            <IconCutRight /> 删右
          </button>
        </>
      )}
      {step === 'audio' && (
        <>
          <button className="btn" onClick={() => selectedTrackId && splitTrack(selectedTrackId)} disabled={!selectedTrackId || onSource} title={selectedTrackId ? hintFor('split-track') : '先选中一条 BGM / 口播'}>
            <IconSplit /> 拆分
          </button>
          <button className="btn" onClick={() => selectedTrackId && cutTrackBefore(selectedTrackId)} disabled={!selectedTrackId} title={selectedTrackId ? hintFor('cut-track-before') : '先选中一条音轨或源音轨'}>
            <IconCutLeft /> 删左
          </button>
          <button className="btn" onClick={() => selectedTrackId && cutTrackAfter(selectedTrackId)} disabled={!selectedTrackId} title={selectedTrackId ? hintFor('cut-track-after') : '先选中一条音轨或源音轨'}>
            <IconCutRight /> 删右
          </button>
        </>
      )}
      <button className="btn icon danger" onClick={onDelete} disabled={!canDelete} aria-label="删除" title={hintFor(deleteHint)}>
        <IconTrash />
      </button>
    </div>
  );
}

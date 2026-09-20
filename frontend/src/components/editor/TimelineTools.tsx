// 时间线工具（挂在 Transport 工具条里）：设入点 / 设出点 / 删左 / 删右（剪辑）、
// 拆分 / 删左 / 删右（音频：作用于选中的音轨；选中源音轨行时删左 / 删右是给原声加静音区间，HIG-25）、
// 拆分（图层模块：作用于选中的图层，HIG-79）、
// 删除（剪辑删区间 / 音频删音轨或原声静音区间 / 文本、贴纸、字幕删图层）。
// 提示文案走 lib/shortcuts 的 hintFor；这里用原生 title 而非 data-tip——.timeline 是 overflow: hidden，
// 纯 CSS tooltip 从表头向上弹出会被裁掉。

import { selectPostDuration, selectPostTime, useEditor } from '../../store/editor';
import { hintFor } from '../../lib/shortcuts';
import { SOURCE_TRACK_ID } from '../../lib/audioTracks';
import { splitLayerBlockedReason } from '../../lib/layerSplit';
import { IconCutLeft, IconCutRight, IconSplit, IconTrash } from '../ui/Icons';

export function TimelineTools() {
  const step = useEditor((s) => s.step);
  const time = useEditor((s) => s.time);
  const inPoint = useEditor((s) => s.inPoint);
  const setInPoint = useEditor((s) => s.setInPoint);
  const setOutPoint = useEditor((s) => s.setOutPoint);
  const removeBefore = useEditor((s) => s.removeBefore);
  const removeAfter = useEditor((s) => s.removeAfter);
  const canRemoveBefore = useEditor((s) => s.canRemoveBefore());
  const canRemoveAfter = useEditor((s) => s.canRemoveAfter());
  const selectedRange = useEditor((s) => s.selectedRangeIndex);
  const deleteRange = useEditor((s) => s.deleteRemoveRange);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const selectedLayerIds = useEditor((s) => s.selectedLayerIds);
  const timelineSelection = useEditor((s) => s.timelineSelection);
  const selectTimelineItems = useEditor((s) => s.selectTimelineItems);
  const copyTimelineItems = useEditor((s) => s.copyTimelineItems);
  const pasteTimelineItems = useEditor((s) => s.pasteTimelineItems);
  const deleteTimelineItems = useEditor((s) => s.deleteTimelineItems);
  const selectAllLayers = useEditor((s) => s.selectAllLayers);
  const setSelectedLayer = useEditor((s) => s.setSelectedLayer);
  const removeSelectedLayers = useEditor((s) => s.removeSelectedLayers);
  const duplicateSelectedLayers = useEditor((s) => s.duplicateSelectedLayers);
  const updateSelectedOpacity = useEditor((s) => s.updateSelectedOpacity);
  const selectedOpacity = useEditor((s) => {
    const l = s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : null;
    return l?.opacity ?? 1;
  });
  const removeLayer = useEditor((s) => s.removeLayer);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const removeTrack = useEditor((s) => s.removeAudioTrack);
  const splitTrack = useEditor((s) => s.splitAudioTrack);
  const cutTrackBefore = useEditor((s) => s.cutTrackBefore);
  const cutTrackAfter = useEditor((s) => s.cutTrackAfter);
  const selectedMute = useEditor((s) => s.selectedMuteIndex);
  const splitLayer = useEditor((s) => s.splitLayer);
  const splitUpperVideo = useEditor((s) => s.splitUpperVideo);
  const layers = useEditor((s) => s.currentSpec()?.layers);
  const postTime = useEditor(selectPostTime);
  const postDuration = useEditor(selectPostDuration);
  const deleteMute = useEditor((s) => s.deleteSourceMute);
  const onSource = selectedTrackId === SOURCE_TRACK_ID;
  const videoLocked = !!spec?.video_locked;
  const audioLocked = onSource ? !!spec?.audio?.source_locked : !!spec?.audio?.tracks.find((t) => t.id === selectedTrackId)?.locked;
  const selectedUpperId = timelineSelection.find((key) => key.startsWith('vclip:'))?.slice(6) ?? null;
  const selectedUpperLocked = selectedUpperId ? !!spec?.video_tracks?.find((track) => track.clips.some((clip) => clip.id === selectedUpperId))?.locked : false;
  const selectedDeletable = timelineSelection.some((key) => key.startsWith('clip:') ? !videoLocked : key.startsWith('vclip:') ? !spec?.video_tracks?.find((track) => track.clips.some((clip) => clip.id === key.slice(6)))?.locked : key.startsWith('layer:') ? !spec?.layers.find((l) => l.id === key.slice(6))?.locked : key.startsWith('track:') ? !spec?.audio?.tracks.find((t) => t.id === key.slice(6))?.locked : false);
  const selectedLayerDeletable = selectedLayerIds.some((id) => !spec?.layers.find((l) => l.id === id)?.locked);

  const canDelete = selectedDeletable || (selectedLayerIds.length > 1 && selectedLayerDeletable) || (step === 'trim' ? selectedRange !== null && !videoLocked : step === 'audio' ? (onSource ? selectedMute !== null && !audioLocked : !!selectedTrackId && !audioLocked) : !!selectedLayerId && !spec?.layers.find((l) => l.id === selectedLayerId)?.locked);
  const onDelete = () => {
    if (timelineSelection.length) deleteTimelineItems();
    else if (selectedLayerIds.length > 1) removeSelectedLayers();
    else if (step === 'trim') {
      if (selectedRange !== null) deleteRange(selectedRange);
    } else if (step === 'audio') {
      if (onSource) {
        if (selectedMute !== null) deleteMute(selectedMute);
      } else if (selectedTrackId) removeTrack(selectedTrackId);
    } else if (selectedLayerId) removeLayer(selectedLayerId);
  };
  // 图层拆分（HIG-79）：剪辑和音频模块各有自己的拆分 / 删左删右，这里只管图层那几个模块
  const layerStep = step !== 'trim' && step !== 'audio';
  const selectedLayer = layers?.find((l) => l.id === selectedLayerId) ?? null;
  const splitBlocked = splitLayerBlockedReason(selectedLayer, postTime, postDuration);
  const deleteHint = hintFor(step === 'trim' ? 'delete-range' : step === 'audio' ? 'delete-track' : 'delete-layer');

  return (
    <div className="tl-tools">
      <button className="btn" onClick={selectAllLayers} title="选中当前视频所有可见且未锁定的视觉图层">全选图层</button>
      <button className="btn" onClick={() => { selectTimelineItems([]); setSelectedLayer(null); }} disabled={!selectedLayerIds.length && !timelineSelection.length}>取消选择</button>
      <button className="btn" onClick={copyTimelineItems} disabled={!timelineSelection.length} title="复制选中的视频、图片、字幕或音频片段">复制所选</button>
      <button className="btn" onClick={pasteTimelineItems} title="把复制的片段粘贴到播放头">粘贴</button>
      {selectedLayerIds.length > 1 && <>
        <button className="btn" onClick={duplicateSelectedLayers}>复制 {selectedLayerIds.length}</button>
        <label title="批量修改透明度" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>透明度 <input type="range" min="0" max="1" step="0.05" value={selectedOpacity} onChange={(e) => updateSelectedOpacity(Number(e.target.value))} style={{ width: 64 }} /></label>
      </>}
      {step === 'trim' && (
        <>
          {selectedUpperId && <button className="btn" onClick={() => splitUpperVideo(selectedUpperId)} disabled={selectedUpperLocked} title="在播放头拆分所选上层视频"><IconSplit /> 拆分上层视频</button>}
          <button className={`btn ${inPoint !== null ? 'on' : ''}`} onClick={() => setInPoint(time)} disabled={videoLocked} title={hintFor('in')}>
            入点
          </button>
          <button className="btn" onClick={() => setOutPoint(time)} disabled={inPoint === null || videoLocked} title={hintFor('out')}>
            出点
          </button>
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
          <button className="btn" onClick={() => selectedTrackId && splitTrack(selectedTrackId)} disabled={!selectedTrackId || onSource || audioLocked} title={selectedTrackId ? hintFor('split-track') : '先选中一条 BGM / 口播'}>
            <IconSplit /> 拆分
          </button>
          <button className="btn" onClick={() => selectedTrackId && cutTrackBefore(selectedTrackId)} disabled={!selectedTrackId || audioLocked} title={selectedTrackId ? hintFor('cut-track-before') : '先选中一条音轨或源音轨'}>
            <IconCutLeft /> 删左
          </button>
          <button className="btn" onClick={() => selectedTrackId && cutTrackAfter(selectedTrackId)} disabled={!selectedTrackId || audioLocked} title={selectedTrackId ? hintFor('cut-track-after') : '先选中一条音轨或源音轨'}>
            <IconCutRight /> 删右
          </button>
        </>
      )}
      {layerStep && (
        <button className="btn" onClick={() => selectedLayerId && splitLayer(selectedLayerId)} disabled={!!splitBlocked} title={splitBlocked ?? hintFor('split-layer')}>
          <IconSplit /> 拆分
        </button>
      )}
      <button className="btn icon danger" onClick={onDelete} disabled={!canDelete} aria-label="删除" title={deleteHint}>
        <IconTrash />
      </button>
    </div>
  );
}

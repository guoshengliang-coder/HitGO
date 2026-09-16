// 「字幕」独立模块（HIG-15）：从文本面板迁出的本地字幕导入能力，加上遮住画面里原字幕的遮盖层。
// 每条字幕仍生成一个文字图层，因此沿用文字图层的画布、时间线、样式与批量应用语义。
// 遮盖层（契约 §2 type = "mask"）也归本模块管：新建时插到第一个文字图层之前，永远压在字幕之下。

import { useRef } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { defaultTextStyle, type MaskLayer } from '../../types';
import { newLayerId } from '../../lib/spec';
import { BUILTIN_TEXT_PRESETS } from '../../lib/textPresets';
import { cuesToTextLayers, parseSrt } from '../../lib/srt';
import { newMaskLayer, timedTextSpan } from '../../lib/mask';
import { IconMask, IconText } from '../ui/Icons';
import { LayerList, LayerProps } from './LayerParts';

export function SubtitlePanel() {
  const addLayer = useEditor((s) => s.addLayer);
  const addLayers = useEditor((s) => s.addLayers);
  const updateLayer = useEditor((s) => s.updateLayer);
  const setToast = useEditor((s) => s.setToast);
  const postDuration = usePostDuration();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedMask = useEditor((s) => {
    const l = s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : undefined;
    return l?.type === 'mask' ? (l as MaskLayer) : null;
  });
  // 「按字幕时段」：把选中遮盖的显示时段收到所有带时段字幕的首尾
  const subtitleSpan = useEditor((s) => (s.currentVideoId ? timedTextSpan(s.specs[s.currentVideoId]?.layers ?? []) : null));

  const importSrt = async (file: File) => {
    let text = '';
    try {
      text = await file.text();
    } catch {
      setToast('读取字幕文件失败');
      return;
    }
    const cues = parseSrt(text);
    const preset = BUILTIN_TEXT_PRESETS.find((p) => p.id === 'builtin:subtitle-bar');
    const style = { ...defaultTextStyle(), ...(preset?.style ?? {}) };
    const layers = cuesToTextLayers(cues, { style, newId: newLayerId, maxEnd: postDuration > 0 ? postDuration : undefined });
    if (!layers.length) {
      setToast('没有解析到字幕');
      return;
    }
    addLayers(layers);
    setToast(`已导入 ${layers.length} 条字幕`);
  };

  const fitToSubtitles = () => {
    if (!selectedMask || !subtitleSpan) return;
    const [a, b] = subtitleSpan;
    updateLayer(selectedMask.id, { t: [Math.round(a * 100) / 100, Math.round(b * 100) / 100] });
  };

  return (
    <div className="panel">
      <div className="panel-head">字幕</div>
      <div className="panel-body">
        <div className="hint">导入本地字幕：把 .srt 文件的每条字幕变成一个带时段的文字图层，套「黑底白字字幕条」样式贴底居中；超出剪后时长的字幕会被截掉。</div>
        <div className="inline">
          <button className="btn" onClick={() => inputRef.current?.click()}>
            <IconText /> 选择 .srt 文件
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".srt,.vtt,text/plain"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // 允许重复导入同一个文件
            if (file) void importSrt(file);
          }}
        />

        <div className="section">
          <div className="section-title">遮盖原字幕</div>
          <div className="hint">画面里烧死的原字幕先用一条遮盖糊掉或盖住，再叠新字幕。遮盖缺省贴底通栏，在画布上拖动、拉伸到原字幕的位置；它总在字幕之下。</div>
          <div className="inline">
            <button className="btn" onClick={() => addLayer(newMaskLayer(newLayerId), { belowType: 'text' })}>
              <IconMask /> 添加遮盖
            </button>
            <button
              className="btn ghost"
              disabled={!selectedMask || !subtitleSpan}
              title={!selectedMask ? '先选中一条遮盖' : !subtitleSpan ? '还没有带时段的字幕' : `把遮盖的显示时段设为 ${subtitleSpan[0].toFixed(1)}s – ${subtitleSpan[1].toFixed(1)}s`}
              onClick={fitToSubtitles}
            >
              按字幕时段
            </button>
          </div>
        </div>
        <LayerList type="mask" emptyHint="还没有遮盖。点「添加遮盖」，在画布上把它拖到原字幕的位置；模糊 / 色块与强度在属性里改。" />
        {selectedMask && <LayerProps key={selectedMask.id} layer={selectedMask} />}
      </div>
    </div>
  );
}

// 「字幕」独立模块（HIG-15）：从文本面板迁出的本地字幕导入能力。
// 每条字幕仍生成一个文字图层，因此沿用文字图层的画布、时间线、样式与批量应用语义。

import { useRef } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { defaultTextStyle } from '../../types';
import { newLayerId } from '../../lib/spec';
import { BUILTIN_TEXT_PRESETS } from '../../lib/textPresets';
import { cuesToTextLayers, parseSrt } from '../../lib/srt';
import { IconText } from '../ui/Icons';
import { ApplyLayersFoot } from './LayerParts';

export function SubtitlePanel({ onApply, targetCount }: { onApply: () => void; targetCount: number }) {
  const addLayers = useEditor((s) => s.addLayers);
  const setToast = useEditor((s) => s.setToast);
  const postDuration = usePostDuration();
  const inputRef = useRef<HTMLInputElement>(null);

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
      </div>
      <ApplyLayersFoot onApply={onApply} targetCount={targetCount} />
    </div>
  );
}

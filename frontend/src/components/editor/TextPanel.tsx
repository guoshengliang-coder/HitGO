// 「文本」模块右侧面板（HIG-8）：文字 / 花字 / 气泡 / 模板 / 字幕 五个 tab。
// 只管文字图层；贴纸在「贴纸」模块里。

import { useRef, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { defaultTextStyle, type TextLayer } from '../../types';
import { newLayerId } from '../../lib/spec';
import { TITLE_TEMPLATES, templateToLayers, type TitleTemplate } from '../../lib/titleTemplates';
import { BUILTIN_TEXT_PRESETS } from '../../lib/textPresets';
import { cuesToTextLayers, parseSrt } from '../../lib/srt';
import { IconText } from '../ui/Icons';
import { ApplyLayersFoot, LayerList, LayerProps, newTextLayer, PresetGallery } from './LayerParts';

type TextTab = 'layers' | 'fancy' | 'bubble' | 'templates' | 'subtitles';

const TABS: { key: TextTab; label: string }[] = [
  { key: 'layers', label: '文字' },
  { key: 'fancy', label: '花字' },
  { key: 'bubble', label: '气泡' },
  { key: 'templates', label: '模板' },
  { key: 'subtitles', label: '字幕' },
];

export function TextPanel({ onApply, targetCount }: { onApply: () => void; targetCount: number }) {
  const [tab, setTab] = useState<TextTab>('layers');
  const selected = useEditor((s) => {
    const l = s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : undefined;
    return l?.type === 'text' ? (l as TextLayer) : null;
  });
  const addLayer = useEditor((s) => s.addLayer);
  const addLayers = useEditor((s) => s.addLayers);
  const setToast = useEditor((s) => s.setToast);
  const postDuration = usePostDuration();
  const srtInputRef = useRef<HTMLInputElement>(null);

  const addTemplate = (c: TitleTemplate) => {
    addLayers(templateToLayers(c, newLayerId));
    setTab('layers');
  };
  // 导入本地字幕（对应剪映）：每条 .srt 字幕 → 一个带时段的文字图层，套「黑底白字字幕条」样式贴底居中。
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
    setTab('layers');
    setToast(`已导入 ${layers.length} 条字幕`);
  };

  return (
    <div className="panel">
      <div className="tabs" role="tablist" style={{ padding: '0 8px' }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'layers' && (
          <>
            <div className="inline">
              <button className="btn" onClick={() => addLayer(newTextLayer())}>
                <IconText /> 添加文字
              </button>
            </div>
            <LayerList type="text" emptyHint="还没有文字图层。点「添加文字」，或在「花字」「气泡」「模板」「字幕」页里一键添加；加入后可在画布上双击直接改字。" />
            {selected && <LayerProps key={selected.id} layer={selected} />}
          </>
        )}
        {(tab === 'fancy' || tab === 'bubble') && <PresetGallery layer={selected} group={tab === 'fancy' ? 'text' : 'bubble'} onCreated={() => setTab('layers')} />}
        {tab === 'templates' && (
          <>
            <div className="hint">标题模板：一键添加带样式与位置的文字图层，加入后只需改字。</div>
            <div className="template-list">
              {TITLE_TEMPLATES.map((c) => (
                <button key={c.id} className="template-item" onClick={() => addTemplate(c)}>
                  <span className="cname">{c.name}</span>
                  <span className="muted small">
                    {c.note}
                    {c.layers.length > 1 ? ` · ${c.layers.length} 个图层` : ''}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {tab === 'subtitles' && (
          <>
            <div className="hint">导入本地字幕：把 .srt 文件的每条字幕变成一个带时段的文字图层，套「黑底白字字幕条」样式贴底居中；超出剪后时长的字幕会被截掉。</div>
            <div className="inline">
              <button className="btn" onClick={() => srtInputRef.current?.click()}>
                <IconText /> 选择 .srt 文件
              </button>
            </div>
            <input
              ref={srtInputRef}
              type="file"
              accept=".srt,.vtt,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ''; // 允许重复导入同一个文件
                if (f) void importSrt(f);
              }}
            />
          </>
        )}
      </div>
      <ApplyLayersFoot onApply={onApply} targetCount={targetCount} />
    </div>
  );
}

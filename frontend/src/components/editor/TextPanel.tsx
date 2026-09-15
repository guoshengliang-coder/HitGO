// 「文本」模块右侧面板：图层 / 文字 / 模板 / 字幕 四个 tab（HIG-8 拆出，HIG-11 对齐贴纸面板重排）。
// 「图层」列出文字图层并编辑选中的那条；「文字」平铺字体 / 花字 / 气泡卡片，双击新建图层。
// 在画布 / 时间线 / 列表里选中文字图层时自动切回「图层」页；「文字」页自己新建的不切，方便连续添加。
// 只管文字图层；贴纸在「贴纸」模块里。

import { useEffect, useRef, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { defaultTextStyle, type TextLayer } from '../../types';
import { newLayerId } from '../../lib/spec';
import { TITLE_TEMPLATES, templateToLayers, type TitleTemplate } from '../../lib/titleTemplates';
import { BUILTIN_TEXT_PRESETS } from '../../lib/textPresets';
import { cuesToTextLayers, parseSrt } from '../../lib/srt';
import { galleryLayerSeed, type GalleryItem } from '../../lib/textGallery';
import { IconText } from '../ui/Icons';
import { ApplyLayersFoot, LayerList, LayerProps, newTextLayer } from './LayerParts';
import { TextGallery } from './TextGallery';

type TextTab = 'layers' | 'gallery' | 'templates' | 'subtitles';

const TABS: { key: TextTab; label: string }[] = [
  { key: 'layers', label: '图层' },
  { key: 'gallery', label: '文字' },
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
  // 「文字」页双击新建的图层 id：它被自动选中时不切页
  const createdIdRef = useRef<string | null>(null);
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId && selectedId === createdIdRef.current) return;
    createdIdRef.current = null; // 选中别的或取消选中后，再选回这条就算主动选中
    if (selectedId) setTab('layers');
  }, [selectedId]);

  const addFromGallery = (item: GalleryItem) => {
    const { style, text } = galleryLayerSeed(item);
    const layer = newTextLayer(style, text);
    createdIdRef.current = layer.id;
    addLayer(layer);
  };

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
            <LayerList type="text" emptyHint="还没有文字图层。点「添加文字」，或在「文字」页双击字体 / 花字 / 气泡卡片、在「模板」「字幕」页里添加；加入后可在画布上双击直接改字。" />
            {selected && <LayerProps key={selected.id} layer={selected} />}
          </>
        )}
        {tab === 'gallery' && <TextGallery onCreate={addFromGallery} />}
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

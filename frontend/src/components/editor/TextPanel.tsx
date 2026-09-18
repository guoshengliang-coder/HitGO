// 「文本」模块右侧面板：图层 / 文字 / 模板三个 tab（HIG-8 拆出，HIG-11 对齐贴纸面板重排）。
// 「图层」列出文字图层并编辑选中的那条；「文字」平铺字体 / 花字 / 气泡卡片，双击新建图层。
// 在画布 / 时间线 / 列表里选中文字图层时自动切回「图层」页；「文字」页自己新建的不切，方便连续添加。
// 只管文字图层；贴纸和字幕分别在各自模块里。

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../../store/editor';
import type { TextLayer } from '../../types';
import { newLayerId } from '../../lib/spec';
import { TITLE_TEMPLATES, templateToLayers, type TitleTemplate } from '../../lib/titleTemplates';
import { galleryLayerSeed, type GalleryItem } from '../../lib/textGallery';
import { IconText } from '../ui/Icons';
import { LayerList, LayerProps, newTextLayer } from './LayerParts';
import { TextGallery } from './TextGallery';

type TextTab = 'layers' | 'gallery' | 'templates';

const TABS: { key: TextTab; label: string }[] = [
  { key: 'layers', label: '图层' },
  { key: 'gallery', label: '文字' },
  { key: 'templates', label: '模板' },
];

export function TextPanel() {
  const [tab, setTab] = useState<TextTab>('layers');
  const selected = useEditor((s) => {
    const l = s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : undefined;
    return l?.type === 'text' ? (l as TextLayer) : null;
  });
  const addLayer = useEditor((s) => s.addLayer);
  const addLayers = useEditor((s) => s.addLayers);
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
              <button className="btn action action-wide" onClick={() => addLayer(newTextLayer())}>
                <IconText /> 添加文字
              </button>
            </div>
            <LayerList type="text" emptyHint="还没有文字图层。点「添加文字」，或在「文字」页双击字体 / 花字 / 气泡卡片、在「模板」页添加；字幕请到顶栏「字幕」模块导入。加入后可在画布上双击直接改字。" />
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
      </div>
    </div>
  );
}

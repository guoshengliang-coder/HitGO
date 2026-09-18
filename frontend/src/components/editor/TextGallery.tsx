// 文本面板「文字」页（HIG-11）：字体 / 花字 / 气泡三组可折叠卡片平铺。
// 单击只高亮，双击（或 Enter）新建一条带该字体 / 样式的文字图层；改已有图层的样式在「图层」页的属性里。

import { useMemo, useState, type ReactNode } from 'react';
import { useEditor } from '../../store/editor';
import { fontChoices, galleryItemKey, groupPresets, searchFontChoices, type GalleryItem } from '../../lib/textGallery';
import { FONT_GROUP_LABEL, type FontGroup } from '../../lib/fontCatalog';
import { IconChevron } from '../ui/Icons';
import { presetThumb } from './LayerParts';

type GroupKey = 'font' | 'fancy' | 'bubble';

function GalleryGroup({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className={`sec ${open ? '' : 'collapsed'}`}>
      <div className="sec-head">
        <button className="sec-title" onClick={onToggle} aria-expanded={open}>
          <span>
            {title} <span className="muted small">{count}</span>
          </span>
          <IconChevron open={open} />
        </button>
      </div>
      {open && <div className="sec-body gallery-body">{children}</div>}
    </div>
  );
}

export function TextGallery({ onCreate }: { onCreate: (item: GalleryItem) => void }) {
  const presets = useEditor((s) => s.textPresets);
  const assets = useEditor((s) => s.assets);
  const deletePreset = useEditor((s) => s.deleteTextPreset);
  const groups = useMemo(() => groupPresets(presets), [presets]);
  const fonts = useMemo(() => fontChoices(assets), [assets]);
  const [fontQuery, setFontQuery] = useState('');
  const shownFonts = useMemo(() => searchFontChoices(fonts, fontQuery), [fonts, fontQuery]);
  const [active, setActive] = useState<string | null>(null);
  const [closed, setClosed] = useState<Record<GroupKey, boolean>>({ font: false, fancy: false, bubble: false });
  const toggle = (k: GroupKey) => setClosed((c) => ({ ...c, [k]: !c[k] }));

  const card = (item: GalleryItem, title: string, visual: ReactNode, extra?: ReactNode) => {
    const key = galleryItemKey(item);
    return (
      <div key={key} className={`preset-item ${extra ? 'user' : ''}`}>
        <button
          className={`preset-btn ${active === key ? 'active' : ''}`}
          aria-pressed={active === key}
          title={`双击添加「${title}」`}
          onClick={() => setActive(key)}
          onDoubleClick={() => onCreate(item)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); // 不再触发 click
            setActive(key);
            onCreate(item);
          }}
        >
          {visual}
          <span className="pname">{title}</span>
        </button>
        {active === key && <button className="btn action sm preset-add" onClick={() => onCreate(item)}>添加</button>}
        {extra}
      </div>
    );
  };

  const presetCards = (list: typeof presets) =>
    list.length === 0 ? (
      <div className="hint">这一组还没有预设。可在「图层」页属性的「套用样式」里把当前文字存为预设。</div>
    ) : (
      <div className="preset-list">
        {list.map((p) => {
          const url = presetThumb(p);
          return card(
            { kind: 'preset', preset: p },
            p.name,
            url ? <img src={url} alt="" /> : <span className="muted small">Aa</span>,
            p.builtin ? undefined : (
              <button className="preset-del" aria-label={`删除预设 ${p.name}`} title="删除预设" onClick={() => void deletePreset(p.id)}>
                ✕
              </button>
            ),
          );
        })}
      </div>
    );

  return (
    <>
      <div className="hint">单击选中样式，再点「添加」创建文字图层；双击或按 Enter 也可直接添加。</div>
      <GalleryGroup title="字体" count={fonts.length} open={!closed.font} onToggle={() => toggle('font')}>
        <input className="input font-search" type="search" placeholder="搜索字体名称或风格" aria-label="搜索字体" value={fontQuery} onChange={(e) => setFontQuery(e.target.value)} />
        {(['basic', 'popular', 'more', 'uploaded'] as const).map((group) => {
          const inGroup = shownFonts.filter((f) => f.group === group);
          if (!inGroup.length) return null;
          return (
            <div key={group} className="font-group">
              <div className="muted small">{group === 'uploaded' ? '其他已上传' : FONT_GROUP_LABEL[group as FontGroup]}</div>
              <div className="preset-list">
                {inGroup.map((f) => card(
                  { kind: 'font', font: f },
                  f.builtin ? `${f.label}（内置）` : f.label,
                  <span className="font-sample" style={{ fontFamily: `"${f.family}", sans-serif` }}>{f.sample}</span>,
                ))}
              </div>
            </div>
          );
        })}
        {shownFonts.length === 0 && <div className="hint">没有符合「{fontQuery.trim()}」的可用字体。</div>}
      </GalleryGroup>
      <GalleryGroup title="花字" count={groups.text.length} open={!closed.fancy} onToggle={() => toggle('fancy')}>
        {presetCards(groups.text)}
      </GalleryGroup>
      <GalleryGroup title="气泡" count={groups.bubble.length} open={!closed.bubble} onToggle={() => toggle('bubble')}>
        {presetCards(groups.bubble)}
      </GalleryGroup>
    </>
  );
}

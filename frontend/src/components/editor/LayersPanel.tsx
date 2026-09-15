import { useMemo, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { ANCHORS, defaultTextStyle, type Anchor, type Layer, type StickerLayer, type TextLayer, type TextSpan, type TextStyle, type TextStylePreset } from '../../types';
import { layerName, layerOutsideDuration, newLayerId } from '../../lib/spec';
import { reanchor } from '../../lib/layout';
import { layerAspect } from '../../lib/spec';
import { BUILTIN_FONT_FAMILY } from '../../lib/fonts';
import { hintFor } from '../../lib/shortcuts';
import { drawTextImage } from '../../lib/textImage';
import { adjustSpans, normalizeSpans, setSpanColor } from '../../lib/textSpans';
import { TITLE_TEMPLATES, templateToLayers, type TitleTemplate } from '../../lib/titleTemplates';
import { AssetCard } from '../../pages/AssetsPage';
import { IconCopy, IconDown, IconEye, IconLock, IconSticker, IconText, IconTrash, IconUp } from '../ui/Icons';

/** 预设缩略图：小画布渲染「花字」，按 id + 样式缓存 data URL。 */
const thumbCache = new Map<string, string>();
const THUMB_H = 400; // 渲染基准高（px）：字号 0.075 → 30 px，描边 / 阴影按同比例缩放
function presetThumb(preset: TextStylePreset): string {
  const key = `${preset.id}:${JSON.stringify(preset.style)}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  let url = '';
  try {
    const style: TextStyle = { ...defaultTextStyle(), ...preset.style, font_size: 0.075, align: 'center', background_width: null };
    url = drawTextImage('花字', style, THUMB_H).canvas.toDataURL('image/png');
  } catch {
    /* 非浏览器环境 / canvas 不可用 */
  }
  thumbCache.set(key, url);
  return url;
}

/** 颜色输入只接受 #RRGGBB；8 位（含透明度）的取前 7 位显示。 */
const hex6 = (c: string) => (c && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : '#000000');

function PresetStrip({ layer }: { layer: TextLayer }) {
  const presets = useEditor((s) => s.textPresets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const savePreset = useEditor((s) => s.saveTextPreset);
  const deletePreset = useEditor((s) => s.deleteTextPreset);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const thumbs = useMemo(() => presets.map((p) => ({ p, url: presetThumb(p) })), [presets]);

  const apply = (p: TextStylePreset) =>
    updateLayer(layer.id, (l) => {
      if (l.type === 'text') Object.assign(l.style, p.style);
    });
  const submit = async () => {
    const nm = name.trim();
    if (!nm) return;
    await savePreset(nm, { ...layer.style });
    setName('');
    setNaming(false);
  };

  return (
    <div className="preset-strip">
      <div className="section-title">
        <span>样式预设</span>
        {naming ? (
          <span className="inline">
            <input
              className="input sm"
              style={{ width: 120 }}
              autoFocus
              maxLength={40}
              placeholder="预设名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
                if (e.key === 'Escape') setNaming(false);
                e.stopPropagation();
              }}
            />
            <button className="btn sm primary" disabled={!name.trim()} onClick={() => void submit()}>保存</button>
            <button className="btn sm ghost" onClick={() => setNaming(false)}>取消</button>
          </span>
        ) : (
          <button className="btn ghost sm" onClick={() => setNaming(true)} title="把当前图层的全部文字样式保存为预设">存为预设</button>
        )}
      </div>
      <div className="preset-list">
        {thumbs.map(({ p, url }) => (
          <div key={p.id} className={`preset-item ${p.builtin ? '' : 'user'}`}>
            <button className="preset-btn" title={`套用「${p.name}」`} onClick={() => apply(p)}>
              {url ? <img src={url} alt="" /> : <span className="muted small">Aa</span>}
              <span className="pname">{p.name}</span>
            </button>
            {!p.builtin && (
              <button className="preset-del" aria-label={`删除预设 ${p.name}`} title="删除预设" onClick={() => void deletePreset(p.id)}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const ANCHOR_TITLES: Record<Anchor, string> = {
  'top-left': '左上', 'top-center': '上中', 'top-right': '右上',
  'center-left': '左中', center: '中心', 'center-right': '右中',
  'bottom-left': '左下', 'bottom-center': '下中', 'bottom-right': '右下',
};

function Num({ value, onChange, step = 0.01, min, max, scale = 100, suffix = '%' }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; scale?: number; suffix?: string }) {
  return (
    <span className="inline">
      <input
        className="input sm num"
        type="number"
        step={step * scale}
        min={min !== undefined ? min * scale : undefined}
        max={max !== undefined ? max * scale : undefined}
        value={Math.round(value * scale * 100) / 100}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n / scale);
        }}
      />
      <span className="muted small">{suffix}</span>
    </span>
  );
}

function LayerProps({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  const postDuration = usePostDuration();
  const fonts = assets.filter((a) => a.type === 'font');
  const aspect = layerAspect(layer, assets);
  // 文本框里的当前选区（[start, end)，UTF-16 索引）与待用的上色颜色
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [spanColor, setSpanColorState] = useState('#E3312B');

  const setAnchor = (a: Anchor) => {
    const p = reanchor(layer, aspect, { W: 1080, H: 1920 }, a);
    updateLayer(layer.id, { anchor: a, margin: [Math.round(p.margin[0] * 10000) / 10000, Math.round(p.margin[1] * 10000) / 10000] });
  };
  const patchStyle = (patch: Partial<TextLayer['style']>) => updateLayer(layer.id, (l) => { if (l.type === 'text') Object.assign(l.style, patch); });
  const patchSpans = (fn: (spans: TextSpan[], textLength: number) => TextSpan[]) =>
    updateLayer(layer.id, (l) => {
      if (l.type !== 'text') return;
      const next = fn(l.spans ?? [], l.text.length);
      if (next.length) l.spans = next;
      else delete l.spans;
    });
  const spans = layer.type === 'text' ? normalizeSpans(layer.spans, layer.text.length) : [];
  const onTextSelect = (t: HTMLTextAreaElement) => setSel(t.selectionStart !== t.selectionEnd ? [t.selectionStart, t.selectionEnd] : null);

  return (
    <div className="section">
      <div className="section-title">属性 · {layerName(layer, assets)}</div>
      <div className="prop-grid">
        <span>锚点</span>
        <div className="inline">
          <div className="anchor-grid" role="radiogroup" aria-label="锚点">
            {ANCHORS.map((a) => (
              <button key={a} role="radio" aria-checked={layer.anchor === a} className={layer.anchor === a ? 'active' : ''} title={ANCHOR_TITLES[a]} onClick={() => setAnchor(a)} />
            ))}
          </div>
          <span className="muted small">{ANCHOR_TITLES[layer.anchor]}</span>
        </div>
        <span>边距 X / Y</span>
        <div className="inline">
          <Num value={layer.margin[0]} onChange={(v) => updateLayer(layer.id, { margin: [v, layer.margin[1]] })} />
          <Num value={layer.margin[1]} onChange={(v) => updateLayer(layer.id, { margin: [layer.margin[0], v] })} />
        </div>
        <span>宽度</span>
        <div className="inline">
          <Num value={layer.width} min={0.01} max={2} onChange={(v) => updateLayer(layer.id, (l) => { l.width = v; if (l.type === 'text') l.width_manual = true; })} />
          {layer.type === 'text' && layer.width_manual && (
            <button className="btn ghost sm" onClick={() => updateLayer(layer.id, (l) => { if (l.type === 'text') l.width_manual = false; })} title="宽度重新跟随文字渲染尺寸">
              自动
            </button>
          )}
        </div>
        <span>旋转</span>
        <Num value={layer.rotate} scale={1} step={1} min={-360} max={360} suffix="°" onChange={(v) => updateLayer(layer.id, { rotate: v })} />
        <span>不透明度</span>
        <Num value={layer.opacity} min={0} max={1} onChange={(v) => updateLayer(layer.id, { opacity: Math.max(0, Math.min(1, v)) })} />
        <span>时段</span>
        <div className="inline">
          <button className={`chip ${layer.t === 'all' ? 'active' : ''}`} onClick={() => updateLayer(layer.id, { t: 'all' })}>全程</button>
          <button className={`chip ${layer.t !== 'all' ? 'active' : ''}`} onClick={() => layer.t === 'all' && updateLayer(layer.id, { t: [0, Math.min(3, postDuration)] })}>区间</button>
          {layer.t !== 'all' && (
            <>
              <Num value={layer.t[0]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => updateLayer(layer.id, { t: [v, Math.max(v + 0.1, (layer.t as [number, number])[1])] })} />
              <Num value={layer.t[1]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => updateLayer(layer.id, { t: [Math.min((layer.t as [number, number])[0], v - 0.1), v] })} />
            </>
          )}
        </div>
      </div>
      {layerOutsideDuration(layer, postDuration) && <div className="error-text">该图层的时段起点已超出剪后时长（{postDuration.toFixed(1)}s），成片里不会出现。</div>}

      {layer.type === 'text' && (
        <>
          <div className="section-title" style={{ marginTop: 6 }}>文字</div>
          <PresetStrip layer={layer} />
          <textarea
            className="textarea"
            rows={3}
            value={layer.text}
            onChange={(e) => {
              const next = e.target.value;
              updateLayer(
                layer.id,
                (l) => {
                  if (l.type !== 'text') return;
                  const moved = adjustSpans(l.spans, l.text, next);
                  if (moved.length) l.spans = moved;
                  else delete l.spans;
                  l.text = next;
                },
                false,
              );
            }}
            onBlur={() => updateLayer(layer.id, {}, true)}
            onSelect={(e) => onTextSelect(e.currentTarget)}
          />
          <div className="prop-grid">
            <span>选中上色</span>
            <div className="inline">
              <input type="color" className="color" value={spanColor} onChange={(e) => setSpanColorState(e.target.value.toUpperCase())} />
              <button className="btn sm" disabled={!sel} title="给文本框里选中的文字上色" onClick={() => sel && patchSpans((sp, len) => setSpanColor(sp, sel[0], sel[1], spanColor, len))}>
                上色
              </button>
              <button className="btn ghost sm" disabled={!sel} title="清除选中文字的颜色" onClick={() => sel && patchSpans((sp, len) => setSpanColor(sp, sel[0], sel[1], null, len))}>
                清除
              </button>
              {!sel && <span className="muted small">先在文本框里选中文字</span>}
            </div>
            {spans.length > 0 && (
              <>
                <span>已上色</span>
                <div className="span-chips">
                  {spans.map((sp) => (
                    <button key={`${sp.start}-${sp.end}`} className="span-chip" title="点击清除这一段的颜色" onClick={() => patchSpans((cur, len) => setSpanColor(cur, sp.start, sp.end, null, len))}>
                      <i style={{ background: sp.color }} />
                      <span className="stext">{layer.text.slice(sp.start, sp.end).replace(/\n/g, ' ')}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <span>字体</span>
            <select className="select sm" value={layer.style.font_family} onChange={(e) => patchStyle({ font_family: e.target.value })}>
              <option value={BUILTIN_FONT_FAMILY}>{BUILTIN_FONT_FAMILY}（内置）</option>
              {fonts.map((f) => (
                <option key={f.id} value={f.family}>{f.family}</option>
              ))}
            </select>
            <span>字重</span>
            <select className="select sm" value={layer.style.font_weight} onChange={(e) => patchStyle({ font_weight: Number(e.target.value) })}>
              {[400, 500, 700, 900].map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
            <span>字号</span>
            <Num value={layer.style.font_size} min={0.01} max={0.3} step={0.005} onChange={(v) => patchStyle({ font_size: v })} suffix="% 高" />
            <span>颜色</span>
            <div className="inline">
              <input type="color" className="color" value={hex6(layer.style.color)} onChange={(e) => patchStyle({ color: e.target.value.toUpperCase() })} />
              <span className="mono small">{layer.style.color}</span>
              {/^#[0-9a-f]{6}00$/i.test(layer.style.color) && <span className="muted small">（透明 · 空心）</span>}
            </div>
            <span>描边</span>
            <div className="inline">
              <input type="color" className="color" value={hex6(layer.style.stroke_color)} onChange={(e) => patchStyle({ stroke_color: e.target.value.toUpperCase() })} />
              <Num value={layer.style.stroke_width} min={0} max={0.05} step={0.001} scale={1000} suffix="‰ 高" onChange={(v) => patchStyle({ stroke_width: v })} />
            </div>
            <span>阴影</span>
            <div className="inline">
              <input
                type="checkbox"
                checked={!!layer.style.shadow}
                onChange={(e) => patchStyle({ shadow: e.target.checked ? { color: '#00000099', blur: 0.01, offset: [0.002, 0.004] } : null })}
              />
              {layer.style.shadow && (
                <>
                  <input
                    type="color"
                    className="color"
                    value={hex6(layer.style.shadow.color)}
                    onChange={(e) => patchStyle({ shadow: { ...layer.style.shadow!, color: e.target.value.toUpperCase() + (layer.style.shadow?.color.slice(7) || '99') } })}
                  />
                  <span className="muted small">模糊</span>
                  <Num value={layer.style.shadow.blur} min={0} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ shadow: { ...layer.style.shadow!, blur: v } })} />
                </>
              )}
            </div>
            {layer.style.shadow && (
              <>
                <span>阴影偏移</span>
                <div className="inline">
                  <Num value={layer.style.shadow.offset[0]} min={-0.05} max={0.05} step={0.001} scale={1000} suffix="‰ X" onChange={(v) => patchStyle({ shadow: { ...layer.style.shadow!, offset: [v, layer.style.shadow!.offset[1]] } })} />
                  <Num value={layer.style.shadow.offset[1]} min={-0.05} max={0.05} step={0.001} scale={1000} suffix="‰ Y" onChange={(v) => patchStyle({ shadow: { ...layer.style.shadow!, offset: [layer.style.shadow!.offset[0], v] } })} />
                </div>
              </>
            )}
            <span>字距</span>
            <Num value={layer.style.letter_spacing ?? 0} min={-0.5} max={2} step={0.01} scale={1} suffix="em" onChange={(v) => patchStyle({ letter_spacing: v })} />
            <span>内边距</span>
            <Num value={layer.style.padding} min={0} max={0.1} step={0.001} scale={1000} suffix="‰ 高" onChange={(v) => patchStyle({ padding: v })} />
            <span>行高</span>
            <Num value={layer.style.line_height} min={0.6} max={3} step={0.05} scale={1} suffix="×" onChange={(v) => patchStyle({ line_height: v })} />
            <span>背景</span>
            <div className="inline">
              <input type="checkbox" checked={!!layer.style.background} onChange={(e) => patchStyle({ background: e.target.checked ? '#00000099' : null })} />
              {layer.style.background && (
                <>
                  <input type="color" className="color" value={layer.style.background.slice(0, 7)} onChange={(e) => patchStyle({ background: e.target.value.toUpperCase() + (layer.style.background?.slice(7) || '99') })} />
                  <span className="mono small">{layer.style.background}</span>
                </>
              )}
            </div>
            {layer.style.background && (
              <>
                <span>背景宽度</span>
                <div className="inline">
                  <button className={`chip ${layer.style.background_width == null ? 'active' : ''}`} onClick={() => patchStyle({ background_width: null })}>贴合</button>
                  <button className={`chip ${layer.style.background_width != null ? 'active' : ''}`} onClick={() => layer.style.background_width == null && patchStyle({ background_width: 1 })}>通栏</button>
                  {layer.style.background_width != null && (
                    <Num value={layer.style.background_width} min={0.3} max={1} step={0.01} suffix="% 宽" onChange={(v) => patchStyle({ background_width: Math.max(0.3, Math.min(1, v)) })} />
                  )}
                </div>
                <span>圆角</span>
                <div className="inline">
                  <Num
                    value={layer.style.background_radius ?? Math.min(layer.style.padding, layer.style.font_size * 0.2)}
                    min={0}
                    max={0.05}
                    step={0.001}
                    scale={1000}
                    suffix="‰ 高"
                    onChange={(v) => patchStyle({ background_radius: Math.max(0, v) })}
                  />
                  {layer.style.background_radius != null && (
                    <button className="btn ghost sm" onClick={() => patchStyle({ background_radius: null })} title="圆角重新跟随内边距 / 字号">
                      自动
                    </button>
                  )}
                </div>
              </>
            )}
            <span>对齐</span>
            <div className="inline">
              {(['left', 'center', 'right'] as const).map((a) => (
                <button key={a} className={`chip ${layer.style.align === a ? 'active' : ''}`} onClick={() => patchStyle({ align: a })}>
                  {{ left: '左', center: '中', right: '右' }[a]}
                </button>
              ))}
            </div>
          </div>
          <div className="hint">文字在「保存并回传」时按 1080×1920 输出分辨率渲染为透明 PNG（image_url）；宽度默认跟随渲染尺寸。</div>
        </>
      )}
    </div>
  );
}

export function LayersPanel({ onApply, targetCount }: { onApply: () => void; targetCount: number }) {
  const [tab, setTab] = useState<'layers' | 'assets'>('layers');
  const [source, setSource] = useState<'builtin' | 'mine'>('mine');
  const [q, setQ] = useState('');
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const assets = useEditor((s) => s.assets);
  const selectedId = useEditor((s) => s.selectedLayerId);
  const setSelected = useEditor((s) => s.setSelectedLayer);
  const addLayer = useEditor((s) => s.addLayer);
  const addLayers = useEditor((s) => s.addLayers);
  const [showTemplates, setShowTemplates] = useState(false);
  const updateLayer = useEditor((s) => s.updateLayer);
  const removeLayer = useEditor((s) => s.removeLayer);
  const moveLayer = useEditor((s) => s.moveLayer);
  const moveLayerTo = useEditor((s) => s.moveLayerTo);
  const duplicateLayer = useEditor((s) => s.duplicateLayer);
  const layers = spec?.layers ?? [];
  const selected = layers.find((l) => l.id === selectedId) ?? null;
  const stickers = useMemo(() => assets.filter((a) => a.type === 'sticker' && (!q || a.name.toLowerCase().includes(q.toLowerCase()))), [assets, q]);

  const addText = () => {
    const l: TextLayer = {
      id: newLayerId(),
      type: 'text',
      text: '双击编辑文字',
      style: defaultTextStyle(),
      anchor: 'center',
      margin: [0, 0],
      width: 0.5,
      rotate: 0,
      opacity: 1,
      t: 'all',
    };
    addLayer(l);
    setTab('layers');
  };
  const addTemplate = (c: TitleTemplate) => {
    addLayers(templateToLayers(c, newLayerId));
    setShowTemplates(false);
    setTab('layers');
  };
  const addSticker = (assetId: string) => {
    const l: StickerLayer = { id: newLayerId(), type: 'sticker', asset_id: assetId, anchor: 'top-left', margin: [0.08, 0.12], width: 0.35, rotate: 0, opacity: 1, t: 'all' };
    addLayer(l);
    setTab('layers');
  };

  return (
    <div className="panel">
      <div className="tabs" style={{ padding: '0 8px' }}>
        <button className={`tab ${tab === 'layers' ? 'active' : ''}`} onClick={() => setTab('layers')}>图层</button>
        <button className={`tab ${tab === 'assets' ? 'active' : ''}`} onClick={() => setTab('assets')}>素材</button>
      </div>
      {tab === 'layers' ? (
        <div className="panel-body">
          <div className="inline">
            <button className="btn" onClick={() => setTab('assets')}><IconSticker /> 贴纸</button>
            <button className="btn" onClick={addText}><IconText /> 文字</button>
            <button className="btn" onClick={() => setShowTemplates((v) => !v)} title="标题模板：一键添加带样式与位置的文字图层，加入后只需改字"><IconText /> 标题模板</button>
          </div>
          {showTemplates && (
            <div className="template-list">
              {TITLE_TEMPLATES.map((c) => (
                <button key={c.id} className="template-item" onClick={() => addTemplate(c)}>
                  <span className="cname">{c.name}</span>
                  <span className="muted small">{c.note}{c.layers.length > 1 ? ` · ${c.layers.length} 个图层` : ''}</span>
                </button>
              ))}
            </div>
          )}
          <div className="section">
            <div className="section-title"><span>图层（上层在前）</span><span className="mono muted">{layers.length}</span></div>
            {layers.length === 0 ? (
              <div className="hint">还没有图层。添加贴纸或文字后，可在预览里拖动、缩放、旋转。</div>
            ) : (
              <div className="layer-list">
                {[...layers].reverse().map((l) => (
                  <div key={l.id} className={`layer-item ${l.id === selectedId ? 'selected' : ''} ${l.visible === false ? 'hidden' : ''}`} onClick={() => setSelected(l.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(l.id)}>
                    <span className="muted">{l.type === 'text' ? <IconText /> : <IconSticker />}</span>
                    <span className="lname" title={layerName(l, assets)}>{layerName(l, assets)}</span>
                    <span className="acts" onClick={(e) => e.stopPropagation()}>
                      <button className="btn ghost icon" title="显示 / 隐藏（仅预览）" onClick={() => updateLayer(l.id, { visible: l.visible === false }, false)}><IconEye off={l.visible === false} /></button>
                      <button className="btn ghost icon" title="锁定 / 解锁" onClick={() => updateLayer(l.id, { locked: !l.locked }, false)}><IconLock open={!l.locked} /></button>
                      <button className="btn ghost icon" title={`${hintFor('layer-up')}（${hintFor('layer-top')}）`} onClick={(e) => (e.shiftKey ? moveLayerTo(l.id, 'top') : moveLayer(l.id, 1))}><IconUp /></button>
                      <button className="btn ghost icon" title={`${hintFor('layer-down')}（${hintFor('layer-bottom')}）`} onClick={(e) => (e.shiftKey ? moveLayerTo(l.id, 'bottom') : moveLayer(l.id, -1))}><IconDown /></button>
                      <button className="btn ghost icon" title={hintFor('duplicate')} onClick={() => duplicateLayer(l.id)}><IconCopy /></button>
                      <button className="btn ghost icon danger" title={hintFor('delete-layer')} onClick={() => removeLayer(l.id)}><IconTrash /></button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {selected && <LayerProps key={selected.id} layer={selected} />}
        </div>
      ) : (
        <div className="panel-body">
          <div className="chips">
            <button className={`chip ${source === 'builtin' ? 'active' : ''}`} onClick={() => setSource('builtin')}>原料库</button>
            <button className={`chip ${source === 'mine' ? 'active' : ''}`} onClick={() => setSource('mine')}>我上传的</button>
          </div>
          <input className="input sm" placeholder="搜索贴纸…" value={q} onChange={(e) => setQ(e.target.value)} />
          {source === 'builtin' ? (
            <div className="empty small">原料库为空 · 正式环境接原料库 API</div>
          ) : stickers.length === 0 ? (
            <div className="empty small">还没有贴纸，去「素材库」上传。</div>
          ) : (
            <div className="sticker-grid">
              {stickers.map((a) => (
                <AssetCard key={a.id} asset={a} onPick={() => addSticker(a.id)} />
              ))}
            </div>
          )}
          <div className="hint">点击贴纸即添加为图层（宽 35%，左上锚点，边距 8% / 12%，全程显示）。</div>
        </div>
      )}
      <div className="panel-foot">
        <button className="btn" disabled={targetCount === 0} onClick={onApply}>
          把图层配置应用到选中 {targetCount} 条
        </button>
      </div>
    </div>
  );
}

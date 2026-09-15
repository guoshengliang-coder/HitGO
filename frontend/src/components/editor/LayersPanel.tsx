// 第二步右侧面板：图层列表 + 属性检查器 + 贴纸素材。
// 属性检查器参考剪映的组织方式：文字内容在最上、样式预设分「花字 / 气泡」两组、
// 位置区带六向对齐、描边 / 阴影 / 背景等做成「勾选启用 + 折叠 + 重置」的分组。

import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { ANCHORS, defaultTextStyle, isAssetReady, isVideoAsset, type Anchor, type Layer, type Playback, type StickerLayer, type TextGlow, type TextLayer, type TextShadow, type TextSpan, type TextStyle, type TextStylePreset } from '../../types';
import { layerName, layerOutsideDuration, newLayerId } from '../../lib/spec';
import { filterAssets, type AssetBucket } from '../../lib/assets';
import { alignPlacement, reanchor, round4, type AlignEdge } from '../../lib/layout';
import { layerAspect } from '../../lib/spec';
import { BUILTIN_FONT_FAMILY } from '../../lib/fonts';
import { hintFor } from '../../lib/shortcuts';
import { drawTextImage } from '../../lib/textImage';
import { adjustSpans, normalizeSpans, setSpanColor } from '../../lib/textSpans';
import { TITLE_TEMPLATES, templateToLayers, type TitleTemplate } from '../../lib/titleTemplates';
import { BUILTIN_TEXT_PRESETS } from '../../lib/textPresets';
import { cuesToTextLayers, parseSrt } from '../../lib/srt';
import { AssetCard } from '../../pages/AssetsPage';
import {
  IconAlignBottom, IconAlignLeft, IconAlignRight, IconAlignTop, IconCenterH, IconCenterV, IconChevron, IconCopy, IconDown, IconEye, IconLock, IconReset, IconSticker, IconText, IconTrash, IconUp,
} from '../ui/Icons';

const REF = { W: 1080, H: 1920 };

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

/** 预设分组：带背景的算「气泡」，其余算「花字」。 */
type PresetGroup = 'text' | 'bubble';
const presetGroup = (p: TextStylePreset): PresetGroup => (p.style.background ? 'bubble' : 'text');

const DEFAULT_SHADOW: TextShadow = { color: '#00000099', blur: 0.01, offset: [0.002, 0.004] };
const DEFAULT_GLOW: TextGlow = { color: '#FFD84DCC', blur: 0.012 };
const DEFAULT_STROKE = { stroke_color: '#000000', stroke_width: 0.004 };
const DEFAULT_BACKGROUND = '#00000099';

// ---------------------------------------------------------------- 通用小控件

const clampNum = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** 数字输入 + 步进按钮。value 为内部单位，界面按 scale 放大显示（默认 ×100 显示为 %）。 */
function Num({ value, onChange, step = 0.01, min, max, scale = 100, suffix = '%', title }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; scale?: number; suffix?: string; title?: string }) {
  const shown = Math.round(value * scale * 100) / 100;
  const bump = (dir: 1 | -1) => onChange(clampNum(Math.round((value + dir * step) * 1e6) / 1e6, min, max));
  return (
    <span className="num-wrap" title={title}>
      <button className="num-step" tabIndex={-1} aria-label="减少" onClick={() => bump(-1)}>−</button>
      <input
        className="input sm num"
        type="number"
        step={step * scale}
        min={min !== undefined ? min * scale : undefined}
        max={max !== undefined ? max * scale : undefined}
        value={shown}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(clampNum(n / scale, min, max));
        }}
      />
      <button className="num-step" tabIndex={-1} aria-label="增加" onClick={() => bump(1)}>+</button>
      {suffix && <span className="muted small">{suffix}</span>}
    </span>
  );
}

/** 滑块 + 数字（不透明度这类 0–1 的量）。 */
function Slider({ value, onChange, min = 0, max = 1, step = 0.01 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <span className="inline slider-row">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <Num value={value} min={min} max={max} step={step} onChange={onChange} />
    </span>
  );
}

/**
 * 可折叠分组。带 onToggle 时标题左侧出现启用勾选（描边 / 阴影 / 背景）；
 * 带 onReset 时标题右侧出现「重置」。
 */
function Section({ title, enabled, onToggle, onReset, defaultOpen = true, children }: { title: string; enabled?: boolean; onToggle?: (on: boolean) => void; onReset?: () => void; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const collapsed = !open || enabled === false;
  return (
    <div className={`sec ${collapsed ? 'collapsed' : ''}`}>
      <div className="sec-head">
        {onToggle && (
          <input
            type="checkbox"
            checked={!!enabled}
            aria-label={`启用${title}`}
            onChange={(e) => {
              onToggle(e.target.checked);
              if (e.target.checked) setOpen(true);
            }}
          />
        )}
        <button className="sec-title" onClick={() => enabled !== false && setOpen((o) => !o)} disabled={enabled === false} aria-expanded={!collapsed}>
          <span>{title}</span>
          <IconChevron open={!collapsed} />
        </button>
        {onReset && (
          <button className="btn ghost icon sm" title="重置为默认值" aria-label={`重置${title}`} onClick={onReset} disabled={enabled === false}>
            <IconReset />
          </button>
        )}
      </div>
      {!collapsed && <div className="sec-body prop-grid">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- 预设

function PresetTabs({ layer }: { layer: TextLayer }) {
  const presets = useEditor((s) => s.textPresets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const savePreset = useEditor((s) => s.saveTextPreset);
  const deletePreset = useEditor((s) => s.deleteTextPreset);
  const [group, setGroup] = useState<PresetGroup>('text');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const thumbs = useMemo(() => presets.filter((p) => presetGroup(p) === group).map((p) => ({ p, url: presetThumb(p) })), [presets, group]);

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
        <span className="chips">
          <button className={`chip ${group === 'text' ? 'active' : ''}`} onClick={() => setGroup('text')}>花字</button>
          <button className={`chip ${group === 'bubble' ? 'active' : ''}`} onClick={() => setGroup('bubble')}>气泡</button>
        </span>
        {naming ? (
          <span className="inline">
            <input
              className="input sm"
              style={{ width: 110 }}
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
        {thumbs.length === 0 && <div className="hint">这一组还没有预设。</div>}
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

// ---------------------------------------------------------------- 属性分组

const ANCHOR_TITLES: Record<Anchor, string> = {
  'top-left': '左上', 'top-center': '上中', 'top-right': '右上',
  'center-left': '左中', center: '中心', 'center-right': '右中',
  'bottom-left': '左下', 'bottom-center': '下中', 'bottom-right': '右下',
};

const ALIGN_BUTTONS: { edge: AlignEdge; label: string; icon: ReactNode }[] = [
  { edge: 'left', label: '贴左', icon: <IconAlignLeft /> },
  { edge: 'center-h', label: '水平居中', icon: <IconCenterH /> },
  { edge: 'right', label: '贴右', icon: <IconAlignRight /> },
  { edge: 'top', label: '贴上', icon: <IconAlignTop /> },
  { edge: 'center-v', label: '垂直居中', icon: <IconCenterV /> },
  { edge: 'bottom', label: '贴下', icon: <IconAlignBottom /> },
];

/** 位置 / 对齐 / 宽度 / 旋转（文字与贴纸共用）。 */
function PlacementSection({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  const aspect = layerAspect(layer, assets);
  const setAnchor = (a: Anchor) => {
    const p = reanchor(layer, aspect, REF, a);
    updateLayer(layer.id, { anchor: a, margin: [round4(p.margin[0]), round4(p.margin[1])] });
  };
  const align = (edge: AlignEdge) => {
    const p = alignPlacement(layer, aspect, REF, edge);
    updateLayer(layer.id, { anchor: p.anchor, margin: p.margin });
  };
  return (
    <Section title="位置">
      <span>对齐</span>
      <div className="align-row" role="group" aria-label="对齐">
        {ALIGN_BUTTONS.map((b, i) => (
          <button key={b.edge} className={`btn icon sm ${i === 3 ? 'gap' : ''}`} title={b.label} aria-label={b.label} disabled={layer.locked} onClick={() => align(b.edge)}>
            {b.icon}
          </button>
        ))}
      </div>
      <span>锚点</span>
      <div className="inline">
        <div className="anchor-grid" role="radiogroup" aria-label="锚点">
          {ANCHORS.map((a) => (
            <button key={a} role="radio" aria-checked={layer.anchor === a} className={layer.anchor === a ? 'active' : ''} title={ANCHOR_TITLES[a]} onClick={() => setAnchor(a)} />
          ))}
        </div>
        <span className="muted small">{ANCHOR_TITLES[layer.anchor]}</span>
      </div>
      <span>边距 X</span>
      <Num value={layer.margin[0]} step={0.005} onChange={(v) => updateLayer(layer.id, { margin: [v, layer.margin[1]] })} />
      <span>边距 Y</span>
      <Num value={layer.margin[1]} step={0.005} onChange={(v) => updateLayer(layer.id, { margin: [layer.margin[0], v] })} />
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
    </Section>
  );
}

function BlendSection({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  return (
    <Section title="混合" onReset={() => updateLayer(layer.id, { opacity: 1 })}>
      <span>不透明度</span>
      <Slider value={layer.opacity} onChange={(v) => updateLayer(layer.id, { opacity: v })} />
    </Section>
  );
}

function TimeSection({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const postDuration = usePostDuration();
  return (
    <Section title="时段">
      <span>显示</span>
      <div className="inline">
        <button className={`chip ${layer.t === 'all' ? 'active' : ''}`} onClick={() => updateLayer(layer.id, { t: 'all' })}>全程</button>
        <button className={`chip ${layer.t !== 'all' ? 'active' : ''}`} onClick={() => layer.t === 'all' && updateLayer(layer.id, { t: [0, Math.min(3, postDuration)] })}>区间</button>
      </div>
      {layer.t !== 'all' && (
        <>
          <span>起 / 止</span>
          <div className="inline">
            <Num value={layer.t[0]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => updateLayer(layer.id, { t: [v, Math.max(v + 0.1, (layer.t as [number, number])[1])] })} />
            <Num value={layer.t[1]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => updateLayer(layer.id, { t: [Math.min((layer.t as [number, number])[0], v - 0.1), v] })} />
          </div>
        </>
      )}
      {layerOutsideDuration(layer, postDuration) && <div className="error-text span2">该图层的时段起点已超出剪后时长（{postDuration.toFixed(1)}s），成片里不会出现。</div>}
    </Section>
  );
}

/** 视频贴纸短于显示时段时的行为，与后端 filtergraph 的三种 eof_action 一一对应。 */
const PLAYBACK_MODES: [Playback, string, string][] = [
  ['loop', '循环', '素材比时段短时，从头循环播放'],
  ['freeze', '定格', '播完停在最后一帧'],
  ['once', '播完消失', '播完后该图层不再出现'],
];

const AUDIO_MODES: [boolean, string, string][] = [
  [false, '不合成', '成片只保留源视频的声音'],
  [true, '合成', '贴纸自带的声音叠加进成片（时段内，跟随播放方式）'],
];

/** 视频贴纸：播放方式 / 音轨。 */
function StickerMediaSection({ layer }: { layer: StickerLayer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  const asset = assets.find((a) => a.id === layer.asset_id);
  if (!isVideoAsset(asset)) return null;
  return (
    <Section title="播放">
      <span>播放</span>
      <div className="inline" role="radiogroup" aria-label="播放">
        {PLAYBACK_MODES.map(([mode, label, title]) => (
          <button key={mode} role="radio" aria-checked={(layer.playback ?? 'loop') === mode} className={`chip ${(layer.playback ?? 'loop') === mode ? 'active' : ''}`} title={title} onClick={() => updateLayer(layer.id, { playback: mode })}>
            {label}
          </button>
        ))}
      </div>
      {asset?.has_audio === true && (
        <>
          <span>音轨</span>
          <div className="inline" role="radiogroup" aria-label="音轨">
            {AUDIO_MODES.map(([mix, label, title]) => (
              <button key={label} role="radio" aria-checked={!!layer.mix_audio === mix} className={`chip ${!!layer.mix_audio === mix ? 'active' : ''}`} title={title} onClick={() => updateLayer(layer.id, { mix_audio: mix })}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function TextSections({ layer, sel }: { layer: TextLayer; sel: [number, number] | null }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  const fonts = assets.filter((a) => a.type === 'font');
  const st = layer.style;
  const d = defaultTextStyle();
  const patchStyle = (patch: Partial<TextStyle>) => updateLayer(layer.id, (l) => { if (l.type === 'text') Object.assign(l.style, patch); });
  const [spanColor, setSpanColorState] = useState('#E3312B');
  const patchSpans = (fn: (spans: TextSpan[], textLength: number) => TextSpan[]) =>
    updateLayer(layer.id, (l) => {
      if (l.type !== 'text') return;
      const next = fn(l.spans ?? [], l.text.length);
      if (next.length) l.spans = next;
      else delete l.spans;
    });
  const spans = normalizeSpans(layer.spans, layer.text.length);

  return (
    <>
      <Section title="字体" onReset={() => patchStyle({ font_family: d.font_family, font_weight: d.font_weight, font_size: d.font_size, color: d.color, align: d.align })}>
        <span>字体</span>
        <select className="select sm" value={st.font_family} onChange={(e) => patchStyle({ font_family: e.target.value })}>
          <option value={BUILTIN_FONT_FAMILY}>{BUILTIN_FONT_FAMILY}（内置）</option>
          {fonts.map((f) => (
            <option key={f.id} value={f.family}>{f.family}</option>
          ))}
        </select>
        <span>字重</span>
        <select className="select sm" value={st.font_weight} onChange={(e) => patchStyle({ font_weight: Number(e.target.value) })}>
          {[400, 500, 700, 900].map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
        <span>字号</span>
        <Num value={st.font_size} min={0.01} max={0.3} step={0.005} onChange={(v) => patchStyle({ font_size: v })} suffix="% 高" />
        <span>颜色</span>
        <div className="inline">
          <input type="color" className="color" value={hex6(st.color)} onChange={(e) => patchStyle({ color: e.target.value.toUpperCase() })} />
          <span className="mono small">{st.color}</span>
          {/^#[0-9a-f]{6}00$/i.test(st.color) && <span className="muted small">（透明 · 空心）</span>}
        </div>
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
        <span>文字对齐</span>
        <div className="inline">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} className={`chip ${st.align === a ? 'active' : ''}`} onClick={() => patchStyle({ align: a })}>
              {{ left: '左', center: '中', right: '右' }[a]}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="描边"
        enabled={st.stroke_width > 0}
        onToggle={(on) => patchStyle(on ? { stroke_width: DEFAULT_STROKE.stroke_width } : { stroke_width: 0 })}
        onReset={() => patchStyle({ ...DEFAULT_STROKE })}
      >
        <span>颜色</span>
        <input type="color" className="color" value={hex6(st.stroke_color)} onChange={(e) => patchStyle({ stroke_color: e.target.value.toUpperCase() })} />
        <span>粗细</span>
        <Num value={st.stroke_width} min={0.001} max={0.05} step={0.001} scale={1000} suffix="‰ 高" onChange={(v) => patchStyle({ stroke_width: v })} />
      </Section>

      <Section
        title="发光"
        enabled={!!st.glow}
        onToggle={(on) => patchStyle({ glow: on ? { ...DEFAULT_GLOW } : null })}
        onReset={() => patchStyle({ glow: { ...DEFAULT_GLOW } })}
      >
        {st.glow && (
          <>
            <span>颜色</span>
            <input type="color" className="color" value={hex6(st.glow.color)} onChange={(e) => patchStyle({ glow: { ...st.glow!, color: e.target.value.toUpperCase() + (st.glow?.color.slice(7) || 'CC') } })} />
            <span>强度</span>
            <Num value={st.glow.blur} min={0.002} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ glow: { ...st.glow!, blur: v } })} />
          </>
        )}
      </Section>

      <Section
        title="阴影"
        enabled={!!st.shadow}
        onToggle={(on) => patchStyle({ shadow: on ? { ...DEFAULT_SHADOW } : null })}
        onReset={() => patchStyle({ shadow: { ...DEFAULT_SHADOW } })}
      >
        {st.shadow && (
          <>
            <span>颜色</span>
            <input type="color" className="color" value={hex6(st.shadow.color)} onChange={(e) => patchStyle({ shadow: { ...st.shadow!, color: e.target.value.toUpperCase() + (st.shadow?.color.slice(7) || '99') } })} />
            <span>模糊</span>
            <Num value={st.shadow.blur} min={0} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ shadow: { ...st.shadow!, blur: v } })} />
            <span>偏移 X</span>
            <Num value={st.shadow.offset[0]} min={-0.05} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ shadow: { ...st.shadow!, offset: [v, st.shadow!.offset[1]] } })} />
            <span>偏移 Y</span>
            <Num value={st.shadow.offset[1]} min={-0.05} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ shadow: { ...st.shadow!, offset: [st.shadow!.offset[0], v] } })} />
          </>
        )}
      </Section>

      <Section
        title="背景"
        enabled={!!st.background}
        onToggle={(on) => patchStyle({ background: on ? DEFAULT_BACKGROUND : null })}
        onReset={() => patchStyle({ background: DEFAULT_BACKGROUND, padding: d.padding, background_width: null, background_radius: null })}
      >
        {st.background && (
          <>
            <span>颜色</span>
            <div className="inline">
              <input type="color" className="color" value={st.background.slice(0, 7)} onChange={(e) => patchStyle({ background: e.target.value.toUpperCase() + (st.background?.slice(7) || '99') })} />
              <span className="mono small">{st.background}</span>
            </div>
            <span>内边距</span>
            <Num value={st.padding} min={0} max={0.1} step={0.001} scale={1000} suffix="‰ 高" onChange={(v) => patchStyle({ padding: v })} />
            <span>宽度</span>
            <div className="inline">
              <button className={`chip ${st.background_width == null ? 'active' : ''}`} onClick={() => patchStyle({ background_width: null })}>贴合</button>
              <button className={`chip ${st.background_width != null ? 'active' : ''}`} onClick={() => st.background_width == null && patchStyle({ background_width: 1 })}>通栏</button>
              {st.background_width != null && (
                <Num value={st.background_width} min={0.3} max={1} step={0.01} suffix="% 宽" onChange={(v) => patchStyle({ background_width: Math.max(0.3, Math.min(1, v)) })} />
              )}
            </div>
            <span>圆角</span>
            <div className="inline">
              <Num value={st.background_radius ?? Math.min(st.padding, st.font_size * 0.2)} min={0} max={0.05} step={0.001} scale={1000} suffix="‰ 高" onChange={(v) => patchStyle({ background_radius: Math.max(0, v) })} />
              {st.background_radius != null && (
                <button className="btn ghost sm" onClick={() => patchStyle({ background_radius: null })} title="圆角重新跟随内边距 / 字号">
                  自动
                </button>
              )}
            </div>
          </>
        )}
      </Section>

      <Section title="排版" defaultOpen={false} onReset={() => patchStyle({ letter_spacing: 0, line_height: d.line_height })}>
        <span>字距</span>
        <Num value={st.letter_spacing ?? 0} min={-0.5} max={2} step={0.01} scale={1} suffix="em" onChange={(v) => patchStyle({ letter_spacing: v })} />
        <span>行高</span>
        <Num value={st.line_height} min={0.6} max={3} step={0.05} scale={1} suffix="×" onChange={(v) => patchStyle({ line_height: v })} />
      </Section>
    </>
  );
}

function LayerProps({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  // 文本框里的当前选区（[start, end)，UTF-16 索引），给「选中上色」用
  const [sel, setSel] = useState<[number, number] | null>(null);
  return (
    <div className="section inspector">
      <div className="section-title">属性 · {layerName(layer, assets)}</div>
      {layer.type === 'text' && (
        <>
          <textarea
            className="textarea"
            rows={3}
            value={layer.text}
            placeholder="输入文字"
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
            onSelect={(e) => {
              const t = e.currentTarget;
              setSel(t.selectionStart !== t.selectionEnd ? [t.selectionStart, t.selectionEnd] : null);
            }}
          />
          <PresetTabs layer={layer} />
          <TextSections layer={layer} sel={sel} />
        </>
      )}
      {layer.type === 'sticker' && <StickerMediaSection layer={layer} />}
      <PlacementSection layer={layer} />
      <BlendSection layer={layer} />
      <TimeSection layer={layer} />
      {layer.type === 'text' && <div className="hint">文字在「保存并回传」时按 1080×1920 输出分辨率渲染为透明 PNG（image_url）；宽度默认跟随渲染尺寸。</div>}
    </div>
  );
}

/** 图层名：双击进入编辑，Enter / 失焦提交，Esc 取消；清空则恢复自动名。 */
function LayerNameCell({ layer, editing, onEdit, onDone }: { layer: Layer; editing: boolean; onEdit: () => void; onDone: () => void }) {
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const shown = layerName(layer, assets);
  const [draft, setDraft] = useState(shown);
  // 提交 / 取消只处理一次：Enter 会触发 blur，Esc 卸载时部分浏览器也会补一个 blur
  const settled = useRef(false);
  if (!editing) {
    return (
      <span className="lname" title="双击重命名" onDoubleClick={(e) => { e.stopPropagation(); setDraft(shown); settled.current = false; onEdit(); }}>{shown}</span>
    );
  }
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (save) {
      const v = draft.trim();
      updateLayer(layer.id, { name: v || undefined }, false);
    }
    onDone();
  };
  return (
    <input
      className="input sm lname-input"
      autoFocus
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      }}
    />
  );
}

// ---------------------------------------------------------------- 面板

export function LayersPanel({ onApply, targetCount }: { onApply: () => void; targetCount: number }) {
  const [tab, setTab] = useState<'layers' | 'assets'>('layers');
  const [bucket, setBucket] = useState<AssetBucket>('mine');
  const [q, setQ] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const assets = useEditor((s) => s.assets);
  const selectedId = useEditor((s) => s.selectedLayerId);
  const setSelected = useEditor((s) => s.setSelectedLayer);
  const addLayer = useEditor((s) => s.addLayer);
  const addLayers = useEditor((s) => s.addLayers);
  const setToast = useEditor((s) => s.setToast);
  const postDuration = usePostDuration();
  const srtInputRef = useRef<HTMLInputElement>(null);
  const updateLayer = useEditor((s) => s.updateLayer);
  const removeLayer = useEditor((s) => s.removeLayer);
  const moveLayer = useEditor((s) => s.moveLayer);
  const moveLayerTo = useEditor((s) => s.moveLayerTo);
  const moveLayerToIndex = useEditor((s) => s.moveLayerToIndex);
  const duplicateLayer = useEditor((s) => s.duplicateLayer);
  const layers = spec?.layers ?? [];
  // 图层列表：正在改名的图层 / 正在拖的图层 / 插入位置指示（列表按 z 序倒序显示：before = 视觉上方 = 更靠上层）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const clearDrag = () => { setDragId(null); setDrop(null); };
  const onRowDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const side = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (drop?.id !== id || drop.side !== side) setDrop({ id, side });
  };
  const onRowDrop = (e: DragEvent<HTMLDivElement>, overId: string) => {
    e.preventDefault();
    if (!dragId || !drop) return clearDrag();
    const from = layers.findIndex((l) => l.id === dragId);
    const over = layers.findIndex((l) => l.id === overId);
    if (from < 0 || over < 0) return clearDrag();
    // 视觉上方 = spec.layers 里 over 之后；先把自己拿掉再算最终下标
    let target = drop.side === 'before' ? over + 1 : over;
    if (from < target) target -= 1;
    clearDrag();
    if (target !== from) moveLayerToIndex(dragId, target);
  };
  const selected = layers.find((l) => l.id === selectedId) ?? null;
  const stickers = useMemo(() => filterAssets(assets, { type: 'sticker', bucket, q }), [assets, bucket, q]);

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
    setShowTemplates(false);
    setTab('layers');
    setToast(`已导入 ${layers.length} 条字幕`);
  };
  const addSticker = (assetId: string) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!isAssetReady(asset)) return; // 还在预处理：加进去也渲染不出来
    const l: StickerLayer = { id: newLayerId(), type: 'sticker', asset_id: assetId, anchor: 'top-left', margin: [0.08, 0.12], width: 0.35, rotate: 0, opacity: 1, t: 'all' };
    if (isVideoAsset(asset)) l.playback = 'loop';
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
            <button className="btn" onClick={() => srtInputRef.current?.click()} title="导入本地字幕：把 .srt 文件的每条字幕变成一个带时段的文字图层"><IconText /> 导入字幕</button>
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
              <div className="layer-list" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null); }}>
                {[...layers].reverse().map((l) => (
                  <div
                    key={l.id}
                    className={`layer-item ${l.id === selectedId ? 'selected' : ''} ${l.visible === false ? 'hidden' : ''} ${l.id === dragId ? 'dragging' : ''} ${drop?.id === l.id && l.id !== dragId ? `drop-${drop.side}` : ''}`}
                    onClick={() => setSelected(l.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(l.id)}
                    draggable={editingId !== l.id}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', l.id); // Firefox 不 setData 不会开始拖
                      setDragId(l.id);
                    }}
                    onDragOver={(e) => onRowDragOver(e, l.id)}
                    onDrop={(e) => onRowDrop(e, l.id)}
                    onDragEnd={clearDrag}
                  >
                    <span className="muted">{l.type === 'text' ? <IconText /> : <IconSticker />}</span>
                    <LayerNameCell layer={l} editing={editingId === l.id} onEdit={() => setEditingId(l.id)} onDone={() => setEditingId(null)} />
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
            <button className={`chip ${bucket === 'library' ? 'active' : ''}`} onClick={() => setBucket('library')}>原料库</button>
            <button className={`chip ${bucket === 'mine' ? 'active' : ''}`} onClick={() => setBucket('mine')}>我上传的</button>
          </div>
          <input className="input sm" placeholder="搜索贴纸…" value={q} onChange={(e) => setQ(e.target.value)} />
          {stickers.length === 0 ? (
            <div className="empty small">
              {q
                ? '没有匹配的贴纸。'
                : bucket === 'library'
                  ? '原料库为空 · 把文件放进仓库的 samples/stickers 作为内置示例，正式环境接原料库 API'
                  : '还没有贴纸，去「素材库」上传。'}
            </div>
          ) : (
            <div className="sticker-grid">
              {stickers.map((a) => (
                <AssetCard key={a.id} asset={a} onPick={() => addSticker(a.id)} />
              ))}
            </div>
          )}
          <div className="hint">点击贴纸即添加为图层（宽 35%，左上锚点，边距 8% / 12%，全程显示）。视频贴纸默认循环播放，可在属性里改。</div>
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

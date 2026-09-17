// 文本 / 贴纸 / 字幕三个模块右侧面板共用的部件（HIG-8 从原「图层」面板拆出）：
// 同类图层列表、属性检查器（文字图层带「套用样式」预设分组，遮盖层带「遮盖」分组）、批量应用底栏。
// 属性检查器参考剪映的组织方式：文字内容在最上、位置区带六向对齐、
// 描边 / 阴影 / 背景等做成「勾选启用 + 折叠 + 重置」的分组。

import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { ANCHORS, defaultTextStyle, isVideoAsset, variantDef, type Anchor, type Asset, type EditSpec, type Layer, type MaskBlur, type MaskLayer, type MaskMode, type Playback, type StickerLayer, type TextGlow, type TextLayer, type TextShadow, type TextSpan, type TextStyle, type TextStylePreset } from '../../types';
import { cloneSpec, layerName, layerOutsideDuration, newLayerId, outputFor } from '../../lib/spec';
import { layersOfType, type LayerType } from '../../lib/layerKind';
import { DEFAULT_MASK_COLOR, MASK_BLUR_LABEL, MASK_MODE_LABEL, maskBlurLevel } from '../../lib/mask';
import { alignPlacement, placeLayer, reanchor, round4, type AlignEdge } from '../../lib/layout';
import { layerFollows, overrideDetaches, placementOfBox } from '../../lib/variantLayout';
import { layerAspect } from '../../lib/spec';
import { BUILTIN_FONT_FAMILY, BUILTIN_WEB_FONTS } from '../../lib/fonts';
import { hintFor } from '../../lib/shortcuts';
import { drawTextImage, getCachedText, TEXT_CANVAS } from '../../lib/textImage';
import { clampWrapWidth, WRAP_WIDTH_MAX, WRAP_WIDTH_MIN } from '../../lib/textWrap';
import { setLayerWrapWidth } from '../../lib/localize';
import { adjustSpans, normalizeSpans, setSpanColor } from '../../lib/textSpans';
import { groupPresets } from '../../lib/textGallery';
import { Section } from '../ui/Section';
import { TextAnimationSection } from './TextAnimationSection';
import { ColorPicker } from '../ui/ColorPicker';
import {
  IconAlignBottom, IconAlignLeft, IconAlignRight, IconAlignTop, IconCenterH, IconCenterV, IconCopy, IconDown, IconEye, IconLock, IconMask, IconSticker, IconText, IconTrash, IconUp,
} from '../ui/Icons';
import { Field, Num, Slider } from '../ui/Num';
import { Seg, type SegOption } from '../ui/Seg';

const REF = { W: 1080, H: 1920 };

/** 预设缩略图：小画布渲染「花字」，按 id + 样式缓存 data URL。 */
const thumbCache = new Map<string, string>();
const THUMB_H = 400; // 渲染基准高（px）：字号 0.075 → 30 px，描边 / 阴影按同比例缩放
export function presetThumb(preset: TextStylePreset): string {
  const key = `${preset.id}:${JSON.stringify(preset.style)}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  let url = '';
  try {
    const style: TextStyle = { ...defaultTextStyle(), ...preset.style, font_size: 0.075, align: 'center', background_width: null, wrap_width: null };
    url = drawTextImage('花字', style, THUMB_H).canvas.toDataURL('image/png');
  } catch {
    /* 非浏览器环境 / canvas 不可用 */
  }
  thumbCache.set(key, url);
  return url;
}

/** 颜色输入只接受 #RRGGBB；8 位（含透明度）的取前 7 位显示。 */

const DEFAULT_SHADOW: TextShadow = { color: '#00000099', blur: 0.01, offset: [0.002, 0.004] };
const DEFAULT_GLOW: TextGlow = { color: '#FFD84DCC', blur: 0.012 };
const DEFAULT_STROKE = { stroke_color: '#000000', stroke_width: 0.004 };
const DEFAULT_BACKGROUND = '#00000099';

// ---------------------------------------------------------------- 预设

/** 新建一个居中、全程显示的文字图层（可带初始样式）。 */
export function newTextLayer(style?: Partial<TextStyle>, text = '双击编辑文字'): TextLayer {
  return {
    id: newLayerId(),
    type: 'text',
    text,
    style: { ...defaultTextStyle(), ...(style ?? {}) },
    anchor: 'center',
    margin: [0, 0],
    width: 0.5,
    rotate: 0,
    opacity: 1,
    t: 'all',
  };
}

/**
 * 属性里的「套用样式」分组（HIG-11）：花字 / 气泡缩略图单击即套用到当前文字图层（进历史，可撤销）。
 * 新建带样式的文字在「文字」页双击卡片；「存为预设」保存当前图层的全部文字样式。
 */
function StylePresetSection({ layer }: { layer: TextLayer }) {
  const presets = useEditor((s) => s.textPresets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const savePreset = useEditor((s) => s.saveTextPreset);
  const deletePreset = useEditor((s) => s.deleteTextPreset);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const groups = useMemo(() => groupPresets(presets), [presets]);

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
  const row = (label: string, list: TextStylePreset[]) => (
    <>
      <span className="span2">{label}</span>
      <div className="preset-list span2">
        {list.length === 0 && <span className="muted small">这一组还没有预设。</span>}
        {list.map((p) => {
          const url = presetThumb(p);
          return (
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
          );
        })}
      </div>
    </>
  );

  return (
    <Section title="套用样式" defaultOpen={false} hint="单击套用到当前图层">
      {row('花字', groups.text)}
      {row('气泡', groups.bubble)}
      <div className="span2 inline">
        {naming ? (
          <>
            <input
              className="input sm"
              style={{ flex: 1, minWidth: 0 }}
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
          </>
        ) : (
          <>
            <span className="muted small" style={{ flex: 1 }}>单击套用到当前图层</span>
            <button className="btn ghost sm" onClick={() => setNaming(true)} title="把当前图层的全部文字样式保存为预设">存为预设</button>
          </>
        )}
      </div>
    </Section>
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

/** 位置 / 对齐 / 宽度 / 旋转（三类图层共用；遮盖多一个「高度」、没有旋转）。 */
/** 预览非 9:16 画幅时：这个图层在该画幅上是跟随视频还是已微调，可一键恢复跟随（HIG-29）。 */
function VariantFitRow({ layer }: { layer: Layer }) {
  const previewKey = useEditor((s) => s.previewVariantKey);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId));
  const setLayerOverride = useEditor((s) => s.setLayerOverride);
  if (previewKey === '9x16' || !spec || !video) return null;
  const variant = outputFor(spec, previewKey);
  const label = variantDef(previewKey).label;
  const tuned = overrideDetaches(variant.layer_overrides?.[layer.id]);
  const follows = layerFollows(spec, layer, variant, video.width, video.height);
  return (
    <Field label={label}>
      <span className="small">{tuned ? '已在画布上单独微调' : follows ? '跟随视频画面' : '相对画布'}</span>
        {tuned && (
          <button className="btn ghost sm" onClick={() => setLayerOverride(previewKey, layer.id, null)} title={`清掉 ${label} 上的微调，重新跟随视频画面`}>
            恢复跟随
          </button>
        )}
    </Field>
  );
}

function PlacementSection({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  const previewKey = useEditor((s) => s.previewVariantKey);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const editLayerOnPreview = useEditor((s) => s.editLayerOnPreview);
  const aspect = layerAspect(layer, assets);
  const setAnchor = (a: Anchor) => {
    const p = reanchor(layer, aspect, REF, a);
    updateLayer(layer.id, { anchor: a, margin: [round4(p.margin[0]), round4(p.margin[1])] });
  };
  const align = (edge: AlignEdge) => {
    // 预览非 9:16：对齐只改该画幅（写覆盖）
    const onVariant = editLayerOnPreview(layer.id, ({ box, anchor }) => {
      const { placement, aspect: a, canvas } = placementOfBox(box, anchor, previewKey, spec ? outputFor(spec, previewKey) : undefined);
      const q = alignPlacement(placement, a, canvas, edge);
      return { box: placeLayer(q, a, canvas), anchor: q.anchor };
    });
    if (onVariant) return;
    const p = alignPlacement(layer, aspect, REF, edge);
    updateLayer(layer.id, { anchor: p.anchor, margin: p.margin });
  };
  return (
    <Section title="位置" hint="拖动数值块微调 · 边距按画布比例" bodyClass="stack">
      <VariantFitRow layer={layer} />
      {/* 对齐是动作不是状态：六个按钮都不带激活态 */}
      <div className="segt" role="group" aria-label="对齐">
        {ALIGN_BUTTONS.map((b, i) => (
          <span key={b.edge} style={{ display: 'contents' }}>
            <button type="button" title={b.label} aria-label={b.label} disabled={layer.locked} onClick={() => align(b.edge)}>
              {b.icon}
            </button>
            {i === 2 && <span className="sp" />}
          </span>
        ))}
      </div>
      {previewKey !== '9x16' && <div className="hint">对齐按钮和画布拖动只改 {variantDef(previewKey).label}；下面的锚点 / 边距 / 宽度是 9:16 基准，改了会带动所有跟随的画幅。</div>}
      <div className="g2">
        <div className="anchor-tile">
          <div className="anchor-grid" role="radiogroup" aria-label="锚点">
            {ANCHORS.map((a) => (
              <button key={a} type="button" role="radio" aria-checked={layer.anchor === a} className={layer.anchor === a ? 'active' : ''} title={ANCHOR_TITLES[a]} onClick={() => setAnchor(a)} />
            ))}
          </div>
          <div className="txt">
            <span className="l">锚点</span>
            <span className="v">{ANCHOR_TITLES[layer.anchor]}</span>
          </div>
        </div>
        <div className="stack-2">
          <Num label="边距 X" value={layer.margin[0]} step={0.005} onChange={(v) => updateLayer(layer.id, { margin: [v, layer.margin[1]] })} />
          <Num label="边距 Y" value={layer.margin[1]} step={0.005} onChange={(v) => updateLayer(layer.id, { margin: [layer.margin[0], v] })} />
        </div>
      </div>
      <div className="g2">
        <div className="tile-row">
          <Num label="宽度" value={layer.width} min={0.01} max={2} onChange={(v) => updateLayer(layer.id, (l) => { l.width = v; if (l.type === 'text') l.width_manual = true; })} />
          {layer.type === 'text' && layer.width_manual && (
            <button className="btn ghost sm" onClick={() => updateLayer(layer.id, (l) => { if (l.type === 'text') l.width_manual = false; })} title="宽度重新跟随文字渲染尺寸">
              自动
            </button>
          )}
        </div>
        {layer.type === 'mask' ? (
          <Num label="高度" value={layer.height} min={0.01} max={1} onChange={(v) => updateLayer(layer.id, { height: v })} title="相对画布高" />
        ) : (
          <Num label="旋转" value={layer.rotate} scale={1} step={1} min={-360} max={360} suffix="°" onChange={(v) => updateLayer(layer.id, { rotate: v })} />
        )}
      </div>
    </Section>
  );
}

const MASK_MODES: SegOption<MaskMode>[] = [
  { v: 'blur', label: MASK_MODE_LABEL.blur, title: '把这块画面糊掉，背景纹理还在' },
  { v: 'solid', label: MASK_MODE_LABEL.solid, title: '用一块纯色盖住，配合不透明度' },
];
const MASK_BLURS: SegOption<MaskBlur>[] = ([1, 2, 3] as MaskBlur[]).map((b) => ({ v: b, label: MASK_BLUR_LABEL[b] }));

/** 遮盖层：方式（模糊 / 色块）、颜色、强度。与后端 filtergraph 的 boxblur 档位 / drawbox 一一对应。 */
function MaskSection({ layer }: { layer: MaskLayer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const mode: MaskMode = layer.mode === 'solid' ? 'solid' : 'blur';
  const level = maskBlurLevel(layer);
  return (
    <Section title="遮盖" bodyClass="stack" onReset={() => updateLayer(layer.id, { mode: 'blur', blur: 2, color: DEFAULT_MASK_COLOR })}>
      <Seg label="遮盖方式" options={MASK_MODES} value={mode} onChange={(m) => updateLayer(layer.id, { mode: m })} />
      {mode === 'blur' ? (
        <Field label="强度">
          <Seg label="模糊强度" options={MASK_BLURS} value={level} onChange={(b) => updateLayer(layer.id, { blur: b })} className="inner" />
        </Field>
      ) : (
        <Field label="颜色">
          <ColorPicker label="遮盖颜色" value={layer.color ?? DEFAULT_MASK_COLOR} onChange={(c) => updateLayer(layer.id, { color: c })} />
        </Field>
      )}
    </Section>
  );
}

function BlendSection({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  return (
    <Section title="混合" bodyClass="stack" onReset={() => updateLayer(layer.id, { opacity: 1 })}>
      <Slider label="不透明度" value={layer.opacity} onChange={(v) => updateLayer(layer.id, { opacity: v })} />
    </Section>
  );
}

const TIME_MODES: SegOption<'all' | 'range'>[] = [
  { v: 'all', label: '全程' },
  { v: 'range', label: '区间' },
];

function TimeSection({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const postDuration = usePostDuration();
  return (
    <Section title="时段" bodyClass="stack">
      <Seg label="显示时段" options={TIME_MODES} value={layer.t === 'all' ? 'all' : 'range'} onChange={(m) => updateLayer(layer.id, { t: m === 'all' ? 'all' : [0, Math.min(3, postDuration)] })} />
      {layer.t !== 'all' && (
        <div className="g2">
          <Num label="开始" value={layer.t[0]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => updateLayer(layer.id, { t: [v, Math.max(v + 0.1, (layer.t as [number, number])[1])] })} />
          <Num label="结束" value={layer.t[1]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => updateLayer(layer.id, { t: [Math.min((layer.t as [number, number])[0], v - 0.1), v] })} />
        </div>
      )}
      {layerOutsideDuration(layer, postDuration) && <div className="error-text">该图层的时段起点已超出剪后时长（{postDuration.toFixed(1)}s），成片里不会出现。</div>}
    </Section>
  );
}

/** 视频贴纸短于显示时段时的行为，与后端 filtergraph 的三种 eof_action 一一对应。 */
const PLAYBACK_MODES: SegOption<Playback>[] = [
  { v: 'loop', label: '循环', title: '素材比时段短时，从头循环播放' },
  { v: 'freeze', label: '定格', title: '播完停在最后一帧' },
  { v: 'once', label: '播完消失', title: '播完后该图层不再出现' },
];

const AUDIO_MODES: SegOption<boolean>[] = [
  { v: false, label: '不合成', title: '成片只保留源视频的声音' },
  { v: true, label: '合成', title: '贴纸自带的声音叠加进成片（时段内，跟随播放方式）' },
];

/** 视频贴纸：播放方式 / 音轨。 */
function StickerMediaSection({ layer }: { layer: StickerLayer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  const asset = assets.find((a) => a.id === layer.asset_id);
  if (!isVideoAsset(asset)) return null;
  return (
    <Section title="播放" bodyClass="stack">
      <Seg label="播放" options={PLAYBACK_MODES} value={layer.playback ?? 'loop'} onChange={(mode) => updateLayer(layer.id, { playback: mode })} />
      {asset?.has_audio === true && (
        <Field label="音轨">
          <Seg label="音轨" options={AUDIO_MODES} value={!!layer.mix_audio} onChange={(mix) => updateLayer(layer.id, { mix_audio: mix })} className="inner" />
        </Field>
      )}
    </Section>
  );
}

const TEXT_ALIGNS: SegOption<'left' | 'center' | 'right'>[] = [
  { v: 'left', label: <IconAlignLeft />, title: '左对齐' },
  { v: 'center', label: <IconCenterH />, title: '居中' },
  { v: 'right', label: <IconAlignRight />, title: '右对齐' },
];
/** 自动换行（HIG-51）：开启时默认按画布宽 90% 折行，画布上拖文字框左右边也能调。 */
const WRAP_MODES: SegOption<'off' | 'on'>[] = [
  { v: 'off', label: '不换行' },
  { v: 'on', label: '自动换行' },
];
const DEFAULT_WRAP_WIDTH = 0.9;

/** 框高（HIG-51）：贴合文字，或固定一个最小高度（文字在框内垂直居中）；画布上拖文字框上下边也能调。 */
const BOX_HEIGHT_MODES: SegOption<'fit' | 'fixed'>[] = [
  { v: 'fit', label: '贴合文字' },
  { v: 'fixed', label: '固定高度' },
];

/** 切到「固定高度」时的起始值：当前文字本身的框高（相对画布高），还没渲染过就给 0.2。 */
function currentBoxHeight(layer: TextLayer): number {
  const r = getCachedText(layer);
  if (!r) return 0.2;
  return Math.min(1, Math.max(0.01, round4((r.height - 2 * r.pad) / TEXT_CANVAS.H)));
}

const BG_WIDTH_MODES: SegOption<'fit' | 'full'>[] = [
  { v: 'fit', label: '贴合' },
  { v: 'full', label: '通栏' },
];

/**
 * 文字图层的样式分组（字体 / 描边 / 发光 / 阴影 / 背景 / 排版）。大字报面板（HIG-50）也用这一套：
 * poster 为真时不显示「选中上色」和换行开关——重点词上色在那边有自己的分组，换行宽度跟着滚动框走。
 */
export function TextSections({ layer, sel, poster = false }: { layer: TextLayer; sel: [number, number] | null; poster?: boolean }) {
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
      <Section title="字体" hint={poster ? undefined : '选中一段文字可单独上色'} bodyClass="stack" onReset={() => patchStyle({ font_family: d.font_family, font_weight: d.font_weight, font_size: d.font_size, color: d.color, align: d.align })}>
        <Field label="字体">
          <select className="select sm" value={st.font_family} onChange={(e) => patchStyle({ font_family: e.target.value })} aria-label="字体">
            {BUILTIN_WEB_FONTS.map((f) => (
              <option key={f.family} value={f.family}>{f.family}（{f.label}）</option>
            ))}
            {/* 图层用的是别的字体（旧 spec / 已删的上传字体）：保留为一个选项，免得下拉显示成第一项而实际不是 */}
            {st.font_family !== BUILTIN_FONT_FAMILY && !BUILTIN_WEB_FONTS.some((f) => f.family === st.font_family) && !fonts.some((f) => f.family === st.font_family) && (
              <option value={st.font_family}>{st.font_family}</option>
            )}
            {fonts.map((f) => (
              <option key={f.id} value={f.family}>{f.family}</option>
            ))}
          </select>
        </Field>
        <div className="g2">
          <Field label="字重">
            <select className="select sm" value={st.font_weight} onChange={(e) => patchStyle({ font_weight: Number(e.target.value) })} aria-label="字重">
              {[400, 500, 700, 900].map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </Field>
          <Num label="字号" value={st.font_size} min={0.01} max={0.3} step={0.005} onChange={(v) => patchStyle({ font_size: v })} suffix="% 高" />
        </div>
        <Field label="颜色" title={/^#[0-9a-f]{6}00$/i.test(st.color) ? '透明 · 空心' : undefined}>
          <ColorPicker label="文字颜色" alpha value={st.color} onChange={(c) => patchStyle({ color: c })} />
        </Field>
        {!poster && (
          <>
            <Field label="选中上色">
              <ColorPicker label="选中上色" showHex={false} value={spanColor} onChange={setSpanColorState} />
              <button className="btn sm" disabled={!sel} title={sel ? '给文本框里选中的文字上色' : '先在文本框里选中文字'} onClick={() => sel && patchSpans((sp, len) => setSpanColor(sp, sel[0], sel[1], spanColor, len))}>
                上色
              </button>
              <button className="btn ghost sm" disabled={!sel} title="清除选中文字的颜色" onClick={() => sel && patchSpans((sp, len) => setSpanColor(sp, sel[0], sel[1], null, len))}>
                清除
              </button>
            </Field>
            {spans.length > 0 && (
              <div className="span-chips">
                {spans.map((sp) => (
                  <button key={`${sp.start}-${sp.end}`} className="span-chip" title="点击清除这一段的颜色" onClick={() => patchSpans((cur, len) => setSpanColor(cur, sp.start, sp.end, null, len))}>
                    <i style={{ background: sp.color }} />
                    <span className="stext">{layer.text.slice(sp.start, sp.end).replace(/\n/g, ' ')}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <Seg label="文字对齐" options={TEXT_ALIGNS} value={st.align} onChange={(a) => patchStyle({ align: a })} />
      </Section>

      <Section
        title="描边"
        bodyClass="stack"
        enabled={st.stroke_width > 0}
        onToggle={(on) => patchStyle(on ? { stroke_width: DEFAULT_STROKE.stroke_width } : { stroke_width: 0 })}
        onReset={() => patchStyle({ ...DEFAULT_STROKE })}
      >
        <div className="g2">
          <Field label="颜色">
            <ColorPicker label="描边颜色" alpha showHex={false} value={st.stroke_color} onChange={(c) => patchStyle({ stroke_color: c })} />
          </Field>
          <Num label="粗细" value={st.stroke_width} min={0.001} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ stroke_width: v })} />
        </div>
      </Section>

      <Section
        title="发光"
        bodyClass="stack"
        enabled={!!st.glow}
        onToggle={(on) => patchStyle({ glow: on ? { ...DEFAULT_GLOW } : null })}
        onReset={() => patchStyle({ glow: { ...DEFAULT_GLOW } })}
      >
        {st.glow && (
          <div className="g2">
            <Field label="颜色">
              <ColorPicker label="发光颜色" alpha showHex={false} value={st.glow.color} onChange={(c) => patchStyle({ glow: { ...st.glow!, color: c } })} />
            </Field>
            <Num label="强度" value={st.glow.blur} min={0.002} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ glow: { ...st.glow!, blur: v } })} />
          </div>
        )}
      </Section>

      <Section
        title="阴影"
        bodyClass="stack"
        enabled={!!st.shadow}
        onToggle={(on) => patchStyle({ shadow: on ? { ...DEFAULT_SHADOW } : null })}
        onReset={() => patchStyle({ shadow: { ...DEFAULT_SHADOW } })}
      >
        {st.shadow && (
          <>
            <Field label="颜色">
              <ColorPicker label="阴影颜色" alpha value={st.shadow.color} onChange={(c) => patchStyle({ shadow: { ...st.shadow!, color: c } })} />
            </Field>
            <div className="g3">
              <Num label="模糊" value={st.shadow.blur} min={0} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ shadow: { ...st.shadow!, blur: v } })} />
              <Num label="X" value={st.shadow.offset[0]} min={-0.05} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ shadow: { ...st.shadow!, offset: [v, st.shadow!.offset[1]] } })} />
              <Num label="Y" value={st.shadow.offset[1]} min={-0.05} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ shadow: { ...st.shadow!, offset: [st.shadow!.offset[0], v] } })} />
            </div>
          </>
        )}
      </Section>

      <Section
        title="背景"
        bodyClass="stack"
        enabled={!!st.background}
        onToggle={(on) => patchStyle({ background: on ? DEFAULT_BACKGROUND : null })}
        onReset={() => patchStyle({ background: DEFAULT_BACKGROUND, padding: d.padding, background_width: null, background_radius: null })}
      >
        {st.background && (
          <>
            <Field label="颜色">
              <ColorPicker label="背景颜色" alpha value={st.background} onChange={(c) => patchStyle({ background: c })} />
            </Field>
            <div className="g2">
              <Num label="内边距" value={st.padding} min={0} max={0.1} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ padding: v })} />
              <div className="tile-row">
                <Num label="圆角" value={st.background_radius ?? Math.min(st.padding, st.font_size * 0.2)} min={0} max={0.05} step={0.001} scale={1000} suffix="‰" onChange={(v) => patchStyle({ background_radius: Math.max(0, v) })} />
                {st.background_radius != null && (
                  <button className="btn ghost sm" onClick={() => patchStyle({ background_radius: null })} title="圆角重新跟随内边距 / 字号">
                    自动
                  </button>
                )}
              </div>
            </div>
            <div className="g2">
              <Seg label="背景宽度" options={BG_WIDTH_MODES} value={st.background_width == null ? 'fit' : 'full'} onChange={(m) => patchStyle({ background_width: m === 'fit' ? null : 1 })} />
              {st.background_width != null ? (
                <Num label="宽度" value={st.background_width} min={0.3} max={1} step={0.01} suffix="% 宽" onChange={(v) => patchStyle({ background_width: Math.max(0.3, Math.min(1, v)) })} />
              ) : (
                <span />
              )}
            </div>
          </>
        )}
      </Section>

      <Section title="排版" bodyClass="stack" defaultOpen={false} onReset={() => patchStyle({ letter_spacing: 0, line_height: d.line_height })}>
        <div className="g2">
          <Num label="字距" value={st.letter_spacing ?? 0} min={-0.5} max={2} step={0.01} scale={1} suffix="em" onChange={(v) => patchStyle({ letter_spacing: v })} />
          <Num label="行高" value={st.line_height} min={0.6} max={3} step={0.05} scale={1} suffix="×" onChange={(v) => patchStyle({ line_height: v })} />
        </div>
        {!poster && (
          <div className="g2">
            <Seg label="换行" options={WRAP_MODES} value={st.wrap_width ? 'on' : 'off'} onChange={(m) => updateLayer(layer.id, (l) => { if (l.type === 'text') setLayerWrapWidth(l, m === 'on' ? DEFAULT_WRAP_WIDTH : null); })} />
            {st.wrap_width ? (
              <Num label="换行宽度" value={st.wrap_width} min={WRAP_WIDTH_MIN} max={WRAP_WIDTH_MAX} step={0.01} suffix="% 宽" onChange={(v) => patchStyle({ wrap_width: clampWrapWidth(v) })} />
            ) : (
              <span />
            )}
          </div>
        )}
        {!poster && (
          <div className="g2">
            <Seg label="框高" options={BOX_HEIGHT_MODES} value={st.box_height ? 'fixed' : 'fit'} onChange={(m) => patchStyle({ box_height: m === 'fixed' ? currentBoxHeight(layer) : null })} />
            {st.box_height ? (
              <Num label="高度" value={st.box_height} min={0.01} max={1} step={0.01} suffix="% 高" onChange={(v) => patchStyle({ box_height: Math.max(0.01, Math.min(1, v)) })} />
            ) : (
              <span />
            )}
          </div>
        )}
      </Section>
    </>
  );
}

export function LayerProps({ layer }: { layer: Layer }) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const pushHistorySnapshot = useEditor((s) => s.pushHistorySnapshot);
  const assets = useEditor((s) => s.assets);
  // 文本框里的当前选区（[start, end)，UTF-16 索引），给「选中上色」用
  const [sel, setSel] = useState<[number, number] | null>(null);
  // 文字输入期间逐键写 store 但不记历史；聚焦时抓一份编辑前的 spec，失焦时若文字真的变了才压入历史
  const textEditStart = useRef<{ layerId: string; text: string; spec: EditSpec } | null>(null);
  return (
    <div className="section inspector">
      <div className="insp-head">
        <span className="insp-ico">{layerIcon(layer.type)}</span>
        <span className="insp-who">
          <span className="insp-name">{layerName(layer, assets)}</span>
          <span className="insp-type">{layerSubtitle(layer, assets)}</span>
        </span>
      </div>
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
            onFocus={() => {
              const spec = useEditor.getState().currentSpec();
              textEditStart.current = spec ? { layerId: layer.id, text: layer.text, spec: cloneSpec(spec) } : null;
            }}
            onBlur={() => {
              const start = textEditStart.current;
              textEditStart.current = null;
              if (start && start.layerId === layer.id && start.text !== layer.text) pushHistorySnapshot(start.spec);
            }}
            onSelect={(e) => {
              const t = e.currentTarget;
              setSel(t.selectionStart !== t.selectionEnd ? [t.selectionStart, t.selectionEnd] : null);
            }}
          />
          <StylePresetSection layer={layer} />
          <TextSections layer={layer} sel={sel} />
        </>
      )}
      {layer.type === 'sticker' && <StickerMediaSection layer={layer} />}
      {layer.type === 'mask' && <MaskSection layer={layer} />}
      <PlacementSection layer={layer} />
      <BlendSection layer={layer} />
      {layer.type === 'text' && <TextAnimationSection layer={layer} />}
      <TimeSection layer={layer} />
      {layer.type === 'text' && <div className="hint">文字在导出时按 1080×1920 渲染为透明 PNG（image_url）；宽度默认跟随渲染尺寸。</div>}
      {layer.type === 'mask' && <div className="hint">遮盖只是把这块区域模糊或盖色，不是无痕擦除；画布上的模糊是近似预览，成片以导出为准。遮盖总在字幕之下。</div>}
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

// ---------------------------------------------------------------- 同类图层列表

const LIST_TITLES: Record<LayerType, string> = { text: '文字图层', sticker: '贴纸图层', mask: '遮盖图层' };
const layerIcon = (type: LayerType) => (type === 'text' ? <IconText /> : type === 'mask' ? <IconMask /> : <IconSticker />);

/** 属性头部第二行：图层类型 + 一项最有辨识度的信息（字数 / 素材尺寸 / 遮盖方式）。 */
function layerSubtitle(layer: Layer, assets: Asset[]): string {
  if (layer.type === 'text') {
    const n = Array.from(layer.text.replace(/\s+/g, '')).length;
    return `文字图层 · ${n} 字`;
  }
  if (layer.type === 'mask') return `遮盖图层 · ${MASK_MODE_LABEL[layer.mode]}`;
  const a = assets.find((x) => x.id === layer.asset_id);
  const dims = a?.width && a?.height ? ` · ${a.width}×${a.height}` : '';
  return `${isVideoAsset(a) ? '视频贴纸' : '贴纸图层'}${dims}`;
}

/** 某一类（文字 / 贴纸 / 遮盖）图层的列表：上层在前，拖动 / 上下移只在这一类里换序（lib/layerKind）。 */
export function LayerList({ type, emptyHint }: { type: LayerType; emptyHint: ReactNode }) {
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const selectedId = useEditor((s) => s.selectedLayerId);
  const setSelected = useEditor((s) => s.setSelectedLayer);
  const updateLayer = useEditor((s) => s.updateLayer);
  const removeLayer = useEditor((s) => s.removeLayer);
  const moveLayer = useEditor((s) => s.moveLayer);
  const moveLayerTo = useEditor((s) => s.moveLayerTo);
  const moveLayerToIndex = useEditor((s) => s.moveLayerToIndex);
  const duplicateLayer = useEditor((s) => s.duplicateLayer);
  const layers = useMemo(() => layersOfType(spec?.layers ?? [], type), [spec?.layers, type]);
  // 正在改名的图层 / 正在拖的图层 / 插入位置指示（列表按 z 序倒序显示：before = 视觉上方 = 更靠上层）
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
    // 视觉上方 = 同类里 over 之后；先把自己拿掉再算最终下标
    let target = drop.side === 'before' ? over + 1 : over;
    if (from < target) target -= 1;
    clearDrag();
    if (target !== from) moveLayerToIndex(dragId, target);
  };

  return (
    <div className="section">
      <div className="section-title"><span>{LIST_TITLES[type]}（上层在前）</span><span className="mono muted">{layers.length}</span></div>
      {layers.length === 0 ? (
        <div className="hint">{emptyHint}</div>
      ) : (
        <div className="layer-list" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null); }}>
          {[...layers].reverse().map((l) => (
            <div
              key={l.id}
              className={`layer-item ${l.id === selectedId ? 'selected' : ''} ${l.hidden ? 'hidden' : ''} ${l.id === dragId ? 'dragging' : ''} ${drop?.id === l.id && l.id !== dragId ? `drop-${drop.side}` : ''}`}
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
              <span className="muted">{layerIcon(l.type)}</span>
              <LayerNameCell layer={l} editing={editingId === l.id} onEdit={() => setEditingId(l.id)} onDone={() => setEditingId(null)} />
              <span className="acts" onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost icon" title={l.hidden ? '显示（导出时恢复）' : '隐藏（导出时也不出，不删除）'} aria-label={l.hidden ? '显示' : '隐藏'} aria-pressed={!!l.hidden} onClick={() => updateLayer(l.id, { hidden: !l.hidden })}><IconEye off={!!l.hidden} /></button>
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
  );
}

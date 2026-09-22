// 画面文字本地化（契约 §1 screen_text / §2 origin='screen'，HIG-38）的纯函数：
// 识别块 → 可编辑的文字图层 / 顶替遮盖，按语言整批替换，以及多语言导出「原版」时的清理。
// 不碰 store / DOM，全部可用 vitest 直接测。时间换算走 lib/time.sourceRangeToPost，与译文字幕同一条路。
//
// 为什么不复用 SRT 那条 cuesToTextLayers：它把 anchor 写死 bottom-center、margin 写死 [0, 0.12]、
// 宽度写死 0.8（lib/srt.ts）——那是字幕的形状。画面文字要落回它原来所在的位置，几何完全是另一回事。

import { fontForLang, type SubtitleBandHint } from './localize';
import { sourceRangeToPost, type Range } from './time';
import { wrapLineRanges, wrapTokens } from './textWrap';
import { frameRegion, referenceFrame, type FrameSpec } from './variantLayout';
import { defaultTextStyle, type Anchor, type EditSpec, type Layer, type MaskLayer, type ScreenBlock, type ScreenBlockStyle, type ScreenBox, type ScreenDetect, type ScreenText, type ScreenVersion, type TextLayer, type TextStyle } from '../types';

/** origin 标记：与改语言的 'localize' 并列，各清各的。 */
export const SCREEN_ORIGIN = 'screen' as const;

/** 样式估计低于这个把握时，界面提示「请核对」。 */
export const STYLE_CONFIDENCE_HINT = 0.6;

/** 遮盖顶替原文字时向外留的余量（相对画布），免得反锯齿的边缘露出来。 */
const MASK_PADDING = 0.01;

/** 译文通常比原文长，文字框留一点富余再自动换行。 */
const WIDTH_SLACK = 1.1;

/** 译文放不下时字号最多缩到原字号的这个比例（HIG-86），再放不下就放宽框。 */
export const FIT_MIN_FONT_SCALE = 0.6;

/** 基准画布（与 lib/textImage 的 TEXT_CANVAS 相同）：font_size 相对 H，wrap_width 相对 W。 */
const CANVAS_W = 1080;
const CANVAS_H = 1920;

/** 测一段文字在 fontPx 字号下的宽度（px）。浏览器里用 canvas 实测，测试和缺省用 estimateTextWidth。 */
export type TextMeasure = (text: string, fontPx: number, style: TextStyle) => number;

const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** 粗估：中日韩与全角 1em，空格 0.3em，其余 0.6em（偏宽一点，宁可早缩字号也别在实测时拆词）。 */
export function estimateTextWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) em += WIDE_CHAR.test(ch) ? 1 : ch === ' ' ? 0.3 : 0.6;
  return em * fontPx;
}

/**
 * 源画面在参考画布上的几何：识别出来的框和字号都相对源画面（契约 §1），
 * 画布却是 1080×1920——非 9:16 的源片要先换算到画布里源画面实际所在的区域（HIG-86）。
 */
export interface SourceFrame {
  srcW: number;
  srcH: number;
  frame: FrameSpec;
}

/** 这条视频的源画面在 spec 参考画幅上的几何；源片尺寸未知时 null（按 9:16 原样处理）。 */
export function screenSource(spec: EditSpec, video: { width?: number | null; height?: number | null }): SourceFrame | null {
  const srcW = video.width ?? 0;
  const srcH = video.height ?? 0;
  if (!(srcW > 0 && srcH > 0)) return null;
  return { srcW, srcH, frame: referenceFrame(spec) };
}

/** 源画面归一化框 → 参考画布归一化框；fontScale 把相对源画面高的字号换成相对画布高。无几何信息时原样返回。 */
export function sourceBoxToCanvas(box: ScreenBox, source?: SourceFrame | null): { box: ScreenBox; fontScale: number } {
  if (!source || !(source.srcW > 0 && source.srcH > 0) || !(source.frame.W > 0 && source.frame.H > 0)) return { box, fontScale: 1 };
  const { srcW, srcH, frame } = source;
  const [s, d] = frameRegion(frame, srcW, srcH);
  const scale = d.w / s.w;
  const out = {
    x: (d.x + (box.x * srcW - s.x) * scale) / frame.W,
    y: (d.y + (box.y * srcH - s.y) * scale) / frame.H,
    w: (box.w * srcW * scale) / frame.W,
    h: (box.h * srcH * scale) / frame.H,
  };
  return {
    box: { x: round4(out.x), y: round4(out.y), w: round4(out.w), h: round4(out.h) },
    fontScale: (srcH * scale) / frame.H,
  };
}

/** 文字图层 PNG 左右被内边距和描边占掉的宽度（px，基准画布），与 textImage.wrapTextLines 同一算法。 */
function sidePadPx(style: TextStyle): number {
  return 2 * Math.max(0, style.padding * CANVAS_H) + 2 * Math.max(0, style.stroke_width * CANVAS_H);
}

export interface ScreenTextFit {
  font_size: number;
  wrap_width: number;
}

/**
 * 译文写回原框（HIG-86）：先按原字号在原框宽内折行；行数超过「原文行数 + 1」或有单词被拆开，就逐步缩字号，
 * 最小到 FIT_MIN_FONT_SCALE；还放不下再放宽，最宽到画布宽。wrap_width 在框宽上补回内边距与描边，
 * 文字的可用宽度才等于原框宽——以前直接用框宽，小框扣掉约 54px 后只剩一两个字宽，英文被拆成一字母一行。
 */
export function fitScreenText(text: string, style: TextStyle, boxW: number, lines: number | undefined, measure: TextMeasure = estimateTextWidth): ScreenTextFit {
  const pads = sidePadPx(style);
  const maxInner = Math.max(1, CANVAS_W - pads);
  const target = Math.min(maxInner, Math.max(1, boxW * CANVAS_W * WIDTH_SLACK));
  const maxLines = Math.max(1, Math.round(lines ?? 1)) + 1;
  const paragraphs = text.split('\n');

  const fits = (fontSize: number, inner: number): boolean => {
    const px = Math.max(4, fontSize * CANVAS_H);
    const m = (s: string) => measure(s, px, style);
    let count = 0;
    for (const line of paragraphs) {
      for (const [a, b] of wrapTokens(line)) {
        if (m(line.slice(a, b).trim()) > inner) return false; // 单词会被拆开
      }
      count += wrapLineRanges(line, inner, m).length;
    }
    return count <= maxLines;
  };
  const done = (fontSize: number, inner: number): ScreenTextFit => ({
    font_size: round4(fontSize),
    wrap_width: round4(Math.min(1, (inner + pads) / CANVAS_W)),
  });

  const base = style.font_size;
  for (let k = 0; k <= 8; k++) {
    const f = Math.max(FIT_MIN_FONT_SCALE, 1 - k * 0.05);
    if (fits(base * f, target)) return done(base * f, target);
    if (f === FIT_MIN_FONT_SCALE) break;
  }
  const smallest = base * FIT_MIN_FONT_SCALE;
  let inner = target;
  while (inner < maxInner) {
    inner = Math.min(maxInner, inner * 1.15);
    if (fits(smallest, inner)) break;
  }
  return done(smallest, inner);
}

/** 放宽后的框：按对齐方式保住文字起点（左对齐守左边、右对齐守右边、居中守中心），再收回画布内。 */
function widenedBox(box: ScreenBox, wrapWidth: number, align: TextStyle['align'], style: TextStyle): ScreenBox {
  const padN = sidePadPx(style) / 2 / CANVAS_W;
  let x: number;
  if (align === 'left') x = box.x - padN;
  else if (align === 'right') x = box.x + box.w + padN - wrapWidth;
  else x = box.x + box.w / 2 - wrapWidth / 2;
  x = Math.min(Math.max(0, x), Math.max(0, 1 - wrapWidth));
  return { x, y: box.y, w: wrapWidth, h: box.h };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * 归一化框 → 图层的 anchor + margin + width。
 *
 * 锚点按框中心落在九宫格的哪一格选：贴左边的用左锚点、贴上边的用上锚点，以此类推。
 * 这样在 1:1 / 4:5 等别的画幅里重新排版时，角标仍然贴角、居中的仍然居中——
 * 如果一律用 top-left + 绝对 margin，换画幅就会整体偏移。
 *
 * 垂直方向用 center / bottom 锚点时 margin 按框高估算，而文字图层的真实高度要等烤图之后才知道，
 * 所以这两档是近似；top 锚点是精确的。
 */
export function boxToPlacement(box: ScreenBox, width?: number): { anchor: Anchor; margin: [number, number]; width: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ax: 'left' | 'center' | 'right' = Math.abs(cx - 0.5) < 0.08 ? 'center' : cx < 0.5 ? 'left' : 'right';
  const ay: 'top' | 'center' | 'bottom' = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'center';
  const mx = ax === 'left' ? box.x : ax === 'right' ? 1 - (box.x + box.w) : cx - 0.5;
  const my = ay === 'top' ? box.y : ay === 'bottom' ? 1 - (box.y + box.h) : cy - 0.5;
  const anchor = (ax === 'center' && ay === 'center' ? 'center' : `${ay}-${ax}`) as Anchor;
  return { anchor, margin: [round4(mx), round4(my)], width: round4(width ?? Math.min(1, box.w * WIDTH_SLACK)) };
}

/** 估出来的样式 → 文字图层样式；估不出的字段回落到默认值，字体一律按目标语言选。 */
export function blockTextStyle(style: ScreenBlockStyle | null | undefined, lang: string, box: ScreenBox, fontScale = 1): TextStyle {
  const base = defaultTextStyle();
  const out: TextStyle = {
    ...base,
    font_family: fontForLang(lang),
  };
  // box 与字号都已换算到画布（sourceBoxToCanvas）；估出来的字号和描边相对源画面高，同样乘 fontScale。
  if (style?.font_size) out.font_size = round4(style.font_size * fontScale);
  if (style?.color) out.color = style.color;
  if (style?.stroke_color) {
    out.stroke_color = style.stroke_color;
    out.stroke_width = style.stroke_width != null ? round4(style.stroke_width * fontScale) : base.stroke_width;
  } else if (style?.color) {
    // 估出了主色却没测到描边 = 这段文字本来就没有描边：不要留着默认的黑边，
    // 那会让原本干净的字看起来变脏。
    // 注意不能用 'stroke_color' in style 判断——后端是 pydantic 模型，缺省不 exclude_none，
    // 真实响应里这个键永远存在（值为 null），那样写这个分支在生产里恒真。
    out.stroke_width = 0;
  }
  if (style?.background) out.background = style.background;
  if (style?.align === 'left' || style?.align === 'center' || style?.align === 'right') out.align = style.align;
  if (style?.line_height) out.line_height = style.line_height;
  // 原框宽度内自动换行，补回内边距与描边，文字可用宽度才等于原框宽；用户仍可拖宽（HIG-51）。
  out.wrap_width = round4(Math.min(1, (box.w * CANVAS_W * WIDTH_SLACK + sidePadPx(out)) / CANVAS_W));
  return out;
}

export interface MergedBlock extends ScreenBlock {
  /** 该语言的译文；版本里没有这块时为空串。 */
  translated: string;
}

/** 按 id 把识别块和某语言的译文对上；版本里多出来的 id（块已被删）丢掉。 */
export function mergedBlocks(detect: ScreenDetect | null | undefined, version: ScreenVersion | null | undefined): MergedBlock[] {
  const byId = new Map((version?.texts ?? []).map((t) => [t.id, t.translated]));
  return (detect?.blocks ?? []).map((b) => ({ ...b, translated: byId.get(b.id) ?? '' }));
}

export interface ScreenLayerOptions {
  lang: string;
  /** 当前 trim.remove（源时间轴），块的时段经它换算到剪后时间轴。 */
  remove: Range[];
  /** 剪后总时长；图层终点裁到这里。 */
  postDuration: number;
  newId: () => string;
  /** 上一次套用时这一块被人调过的几何与样式，按 screen_block 接回去。 */
  previous?: Map<string, Pick<TextLayer, 'anchor' | 'margin' | 'width' | 'style'>>;
  /** 源画面在参考画布上的几何（HIG-86）；缺省按源片就是 9:16 处理。 */
  source?: SourceFrame | null;
  /** 折行测宽；浏览器里注入 canvas 实测，缺省粗估。 */
  measure?: TextMeasure;
}

/** 一块画面文字在画布上的位置与样式：换算画幅，放不下时先缩字号再放宽（HIG-86）。 */
export function screenBlockLayout(block: ScreenBlock, text: string, lang: string, opts: Pick<ScreenLayerOptions, 'source' | 'measure'> = {}): { anchor: Anchor; margin: [number, number]; width: number; style: TextStyle } {
  const { box, fontScale } = sourceBoxToCanvas(block.box, opts.source);
  const style = blockTextStyle(block.style, lang, box, fontScale);
  const fit = fitScreenText(text, style, box.w, block.lines, opts.measure);
  style.font_size = fit.font_size;
  style.wrap_width = fit.wrap_width;
  const placed = widenedBox(box, fit.wrap_width, style.align, style);
  const placement = boxToPlacement(placed, fit.wrap_width);
  return { ...placement, style };
}

/**
 * 一块画面文字 → 一个可编辑的文字图层。
 * 译文为空、整块落在删除区里、或这块是会动的文字，都不生成（返回 null）。
 */
export function blockToTextLayer(block: MergedBlock, opts: ScreenLayerOptions): TextLayer | null {
  const text = (block.translated || '').trim();
  if (!text || block.moving || block.enabled === false) return null;
  const window = sourceRangeToPost(block.t, opts.remove);
  if (!window) return null;
  const end = opts.postDuration > 0 ? Math.min(window[1], opts.postDuration) : window[1];
  if (end <= window[0]) return null;

  const kept = opts.previous?.get(block.id);
  const layout = kept ?? screenBlockLayout(block, text, opts.lang, opts);
  const placement = layout;
  const style = layout.style;
  return {
    id: opts.newId(),
    type: 'text',
    text,
    style: { ...style },
    anchor: placement.anchor,
    margin: [placement.margin[0], placement.margin[1]],
    width: placement.width,
    rotate: 0,
    opacity: 1,
    t: [window[0], end],
    origin: SCREEN_ORIGIN,
    lang: opts.lang,
    screen_block: block.id,
    name: `画面文字 ${block.id}`,
  };
}

/**
 * 擦除还没就位时的顶替遮盖：把原文字糊掉，好让译文盖上去时下面不是两层字。
 * 只是模糊 / 色块，不是无痕擦除——真正擦干净要靠无字版（契约 §1）。
 */
export function blockToMaskLayer(block: ScreenBlock, opts: Pick<ScreenLayerOptions, 'remove' | 'postDuration' | 'newId' | 'source'>): MaskLayer | null {
  if (block.moving || block.enabled === false) return null;
  const window = sourceRangeToPost(block.t, opts.remove);
  if (!window) return null;
  const end = opts.postDuration > 0 ? Math.min(window[1], opts.postDuration) : window[1];
  if (end <= window[0]) return null;
  const src = sourceBoxToCanvas(block.box, opts.source).box;
  const box = {
    x: clamp01(src.x - MASK_PADDING),
    y: clamp01(src.y - MASK_PADDING),
    w: clamp01(src.w + MASK_PADDING * 2),
    h: clamp01(src.h + MASK_PADDING * 2),
  };
  const placement = boxToPlacement(box);
  return {
    id: opts.newId(),
    type: 'mask',
    mode: 'blur',
    blur: 2,
    color: '#000000',
    anchor: placement.anchor,
    margin: [placement.margin[0], placement.margin[1]],
    width: round4(box.w),
    height: round4(box.h),
    rotate: 0,
    opacity: 1,
    t: [window[0], end],
    origin: SCREEN_ORIGIN,
    screen_block: block.id,
    name: '画面文字遮盖',
  };
}

/** spec 里由画面文字本地化生成的层（文字 + 遮盖）。 */
export function screenLayers(spec: EditSpec): Layer[] {
  return spec.layers.filter((l) => l.origin === SCREEN_ORIGIN);
}

/**
 * 上一次套用时人调过的几何与样式，按 screen_block 记下来。
 * 换语言、重新套用时接回去——自动估的样式只是起点，人调过的才是准的。
 */
export function screenLayerTemplate(spec: EditSpec): Map<string, Pick<TextLayer, 'anchor' | 'margin' | 'width' | 'style'>> {
  const out = new Map<string, Pick<TextLayer, 'anchor' | 'margin' | 'width' | 'style'>>();
  for (const layer of spec.layers) {
    if (layer.origin !== SCREEN_ORIGIN || layer.type !== 'text' || !layer.screen_block) continue;
    out.set(layer.screen_block, { anchor: layer.anchor, margin: [layer.margin[0], layer.margin[1]], width: layer.width, style: { ...layer.style } });
  }
  return out;
}

/** 无字版是不是真的能用（done、没过期、有文件）。 */
export function cleanReady(screen: ScreenText | null | undefined): boolean {
  const er = screen?.erase;
  return !!er && er.status === 'done' && !er.stale && !!er.clean_url;
}

export interface ScreenApplyContext {
  screen: ScreenText | null | undefined;
  /** 当前视频时长（源时间轴）与 trim。 */
  remove: Range[];
  postDuration: number;
  newLayerId: () => string;
  /** 源画面几何与测宽（HIG-86），见 ScreenLayerOptions。 */
  source?: SourceFrame | null;
  measure?: TextMeasure;
}

/**
 * 把某个语言的画面文字套用到 spec 上（原地修改，一次调用 = 一步历史）：
 * 1. 先删掉所有 origin='screen' 的层——不管哪种语言，同一时间只套一个；
 * 2. 无字版可用就切到它（原文字已经从画面上没了，不需要遮盖）；否则回到原片并生成顶替遮盖；
 * 3. 遮盖插在第一个文字图层之前（契约 §2 层级规则，与后端 apply.py 一致），译文层追加到末尾。
 *
 * 返回警告列表。这个函数只碰 origin='screen' 的层和 source_variant，
 * 改语言那一套（origin='localize'）完全不受影响——两边各清各的。
 */
export function applyScreenTextToSpec(spec: EditSpec, lang: string, ctx: ScreenApplyContext): string[] {
  const warnings: string[] = [];
  const detect = ctx.screen?.detect;
  const version = lang ? ctx.screen?.versions?.[lang] : null;
  const previous = screenLayerTemplate(spec);

  spec.layers = spec.layers.filter((l) => l.origin !== SCREEN_ORIGIN);

  // 多片段拼接时源片是虚拟的，没有对应的无字版——后端会 400 挡下（契约 §2），
  // 所以这里就不能写 clean，否则套用 / 多语言导出会整批保存失败。
  const useClean = cleanReady(ctx.screen) && !spec.sequence;
  spec.source_variant = useClean ? 'clean' : 'original';
  if (cleanReady(ctx.screen) && spec.sequence) warnings.push('这条视频做过多片段拼接，暂不支持无字版源片，已改用原片 + 遮盖');
  else if (ctx.screen?.erase?.stale) warnings.push('识别结果改过之后还没重新擦除，先用遮盖顶替；重擦一次即可换成无字版');

  if (!detect || detect.status !== 'done') {
    if (lang) warnings.push('还没有画面文字识别结果');
    return warnings;
  }

  const blocks = mergedBlocks(detect, version);
  const opts: ScreenLayerOptions = { lang, remove: ctx.remove, postDuration: ctx.postDuration, newId: ctx.newLayerId, previous, source: ctx.source, measure: ctx.measure };

  // 没有无字版时，先把原文字糊掉再叠译文。
  const masks: Layer[] = [];
  if (!useClean) {
    for (const block of blocks) {
      if (!block.translated.trim()) continue; // 没有译文就不盖：盖了只会留下一块糊的原文
      const mask = blockToMaskLayer(block, opts);
      if (mask) masks.push(mask);
    }
  }
  if (masks.length) {
    const firstText = spec.layers.findIndex((l) => l.type === 'text');
    const at = firstText < 0 ? spec.layers.length : firstText;
    spec.layers.splice(at, 0, ...masks);
  }

  const texts: Layer[] = [];
  for (const block of blocks) {
    const layer = blockToTextLayer(block, opts);
    if (layer) texts.push(layer);
  }
  spec.layers.push(...texts);

  if (lang && !texts.length) {
    const translatable = blocks.filter((b) => !b.moving && b.enabled !== false);
    if (!translatable.length) warnings.push('识别到的画面文字都被关掉或标成了会动的文字，没有可写回的内容');
    else warnings.push('这个语言还没有画面文字译文');
  }
  const moving = (detect.blocks ?? []).filter((b) => b.moving).length;
  if (moving) warnings.push(`有 ${moving} 处会动的画面文字不在处理范围内，需要手动处理`);
  return warnings;
}

/**
 * 多语言导出「原版」用：去掉画面文字层并切回原片。
 * 漏了这一步，原版就会是「用了无字版但一个字都没有」的空画面。
 */
export function stripScreenText(spec: EditSpec): void {
  spec.layers = spec.layers.filter((l) => l.origin !== SCREEN_ORIGIN);
  spec.source_variant = 'original';
}

/** 当前 spec 套用的是哪个语言的画面文字；没有任何 origin='screen' 的层时返回 null。 */
export function appliedScreenLang(spec: EditSpec | null | undefined): string | null {
  if (!spec) return null;
  for (const layer of spec.layers) {
    if (layer.origin === SCREEN_ORIGIN && layer.lang) return layer.lang;
  }
  return null;
}

/** 某个状态是不是还在跑（识别 / 擦除 / 翻译共用）。 */
export function screenTextActive(screen: ScreenText | null | undefined): boolean {
  if (!screen) return false;
  const running = (s?: { status?: string } | null) => s?.status === 'queued' || s?.status === 'running';
  return running(screen.detect) || running(screen.erase) || Object.values(screen.versions ?? {}).some(running);
}

/** 识别出来的硬字幕带 → 译文字幕的落点与样式（HIG-38）。没有带、或带的把握太低时返回 null。 */
export function bandHint(screen: ScreenText | null | undefined, lang: string, source?: SourceFrame | null): SubtitleBandHint | null {
  const band = screen?.detect?.subtitle_band;
  if (!band) return null;
  const { box, fontScale } = sourceBoxToCanvas(band.box, source);
  const style = band.style ? blockTextStyle(band.style, lang, box, fontScale) : undefined;
  // 图层宽度跟 PNG 宽（= wrap_width，已补回内边距）一致，文字可用宽度才是带宽 × 1.1。
  const placement = boxToPlacement(box, style?.wrap_width ?? undefined);
  return { anchor: placement.anchor, margin: placement.margin, width: placement.width, style };
}

/** 识别状态的一句话（HIG-86）：排队和识别分开说，识别中带帧数进度——排队久是后台忙，不是识别慢。 */
export function detectStatusText(detect: ScreenText['detect']): string {
  if (!detect) return '未开始';
  if (detect.status === 'queued') return '排队中…（后台有其它任务时会等一会儿）';
  if (detect.status === 'running') {
    const p = detect.progress;
    if (!p) return '准备中…（抽帧）';
    return p.total > 0 ? `识别中 ${p.done}/${p.total} 帧…` : '识别中…';
  }
  if (detect.status === 'failed') return `失败：${detect.error ?? '未知原因'}`;
  if (detect.status === 'done') return '已完成';
  return '未开始';
}

/** 擦除状态的一句话（HIG-86）：运行中带上供应商自己报的状态——卡在供应商排队和我们这边没在查是两回事。 */
export function eraseStatusText(erase: ScreenText['erase']): string {
  if (!erase) return '未开始';
  if (erase.status === 'queued') return '排队中…（识别和翻译做完才会提交）';
  if (erase.status === 'running') return erase.vendor_status ? `擦除中…供应商：${erase.vendor_status}` : '擦除中…';
  if (erase.status === 'failed') return `失败：${erase.error ?? '未知原因'}`;
  if (erase.status === 'done') return '已完成';
  return '未开始';
}

/** 跳过了几帧的提示（HIG-86）；没跳过时为空串。 */
export function skippedFramesText(detect: ScreenText['detect']): string {
  const n = detect?.status === 'done' ? detect.skipped_frames ?? 0 : 0;
  return n > 0 ? `${n} 帧识别失败已跳过，那几帧的文字由前后帧补上；漏了可以重新识别` : '';
}

/** 后端的原因多半已经以「画面文字识别失败」开头，不再重复一遍。 */
function withPrefix(prefix: string, error: string | null | undefined): string {
  const reason = error ?? '未知原因';
  return reason.startsWith(prefix) ? reason : `${prefix}：${reason}`;
}

/** 轮询结束时的一句话提示：先说坏消息，再说好消息。 */
export function screenTextFinishText(screen: ScreenText | null | undefined): string {
  if (!screen) return '画面文字处理结束';
  const detect = screen.detect;
  if (detect?.status === 'failed') return withPrefix('画面文字识别失败', detect.error);
  const failedLang = Object.entries(screen.versions ?? {}).find(([, v]) => v.status === 'failed');
  if (failedLang) return `画面文字翻译失败：${failedLang[1].error ?? '未知原因'}`;
  if (screen.erase?.status === 'failed') return `画面文字擦除失败：${screen.erase.error ?? '未知原因'}`;
  if (screen.erase?.status === 'done') return '无字版已生成，可在「画面文字」里切换原片 / 无字版';
  const count = detect?.blocks?.length ?? 0;
  const band = detect?.subtitle_band ? '，并定位到硬字幕带' : '';
  return count ? `识别到 ${count} 处画面文字${band}` : `没有识别到画面文字${band}`;
}

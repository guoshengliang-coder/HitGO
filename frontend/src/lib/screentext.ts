// 画面文字本地化（契约 §1 screen_text / §2 origin='screen'，HIG-38）的纯函数：
// 识别块 → 可编辑的文字图层 / 顶替遮盖，按语言整批替换，以及多语言导出「原版」时的清理。
// 不碰 store / DOM，全部可用 vitest 直接测。时间换算走 lib/time.sourceRangeToPost，与译文字幕同一条路。
//
// 为什么不复用 SRT 那条 cuesToTextLayers：它把 anchor 写死 bottom-center、margin 写死 [0, 0.12]、
// 宽度写死 0.8（lib/srt.ts）——那是字幕的形状。画面文字要落回它原来所在的位置，几何完全是另一回事。

import { fontForLang, type SubtitleBandHint } from './localize';
import { sourceRangeToPost, type Range } from './time';
import { defaultTextStyle, type Anchor, type EditSpec, type Layer, type MaskLayer, type ScreenBlock, type ScreenBlockStyle, type ScreenBox, type ScreenDetect, type ScreenText, type ScreenVersion, type TextLayer, type TextStyle } from '../types';

/** origin 标记：与改语言的 'localize' 并列，各清各的。 */
export const SCREEN_ORIGIN = 'screen' as const;

/** 样式估计低于这个把握时，界面提示「请核对」。 */
export const STYLE_CONFIDENCE_HINT = 0.6;

/** 遮盖顶替原文字时向外留的余量（相对画布），免得反锯齿的边缘露出来。 */
const MASK_PADDING = 0.01;

/** 译文通常比原文长，文字框留一点富余再自动换行。 */
const WIDTH_SLACK = 1.1;

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
export function boxToPlacement(box: ScreenBox): { anchor: Anchor; margin: [number, number]; width: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ax: 'left' | 'center' | 'right' = Math.abs(cx - 0.5) < 0.08 ? 'center' : cx < 0.5 ? 'left' : 'right';
  const ay: 'top' | 'center' | 'bottom' = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'center';
  const mx = ax === 'left' ? box.x : ax === 'right' ? 1 - (box.x + box.w) : cx - 0.5;
  const my = ay === 'top' ? box.y : ay === 'bottom' ? 1 - (box.y + box.h) : cy - 0.5;
  const anchor = (ax === 'center' && ay === 'center' ? 'center' : `${ay}-${ax}`) as Anchor;
  return { anchor, margin: [round4(mx), round4(my)], width: round4(Math.min(1, box.w * WIDTH_SLACK)) };
}

/** 估出来的样式 → 文字图层样式；估不出的字段回落到默认值，字体一律按目标语言选。 */
export function blockTextStyle(style: ScreenBlockStyle | null | undefined, lang: string, box: ScreenBox): TextStyle {
  const base = defaultTextStyle();
  const out: TextStyle = {
    ...base,
    font_family: fontForLang(lang),
    // 原框宽度内自动换行；用户仍可拖宽（HIG-51）。
    wrap_width: round4(Math.min(1, box.w * WIDTH_SLACK)),
  };
  if (style?.font_size) out.font_size = round4(style.font_size);
  if (style?.color) out.color = style.color;
  if (style?.stroke_color) {
    out.stroke_color = style.stroke_color;
    out.stroke_width = style.stroke_width ?? base.stroke_width;
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
  const placement = kept ?? boxToPlacement(block.box);
  const style = kept?.style ?? blockTextStyle(block.style, opts.lang, block.box);
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
export function blockToMaskLayer(block: ScreenBlock, opts: Pick<ScreenLayerOptions, 'remove' | 'postDuration' | 'newId'>): MaskLayer | null {
  if (block.moving || block.enabled === false) return null;
  const window = sourceRangeToPost(block.t, opts.remove);
  if (!window) return null;
  const end = opts.postDuration > 0 ? Math.min(window[1], opts.postDuration) : window[1];
  if (end <= window[0]) return null;
  const box = {
    x: clamp01(block.box.x - MASK_PADDING),
    y: clamp01(block.box.y - MASK_PADDING),
    w: clamp01(block.box.w + MASK_PADDING * 2),
    h: clamp01(block.box.h + MASK_PADDING * 2),
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
  const opts: ScreenLayerOptions = { lang, remove: ctx.remove, postDuration: ctx.postDuration, newId: ctx.newLayerId, previous };

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
export function bandHint(screen: ScreenText | null | undefined, lang: string): SubtitleBandHint | null {
  const band = screen?.detect?.subtitle_band;
  if (!band) return null;
  const placement = boxToPlacement(band.box);
  const style = band.style ? blockTextStyle(band.style, lang, band.box) : undefined;
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

// 文字图层 → 透明 PNG。
//
// 按契约，worker 不自己排版文字，只叠加前端渲染好的 PNG（image_url / image_size）。
// 渲染基准：默认变体 9:16 的输出画布 1080×1920：
//   字号 px = font_size × 1920，描边 px = stroke_width × 1920，内边距 px = padding × 1920。
// 输出 PNG 为紧贴文字（含内边距与描边溢出）的透明位图；有 background 时先画背景矩形，
// background_width 指定时背景拉到该宽度（相对画布宽，通栏 = 1），background_radius 指定圆角。
// 局部上色（layer.spans）由 textSpans.splitRuns 拆成片段，填充时逐段换色，描边全线同色。
//
// 文字图层的 width 语义：文字图层的宽度跟随其渲染尺寸，即 width = pngWidth / 1080，
// 除非用户手动缩放过（layer.width_manual = true，本地字段，发送时剔除）。
// 编辑器预览也用同一函数产出的 canvas 作为 Konva.Image，保证预览与成片一致。

import type { TextLayer, TextSpan, TextStyle } from '../types';
import { api } from '../api';
import { resolveBackgroundBox, splitRuns, type TextRun } from './textSpans';

export const TEXT_CANVAS = { W: 1080, H: 1920 };

export interface RenderedText {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export function fontString(style: TextStyle, px: number): string {
  const fam = style.font_family.includes(',')
    ? style.font_family
    : `"${style.font_family}", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
  return `${style.font_weight} ${px}px ${fam}`;
}

export async function waitForFont(style: TextStyle, px = 40): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fonts?.load) {
      await document.fonts.load(fontString(style, px), '汉字Aa');
    }
  } catch {
    /* 字体不可用时退回系统字体 */
  }
}

type Ctx2D = CanvasRenderingContext2D & { letterSpacing?: string };

/** 浏览器是否原生支持 ctx.letterSpacing（Chrome 99+ / Safari 17+）。 */
function supportsLetterSpacing(ctx: Ctx2D): boolean {
  return typeof ctx.letterSpacing === 'string';
}

/** 逐字形绘制（不支持 ctx.letterSpacing 时的退路）：按 measureText 累加每个字形的前进宽度。 */
function glyphs(line: string): string[] {
  return Array.from(line);
}

/** 空行画一个空格占位，让行高与测量都成立。 */
function lineRuns(runs: TextRun[]): TextRun[] {
  return runs.some((r) => r.text) ? runs : [{ text: ' ' }];
}

/** 一段文字的前进宽度（含每个字形后的字距，末尾字形后也算，方便片段首尾相接）。 */
function advance(ctx: Ctx2D, text: string, spacingPx: number, native: boolean): number {
  if (!spacingPx || native) return ctx.measureText(text).width;
  let w = 0;
  for (const g of glyphs(text)) w += ctx.measureText(g).width + spacingPx;
  return w;
}

/** 一行文字的宽度（含字距；末尾字形后不计字距）。 */
function measureLine(ctx: Ctx2D, runs: TextRun[], spacingPx: number, native: boolean): number {
  let w = 0;
  for (const r of lineRuns(runs)) w += advance(ctx, r.text, spacingPx, native);
  // 原生实现与逐字形累加都在最后一个字形后加了字距；扣掉让对齐更准
  return Math.max(0, w - spacingPx);
}

function drawLine(ctx: Ctx2D, runs: TextRun[], x: number, y: number, spacingPx: number, native: boolean, mode: 'fill' | 'stroke', baseColor: string) {
  const paint = (t: string, px: number) => (mode === 'fill' ? ctx.fillText(t, px, y) : ctx.strokeText(t, px, y));
  let cx = x;
  for (const r of lineRuns(runs)) {
    if (mode === 'fill') ctx.fillStyle = r.color ?? baseColor;
    if (!spacingPx || native) {
      paint(r.text, cx);
      cx += ctx.measureText(r.text).width;
      continue;
    }
    for (const g of glyphs(r.text)) {
      paint(g, cx);
      cx += ctx.measureText(g).width + spacingPx;
    }
  }
}

/** 同步测量 + 绘制（调用前请先 await waitForFont）。 */
export function drawTextImage(text: string, style: TextStyle, H = TEXT_CANVAS.H, spans?: readonly TextSpan[] | null): RenderedText {
  const canvasW = (H * TEXT_CANVAS.W) / TEXT_CANVAS.H;
  const fontPx = Math.max(4, style.font_size * H);
  const strokePx = Math.max(0, style.stroke_width * H);
  const padPx = Math.max(0, style.padding * H);
  const lineH = fontPx * (style.line_height || 1.2);
  const spacingPx = (style.letter_spacing || 0) * fontPx;
  const shadow = style.shadow ?? null;
  const shadowBlurPx = shadow ? Math.max(0, shadow.blur * H) : 0;
  const shadowDx = shadow ? shadow.offset[0] * H : 0;
  const shadowDy = shadow ? shadow.offset[1] * H : 0;
  // 阴影可能溢出文字框：左右上下各留 blur + |offset|
  const shadowPad = shadow ? Math.ceil(shadowBlurPx + Math.max(Math.abs(shadowDx), Math.abs(shadowDy))) : 0;
  const lines = splitRuns(text || ' ', spans);

  const measure = document.createElement('canvas').getContext('2d')! as Ctx2D;
  measure.font = fontString(style, fontPx);
  const native = supportsLetterSpacing(measure);
  if (native) measure.letterSpacing = `${spacingPx}px`;
  const lineWidths = lines.map((l) => measureLine(measure, l, spacingPx, native));
  const contentW = Math.max(1, ...lineWidths);
  const contentH = lines.length * lineH;

  const { boxW, alignW } = resolveBackgroundBox({ contentW, padPx, strokePx, backgroundWidth: style.background ? style.background_width : null, canvasW });
  const boxH = Math.ceil(contentH + padPx * 2 + strokePx * 2);
  const width = boxW + shadowPad * 2;
  const height = boxH + shadowPad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d')! as Ctx2D;
  ctx.clearRect(0, 0, width, height);
  ctx.font = fontString(style, fontPx);
  if (native) ctx.letterSpacing = `${spacingPx}px`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const ox = shadowPad;
  const oy = shadowPad;
  const left = ox + strokePx + padPx;
  const lineX = (i: number) => {
    const lw = lineWidths[i];
    if (style.align === 'center') return left + (alignW - lw) / 2;
    if (style.align === 'right') return left + alignW - lw;
    return left;
  };
  const lineY = (i: number) => oy + strokePx + padPx + lineH * i + lineH / 2;

  const setShadow = (on: boolean) => {
    if (on && shadow) {
      ctx.shadowColor = shadow.color;
      ctx.shadowBlur = shadowBlurPx;
      ctx.shadowOffsetX = shadowDx;
      ctx.shadowOffsetY = shadowDy;
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
  };

  if (style.background) {
    // 有背景时阴影跟着背景矩形走（文字本身不再单独投影）
    setShadow(true);
    ctx.fillStyle = style.background;
    const r = style.background_radius != null ? Math.max(0, style.background_radius * H) : Math.min(padPx, fontPx * 0.2);
    roundRect(ctx, ox + strokePx, oy + strokePx, boxW - strokePx * 2, boxH - strokePx * 2, r);
    ctx.fill();
    setShadow(false);
  } else if (shadow) {
    // 只画阴影的一遍：用描边 + 填充的轮廓投影，再清掉阴影正常绘制
    setShadow(true);
    ctx.strokeStyle = style.stroke_color;
    ctx.lineWidth = strokePx * 2;
    lines.forEach((line, i) => {
      if (strokePx > 0) drawLine(ctx, line, lineX(i), lineY(i), spacingPx, native, 'stroke', style.color);
      drawLine(ctx, line, lineX(i), lineY(i), spacingPx, native, 'fill', style.color);
    });
    setShadow(false);
  }

  lines.forEach((line, i) => {
    const x = lineX(i);
    const y = lineY(i);
    if (strokePx > 0) {
      ctx.strokeStyle = style.stroke_color;
      ctx.lineWidth = strokePx * 2;
      drawLine(ctx, line, x, y, spacingPx, native, 'stroke', style.color);
    }
    drawLine(ctx, line, x, y, spacingPx, native, 'fill', style.color);
  });

  return { canvas, width: canvas.width, height: canvas.height };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export async function renderTextImage(layer: TextLayer): Promise<RenderedText> {
  await waitForFont(layer.style);
  return drawTextImage(layer.text, layer.style, TEXT_CANVAS.H, layer.spans);
}

/** 渲染并上传 PNG，返回更新后的图层（image_url / image_size / width）。 */
export async function bakeTextLayer(layer: TextLayer): Promise<TextLayer> {
  const rendered = await renderTextImage(layer);
  const blob = await new Promise<Blob>((resolve, reject) =>
    rendered.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'),
  );
  const up = await api.uploadLayerImage(blob);
  const next: TextLayer = {
    ...layer,
    image_url: up.url,
    image_size: [up.width || rendered.width, up.height || rendered.height],
  };
  if (!layer.width_manual || !layer.width) {
    next.width = rendered.width / TEXT_CANVAS.W;
  }
  return next;
}

// ---- 预览缓存：同一文字 + 样式 + 上色只渲染一次 ----
const cache = new Map<string, RenderedText>();
const pending = new Map<string, Promise<RenderedText>>();

export function textCacheKey(layer: TextLayer): string {
  return JSON.stringify([layer.text, layer.style, layer.spans ?? null]);
}

export function getCachedText(layer: TextLayer): RenderedText | undefined {
  return cache.get(textCacheKey(layer));
}

export function ensureTextRendered(layer: TextLayer): Promise<RenderedText> {
  const key = textCacheKey(layer);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const p = pending.get(key);
  if (p) return p;
  const np = renderTextImage(layer).then((r) => {
    cache.set(key, r);
    pending.delete(key);
    if (cache.size > 200) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return r;
  });
  pending.set(key, np);
  return np;
}

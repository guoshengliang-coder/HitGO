// HIG-65：所有图形共用同一张透明画布的绘制逻辑，预览与导出使用同一结果。
import { api } from '../api';
import type { ShapeLayer } from '../types';

const REF_W = 1080;
const REF_H = 1920;

export function shapePixelSize(shape: Pick<ShapeLayer, 'width' | 'height'>): [number, number] {
  return [Math.max(8, Math.round(shape.width * REF_W)), Math.max(8, Math.round(shape.height * REF_H))];
}

function polygon(ctx: CanvasRenderingContext2D, points: [number, number][]) {
  ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.closePath();
}

export function renderShapeCanvas(shape: ShapeLayer): HTMLCanvasElement {
  const [w, h] = shapePixelSize(shape);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const stroke = Math.min(Math.max(0, shape.stroke_width * REF_H), Math.min(w, h) / 3);
  const inset = Math.max(1, stroke / 2 + 1);
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  ctx.save();
  if (shape.flip_x || shape.flip_y) {
    ctx.translate(shape.flip_x ? w : 0, shape.flip_y ? h : 0);
    ctx.scale(shape.flip_x ? -1 : 1, shape.flip_y ? -1 : 1);
  }
  ctx.lineWidth = stroke;
  ctx.strokeStyle = shape.stroke;
  ctx.fillStyle = shape.fill;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (shape.shape === 'rect') {
    const r = Math.min((shape.radius || 0) * Math.min(w, h), (x1 - x0) / 2, (y1 - y0) / 2);
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x1 - r, y0);
    ctx.quadraticCurveTo(x1, y0, x1, y0 + r);
    ctx.lineTo(x1, y1 - r);
    ctx.quadraticCurveTo(x1, y1, x1 - r, y1);
    ctx.lineTo(x0 + r, y1);
    ctx.quadraticCurveTo(x0, y1, x0, y1 - r);
    ctx.lineTo(x0, y0 + r);
    ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
    ctx.closePath();
  } else if (shape.shape === 'ellipse') {
    ctx.ellipse(w / 2, h / 2, Math.max(1, (x1 - x0) / 2), Math.max(1, (y1 - y0) / 2), 0, 0, Math.PI * 2);
  } else if (shape.shape === 'triangle') {
    polygon(ctx, [[w / 2, y0], [x1, y1], [x0, y1]]);
  } else if (shape.shape === 'star') {
    const points: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 5;
      const k = i % 2 ? 0.45 : 1;
      points.push([w / 2 + Math.cos(angle) * (x1 - x0) / 2 * k, h / 2 + Math.sin(angle) * (y1 - y0) / 2 * k]);
    }
    polygon(ctx, points);
  } else {
    const head = shape.shape === 'arrow' ? Math.min(w, h) * 0.25 : 0;
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - head * 0.4, y1 - head * 0.4);
    if (head) {
      ctx.moveTo(x1 - head, y1);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1, y1 - head);
    }
  }
  if (shape.shape !== 'line' && shape.shape !== 'arrow') ctx.fill();
  if (stroke > 0 || shape.shape === 'line' || shape.shape === 'arrow') {
    if (!stroke) ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
  return canvas;
}

export async function bakeShapeLayer(shape: ShapeLayer): Promise<ShapeLayer> {
  const canvas = renderShapeCanvas(shape);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('图形 PNG 生成失败')), 'image/png'));
  const uploaded = await api.uploadLayerImage(blob);
  return { ...shape, image_url: uploaded.url, image_size: [canvas.width, canvas.height] };
}

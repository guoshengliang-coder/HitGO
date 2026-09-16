// 剪辑模块的裁切编辑：按源视频比例显示当前帧，拖动 / 拉角一个锁定当前画幅比例的窗口，写入该画幅 outputs[].crop（HIG-29）。
// 窗口的像素比 = 输出画幅比，所以 worker 端"裁窗口 → cover 居中"那一步不会再裁掉任何东西，所见即所得。

import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage as KStage, Layer as KLayer, Rect, Transformer, Group } from 'react-konva';
import { useEditor } from '../../store/editor';
import { player } from '../../lib/player';
import { isDue, previewIntervalMs } from '../../lib/previewClock';
import { loadImage } from '../../lib/useImage';
import { clampCropRect, cropRectFromPixels, cropRectToPixels, defaultCropRect, describeCrop, type PixelBox } from '../../lib/crop';
import { variantDef } from '../../types';
import { outputFor } from '../../lib/spec';
import { useFitSize } from './Stage';

const ACCENT = '#d9481f';
const MASK = 'rgba(0,0,0,0.55)';
const MIN_PX = 16;

export function CropEditor() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const rectRef = useRef<Konva.Rect>(null);
  const trRef = useRef<Konva.Transformer>(null);

  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const setCrop = useEditor((s) => s.setCrop);
  const setCropEditing = useEditor((s) => s.setCropEditing);

  const previewKey = useEditor((s) => s.previewVariantKey);
  const def = variantDef(previewKey);
  const aspect = def.width / def.height;
  const srcW = video?.width || 16;
  const srcH = video?.height || 9;
  const { W, H } = useFitSize(wrapRef, srcW / srcH);

  const variant = spec ? outputFor(spec, previewKey) : undefined;
  const rect = variant?.crop ?? defaultCropRect(srcW, srcH, aspect);
  const px = cropRectToPixels(rect, W, H);
  // 拖动 / 缩放过程中的实时框（遮罩跟着走），松手后以 store 为准
  const [live, setLive] = useState<PixelBox | null>(null);
  const box = live ?? px;

  // 背景：当前帧（<video> 已就绪）或封面。
  // 由常驻 rAF 驱动，不放进 effect 依赖里跟着每帧重渲染走（HIG-5）。
  const bgInputRef = useRef<{ posterUrl: string; W: number; H: number } | null>(null);
  bgInputRef.current = video ? { posterUrl: video.poster_url ?? '', W, H } : null;

  useEffect(() => {
    const c = bgRef.current;
    if (!c) return;
    let raf = 0;
    let gen = 0;
    let drawing = false;
    let lastDrawn = -Infinity;
    let everDrewLiveFrame = false;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const input = bgInputRef.current;
      if (!input || drawing) return;
      const interval = previewIntervalMs({ playing: player.isPlaying, selected: true, visible: true });
      if (interval === null) return;
      const now = performance.now();
      if (!isDue(now, lastDrawn, interval)) return;

      const ctx = c.getContext('2d');
      if (!ctx) return;
      const v = player.getVideo();
      const liveSrc = v && v.readyState >= 2 ? v : null;
      // 已经画过真实帧后就不再闪回封面
      if (!liveSrc && everDrewLiveFrame) return;

      lastDrawn = now;
      const myGen = ++gen;
      if (liveSrc) {
        ctx.fillStyle = '#0b0d10';
        ctx.fillRect(0, 0, input.W, input.H);
        ctx.drawImage(liveSrc, 0, 0, input.W, input.H);
        everDrewLiveFrame = true;
        return;
      }
      if (!input.posterUrl) {
        ctx.fillStyle = '#0b0d10';
        ctx.fillRect(0, 0, input.W, input.H);
        return;
      }
      drawing = true;
      void loadImage(input.posterUrl)
        .then((img) => {
          if (myGen !== gen) return;
          ctx.fillStyle = '#0b0d10';
          ctx.fillRect(0, 0, input.W, input.H);
          ctx.drawImage(img, 0, 0, input.W, input.H);
        })
        .catch(() => {
          /* 没有封面就留底色 */
        })
        .finally(() => {
          drawing = false;
        });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      gen++;
    };
  }, []);

  // Transformer 绑定到窗口节点
  useEffect(() => {
    const tr = trRef.current;
    const node = rectRef.current;
    if (!tr || !node) return;
    tr.nodes([node]);
    tr.getLayer()?.batchDraw();
  }, [W, H]);

  const readBox = (node: Konva.Rect): PixelBox => ({ x: node.x(), y: node.y(), w: node.width() * node.scaleX(), h: node.height() * node.scaleY() });

  const commit = (node: Konva.Rect) => {
    const b = readBox(node);
    node.scaleX(1);
    node.scaleY(1);
    const next = clampCropRect(cropRectFromPixels(b, W, H), srcW, srcH, aspect);
    // 节点同步到钳制后的位置，避免松手时跳一下
    const p = cropRectToPixels(next, W, H);
    node.position({ x: p.x, y: p.y });
    node.size({ width: p.w, height: p.h });
    setLive(null);
    setCrop(next);
  };

  return (
    <>
      <div className="stage-wrap" ref={wrapRef}>
        <div className="stage-box" style={{ width: W, height: H }}>
          <canvas ref={bgRef} className="crop-bg" width={W} height={H} />
          <div className="konva-layer">
            <KStage width={W} height={H}>
              <KLayer>
                <Group listening={false}>
                  <Rect x={0} y={0} width={W} height={Math.max(0, box.y)} fill={MASK} />
                  <Rect x={0} y={box.y + box.h} width={W} height={Math.max(0, H - box.y - box.h)} fill={MASK} />
                  <Rect x={0} y={box.y} width={Math.max(0, box.x)} height={box.h} fill={MASK} />
                  <Rect x={box.x + box.w} y={box.y} width={Math.max(0, W - box.x - box.w)} height={box.h} fill={MASK} />
                </Group>
                <Rect
                  ref={rectRef}
                  x={px.x}
                  y={px.y}
                  width={px.w}
                  height={px.h}
                  stroke={ACCENT}
                  strokeWidth={1.5}
                  strokeScaleEnabled={false}
                  draggable
                  dragBoundFunc={(pos) => ({ x: Math.min(Math.max(0, pos.x), Math.max(0, W - px.w)), y: Math.min(Math.max(0, pos.y), Math.max(0, H - px.h)) })}
                  onDragMove={(e) => setLive(readBox(e.target as Konva.Rect))}
                  onTransform={(e) => setLive(readBox(e.target as Konva.Rect))}
                  onDragEnd={(e) => commit(e.target as Konva.Rect)}
                  onTransformEnd={(e) => commit(e.target as Konva.Rect)}
                />
                <Transformer
                  ref={trRef}
                  keepRatio
                  rotateEnabled={false}
                  enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
                  anchorSize={8}
                  anchorStroke={ACCENT}
                  anchorFill="#fff"
                  borderStroke={ACCENT}
                  boundBoxFunc={(oldBox, newBox) => {
                    if (newBox.width < MIN_PX || newBox.height < MIN_PX) return oldBox;
                    if (newBox.x < -0.5 || newBox.y < -0.5 || newBox.x + newBox.width > W + 0.5 || newBox.y + newBox.height > H + 0.5) return oldBox;
                    return newBox;
                  }}
                />
              </KLayer>
            </KStage>
          </div>
          <div className="stage-hint">
            {def.label} 裁切范围 · {describeCrop(rect, srcW, srcH)} · 源 {srcW}×{srcH}
          </div>
        </div>
      </div>
      <div className="override-bar crop-bar">
        <span className="muted">拖动 / 拉角调整 {def.label} 成片的裁切窗口（锁定画幅比）；遮罩部分不会出现在成片里。</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setCrop(defaultCropRect(srcW, srcH, aspect))}>
          居中
        </button>
        <button className="btn sm primary" onClick={() => setCropEditing(false)}>
          完成
        </button>
      </div>
    </>
  );
}

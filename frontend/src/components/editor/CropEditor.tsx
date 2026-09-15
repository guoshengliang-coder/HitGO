// 输出步骤的裁切编辑：按源视频比例显示当前帧，拖动 / 拉角一个锁定画幅比的窗口，写入 outputs[].crop。
// 窗口的像素比 = 输出画幅比，所以 worker 端"裁窗口 → cover 居中"那一步不会再裁掉任何东西，所见即所得。

import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage as KStage, Layer as KLayer, Rect, Transformer, Group } from 'react-konva';
import { useEditor, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { loadImage } from '../../lib/useImage';
import { clampCropRect, cropRectFromPixels, cropRectToPixels, defaultCropRect, describeCrop, type PixelBox } from '../../lib/crop';
import { variantDef } from '../../types';
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
  const variantKey = useEditor((s) => s.selectedVariantKey);
  const setCrop = useEditor((s) => s.setCrop);
  const setCropEditing = useEditor((s) => s.setCropEditing);
  const postTime = usePostTime();

  const def = variantDef(variantKey);
  const aspect = def.width / def.height;
  const srcW = video?.width || 16;
  const srcH = video?.height || 9;
  const { W, H } = useFitSize(wrapRef, srcW / srcH);

  const variant = spec?.outputs.find((o) => o.variant_key === variantKey);
  const rect = variant?.crop ?? defaultCropRect(srcW, srcH, aspect);
  const px = cropRectToPixels(rect, W, H);
  // 拖动 / 缩放过程中的实时框（遮罩跟着走），松手后以 store 为准
  const [live, setLive] = useState<PixelBox | null>(null);
  const box = live ?? px;

  // 背景：当前帧（<video> 已就绪）或封面
  useEffect(() => {
    const c = bgRef.current;
    if (!c || !video) return;
    let alive = true;
    const draw = async () => {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, 0, W, H);
      const v = player.getVideo();
      let src: CanvasImageSource | null = v && v.readyState >= 2 ? v : null;
      if (!src && video.poster_url) {
        try {
          src = await loadImage(video.poster_url);
        } catch {
          src = null;
        }
      }
      if (alive && src) ctx.drawImage(src, 0, 0, W, H);
    };
    void draw();
    return () => {
      alive = false;
    };
  }, [video, W, H, postTime]);

  // Transformer 绑定到窗口节点
  useEffect(() => {
    const tr = trRef.current;
    const node = rectRef.current;
    if (!tr || !node) return;
    tr.nodes([node]);
    tr.getLayer()?.batchDraw();
  }, [W, H, variantKey]);

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
    setCrop(variantKey, next);
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
        <span className="muted">拖动 / 拉角调整 {def.label} 变体的裁切窗口（锁定画幅比）；遮罩部分不会出现在成片里。</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setCrop(variantKey, defaultCropRect(srcW, srcH, aspect))}>
          居中
        </button>
        <button className="btn sm primary" onClick={() => setCropEditing(false)}>
          完成
        </button>
      </div>
    </>
  );
}

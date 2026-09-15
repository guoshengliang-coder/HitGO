// 预览舞台：<video>（proxy）在下，react-konva Stage 同尺寸叠在上面，绘制安全区与图层。
// 图层位置全部由 lib/layout.ts 的契约公式计算；拖动 / 缩放 / 旋转后反算回 margin / width / rotate。
// 拖动时吸附到画布边 / 中线 / 安全区边（lib/snap.canvasGuides），按住 ⌘/Ctrl 关闭；命中的参考线画在最上层。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage as KStage, Layer as KLayer, Image as KImage, Line as KLine, Rect, Text as KText, Transformer, Group } from 'react-konva';
import { useEditor, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { marginFromBox, placeLayer, round4 } from '../../lib/layout';
import { layerAspect } from '../../lib/spec';
import { windowContains } from '../../lib/time';
import { canvasGuides, snapValue } from '../../lib/snap';
import { ensureTextRendered, getCachedText, textCacheKey, TEXT_CANVAS } from '../../lib/textImage';
import { useImage } from '../../lib/useImage';
import type { Layer, Rect as ZRect, SafeZone, TextLayer } from '../../types';

const SNAP_PX = 6;
const GUIDE_COLOR = '#d9481f';

type Guides = { xs: number[]; ys: number[] };
const NO_GUIDES: Guides = { xs: [], ys: [] };

function useFitSize(ref: React.RefObject<HTMLDivElement>, aspect: number) {
  const [size, setSize] = useState({ W: 270, H: 480 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cw = el.clientWidth - 24;
      const ch = el.clientHeight - 24;
      if (cw <= 0 || ch <= 0) return;
      let W = ch * aspect;
      let H = ch;
      if (W > cw) {
        W = cw;
        H = cw / aspect;
      }
      setSize({ W: Math.floor(W), H: Math.floor(H) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect]);
  return size;
}

function FrameRect({ r, W, H, label }: { r: ZRect; W: number; H: number; label: string }) {
  return (
    <Group listening={false}>
      <Rect x={r.x * W} y={r.y * H} width={r.w * W} height={r.h * H} stroke="rgba(255,255,255,0.55)" strokeWidth={1} dash={[6, 4]} />
      <KText x={r.x * W + 4} y={r.y * H + 3} text={label} fontSize={10} fontFamily="Noto Sans SC, sans-serif" fill="rgba(255,255,255,0.7)" />
    </Group>
  );
}

/** 安全区框线（frames 模式；overlay 模式无叠层图时也走这里）。 */
function SafeZones({ zone, W, H }: { zone: SafeZone | undefined; W: number; H: number }) {
  if (!zone) return null;
  return (
    <>
      {zone.zones.map((z, i) => (
        <Group key={i} listening={false}>
          <Rect x={z.x * W} y={z.y * H} width={z.w * W} height={z.h * H} fill="rgba(217,72,31,0.18)" stroke="rgba(217,72,31,0.6)" strokeWidth={1} dash={[4, 3]} />
          <KText x={z.x * W + 4} y={z.y * H + 3} text={z.label} fontSize={10} fontFamily="Noto Sans SC, sans-serif" fill="rgba(255,255,255,0.9)" width={Math.max(20, z.w * W - 8)} />
        </Group>
      ))}
      {zone.inner && <FrameRect r={zone.inner} W={W} H={H} label={zone.inner.label || '内安全框'} />}
      {zone.outer && <FrameRect r={zone.outer} W={W} H={H} label={zone.outer.label || '外安全框'} />}
    </>
  );
}

/** 平台 UI 叠层图（overlay 模式且预设带 overlay_url）。 */
function SafeZoneOverlay({ url, W, H }: { url: string; W: number; H: number }) {
  const img = useImage(url);
  if (!img) return null;
  return <KImage image={img} x={0} y={0} width={W} height={H} listening={false} />;
}

/** 单个图层节点。 */
function LayerNode({
  layer,
  W,
  H,
  selectable,
  selected,
  guides,
  onSelect,
  onGuides,
  registerNode,
}: {
  layer: Layer;
  W: number;
  H: number;
  selectable: boolean;
  selected: boolean;
  guides: Guides;
  onSelect: () => void;
  onGuides: (g: Guides) => void;
  registerNode: (node: Konva.Image | null) => void;
}) {
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const stickerUrl = layer.type === 'sticker' ? assets.find((a) => a.id === layer.asset_id)?.url : undefined;
  const stickerImg = useImage(stickerUrl);
  const [, bump] = useState(0);

  // 文字图层：渲染 PNG 预览；未手动设宽时，width 跟随渲染尺寸（pngWidth / 1080）
  // 缓存 key 与 textImage 一致（text + style + spans），任一变化都重新渲染
  const textKey = layer.type === 'text' ? textCacheKey(layer as TextLayer) : '';
  const widthManual = layer.type === 'text' ? !!(layer as TextLayer).width_manual : true;
  useEffect(() => {
    if (layer.type !== 'text') return;
    let alive = true;
    void ensureTextRendered(layer as TextLayer).then((r) => {
      if (!alive) return;
      bump((n) => n + 1);
      const autoW = round4(r.width / TEXT_CANVAS.W);
      if (!widthManual && Math.abs(autoW - layer.width) > 1e-4) updateLayer(layer.id, { width: autoW }, false);
    });
    return () => {
      alive = false;
    };
  }, [textKey, widthManual]); // eslint-disable-line react-hooks/exhaustive-deps

  const image: CanvasImageSource | undefined = layer.type === 'sticker' ? stickerImg : getCachedText(layer as TextLayer)?.canvas;
  if (!image) return null;

  const aspect = layerAspect(layer, assets);
  const box = placeLayer(layer, aspect, { W, H });
  const draggable = selectable && !layer.locked;

  const commitBox = (node: Konva.Image, newW: number, rotate?: number) => {
    const h = newW / aspect;
    const cx = node.x();
    const cy = node.y();
    const nb = { x: cx - newW / 2, y: cy - h / 2, w: newW, h };
    const margin = marginFromBox(nb, layer.anchor, { W, H });
    updateLayer(layer.id, (l) => {
      l.margin = [round4(margin[0]), round4(margin[1])];
      l.width = round4(newW / W);
      if (rotate !== undefined) l.rotate = Math.round(rotate * 10) / 10;
      if (l.type === 'text' && Math.abs(newW - box.w) > 0.5) l.width_manual = true;
    });
  };

  // 拖动中：外接矩形（考虑旋转）的左 / 中 / 右、上 / 中 / 下 吸附到参考线
  const onDragMove = (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target as Konva.Image;
    if (e.evt?.ctrlKey || e.evt?.metaKey) {
      onGuides(NO_GUIDES);
      return;
    }
    const r = node.getClientRect({ skipStroke: true });
    const snapAxis = (edges: number[], lines: number[]) => {
      let best: { d: number; delta: number; hit: number } | null = null;
      for (const v of edges) {
        const s = snapValue(v, lines, SNAP_PX);
        if (s.hit === null) continue;
        const d = Math.abs(s.hit - v);
        if (!best || d < best.d) best = { d, delta: s.hit - v, hit: s.hit };
      }
      return best;
    };
    const sx = snapAxis([r.x, r.x + r.width / 2, r.x + r.width], guides.xs);
    const sy = snapAxis([r.y, r.y + r.height / 2, r.y + r.height], guides.ys);
    if (sx) node.x(node.x() + sx.delta);
    if (sy) node.y(node.y() + sy.delta);
    onGuides({ xs: sx ? [sx.hit] : [], ys: sy ? [sy.hit] : [] });
  };

  return (
    <KImage
      ref={registerNode}
      image={image}
      x={box.x + box.w / 2}
      y={box.y + box.h / 2}
      width={box.w}
      height={box.h}
      offsetX={box.w / 2}
      offsetY={box.h / 2}
      rotation={layer.rotate}
      opacity={layer.opacity}
      draggable={draggable}
      listening={selectable}
      onClick={onSelect}
      onTap={onSelect}
      onDblClick={onSelect}
      onDragStart={onSelect}
      onDragMove={onDragMove}
      onDragEnd={(e) => {
        onGuides(NO_GUIDES);
        commitBox(e.target as Konva.Image, box.w);
      }}
      onTransformEnd={(e) => {
        onGuides(NO_GUIDES);
        const node = e.target as Konva.Image;
        const newW = Math.max(8, node.width() * node.scaleX());
        node.scaleX(1);
        node.scaleY(1);
        commitBox(node, newW, node.rotation());
      }}
      stroke={selected ? GUIDE_COLOR : undefined}
      strokeWidth={selected ? 1 : 0}
      strokeScaleEnabled={false}
    />
  );
}

export function Stage({ hidden }: { hidden?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodes = useRef<Record<string, Konva.Image | null>>({});
  const { W, H } = useFitSize(wrapRef, 9 / 16);

  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const step = useEditor((s) => s.step);
  const zone = useEditor((s) => s.safeZones.find((z) => z.key === s.safeZoneKey));
  const safeZoneView = useEditor((s) => s.safeZoneView);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const setSelectedLayer = useEditor((s) => s.setSelectedLayer);
  const setTime = useEditor((s) => s.setTime);
  const setPlaying = useEditor((s) => s.setPlaying);
  const postTime = usePostTime();
  const [hitGuides, setHitGuides] = useState<Guides>(NO_GUIDES);

  const guides = canvasGuides(zone, W, H);
  const guidesRef = useRef(guides);
  guidesRef.current = guides;

  // 播放器挂载
  useEffect(() => {
    const el = videoRef.current;
    player.attach(el);
    player.duration = video?.duration ?? 0;
    player.seek(0);
    const unsub = player.subscribe((t, playing) => {
      setTime(t);
      setPlaying(playing);
    });
    return () => {
      unsub();
      player.pause();
    };
  }, [video?.id, video?.duration, setTime, setPlaying]);

  useEffect(() => {
    player.remove = spec?.trim.remove ?? [];
  }, [spec?.trim.remove]);

  // Transformer 绑定
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selectedLayerId && step === 2 ? nodes.current[selectedLayerId] : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedLayerId, step, spec, W, H]);

  const onStageMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (e.target === e.target.getStage()) setSelectedLayer(null);
    },
    [setSelectedLayer],
  );

  // 缩放角点吸附到参考线（旋转把手不吸附；按住 ⌘/Ctrl 关闭）
  const anchorDragBoundFunc = useCallback((_oldPos: Konva.Vector2d, newPos: Konva.Vector2d, evt: MouseEvent | TouchEvent | undefined) => {
    const tr = trRef.current;
    if (!tr || tr.getActiveAnchor() === 'rotater') return newPos;
    const me = evt as MouseEvent | undefined;
    if (me?.ctrlKey || me?.metaKey) {
      setHitGuides(NO_GUIDES);
      return newPos;
    }
    const g = guidesRef.current;
    const sx = snapValue(newPos.x, g.xs, SNAP_PX);
    const sy = snapValue(newPos.y, g.ys, SNAP_PX);
    setHitGuides({ xs: sx.hit === null ? [] : [sx.hit], ys: sy.hit === null ? [] : [sy.hit] });
    return { x: sx.value, y: sy.value };
  }, []);

  const layers = spec?.layers ?? [];
  const hasSrc = !!video?.proxy_url;
  const overlayUrl = safeZoneView === 'overlay' ? zone?.overlay_url ?? null : null;
  const showFrames = safeZoneView === 'frames' || (safeZoneView === 'overlay' && !overlayUrl);

  return (
    <div className="stage-wrap" ref={wrapRef} style={hidden ? { display: 'none' } : undefined}>
      <div className="stage-box" style={{ width: W, height: H }}>
        <video ref={videoRef} src={video?.proxy_url || undefined} poster={video?.poster_url} playsInline preload="auto" key={video?.id} />
        <div className="konva-layer">
          <KStage width={W} height={H} onMouseDown={onStageMouseDown} onTouchStart={onStageMouseDown}>
            <KLayer listening={false}>{showFrames && <SafeZones zone={zone} W={W} H={H} />}</KLayer>
            <KLayer>
              {layers.map((l) => {
                if (l.visible === false) return null;
                if (!windowContains(l.t, postTime)) return null;
                return (
                  <LayerNode
                    key={l.id}
                    layer={l}
                    W={W}
                    H={H}
                    selectable={step === 2}
                    selected={selectedLayerId === l.id && step === 2}
                    guides={guides}
                    onSelect={() => setSelectedLayer(l.id)}
                    onGuides={setHitGuides}
                    registerNode={(n) => {
                      nodes.current[l.id] = n;
                    }}
                  />
                );
              })}
              {step === 2 && (
                <Transformer
                  ref={trRef}
                  keepRatio
                  enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
                  rotateEnabled
                  anchorSize={8}
                  anchorStroke={GUIDE_COLOR}
                  anchorFill="#fff"
                  borderStroke={GUIDE_COLOR}
                  rotationSnaps={[0, 90, 180, 270]}
                  boundBoxFunc={(oldBox, newBox) => (newBox.width < 8 || newBox.height < 8 ? oldBox : newBox)}
                  anchorDragBoundFunc={anchorDragBoundFunc}
                />
              )}
            </KLayer>
            <KLayer listening={false}>
              {overlayUrl && <SafeZoneOverlay url={overlayUrl} W={W} H={H} />}
              {hitGuides.xs.map((x) => (
                <KLine key={`x${x}`} points={[x, 0, x, H]} stroke={GUIDE_COLOR} strokeWidth={1} dash={[4, 3]} />
              ))}
              {hitGuides.ys.map((y) => (
                <KLine key={`y${y}`} points={[0, y, W, y]} stroke={GUIDE_COLOR} strokeWidth={1} dash={[4, 3]} />
              ))}
            </KLayer>
          </KStage>
        </div>
        {!hasSrc && <div className="stage-hint">无代理视频（mock 示例）· 使用合成时钟播放</div>}
        {video?.status === 'preparing' && <div className="stage-hint">预处理中…</div>}
      </div>
    </div>
  );
}

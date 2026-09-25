// 预览舞台：<video>（proxy）在下，react-konva Stage 同尺寸叠在上面，绘制安全区与图层。
// 图层位置全部由 lib/layout.ts 的契约公式计算；拖动 / 缩放 / 旋转后反算回 margin / width / rotate。
// 拖动时吸附到画布边 / 中线 / 安全区边（lib/snap.canvasGuides），按住 ⌘/Ctrl 关闭；命中的参考线画在最上层。
// 画布比例跟着「成片画面」页签的预览画幅（HIG-29，缺省 9:16）；源画面比例不同时按该画幅的填充方式（模糊 / 纯色 / 裁切）画底。
// 非 9:16 预览时图层位置由 lib/variantLayout 算（跟随视频或已微调），拖动 / 缩放写回该画幅的 layer_overrides；
// 安全区只在 9:16 显示，内联文字编辑也只在 9:16 上进行。
// 所有当前可见图层都能点选；点中后自动切到该对象的编辑模块。
// 双击文字图层进入内联编辑（InlineTextEditor 叠在 Konva 上），编辑期间隐藏该图层的 Konva 节点和 Transformer。
// 遮盖层（MaskNode）的模糊 / 色块由叠在 <video> 之上、Konva 之下的 MaskPreview div 实时画出，Konva 只画把手；
// 拉伸不锁比例、没有旋转把手。
// 文字图层（HIG-51，对齐剪映）：四角等比缩放；左右边把手改自动换行宽度（style.wrap_width），上下边把手改框高（style.box_height，
// 不小于文字本身，文字在框内垂直居中）。拖边时逐帧同步重画 PNG，字号、字形不变，被拖边的对边不动。
// 有封面（HIG-9）时播放头的封面段（time < 0）由 CoverPreview 盖住正片，图层不显示、贴纸与音轨不出声。
// 把图片 / 视频或贴纸卡片拖到画布上（图片 HIG-46，视频 HIG-67）：以落点为中心加贴纸图层（useCanvasImageDrop）。
// 滚动文字（HIG-50 大字报）：PNG 在裁切框（scroll.box）里按 lib/poster 的曲线向上滚，框外裁掉；不能拖动 / 缩放，
// 选中且暂停时画出框线。成片时长（trim.duration）交给 player 循环补足，播放头的成片时刻从 usePostTime 取（跨遍累加）。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Konva from 'konva';
import { Stage as KStage, Layer as KLayer, Image as KImage, Line as KLine, Rect, Text as KText, Transformer, Group } from 'react-konva';
import { useCoverDuration, useEditor, useInCover, usePostDuration, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { marginFromBox, placeLayer, round4, type LayerBox } from '../../lib/layout';
import { cloneSpec, layerAspect, newLayerId, outputFor } from '../../lib/spec';
import { blurFillFilter } from '../../lib/blurFill';
import { resolveLayerBox } from '../../lib/variantLayout';
import { layerTypesForStep } from '../../lib/steps';
import { windowContains } from '../../lib/time';
import { clipAt, clipWindows, sequenceSourceGain } from '../../lib/sequence';
import { resolveScroll, sampleScrollY, scrollPath } from '../../lib/poster';
import { boxFromTransform, boxToStage } from '../../lib/scrollBoxDrag';
import { canvasGuides, snapActive, snapValue } from '../../lib/snap';
import { ensureTextRendered, getCachedText, renderTextSync, textCacheKey, TEXT_CANVAS, type RenderedText } from '../../lib/textImage';
import { boxHeightFromStage, edgeOfAnchor, keepOppositeEdge, wrapWidthFromStage } from '../../lib/textBoxDrag';
import { setLayerWrapWidth } from '../../lib/localize';
import { clampTextWidth } from '../../lib/textWrap';
import { loadImage, useImage } from '../../lib/useImage';
import { containBox, coverBox, variantFrameBox } from '../../lib/videoBox';
import { coverMediaTime } from '../../lib/cover';
import { useVideo } from '../../lib/useVideo';
import { stickerAudible, stickerFinished, stickerMediaTime, windowRange } from '../../lib/stickerMedia';
import { sourceSegment } from '../../lib/sourceTrim';
import { REST, enterDelay, hasAnimation, sampleAnimation } from '../../lib/textAnimation';
import { CURSOR_TAIL, buildGlyphLayout, paintReveal, revealTiming, unitCount } from '../../lib/textReveal';
import { InlineTextEditor } from './InlineTextEditor';
import { useCanvasImageDrop } from './useCanvasImageDrop';
import { renderShapeCanvas } from '../../lib/shapeImage';
import { sourceGainAt, sourceVolume } from '../../lib/audioTracks';
import { AudioTracks } from './AudioTracks';
import { MaskNode, MaskPreview, maskStageBox, supportsBackdropBlur } from './MaskNode';
import { GUIDE_COLOR, NO_GUIDES, SNAP_PX, snapDraggedNode, type Guides } from './stageSnap';
import { isVideoAsset, outputSize, variantDef, type CropRect, type EditSpec, type Layer, type Rect as ZRect, type SafeZone, type TextLayer, type Video, type VideoTrackClip } from '../../types';
import { resolveVideoTransform, transformFromBox, videoBox, type VideoBox } from '../../lib/videoTransform';
import { videoTrackClipEnd } from '../../lib/videoTracks';

// Transformer 把手：贴纸锁比例只留四角；文字四角锁比例、四条边改换行宽度 / 框高（keepRatio 只作用于四角）；遮盖不锁比例，八向都能拉
/** 指针移开这么多舞台像素才算框选，而不是一次点击（HIG-77，与时间轴同一个阈值）。 */
const MARQUEE_PX = 4;

const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGE_ANCHORS = ['middle-left', 'middle-right'];
const ALL_ANCHORS = [...CORNER_ANCHORS, 'top-center', ...EDGE_ANCHORS, 'bottom-center'];
const TEXT_ANCHORS = ALL_ANCHORS;

/** 预览用的 glyph_layout 按渲染结果 + 单位缓存（渲染结果本身已按文字 / 样式缓存）。 */
const layoutCache = new WeakMap<object, Map<string, ReturnType<typeof buildGlyphLayout>>>();
function cachedLayout(rendered: { lines: Parameters<typeof buildGlyphLayout>[0]; width: number; height: number }, unit: 'char' | 'word') {
  let byUnit = layoutCache.get(rendered);
  if (!byUnit) layoutCache.set(rendered, (byUnit = new Map()));
  if (!byUnit.has(unit)) byUnit.set(unit, buildGlyphLayout(rendered.lines, rendered.width, rendered.height, unit));
  return byUnit.get(unit) ?? null;
}

export function useFitSize(ref: React.RefObject<HTMLDivElement>, aspect: number) {
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

/**
 * 源画面不是 9:16 时的底：模糊 = 当前帧放大模糊做底 + contain 前景由 <video> 画；
 * 纯色 = 变体颜色做底；裁切 = 按 outputs[].crop 从当前帧取窗口再 cover（与 worker 顺序一致，
 * <video> 隐藏）。几何全部走 lib/videoBox，与 worker 同一份说法。每帧重绘（跟随 postTime）。
 */
function FillBackdrop({ fill, color, crop, blurFilter, videoId, posterUrl, W, H, postTime }: { fill: 'blur' | 'color' | 'crop'; color?: string; crop?: CropRect; blurFilter: string; videoId?: string; posterUrl?: string; W: number; H: number; postTime: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // 暂停时 store 的 time 可能不变（换素材前后都是 0），帧就绪要单独触发重画，否则会停在旧素材的帧上（HIG-12）
  const [frame, setFrame] = useState(0);
  useEffect(() => player.onFrame(() => setFrame((n) => n + 1)), []);
  useEffect(() => {
    const c = ref.current;
    if (!c || fill === 'color') return;
    let alive = true;
    const draw = (src: CanvasImageSource, sw: number, sh: number) => {
      if (!alive) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const cw = c.width;
      const ch = c.height;
      ctx.clearRect(0, 0, cw, ch);
      if (fill === 'blur') {
        const bg = coverBox(sw, sh, cw, ch, 1.05);
        ctx.save();
        ctx.filter = blurFilter;
        ctx.drawImage(src, bg.x, bg.y, bg.w, bg.h);
        ctx.restore();
      } else {
        const { src: sBox, dst } = variantFrameBox('crop', crop, sw, sh, cw, ch);
        if (sBox) ctx.drawImage(src, sBox.x, sBox.y, sBox.w, sBox.h, dst.x, dst.y, dst.w, dst.h);
        else ctx.drawImage(src, dst.x, dst.y, dst.w, dst.h);
      }
    };
    const v = player.getVideo();
    if (v && v.readyState >= 2 && v.videoWidth) draw(v, v.videoWidth, v.videoHeight);
    else if (posterUrl) void loadImage(posterUrl).then((img) => draw(img, img.naturalWidth, img.naturalHeight)).catch(() => undefined);
    else c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    return () => {
      alive = false;
    };
  }, [fill, crop, blurFilter, videoId, posterUrl, W, H, postTime, frame]);
  if (fill === 'color') return <div className="stage-fill" style={{ background: color ?? '#000000' }} />;
  // 模糊底图半分辨率即可；裁切是前景，按画布尺寸画
  const scale = fill === 'blur' ? 0.5 : 1;
  return <canvas ref={ref} className="stage-fill" width={Math.max(1, Math.round(W * scale))} height={Math.max(1, Math.round(H * scale))} />;
}

/**
 * 封面段（HIG-9，播放头在 [-N, 0)）：盖住正片，按输出的 fill 把封面铺满画布，和 worker 一致——
 * 模糊 = 放大模糊做底 + contain；纯色 = 颜色做底 + contain；裁切 = cover 居中（源画面的裁切窗口不作用于封面）。
 * 视频封面用浏览器可播的预览代理，对齐到 time + N，只在播放中出声（封面原声）。
 */
function CoverPreview({ fill, color, blurFilter, W, H }: { fill: 'blur' | 'color' | 'crop'; color?: string; blurFilter: string; W: number; H: number }) {
  const asset = useEditor((s) => {
    const cover = s.currentVideoId ? s.specs[s.currentVideoId]?.cover : null;
    return cover ? s.assets.find((a) => a.id === cover.asset_id) : undefined;
  });
  const active = useInCover();
  const isVideo = isVideoAsset(asset);
  const img = useImage(asset && !isVideo ? asset.url : undefined);
  const { video, ready } = useVideo(asset && isVideo ? asset.preview_url ?? asset.url : undefined);
  const poster = useImage(asset && isVideo && !ready ? asset.poster_url : undefined);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!video) return;
    const sync = (t: number, playing: boolean) => {
      const at = coverMediaTime(t, player.preroll);
      if (at === null || !playing) {
        video.muted = true;
        if (!video.paused) video.pause();
        if (at !== null && Math.abs(video.currentTime - at) > 0.01) video.currentTime = at;
        return;
      }
      video.muted = false;
      if (video.playbackRate !== player.mediaRate) video.playbackRate = player.mediaRate;
      if (Math.abs(video.currentTime - at) > 0.25 * player.mediaRate) video.currentTime = at;
      if (video.paused) void video.play().catch(() => undefined);
    };
    sync(player.currentTime, player.mediaRate > 0);
    const unsub = player.subscribe((t) => sync(t, player.mediaRate > 0));
    return () => {
      unsub();
      video.pause();
      video.muted = true;
    };
  }, [video]);

  // 每次渲染都重画：播放中 time 每帧变化，暂停时 useVideo / useImage 在帧或图片就绪后会触发重渲染
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const cw = c.width;
    const ch = c.height;
    let src: CanvasImageSource | undefined;
    let sw = 0;
    let sh = 0;
    if (isVideo && ready && video && video.videoWidth) [src, sw, sh] = [video, video.videoWidth, video.videoHeight];
    else if (isVideo && poster) [src, sw, sh] = [poster, poster.naturalWidth, poster.naturalHeight];
    else if (!isVideo && img) [src, sw, sh] = [img, img.naturalWidth, img.naturalHeight];
    ctx.fillStyle = fill === 'color' ? color ?? '#000000' : '#000000';
    ctx.fillRect(0, 0, cw, ch);
    if (!src || !sw || !sh) return;
    if (fill === 'crop') {
      const b = coverBox(sw, sh, cw, ch);
      ctx.drawImage(src, b.x, b.y, b.w, b.h);
      return;
    }
    if (fill === 'blur') {
      const bg = coverBox(sw, sh, cw, ch, 1.05);
      ctx.save();
      ctx.filter = blurFilter;
      ctx.drawImage(src, bg.x, bg.y, bg.w, bg.h);
      ctx.restore();
    }
    const fg = containBox(sw, sh, cw, ch);
    ctx.drawImage(src, fg.x, fg.y, fg.w, fg.h);
  });

  if (!active || !asset) return null;
  return <canvas ref={ref} className="stage-fill" width={Math.max(1, Math.round(W))} height={Math.max(1, Math.round(H))} />;
}

type StageGeom = { box: LayerBox; rotate: number; opacity: number };

/** 单个图层节点。 */
function LayerNode({
  layer,
  W,
  H,
  selectable,
  selected,
  hidden,
  guides,
  onSelect,
  onEdit,
  onGuides,
  registerNode,
  geom,
  onCommitVariant,
  onGroupMove,
  activeAnchor,
}: {
  layer: Layer;
  W: number;
  H: number;
  selectable: boolean;
  selected: boolean;
  /** 内联编辑中：节点不画（textarea 叠在原位），避免旧 PNG 和输入框重影 */
  hidden: boolean;
  guides: Guides;
  onSelect: () => void;
  onEdit: () => void;
  onGuides: (g: Guides) => void;
  /** 交给 Transformer 的节点：贴纸 / 文字是图片节点，大字报是它的裁切框（HIG-75）。 */
  registerNode: (node: Konva.Image | Konva.Rect | null) => void;
  /** 预览非 9:16 画幅时由 Stage 算好的舞台框 / 旋转 / 不透明度（HIG-29）。 */
  geom?: StageGeom;
  /** 预览非 9:16 画幅时松手写回该画幅的覆盖。 */
  onCommitVariant?: (box: LayerBox, rotate?: number, history?: boolean) => void;
  onGroupMove?: (dx: number, dy: number) => void;
  /** 正在拖的 Transformer 把手名（middle-left 等），没有时 null。 */
  activeAnchor: () => string | null;
}) {
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const syncPosterLayer = useEditor((s) => s.syncPosterLayer);
  const setScroll = useEditor((s) => s.setScroll);
  const pushHistorySnapshot = useEditor((s) => s.pushHistorySnapshot);
  const postDuration = usePostDuration();
  const postTime = usePostTime();
  const playing = useEditor((s) => s.playing);
  const sticker = layer.type === 'sticker' ? assets.find((a) => a.id === layer.asset_id) : undefined;
  const stickerIsVideo = isVideoAsset(sticker);
  // 静态图走 useImage；视频贴纸优先用浏览器可播的预览代理（MOV/ProRes 直接放会是空白）
  const stickerImg = useImage(stickerIsVideo ? undefined : sticker?.url);
  const { video: stickerVideo, ready: videoReady } = useVideo(
    stickerIsVideo ? sticker?.preview_url ?? sticker?.url : undefined,
  );
  // 视频还没就绪时先画首帧，避免画布上突然空一块
  const stickerPoster = useImage(stickerIsVideo && !videoReady ? sticker?.poster_url : undefined);
  const shapeCanvas = useMemo(() => layer.type === 'shape' ? renderShapeCanvas(layer) : undefined, [layer]);
  const [, bump] = useState(0);
  // 逐字显现（HIG-45）的合成画布：每帧按遮罩把文字 PNG 画进来，复用同一块
  const revealCanvas = useRef<HTMLCanvasElement | null>(null);

  // 把贴纸视频的播放位置对齐到播放头。播放中的每帧重绘由 player 的 rAF → setTime →
  // React 重渲染带出来；这里补的是暂停 / 拖进度条后 seek 完成的那一次重绘。
  useEffect(() => {
    if (!stickerVideo || layer.type !== 'sticker') return;
    const playback = layer.playback ?? 'loop';
    const mediaDuration = sticker?.duration ?? stickerVideo.duration ?? 0;
    // 素材内裁剪（HIG-67）：预览只播 [source_in, source_out)，和成片同一段
    const segment = sourceSegment(layer, mediaDuration);
    const sync = (postTime: number, playing: boolean) => {
      const at = stickerMediaTime(postTime, layer.t, postDuration, mediaDuration, playback, segment);
      // 贴纸音轨（mix_audio）：和成片同一套规则决定此刻出不出声；元素默认静音
      stickerVideo.muted = !stickerAudible({
        postTime, t: layer.t, postDuration, mediaDuration, playback, playing,
        mixAudio: layer.mix_audio, hasAudio: sticker?.has_audio, segment,
      });
      if (at === null) {
        if (!stickerVideo.paused) stickerVideo.pause();
        return;
      }
      if (playing && stickerFinished(postTime, layer.t, postDuration, mediaDuration, playback, segment)) {
        // freeze 定格中：再 play() 浏览器会从头重播（画面闪、声音重来），停在最后一帧即可
        if (!stickerVideo.paused) stickerVideo.pause();
        if (Math.abs(stickerVideo.currentTime - at) > 0.01) stickerVideo.currentTime = at;
      } else if (playing) {
        // 播放中只在明显漂移时纠正，否则每帧 seek 会让画面抖
        if (stickerVideo.playbackRate !== player.mediaRate) stickerVideo.playbackRate = player.mediaRate;
        // 越过出点要马上拉回：0.25s 的漂移容差会让裁掉的内容露出来
        const overran = segment.trimmed && stickerVideo.currentTime > segment.end + 0.02;
        if (overran || Math.abs(stickerVideo.currentTime - at) > 0.25 * player.mediaRate) stickerVideo.currentTime = at;
        if (stickerVideo.paused) void stickerVideo.play().catch(() => undefined);
      } else {
        if (!stickerVideo.paused) stickerVideo.pause();
        if (Math.abs(stickerVideo.currentTime - at) > 0.01) stickerVideo.currentTime = at;
      }
    };
    // 封面段（t < 0）里图层不出现：按暂停对齐，不播也不出声。成片时刻跨遍累加（HIG-50）
    sync(player.postTime, player.mediaRate > 0 && player.currentTime >= 0);
    const unsub = player.subscribe((t) => sync(player.postTime, player.mediaRate > 0 && t >= 0));
    return () => {
      unsub();
      stickerVideo.pause();
      stickerVideo.muted = true;
    };
  }, [stickerVideo, sticker?.duration, sticker?.has_audio, layer, postDuration]);

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
      // 滚动文案（HIG-50）：PNG 高度变了（改字号 / 折行）成片时长也要跟着变
      if ((layer as TextLayer).scroll) void syncPosterLayer(layer.id);
    });
    return () => {
      alive = false;
    };
  }, [textKey, widthManual]); // eslint-disable-line react-hooks/exhaustive-deps



  // 改了文字 / 样式、新 PNG 还没渲染好时先沿用上一张：拖边改换行宽度时节点不会中途消失
  const lastText = useRef<RenderedText | undefined>(undefined);
  const textRendered = layer.type === 'text' ? getCachedText(layer as TextLayer) : undefined;
  if (textRendered) lastText.current = textRendered;
  let image: CanvasImageSource | undefined;
  if (layer.type === 'shape') image = shapeCanvas;
  else if (layer.type !== 'sticker') image = lastText.current?.canvas;
  else if (!stickerIsVideo) image = stickerImg;
  else image = videoReady ? stickerVideo : stickerPoster;
  // 拖边改换行宽度 / 框高：开始时的 spec 快照（松手时压一条历史）、舞台像素 / PNG 像素的比例、拖的轴和方向、
  // 开始时该轴的长度、按拖到的尺寸改好的图层草稿（没拖动时为 null）、节流用的 rAF
  const edge = useRef<{ snapshot: EditSpec | null; ratio: number; axis: 'x' | 'y'; side: 1 | -1; startLen: number; draft: TextLayer | null; raf: number } | null>(null);
  if (!image) return null;

  const aspect = layer.type === 'text' && lastText.current ? lastText.current.width / lastText.current.height : layerAspect(layer, assets);
  if (layer.type === 'text' && layer.scroll) {
    // 滚动文字：与 lib/poster / 后端同一套几何——PNG 宽 = min(width, box.w) × W，水平居中于框，
    // 窗口顶边 y（相对画布高）从 y0 走到 y1，PNG 顶边 = 框底边 − y
    const sc = resolveScroll(layer.scroll);
    const bx = { x: sc.box.x * W, y: sc.box.y * H, w: sc.box.w * W, h: sc.box.h * H };
    const imgW = Math.min(layer.width > 0 ? layer.width : sc.box.w, sc.box.w) * W;
    const imgH = imgW / aspect;
    const [a] = windowRange(layer.t, postDuration);
    const y = sampleScrollY(scrollPath(sc, imgH / H), postTime - a);
    const boxDraggable = selectable && !layer.locked;
    const commitBox = (node: Konva.Rect) => {
      const next = boxFromTransform(node, { w: W, h: H });
      node.scaleX(1);
      node.scaleY(1);
      // 夹过之后的框可能和拖到的位置不完全一样（贴边、最小尺寸），把节点摆回真正生效的位置
      node.setAttrs(boxToStage(next, { w: W, h: H }));
      setScroll(layer.id, { box: next });
    };
    return (
      <>
        <Group clipX={bx.x} clipY={bx.y} clipWidth={bx.w} clipHeight={bx.h} visible={!hidden}>
          <KImage
            image={image}
            x={bx.x + (bx.w - imgW) / 2}
            y={bx.y + bx.h - y * H}
            width={imgW}
            height={imgH}
            opacity={geom?.opacity ?? layer.opacity}
            listening={selectable}
            onClick={onSelect}
            onTap={onSelect}
          />
        </Group>
        {/* 裁切框本身可拖可缩放（HIG-75）：以前只是一条只读虚线，框只能靠右栏四个数字改 */}
        {!hidden && (
          <Rect
            ref={(n) => registerNode(n)}
            x={bx.x}
            y={bx.y}
            width={bx.w}
            height={bx.h}
            stroke={GUIDE_COLOR}
            strokeWidth={1}
            dash={[4, 3]}
            // 透明填充才拖得动：没有 fill 的 Rect 只有描边能命中
            fill="rgba(0,0,0,0.001)"
            visible={selected && !playing}
            listening={boxDraggable && selected && !playing}
            draggable={boxDraggable}
            onDragEnd={(e) => commitBox(e.target as Konva.Rect)}
            onTransformEnd={(e) => commitBox(e.target as Konva.Rect)}
          />
        )}
      </>
    );
  }
  const box = geom?.box ?? placeLayer(layer, aspect, { W, H });
  const draggable = selectable && !layer.locked;
  // 文字动画（HIG-40）：按成片同一套曲线采样，只叠加在显示上。选中且暂停时显示静止状态，
  // 否则停在入场开头（透明）时既看不见也没法调；拖动 / 变换写回时把动画偏移扣掉。
  const animation = layer.type === 'text' ? (layer as TextLayer).animation : undefined;
  let anim = REST;
  let revealKey: number | undefined;
  if (hasAnimation(animation) && !(selected && !playing)) {
    const [a, b] = windowRange(layer.t, postDuration);
    anim = sampleAnimation(animation, postTime - a, b - a);
    const rendered = animation.reveal ? getCachedText(layer as TextLayer) : undefined;
    if (animation.reveal && rendered) {
      // 逐字显现：字位置与导出时 bakeTextLayer 写进 glyph_layout 的同一份
      const layout = cachedLayout(rendered, animation.reveal.unit ?? 'char');
      const u = postTime - a;
      const delay = enterDelay(animation, b - a);
      const timing = layout ? revealTiming(animation.reveal, unitCount(layout), b - a, delay) : null;
      if (layout && timing && u < timing.end + CURSOR_TAIL) {
        const canvas = (revealCanvas.current ??= document.createElement('canvas'));
        if (canvas.width !== rendered.width || canvas.height !== rendered.height) {
          canvas.width = rendered.width;
          canvas.height = rendered.height;
        }
        const color = (layer as TextLayer).style.color || '#FFFFFF';
        paintReveal(canvas.getContext('2d')!, rendered.canvas, rendered.background, layout, animation.reveal, b - a, delay, u, rendered.width, rendered.height, color.slice(0, 7));
        image = canvas;
        revealKey = Math.round(u * 1000); // 同一块画布内容变了：换个属性值让 Konva 重画
      }
    }
  }
  const onDblClick = () => {
    onSelect();
    if (layer.type === 'text' && selectable && !layer.locked) onEdit();
  };

  const commitBox = (node: Konva.Image, newW: number, rotate?: number, newH?: number) => {
    const h = newH ?? newW / aspect;
    const cx = node.x() - anim.dx * H;
    const cy = node.y() - anim.dy * H;
    const nb = { x: cx - newW / 2, y: cy - h / 2, w: newW, h };
    if (onCommitVariant) {
      onCommitVariant(nb, rotate);
      return;
    }
    const margin = marginFromBox(nb, layer.anchor, { W, H });
    const m: [number, number] = [round4(margin[0]), round4(margin[1])];
    const w = layer.type === 'text' ? clampTextWidth(newW / W) : round4(newW / W);
    const r = rotate !== undefined ? Math.round(rotate * 10) / 10 : undefined;
    updateLayer(layer.id, (l) => {
      l.margin = m;
      l.width = w;
      if (l.type === 'shape') l.height = round4(h / H);
      if (r !== undefined) l.rotate = r;
      if (l.type === 'text' && Math.abs(newW - box.w) > 0.5) l.width_manual = true;
    });
  };

  // 边把手（文字）：写回拖动中算好的草稿（换行宽度 / 框高，旧译文字幕并回的文字），框按节点当前尺寸反算位置
  const applyEdge = (node: Konva.Image, history: boolean) => {
    const e = edge.current;
    // 只点了一下把手没拖：不写 spec、不记历史
    if (!e || !e.draft) return;
    const draft = e.draft;
    const newW = node.width();
    const newH = node.height();
    const cx = node.x() - anim.dx * H;
    const cy = node.y() - anim.dy * H;
    const nb = { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
    updateLayer(
      layer.id,
      (l) => {
        if (l.type !== 'text') return;
        l.text = draft.text;
        if (draft.spans) l.spans = draft.spans;
        else delete l.spans;
        l.style = draft.style;
        if (onCommitVariant) return;
        const m = marginFromBox(nb, l.anchor, { W, H });
        l.margin = [round4(m[0]), round4(m[1])];
        l.width = clampTextWidth(newW / W);
      },
      false,
    );
    onCommitVariant?.(nb, undefined, false);
    if (history && e.snapshot) pushHistorySnapshot(e.snapshot);
  };

  // 拖动中：外接矩形（考虑旋转）的左 / 中 / 右、上 / 中 / 下 吸附到参考线（stageSnap，与遮盖共用）
  const onDragMove = (e: Konva.KonvaEventObject<DragEvent>) => snapDraggedNode(e.target, e.evt, guides, onGuides);

  return (
    <KImage
      ref={registerNode}
      image={image}
      x={box.x + box.w / 2 + anim.dx * H}
      y={box.y + box.h / 2 + anim.dy * H}
      width={box.w}
      height={box.h}
      offsetX={box.w / 2}
      offsetY={box.h / 2}
      scaleX={anim.scale}
      scaleY={anim.scale}
      rotation={geom?.rotate ?? layer.rotate}
      opacity={(geom?.opacity ?? layer.opacity) * anim.opacity}
      revealKey={revealKey}
      visible={!hidden}
      draggable={draggable}
      listening={selectable}
      onClick={onSelect}
      onTap={onSelect}
      onDblClick={onDblClick}
      onDblTap={onDblClick}
      onDragStart={onSelect}
      onDragMove={onDragMove}
      onDragEnd={(e) => {
        onGuides(NO_GUIDES);
        if (onGroupMove) {
          const node = e.target as Konva.Image;
          onGroupMove((node.x() - (box.x + box.w / 2 + anim.dx * H)) / W, (node.y() - (box.y + box.h / 2 + anim.dy * H)) / H);
          return;
        }
        commitBox(e.target as Konva.Image, box.w);
      }}
      onTransformStart={() => {
        const side = layer.type === 'text' ? edgeOfAnchor(activeAnchor()) : null;
        if (!side || !lastText.current) return;
        const spec = useEditor.getState().currentSpec();
        const startLen = side.axis === 'x' ? box.w : box.h;
        edge.current = { snapshot: spec ? cloneSpec(spec) : null, ratio: box.w / lastText.current.width, ...side, startLen, draft: null, raf: 0 };
      }}
      onTransform={(e) => {
        const ed = edge.current;
        if (!ed || layer.type !== 'text') return;
        const node = e.target as Konva.Image;
        const s = anim.scale;
        // Konva 把拉伸放在 scaleX / scaleY 上：换算成拖到的长度，再按新样式同步重画，节点尺寸跟着 PNG 走（字形不拉伸）
        const dragged = Math.max(8, ed.axis === 'x' ? node.width() * (node.scaleX() / s) : node.height() * (node.scaleY() / s));
        if (!ed.draft && Math.abs(dragged - ed.startLen) < 0.5) {
          node.setAttrs({ scaleX: s, scaleY: s });
          return;
        }
        const pad = lastText.current?.pad ?? 0;
        const src = layer as TextLayer;
        const draft: TextLayer = { ...src, style: { ...src.style } };
        if (ed.axis === 'x') {
          setLayerWrapWidth(draft, wrapWidthFromStage(dragged, ed.ratio, pad));
        } else {
          const tight = renderTextSync({ ...src, style: { ...src.style, box_height: null } }).height - 2 * pad;
          draft.style.box_height = boxHeightFromStage(dragged, ed.ratio, pad, tight);
        }
        const r = renderTextSync(draft);
        const w = r.width * ed.ratio;
        const h = r.height * ed.ratio;
        const c = keepOppositeEdge({ x: node.x(), y: node.y() }, node.rotation(), ed.axis, ed.side, dragged * s, (ed.axis === 'x' ? w : h) * s);
        node.setAttrs({ image: r.canvas, width: w, height: h, offsetX: w / 2, offsetY: h / 2, scaleX: s, scaleY: s, x: c.x, y: c.y });
        ed.draft = draft;
        if (!ed.raf) {
          ed.raf = requestAnimationFrame(() => {
            ed.raf = 0;
            if (edge.current === ed) applyEdge(node, false);
          });
        }
      }}
      onTransformEnd={(e) => {
        onGuides(NO_GUIDES);
        const node = e.target as Konva.Image;
        const ed = edge.current;
        if (ed) {
          if (ed.raf) cancelAnimationFrame(ed.raf);
          applyEdge(node, true);
          edge.current = null;
          return;
        }
        const newW = Math.max(8, (node.width() * node.scaleX()) / anim.scale);
        const newH = layer.type === 'shape' ? Math.max(8, (node.height() * node.scaleY()) / anim.scale) : undefined;
        node.scaleX(anim.scale);
        node.scaleY(anim.scale);
        commitBox(node, newW, node.rotation(), newH);
      }}
      stroke={selected ? GUIDE_COLOR : undefined}
      strokeWidth={selected ? 1 : 0}
      strokeScaleEnabled={false}
    />
  );
}

function mediaFrameStyle(box: VideoBox, clip: VideoTrackClip | { transform?: import('../../types').VideoTransform | null }) {
  const crop = resolveVideoTransform(clip.transform).crop;
  const frame = { left: box.x, top: box.y, width: box.w, height: box.h };
  if (!crop) return { frame, media: { inset: 0, width: '100%', height: '100%' } as CSSProperties };
  return {
    frame,
    media: {
      inset: 'auto',
      left: -crop.x * box.w / crop.w,
      top: -crop.y * box.h / crop.h,
      width: box.w / crop.w,
      height: box.h / crop.h,
    } as CSSProperties,
  };
}

function UpperVideoPreview({ clip, source, active, fill, W, H, outputW }: { clip: VideoTrackClip; source: Video; active: boolean; fill: 'blur' | 'color' | 'crop'; W: number; H: number; outputW: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const sync = (playing: boolean) => {
      const element = ref.current;
      if (!element) return;
      const post = player.postTime;
      const visible = post >= clip.start && post < clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
      if (!visible) { element.pause(); return; }
      const at = clip.in + (post - clip.start) * (clip.speed ?? 1);
      element.muted = true;
      element.playbackRate = Math.max(0.25, Math.min(4, player.mediaRate * (clip.speed ?? 1)));
      if (Math.abs(element.currentTime - at) > (playing ? 0.2 : 0.01)) element.currentTime = at;
      if (playing && element.paused) void element.play().catch(() => undefined);
      if (!playing && !element.paused) element.pause();
    };
    sync(player.mediaRate > 0);
    return player.subscribe((_time, playing) => sync(playing));
  }, [clip]);
  const transformed = !!clip.transform;
  const box = transformed ? videoBox(clip.transform, source.width * (W / outputW), source.height * (W / outputW), W, H, fill) : { x: 0, y: 0, w: W, h: H };
  const styles = mediaFrameStyle(box, clip);
  return <div className="upper-video-frame" style={{ ...styles.frame, display: active ? 'block' : 'none', background: transformed ? 'transparent' : undefined }}><video ref={ref} className="upper-video-preview" src={source.proxy_url} playsInline preload="auto" muted style={{ ...styles.media, objectFit: transformed ? 'fill' : fill === 'crop' ? 'cover' : 'contain', background: transformed ? 'transparent' : undefined }} /></div>;
}

export function Stage({ hidden }: { hidden?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const videoTrRef = useRef<Konva.Transformer>(null);
  const videoNodeRef = useRef<Konva.Rect>(null);
  const nodes = useRef<Record<string, Konva.Node | null>>({});
  const previewKey = useEditor((s) => s.previewVariantKey);
  const isRef = previewKey === '9x16';
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const activeSource = useEditor((s) => {
    const sequence = s.currentVideoId ? s.specs[s.currentVideoId]?.sequence : null;
    const clip = sequence ? clipAt(sequence, Math.max(0, s.time))?.clip : null;
    return clip ? s.videos.find((v) => v.id === clip.video_id) ?? null : null;
  });
  const frameVideo = activeSource ?? video;
  const variant = spec ? outputFor(spec, previewKey) : undefined;
  const { width: outputW, height: outputH } = variant ? outputSize(variant) : variantDef(previewKey);
  const { W, H } = useFitSize(wrapRef, outputW / outputH);
  const assets = useEditor((s) => s.assets);
  const editLayerOnPreview = useEditor((s) => s.editLayerOnPreview);
  // 非 9:16 预览：图层框按该画幅算（输出像素 → 舞台像素），松手写回该画幅的覆盖
  const stageScale = W / outputW;
  const geomOf = (l: Layer): StageGeom | undefined => {
    if (isRef || !spec || !variant || !video) return undefined;
    const r = resolveLayerBox(spec, l, variant, layerAspect(l, assets), frameVideo?.width ?? video.width, frameVideo?.height ?? video.height);
    return { box: { x: r.x * stageScale, y: r.y * stageScale, w: r.w * stageScale, h: r.h * stageScale }, rotate: r.rotate, opacity: r.opacity };
  };
  const commitOnVariant = (l: Layer) =>
    isRef
      ? undefined
      : (b: LayerBox, rotate?: number, history = true) => {
          editLayerOnPreview(l.id, () => ({ box: { x: b.x / stageScale, y: b.y / stageScale, w: b.w / stageScale, h: b.h / stageScale }, rotate }), history);
        };
  const fill = variant?.fill ?? 'blur';
  // 源画面与画布比例不一致时才需要填充背景（9:16 素材放到 9:16 画布上铺满，不画）
  const needsFill = !!frameVideo && Math.abs(frameVideo.width / frameVideo.height - outputW / outputH) > 0.01;
  const step = useEditor((s) => s.step);
  const layerTypes = layerTypesForStep(step);
  const zone = useEditor((s) => s.safeZones.find((z) => z.key === s.safeZoneKey));
  const safeZoneView = useEditor((s) => s.safeZoneView);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const selectedLayerIds = useEditor((s) => s.selectedLayerIds);
  const moveSelectedLayersOnCanvas = useEditor((s) => s.moveSelectedLayersOnCanvas);
  const drawingShape = useEditor((s) => s.drawingShape);
  const addLayer = useEditor((s) => s.addLayer);
  const setSelectedLayer = useEditor((s) => s.setSelectedLayer);
  const selectTimelineItems = useEditor((s) => s.selectTimelineItems);
  const timelineSelection = useEditor((s) => s.timelineSelection);
  const updateSelectedVideoTransform = useEditor((s) => s.updateSelectedVideoTransform);
  const focusLayer = useEditor((s) => s.focusLayer);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const postTime = usePostTime();
  const postDuration = usePostDuration();
  const preroll = useCoverDuration();
  const coverActive = useInCover();
  const mainVideoHidden = !!spec?.video_hidden && !coverActive;
  const [hitGuides, setHitGuides] = useState<Guides>(NO_GUIDES);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  // 正在拖动 / 拉伸的遮盖的实时框：预览 div 跟着它走，松手后回到 spec 算出的框
  const [liveMask, setLiveMask] = useState<{ id: string; box: LayerBox } | null>(null);
  const [shapeDraft, setShapeDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // 画布框选（HIG-77）：与时间轴同一套语义（⇧ 追加、⌥/Ctrl 排除），坐标用舞台自己的像素，
  // 和 node.getClientRect() 同一个坐标系，省掉容器偏移的换算。
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number; mode: 'replace' | 'add' | 'subtract'; active: boolean } | null>(null);
  const backdrop = useMemo(supportsBackdropBlur, []);
  const selectedVideoKey = [...timelineSelection].reverse().find((key) => key.startsWith('clip:') || key.startsWith('vclip:')) ?? null;
  const activeMainClip = spec?.sequence ? clipAt(spec.sequence, postTime)?.clip : undefined;
  const activeUpper = spec?.video_tracks?.flatMap((track) => track.hidden ? [] : track.clips.map((clip) => ({ clip, locked: !!track.locked }))).filter(({ clip }) => postTime >= clip.start && postTime < videoTrackClipEnd(clip)) ?? [];

  // 换选中 / 换视频 / 换步骤时退出内联编辑
  useEffect(() => {
    if (editingLayerId && selectedLayerId !== editingLayerId) setEditingLayerId(null);
  }, [selectedLayerId, editingLayerId]);
  useEffect(() => {
    setEditingLayerId(null);
  }, [video?.id, step, previewKey]);
  useEffect(() => {
    if (coverActive) setEditingLayerId(null);
  }, [coverActive]);

  // 安全区按竖版平台定义：非 9:16 预览时只吸附画布边与中线
  const guides = canvasGuides(isRef ? zone : null, W, H);
  const guidesRef = useRef(guides);
  guidesRef.current = guides;

  // 源音轨音量（契约 §2 audio.source_volume）：和成片一样直接作用在源视频上；
  // 有原声静音区间（source_mute，HIG-25）时跟着播放头逐帧取增益，落进区间就是 0。
  // 源音轨关掉眼睛（HIG-33）：预览同样听不到原声
  const srcVolume = spec?.audio?.source_hidden ? 0 : sourceVolume(spec?.audio);
  const srcAudio = spec?.audio;
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = srcVolume;
    if (!spec?.sequence && (!srcAudio?.source_mute?.length || srcAudio.source_hidden)) return;
    const apply = () => {
      const v = videoRef.current;
      if (v) v.volume = spec?.sequence && video ? sequenceSourceGain(spec, video.id, player.currentTime) : sourceGainAt(srcAudio, player.postTime);
    };
    apply();
    return player.subscribe(apply);
  }, [srcVolume, srcAudio, video?.id, spec?.sequence]);

  // 封面时长 → 播放头前面的封面段。必须写在「播放器挂载」之前：换视频时先有新的封面时长，挂载时才能退到封面起点。
  useEffect(() => {
    const wasOff = player.preroll === 0;
    player.setPreroll(preroll);
    // 刚加上封面（或素材列表刚载入）且播放头停在正片开头：退到封面起点，画布上就是成片第一帧
    if (wasOff && preroll > 0 && !player.isPlaying && player.currentTime === 0) player.seek(-preroll);
  }, [preroll]);

  // 成片时长（HIG-50）→ player 循环补足 / 截断的依据；只在这里同步，store 里换批次时清零
  const fixedDuration = spec?.trim.duration ?? null;
  useEffect(() => {
    player.setOutputDuration(fixedDuration);
  }, [fixedDuration]);

  // 播放器挂载
  useEffect(() => {
    const el = videoRef.current;
    player.setSequence(null);
    player.attach(el);
    player.duration = video?.duration ?? 0;
    player.seek(-player.preroll, 0);
    const unsub = player.subscribe((t, playing, lap) => setPlayhead(t, playing, lap));
    return () => {
      unsub();
      player.pause();
      // 换素材时先解绑旧 <video>：子组件（填充底图）的 effect 先于这里的 attach 执行，不解绑会从旧元素抓帧（HIG-12）
      player.detach();
    };
  }, [video?.id, video?.duration, setPlayhead]);

  // 正片切到无字版时预览也要跟着换（HIG-38）：否则画面上是原文 + 译文两层字叠着，
  // 而导出的成片是干净的——所见与所得正好相反。无字版预览缺失时回落原片代理。
  const previewUrl = spec?.source_variant === 'clean' ? video?.screen_text?.erase?.clean_proxy_url || video?.proxy_url : video?.proxy_url;

  useEffect(() => {
    const el = videoRef.current;
    if (!spec?.sequence || !video) {
      player.setSequence(null);
      if (el && previewUrl && el.getAttribute('src') !== previewUrl) {
        el.setAttribute('src', previewUrl);
        el.load();
      }
      player.duration = video?.duration ?? 0;
      return;
    }
    const clips = clipWindows(spec.sequence).map(({ clip, start, end }) => {
      const source = useEditor.getState().videos.find((v) => v.id === clip.video_id);
      return { id: clip.id, src: source?.proxy_url ?? '', sourceIn: clip.in, sourceOut: clip.out, start, end, speed: clip.speed ?? 1, holdAfter: clip.hold_after ?? 0 };
    });
    player.setSequence(clips);
  }, [spec?.sequence, video?.id, video?.duration, previewUrl]);

  useEffect(() => {
    player.remove = spec?.trim.remove ?? [];
  }, [spec?.trim.remove, spec?.sequence]);

  // Transformer 绑定
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const selected = selectedLayerId ? spec?.layers.find((l) => l.id === selectedLayerId) : undefined;
    const node = selected && layerTypes.includes(selected.type) && editingLayerId !== selectedLayerId ? nodes.current[selected.id] : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedLayerId, editingLayerId, step, spec, W, H, coverActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const tr = videoTrRef.current;
    if (!tr) return;
    tr.nodes(step === 'trim' && selectedVideoKey && videoNodeRef.current ? [videoNodeRef.current] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedVideoKey, step, spec, W, H, coverActive]);

  const imageDrop = useCanvasImageDrop(boxRef, { enabled: !!video && !!spec, isRef });

  const onStageMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (drawingShape && spec && video && !coverActive) {
        const p = e.target.getStage()?.getPointerPosition();
        if (p) setShapeDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        return;
      }
      // 空白处：先只记起点。是「点一下取消选中」还是「拉框多选」，等松手时才知道。
      if (e.target === e.target.getStage()) {
        const p = e.target.getStage()?.getPointerPosition();
        const ev = e.evt as MouseEvent;
        if (p) marqueeRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, mode: ev.altKey || ev.ctrlKey ? 'subtract' : ev.shiftKey ? 'add' : 'replace', active: false };
      }
    },
    [drawingShape, spec, video, coverActive],
  );
  const onStageMouseMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (shapeDraft) {
      const p = e.target.getStage()?.getPointerPosition();
      if (p) setShapeDraft((d) => d && { ...d, x1: Math.max(0, Math.min(W, p.x)), y1: Math.max(0, Math.min(H, p.y)) });
      return;
    }
    const m = marqueeRef.current;
    if (!m) return;
    const p = e.target.getStage()?.getPointerPosition();
    if (!p) return;
    // 移开超过阈值才算框选，没动就还是一次普通点击
    if (!m.active && Math.abs(p.x - m.x0) < MARQUEE_PX && Math.abs(p.y - m.y0) < MARQUEE_PX) return;
    m.active = true;
    m.x1 = Math.max(0, Math.min(W, p.x));
    m.y1 = Math.max(0, Math.min(H, p.y));
    setMarquee({ x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 });
  };
  /** 框选结束：命中判定用舞台坐标，和 node.getClientRect() 同一个坐标系。 */
  const finishMarquee = () => {
    const m = marqueeRef.current;
    marqueeRef.current = null;
    setMarquee(null);
    if (!m) return;
    if (!m.active) {
      setSelectedLayer(null); // 只是点了一下空白：取消选中（原行为）
      return;
    }
    const left = Math.min(m.x0, m.x1), right = Math.max(m.x0, m.x1);
    const top = Math.min(m.y0, m.y1), bottom = Math.max(m.y0, m.y1);
    const hits = (spec?.layers ?? [])
      .filter((l) => layerTypes.includes(l.type))
      .filter((l) => {
        const node = nodes.current[l.id];
        if (!node) return false;
        const r = node.getClientRect({ skipShadow: true, skipStroke: true });
        return r.x <= right && r.x + r.width >= left && r.y <= bottom && r.y + r.height >= top;
      })
      .map((l) => l.id);
    // 走时间线那一套选择入口（HIG-60）：它会把 timelineSelection 和 selectedLayerIds 一起更新，
    // 否则画布上框中的图层在时间轴上不会跟着高亮。
    selectTimelineItems(hits.map((id) => `layer:${id}`), m.mode);
  };
  const onStageMouseUp = () => {
    if (!shapeDraft) {
      finishMarquee();
      return;
    }
    const d = shapeDraft;
    setShapeDraft(null);
    if (!d || !drawingShape || Math.abs(d.x1 - d.x0) < 8 || Math.abs(d.y1 - d.y0) < 8) return;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const start = Math.max(0, Math.min(postTime, Math.max(0, postDuration - 0.1)));
    const end = Math.min(postDuration, start + 3);
    addLayer({
      id: newLayerId(), type: 'shape', shape: drawingShape, anchor: 'top-left',
      margin: [round4(x / W), round4(y / H)],
      width: round4(Math.min(1, Math.abs(d.x1 - d.x0) / W)),
      height: round4(Math.min(1, Math.abs(d.y1 - d.y0) / H)),
      rotate: 0, opacity: 1, t: end > start ? [start, end] : 'all',
      fill: '#E3312B', stroke: '#FFFFFF', stroke_width: 0.004, radius: 0.08,
      flip_x: d.x1 < d.x0, flip_y: d.y1 < d.y0,
    });
  };

  // 拖出画布再松手时 Konva 收不到 mouseup，兜一层（框选跨出画面是常事）
  useEffect(() => {
    const onUp = () => {
      if (marqueeRef.current) finishMarquee();
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  });

  // 缩放角点吸附到参考线（旋转把手不吸附；按住 ⌘/Ctrl 关闭）
  const anchorDragBoundFunc = useCallback((_oldPos: Konva.Vector2d, newPos: Konva.Vector2d, evt: MouseEvent | TouchEvent | undefined) => {
    const tr = trRef.current;
    if (!tr || tr.getActiveAnchor() === 'rotater') return newPos;
    const me = evt as MouseEvent | undefined;
    if (!snapActive(useEditor.getState().snapEnabled, !!(me?.ctrlKey || me?.metaKey))) {
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
  const editingLayer = layerTypes.includes('text') && editingLayerId ? (layers.find((l) => l.id === editingLayerId && l.type === 'text') as TextLayer | undefined) : undefined;
  const selectedLayer = selectedLayerId ? layers.find((l) => l.id === selectedLayerId) : undefined;
  const selectedType = selectedLayer?.type;
  const selectedIsMask = selectedType === 'mask';
  // 大字报拖的是裁切框（HIG-75）：八向、不锁比例、不旋转，与遮盖同一档
  const selectedIsScrollBox = selectedType === 'text' && !!(selectedLayer as TextLayer | undefined)?.scroll;
  const activeAnchor = useCallback(() => trRef.current?.getActiveAnchor() ?? null, []);
  const hasSrc = !!previewUrl;
  const mainTransformed = !!activeMainClip?.transform;
  const mainBox = mainTransformed && frameVideo
    ? videoBox(activeMainClip?.transform, frameVideo.width * stageScale, frameVideo.height * stageScale, W, H, fill)
    : { x: 0, y: 0, w: W, h: H };
  const mainFrameStyles = mediaFrameStyle(mainBox, activeMainClip ?? {});
  const videoControls = [
    ...(!coverActive && frameVideo ? [{
      key: activeMainClip ? `clip:${activeMainClip.id}` : 'main',
      clip: activeMainClip,
      source: frameVideo,
      locked: !!spec?.video_locked,
      box: videoBox(activeMainClip?.transform, frameVideo.width * stageScale, frameVideo.height * stageScale, W, H, fill),
    }] : []),
    ...activeUpper.flatMap(({ clip, locked }) => {
      const source = useEditor.getState().videos.find((item) => item.id === clip.video_id);
      return source ? [{ key: `vclip:${clip.id}`, clip, source, locked, box: videoBox(clip.transform, source.width * stageScale, source.height * stageScale, W, H, fill) }] : [];
    }),
  ];
  const selectVideoControl = (key: string) => {
    if (key === 'main') updateSelectedVideoTransform({});
    else selectTimelineItems([key]);
  };
  const overlayUrl = isRef && safeZoneView === 'overlay' ? zone?.overlay_url ?? null : null;
  const showFrames = isRef && (safeZoneView === 'frames' || (safeZoneView === 'overlay' && !overlayUrl));

  return (
    <div className="stage-wrap" ref={wrapRef} style={hidden ? { display: 'none' } : undefined} {...imageDrop.handlers}>
      <div className="stage-box" ref={boxRef} style={{ width: W, height: H, background: mainVideoHidden ? '#000' : undefined }}>
        {needsFill && !mainVideoHidden && <FillBackdrop fill={fill} color={variant?.color} crop={variant?.crop} blurFilter={blurFillFilter(variant ?? {}, outputW, outputH, W / 2)} videoId={frameVideo?.id} posterUrl={frameVideo?.poster_url} W={W} H={H} postTime={postTime} />}
        <div className="main-video-frame" style={mainFrameStyles.frame}>
          <video
            ref={videoRef}
            src={previewUrl || undefined}
            poster={video?.poster_url}
            playsInline
            preload="auto"
            key={`${video?.id}:${spec?.source_variant ?? 'original'}`}
            style={{ ...mainFrameStyles.media, objectFit: mainTransformed ? 'fill' : 'contain', background: needsFill ? 'transparent' : undefined, visibility: mainVideoHidden || (!mainTransformed && needsFill && fill === 'crop') ? 'hidden' : undefined }}
            onLoadedMetadata={(e) => {
              e.currentTarget.volume = spec?.sequence && video ? sequenceSourceGain(spec, video.id, player.currentTime) : sourceGainAt(srcAudio, player.postTime);
            }}
          />
        </div>
        {!coverActive && spec?.video_tracks?.filter((track) => !track.hidden).flatMap((track) => track.clips).map((clip) => {
          const source = useEditor.getState().videos.find((item) => item.id === clip.video_id);
          const active = postTime >= clip.start && postTime < clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
          return source ? <UpperVideoPreview key={clip.id} clip={clip} source={source} active={active} fill={fill} W={W} H={H} outputW={outputW} /> : null;
        })}
        {preroll > 0 && <CoverPreview fill={fill} color={variant?.color} blurFilter={blurFillFilter(variant ?? {}, outputW, outputH, W)} W={W} H={H} />}
        <AudioTracks />
        {!coverActive &&
          layers.map((l) => {
            if (l.type !== 'mask' || l.hidden || !windowContains(l.t, postTime)) return null;
            const g = geomOf(l);
            const box = liveMask?.id === l.id ? liveMask.box : g?.box ?? maskStageBox(l, W, H);
            return <MaskPreview key={l.id} layer={g ? { ...l, opacity: g.opacity } : l} box={box} W={W} backdrop={backdrop} />;
          })}
        <div className="konva-layer" style={drawingShape ? { cursor: 'crosshair' } : undefined}>
          <KStage width={W} height={H} onMouseDown={onStageMouseDown} onTouchStart={onStageMouseDown} onMouseMove={onStageMouseMove} onTouchMove={onStageMouseMove} onMouseUp={onStageMouseUp} onTouchEnd={onStageMouseUp}>
            <KLayer listening={false}>{showFrames && <SafeZones zone={zone} W={W} H={H} />}</KLayer>
            <KLayer>
              {step === 'trim' && videoControls.map((control) => {
                const selected = selectedVideoKey === control.key;
                return <Rect
                  key={`video-control:${control.key}`}
                  ref={selected ? videoNodeRef : undefined}
                  x={control.box.x}
                  y={control.box.y}
                  width={control.box.w}
                  height={control.box.h}
                  fill="rgba(0,0,0,0.001)"
                  stroke={selected ? GUIDE_COLOR : undefined}
                  strokeWidth={selected ? 1 : 0}
                  draggable={!control.locked}
                  onPointerDown={() => selectVideoControl(control.key)}
                  onDragEnd={(e) => {
                    const node = e.target;
                    updateSelectedVideoTransform({ x: (node.x() + node.width() / 2) / W, y: (node.y() + node.height() / 2) / H });
                  }}
                  onTransformEnd={(e) => {
                    const node = e.target;
                    const box = { x: node.x(), y: node.y(), w: node.width() * node.scaleX(), h: node.height() * node.scaleY() };
                    node.scaleX(1);
                    node.scaleY(1);
                    updateSelectedVideoTransform(transformFromBox(box, control.clip?.transform, control.source.width * stageScale, control.source.height * stageScale, W, H, fill));
                  }}
                />;
              })}
              {layers.map((l) => {
                if (l.hidden || coverActive) return null;
                if (!windowContains(l.t, postTime)) return null;
                // 图层无论当前模块为何都能命中；点选后由 focusLayer 切到对应属性面板。
                const selectable = !drawingShape;
                if (l.type === 'mask') {
                  return (
                    <MaskNode
                      key={l.id}
                      layer={l}
                      W={W}
                      H={H}
                      selectable={selectable}
                      selected={selectedLayerIds.includes(l.id) && layerTypes.includes(l.type)}
                      outlined={layerTypes.includes(l.type)}
                      backdrop={backdrop}
                      guides={guides}
                      onSelect={() => { if (selectedLayerIds.length <= 1 || !selectedLayerIds.includes(l.id)) focusLayer(l); }}
                      onGuides={setHitGuides}
                      onLive={(box) => setLiveMask(box ? { id: l.id, box } : null)}
                      registerNode={(n) => {
                        nodes.current[l.id] = n;
                      }}
                      box={geomOf(l)?.box}
                      onCommitVariant={commitOnVariant(l)}
                    />
                  );
                }
                return (
                  <LayerNode
                    key={l.id}
                    layer={l}
                    W={W}
                    H={H}
                    selectable={selectable}
                    selected={selectedLayerIds.includes(l.id) && layerTypes.includes(l.type)}
                    hidden={!!editingLayer && editingLayer.id === l.id}
                    guides={guides}
                    onSelect={() => { if (selectedLayerIds.length <= 1 || !selectedLayerIds.includes(l.id)) focusLayer(l); }}
                    onEdit={() => isRef && setEditingLayerId(l.id)}
                    onGuides={setHitGuides}
                    registerNode={(n) => {
                      nodes.current[l.id] = n;
                    }}
                    geom={geomOf(l)}
                    onCommitVariant={commitOnVariant(l)}
                    onGroupMove={isRef && selectedLayerIds.length > 1 && selectedLayerIds.includes(l.id) ? moveSelectedLayersOnCanvas : undefined}
                    activeAnchor={activeAnchor}
                  />
                );
              })}
              {layerTypes.length > 0 && (
                <Transformer
                  ref={trRef}
                  keepRatio={!selectedIsMask && !selectedIsScrollBox && (selectedType !== 'shape' || !isRef)}
                  enabledAnchors={selectedIsMask || selectedIsScrollBox || selectedType === 'shape' ? ALL_ANCHORS : selectedType === 'text' ? TEXT_ANCHORS : CORNER_ANCHORS}
                  rotateEnabled={!selectedIsMask && !selectedIsScrollBox}
                  anchorSize={8}
                  anchorStroke={GUIDE_COLOR}
                  anchorFill="#fff"
                  borderStroke={GUIDE_COLOR}
                  rotationSnaps={[0, 90, 180, 270]}
                  boundBoxFunc={(oldBox, newBox) => (newBox.width < 8 || newBox.height < 8 ? oldBox : newBox)}
                  anchorDragBoundFunc={anchorDragBoundFunc}
                />
              )}
              {step === 'trim' && selectedVideoKey && (
                <Transformer
                  ref={videoTrRef}
                  keepRatio
                  enabledAnchors={CORNER_ANCHORS}
                  rotateEnabled={false}
                  anchorSize={8}
                  anchorStroke={GUIDE_COLOR}
                  anchorFill="#fff"
                  borderStroke={GUIDE_COLOR}
                  boundBoxFunc={(oldBox, newBox) => (newBox.width < 8 || newBox.height < 8 ? oldBox : newBox)}
                />
              )}
            </KLayer>
            <KLayer listening={false}>
              {shapeDraft && <Rect x={Math.min(shapeDraft.x0, shapeDraft.x1)} y={Math.min(shapeDraft.y0, shapeDraft.y1)} width={Math.abs(shapeDraft.x1 - shapeDraft.x0)} height={Math.abs(shapeDraft.y1 - shapeDraft.y0)} stroke={GUIDE_COLOR} strokeWidth={1} dash={[4, 4]} />}
              {marquee && (
                <Rect
                  x={Math.min(marquee.x0, marquee.x1)}
                  y={Math.min(marquee.y0, marquee.y1)}
                  width={Math.abs(marquee.x1 - marquee.x0)}
                  height={Math.abs(marquee.y1 - marquee.y0)}
                  stroke={GUIDE_COLOR}
                  strokeWidth={1}
                  dash={[4, 3]}
                  fill="rgba(255,255,255,0.08)"
                  listening={false}
                />
              )}
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
        {editingLayer && <InlineTextEditor key={editingLayer.id} layer={editingLayer} W={W} H={H} onClose={() => setEditingLayerId(null)} />}
        {!hasSrc && <div className="stage-hint">无代理视频（mock 示例）· 使用合成时钟播放</div>}
        {video?.status === 'preparing' && <div className="stage-hint">预处理中…</div>}
        {imageDrop.over && (
          <div className="dropzone-mask" aria-hidden>
            <span>松手添加为贴纸</span>
          </div>
        )}
      </div>
    </div>
  );
}

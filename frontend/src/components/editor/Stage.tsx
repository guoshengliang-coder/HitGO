// 预览舞台：<video>（proxy）在下，react-konva Stage 同尺寸叠在上面，绘制安全区与图层。
// 图层位置全部由 lib/layout.ts 的契约公式计算；拖动 / 缩放 / 旋转后反算回 margin / width / rotate。
// 拖动时吸附到画布边 / 中线 / 安全区边（lib/snap.canvasGuides），按住 ⌘/Ctrl 关闭；命中的参考线画在最上层。
// 画布比例跟着「成片画面」页签的预览画幅（HIG-29，缺省 9:16）；源画面比例不同时按该画幅的填充方式（模糊 / 纯色 / 裁切）画底。
// 非 9:16 预览时图层位置由 lib/variantLayout 算（跟随视频或已微调），拖动 / 缩放写回该画幅的 layer_overrides；
// 安全区只在 9:16 显示，内联文字编辑也只在 9:16 上进行。
// 只有当前模块管理的那几类图层（文本 / 贴纸；字幕管文字 + 遮盖）能选中、拖动；其它类照常显示。
// 双击文字图层进入内联编辑（InlineTextEditor 叠在 Konva 上），编辑期间隐藏该图层的 Konva 节点和 Transformer。
// 遮盖层（MaskNode）的模糊 / 色块由叠在 <video> 之上、Konva 之下的 MaskPreview div 实时画出，Konva 只画把手；
// 拉伸不锁比例、没有旋转把手。
// 文字图层（HIG-51，对齐剪映）：四角等比缩放；左右边把手改自动换行宽度（style.wrap_width），拖动中实时重新折行，高度跟着行数变。
// 有封面（HIG-9）时播放头的封面段（time < 0）由 CoverPreview 盖住正片，图层不显示、贴纸与音轨不出声。
// 把 JPG / PNG 或贴纸卡片拖到画布上（HIG-46）：以落点为中心加贴纸图层（useCanvasImageDrop）。
// 滚动文字（HIG-50 大字报）：PNG 在裁切框（scroll.box）里按 lib/poster 的曲线向上滚，框外裁掉；不能拖动 / 缩放，
// 选中且暂停时画出框线。成片时长（trim.duration）交给 player 循环补足，播放头的成片时刻从 usePostTime 取（跨遍累加）。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage as KStage, Layer as KLayer, Image as KImage, Line as KLine, Rect, Text as KText, Transformer, Group } from 'react-konva';
import { useCoverDuration, useEditor, useInCover, usePostDuration, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { marginFromBox, placeLayer, round4, type LayerBox } from '../../lib/layout';
import { cloneSpec, layerAspect, outputFor } from '../../lib/spec';
import { resolveLayerBox } from '../../lib/variantLayout';
import { layerTypesForStep } from '../../lib/steps';
import { windowContains } from '../../lib/time';
import { resolveScroll, sampleScrollY, scrollPath } from '../../lib/poster';
import { canvasGuides, snapActive, snapValue } from '../../lib/snap';
import { ensureTextRendered, getCachedText, textCacheKey, TEXT_CANVAS, type RenderedText } from '../../lib/textImage';
import { clampWrapWidth } from '../../lib/textWrap';
import { setLayerWrapWidth } from '../../lib/localize';
import { loadImage, useImage } from '../../lib/useImage';
import { containBox, coverBox, variantFrameBox } from '../../lib/videoBox';
import { coverMediaTime } from '../../lib/cover';
import { useVideo } from '../../lib/useVideo';
import { stickerAudible, stickerFinished, stickerMediaTime, windowRange } from '../../lib/stickerMedia';
import { REST, enterDelay, hasAnimation, sampleAnimation } from '../../lib/textAnimation';
import { CURSOR_TAIL, buildGlyphLayout, paintReveal, revealTiming, unitCount } from '../../lib/textReveal';
import { InlineTextEditor } from './InlineTextEditor';
import { useCanvasImageDrop } from './useCanvasImageDrop';
import { sourceGainAt, sourceVolume } from '../../lib/audioTracks';
import { AudioTracks } from './AudioTracks';
import { MaskNode, MaskPreview, maskStageBox, supportsBackdropBlur } from './MaskNode';
import { GUIDE_COLOR, NO_GUIDES, SNAP_PX, snapDraggedNode, type Guides } from './stageSnap';
import { isVideoAsset, variantDef, type CropRect, type EditSpec, type Layer, type Rect as ZRect, type SafeZone, type TextLayer } from '../../types';

// Transformer 把手：贴纸锁比例只留四角；文字四角锁比例、左右边改换行宽度（keepRatio 只作用于四角）；遮盖不锁比例，八向都能拉
const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGE_ANCHORS = ['middle-left', 'middle-right'];
const TEXT_ANCHORS = [...CORNER_ANCHORS, ...EDGE_ANCHORS];
const ALL_ANCHORS = [...CORNER_ANCHORS, 'top-center', ...EDGE_ANCHORS, 'bottom-center'];

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
function FillBackdrop({ fill, color, crop, videoId, posterUrl, W, H, postTime }: { fill: 'blur' | 'color' | 'crop'; color?: string; crop?: CropRect; videoId?: string; posterUrl?: string; W: number; H: number; postTime: number }) {
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
        ctx.filter = 'blur(6px) brightness(0.7)';
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
  }, [fill, crop, videoId, posterUrl, W, H, postTime, frame]);
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
function CoverPreview({ fill, color, W, H }: { fill: 'blur' | 'color' | 'crop'; color?: string; W: number; H: number }) {
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
      ctx.filter = 'blur(12px) brightness(0.7)';
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
  registerNode: (node: Konva.Image | null) => void;
  /** 预览非 9:16 画幅时由 Stage 算好的舞台框 / 旋转 / 不透明度（HIG-29）。 */
  geom?: StageGeom;
  /** 预览非 9:16 画幅时松手写回该画幅的覆盖。 */
  onCommitVariant?: (box: LayerBox, rotate?: number, history?: boolean) => void;
  /** 正在拖的 Transformer 把手名（middle-left 等），没有时 null。 */
  activeAnchor: () => string | null;
}) {
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const syncPosterLayer = useEditor((s) => s.syncPosterLayer);
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
  const [, bump] = useState(0);
  // 逐字显现（HIG-45）的合成画布：每帧按遮罩把文字 PNG 画进来，复用同一块
  const revealCanvas = useRef<HTMLCanvasElement | null>(null);

  // 把贴纸视频的播放位置对齐到播放头。播放中的每帧重绘由 player 的 rAF → setTime →
  // React 重渲染带出来；这里补的是暂停 / 拖进度条后 seek 完成的那一次重绘。
  useEffect(() => {
    if (!stickerVideo || layer.type !== 'sticker') return;
    const playback = layer.playback ?? 'loop';
    const mediaDuration = sticker?.duration ?? stickerVideo.duration ?? 0;
    const sync = (postTime: number, playing: boolean) => {
      const at = stickerMediaTime(postTime, layer.t, postDuration, mediaDuration, playback);
      // 贴纸音轨（mix_audio）：和成片同一套规则决定此刻出不出声；元素默认静音
      stickerVideo.muted = !stickerAudible({
        postTime, t: layer.t, postDuration, mediaDuration, playback, playing,
        mixAudio: layer.mix_audio, hasAudio: sticker?.has_audio,
      });
      if (at === null) {
        if (!stickerVideo.paused) stickerVideo.pause();
        return;
      }
      if (playing && stickerFinished(postTime, layer.t, postDuration, mediaDuration, playback)) {
        // freeze 定格中：再 play() 浏览器会从头重播（画面闪、声音重来），停在最后一帧即可
        if (!stickerVideo.paused) stickerVideo.pause();
        if (Math.abs(stickerVideo.currentTime - at) > 0.01) stickerVideo.currentTime = at;
      } else if (playing) {
        // 播放中只在明显漂移时纠正，否则每帧 seek 会让画面抖
        if (stickerVideo.playbackRate !== player.mediaRate) stickerVideo.playbackRate = player.mediaRate;
        if (Math.abs(stickerVideo.currentTime - at) > 0.25 * player.mediaRate) stickerVideo.currentTime = at;
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

  // 滚动文字（HIG-50）没有可变换的节点：把 Transformer 里的引用清掉，免得留着旧节点
  const isScroll = layer.type === 'text' && !!layer.scroll;
  useEffect(() => {
    if (isScroll) registerNode(null);
  }, [isScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  // 改了文字 / 样式、新 PNG 还没渲染好时先沿用上一张：拖边改换行宽度时节点不会中途消失
  const lastText = useRef<RenderedText | undefined>(undefined);
  const textRendered = layer.type === 'text' ? getCachedText(layer as TextLayer) : undefined;
  if (textRendered) lastText.current = textRendered;
  let image: CanvasImageSource | undefined;
  if (layer.type !== 'sticker') image = lastText.current?.canvas;
  else if (!stickerIsVideo) image = stickerImg;
  else image = videoReady ? stickerVideo : stickerPoster;
  // 拖边改换行宽度：开始时的 spec 快照（松手时压一条历史）、舞台像素 / PNG 像素的比例、节流用的 rAF
  const edge = useRef<{ snapshot: EditSpec | null; ratio: number; startW: number; moved: boolean; raf: number } | null>(null);
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
    return (
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
        {selected && !playing && <Rect x={bx.x + 0.5} y={bx.y + 0.5} width={bx.w - 1} height={bx.h - 1} stroke={GUIDE_COLOR} strokeWidth={1} dash={[4, 3]} listening={false} />}
      </Group>
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

  const commitBox = (node: Konva.Image, newW: number, rotate?: number) => {
    const h = newW / aspect;
    const cx = node.x() - anim.dx * H;
    const cy = node.y() - anim.dy * H;
    const nb = { x: cx - newW / 2, y: cy - h / 2, w: newW, h };
    if (onCommitVariant) {
      onCommitVariant(nb, rotate);
      return;
    }
    const margin = marginFromBox(nb, layer.anchor, { W, H });
    const m: [number, number] = [round4(margin[0]), round4(margin[1])];
    const w = round4(newW / W);
    const r = rotate !== undefined ? Math.round(rotate * 10) / 10 : undefined;
    updateLayer(layer.id, (l) => {
      l.margin = m;
      l.width = w;
      if (r !== undefined) l.rotate = r;
      if (l.type === 'text' && Math.abs(newW - box.w) > 0.5) l.width_manual = true;
    });
  };

  // 左右边把手（文字）：Konva 把拉伸放在 scaleX 上，这里换成节点宽度（图片先横向拉伸），再节流写回 wrap_width
  const isEdgeDrag = () => layer.type === 'text' && EDGE_ANCHORS.includes(activeAnchor() ?? '');
  const applyEdge = (node: Konva.Image, history: boolean) => {
    const e = edge.current;
    const r = lastText.current;
    if (!e || !r) return;
    const newW = node.width();
    // 只点了一下把手没拖：不写 spec、不记历史
    if (!e.moved && Math.abs(newW - e.startW) < 0.5) return;
    e.moved = true;
    const wrap = clampWrapWidth((newW / e.ratio - 2 * r.pad) / TEXT_CANVAS.W);
    const cx = node.x() - anim.dx * H;
    const cy = node.y() - anim.dy * H;
    const nb = { x: cx - newW / 2, y: cy - node.height() / 2, w: newW, h: node.height() };
    updateLayer(
      layer.id,
      (l) => {
        if (l.type !== 'text') return;
        setLayerWrapWidth(l, wrap);
        if (onCommitVariant) return;
        const m = marginFromBox(nb, l.anchor, { W, H });
        l.margin = [round4(m[0]), round4(m[1])];
        l.width = round4(newW / W);
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
        commitBox(e.target as Konva.Image, box.w);
      }}
      onTransformStart={() => {
        if (!isEdgeDrag() || !lastText.current) return;
        const spec = useEditor.getState().currentSpec();
        edge.current = { snapshot: spec ? cloneSpec(spec) : null, ratio: box.w / lastText.current.width, startW: box.w, moved: false, raf: 0 };
      }}
      onTransform={(e) => {
        const ed = edge.current;
        if (!ed) return;
        const node = e.target as Konva.Image;
        const newW = Math.max(8, node.width() * (node.scaleX() / anim.scale));
        // 保持左 / 右边不动：offset 跟着宽度走，scale 复原
        node.setAttrs({ width: newW, offsetX: newW / 2, scaleX: anim.scale });
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
        node.scaleX(anim.scale);
        node.scaleY(anim.scale);
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
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodes = useRef<Record<string, Konva.Node | null>>({});
  const previewKey = useEditor((s) => s.previewVariantKey);
  const isRef = previewKey === '9x16';
  const def = variantDef(previewKey);
  const { W, H } = useFitSize(wrapRef, def.width / def.height);

  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const variant = spec ? outputFor(spec, previewKey) : undefined;
  const assets = useEditor((s) => s.assets);
  const editLayerOnPreview = useEditor((s) => s.editLayerOnPreview);
  // 非 9:16 预览：图层框按该画幅算（输出像素 → 舞台像素），松手写回该画幅的覆盖
  const stageScale = W / def.width;
  const geomOf = (l: Layer): StageGeom | undefined => {
    if (isRef || !spec || !variant || !video) return undefined;
    const r = resolveLayerBox(spec, l, variant, layerAspect(l, assets), video.width, video.height);
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
  const needsFill = !!video && Math.abs(video.width / video.height - def.width / def.height) > 0.01;
  const step = useEditor((s) => s.step);
  const layerTypes = layerTypesForStep(step);
  const zone = useEditor((s) => s.safeZones.find((z) => z.key === s.safeZoneKey));
  const safeZoneView = useEditor((s) => s.safeZoneView);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const setSelectedLayer = useEditor((s) => s.setSelectedLayer);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const postTime = usePostTime();
  const preroll = useCoverDuration();
  const coverActive = useInCover();
  const [hitGuides, setHitGuides] = useState<Guides>(NO_GUIDES);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  // 正在拖动 / 拉伸的遮盖的实时框：预览 div 跟着它走，松手后回到 spec 算出的框
  const [liveMask, setLiveMask] = useState<{ id: string; box: LayerBox } | null>(null);
  const backdrop = useMemo(supportsBackdropBlur, []);

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
    if (!srcAudio?.source_mute?.length || srcAudio.source_hidden) return;
    const apply = () => {
      const v = videoRef.current;
      if (v) v.volume = sourceGainAt(srcAudio, player.postTime);
    };
    apply();
    return player.subscribe(apply);
  }, [srcVolume, srcAudio, video?.id]);

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

  useEffect(() => {
    player.remove = spec?.trim.remove ?? [];
  }, [spec?.trim.remove]);

  // Transformer 绑定
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const selected = selectedLayerId ? spec?.layers.find((l) => l.id === selectedLayerId) : undefined;
    const node = selected && layerTypes.includes(selected.type) && editingLayerId !== selectedLayerId ? nodes.current[selected.id] : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedLayerId, editingLayerId, step, spec, W, H, coverActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const imageDrop = useCanvasImageDrop(boxRef, { enabled: !!video && !!spec, isRef });

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
  const selectedType = selectedLayerId ? layers.find((l) => l.id === selectedLayerId)?.type : undefined;
  const selectedIsMask = selectedType === 'mask';
  const activeAnchor = useCallback(() => trRef.current?.getActiveAnchor() ?? null, []);
  const hasSrc = !!video?.proxy_url;
  const overlayUrl = isRef && safeZoneView === 'overlay' ? zone?.overlay_url ?? null : null;
  const showFrames = isRef && (safeZoneView === 'frames' || (safeZoneView === 'overlay' && !overlayUrl));

  return (
    <div className="stage-wrap" ref={wrapRef} style={hidden ? { display: 'none' } : undefined} {...imageDrop.handlers}>
      <div className="stage-box" ref={boxRef} style={{ width: W, height: H }}>
        {needsFill && <FillBackdrop fill={fill} color={variant?.color} crop={variant?.crop} videoId={video?.id} posterUrl={video?.poster_url} W={W} H={H} postTime={postTime} />}
        <video
          ref={videoRef}
          src={video?.proxy_url || undefined}
          poster={video?.poster_url}
          playsInline
          preload="auto"
          key={video?.id}
          style={{ objectFit: 'contain', background: needsFill ? 'transparent' : undefined, visibility: needsFill && fill === 'crop' ? 'hidden' : undefined }}
          onLoadedMetadata={(e) => {
            e.currentTarget.volume = srcVolume;
          }}
        />
        {preroll > 0 && <CoverPreview fill={fill} color={variant?.color} W={W} H={H} />}
        <AudioTracks />
        {!coverActive &&
          layers.map((l) => {
            if (l.type !== 'mask' || l.hidden || !windowContains(l.t, postTime)) return null;
            const g = geomOf(l);
            const box = liveMask?.id === l.id ? liveMask.box : g?.box ?? maskStageBox(l, W, H);
            return <MaskPreview key={l.id} layer={g ? { ...l, opacity: g.opacity } : l} box={box} W={W} backdrop={backdrop} />;
          })}
        <div className="konva-layer">
          <KStage width={W} height={H} onMouseDown={onStageMouseDown} onTouchStart={onStageMouseDown}>
            <KLayer listening={false}>{showFrames && <SafeZones zone={zone} W={W} H={H} />}</KLayer>
            <KLayer>
              {layers.map((l) => {
                if (l.hidden || coverActive) return null;
                if (!windowContains(l.t, postTime)) return null;
                const selectable = layerTypes.includes(l.type);
                if (l.type === 'mask') {
                  return (
                    <MaskNode
                      key={l.id}
                      layer={l}
                      W={W}
                      H={H}
                      selectable={selectable}
                      selected={selectedLayerId === l.id && selectable}
                      backdrop={backdrop}
                      guides={guides}
                      onSelect={() => setSelectedLayer(l.id)}
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
                    selected={selectedLayerId === l.id && selectable}
                    hidden={!!editingLayer && editingLayer.id === l.id}
                    guides={guides}
                    onSelect={() => setSelectedLayer(l.id)}
                    onEdit={() => isRef && setEditingLayerId(l.id)}
                    onGuides={setHitGuides}
                    registerNode={(n) => {
                      nodes.current[l.id] = n;
                    }}
                    geom={geomOf(l)}
                    onCommitVariant={commitOnVariant(l)}
                    activeAnchor={activeAnchor}
                  />
                );
              })}
              {layerTypes.length > 0 && (
                <Transformer
                  ref={trRef}
                  keepRatio={!selectedIsMask}
                  enabledAnchors={selectedIsMask ? ALL_ANCHORS : selectedType === 'text' ? TEXT_ANCHORS : CORNER_ANCHORS}
                  rotateEnabled={!selectedIsMask}
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

// 时间轴：标尺 + 视频轨（雪碧图）+ 删除区间（剪辑模块，区间可拖边）/ 音轨行（音频模块：源音轨可选中并画出静音区间（可拖边，HIG-25）、
// BGM / 口播可拖动拉伸、贴纸音轨只读）/
// 图层行（文本模块显示文字图层，字幕模块显示文字 + 遮盖图层，贴纸模块显示贴纸图层；可拖动、拉伸，轨道头可锁定 / 隐藏）。
// 横轴为源时间；图层与音轨的 t 基于剪后时间，显示时用 postToSource 映射。
// 有封面（HIG-9）时最前面多出 N·pps 宽的封面块，正片所有行整体右移（lib/cover 的 timelineX / timelineTime），
// 播放头可以落进封面段（time < 0）；封面期间其余各行画斜纹，表示不叠图层、不放音轨。
// 交互：⌘/Ctrl+滚轮 围绕光标缩放；普通滚轮横向滚动；标尺 / 轨道按下即定位、拖动连续 scrub（pointer capture）；
// 拖动区间 / 图层条 / 音轨条时吸附到 0、时长、播放头、入点与其他区间端点（按住 ⌥ 关闭）。
// 轨道头的名字双击改名（HIG-48）：视频轨改的是视频名（与左栏同一个），其余存进 spec（lib/trackNames），清空恢复自动名。
// 拖放加音轨（HIG-33）：音频面板的素材卡片、或系统里的音频文件拖到时间线上，落点为起点，落在口播行加口播，其余加 BGM（lib/timelineDrop）。
// 拖放加贴纸（HIG-46）：JPG / PNG 文件或贴纸卡片拖上来，加贴纸图层，落点时间起显示到片尾（lib/imageDrop），并切到「贴纸」模块。
// 成片时长 trim.duration（HIG-50）比剪后长时：源片右边接一段「循环补足」斜纹块，横轴按 duration + 多出来的秒数延长；
// 图层 / 音轨条可以排进那段；在那段里 scrub 换算成「第几遍 + 遍内源时刻」交给 player.seek(t, lap)，播放头按成片时刻定位。

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useCoverDuration, useEditor, usePostDuration, usePostTime } from '../../store/editor';
import { player } from '../../lib/player';
import { clamp, lapsFor, postToSource, postTrimDuration, sourceToPost, splitPostTime } from '../../lib/time';
import { layerName } from '../../lib/spec';
import { layerTypesForStep } from '../../lib/steps';
import { resolveTrack, SOURCE_TRACK_ID, sourceVolume, stickerAudioLayers, trackAssetProblem, trackSnapCandidates } from '../../lib/audioTracks';
import { windowRange } from '../../lib/stickerMedia';
import { timelineTime, timelineX } from '../../lib/cover';
import { snapActive, snapValue } from '../../lib/snap';
import { MAX_PPS, MIN_PPS, stepZoom, TIMELINE_ZOOM_EVENT } from '../../lib/transportKeys';
import { IconEye, IconLock } from '../ui/Icons';
import { InlineName } from '../ui/InlineName';
import { audioTrackName, cleanTrackName, sourceAudioLabel, sourceAudioName, TRACK_NAME_MAX } from '../../lib/trackNames';
import { api } from '../../api';
import { isFileDrag, rejectedText, splitByAccept } from '../../lib/fileDrop';
import { dropKind, dropRole, dropWindow, isAssetDrag, parseAssetDrag, ASSET_DRAG_MIME } from '../../lib/timelineDrop';
import { IMAGE_ACCEPT, IMAGE_ACCEPT_TEXT, timelineDropWindow } from '../../lib/imageDrop';
import { addStickerLayers, dropImages } from './stickerDrop';
import { AUDIO_ACCEPT } from '../../pages/AssetsPage';
import { enterDelay, hasAnimation, phaseLengths } from '../../lib/textAnimation';
import type { Asset, AudioRole, AudioSpec, Layer } from '../../types';

/** 系统文件拖进来：上传完成、素材探测就绪后才能加轨，先记下落点。 */
type PendingDrop = { assetId: string; role: AudioRole; start: number; videoId: string };

const LABEL_W = 96;
const SNAP_PX = 6;

/** 封面段在非视频行里的占位斜纹（封面期间不叠图层、不放音轨）。 */
function CoverGap({ width }: { width: number }) {
  return width > 0 ? <div className="tl-cover-gap" style={{ width }} title="封面期间不叠加图层、不放音轨" /> : null;
}

/** 轨道头的眼睛（HIG-33）：关掉 = 隐藏，留在 spec 里、成片不出；再打开即恢复。 */
function EyeButton({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <span className="tl-acts" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button className="btn ghost icon" title={hidden ? '显示（导出时恢复）' : '隐藏（导出时也不出，不删除）'} aria-label={hidden ? '显示' : '隐藏'} aria-pressed={hidden} onClick={onToggle}>
        <IconEye off={hidden} />
      </button>
    </span>
  );
}

/** 轨道头上可双击改名的名字（HIG-48）：清空提交空字符串，由调用方恢复自动名。 */
function TrackName({ value, display, label, onSave }: { value: string; display?: string; label: string; onSave: (name: string) => Promise<boolean> | boolean | void }) {
  return <InlineName className="lname" inputClassName="lname-input" value={value} display={display} label={label} allowEmpty maxLength={TRACK_NAME_MAX} onSave={onSave} />;
}

/** 音频模块的源音轨行：状态（静音 / 音量 / 隐藏）+ 静音区间（source_mute，由调用方画进 children）。点行选中，删左 / 删右 / I·O 作用于它。 */
function SourceAudioRow({ audio, hasAudio, onToggleHidden, onRename, width, offset, scrub, selected, onSelect, children }: { audio: AudioSpec | null | undefined; hasAudio: boolean; onToggleHidden: () => void; onRename: (name: string) => void; width: number; offset: number; scrub: ReturnType<typeof useScrub>['handlers']; selected: boolean; onSelect: () => void; children?: React.ReactNode }) {
  const volume = sourceVolume(audio);
  const hidden = !!audio?.source_hidden;
  const muted = !hasAudio || volume === 0 || hidden;
  const label = sourceAudioLabel(audio, hasAudio);
  return (
    <div className={`tl-row tl-audio ${muted ? 'muted' : ''} ${hidden ? 'hidden' : ''} ${selected ? 'selected' : ''}`} onClick={hasAudio ? onSelect : undefined}>
      <div className="lbl" title={hasAudio ? `${label}：选中后按 Q / W 或 I、O 静音一段原声（画面不动）` : label}>
        <TrackName value={sourceAudioName(audio)} display={label} label="源音轨名" onSave={onRename} />
        {hasAudio && <EyeButton hidden={hidden} onToggle={onToggleHidden} />}
      </div>
      <div className="body" {...scrub}>
        <CoverGap width={offset} />
        {hasAudio && <div className={`tl-bar audio all ${volume === 0 || hidden ? 'muted' : ''} ${selected ? 'selected' : ''}`} style={{ left: offset, width, cursor: 'default', opacity: volume === 0 || hidden ? 0.35 : 0.45 + 0.55 * volume, pointerEvents: 'none' }} />}
        {hasAudio && volume > 0 && !hidden && children}
      </div>
    </div>
  );
}

/** 封面块的缩略图：视频用首帧，图片用原图。 */
function coverThumb(asset: Asset | undefined): string | undefined {
  if (!asset) return undefined;
  return asset.kind === 'video' ? asset.poster_url ?? undefined : asset.url;
}

function useWidth(ref: React.RefObject<HTMLDivElement>) {
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = () => setW(el.clientWidth);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

type Drag = { kind: 'cut-l' | 'cut-r' | 'cut-move' | 'bar-l' | 'bar-r' | 'bar-move' | 'track-l' | 'track-r' | 'track-move' | 'mute-l' | 'mute-r' | 'mute-move'; index: number; startX: number; orig: [number, number] };

/** 标尺 / 轨道上的 scrub：按下暂停并定位，拖动时用 rAF 节流连续定位。seekAt 负责把横坐标换算成播放头位置。 */
function useScrub(seekAt: (clientX: number) => void) {
  const [scrubbing, setScrubbing] = useState(false);
  const active = useRef(false);
  const raf = useRef(0);
  const pending = useRef<number | null>(null);

  const flush = () => {
    raf.current = 0;
    if (pending.current !== null && active.current) seekAt(pending.current);
    pending.current = null;
  };
  const onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    active.current = true;
    player.pause();
    seekAt(e.clientX);
    setScrubbing(true);
  };
  const onPointerMove = (e: RPointerEvent<HTMLElement>) => {
    if (!active.current) return;
    pending.current = e.clientX;
    if (!raf.current) raf.current = requestAnimationFrame(flush);
  };
  const onPointerUp = (e: RPointerEvent<HTMLElement>) => {
    if (!active.current) return;
    active.current = false;
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    }
    seekAt(e.clientX);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setScrubbing(false);
  };
  return { scrubbing, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}

export function Timeline() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerW = useWidth(scrollRef);
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const step = useEditor((s) => s.step);
  const time = useEditor((s) => s.time);
  const lap = useEditor((s) => s.lap);
  const postTime = usePostTime();
  const outputLen = usePostDuration();
  const playing = useEditor((s) => s.playing);
  const inPoint = useEditor((s) => s.inPoint);
  const selectedRange = useEditor((s) => s.selectedRangeIndex);
  const setSelectedRange = useEditor((s) => s.setSelectedRange);
  const updateRemoveRange = useEditor((s) => s.updateRemoveRange);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const setSelectedLayer = useEditor((s) => s.setSelectedLayer);
  const updateLayer = useEditor((s) => s.updateLayer);
  const renameLayer = (l: Layer, name: string) => {
    if (cleanTrackName(name) !== cleanTrackName(l.name)) updateLayer(l.id, { name: cleanTrackName(name) });
  };
  const assets = useEditor((s) => s.assets);
  const coverAsset = useEditor((s) => {
    const cover = s.currentVideoId ? s.specs[s.currentVideoId]?.cover : null;
    return cover ? s.assets.find((a) => a.id === cover.asset_id) : undefined;
  });
  const preroll = useCoverDuration();
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const setSelectedTrack = useEditor((s) => s.setSelectedTrack);
  const updateAudioTrack = useEditor((s) => s.updateAudioTrack);
  const toggleTrackHidden = useEditor((s) => s.toggleTrackHidden);
  const toggleSourceHidden = useEditor((s) => s.toggleSourceHidden);
  const renameAudioTrack = useEditor((s) => s.renameAudioTrack);
  const renameSourceAudio = useEditor((s) => s.renameSourceAudio);
  const renameVideo = useEditor((s) => s.renameVideo);
  const selectedMute = useEditor((s) => s.selectedMuteIndex);
  const setSelectedMute = useEditor((s) => s.setSelectedMute);
  const updateSourceMute = useEditor((s) => s.updateSourceMute);
  const timelinePps = useEditor((s) => s.timelinePps);
  const setTimelinePps = useEditor((s) => s.setTimelinePps);
  const setTimelineViewPps = useEditor((s) => s.setTimelineViewPps);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dragVal, setDragVal] = useState<[number, number] | null>(null);
  const [snapX, setSnapX] = useState<number | null>(null);
  const dragRef = useRef<[number, number] | null>(null);
  const addAudioTrack = useEditor((s) => s.addAudioTrack);
  const setStep = useEditor((s) => s.setStep);
  const setToast = useEditor((s) => s.setToast);
  const loadAssets = useEditor((s) => s.loadAssets);
  const currentVideoId = useEditor((s) => s.currentVideoId);
  const [dropHint, setDropHint] = useState<{ x: number; role: AudioRole; post: number; kind: 'sticker' | 'audio' } | null>(null);
  const [pendingDrops, setPendingDrops] = useState<PendingDrop[]>([]);

  const duration = Math.max(0.1, video?.duration ?? 0);
  const remove = spec?.trim.remove ?? [];
  const postLen = postTrimDuration(duration, remove);
  // 成片时长（trim.duration，HIG-50）：比剪后长的部分接在源片右边（循环补足块），横轴按它延长；图层 / 音轨的时段上限也是它
  const postDuration = Math.max(outputLen, 0);
  const extra = Math.max(0, postDuration - postLen);
  const axisLen = duration + extra;
  const fitPps = Math.max(1, containerW - LABEL_W - 2) / (axisLen + preroll);
  const pps = clamp(timelinePps ?? fitPps, MIN_PPS, MAX_PPS);
  const trackW = axisLen * pps;
  // 封面块宽度：正片各行的横坐标都要加上它
  const off = preroll * pps;
  /** 横轴时刻（源时间，超过 duration 的部分是循环补足段）→ 成片时刻。 */
  const axisToPost = (t: number) => (t <= duration ? sourceToPost(t, remove) : postLen + (t - duration));
  // 播放头在横轴上的位置：第 0 遍就是源时刻，之后的遍数落在循环补足段里
  const axisTime = lap === 0 ? time : duration + Math.max(0, postTime - postLen);
  const headX = timelineX(axisTime, preroll, pps);
  const trimStep = step === 'trim';
  const audioStep = step === 'audio';
  const tracks = spec?.audio?.tracks ?? [];
  const mutes = spec?.audio?.source_mute ?? [];
  const stickerAudio = audioStep ? stickerAudioLayers(spec?.layers ?? [], assets) : [];
  const layerTypes = layerTypesForStep(step);
  const layerType = layerTypes[0] ?? null;
  // 本模块管理的图层行；保留在 spec.layers 里的下标，拖动时按它写回
  const layerRows = layerType ? (spec?.layers ?? []).map((l, i) => ({ l, i })).filter((r) => layerTypes.includes(r.l.type)) : [];
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const prerollRef = useRef(preroll);
  prerollRef.current = preroll;
  const axisTimeRef = useRef(axisTime);
  axisTimeRef.current = axisTime;

  // ---- 缩放：围绕锚点保持光标下的时间不动 ----
  const zoomAnchor = useRef<{ time: number; offsetX: number } | null>(null);
  const zoomTo = (next: number, anchor: { time: number; offsetX: number }) => {
    const n = clamp(next, MIN_PPS, MAX_PPS);
    if (Math.abs(n - ppsRef.current) < 1e-6) return;
    zoomAnchor.current = anchor;
    setTimelinePps(n);
  };
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    zoomAnchor.current = null;
    el.scrollLeft = Math.max(0, timelineX(a.time, prerollRef.current, pps) - a.offsetX);
  }, [pps]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) return; // 交给浏览器
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const cur = ppsRef.current;
        const rect = el.getBoundingClientRect();
        const offsetX = e.clientX - rect.left - LABEL_W;
        zoomTo(cur * Math.exp(-e.deltaY * 0.002), { time: (offsetX + el.scrollLeft) / cur - prerollRef.current, offsetX });
        return;
      }
      // 普通滚轮：横向滚动（轨道没有横向溢出时保留浏览器默认的纵向滚动）
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth + 1) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTimelinePps]);

  // 有效 px/s 写回 store：Transport 里的滑杆和「px/s」读它（适应模式下 pps 由容器宽算出，只有这里知道）
  useEffect(() => {
    setTimelineViewPps(pps);
  }, [pps, setTimelineViewPps]);

  // ---- 缩放事件：键盘 ⌘= / ⌘-（detail 为 ±1，围绕播放头，HIG-30）；Transport 滑杆（detail 为 { pps }，围绕视口中心） ----
  useEffect(() => {
    const onZoom = (e: Event) => {
      const el = scrollRef.current;
      if (!el) return;
      const detail = (e as CustomEvent<1 | -1 | { pps: number }>).detail;
      const cur = ppsRef.current;
      if (typeof detail === 'object') {
        const viewW = el.clientWidth - LABEL_W;
        const center = (el.scrollLeft + viewW / 2) / cur - prerollRef.current;
        zoomTo(detail.pps, { time: center, offsetX: viewW / 2 });
        return;
      }
      const t = axisTimeRef.current;
      const offsetX = Math.min(Math.max(0, timelineX(t, prerollRef.current, cur) - el.scrollLeft), el.clientWidth - LABEL_W);
      zoomTo(stepZoom(cur, detail), { time: t, offsetX });
    };
    window.addEventListener(TIMELINE_ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(TIMELINE_ZOOM_EVENT, onZoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTimelinePps]);

  // ---- 播放时翻页式跟随 ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const viewW = el.clientWidth - LABEL_W;
    const x = headX;
    if (x < el.scrollLeft || x > el.scrollLeft + viewW) el.scrollLeft = Math.max(0, x - viewW * 0.2);
  }, [headX, playing]);

  /** 横坐标 → 横轴时刻（源时间；循环补足段延伸到 duration + extra），夹到 [-封面, axisLen]。 */
  const xToTime = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - LABEL_W + el.scrollLeft;
    return timelineTime(x, prerollRef.current, ppsRef.current, axisLen);
  };
  /** 定位播放头：源片段里是第 0 遍；循环补足段里换算成第几遍 + 遍内源时刻（HIG-50）。 */
  const seekAt = (clientX: number) => {
    const t = xToTime(clientX);
    if (t <= duration) {
      player.seek(t, 0);
      return;
    }
    const { lap: n, rem } = splitPostTime(axisToPost(t), postLen, lapsFor(postDuration, postLen));
    player.seek(postToSource(rem, remove), n);
  };
  const scrub = useScrub(seekAt);

  // ---- 拖放加音轨（HIG-33）----
  const dropPoint = (e: React.DragEvent<HTMLElement>) => {
    const src = Math.max(0, xToTime(e.clientX));
    const rowRole = (e.target as HTMLElement).closest<HTMLElement>('[data-drop-role]')?.dataset.dropRole as AudioRole | undefined;
    return { x: off + src * pps, role: dropRole(rowRole), post: Math.min(axisToPost(src), postDuration) };
  };
  const addDropped = (assetId: string, role: AudioRole, start: number): boolean => {
    const asset = useEditor.getState().assets.find((a) => a.id === assetId);
    const t = dropWindow({ start, role, postDuration, mediaDuration: asset?.duration });
    if (addAudioTrack(assetId, role, { t }) === null) return false;
    if (!audioStep) setStep('audio');
    return true;
  };
  const onDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!video || !spec || (!isAssetDrag(e.dataTransfer.types) && !isFileDrag(e.dataTransfer.types))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const p = { ...dropPoint(e), kind: dropKind(e.dataTransfer.types, e.dataTransfer.items) };
    setDropHint((h) => (h && Math.abs(h.x - p.x) < 0.5 && h.role === p.role && h.kind === p.kind ? h : p));
  };
  const onDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(null);
  };
  const onDrop = (e: React.DragEvent<HTMLElement>) => {
    setDropHint(null);
    if (!video || !spec) return;
    const card = parseAssetDrag(e.dataTransfer.getData(ASSET_DRAG_MIME));
    const files = isFileDrag(e.dataTransfer.types) ? Array.from(e.dataTransfer.files) : [];
    if (!card && !files.length) return;
    e.preventDefault();
    const { role, post } = dropPoint(e);
    const stickerWindow = () => timelineDropWindow(post, postDuration);
    if (card) {
      if (card.type === 'sticker') {
        const asset = useEditor.getState().assets.find((a) => a.id === card.id);
        if (!asset || (asset.status ?? 'ready') !== 'ready') setToast('素材还在处理中，就绪后再拖进来');
        else addStickerLayers([asset], () => ({ t: stickerWindow() }));
        return;
      }
      if (card.type !== 'audio') return;
      if (!addDropped(card.id, role, post)) setToast('素材还在处理中，就绪后再拖进来');
      return;
    }
    // 图片加贴纸，音频加音轨；两样都不是的一起提示
    const images = splitByAccept(files, IMAGE_ACCEPT);
    const { accepted, rejected } = splitByAccept(images.rejected, AUDIO_ACCEPT);
    if (images.accepted.length) void dropImages(images.accepted, () => ({ t: stickerWindow() }));
    const skipped = rejectedText(rejected, `mp3 / wav / m4a 或 ${IMAGE_ACCEPT_TEXT}`);
    if (!accepted.length) {
      if (skipped) setToast(skipped);
      return;
    }
    const videoId = video.id;
    setToast(`正在上传 ${accepted.length} 个音频…${skipped ? `（${skipped}）` : ''}`);
    void (async () => {
      try {
        const uploaded = await api.uploadAssets('audio', accepted);
        await loadAssets();
        // 多个文件依次排在落点之后：各自从上一个的结尾开始（时长未知时同一起点）
        let start = post;
        const pend: PendingDrop[] = [];
        for (const a of uploaded) {
          pend.push({ assetId: a.id, role, start, videoId });
          if (a.duration) start = Math.min(start + a.duration, Math.max(0, postDuration - 0.1));
        }
        setPendingDrops((p) => [...p, ...pend]);
        setToast(null);
      } catch (err) {
        setToast(`上传失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };
  // 上传的素材探测就绪后加轨；处理失败的提示一下；期间换了视频就不加到别的视频上
  useEffect(() => {
    if (!pendingDrops.length) return;
    const left: PendingDrop[] = [];
    for (const p of pendingDrops) {
      const asset = assets.find((a) => a.id === p.assetId);
      const status = asset?.status ?? 'ready';
      if (!asset || status === 'preparing') {
        if (asset || p.videoId === currentVideoId) left.push(p);
        continue;
      }
      if (status === 'failed') setToast(`「${asset.name}」处理失败，没有加轨`);
      else if (p.videoId !== currentVideoId) setToast(`「${asset.name}」已上传；已切换视频，没有自动加轨`);
      else addDropped(p.assetId, p.role, p.start);
    }
    if (left.length !== pendingDrops.length) setPendingDrops(left);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, pendingDrops, currentVideoId]);

  // ---- 拖动区间 / 图层条（pointer capture + 吸附）----
  const startDrag = (e: RPointerEvent<HTMLElement>, d: Drag) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDrag(d);
    setDragVal(d.orig);
    dragRef.current = d.orig;
    const isBar = d.kind.startsWith('bar');
    const isTrack = d.kind.startsWith('track');
    const isMute = d.kind.startsWith('mute');
    const postAxis = isBar || isTrack || isMute;
    const maxT = postAxis ? postDuration : duration;
    // 吸附候选：源时间（区间）或剪后时间（图层条、音轨条）
    const head = Math.max(0, time); // 封面段里的播放头按正片开头算
    const candidates: number[] = isMute
      ? [0, postDuration, postTime, ...tracks.flatMap((t) => (t.t === 'all' ? [] : t.t)), ...mutes.flatMap((r, i) => (i === d.index ? [] : r))]
      : isTrack
      ? trackSnapCandidates({ tracks, layers: spec?.layers ?? [], excludeTrackId: tracks[d.index]?.id ?? '', postDuration, playhead: postTime })
      : isBar
        ? [0, postDuration, postTime, ...(spec?.layers ?? []).flatMap((l, i) => (i === d.index || l.t === 'all' ? [] : l.t))]
        : [0, duration, head, ...(inPoint !== null ? [inPoint] : []), ...remove.flatMap((r, i) => (i === d.index ? [] : r))];
    const threshold = SNAP_PX / pps;

    const onMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - d.startX) / pps;
      let [a, b] = d.orig;
      let hit: number | null = null;
      const snap = snapActive(useEditor.getState().snapEnabled, ev.altKey);
      if (d.kind.endsWith('-l')) {
        a = a + dt;
        if (snap) ({ value: a, hit } = snapValue(a, candidates, threshold));
        a = clamp(a, 0, b - 0.05);
      } else if (d.kind.endsWith('-r')) {
        b = b + dt;
        if (snap) ({ value: b, hit } = snapValue(b, candidates, threshold));
        b = clamp(b, a + 0.05, maxT);
      } else {
        const len = b - a;
        a = a + dt;
        if (snap) {
          const ra = snapValue(a, candidates, threshold);
          const rb = snapValue(a + len, candidates, threshold);
          const da = ra.hit === null ? Infinity : Math.abs(ra.hit - a);
          const db = rb.hit === null ? Infinity : Math.abs(rb.hit - (a + len));
          if (da <= db && ra.hit !== null) {
            a = ra.value;
            hit = ra.hit;
          } else if (rb.hit !== null) {
            a = rb.value - len;
            hit = rb.hit;
          }
        }
        a = clamp(a, 0, maxT - len);
        b = a + len;
      }
      setDragVal([a, b]);
      dragRef.current = [a, b];
      setSnapX(hit === null ? null : off + (postAxis ? postToSource(hit, remove) : hit) * pps);
    };
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      const val = dragRef.current;
      if (val) {
        const [a, b] = val;
        if (d.kind.startsWith('cut')) updateRemoveRange(d.index, a, b);
        else if (isMute) {
          if (a !== d.orig[0] || b !== d.orig[1]) updateSourceMute(d.index, Math.round(a * 100) / 100, Math.round(b * 100) / 100);
        } else if (isTrack) {
          // 只点了一下没拖：不写 spec，免得多出一条空的撤销记录
          const track = tracks[d.index];
          if (track && (a !== d.orig[0] || b !== d.orig[1])) updateAudioTrack(track.id, { t: [Math.round(a * 100) / 100, Math.round(b * 100) / 100] });
        } else {
          const layer = spec?.layers[d.index];
          if (layer) updateLayer(layer.id, { t: [Math.round(a * 100) / 100, Math.round(b * 100) / 100] });
        }
      }
      setDrag(null);
      setDragVal(null);
      setSnapX(null);
      dragRef.current = null;
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  // ---- 标尺刻度：按 pps 选步长 ----
  const tickStep = pps >= 160 ? 0.5 : pps >= 60 ? 1 : pps >= 30 ? 2 : 5;
  const tickCount = Math.floor(axisLen / tickStep + 1e-6);
  const ticks: { t: number; label: string; minor: boolean }[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const t = i * tickStep;
    const minor = tickStep === 0.5 && i % 2 === 1;
    ticks.push({ t, label: minor ? '' : tickStep < 1 ? String(t) : String(Math.round(t)), minor });
  }

  // ---- 雪碧图：按 interval·pps / tile_width 缩放，保证高倍缩放下不留缝 ----
  const sprite = video?.sprite;
  const rowH = 64;
  const tileSlot = sprite ? sprite.interval * pps : 0;
  const spriteScale = sprite ? Math.max(rowH / sprite.tile_height, tileSlot / sprite.tile_width) : 1;
  const tileW = sprite ? sprite.tile_width * spriteScale : 0;
  const tileH = sprite ? sprite.tile_height * spriteScale : 0;
  const tiles: number[] = [];
  if (sprite) for (let i = 0; i < sprite.count; i++) tiles.push(i);

  const cutVal = (i: number, r: [number, number]) => (drag && drag.kind.startsWith('cut') && drag.index === i && dragVal ? dragVal : r);
  const barVal = (i: number, l: Layer): [number, number] | 'all' => {
    if (l.t === 'all') return 'all';
    return drag && drag.kind.startsWith('bar') && drag.index === i && dragVal ? dragVal : l.t;
  };

  return (
    <div className="timeline" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className={`tl-scroll ${scrub.scrubbing ? 'scrubbing' : ''} ${dropHint ? 'drop-over' : ''}`} ref={scrollRef}>
        <div className="tl-inner" style={{ width: off + trackW + LABEL_W }}>
          <div className="tl-row" style={{ height: 20 }}>
            <div className="lbl mono" style={{ height: 20, fontSize: 10 }}>{trimStep ? '秒' : '剪后'}</div>
            <div className="tl-ruler" {...scrub.handlers}>
              {off > 0 && <div className="tl-cover-mark" style={{ width: off }}>封面</div>}
              {ticks.map((k) => (
                <div key={k.t} className={`tick ${k.minor ? 'minor' : ''}`} style={{ left: off + k.t * pps }}>
                  {k.label}
                </div>
              ))}
            </div>
          </div>

          <div className="tl-row tl-video">
            <div className="lbl" title="视频轨：双击改视频名（与左栏同一个名字）">
              {video ? <TrackName value={video.name} label="视频名" onSave={(name) => (cleanTrackName(name) ? renameVideo(video.id, name) : false)} /> : <span className="lname">视频</span>}
            </div>
            <div className="body" {...scrub.handlers}>
              {off > 0 && (
                <div
                  className="tl-cover"
                  style={{ width: off, backgroundImage: coverThumb(coverAsset) ? `url("${coverThumb(coverAsset)}")` : undefined }}
                  title={`封面 ${preroll.toFixed(1)}s（在右侧「封面」里更换或移除）`}
                >
                  <span>封面 {preroll.toFixed(1)}s</span>
                </div>
              )}
              {sprite &&
                tiles.map((i) => (
                  <div
                    key={i}
                    className="tl-sprite"
                    style={{
                      left: off + i * tileSlot,
                      width: tileSlot,
                      backgroundImage: `url("${sprite.url}")`,
                      backgroundSize: `${sprite.columns * tileW}px auto`,
                      backgroundPosition: `-${(i % sprite.columns) * tileW}px ${-Math.floor(i / sprite.columns) * tileH + (rowH - tileH) / 2}px`,
                    }}
                  />
                ))}
              {remove.map((r, i) => {
                const [a, b] = cutVal(i, r);
                return (
                  <div
                    key={i}
                    className={`tl-cut ${selectedRange === i ? 'selected' : ''}`}
                    style={{ left: off + a * pps, width: Math.max(2, (b - a) * pps), opacity: trimStep ? 1 : 0.5, pointerEvents: trimStep ? 'auto' : 'none' }}
                    onPointerDown={(e) => {
                      setSelectedRange(i);
                      startDrag(e, { kind: 'cut-move', index: i, startX: e.clientX, orig: r });
                    }}
                    title={`删除 ${a.toFixed(2)}s – ${b.toFixed(2)}s`}
                  >
                    {trimStep && (
                      <>
                        <div className="edge l" onPointerDown={(e) => { setSelectedRange(i); startDrag(e, { kind: 'cut-l', index: i, startX: e.clientX, orig: r }); }} />
                        <div className="edge r" onPointerDown={(e) => { setSelectedRange(i); startDrag(e, { kind: 'cut-r', index: i, startX: e.clientX, orig: r }); }} />
                      </>
                    )}
                  </div>
                );
              })}
              {inPoint !== null && trimStep && <div className="tl-inpoint" style={{ left: off + inPoint * pps }} title="入点" />}
              {extra > 0 && (
                <div
                  className="tl-loop-fill"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: off + duration * pps,
                    width: extra * pps,
                    borderLeft: '2px solid var(--accent)',
                    background: 'repeating-linear-gradient(135deg, rgba(127, 127, 127, 0.28) 0 4px, rgba(127, 127, 127, 0.08) 4px 8px)',
                    color: 'var(--ink-soft, #ccc)',
                    fontSize: 10,
                    lineHeight: '14px',
                    padding: '3px 0 0 4px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    pointerEvents: 'none',
                    zIndex: 1,
                  }}
                  title={`成片时长 ${postDuration.toFixed(1)}s 比剪后时长 ${postLen.toFixed(1)}s 长：保留段从头再放，补足 ${extra.toFixed(1)}s（大字报的滚动 / 朗读比源片长）`}
                >
                  循环补足 {extra.toFixed(1)}s
                </div>
              )}
            </div>
          </div>

          {audioStep && (
            <SourceAudioRow
              audio={spec?.audio}
              hasAudio={!!video?.has_audio}
              onToggleHidden={toggleSourceHidden}
              onRename={renameSourceAudio}
              width={trackW}
              offset={off}
              scrub={scrub.handlers}
              selected={selectedTrackId === SOURCE_TRACK_ID}
              onSelect={() => setSelectedTrack(SOURCE_TRACK_ID)}
            >
              {mutes.map((m, i) => {
                const [pa, pb] = drag && drag.kind.startsWith('mute') && drag.index === i && dragVal ? dragVal : m;
                const left = off + postToSource(pa, remove) * pps;
                const right = off + postToSource(pb, remove) * pps;
                return (
                  <div
                    key={i}
                    className={`tl-cut tl-mute ${selectedMute === i ? 'selected' : ''}`}
                    style={{ left, width: Math.max(2, right - left) }}
                    title={`原声静音 ${pa.toFixed(2)}s – ${pb.toFixed(2)}s（剪后时间；Delete 删除）`}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => {
                      setSelectedMute(i);
                      startDrag(e, { kind: 'mute-move', index: i, startX: e.clientX, orig: m });
                    }}
                  >
                    <div className="edge l" onPointerDown={(e) => { setSelectedMute(i); startDrag(e, { kind: 'mute-l', index: i, startX: e.clientX, orig: m }); }} />
                    <div className="edge r" onPointerDown={(e) => { setSelectedMute(i); startDrag(e, { kind: 'mute-r', index: i, startX: e.clientX, orig: m }); }} />
                  </div>
                );
              })}
              {inPoint !== null && selectedTrackId === SOURCE_TRACK_ID && <div className="tl-inpoint" style={{ left: off + inPoint * pps }} title="静音入点" />}
            </SourceAudioRow>
          )}
          {audioStep &&
            tracks.map((t, i) => {
              const r = resolveTrack(t);
              const all = r.t === 'all';
              const win = windowRange(r.t, postDuration);
              const [pa, pb] = drag && drag.kind.startsWith('track') && drag.index === i && dragVal ? dragVal : win;
              const left = off + postToSource(pa, remove) * pps;
              const right = off + postToSource(pb, remove) * pps;
              const sel = selectedTrackId === t.id;
              const name = audioTrackName(t, assets);
              const problem = trackAssetProblem(t, assets);
              const hidden = !!t.hidden;
              return (
                <div key={t.id} data-drop-role={r.role} className={`tl-row tl-audio ${sel ? 'selected' : ''} ${hidden ? 'hidden' : ''} ${problem === 'missing' ? 'broken' : ''}`} onClick={() => setSelectedTrack(t.id)}>
                  <div className="lbl" title={`${r.role === 'voice' ? '口播' : 'BGM'} · ${name}${r.align === 'source' ? '（对齐源时间轴：随剪辑一起裁）' : ''}${hidden ? '（已隐藏，导出时不混入）' : ''}`}>
                    <span className={`role ${r.role}`} style={{ fontSize: 10, flex: 'none' }}>{r.role === 'voice' ? '口播' : 'BGM'}{r.align === 'source' ? ' · 源' : ''}</span>
                    <TrackName value={name} label="音轨名" onSave={(v) => renameAudioTrack(t.id, v)} />
                    <EyeButton hidden={hidden} onToggle={() => toggleTrackHidden(t.id)} />
                  </div>
                  <div className="body" {...scrub.handlers}>
                    <CoverGap width={off} />
                    <div
                      className={`tl-bar audio ${r.role} ${sel ? 'selected' : ''} ${all ? 'all' : ''} ${r.volume === 0 || hidden ? 'muted' : ''} ${hidden ? 'hidden' : ''}`}
                      style={{ left, width: Math.max(4, right - left), cursor: all ? 'default' : 'grab' }}
                      onPointerDown={(e) => {
                        setSelectedTrack(t.id);
                        if (all) {
                          e.stopPropagation();
                          return;
                        }
                        startDrag(e, { kind: 'track-move', index: i, startX: e.clientX, orig: win });
                      }}
                    >
                      {all ? '全程' : `${pa.toFixed(1)}s – ${pb.toFixed(1)}s`}
                      {r.loop ? ' ↻' : ''}
                      {r.volume !== 1 ? ` ${Math.round(r.volume * 100)}%` : ''}
                      {hidden ? ' · 已隐藏' : problem === 'missing' ? ' · 素材已失效，导出会跳过' : problem === 'not-ready' ? ' · 素材处理中' : ''}
                      {!all && (
                        <>
                          <div className="edge l" onPointerDown={(e) => { setSelectedTrack(t.id); startDrag(e, { kind: 'track-l', index: i, startX: e.clientX, orig: win }); }} />
                          <div className="edge r" onPointerDown={(e) => { setSelectedTrack(t.id); startDrag(e, { kind: 'track-r', index: i, startX: e.clientX, orig: win }); }} />
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          {audioStep && tracks.length === 0 && (
            <div className="tl-row" style={{ height: 30 }}>
              <div className="lbl">BGM / 口播</div>
              <div className="body hint" style={{ padding: '6px 8px' }}>还没有 BGM / 口播：把右侧「音频素材」或电脑里的音频文件拖到这里，或点右侧「+ BGM / + 口播」。</div>
            </div>
          )}
          {stickerAudio.map((l) => {
            const [pa, pb] = windowRange(l.t, postDuration);
            const left = off + postToSource(pa, remove) * pps;
            const right = off + postToSource(pb, remove) * pps;
            const on = !!l.mix_audio && !l.hidden;
            const name = layerName(l, assets);
            return (
              <div key={l.id} className={`tl-row tl-audio ${on ? '' : 'muted'}`}>
                <div className="lbl" title={`${name}（贴纸音轨，时段在贴纸模块里改${l.hidden ? '；贴纸图层已隐藏，声音跟着不出' : ''}）`}>
                  <span className="role sticker" style={{ fontSize: 10, flex: 'none' }}>贴纸</span>
                  <TrackName value={name} label="贴纸名" onSave={(v) => renameLayer(l, v)} />
                </div>
                <div className="body" {...scrub.handlers}>
                  <CoverGap width={off} />
                  <div className={`tl-bar audio sticker ${l.t === 'all' ? 'all' : ''} ${on ? '' : 'muted'}`} style={{ left, width: Math.max(4, right - left), cursor: 'default', pointerEvents: 'none' }}>
                    {l.hidden ? '图层已隐藏' : on ? '合成' : '不合成'} · {l.t === 'all' ? '全程' : `${pa.toFixed(1)}s – ${pb.toFixed(1)}s`}
                  </div>
                </div>
              </div>
            );
          })}

          {layerRows.map(({ l, i }) => {
            const v = barVal(i, l);
            const all = v === 'all';
            const [pa, pb] = all ? [0, postDuration] : v;
            const left = off + postToSource(pa, remove) * pps;
            const right = off + postToSource(pb, remove) * pps;
            const sel = selectedLayerId === l.id;
            const hidden = !!l.hidden;
            const locked = !!l.locked;
            return (
              <div key={l.id} className={`tl-row tl-layer ${sel ? 'selected' : ''} ${hidden ? 'hidden' : ''}`}>
                <div className="lbl" title={`${layerName(l, assets)} · ${all ? '全程' : '区间'}`}>
                  <TrackName value={layerName(l, assets)} label="图层名" onSave={(v) => renameLayer(l, v)} />
                  <span className="tl-acts" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                    <button className="btn ghost icon" title={hidden ? '显示（导出时恢复）' : '隐藏（导出时也不出，不删除）'} aria-label={hidden ? '显示' : '隐藏'} aria-pressed={hidden} onClick={() => updateLayer(l.id, { hidden: !hidden })}>
                      <IconEye off={hidden} />
                    </button>
                    <button className="btn ghost icon" title="锁定 / 解锁" onClick={() => updateLayer(l.id, { locked: !locked }, false)}>
                      <IconLock open={!locked} />
                    </button>
                  </span>
                </div>
                <div className="body" {...scrub.handlers}>
                  <CoverGap width={off} />
                  <div
                    className={`tl-bar ${l.type === 'mask' ? 'mask' : ''} ${sel ? 'selected' : ''} ${all ? 'all' : ''} ${locked ? 'locked' : ''}`}
                    style={{ left, width: Math.max(4, right - left), cursor: all || locked ? 'default' : 'grab' }}
                    onPointerDown={(e) => {
                      setSelectedLayer(l.id);
                      if (all || locked) {
                        e.stopPropagation();
                        return;
                      }
                      startDrag(e, { kind: 'bar-move', index: i, startX: e.clientX, orig: v as [number, number] });
                    }}
                  >
                    {l.type === 'text' && hasAnimation(l.animation) && (() => {
                      // 入场 / 出场段（HIG-40）：按剪后时长近似画宽，时段里有删除区间时略有偏差；入场延迟（HIG-44）让入场段右移
                      const [di, dout] = phaseLengths(l.animation, pb - pa);
                      const dl = enterDelay(l.animation, pb - pa);
                      const px = Math.max(4, right - left) / Math.max(1e-6, pb - pa);
                      return (
                        <>
                          {di > 0 && <span className="tl-anim in" style={{ left: dl * px, width: di * px }} title={dl > 0 ? `入场 ${di.toFixed(2)}s（延迟 ${dl.toFixed(2)}s）` : `入场 ${di.toFixed(2)}s`} />}
                          {dout > 0 && <span className="tl-anim out" style={{ width: dout * px }} title={`出场 ${dout.toFixed(2)}s`} />}
                        </>
                      );
                    })()}
                    {all ? '全程' : `${pa.toFixed(1)}s – ${pb.toFixed(1)}s`}
                    {!all && !locked && (
                      <>
                        <div className="edge l" onPointerDown={(e) => { setSelectedLayer(l.id); startDrag(e, { kind: 'bar-l', index: i, startX: e.clientX, orig: v as [number, number] }); }} />
                        <div className="edge r" onPointerDown={(e) => { setSelectedLayer(l.id); startDrag(e, { kind: 'bar-r', index: i, startX: e.clientX, orig: v as [number, number] }); }} />
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {layerType && layerRows.length === 0 && (
            <div className="tl-row" style={{ height: 30 }}>
              <div className="lbl">{step === 'subtitle' ? '字幕' : step === 'localize' ? '译文字幕' : layerType === 'text' ? '文字' : '贴纸'}</div>
              <div className="body hint" style={{ padding: '6px 8px' }}>
                {step === 'subtitle'
                  ? '还没有字幕，在右侧选择 .srt 文件导入；要遮住画面里的原字幕，在右侧「遮盖原字幕」里添加。'
                  : step === 'localize'
                    ? '还没有译文字幕，在右侧生成语言版本后「套用」，字幕层和配音轨会一起加进来。'
                    : layerType === 'text'
                      ? '还没有文字图层，在右侧添加文字或标题模板；字幕请到顶栏「字幕」模块导入。'
                      : '还没有贴纸，在右侧素材里点选添加，或把 JPG / PNG 拖到这里 / 画布上。'}
              </div>
            </div>
          )}

          {snapX !== null && <div className="tl-snap" style={{ left: LABEL_W + snapX }} />}
          {dropHint && (
            <div className="tl-drop" style={{ left: LABEL_W + dropHint.x }}>
              <span className="tl-drop-tip">
                加为{dropHint.kind === 'sticker' ? '贴纸' : dropHint.role === 'voice' ? '口播' : ' BGM'} · {dropHint.post.toFixed(1)}s
              </span>
            </div>
          )}
          <div className="tl-playhead" style={{ left: LABEL_W + headX }}>
            <div className="grip" {...scrub.handlers} title="拖动定位" />
          </div>
        </div>
      </div>
    </div>
  );
}

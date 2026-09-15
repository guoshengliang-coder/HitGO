// 时间轴：标尺 + 视频轨（雪碧图）+ 删除区间（步骤 1 可拖边）/ 图层行（步骤 2 可拖动、拉伸，轨道头可锁定 / 隐藏）。
// 横轴为源时间；图层 t 基于剪后时间，显示时用 postToSource 映射。
// 交互：⌘/Ctrl+滚轮 围绕光标缩放；普通滚轮横向滚动；标尺 / 轨道按下即定位、拖动连续 scrub（pointer capture）；
// 拖动区间 / 图层条时吸附到 0、时长、播放头、入点与其他区间端点（按住 ⌥ 关闭）。

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useEditor } from '../../store/editor';
import { player } from '../../lib/player';
import { clamp, postToSource, postTrimDuration, sourceToPost } from '../../lib/time';
import { layerName } from '../../lib/spec';
import { resolveTrack, sourceVolume } from '../../lib/audioTracks';
import { windowRange } from '../../lib/stickerMedia';
import { snapValue } from '../../lib/snap';
import { hintFor } from '../../lib/shortcuts';
import { IconEye, IconFit, IconLock } from '../ui/Icons';
import { TimelineTools } from './TimelineTools';
import type { Layer } from '../../types';

const LABEL_W = 112;
const MIN_PPS = 20;
const MAX_PPS = 400;
const SNAP_PX = 6;

/** 步骤 1 的源音轨行：只是状态展示（静音 / 音量），没有可拖的东西。 */
function SourceAudioRow({ hasAudio, volume, width, scrub }: { hasAudio: boolean; volume: number; width: number; scrub: ReturnType<typeof useScrub>['handlers'] }) {
  const muted = !hasAudio || volume === 0;
  const label = !hasAudio ? '源音轨（无）' : volume === 0 ? '源音轨（已静音）' : volume < 1 ? `源音轨 ${Math.round(volume * 100)}%` : '源音轨';
  return (
    <div className={`tl-row tl-audio ${muted ? 'muted' : ''}`}>
      <div className="lbl" title={label}>{label}</div>
      <div className="body" {...scrub}>
        {hasAudio && <div className={`tl-bar audio all ${volume === 0 ? 'muted' : ''}`} style={{ left: 0, width, cursor: 'default', opacity: volume === 0 ? 0.35 : 0.45 + 0.55 * volume }} />}
      </div>
    </div>
  );
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

type Drag = { kind: 'cut-l' | 'cut-r' | 'cut-move' | 'bar-l' | 'bar-r' | 'bar-move'; index: number; startX: number; orig: [number, number] };

/** 标尺 / 轨道上的 scrub：按下暂停并定位，拖动时用 rAF 节流连续定位。 */
function useScrub(xToTime: (clientX: number) => number) {
  const [scrubbing, setScrubbing] = useState(false);
  const active = useRef(false);
  const raf = useRef(0);
  const pending = useRef<number | null>(null);

  const flush = () => {
    raf.current = 0;
    if (pending.current !== null && active.current) player.seek(xToTime(pending.current));
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
    player.seek(xToTime(e.clientX));
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
    player.seek(xToTime(e.clientX));
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
  const playing = useEditor((s) => s.playing);
  const inPoint = useEditor((s) => s.inPoint);
  const selectedRange = useEditor((s) => s.selectedRangeIndex);
  const setSelectedRange = useEditor((s) => s.setSelectedRange);
  const updateRemoveRange = useEditor((s) => s.updateRemoveRange);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const setSelectedLayer = useEditor((s) => s.setSelectedLayer);
  const updateLayer = useEditor((s) => s.updateLayer);
  const assets = useEditor((s) => s.assets);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const setSelectedTrack = useEditor((s) => s.setSelectedTrack);
  const timelinePps = useEditor((s) => s.timelinePps);
  const setTimelinePps = useEditor((s) => s.setTimelinePps);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dragVal, setDragVal] = useState<[number, number] | null>(null);
  const [snapX, setSnapX] = useState<number | null>(null);
  const dragRef = useRef<[number, number] | null>(null);

  const duration = Math.max(0.1, video?.duration ?? 0);
  const fitPps = Math.max(1, containerW - LABEL_W - 2) / duration;
  const pps = clamp(timelinePps ?? fitPps, MIN_PPS, MAX_PPS);
  const trackW = duration * pps;
  const remove = spec?.trim.remove ?? [];
  const postDuration = postTrimDuration(duration, remove);
  const ppsRef = useRef(pps);
  ppsRef.current = pps;

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
    el.scrollLeft = Math.max(0, a.time * pps - a.offsetX);
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
        zoomTo(cur * Math.exp(-e.deltaY * 0.002), { time: (offsetX + el.scrollLeft) / cur, offsetX });
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

  // ---- 播放时翻页式跟随 ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const viewW = el.clientWidth - LABEL_W;
    const x = time * pps;
    if (x < el.scrollLeft || x > el.scrollLeft + viewW) el.scrollLeft = Math.max(0, x - viewW * 0.2);
  }, [time, playing, pps]);

  const xToTime = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - LABEL_W + el.scrollLeft;
    return clamp(x / ppsRef.current, 0, duration);
  };
  const scrub = useScrub(xToTime);

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
    const maxT = isBar ? postDuration : duration;
    // 吸附候选：源时间（区间）或剪后时间（图层条）
    const candidates: number[] = isBar
      ? [0, postDuration, sourceToPost(time, remove), ...(spec?.layers ?? []).flatMap((l, i) => (i === d.index || l.t === 'all' ? [] : l.t))]
      : [0, duration, time, ...(inPoint !== null ? [inPoint] : []), ...remove.flatMap((r, i) => (i === d.index ? [] : r))];
    const threshold = SNAP_PX / pps;

    const onMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - d.startX) / pps;
      let [a, b] = d.orig;
      let hit: number | null = null;
      const snap = !ev.altKey;
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
      setSnapX(hit === null ? null : (isBar ? postToSource(hit, remove) : hit) * pps);
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
        else {
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
  const tickCount = Math.floor(duration / tickStep + 1e-6);
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

  const zoomSlider = Math.round((Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000);
  const onSlider = (v: number) => {
    const el = scrollRef.current;
    const next = MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 1000);
    const viewW = el ? el.clientWidth - LABEL_W : 0;
    const center = el ? (el.scrollLeft + viewW / 2) / ppsRef.current : 0;
    zoomTo(next, { time: center, offsetX: viewW / 2 });
  };

  return (
    <div className="timeline">
      <div className="tl-head">
        <TimelineTools />
        <span className="tl-sep" />
        <span>缩放</span>
        <input type="range" min={0} max={1000} value={zoomSlider} onChange={(e) => onSlider(Number(e.target.value))} aria-label="时间轴缩放" title={hintFor('tl-zoom')} />
        <span className="mono">{Math.round(pps)} px/s</span>
        <button className="btn ghost" onClick={() => setTimelinePps(null)} disabled={timelinePps === null} title={hintFor('tl-fit')}>
          <IconFit /> 适应
        </button>
        <span className="spacer" />
        <span>{hintFor('tl-zoom')} · {hintFor('tl-scroll')} · {hintFor('tl-no-snap')}</span>
      </div>
      <div className={`tl-scroll ${scrub.scrubbing ? 'scrubbing' : ''}`} ref={scrollRef}>
        <div className="tl-inner" style={{ width: trackW + LABEL_W }}>
          <div className="tl-row" style={{ height: 20 }}>
            <div className="lbl mono" style={{ height: 20, fontSize: 10 }}>{step === 2 ? '剪后' : '秒'}</div>
            <div className="tl-ruler" {...scrub.handlers}>
              {ticks.map((k) => (
                <div key={k.t} className={`tick ${k.minor ? 'minor' : ''}`} style={{ left: k.t * pps }}>
                  {k.label}
                </div>
              ))}
            </div>
          </div>

          <div className="tl-row tl-video">
            <div className="lbl">视频</div>
            <div className="body" {...scrub.handlers}>
              {sprite &&
                tiles.map((i) => (
                  <div
                    key={i}
                    className="tl-sprite"
                    style={{
                      left: i * tileSlot,
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
                    style={{ left: a * pps, width: Math.max(2, (b - a) * pps), opacity: step === 1 ? 1 : 0.5, pointerEvents: step === 1 ? 'auto' : 'none' }}
                    onPointerDown={(e) => {
                      setSelectedRange(i);
                      startDrag(e, { kind: 'cut-move', index: i, startX: e.clientX, orig: r });
                    }}
                    title={`删除 ${a.toFixed(2)}s – ${b.toFixed(2)}s`}
                  >
                    {step === 1 && (
                      <>
                        <div className="edge l" onPointerDown={(e) => { setSelectedRange(i); startDrag(e, { kind: 'cut-l', index: i, startX: e.clientX, orig: r }); }} />
                        <div className="edge r" onPointerDown={(e) => { setSelectedRange(i); startDrag(e, { kind: 'cut-r', index: i, startX: e.clientX, orig: r }); }} />
                      </>
                    )}
                  </div>
                );
              })}
              {inPoint !== null && step === 1 && <div className="tl-inpoint" style={{ left: inPoint * pps }} title="入点" />}
            </div>
          </div>

          {step === 1 && (
            <SourceAudioRow hasAudio={!!video?.has_audio} volume={sourceVolume(spec?.audio)} width={trackW} scrub={scrub.handlers} />
          )}
          {step === 1 &&
            (spec?.audio?.tracks ?? []).map((t) => {
              const r = resolveTrack(t);
              const all = r.t === 'all';
              const [pa, pb] = windowRange(r.t, postDuration);
              const left = postToSource(pa, remove) * pps;
              const right = postToSource(pb, remove) * pps;
              const sel = selectedTrackId === t.id;
              const asset = assets.find((a) => a.id === t.asset_id);
              const name = asset?.name.replace(/\.[a-z0-9]+$/i, '') ?? '音频';
              return (
                <div key={t.id} className={`tl-row tl-audio ${sel ? 'selected' : ''}`} onClick={() => setSelectedTrack(t.id)}>
                  <div className="lbl" title={name}>
                    <span className={`role ${r.role}`} style={{ fontSize: 10, flex: 'none' }}>{r.role === 'voice' ? '口播' : 'BGM'}</span>
                    <span className="lname" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
                  </div>
                  <div className="body" {...scrub.handlers}>
                    <div className={`tl-bar audio ${r.role} ${sel ? 'selected' : ''} ${all ? 'all' : ''} ${r.volume === 0 ? 'muted' : ''}`} style={{ left, width: Math.max(4, right - left), cursor: 'default' }} onPointerDown={(e) => { setSelectedTrack(t.id); e.stopPropagation(); }}>
                      {all ? '全程' : `${pa.toFixed(1)}s – ${pb.toFixed(1)}s`}
                      {r.loop ? ' ↻' : ''}
                      {r.volume !== 1 ? ` ${Math.round(r.volume * 100)}%` : ''}
                    </div>
                  </div>
                </div>
              );
            })}

          {step === 2 &&
            (spec?.layers ?? []).map((l, i) => {
              const v = barVal(i, l);
              const all = v === 'all';
              const [pa, pb] = all ? [0, postDuration] : v;
              const left = postToSource(pa, remove) * pps;
              const right = postToSource(pb, remove) * pps;
              const sel = selectedLayerId === l.id;
              const hidden = l.visible === false;
              const locked = !!l.locked;
              return (
                <div key={l.id} className={`tl-row tl-layer ${sel ? 'selected' : ''} ${hidden ? 'hidden' : ''}`}>
                  <div className="lbl" title={layerName(l, assets)}>
                    <span className="tl-acts" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                      <button className="btn ghost icon" title="显示 / 隐藏（仅预览）" onClick={() => updateLayer(l.id, { visible: hidden }, false)}>
                        <IconEye off={hidden} />
                      </button>
                      <button className="btn ghost icon" title="锁定 / 解锁" onClick={() => updateLayer(l.id, { locked: !locked }, false)}>
                        <IconLock open={!locked} />
                      </button>
                    </span>
                    <button
                      className={`chip ${all ? 'active' : ''}`}
                      style={{ height: 18, padding: '0 6px', fontSize: 10 }}
                      title="全程 / 区间"
                      onClick={() => {
                        if (all) {
                          const cur = sourceToPost(time, remove);
                          updateLayer(l.id, { t: [Math.round(cur * 100) / 100, Math.round(Math.min(postDuration, cur + 3) * 100) / 100] });
                        } else updateLayer(l.id, { t: 'all' });
                      }}
                    >
                      {all ? '全程' : '区间'}
                    </button>
                    <span className="lname" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{layerName(l, assets)}</span>
                  </div>
                  <div className="body" {...scrub.handlers}>
                    <div
                      className={`tl-bar ${sel ? 'selected' : ''} ${all ? 'all' : ''} ${locked ? 'locked' : ''}`}
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
          {step === 2 && (spec?.layers.length ?? 0) === 0 && (
            <div className="tl-row" style={{ height: 30 }}>
              <div className="lbl">图层</div>
              <div className="body hint" style={{ padding: '6px 8px' }}>还没有图层，在右侧添加贴纸或文字。</div>
            </div>
          )}

          {snapX !== null && <div className="tl-snap" style={{ left: LABEL_W + snapX }} />}
          <div className="tl-playhead" style={{ left: LABEL_W + time * pps }}>
            <div className="grip" {...scrub.handlers} title="拖动定位" />
          </div>
        </div>
      </div>
    </div>
  );
}

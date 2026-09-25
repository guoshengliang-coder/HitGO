// 播放控制器：包装 <video>，并在视频不可用（mock 内置示例没有文件）时退回到合成时钟。
// 时间统一用"源时间轴"秒；剪辑区间的跳过在 tick 中处理。
// 有封面（HIG-9）时播放头前面多出 [-preroll, 0)：这段由合成时钟推进、正片 <video> 停在第 0 帧，
// 走到 0 时再让正片开始播；封面画面 / 声音由 Stage 按 time + preroll 自己对齐。
// 倍速（HIG-30 J/K/L）：rate > 1 时 <video> 与音轨按 playbackRate 快放；rate < 0 为倒放，
// 由合成时钟往回走、逐帧 seek 画面，这时各媒体元素按「暂停对齐」处理（mediaRate = 0）。
// 成片时长 trim.duration（HIG-50）比剪后时长长时，保留段循环补足：源片放完回到第一个保留帧接着放，
// 用 lap（第几遍，0 起）记着；time 仍是源时间，成片时刻 = lap × 剪后时长 + 剪后时刻（postTime）。
// 封面只在第 0 遍前面；成片时刻走到 trim.duration 就停（短于剪后时长时也在那里截断）。

import { lapsFor, postTimeOf, postToSource, postTrimDuration, removedRangeAt, skipRemoved, sourceToPost, type Range } from './time';

type Listener = (t: number, playing: boolean, lap: number) => void;
type FrameListener = () => void;
export interface SequencePlaybackClip { id: string; src: string; sourceIn: number; sourceOut: number; start: number; end: number; speed?: number; holdAfter?: number }

export class Player {
  private video: HTMLVideoElement | null = null;
  private synthetic = true;
  private time = 0;
  private playing = false;
  private rateValue = 1;
  private raf = 0;
  private lastTs = 0;
  private listeners = new Set<Listener>();
  private frameListeners = new Set<FrameListener>();
  duration = 0;
  remove: Range[] = [];
  /** 封面时长（秒）；0 = 没有封面。用 setPreroll 改，保证播放头不落在封面之外。 */
  private prerollSec = 0;
  /** 成片正片时长（秒）；null = 跟剪后时长一样（不循环、不截断）。用 setOutputDuration 改。 */
  private outputSec: number | null = null;
  /** 当前放到第几遍（0 起）；只有成片比剪后长时才会 > 0。 */
  private lapValue = 0;
  /** 换遍后让 <video> 回到开头的 seek 还没完成：元素这时仍报片尾，读了会连跳好几遍。 */
  private lapSeekPending = false;
  private sequence: SequencePlaybackClip[] | null = null;
  private sequenceSignature = '';
  private pendingMediaTime: number | null = null;

  private onLoadedMetadata = () => {
    const v = this.video;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      this.synthetic = false;
      if (!this.sequence) this.duration = v.duration;
      if (this.pendingMediaTime !== null) {
        v.currentTime = this.pendingMediaTime;
        this.pendingMediaTime = null;
        if (this.playing && this.rateValue > 0) this.playVideo();
      }
    }
    this.emit();
  };

  private onError = () => {
    this.synthetic = true;
    this.emit();
  };

  /** <video> 自己播到尾：还有下一遍就接着放，否则停。rAF 那边也会检查，这里先到就先处理。 */
  private onEnded = () => {
    if (!this.playing || this.rateValue < 0) return;
    if (this.sequence) {
      const current = this.sequenceClipAt(this.time);
      if (current && (current.holdAfter ?? 0) > 0) {
        this.time = Math.max(this.time, this.holdStart(current));
        this.video?.pause();
        return;
      }
      const next = this.sequence[this.sequence.findIndex((clip) => clip.id === current?.id) + 1];
      if (next) this.seek(next.start);
      else this.pause();
      return;
    }
    if (!this.advanceLap()) this.pause();
  };

  /** 当前元素有了新的可绘制帧（首帧解码完 / 跳转完成）。只挂在当前元素上，换元素时随 detach 解绑。 */
  private onFrameReady = () => {
    for (const l of this.frameListeners) l();
  };

  /** 解绑当前元素的监听器。attach 会先调它，避免同一元素被反复挂上多份监听。 */
  detach() {
    const v = this.video;
    if (v) {
      v.removeEventListener('loadedmetadata', this.onLoadedMetadata);
      v.removeEventListener('error', this.onError);
      v.removeEventListener('ended', this.onEnded);
      v.removeEventListener('loadeddata', this.onFrameReady);
      v.removeEventListener('seeked', this.onFrameReady);
    }
    this.video = null;
    this.synthetic = true;
  }

  attach(video: HTMLVideoElement | null) {
    this.detach();
    this.video = video;
    this.synthetic = !video || !video.src;
    if (video) {
      video.addEventListener('loadedmetadata', this.onLoadedMetadata);
      video.addEventListener('error', this.onError);
      video.addEventListener('ended', this.onEnded);
      video.addEventListener('loadeddata', this.onFrameReady);
      video.addEventListener('seeked', this.onFrameReady);
      if (this.sequence) this.syncSequenceMedia();
    }
  }

  /** Virtual composed timeline; null restores the historical single-source clock. */
  setSequence(clips: SequencePlaybackClip[] | null) {
    const signature = JSON.stringify(clips);
    if (signature === this.sequenceSignature) return;
    this.sequenceSignature = signature;
    this.sequence = clips?.length ? clips : null;
    if (this.sequence) {
      this.duration = this.sequence[this.sequence.length - 1].end;
      this.lapValue = 0;
      this.outputSec = null;
      this.time = Math.max(-this.prerollSec, Math.min(this.duration, this.time));
      this.syncSequenceMedia();
    }
    this.emit();
  }

  private sequenceClipAt(t: number): SequencePlaybackClip | null {
    if (!this.sequence?.length) return null;
    return [...this.sequence].reverse().find((clip) => t >= clip.start - 1e-6) ?? this.sequence[0];
  }

  private holdStart(clip: SequencePlaybackClip): number {
    return clip.start + (clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1);
  }

  private holding(clip: SequencePlaybackClip | null): boolean {
    return !!clip && (clip.holdAfter ?? 0) > 0 && this.time >= this.holdStart(clip) - 1e-3 && this.time < clip.end - 1e-3;
  }

  private syncSequenceMedia() {
    const video = this.video;
    const clip = this.sequenceClipAt(Math.max(0, this.time));
    if (!video || !clip) return;
    const mediaTime = this.holding(clip)
      ? Math.max(clip.sourceIn, clip.sourceOut - 0.001)
      : Math.min(clip.sourceOut, clip.sourceIn + Math.max(0, this.time - clip.start) * (clip.speed ?? 1));
    if (video.getAttribute('src') !== clip.src) {
      video.pause();
      this.synthetic = true;
      this.pendingMediaTime = mediaTime;
      video.setAttribute('src', clip.src);
      video.load();
    } else if (Math.abs(video.currentTime - mediaTime) > 0.08) {
      try { video.currentTime = mediaTime; } catch { /* metadata not loaded yet */ }
    }
    this.applyRate();
    if (this.holding(clip)) video.pause();
  }

  get isSynthetic() {
    return this.synthetic;
  }

  /** 当前挂载的 <video>（裁切编辑、填充底图抓帧用）；合成时钟模式下返回 null。 */
  getVideo(): HTMLVideoElement | null {
    return this.video && !this.synthetic ? this.video : null;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 订阅"当前挂载的 <video> 有新帧可画"。暂停状态下 store 的 time 不一定变化（换素材时两边都是 0），
   * 从 <video> 抓帧的画布（填充底图）靠它在帧真正就绪后重画（HIG-12）。
   */
  onFrame(fn: FrameListener) {
    this.frameListeners.add(fn);
    return () => {
      this.frameListeners.delete(fn);
    };
  }

  private emit() {
    for (const l of this.listeners) l(this.time, this.playing, this.lapValue);
  }

  get currentTime() {
    return this.time;
  }

  get lap() {
    return this.lapValue;
  }

  get outputDuration() {
    return this.outputSec;
  }

  /** 剪后时长（保留段总长）。 */
  get postLength() {
    return postTrimDuration(this.duration, this.remove);
  }

  /** 保留段要放几遍。 */
  get laps() {
    return lapsFor(this.outputSec, this.postLength);
  }

  /** 播放头的成片时刻（剪后时间轴，跨遍累加）；封面段里为 0。 */
  get postTime() {
    return postTimeOf(this.lapValue, this.postLength, sourceToPost(Math.max(0, this.time), this.remove));
  }

  /** 设成片时长（null = 跟剪后时长）；遍数变少时把落在后面的播放头夹回最后一遍。 */
  setOutputDuration(sec: number | null) {
    const next = typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : null;
    if (next === this.outputSec) return;
    this.outputSec = next;
    const maxLap = this.laps - 1;
    if (this.lapValue > maxLap) this.seek(this.time, maxLap);
    else this.emit();
  }

  /** 成片是否已经放到头：设了成片时长按成片时刻算，否则按源片尾。 */
  private atOutputEnd(sourceTime = this.time): boolean {
    if (this.outputSec !== null) return postTimeOf(this.lapValue, this.postLength, sourceToPost(Math.max(0, sourceTime), this.remove)) >= this.outputSec - 0.01;
    return sourceTime >= this.duration - 0.01;
  }

  /** 源片放完：还有下一遍就回到第一个保留帧接着放（返回 true）；没有了返回 false，由调用方停下。 */
  private advanceLap(): boolean {
    if (this.lapValue + 1 >= this.laps) return false;
    this.lapValue += 1;
    this.time = skipRemoved(0, this.remove);
    if (this.video && !this.synthetic) {
      this.lapSeekPending = true;
      try {
        this.video.currentTime = this.time;
      } catch {
        /* ignore */
      }
      this.playVideo();
    }
    return true;
  }

  get preroll() {
    return this.prerollSec;
  }

  /** 设置封面时长；封面变短 / 删掉时，落在新封面之前的播放头夹回来。 */
  setPreroll(sec: number) {
    const next = Number.isFinite(sec) && sec > 0 ? sec : 0;
    if (next === this.prerollSec) return;
    this.prerollSec = next;
    if (this.time < -next) this.seek(next > 0 ? -next : 0);
  }

  get isPlaying() {
    return this.playing;
  }

  /** 当前倍速（带符号）；没在播时为 1。 */
  get rate() {
    return this.rateValue;
  }

  /** 媒体元素该用的播放速率：正放中为 rate，倒放 / 暂停为 0（按暂停对齐）。 */
  get mediaRate() {
    return this.playing && this.rateValue > 0 ? this.rateValue : 0;
  }

  /** Source-aligned media follows the active sequence clip's retiming as well as J/K/L. */
  get sourceMediaRate() {
    if (!this.playing || this.rateValue <= 0) return 0;
    if (this.sequence && this.holding(this.sequenceClipAt(Math.max(0, this.time)))) return 0;
    const clipSpeed = this.sequence ? this.sequenceClipAt(Math.max(0, this.time))?.speed ?? 1 : 1;
    return this.rateValue * clipSpeed;
  }

  private applyRate() {
    if (this.video && !this.synthetic) {
      try {
        const clipSpeed = this.sequence ? this.sequenceClipAt(Math.max(0, this.time))?.speed ?? 1 : 1;
        this.video.playbackRate = this.rateValue > 0 ? this.rateValue * clipSpeed : 1;
      } catch {
        /* ignore */
      }
    }
  }

  /** J/K/L 穿梭：rate=0 停；正数正放、负数倒放。已在播时直接换速 / 换方向。 */
  shuttle(rate: number) {
    if (!rate) {
      this.pause();
      return;
    }
    const wasPlaying = this.playing;
    const wasReverse = this.rateValue < 0;
    if (!wasPlaying) {
      // 倒放到头 / 正放到尾时没东西可放
      if (rate < 0 && this.time <= (this.prerollSec > 0 ? -this.prerollSec : 0) + 0.01) return;
      this.play(rate);
      return;
    }
    this.rateValue = rate;
    this.applyRate();
    if (rate < 0 && !wasReverse && this.video && !this.synthetic) this.video.pause();
    if (rate > 0 && wasReverse && this.time >= 0) this.playVideo();
    this.emit();
  }

  /** 定位到源时刻 t；lap 指定第几遍（缺省保持当前遍），封面段（t < 0）只属于第 0 遍。 */
  seek(t: number, lap?: number) {
    const lo = this.prerollSec > 0 ? -this.prerollSec : 0; // 不写成 -0，免得 -0 流进 store
    const clamped = Math.max(lo, Math.min(this.duration || t, t));
    this.time = clamped;
    this.lapSeekPending = false;
    if (lap !== undefined) this.lapValue = Math.max(0, Math.min(this.laps - 1, Math.floor(lap)));
    if (clamped < 0) this.lapValue = 0;
    if (this.sequence) {
      if (clamped < 0 && this.video) this.video.pause();
      else this.syncSequenceMedia();
      this.emit();
      return;
    }
    if (this.video && !this.synthetic) {
      // 封面段里正片停在第 0 帧，等播放头走到 0 再接上
      if (clamped < 0 && this.playing) this.video.pause();
      try {
        this.video.currentTime = Math.max(0, clamped);
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }

  private playVideo() {
    if (this.sequence && this.holding(this.sequenceClipAt(Math.max(0, this.time)))) return;
    if (this.video && !this.synthetic) {
      this.video.play().catch(() => {
        this.synthetic = true;
      });
    }
  }

  play(rate = 1) {
    if (this.playing) return;
    this.rateValue = rate;
    this.applyRate();
    if (this.sequence) {
      if (this.time >= this.duration - 0.01) this.seek(this.prerollSec > 0 ? -this.prerollSec : 0);
      if (rate > 0 && this.time >= 0) this.seek(skipRemoved(this.time, this.remove));
      this.playing = true;
      if (this.time >= 0 && rate > 0) this.playVideo();
      this.lastTs = performance.now();
      this.loop();
      this.emit();
      return;
    }
    if (rate > 0) {
      const start = skipRemoved(this.time, this.remove);
      // 播到头再按播放：从成片开头（有封面就从封面）重来；源片到尾但还有下一遍就接着放下一遍
      if (this.atOutputEnd(start)) this.seek(this.prerollSec > 0 ? -this.prerollSec : 0, 0);
      else if (start >= this.duration - 0.01) {
        if (!this.advanceLap()) this.seek(this.prerollSec > 0 ? -this.prerollSec : 0, 0);
      } else if (start !== this.time) this.seek(start);
    }
    this.playing = true;
    if (this.time >= 0 && rate > 0) this.playVideo();
    this.lastTs = performance.now();
    this.loop();
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.rateValue = 1;
    this.applyRate();
    cancelAnimationFrame(this.raf);
    if (this.video && !this.synthetic) this.video.pause();
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  private loop = () => {
    if (!this.playing) return;
    const now = performance.now();
    const dt = (now - this.lastTs) / 1000;
    this.lastTs = now;
    if (this.rateValue < 0) {
      this.reverseStep(dt);
      return;
    }
    if (this.sequence) {
      if (this.time < 0) {
        this.time += dt * this.rateValue;
        if (this.time >= 0) { this.time = skipRemoved(0, this.remove); this.syncSequenceMedia(); this.playVideo(); }
      } else {
        const clip = this.sequenceClipAt(this.time);
        if (this.holding(clip)) {
          this.video?.pause();
          this.time += dt * this.rateValue;
        } else if (clip && this.video && !this.synthetic) this.time = clip.start + Math.max(0, this.video.currentTime - clip.sourceIn) / (clip.speed ?? 1);
        else this.time += dt * this.rateValue;
        const next = this.sequence.find((c) => c.start > (clip?.start ?? 0) + 1e-6 && c.start <= this.time + 1e-3);
        if (next) { this.time = next.start; this.syncSequenceMedia(); this.playVideo(); }
        const skipped = skipRemoved(this.time, this.remove);
        if (skipped !== this.time) { this.time = skipped; this.syncSequenceMedia(); this.playVideo(); }
      }
      if (this.time >= this.duration - 0.01) { this.time = this.duration; this.pause(); return; }
      this.emit();
      this.raf = requestAnimationFrame(this.loop);
      return;
    }
    if (this.time < 0) {
      // 封面段：合成时钟推进，跨过 0 时让正片从（跳过删除区间后的）开头接着播
      this.time += dt * this.rateValue;
      if (this.time >= 0) {
        this.time = skipRemoved(0, this.remove);
        if (this.video && !this.synthetic) {
          try {
            this.video.currentTime = this.time;
          } catch {
            /* ignore */
          }
        }
        this.playVideo();
      }
    } else if (this.video && !this.synthetic) {
      const vt = this.video.currentTime;
      if (this.lapSeekPending && vt >= this.duration - 0.05) {
        // 换遍的 seek 还没落地：这一帧沿用上次的位置
      } else {
        this.lapSeekPending = false;
        this.time = vt;
      }
    } else {
      this.time += dt * this.rateValue;
    }
    const skipped = skipRemoved(this.time, this.remove);
    if (skipped !== this.time) {
      this.time = skipped;
      if (this.video && !this.synthetic) this.video.currentTime = skipped;
    }
    if (this.outputSec !== null && this.atOutputEnd() && this.time >= 0) {
      // 成片时刻走到 trim.duration：停在那一帧（短于剪后时长时就是截断点）
      this.time = Math.min(this.duration || this.time, postToSource(Math.max(0, this.outputSec - this.lapValue * this.postLength), this.remove));
      if (this.video && !this.synthetic) {
        try {
          this.video.currentTime = this.time;
        } catch {
          /* ignore */
        }
      }
      this.pause();
      return;
    }
    if (this.time >= this.duration && this.duration > 0) {
      // 源片到尾：还有下一遍就回到开头接着放
      if (!this.advanceLap()) {
        this.time = this.duration;
        this.pause();
        return;
      }
    }
    this.emit();
    this.raf = requestAnimationFrame(this.loop);
  };

  /** 倒放一帧：往回走，落进删除区间就跳到区间起点之前；不是第 0 遍时退回上一遍的片尾，走到开头停下。 */
  private reverseStep(dt: number) {
    const lo = this.prerollSec > 0 ? -this.prerollSec : 0;
    let t = this.time + dt * this.rateValue;
    if (this.sequence) {
      for (let i = 0; i < this.remove.length; i++) {
        const range = t >= 0 ? removedRangeAt(t, this.remove) : null;
        if (!range) break;
        t = range[0] - 1e-3;
      }
      if (t <= lo) { this.seek(lo); this.pause(); return; }
      this.time = t;
      this.syncSequenceMedia();
      this.emit();
      this.raf = requestAnimationFrame(this.loop);
      return;
    }
    if (t <= 0 && this.lapValue > 0) {
      this.lapValue -= 1;
      t = this.duration - 1e-3;
    }
    for (let i = 0; i < 8; i++) {
      const r = t >= 0 ? removedRangeAt(t, this.remove) : null;
      if (!r) break;
      t = r[0] - 1e-3;
    }
    if (t <= lo) {
      this.seek(lo);
      this.pause();
      return;
    }
    this.time = t;
    if (this.video && !this.synthetic) {
      try {
        this.video.currentTime = Math.max(0, t);
      } catch {
        /* ignore */
      }
    }
    this.emit();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    this.pause();
    this.lapValue = 0;
    this.outputSec = null;
    this.listeners.clear();
    this.frameListeners.clear();
    this.detach();
  }
}

export const player = new Player();

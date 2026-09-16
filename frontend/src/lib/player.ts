// 播放控制器：包装 <video>，并在视频不可用（mock 内置示例没有文件）时退回到合成时钟。
// 时间统一用"源时间轴"秒；剪辑区间的跳过在 tick 中处理。
// 有封面（HIG-9）时播放头前面多出 [-preroll, 0)：这段由合成时钟推进、正片 <video> 停在第 0 帧，
// 走到 0 时再让正片开始播；封面画面 / 声音由 Stage 按 time + preroll 自己对齐。
// 倍速（HIG-30 J/K/L）：rate > 1 时 <video> 与音轨按 playbackRate 快放；rate < 0 为倒放，
// 由合成时钟往回走、逐帧 seek 画面，这时各媒体元素按「暂停对齐」处理（mediaRate = 0）。

import { removedRangeAt, skipRemoved, type Range } from './time';

type Listener = (t: number, playing: boolean) => void;
type FrameListener = () => void;

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

  private onLoadedMetadata = () => {
    const v = this.video;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      this.synthetic = false;
      this.duration = v.duration;
    }
    this.emit();
  };

  private onError = () => {
    this.synthetic = true;
    this.emit();
  };

  private onEnded = () => {
    this.pause();
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
    }
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
    for (const l of this.listeners) l(this.time, this.playing);
  }

  get currentTime() {
    return this.time;
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

  private applyRate() {
    if (this.video && !this.synthetic) {
      try {
        this.video.playbackRate = this.rateValue > 0 ? this.rateValue : 1;
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

  seek(t: number) {
    const lo = this.prerollSec > 0 ? -this.prerollSec : 0; // 不写成 -0，免得 -0 流进 store
    const clamped = Math.max(lo, Math.min(this.duration || t, t));
    this.time = clamped;
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
    if (rate > 0) {
      const start = skipRemoved(this.time, this.remove);
      // 播到头再按播放：从成片开头（有封面就从封面）重来
      if (start >= this.duration - 0.01) this.seek(this.prerollSec > 0 ? -this.prerollSec : 0);
      else if (start !== this.time) this.seek(start);
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
      this.time = this.video.currentTime;
    } else {
      this.time += dt * this.rateValue;
    }
    const skipped = skipRemoved(this.time, this.remove);
    if (skipped !== this.time) {
      this.time = skipped;
      if (this.video && !this.synthetic) this.video.currentTime = skipped;
    }
    if (this.time >= this.duration && this.duration > 0) {
      this.time = this.duration;
      this.pause();
      return;
    }
    this.emit();
    this.raf = requestAnimationFrame(this.loop);
  };

  /** 倒放一帧：往回走，落进删除区间就跳到区间起点之前，走到开头停下。 */
  private reverseStep(dt: number) {
    const lo = this.prerollSec > 0 ? -this.prerollSec : 0;
    let t = this.time + dt * this.rateValue;
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
    this.listeners.clear();
    this.frameListeners.clear();
    this.detach();
  }
}

export const player = new Player();

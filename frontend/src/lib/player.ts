// 播放控制器：包装 <video>，并在视频不可用（mock 内置示例没有文件）时退回到合成时钟。
// 时间统一用"源时间轴"秒；剪辑区间的跳过在 tick 中处理。

import { skipRemoved, type Range } from './time';

type Listener = (t: number, playing: boolean) => void;

export class Player {
  private video: HTMLVideoElement | null = null;
  private synthetic = true;
  private time = 0;
  private playing = false;
  private raf = 0;
  private lastTs = 0;
  private listeners = new Set<Listener>();
  duration = 0;
  remove: Range[] = [];

  attach(video: HTMLVideoElement | null) {
    this.video = video;
    this.synthetic = !video || !video.src;
    if (video) {
      video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          this.synthetic = false;
          this.duration = video.duration;
        }
        this.emit();
      });
      video.addEventListener('error', () => {
        this.synthetic = true;
        this.emit();
      });
      video.addEventListener('ended', () => {
        this.pause();
      });
    }
  }

  get isSynthetic() {
    return this.synthetic;
  }

  /** 当前挂载的 <video>（输出步骤抓帧用）；合成时钟模式下返回 null。 */
  getVideo(): HTMLVideoElement | null {
    return this.video && !this.synthetic ? this.video : null;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    for (const l of this.listeners) l(this.time, this.playing);
  }

  get currentTime() {
    return this.time;
  }

  get isPlaying() {
    return this.playing;
  }

  seek(t: number) {
    const clamped = Math.max(0, Math.min(this.duration || t, t));
    this.time = clamped;
    if (this.video && !this.synthetic) {
      try {
        this.video.currentTime = clamped;
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }

  play() {
    if (this.playing) return;
    const start = skipRemoved(this.time, this.remove);
    if (start >= this.duration - 0.01) this.seek(0);
    else if (start !== this.time) this.seek(start);
    this.playing = true;
    if (this.video && !this.synthetic) {
      this.video.play().catch(() => {
        this.synthetic = true;
      });
    }
    this.lastTs = performance.now();
    this.loop();
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
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
    if (this.video && !this.synthetic) {
      this.time = this.video.currentTime;
    } else {
      this.time += dt;
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

  destroy() {
    this.pause();
    this.listeners.clear();
    this.video = null;
  }
}

export const player = new Player();

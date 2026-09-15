// 播放控制器：包装 <video>，并在视频不可用（mock 内置示例没有文件）时退回到合成时钟。
// 时间统一用"源时间轴"秒；剪辑区间的跳过在 tick 中处理。

import { skipRemoved, type Range } from './time';

type Listener = (t: number, playing: boolean) => void;
type FrameListener = () => void;

export class Player {
  private video: HTMLVideoElement | null = null;
  private synthetic = true;
  private time = 0;
  private playing = false;
  private raf = 0;
  private lastTs = 0;
  private listeners = new Set<Listener>();
  private frameListeners = new Set<FrameListener>();
  duration = 0;
  remove: Range[] = [];

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
    this.frameListeners.clear();
    this.detach();
  }
}

export const player = new Player();

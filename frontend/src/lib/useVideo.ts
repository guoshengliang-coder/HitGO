import { useEffect, useState } from 'react';

// 视频贴纸的 <video> 元素缓存，形状与 useImage 保持一致。
// HTMLVideoElement 本身就是 CanvasImageSource，Konva.Image 与 ctx.drawImage 都能直接吃，
// 所以画布侧不需要再做一层离屏 canvas。
// 元素一律静音：贴纸自带的音轨不参与成片（契约 §2），预览也不应该出声。

const cache = new Map<string, HTMLVideoElement>();

/** 只有跨域 http(s) 地址才加 crossOrigin（导出画布需要）；站内 /media 路径按原样加载。 */
function needsCrossOrigin(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return typeof location !== 'undefined' && new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

function createVideo(url: string): HTMLVideoElement {
  const el = document.createElement('video');
  if (needsCrossOrigin(url)) el.crossOrigin = 'anonymous';
  el.muted = true;
  el.defaultMuted = true;
  el.loop = false; // 循环由 stickerMediaTime 驱动，和后端的 playback 语义保持一致
  el.playsInline = true;
  el.preload = 'auto';
  el.src = url;
  return el;
}

/** 取（带缓存的）<video>；ready 表示已经有可绘制的帧（readyState ≥ 2）。 */
export function useVideo(url: string | undefined | null): { video?: HTMLVideoElement; ready: boolean } {
  const [, bump] = useState(0);
  const video = url ? cache.get(url) ?? undefined : undefined;

  useEffect(() => {
    if (!url) return;
    let alive = true;
    let el = cache.get(url);
    if (!el) {
      el = createVideo(url);
      cache.set(url, el);
    }
    const onChange = () => {
      if (alive) bump((n) => n + 1);
    };
    el.addEventListener('loadeddata', onChange);
    el.addEventListener('seeked', onChange);
    el.addEventListener('error', onChange);
    if (el.readyState < 2) el.load();
    onChange();
    return () => {
      alive = false;
      el?.removeEventListener('loadeddata', onChange);
      el?.removeEventListener('seeked', onChange);
      el?.removeEventListener('error', onChange);
    };
  }, [url]);

  return { video, ready: !!video && video.readyState >= 2 };
}

/** 命令式取用（输出步骤的缩略预览按帧抓图时用）。 */
export function getVideo(url: string): HTMLVideoElement {
  let el = cache.get(url);
  if (!el) {
    el = createVideo(url);
    cache.set(url, el);
  }
  return el;
}

import { useEffect, useState } from 'react';

const cache = new Map<string, HTMLImageElement>();

/**
 * 只有跨域 http(s) 地址才加 crossOrigin（导出 canvas 需要）；站内路径（/media、/api/overlays，
 * 受访问码 Cookie 限制）、data: / blob: 一律按原样加载。
 */
function needsCrossOrigin(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return typeof location !== 'undefined' && new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

/** 加载图片（带缓存）；url 为空时返回 undefined。 */
export function useImage(url: string | undefined | null): HTMLImageElement | undefined {
  const [img, setImg] = useState<HTMLImageElement | undefined>(() => (url ? cache.get(url) : undefined));
  useEffect(() => {
    if (!url) {
      setImg(undefined);
      return;
    }
    const hit = cache.get(url);
    if (hit) {
      setImg(hit);
      return;
    }
    let alive = true;
    const el = new Image();
    if (needsCrossOrigin(url)) el.crossOrigin = 'anonymous';
    el.onload = () => {
      cache.set(url, el);
      if (alive) setImg(el);
    };
    el.onerror = () => {
      if (alive) setImg(undefined);
    };
    el.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return img;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const el = new Image();
    if (needsCrossOrigin(url)) el.crossOrigin = 'anonymous';
    el.onload = () => {
      cache.set(url, el);
      resolve(el);
    };
    el.onerror = () => reject(new Error('图片加载失败'));
    el.src = url;
  });
}

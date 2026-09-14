// 上传字体的加载：通过 FontFace API 注册到 document.fonts，family 取 asset.family。

import type { Asset } from '../types';

const loaded = new Map<string, Promise<void>>();

export function ensureFontLoaded(asset: Asset): Promise<void> {
  if (asset.type !== 'font' || !asset.family) return Promise.resolve();
  const key = asset.family;
  const hit = loaded.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      if (typeof FontFace === 'undefined') return;
      const face = new FontFace(key, `url("${asset.url}")`);
      await face.load();
      document.fonts.add(face);
    } catch (e) {
      console.warn('字体加载失败', asset.name, e);
    }
  })();
  loaded.set(key, p);
  return p;
}

export function ensureFontsLoaded(assets: Asset[]): Promise<void> {
  return Promise.all(assets.map(ensureFontLoaded)).then(() => undefined);
}

export const BUILTIN_FONT_FAMILY = 'Noto Sans SC';

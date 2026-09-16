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

/**
 * index.html 里通过 Google Fonts 引入的内置 web 字体（与那条 <link> 保持一致）。
 * 第一个是中文默认；其余按目标语言由 lib/localize.FONT_BY_LANG 选用，字体下拉里也列出来。
 * Google Fonts 不可达时浏览器退回系统同语种字体：可读但样式不一致。
 */
export const BUILTIN_WEB_FONTS: { family: string; label: string }[] = [
  { family: BUILTIN_FONT_FAMILY, label: '内置' },
  { family: 'Noto Sans KR', label: '韩文' },
  { family: 'Noto Sans JP', label: '日文' },
  { family: 'Noto Sans Thai', label: '泰文' },
];

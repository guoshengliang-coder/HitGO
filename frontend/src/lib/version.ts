// 顶栏 / 导航栏 HitGO 旁显示的版本号（HIG-14）：只显示最近的 git tag，如 v0.8.0。
// 原始值在构建期由 vite.config.ts 注入（__APP_VERSION__），这里只做规整。

/** 规整版本号：去空白；误传完整 git describe（v0.8.0-3-gabc1234）时裁成 tag；取不到时返回 dev。 */
export function formatVersion(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return 'dev';
  const described = /^(.+)-\d+-g[0-9a-f]+$/.exec(v);
  return described ? described[1] : v;
}

export const APP_VERSION = formatVersion(typeof __APP_VERSION__ === 'undefined' ? '' : __APP_VERSION__);

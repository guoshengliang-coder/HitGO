// 把音频拖进时间线（HIG-33）的纯逻辑：认拖拽载荷、按落点算新音轨的角色和时段。
// 两种来源：音频面板里的素材卡片（自定义 MIME，不带 'Files'，所以不会让 DropZone 亮起"松手上传"），
// 和从系统里拖进来的文件（先上传，就绪后在记住的落点加轨）。

import type { AssetType, AudioRole, TimeWindow } from '../types';

export const ASSET_DRAG_MIME = 'application/x-hitgo-asset';

export interface AssetDragPayload {
  id: string;
  type: AssetType;
}

export function encodeAssetDrag(p: AssetDragPayload): string {
  return JSON.stringify({ id: p.id, type: p.type });
}

/** 解析卡片写进 dataTransfer 的载荷；不是本应用写的（或格式不对）返回 null。 */
export function parseAssetDrag(raw: string | null | undefined): AssetDragPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AssetDragPayload>;
    if (typeof v?.id !== 'string' || !v.id || typeof v.type !== 'string') return null;
    return { id: v.id, type: v.type as AssetType };
  } catch {
    return null;
  }
}

/** dragover 阶段读不到数据，只能看 types：是不是素材卡片拖过来的。 */
export function isAssetDrag(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes(ASSET_DRAG_MIME);
}

/** 落在哪一行决定角色：落在口播音轨行上加口播，其余（BGM 行、源音轨、空白处）都加 BGM。 */
export function dropRole(rowRole: AudioRole | null | undefined): AudioRole {
  return rowRole === 'voice' ? 'voice' : 'bgm';
}

const MIN_WINDOW = 0.1;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 新音轨的时段（剪后时间）。落在开头（< 0.05 s）的 BGM 用「全程」，和点「+ BGM」一致；
 * 其余从落点开始：BGM 循环铺到结尾，口播按素材时长放一遍（时长未知时铺到结尾）。
 * 落点太靠后、剩下不够 0.1 s 时往前挪，保证时段有效。
 */
export function dropWindow(opts: { start: number; role: AudioRole; postDuration: number; mediaDuration?: number | null }): TimeWindow {
  const post = Math.max(0, opts.postDuration);
  if (post <= MIN_WINDOW) return 'all';
  const start = Math.min(Math.max(0, opts.start), post - MIN_WINDOW);
  if (opts.role === 'bgm' && start < 0.05) return 'all';
  const media = opts.mediaDuration ?? 0;
  const end = opts.role === 'voice' && media > 0 ? Math.min(post, start + media) : post;
  const a = round2(start);
  const b = round2(Math.max(end, a + MIN_WINDOW));
  return [a, Math.min(b, round2(post))];
}

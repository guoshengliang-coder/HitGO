// 素材来源分栏与筛选。前端一次性把全部素材拉进 store，所以筛选在本地做；
// 接正式物料库后只需让 'library' 这一栏多出 source === 'library' 的素材，见 docs/ASSETS.md。
import { isVideoAsset, type Asset, type AssetSource, type AssetType } from '../types';

/** 界面上的两栏：原料库（内置示例 + 将来的正式物料库）/ 我上传的。 */
export type AssetBucket = 'library' | 'mine';

const BUCKET_SOURCES: Record<AssetBucket, AssetSource[]> = {
  library: ['builtin', 'library'],
  mine: ['upload'],
};

export function bucketOf(asset: Asset): AssetBucket {
  return asset.source === 'upload' ? 'mine' : 'library';
}

/** 只有自己上传的素材能删；builtin 下次启动会被重新导入，library 归正式系统管。 */
export function canDelete(asset: Asset): boolean {
  return asset.source === 'upload';
}

// 契约 §3 的单文件上限。前端先挡一次，免得几百 MB 传完才被后端 400。
const MiB = 1024 * 1024;
export const UPLOAD_LIMITS = { image: 10 * MiB, video: 1024 * MiB, font: 20 * MiB, audio: 50 * MiB } as const;
const VIDEO_STICKER_EXT = /\.(mp4|mov|webm)$/i;

function humanSize(bytes: number): string {
  return bytes >= 1024 * MiB ? `${bytes / (1024 * MiB)} GiB` : `${Math.round(bytes / MiB)} MiB`;
}

/** 该素材文件的上限（字节）。视频贴纸按扩展名判断，多帧 gif / webp 仍按图片上限（与后端一致）。 */
export function uploadLimit(type: AssetType, filename: string): number {
  if (type === 'font') return UPLOAD_LIMITS.font;
  if (type === 'audio') return UPLOAD_LIMITS.audio;
  return VIDEO_STICKER_EXT.test(filename) ? UPLOAD_LIMITS.video : UPLOAD_LIMITS.image;
}

/** 第一个超限文件的中文提示；都没超限返回 null。文案与后端 400 保持同一口径。 */
export function oversizedUpload(type: AssetType, files: { name: string; size: number }[]): string | null {
  for (const f of files) {
    const limit = uploadLimit(type, f.name);
    if (f.size > limit) return `${f.name}：文件超过 ${humanSize(limit)} 上限`;
  }
  return null;
}

/** 贴纸面板里的形态筛选：全部 / 静态图 / 视频贴纸。 */
export type StickerKindFilter = 'all' | 'image' | 'video';

export function filterAssets(
  assets: Asset[],
  opts: { type?: AssetType; bucket?: AssetBucket; q?: string; kind?: StickerKindFilter } = {},
): Asset[] {
  const { type, bucket, q, kind } = opts;
  const needle = (q ?? '').trim().toLowerCase();
  const sources = bucket ? BUCKET_SOURCES[bucket] : null;
  return assets.filter((a) => {
    if (type && a.type !== type) return false;
    if (sources && !sources.includes(a.source)) return false;
    if (kind === 'video' && !isVideoAsset(a)) return false;
    if (kind === 'image' && isVideoAsset(a)) return false;
    if (needle && !a.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

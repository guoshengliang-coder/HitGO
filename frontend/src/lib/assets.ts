// 素材来源分栏与筛选。前端一次性把全部素材拉进 store，所以筛选在本地做；
// 接正式物料库后只需让 'library' 这一栏多出 source === 'library' 的素材，见 docs/ASSETS.md。
import type { Asset, AssetSource, AssetType } from '../types';

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

export function filterAssets(
  assets: Asset[],
  opts: { type?: AssetType; bucket?: AssetBucket; q?: string } = {},
): Asset[] {
  const { type, bucket, q } = opts;
  const needle = (q ?? '').trim().toLowerCase();
  const sources = bucket ? BUCKET_SOURCES[bucket] : null;
  return assets.filter((a) => {
    if (type && a.type !== type) return false;
    if (sources && !sources.includes(a.source)) return false;
    if (needle && !a.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// 右上角「导出」的范围（HIG-8）：这一批全部（默认）/ 左侧勾选 / 仅当前。
// 还没预处理完（或预处理失败）的视频不能保存 spec，也不能提交渲染（后端整单 400），这里提前剔掉并计数。

import { VARIANT_DEFS, type VariantKey, type Video } from '../types';

export type ExportScope = 'batch' | 'selected' | 'current';

export interface ExportTargets {
  /** 实际提交的视频 id，按批次里的顺序。 */
  ids: string[];
  /** 范围内但未就绪、被跳过的视频 id。 */
  skipped: string[];
}

export function resolveExportTargets(
  videos: Pick<Video, 'id' | 'status'>[],
  scope: ExportScope,
  selectedIds: string[],
  currentId: string | null,
): ExportTargets {
  const inScope =
    scope === 'batch'
      ? videos
      : scope === 'selected'
        ? videos.filter((v) => selectedIds.includes(v.id))
        : videos.filter((v) => v.id === currentId);
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const v of inScope) (v.status === 'ready' ? ids : skipped).push(v.id);
  return { ids, skipped };
}

// ---- 导出画幅（HIG-29）：勾选这次出哪些画幅 ----
// HIG-35 起勾选存在当前视频 spec 的 outputs[].export；这里读本机的旧记录只给没写过勾选的老 spec 兜底，不再写入。

const VARIANTS_KEY = 'hitgo.exportVariants';
const ALL_KEYS: VariantKey[] = VARIANT_DEFS.map((d) => d.key);

/** 清洗勾选：只留认识的画幅、按画幅顺序、至少一个（空时回到 9x16）。 */
export function cleanExportVariants(list: unknown): VariantKey[] {
  const set = new Set(Array.isArray(list) ? list : []);
  const out = ALL_KEYS.filter((k) => set.has(k));
  return out.length ? out : ['9x16'];
}

export function loadExportVariants(storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): VariantKey[] {
  try {
    const raw = storage?.getItem(VARIANTS_KEY);
    return cleanExportVariants(raw ? JSON.parse(raw) : null);
  } catch {
    return ['9x16'];
  }
}

/** 勾选 / 取消一个画幅；不允许把最后一个取消掉。 */
export function toggleExportVariant(list: VariantKey[], key: VariantKey): VariantKey[] {
  if (list.includes(key)) return list.length > 1 ? list.filter((k) => k !== key) : list;
  return cleanExportVariants([...list, key]);
}

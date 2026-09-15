// 右上角「导出」的范围（HIG-8）：这一批全部（默认）/ 左侧勾选 / 仅当前。
// 还没预处理完（或预处理失败）的视频不能保存 spec，也不能提交渲染（后端整单 400），这里提前剔掉并计数。

import type { Video } from '../types';

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

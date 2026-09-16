// 编辑器左栏视频列表的纯逻辑：预处理轮询（HIG-24）与删除后的选中项（HIG-20）。

import type { Video } from '../types';

/** 还有视频在预处理：编辑器据此决定要不要继续拉批次详情。 */
export function hasPreparingVideos(videos: readonly Pick<Video, 'status'>[]): boolean {
  return videos.some((v) => v.status === 'preparing');
}

/**
 * 删掉一批视频后当前该落在哪条：当前这条没被删就不动；被删了就取它原位置之后第一条留下来的，
 * 后面没有了再往前找（删最后一条时停在新的最后一条）。一条都不剩返回 null。
 */
export function nextCurrentAfterDelete(videos: readonly Pick<Video, 'id'>[], currentId: string | null, deletedIds: readonly string[]): string | null {
  const gone = new Set(deletedIds);
  const remaining = videos.filter((v) => !gone.has(v.id));
  if (currentId && !gone.has(currentId) && remaining.some((v) => v.id === currentId)) return currentId;
  const at = videos.findIndex((v) => v.id === currentId);
  if (at >= 0) {
    const after = videos.slice(at + 1).find((v) => !gone.has(v.id));
    if (after) return after.id;
    const before = videos
      .slice(0, at)
      .reverse()
      .find((v) => !gone.has(v.id));
    if (before) return before.id;
  }
  return remaining[0]?.id ?? null;
}

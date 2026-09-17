// 产物页批量下载（HIG-47）的勾选逻辑：只有已完成、有成片地址的行能勾；列表变了（刷新 / 搜索 / 加载更多）
// 就把看不见的勾去掉，免得打包进用户看不到的文件。打包本身由后端 POST /api/outputs/zip 边打边传。

import type { Job } from '../types';

/** 与后端 MAX_ZIP_JOBS 一致：一次最多打包的产物数。 */
export const MAX_ZIP_JOBS = 500;

export function isDownloadable(job: Pick<Job, 'status' | 'output_url'>): boolean {
  return job.status === 'done' && !!job.output_url;
}

/** 列表里可勾选的 id，保持列表顺序。 */
export function downloadableIds(jobs: Job[]): string[] {
  return jobs.filter(isDownloadable).map((j) => j.id);
}

/** 只保留当前列表里还可勾选的 id；没有变化时返回原数组（React 据此跳过重渲染）。 */
export function pruneSelection(selected: string[], jobs: Job[]): string[] {
  const ok = new Set(downloadableIds(jobs));
  const next = selected.filter((id) => ok.has(id));
  return next.length === selected.length ? selected : next;
}

export function toggleOne(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** 表头全选框的状态。 */
export function headState(selected: string[], jobs: Job[]): 'none' | 'some' | 'all' {
  const ids = downloadableIds(jobs);
  const on = ids.filter((id) => selected.includes(id)).length;
  if (on === 0) return 'none';
  return on === ids.length ? 'all' : 'some';
}

/** 表头全选框点击：全选了就清空，否则勾上全部可下载的行。 */
export function toggleAll(selected: string[], jobs: Job[]): string[] {
  return headState(selected, jobs) === 'all' ? [] : downloadableIds(jobs);
}

/** 按列表顺序给出要打包的 id（后端按这个顺序写进 zip），以及已知大小之和（缺 output.size 的行不计）。 */
export function selectionSummary(selected: string[], jobs: Job[]): { ids: string[]; bytes: number } {
  const set = new Set(selected);
  const rows = jobs.filter((j) => set.has(j.id) && isDownloadable(j));
  return { ids: rows.map((j) => j.id), bytes: rows.reduce((sum, j) => sum + (j.output?.size ?? 0), 0) };
}

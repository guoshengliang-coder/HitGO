// 从系统里把文件拖进页面（HIG-21）的纯逻辑：认不认这次拖拽、哪些文件收、哪些跳过。

/** 批次视频可上传的格式，和新建批次表单的 input accept 一致（契约 §3）。 */
export const VIDEO_ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';

/**
 * 这次拖拽带的是不是系统文件。页面内部的拖拽（图层排序用 text/plain）不算，
 * 否则拖图层时整块区域都会亮起"松手上传"。
 */
export function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types).includes('Files');
}

/**
 * 按 input 的 accept 语法筛文件：`.ext`、`type/subtype`、`type/*`，逗号分隔。
 * 浏览器对拖进来的文件不做 accept 过滤，只能自己来。空 accept = 全收。
 */
export function splitByAccept<F extends { name: string; type: string }>(files: readonly F[], accept: string): { accepted: F[]; rejected: F[] } {
  const rules = accept
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const accepted: F[] = [];
  const rejected: F[] = [];
  for (const f of files) {
    (rules.length === 0 || rules.some((r) => matches(f, r)) ? accepted : rejected).push(f);
  }
  return { accepted, rejected };
}

function matches(f: { name: string; type: string }, rule: string): boolean {
  const name = f.name.toLowerCase();
  const type = (f.type || '').toLowerCase();
  if (rule.startsWith('.')) return name.endsWith(rule);
  if (rule.endsWith('/*')) return !!type && type.startsWith(rule.slice(0, -1));
  return !!type && type === rule;
}

/** 跳过的文件怎么告诉用户：最多列 3 个名字，其余说个数。 */
export function rejectedText(rejected: readonly { name: string }[], what: string): string | null {
  if (!rejected.length) return null;
  const names = rejected
    .slice(0, 3)
    .map((f) => `「${f.name}」`)
    .join('');
  const more = rejected.length > 3 ? `等 ${rejected.length} 个文件` : '';
  return `已跳过${names}${more}：只支持 ${what}`;
}

/** 往待上传列表里加文件：同名同大小的视为同一个，不重复加（拖两次同一批文件时常见）。 */
export function mergeFiles<F extends { name: string; size: number }>(prev: readonly F[], added: readonly F[]): F[] {
  const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
  const out = [...prev];
  for (const f of added) {
    const key = `${f.name}:${f.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

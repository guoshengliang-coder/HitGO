// 列表页按名称搜索（HIG-27）。

/** 名称是否包含搜索词：忽略前后空白和大小写；搜索词为空时全都算匹配。 */
export function matchesQuery(name: string | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (name ?? '').toLowerCase().includes(q);
}

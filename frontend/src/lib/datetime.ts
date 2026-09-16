// 日期时间显示：后端一律回 ISO 串，界面上要的是「哪天几点」。
// 这里只管墙钟时间的展示，时间轴/时长的换算在 lib/time.ts。

/** ISO 串 → `YYYY-MM-DD HH:mm`（本地时区）。解析不出来就原样返回，不吞掉异常数据。 */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 同上，但允许 null / undefined（任务没跑完就没有完成时间）。 */
export function fmtDateOr(iso: string | null | undefined, fallback = '—'): string {
  return iso ? fmtDate(iso) : fallback;
}

/** 字节数 → 人读的大小。 */
export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

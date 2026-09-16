// 数值输入块的拖动微调（docs/DESIGN.md §3.2）：在块上按住左右拖，按 step 走；
// 纯函数，Num 组件只负责把指针事件换算成 dx 再调这里。

/** 每走一档需要拖多少像素；太小会抖，太大要拖很远。 */
export const SCRUB_PX_PER_STEP = 4;
/** 按下后移动超过这个距离才算拖动，否则是单击进入编辑。 */
export const SCRUB_THRESHOLD_PX = 3;

export function clampNum(v: number, min?: number, max?: number): number {
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
}

/** 去掉浮点尾巴：0.1 + 0.2 → 0.3。 */
export function tidy(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * 从按下时的值 start 与水平位移 dx 算出新值。shift 十倍步进、alt 十分之一步进。
 * 位移不足一档时返回 start 本身（拖动开始前不改值）。
 */
export function scrubValue(start: number, dx: number, step: number, opts: { min?: number; max?: number; shift?: boolean; alt?: boolean } = {}): number {
  const unit = opts.shift ? step * 10 : opts.alt ? step / 10 : step;
  const steps = Math.trunc(dx / SCRUB_PX_PER_STEP);
  if (steps === 0) return start;
  return clampNum(tidy(start + steps * unit), opts.min, opts.max);
}

/** 键盘上下键步进（同样支持 shift / alt）。 */
export function nudgeValue(value: number, dir: 1 | -1, step: number, opts: { min?: number; max?: number; shift?: boolean; alt?: boolean } = {}): number {
  const unit = opts.shift ? step * 10 : opts.alt ? step / 10 : step;
  return clampNum(tidy(value + dir * unit), opts.min, opts.max);
}

/** 内部单位 → 显示值（默认 ×100 显示为百分比），最多两位小数。 */
export function shownValue(value: number, scale: number): number {
  return Math.round(value * scale * 100) / 100;
}

/** 显示值 → 内部单位；解析失败返回 null（保持原值）。允许 "8"、"8.5"、"-3"、"  12 " 这类输入。 */
export function parseShown(text: string, scale: number, min?: number, max?: number): number | null {
  const n = parseFloat(text.trim());
  if (!Number.isFinite(n)) return null;
  return clampNum(tidy(n / scale), min, max);
}

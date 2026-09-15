// 变体预览的重绘节奏。
//
// 播放时预览不该跟着 React 每帧重渲染走（那正是 HIG-5：依赖 postTime 的 effect 每帧
// cleanup 掉自己还没执行的 rAF，绘制永远排不上）。改成一个常驻 rAF 循环按这里的间隔取帧，
// 判定抽成纯函数是为了能测。

export interface PreviewTiming {
  /** 播放中 */
  playing: boolean;
  /** 是否当前选中的变体 */
  selected: boolean;
  /** 是否在视口里（变体面板可横向滚动） */
  visible: boolean;
}

/** 选中变体播放时的重绘间隔（毫秒）：0 = 每个 rAF 都画。 */
export const SELECTED_INTERVAL_MS = 0;
/** 未选中变体播放时的重绘间隔（毫秒）：约 8Hz，够看出在动，又不会 4 路大图吃满主线程。 */
export const UNSELECTED_INTERVAL_MS = 125;

/** 返回重绘间隔；null 表示这一轮不该画。 */
export function previewIntervalMs({ playing, selected, visible }: PreviewTiming): number | null {
  if (!visible) return null;
  if (!playing) return 0; // 暂停时每次状态变化都要立刻反映（逐帧、拖 playhead、改 fill）
  return selected ? SELECTED_INTERVAL_MS : UNSELECTED_INTERVAL_MS;
}

/** 距上次绘制是否已到间隔。last 传 -Infinity 表示从未画过。 */
export function isDue(now: number, last: number, intervalMs: number): boolean {
  if (!Number.isFinite(last)) return true;
  if (intervalMs <= 0) return true;
  const elapsed = now - last;
  if (elapsed < 0) return true; // 时钟回退（performance.now 理论上单调，但别让它卡死）
  return elapsed >= intervalMs;
}

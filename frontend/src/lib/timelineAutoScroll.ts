export const TIMELINE_EDGE_PX = 56;
export const TIMELINE_MAX_SCROLL_PX_S = 900;

/** Horizontal pixels to scroll this frame while a scrub pointer sits near/outside an edge. */
export function timelineAutoScrollDelta(
  clientX: number,
  left: number,
  right: number,
  elapsedMs: number,
): number {
  const edge = Math.min(TIMELINE_EDGE_PX, Math.max(0, (right - left) / 2));
  if (edge <= 0 || elapsedMs <= 0) return 0;
  let strength = 0;
  if (clientX < left + edge) strength = -Math.min(1, (left + edge - clientX) / edge);
  else if (clientX > right - edge) strength = Math.min(1, (clientX - (right - edge)) / edge);
  return strength * TIMELINE_MAX_SCROLL_PX_S * Math.min(elapsedMs, 50) / 1000;
}

export const TRACK_LABEL_DEFAULT = 128;
export const TRACK_LABEL_MIN = 112;
export const TRACK_LABEL_MAX = 360;
const KEY = 'hitgo.timeline.labelWidth';

export function clampTrackLabelWidth(width: number, container = 1000): number {
  const max = Math.max(TRACK_LABEL_MIN, Math.min(TRACK_LABEL_MAX, container * 0.45));
  return Math.round(Math.max(TRACK_LABEL_MIN, Math.min(max, Number.isFinite(width) ? width : TRACK_LABEL_DEFAULT)));
}

export function loadTrackLabelWidth(): number {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? TRACK_LABEL_DEFAULT : clampTrackLabelWidth(Number(raw));
  } catch { return TRACK_LABEL_DEFAULT; }
}

export function saveTrackLabelWidth(width: number): void {
  try { localStorage.setItem(KEY, String(clampTrackLabelWidth(width))); } catch { /* 本机偏好不可用时仍可调宽 */ }
}

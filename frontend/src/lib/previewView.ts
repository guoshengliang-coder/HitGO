/** Local preview coordinates; never part of edit_spec or undo history. */
export interface PreviewView { scale: number; x: number; y: number }
export const FIT_VIEW: PreviewView = { scale: 1, x: 0, y: 0 };
export const MIN_PREVIEW_SCALE = 0.25;
export const MAX_PREVIEW_SCALE = 4;

/** Anchor is measured from the viewport centre, before applying its view transform. */
export function zoomPreview(view: PreviewView, scale: number, anchor: { x: number; y: number }): PreviewView {
  const next = Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, scale));
  if (!Number.isFinite(next) || next === view.scale) return view;
  const ratio = next / view.scale;
  return { scale: next, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio };
}

export function wheelPreview(view: PreviewView, deltaY: number, deltaMode: number, pageHeight: number, anchor: { x: number; y: number }): PreviewView {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  return zoomPreview(view, view.scale * Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.002), anchor);
}

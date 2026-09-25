export interface TimelinePointerLike {
  button: number;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** 普通左键单击 Clip 才定位；组合选择和边缘拖拽保留原语义。 */
export function shouldSeekTimelineClip(e: TimelinePointerLike): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

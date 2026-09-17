// 产物页「播放」（HIG-52）：成片是同源的 H.264 MP4（/media 静态文件，支持 Range），直接交给 <video> 播放。
// 这里只算播放器尺寸：按成片宽高比塞进可用区域，竖版 9:16 不被撑出视口。

/** 播放器尺寸：保持 w:h，不超过 maxW × maxH；缺少宽高时按 16:9 处理。 */
export function fitPlayerBox(w: number | undefined, h: number | undefined, maxW: number, maxH: number): { width: number; height: number } {
  const aspect = w && h && w > 0 && h > 0 ? w / h : 16 / 9;
  const boundW = Math.max(1, maxW);
  const boundH = Math.max(1, maxH);
  let width = boundW;
  let height = width / aspect;
  if (height > boundH) {
    height = boundH;
    width = height * aspect;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

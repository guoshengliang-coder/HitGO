// 画布拖入图片 / 贴纸卡片（HIG-46）：松手处作为贴纸中心，按参考画布（9:16）算 margin。
// 预览的是别的画幅时，图层几何仍按 9:16 存、落点换算不直观，退回面板的默认位置。

import { useRef, useState, type DragEvent, type RefObject } from 'react';
import { useEditor } from '../../store/editor';
import { isFileDrag } from '../../lib/fileDrop';
import { assetDragType, isAssetDrag, parseAssetDrag, ASSET_DRAG_MIME } from '../../lib/timelineDrop';
import { assetAspect, canvasDropMargin, defaultMargin } from '../../lib/imageDrop';
import type { Asset } from '../../types';
import { addStickerLayers, dropOverlays } from './stickerDrop';

export function useCanvasImageDrop(boxRef: RefObject<HTMLElement>, opts: { enabled: boolean; isRef: boolean }) {
  const [over, setOver] = useState(false);
  // 子元素之间移动也会成对触发 enter / leave，计数到 0 才算离开
  const depth = useRef(0);

  const accepts = (e: DragEvent) => {
    if (!opts.enabled) return false;
    if (isFileDrag(e.dataTransfer.types)) return true;
    return isAssetDrag(e.dataTransfer.types) && assetDragType(e.dataTransfer.types) === 'sticker';
  };
  const place = (e: DragEvent) => {
    const rect = boxRef.current?.getBoundingClientRect();
    const point = rect && rect.width > 0 && rect.height > 0 ? { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height } : null;
    return (asset: Asset, index: number) => ({ margin: opts.isRef && point ? canvasDropMargin(point, assetAspect(asset), index) : defaultMargin(index) });
  };

  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault(); // 不拦下 dragover，drop 不会触发，浏览器会直接打开图片
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!accepts(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const at = place(e);
      const card = parseAssetDrag(e.dataTransfer.getData(ASSET_DRAG_MIME));
      if (card) {
        const asset = useEditor.getState().assets.find((a) => a.id === card.id);
        if (asset && (asset.status ?? 'ready') === 'ready') addStickerLayers([asset], at);
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length) void dropOverlays(files, at);
    },
  };
  return { over, handlers };
}

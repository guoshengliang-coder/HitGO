// 遮盖层（契约 §2 type = "mask"）在画布上的两个部件：
// - MaskPreview：叠在 <video> 之上、Konva 之下的 div，用 backdrop-filter 实时模糊画面（GPU 合成，零成本），
//   色块模式用背景色 + 不透明度；拖动 / 拉伸中跟着实时框走，所以预览和把手始终对齐。
// - MaskNode：Konva Rect，只管命中、拖动（吸附参考线）、八向拉伸与选中框；没有旋转（worker 忽略 rotate）。
//   浏览器不支持 backdrop-filter 时模糊模式退回磨砂填充，色块仍由 MaskPreview 画。
// 松手后按契约公式反算 margin / width / height；遮盖没有素材宽高比，高度直接相对画布高。

import type { CSSProperties } from 'react';
import type Konva from 'konva';
import { Rect } from 'react-konva';
import { useEditor } from '../../store/editor';
import { marginFromBox, placeLayer, round4, type LayerBox } from '../../lib/layout';
import { layerAspect } from '../../lib/spec';
import { DEFAULT_MASK_COLOR, maskBlurLevel, maskBlurPx } from '../../lib/mask';
import type { MaskLayer } from '../../types';
import { GUIDE_COLOR, NO_GUIDES, snapDraggedNode, type Guides } from './stageSnap';

/** 是否能用 backdrop-filter 做真实模糊预览（Safari 走 -webkit- 前缀）。 */
export function supportsBackdropBlur(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  return CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
}

/** 遮盖在舞台上的像素框（未旋转；遮盖不旋转）。 */
export function maskStageBox(layer: MaskLayer, W: number, H: number): LayerBox {
  return placeLayer(layer, layerAspect(layer, []), { W, H });
}

export function MaskPreview({ layer, box, W, backdrop }: { layer: MaskLayer; box: LayerBox; W: number; backdrop: boolean }) {
  const style: CSSProperties = { left: box.x, top: box.y, width: box.w, height: box.h, opacity: layer.opacity };
  if (layer.mode === 'solid') {
    style.background = layer.color ?? DEFAULT_MASK_COLOR;
  } else if (backdrop) {
    const blur = `blur(${maskBlurPx(maskBlurLevel(layer), W)}px)`;
    style.backdropFilter = blur;
    style.WebkitBackdropFilter = blur;
  } else {
    return null; // 不支持 backdrop-filter：由 MaskNode 的磨砂填充顶上
  }
  return <div className="mask-preview" style={style} aria-hidden />;
}

export function MaskNode({
  layer,
  W,
  H,
  selectable,
  selected,
  backdrop,
  guides,
  onSelect,
  onGuides,
  onLive,
  registerNode,
  box: boxProp,
  onCommitVariant,
}: {
  layer: MaskLayer;
  W: number;
  H: number;
  selectable: boolean;
  selected: boolean;
  /** 页面能用 backdrop-filter 预览模糊；否则模糊模式在这里画磨砂填充 */
  backdrop: boolean;
  guides: Guides;
  onSelect: () => void;
  onGuides: (g: Guides) => void;
  /** 拖动 / 拉伸中的实时框（给 MaskPreview 跟随），松手后传 null */
  onLive: (box: LayerBox | null) => void;
  registerNode: (node: Konva.Rect | null) => void;
  /** 预览非 9:16 画幅时由 Stage 算好的舞台框（HIG-29）；缺省按图层本身在 9:16 画布上算。 */
  box?: LayerBox;
  /** 预览非 9:16 画幅时松手写回该画幅的覆盖，而不是改图层本身。 */
  onCommitVariant?: (box: LayerBox) => void;
}) {
  const updateLayer = useEditor((s) => s.updateLayer);
  const box = boxProp ?? maskStageBox(layer, W, H);
  const draggable = selectable && !layer.locked;
  const frosted = layer.mode !== 'solid' && !backdrop;

  const liveBox = (node: Konva.Rect): LayerBox => ({ x: node.x(), y: node.y(), w: node.width() * node.scaleX(), h: node.height() * node.scaleY() });
  const commit = (nb: LayerBox) => {
    if (onCommitVariant) {
      onCommitVariant(nb);
      return;
    }
    const margin = marginFromBox(nb, layer.anchor, { W, H });
    updateLayer(layer.id, {
      margin: [round4(margin[0]), round4(margin[1])],
      width: round4(Math.max(1, nb.w) / W),
      height: round4(Math.max(1, nb.h) / H),
    });
  };

  return (
    <Rect
      ref={registerNode}
      x={box.x}
      y={box.y}
      width={box.w}
      height={box.h}
      fill={frosted ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0)'}
      opacity={frosted ? layer.opacity : 1}
      draggable={draggable}
      listening={selectable}
      onClick={onSelect}
      onTap={onSelect}
      onDragStart={onSelect}
      onDragMove={(e) => {
        snapDraggedNode(e.target, e.evt, guides, onGuides);
        onLive(liveBox(e.target as Konva.Rect));
      }}
      onDragEnd={(e) => {
        onGuides(NO_GUIDES);
        onLive(null);
        commit(liveBox(e.target as Konva.Rect));
      }}
      onTransform={(e) => onLive(liveBox(e.target as Konva.Rect))}
      onTransformEnd={(e) => {
        onGuides(NO_GUIDES);
        onLive(null);
        const node = e.target as Konva.Rect;
        const nb = liveBox(node);
        node.scaleX(1);
        node.scaleY(1);
        node.width(nb.w);
        node.height(nb.h);
        commit(nb);
      }}
      stroke={selected ? GUIDE_COLOR : selectable ? 'rgba(255,255,255,0.6)' : undefined}
      strokeWidth={selected || selectable ? 1 : 0}
      dash={selected ? undefined : [4, 3]}
      strokeScaleEnabled={false}
    />
  );
}

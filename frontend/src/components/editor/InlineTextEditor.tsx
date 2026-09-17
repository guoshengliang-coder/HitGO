// 画布内联文字编辑：双击文字图层后，在图层所在位置叠一个 textarea 直接改字（对齐剪映）。
// 输入实时写入 store 但不产生历史；失焦 / ⌘Enter 提交时把挂载时抓的 spec 快照压入历史；Esc 还原双击时的原文并退出。
// 位置用 lib/layout.placeLayer 的契约公式算，与 Konva 节点同一套坐标；旋转绕中心，与图层一致。
// 开了自动换行（style.wrap_width，HIG-51）时输入框宽度、内边距和字号按烤好的 PNG 换算，折行位置与画布上基本一致。

import { useEffect, useRef } from 'react';
import { useEditor } from '../../store/editor';
import { placeLayer } from '../../lib/layout';
import { cloneSpec, layerAspect } from '../../lib/spec';
import { getCachedText, TEXT_CANVAS } from '../../lib/textImage';
import type { EditSpec, TextLayer } from '../../types';

const MIN_W = 120;
const MIN_H = 40;

export function InlineTextEditor({ layer, W, H, onClose }: { layer: TextLayer; W: number; H: number; onClose: () => void }) {
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const pushHistorySnapshot = useEditor((s) => s.pushHistorySnapshot);
  const ref = useRef<HTMLTextAreaElement>(null);
  const original = useRef(layer.text); // 挂载时的原文，Esc 时还原
  // 挂载时（还没改字）的整份 spec，提交时作为撤销点压入历史
  const snapshot = useRef<EditSpec | null>(null);
  if (snapshot.current === null) {
    const spec = useEditor.getState().currentSpec();
    snapshot.current = spec ? cloneSpec(spec) : null;
  }
  const latest = useRef(layer.text);
  latest.current = layer.text;
  const ready = useRef(false); // 挂载聚焦完成前忽略 blur，避免双击的余波把编辑框立刻关掉
  const closed = useRef(false);

  const finish = (mode: 'commit' | 'cancel') => {
    if (closed.current) return;
    closed.current = true;
    if (mode === 'cancel') updateLayer(layer.id, { text: original.current }, false);
    else if (latest.current !== original.current && snapshot.current) pushHistorySnapshot(snapshot.current); // 只在真的改过时记一条历史
    onClose();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.select();
    const t = window.setTimeout(() => {
      ready.current = true;
    }, 0);
    return () => {
      window.clearTimeout(t);
      // 父组件因切视频 / 切步骤 / 换选中而卸载编辑框时，把已改的文字作为一条历史落下
      finishRef.current('commit');
    };
  }, []);

  const box = placeLayer(layer, layerAspect(layer, assets), { W, H });
  const st = layer.style;
  const rendered = getCachedText(layer);
  const wrap = st.wrap_width && st.wrap_width > 0 && rendered ? st.wrap_width : null;
  // 舞台像素 / PNG 像素（PNG 按 1080×1920 基准渲染）
  const ratio = wrap && rendered ? box.w / rendered.width : H / TEXT_CANVAS.H;
  const w = wrap ? box.w : Math.max(MIN_W, box.w);
  const h = Math.max(MIN_H, box.h);
  const wrapInner = wrap ? (wrap * TEXT_CANVAS.W - 2 * (st.padding + st.stroke_width) * TEXT_CANVAS.H) * ratio : 0;
  const padX = wrap ? Math.max(0, (w - wrapInner) / 2) : undefined;
  const style: React.CSSProperties = {
    left: box.x + box.w / 2 - w / 2,
    top: box.y + box.h / 2 - h / 2,
    width: w,
    height: h,
    transform: `rotate(${layer.rotate || 0}deg)`,
    fontSize: Math.max(10, st.font_size * TEXT_CANVAS.H * ratio),
    paddingLeft: padX,
    paddingRight: padX,
    overflowWrap: wrap ? 'anywhere' : undefined,
    fontFamily: `"${st.font_family}", sans-serif`,
    fontWeight: st.font_weight,
    lineHeight: st.line_height,
    textAlign: st.align,
    letterSpacing: st.letter_spacing ? `${st.letter_spacing}em` : undefined,
    opacity: layer.opacity,
  };

  return (
    <textarea
      ref={ref}
      className="inline-text-editor"
      style={style}
      value={layer.text}
      spellCheck={false}
      onChange={(e) => updateLayer(layer.id, { text: e.target.value }, false)}
      onBlur={() => {
        if (!ready.current) {
          ref.current?.focus();
          return;
        }
        finish('commit');
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish('cancel');
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish('commit');
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

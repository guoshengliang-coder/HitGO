// 面板分隔拖动条：竖条拖左右（调右栏宽），横条拖上下（调时间线高）。
// 只负责把拖动量回调出去，尺寸由父组件持有（见 lib/layoutPrefs）。双击恢复默认。

import { useRef } from 'react';

export function Splitter({ axis, onMove, onReset, label }: { axis: 'x' | 'y'; onMove: (delta: number) => void; onReset: () => void; label: string }) {
  const start = useRef<number | null>(null);
  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={`${label} · 双击恢复默认`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        start.current = axis === 'x' ? e.clientX : e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('active');
        // 拖动期间禁止全页选中文字，并让光标保持 resize 形状
        document.body.classList.add(axis === 'x' ? 'is-resizing-x' : 'is-resizing-y');
        e.preventDefault();
      }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={(e) => {
        if (start.current === null) return;
        const cur = axis === 'x' ? e.clientX : e.clientY;
        onMove(cur - start.current);
        start.current = cur;
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.classList.remove('active');
        document.body.classList.remove('is-resizing-x', 'is-resizing-y');
      }}
      onPointerCancel={(e) => {
        start.current = null;
        e.currentTarget.classList.remove('active');
        document.body.classList.remove('is-resizing-x', 'is-resizing-y');
      }}
      onDoubleClick={onReset}
    />
  );
}

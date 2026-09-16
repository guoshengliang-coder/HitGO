// 把系统文件拖进来上传的区域（HIG-21）。只认带 Files 的拖拽，页面内部拖拽（图层排序等）照常工作。

import { useRef, useState, type ReactNode } from 'react';
import { isFileDrag, splitByAccept } from '../../lib/fileDrop';

export function DropZone({
  accept,
  onFiles,
  disabled,
  hint,
  className,
  children,
}: {
  /** input accept 语法；浏览器不替拖入的文件过滤，这里按它分出收 / 不收 */
  accept: string;
  onFiles: (accepted: File[], rejected: File[]) => void;
  disabled?: boolean;
  /** 拖进来时遮罩上的字 */
  hint: string;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  // dragenter / dragleave 在子元素之间移动时也会成对触发，计数到 0 才算真离开
  const depth = useRef(0);

  const reset = () => {
    depth.current = 0;
    setOver(false);
  };

  return (
    <div
      className={`dropzone ${over ? 'over' : ''} ${className ?? ''}`}
      onDragEnter={(e) => {
        if (disabled || !isFileDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !isFileDrag(e.dataTransfer.types)) return;
        e.preventDefault(); // 不拦下 dragover，drop 不会触发，浏览器会直接打开文件
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (disabled || !isFileDrag(e.dataTransfer.types)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled || !isFileDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        reset();
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        const { accepted, rejected } = splitByAccept(files, accept);
        onFiles(accepted, rejected);
      }}
    >
      {children}
      {over && (
        <div className="dropzone-mask" aria-hidden>
          <span>{hint}</span>
        </div>
      )}
    </div>
  );
}

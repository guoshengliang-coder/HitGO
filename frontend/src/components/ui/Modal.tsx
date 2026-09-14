import { useEffect, type ReactNode } from 'react';
import { IconClose } from './Icons';

export function Modal({
  title,
  onClose,
  children,
  footer,
  className,
  width,
}: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" style={width ? { width } : undefined}>
        <div className="modal-head">
          <span>{title}</span>
          {onClose && (
            <button className="btn ghost icon sm" onClick={onClose} aria-label="关闭">
              <IconClose />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

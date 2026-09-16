// 分段组（docs/DESIGN.md §3.3）：同一容器内多选一，下沉的槽 + 抬起的激活段。替代橙边 chip。
import type { ReactNode } from 'react';

export interface SegOption<T> {
  v: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export function Seg<T extends string | number | boolean>({
  options,
  value,
  onChange,
  label,
  disabled,
  sepAfter,
  className,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** aria-label */
  label: string;
  disabled?: boolean;
  /** 在第 n 个（从 1 数）段后面画一条分隔线，例如左 / 中 / 右 | 上 / 中 / 下 */
  sepAfter?: number;
  className?: string;
}) {
  return (
    <div className={`segt ${className ?? ''}`} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <span key={String(o.v)} style={{ display: 'contents' }}>
          <button
            type="button"
            role="radio"
            aria-checked={o.v === value}
            className={o.v === value ? 'active' : ''}
            title={o.title}
            disabled={disabled || o.disabled}
            onClick={() => o.v !== value && onChange(o.v)}
          >
            {o.label}
          </button>
          {sepAfter === i + 1 && <span className="sp" />}
        </span>
      ))}
    </div>
  );
}

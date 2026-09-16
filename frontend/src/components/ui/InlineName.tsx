// 双击就地改名（批次名 / 视频名，HIG-27）。交互与图层名一致：Enter / 失焦提交，Esc 取消，清空视为取消。

import { useEffect, useRef, useState } from 'react';

export function InlineName({
  value,
  onSave,
  className,
  inputClassName,
  label,
  editRequested,
  onEditEnd,
}: {
  value: string;
  /** 返回 false 表示没存上（原因由调用方提示），留在显示态并保持原名 */
  onSave: (name: string) => Promise<boolean> | boolean | void;
  className?: string;
  inputClassName?: string;
  /** 用于 title / aria-label，例如「批次名」 */
  label: string;
  /** 外部要求进入编辑（例如行操作里的「重命名」按钮）：每次变成 true 都进一次编辑态 */
  editRequested?: boolean;
  /** 编辑结束（提交或取消）时回调，外部据此清掉 editRequested */
  onEditEnd?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Enter 会顺带触发 blur：只处理一次
  const settled = useRef(false);
  useEffect(() => {
    if (!editRequested) return;
    setDraft(value);
    settled.current = false;
    setEditing(true);
    // value 变化不该重新进入编辑：只在 editRequested 翻转时进
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequested]);

  if (!editing) {
    return (
      <span
        className={className}
        title={`${value}（双击重命名）`}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(value);
          settled.current = false;
          setEditing(true);
        }}
      >
        {value}
      </span>
    );
  }

  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    onEditEnd?.();
    const next = draft.trim();
    if (save && next && next !== value) void onSave(next);
  };

  return (
    <input
      className={`input sm ${inputClassName ?? ''}`}
      aria-label={`重命名${label}`}
      autoFocus
      maxLength={255}
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

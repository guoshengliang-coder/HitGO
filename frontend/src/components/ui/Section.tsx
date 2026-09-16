// 可折叠分组（原在 components/editor/LayerParts.tsx，HIG-17 提到 ui/ 供剪辑面板一起用）。
// 带 onToggle 时标题左侧出现启用勾选；带 onReset 时标题右侧出现「重置」；
// 带 summary 时折叠态下标题行右端显示摘要——收起来之后它就是这块设置唯一的可见信息；
// 带 id 时开合状态按 id 存本机（lib/sectionPrefs），刷新后保持。

import { useState, type ReactNode } from 'react';
import { IconChevron, IconReset } from './Icons';
import { HelpTip } from './HelpTip';
import { loadSectionPrefs, saveSectionOpen, sectionOpen } from '../../lib/sectionPrefs';

export function Section({
  title,
  id,
  summary,
  help,
  enabled,
  onToggle,
  onReset,
  defaultOpen = true,
  bodyClass = 'prop-grid',
  children,
}: {
  title: string;
  id?: string;
  summary?: ReactNode;
  help?: string;
  enabled?: boolean;
  onToggle?: (on: boolean) => void;
  onReset?: () => void;
  defaultOpen?: boolean;
  bodyClass?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => sectionOpen(loadSectionPrefs(), id, defaultOpen));
  const collapsed = !open || enabled === false;
  const set = (next: boolean) => {
    setOpen(next);
    if (id) saveSectionOpen(id, next);
  };
  return (
    <div className={`sec ${collapsed ? 'collapsed' : ''}`}>
      <div className="sec-head">
        {onToggle && (
          <input
            type="checkbox"
            checked={!!enabled}
            aria-label={`启用${title}`}
            onChange={(e) => {
              onToggle(e.target.checked);
              if (e.target.checked) set(true);
            }}
          />
        )}
        <button className="sec-title" onClick={() => enabled !== false && set(!open)} disabled={enabled === false} aria-expanded={!collapsed}>
          <span className="sec-name">{title}</span>
          {summary !== undefined && summary !== '' && <span className="sec-sum">{summary}</span>}
          <IconChevron open={!collapsed} />
        </button>
        {help && <HelpTip text={help} label={title} />}
        {onReset && (
          <button className="btn ghost icon sm" title="重置为默认值" aria-label={`重置${title}`} onClick={onReset} disabled={enabled === false}>
            <IconReset />
          </button>
        )}
      </div>
      {!collapsed && <div className={`sec-body ${bodyClass}`}>{children}</div>}
    </div>
  );
}

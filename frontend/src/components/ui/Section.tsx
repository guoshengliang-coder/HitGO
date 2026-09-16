// 可折叠分组（原在 components/editor/LayerParts.tsx，HIG-17 提到 ui/ 供剪辑面板一起用）。
// 两态（docs/DESIGN.md §3.1）：展开是卡片，折叠是一行摘要——收起来之后摘要就是这块设置唯一的可见信息。
// 带 onToggle 时标题左侧是启用开关，关闭时整组以灰色摘要行显示且不可展开；
// 带 onReset 时标题右侧有「重置」，hover 才出现；带 hint 时展开态标题右侧显示一句提示；
// enabled 为真或 changed 为真时卡片左侧亮一条橙线，表示这组有非默认值；
// 带 id 时开合状态按 id 存本机（lib/sectionPrefs），刷新后保持。

import { useState, type ReactNode } from 'react';
import { IconChevron, IconReset } from './Icons';
import { HelpTip } from './HelpTip';
import { loadSectionPrefs, saveSectionOpen, sectionOpen } from '../../lib/sectionPrefs';

export function Section({
  title,
  id,
  summary,
  hint,
  help,
  enabled,
  changed = false,
  onToggle,
  onReset,
  defaultOpen = true,
  bodyClass = 'prop-grid',
  children,
}: {
  title: string;
  id?: string;
  summary?: ReactNode;
  hint?: string;
  help?: string;
  enabled?: boolean;
  changed?: boolean;
  onToggle?: (on: boolean) => void;
  onReset?: () => void;
  defaultOpen?: boolean;
  bodyClass?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => sectionOpen(loadSectionPrefs(), id, defaultOpen));
  const off = enabled === false;
  const collapsed = !open || off;
  const marked = !off && (enabled === true || changed);
  const set = (next: boolean) => {
    setOpen(next);
    if (id) saveSectionOpen(id, next);
  };
  const showSummary = collapsed && !off && summary !== undefined && summary !== '';
  return (
    <div className={`sec ${collapsed ? 'collapsed' : ''} ${marked ? 'marked' : ''}`}>
      <div className="sec-head">
        {onToggle && (
          <button
            type="button"
            role="switch"
            aria-checked={!!enabled}
            aria-label={`启用${title}`}
            className={`sw ${enabled ? 'on' : ''}`}
            onClick={() => {
              onToggle(!enabled);
              if (!enabled) set(true);
            }}
          />
        )}
        <button className="sec-title" onClick={() => !off && set(!open)} disabled={off} aria-expanded={!collapsed}>
          <span className="sec-name">{title}</span>
          {showSummary && <span className="sec-sum">{summary}</span>}
          {off && <span className="sec-sum">关</span>}
          {!collapsed && hint && <span className="sec-hint">{hint}</span>}
          <IconChevron open={!collapsed} />
        </button>
        {help && <HelpTip text={help} label={title} />}
        {onReset && (
          <button className="btn ghost icon sm sec-reset" title="重置为默认值" aria-label={`重置${title}`} onClick={onReset} disabled={off}>
            <IconReset />
          </button>
        )}
      </div>
      {!collapsed && <div className={`sec-body ${bodyClass}`}>{children}</div>}
    </div>
  );
}

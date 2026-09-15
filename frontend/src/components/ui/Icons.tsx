// 小型内联 SVG 图标（不用 emoji）。
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export const IconPlay = () => (
  <svg {...base}><path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none" /></svg>
);
export const IconPause = () => (
  <svg {...base}><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" stroke="none" /></svg>
);
export const IconStepBack = () => (
  <svg {...base}><path d="M12 3v10L6 8z" fill="currentColor" stroke="none" /><path d="M4 3v10" /></svg>
);
export const IconStepFwd = () => (
  <svg {...base}><path d="M4 3v10l6-5z" fill="currentColor" stroke="none" /><path d="M12 3v10" /></svg>
);
export const IconUndo = () => (
  <svg {...base}><path d="M6 4 3 7l3 3" /><path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H6" /></svg>
);
export const IconRedo = () => (
  <svg {...base}><path d="m10 4 3 3-3 3" /><path d="M13 7H6.5a3.5 3.5 0 0 0 0 7H10" /></svg>
);
export const IconClose = () => (
  <svg {...base}><path d="m4 4 8 8M12 4l-8 8" /></svg>
);
export const IconTrash = () => (
  <svg {...base}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" /></svg>
);
export const IconEye = ({ off }: { off?: boolean }) => (
  <svg {...base}>
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
    {off && <path d="m3 13 10-10" />}
  </svg>
);
export const IconLock = ({ open }: { open?: boolean }) => (
  <svg {...base}>
    <rect x="3.5" y="7" width="9" height="7" rx="1" />
    {open ? <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0" /> : <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />}
  </svg>
);
export const IconUp = () => <svg {...base}><path d="m4 10 4-4 4 4" /></svg>;
export const IconDown = () => <svg {...base}><path d="m4 6 4 4 4-4" /></svg>;
export const IconCopy = () => (
  <svg {...base}><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>
);
export const IconText = () => <svg {...base}><path d="M3 3.5h10M8 3.5v9M6 12.5h4" /></svg>;
export const IconSticker = () => (
  <svg {...base}><path d="M3 3h10v6l-4 4H3z" /><path d="M9 13V9h4" /></svg>
);
export const IconPlus = () => <svg {...base}><path d="M8 3v10M3 8h10" /></svg>;
export const IconRetry = () => (
  <svg {...base}><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 2.5v3h-3" /></svg>
);
export const IconSpinner = () => (
  <svg {...base} style={{ animation: 'spin 1s linear infinite' }}><path d="M8 2a6 6 0 1 1-6 6" /></svg>
);
/** 删左：播放头左侧打叉。 */
export const IconCutLeft = () => (
  <svg {...base}><path d="M9 2.5v11" /><path d="m2.5 5.5 4 4M6.5 5.5l-4 4" /><path d="M11 8h3" strokeDasharray="1.5 1.5" /></svg>
);
/** 删右：播放头右侧打叉。 */
export const IconCutRight = () => (
  <svg {...base}><path d="M7 2.5v11" /><path d="m9.5 5.5 4 4M13.5 5.5l-4 4" /><path d="M2 8h3" strokeDasharray="1.5 1.5" /></svg>
);
export const IconCenterH = () => (
  <svg {...base}><path d="M8 1.5v13" strokeDasharray="2 1.5" /><rect x="3" y="5" width="10" height="6" rx="1" /></svg>
);
export const IconCenterV = () => (
  <svg {...base}><path d="M1.5 8h13" strokeDasharray="2 1.5" /><rect x="5" y="3" width="6" height="10" rx="1" /></svg>
);
export const IconCenter = () => (
  <svg {...base}><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /><rect x="5" y="5" width="6" height="6" rx="1" /></svg>
);
/** 安全区显示：frames = 虚线框；overlay = 实心叠层；none = 划掉。 */
export const IconSafeZone = ({ mode }: { mode: 'frames' | 'overlay' | 'none' }) => (
  <svg {...base}>
    <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
    {mode === 'frames' && <rect x="5" y="4" width="6" height="8" strokeDasharray="1.5 1.5" />}
    {mode === 'overlay' && <path d="M2.5 10.5h11v2.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z" fill="currentColor" stroke="none" />}
    {mode === 'none' && <path d="m4 13 8-10" />}
  </svg>
);
export const IconHelp = () => (
  <svg {...base}><circle cx="8" cy="8" r="6.2" /><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.8.6-.8 1.2" /><path d="M8 11.6h.01" strokeWidth={2} /></svg>
);
export const IconFit = () => (
  <svg {...base}><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" /><path d="M5 8h6" /><path d="m6.5 6.5-1.5 1.5 1.5 1.5M9.5 6.5 11 8l-1.5 1.5" /></svg>
);
export const IconRatio = () => (
  <svg {...base}><rect x="2" y="3" width="12" height="10" rx="1" /><rect x="5.5" y="2" width="5" height="12" rx="1" strokeDasharray="1.5 1.5" /></svg>
);

/* 六向对齐（属性面板） */
export const IconAlignLeft = () => (
  <svg {...base}><path d="M2.5 1.5v13" /><rect x="4.5" y="4" width="8" height="3" rx="0.8" /><rect x="4.5" y="9" width="5" height="3" rx="0.8" /></svg>
);
export const IconAlignRight = () => (
  <svg {...base}><path d="M13.5 1.5v13" /><rect x="3.5" y="4" width="8" height="3" rx="0.8" /><rect x="6.5" y="9" width="5" height="3" rx="0.8" /></svg>
);
export const IconAlignTop = () => (
  <svg {...base}><path d="M1.5 2.5h13" /><rect x="4" y="4.5" width="3" height="8" rx="0.8" /><rect x="9" y="4.5" width="3" height="5" rx="0.8" /></svg>
);
export const IconAlignBottom = () => (
  <svg {...base}><path d="M1.5 13.5h13" /><rect x="4" y="3.5" width="3" height="8" rx="0.8" /><rect x="9" y="6.5" width="3" height="5" rx="0.8" /></svg>
);
export const IconChevron = ({ open }: { open: boolean }) => (
  <svg {...base} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.12s' }}><path d="M6 3.5l4 4.5-4 4.5" /></svg>
);
export const IconReset = () => (
  <svg {...base}><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M3 2.5v3h3" /></svg>
);

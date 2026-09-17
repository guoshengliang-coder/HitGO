// 分组标题旁的「?」：把常驻的说明文字收起来，需要时再看（HIG-17）。
// 沿用全站的纯 CSS 气泡（styles.css 的 [data-tip]），额外挂 .tip-wide 让长文案换行——
// 默认的 data-tip 是 nowrap 且居中，右栏只有 320px 宽，一句话就冲出去了。
// 气泡默认朝上；面板第一个分组的「?」离滚动容器顶太近，朝上会被裁成一条（HIG-57），悬停 / 聚焦时量一下再决定朝向。

import { useState } from 'react';
import { tipSide } from '../../lib/popover';
import { IconHelp } from './Icons';

/** 会裁掉气泡的最近祖先（overflow 不是 visible 的那个）；找不到用视口顶。 */
function clipTopOf(el: HTMLElement): number {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') return p.getBoundingClientRect().top;
  }
  return 0;
}

export function HelpTip({ text, label }: { text: string; label: string }) {
  const [side, setSide] = useState<'top' | 'bottom'>('top');
  const measure = (el: HTMLElement) => {
    const width = parseFloat(getComputedStyle(el, '::after').width) || 240;
    setSide(tipSide(el.getBoundingClientRect().top, clipTopOf(el), text, width));
  };
  return (
    <button type="button" className="help-tip tip-wide" data-tip={text} data-tip-side={side} aria-label={`关于${label}`} onMouseEnter={(e) => measure(e.currentTarget)} onFocus={(e) => measure(e.currentTarget)}>
      <IconHelp />
    </button>
  );
}

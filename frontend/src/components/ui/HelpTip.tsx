// 分组标题旁的「?」：把常驻的说明文字收起来，需要时再看（HIG-17）。
// 沿用全站的纯 CSS 气泡（styles.css 的 [data-tip]），额外挂 .tip-wide 让长文案换行——
// 默认的 data-tip 是 nowrap 且居中，右栏只有 320px 宽，一句话就冲出去了。

import { IconHelp } from './Icons';

export function HelpTip({ text, label }: { text: string; label: string }) {
  return (
    <button type="button" className="help-tip tip-wide" data-tip={text} aria-label={`关于${label}`}>
      <IconHelp />
    </button>
  );
}

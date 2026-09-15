// 快捷键速查表（按 ? 打开）。数据来自 lib/shortcuts.ts。

import { Modal } from '../ui/Modal';
import { formatKeys, SHORTCUTS, type ShortcutGroup } from '../../lib/shortcuts';
import { useEditor } from '../../store/editor';

const GROUPS: ShortcutGroup[] = ['全局', '剪辑', '音频', '图层', '时间轴'];

export function ShortcutsModal() {
  const setOpen = useEditor((s) => s.setShortcutsOpen);
  return (
    <Modal title="快捷键" onClose={() => setOpen(false)} width={640}>
      <div className="shortcut-groups">
        {GROUPS.map((g) => {
          const items = SHORTCUTS.filter((s) => s.group === g && s.keys.length > 0);
          if (!items.length) return null;
          return (
            <table key={g} className="shortcut-table">
              <thead>
                <tr>
                  <th colSpan={2}>{g}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.label}</td>
                    <td className="keys">
                      {s.keys.map((k, i) => (
                        <kbd key={i} title={formatKeys([k])}>{formatKeys([k])}</kbd>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })}
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        字母键按物理键位匹配，与输入法状态无关；在输入框中打字时快捷键不生效。
      </div>
    </Modal>
  );
}

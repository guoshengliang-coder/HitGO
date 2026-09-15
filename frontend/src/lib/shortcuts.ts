// 快捷键清单（单一数据源）：ShortcutsModal、按钮 title / data-tip 都从这里取文案。
// keys 用 mac 展示形式书写（⌘ / ⌥ / ⇧），Windows 下由 formatKeys 转成 Ctrl / Alt / Shift。
// 注意：真正的按键匹配在 EditorPage 里按 e.code 做，这里只管展示。

export type ShortcutGroup = '全局' | '剪辑' | '图层' | '时间轴';

export interface Shortcut {
  id: string;
  keys: string[];
  label: string;
  group: ShortcutGroup;
  step?: 1 | 2 | 3;
}

export const SHORTCUTS: Shortcut[] = [
  // 全局
  { id: 'play', keys: ['空格'], label: '播放 / 暂停', group: '全局' },
  { id: 'frame-prev', keys: ['←'], label: '上一帧', group: '全局' },
  { id: 'frame-next', keys: ['→'], label: '下一帧', group: '全局' },
  { id: 'seek-back', keys: ['⇧', '←'], label: '后退 1 秒', group: '全局' },
  { id: 'seek-fwd', keys: ['⇧', '→'], label: '前进 1 秒', group: '全局' },
  { id: 'undo', keys: ['⌘', 'Z'], label: '撤销', group: '全局' },
  { id: 'redo', keys: ['⇧', '⌘', 'Z'], label: '重做', group: '全局' },
  { id: 'save', keys: ['⌘', 'S'], label: '保存', group: '全局' },
  { id: 'shortcuts', keys: ['?'], label: '快捷键列表', group: '全局' },
  { id: 'escape', keys: ['Esc'], label: '取消选择 / 关闭弹窗', group: '全局' },
  // 剪辑
  { id: 'in', keys: ['I'], label: '设入点', group: '剪辑', step: 1 },
  { id: 'out', keys: ['O'], label: '设出点', group: '剪辑', step: 1 },
  { id: 'remove-before', keys: ['Q'], label: '删左', group: '剪辑', step: 1 },
  { id: 'remove-after', keys: ['W'], label: '删右', group: '剪辑', step: 1 },
  { id: 'delete-range', keys: ['Delete'], label: '删除选中区间', group: '剪辑', step: 1 },
  // 图层
  { id: 'copy-layer', keys: ['⌘', 'C'], label: '复制图层', group: '图层', step: 2 },
  { id: 'paste-layer', keys: ['⌘', 'V'], label: '粘贴图层', group: '图层', step: 2 },
  { id: 'duplicate', keys: ['⌘', 'D'], label: '创建副本', group: '图层', step: 2 },
  { id: 'copy-style', keys: ['⌥', '⌘', 'C'], label: '复制文字样式', group: '图层', step: 2 },
  { id: 'paste-style', keys: ['⌥', '⌘', 'V'], label: '粘贴文字样式', group: '图层', step: 2 },
  { id: 'layer-up', keys: [']'], label: '上移一层', group: '图层', step: 2 },
  { id: 'layer-down', keys: ['['], label: '下移一层', group: '图层', step: 2 },
  { id: 'layer-top', keys: ['⇧', ']'], label: '置顶', group: '图层', step: 2 },
  { id: 'layer-bottom', keys: ['⇧', '['], label: '置底', group: '图层', step: 2 },
  { id: 'layer-drag', keys: ['拖动'], label: '拖动图层调整层级', group: '图层', step: 2 },
  { id: 'layer-rename', keys: ['双击'], label: '重命名图层', group: '图层', step: 2 },
  { id: 'nudge', keys: ['↑↓←→'], label: '微移 1 px（参考 1080×1920）', group: '图层', step: 2 },
  { id: 'nudge-10', keys: ['⇧', '↑↓←→'], label: '微移 10 px', group: '图层', step: 2 },
  { id: 'frame-step-alt', keys: ['⌥', '←→'], label: '选中图层时仍逐帧', group: '图层', step: 2 },
  { id: 'delete-layer', keys: ['Delete'], label: '删除图层', group: '图层', step: 2 },
  { id: 'edit-text', keys: ['双击'], label: '在画布上编辑文字', group: '图层', step: 2 },
  { id: 'edit-text-commit', keys: ['⌘', 'Enter'], label: '提交画布文字编辑（Esc 取消）', group: '图层', step: 2 },
  { id: 'center-h', keys: [], label: '水平居中', group: '图层', step: 2 },
  { id: 'center-v', keys: [], label: '垂直居中', group: '图层', step: 2 },
  { id: 'center', keys: [], label: '居中', group: '图层', step: 2 },
  // 时间轴
  { id: 'tl-zoom', keys: ['⌘', '滚轮'], label: '缩放时间轴', group: '时间轴' },
  { id: 'tl-scroll', keys: ['滚轮'], label: '横向滚动', group: '时间轴' },
  { id: 'tl-fit', keys: ['⇧', 'Z'], label: '适应窗口', group: '时间轴' },
  { id: 'tl-no-snap', keys: ['⌥', '拖动'], label: '拖动时不吸附', group: '时间轴' },
  { id: 'canvas-no-snap', keys: ['⌘', '拖动'], label: '画布拖动时不吸附', group: '时间轴' },
  // 无键位的按钮项（只给 hintFor 用，不出现在速查表里）
  { id: 'safe-zone-view', keys: [], label: '安全区显示', group: '全局' },
];

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return true;
  const p = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

const WIN_NAMES: Record<string, string> = { '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
const MOD_SYMBOLS = new Set(['⌘', '⌥', '⇧']);

/** 按平台格式化键位：mac → ⇧⌘Z，Windows → Ctrl+Shift+Z。 */
export function formatKeys(keys: string[], mac = isMac()): string {
  if (!keys.length) return '';
  if (mac) {
    const compact = keys.every((k) => MOD_SYMBOLS.has(k) || k.length === 1);
    return keys.join(compact ? '' : ' ');
  }
  const mods = keys.filter((k) => MOD_SYMBOLS.has(k));
  const rest = keys.filter((k) => !MOD_SYMBOLS.has(k));
  // Windows 习惯顺序 Ctrl+Alt+Shift
  const order = ['⌘', '⌥', '⇧'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods.map((k) => WIN_NAMES[k]), ...rest].join('+');
}

export function shortcutById(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** 按钮提示文案：`删左 · Q`；没有键位时只返回标签。 */
export function hintFor(id: string): string {
  const s = shortcutById(id);
  if (!s) return id;
  const k = formatKeys(s.keys);
  return k ? `${s.label} · ${k}` : s.label;
}

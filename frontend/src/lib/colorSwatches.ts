// 取色器色板：内置预设色（参照剪映排布）+「+」保存的自定义色（本机偏好，存 localStorage）。

import { normalizeHex } from './color';

/** 预设色，按行排：浅→深的红粉橙、黄棕、粉紫、蓝、青绿、中性色。 */
export const PRESET_COLORS: readonly string[] = [
  '#FFD1D6', '#FF8A80', '#FF5252', '#FF1744', '#FF0000', '#B71C1C', '#FFDCC8', '#FFB38A', '#FF8A50',
  '#FF8C1A', '#FF6D00', '#A84B3A', '#FFF6C8', '#FFF176', '#FFE000', '#FFC21A', '#FFA800', '#A87332',
  '#FFE0EC', '#FFB0CB', '#FF5C9A', '#FF2E7E', '#FF00FF', '#8C1D4A', '#E8E6FF', '#CCC8FF', '#9282E0',
  '#8A63FF', '#9152FF', '#4A3399', '#BFE3FF', '#94C8FF', '#4AA3F5', '#0A7AFF', '#0022FF', '#2E4F99',
  '#C4F2F2', '#99E6EB', '#5CD8E0', '#00C8E0', '#00A6CC', '#006E8A', '#C4F5D6', '#6AE8B0', '#00D67A',
  '#33E655', '#00FF55', '#1F8A45', '#E8E8D0', '#FFFFFF', '#D9D9D9', '#A6A6A6', '#737373', '#404040',
  '#000000',
];

export const CUSTOM_LIMIT = 18;
const KEY = 'hitgo.colors';

type Reader = Pick<Storage, 'getItem'> | null;
type Writer = Pick<Storage, 'setItem'> | null;
const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/** 清洗：规范化、去掉非法、去重（大小写不敏感）、截到上限。 */
export function cleanCustomColors(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const hex = normalizeHex(v, '');
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length >= CUSTOM_LIMIT) break;
  }
  return out;
}

/** 新颜色放最前；已存在则挪到最前。 */
export function addCustomColor(list: string[], color: string): string[] {
  const hex = normalizeHex(color, '');
  if (!hex) return list;
  return cleanCustomColors([hex, ...list.filter((c) => c !== hex)]);
}

export function removeCustomColor(list: string[], color: string): string[] {
  const hex = normalizeHex(color, '');
  return list.filter((c) => c !== hex);
}

export function loadCustomColors(storage: Reader = defaultStorage()): string[] {
  try {
    const raw = storage?.getItem(KEY);
    return cleanCustomColors(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

export function saveCustomColors(list: string[], storage: Writer = defaultStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(cleanCustomColors(list)));
  } catch {
    /* 隐私模式等：忽略 */
  }
}

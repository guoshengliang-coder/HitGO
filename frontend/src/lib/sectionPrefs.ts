// 可折叠分组的开合状态：本机偏好，按分组 id 存 localStorage，纯函数便于测试。
// 与 layoutPrefs 分开：那边是两个数值 + clamp，这边是任意 id 的开合表。

export type SectionPrefs = Record<string, boolean>;

const KEY = 'hitgo.sections';

type Getter = Pick<Storage, 'getItem'> | null;
type Setter = Pick<Storage, 'getItem' | 'setItem'> | null;

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/** 只保留值为布尔的键，其余丢掉——存过的旧格式不该把界面卡在错误状态。 */
export function cleanPrefs(p: unknown): SectionPrefs {
  const out: SectionPrefs = {};
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

export function loadSectionPrefs(storage: Getter = defaultStorage()): SectionPrefs {
  try {
    const raw = storage?.getItem(KEY);
    return cleanPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

/** 没存过就用调用方给的默认值。 */
export function sectionOpen(prefs: SectionPrefs, id: string | undefined, defaultOpen: boolean): boolean {
  if (!id) return defaultOpen;
  const v = prefs[id];
  return typeof v === 'boolean' ? v : defaultOpen;
}

export function saveSectionOpen(id: string, open: boolean, storage: Setter = defaultStorage()): void {
  try {
    if (!storage) return;
    // 用 loadSectionPrefs 读，坏 JSON 会被它吞成空表，这次的改动仍然存得下去
    storage.setItem(KEY, JSON.stringify({ ...loadSectionPrefs(storage), [id]: open }));
  } catch {
    /* 隐私模式 / 坏 JSON：忽略，界面照常工作 */
  }
}

// 多语言批量导出（HIG-43）的纯逻辑：导出弹窗里能勾哪些语言、勾了之后每条视频出哪几份、哪些组合要跳过。
// 每份成片带自己的 spec 快照（契约 §3 POST /api/render items），编辑器里的 spec 不动。

import type { Asset, EditSpec, Video } from '../types';
import { appliedVersion, canApplyVersion } from './localize';

/** 「原版」在语言勾选里的键；和 GET /api/outputs?lang=original 同一个词。 */
export const ORIGINAL_LANG = 'original';

export interface LangExportItem {
  video_id: string;
  /** null = 原版。 */
  lang: string | null;
}

export interface LangExportSkip {
  video_id: string;
  video_name: string;
  lang: string;
  reason: string;
}

/** 这些视频里至少有一条能导出的语言（版本已完成、配音素材就绪），按首次出现的顺序。 */
export function exportableLangs(videos: Video[], assets: Asset[]): string[] {
  const out: string[] = [];
  for (const v of videos) {
    for (const lang of Object.keys(v.localization?.versions ?? {})) {
      if (!out.includes(lang) && canApplyVersion(v, lang, assets).ok) out.push(lang);
    }
  }
  return out;
}

/**
 * 勾选的语言 × 视频 → 要提交的条目；某条视频没有某个语言（或还不能用）就跳过并给出原因。
 * 「原版」每条视频都能出。条目顺序：按视频，再按勾选顺序。
 */
export function planLanguageExport(videos: Video[], langs: string[], assets: Asset[]): { items: LangExportItem[]; skipped: LangExportSkip[] } {
  const items: LangExportItem[] = [];
  const skipped: LangExportSkip[] = [];
  const wanted = [...new Set(langs)];
  for (const v of videos) {
    for (const lang of wanted) {
      if (lang === ORIGINAL_LANG) {
        items.push({ video_id: v.id, lang: null });
        continue;
      }
      const ok = canApplyVersion(v, lang, assets);
      if (ok.ok) items.push({ video_id: v.id, lang });
      else skipped.push({ video_id: v.id, video_name: v.name, lang, reason: ok.reason });
    }
  }
  return { items, skipped };
}

/** 普通导出（没勾语言）时这份成片的语言：spec 里套用着哪个语言就记哪个，没套用为 null。 */
export function specLang(spec: EditSpec | null | undefined, video: Video): string | null {
  return appliedVersion(spec, video.localization)?.lang ?? null;
}

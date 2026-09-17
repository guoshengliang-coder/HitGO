import { describe, expect, it } from 'vitest';
import { exportableLangs, ORIGINAL_LANG, planLanguageExport, specLang } from './langExport';
import type { Asset, EditSpec, LocalizationVersion, Video } from '../types';
import { emptySpec } from '../types';

function version(voice_asset_id: string | null, over: Partial<LocalizationVersion> = {}): LocalizationVersion {
  return { status: 'done', stage: null, voice: null, terms: [], cues: [], stale: false, error: null, warnings: [], voice_asset_id, updated_at: 'v', ...over };
}

function video(id: string, versions: Record<string, LocalizationVersion>): Video {
  return { id, name: `${id}.mp4`, duration: 10, has_audio: true, status: 'ready', localization: { source_lang: 'zh', transcript: { status: 'done', cues: [] }, versions } } as unknown as Video;
}

const ASSET = { type: 'audio', kind: 'audio', status: 'ready', url: '/media/x', source: 'derived', created_at: '' } as const;
const ASSETS: Asset[] = [
  { ...ASSET, id: 'a1_ko', name: 'ko' },
  { ...ASSET, id: 'a1_en', name: 'en' },
  { ...ASSET, id: 'a2_ko', name: 'ko' },
  { ...ASSET, id: 'a2_ja', name: 'ja', status: 'preparing' },
] as Asset[];

const V1 = video('v1', { ko: version('a1_ko'), en: version('a1_en') });
const V2 = video('v2', { ko: version('a2_ko'), ja: version('a2_ja'), fr: version(null, { status: 'failed', error: '超时' }) });
const V3 = { ...video('v3', {}), localization: null } as Video;

describe('exportableLangs', () => {
  it('所有视频里能导出的语言的并集，按首次出现排序；生成失败 / 素材没就绪的不算', () => {
    expect(exportableLangs([V1, V2, V3], ASSETS)).toEqual(['ko', 'en']);
    expect(exportableLangs([V3], ASSETS)).toEqual([]);
  });
});

describe('planLanguageExport', () => {
  it('视频 × 勾选语言；缺的组合跳过并带原因；原版每条都出', () => {
    const { items, skipped } = planLanguageExport([V1, V2, V3], [ORIGINAL_LANG, 'ko', 'en', 'ko'], ASSETS);
    expect(items).toEqual([
      { video_id: 'v1', lang: null },
      { video_id: 'v1', lang: 'ko' },
      { video_id: 'v1', lang: 'en' },
      { video_id: 'v2', lang: null },
      { video_id: 'v2', lang: 'ko' },
      { video_id: 'v3', lang: null },
    ]);
    expect(skipped.map((s) => [s.video_id, s.lang])).toEqual([
      ['v2', 'en'],
      ['v3', 'ko'],
      ['v3', 'en'],
    ]);
    expect(skipped[0].video_name).toBe('v2.mp4');
    expect(skipped[0].reason).toBeTruthy();
  });
  it('没勾任何语言：什么都不出', () => {
    expect(planLanguageExport([V1], [], ASSETS)).toEqual({ items: [], skipped: [] });
  });
});

describe('specLang', () => {
  it('spec 套用着哪个语言就是哪个；没套用为 null', () => {
    const spec: EditSpec = { ...emptySpec(), audio: { source_volume: 0, tracks: [{ id: 't', asset_id: 'a1_ko', role: 'voice', t: 'all', origin: 'localize', lang: 'ko' }] } };
    expect(specLang(spec, V1)).toBe('ko');
    expect(specLang(emptySpec(), V1)).toBeNull();
    expect(specLang(null, V1)).toBeNull();
  });
});

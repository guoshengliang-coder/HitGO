import { describe, expect, it } from 'vitest';
import {
  appliedScreenLang,
  bandHint,
  applyScreenTextToSpec,
  blockToMaskLayer,
  blockToTextLayer,
  blockTextStyle,
  boxToPlacement,
  cleanReady,
  detectStatusText,
  mergedBlocks,
  screenLayers,
  screenLayerTemplate,
  screenTextActive,
  screenTextFinishText,
  SCREEN_ORIGIN,
  stripScreenText,
} from './screentext';
import { emptySpec, type EditSpec, type ScreenBlock, type ScreenText, type TextLayer } from '../types';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

let seq = 0;
const newId = () => `g_${++seq}`;

function blocks(): ScreenBlock[] {
  return [
    { id: 's0', text: '限时免费', box: box(0.62, 0.06, 0.3, 0.07), t: [1, 4], lines: 1, style: { font_size: 0.052, color: '#E3312B', align: 'right' }, moving: false, enabled: true },
    { id: 's1', text: '立即下载', box: box(0.3, 0.5, 0.4, 0.06), t: [5, 8], lines: 1, style: { color: '#FFFFFF' }, moving: false, enabled: true },
  ];
}

function screen(overrides: Partial<ScreenText> = {}): ScreenText {
  return {
    detect: { status: 'done', frames: 6, subtitle_band: null, blocks: blocks() },
    erase: null,
    versions: { ko: { status: 'done', texts: [{ id: 's0', translated: '한정 무료' }, { id: 's1', translated: '지금 다운로드' }], stale: false } },
    ...overrides,
  };
}

const ctx = (s: ScreenText | null, remove: [number, number][] = []) => ({ screen: s, remove, postDuration: 24.6, newLayerId: newId });

// ---- 几何 ----

describe('boxToPlacement', () => {
  it('按框中心选九宫格锚点，换画幅时角标仍然贴角', () => {
    expect(boxToPlacement(box(0.62, 0.06, 0.3, 0.07)).anchor).toBe('top-right');
    expect(boxToPlacement(box(0.04, 0.05, 0.2, 0.05)).anchor).toBe('top-left');
    expect(boxToPlacement(box(0.3, 0.8, 0.4, 0.06)).anchor).toBe('bottom-center');
    expect(boxToPlacement(box(0.3, 0.45, 0.4, 0.06)).anchor).toBe('center');
  });

  it('top / left 锚点的 margin 就是框到那条边的距离', () => {
    const p = boxToPlacement(box(0.12, 0.08, 0.3, 0.05));
    expect(p.anchor).toBe('top-left');
    expect(p.margin[0]).toBeCloseTo(0.12, 4);
    expect(p.margin[1]).toBeCloseTo(0.08, 4);
  });

  it('right / bottom 锚点的 margin 从对面那条边量起', () => {
    const p = boxToPlacement(box(0.62, 0.86, 0.3, 0.05));
    expect(p.anchor).toBe('bottom-right');
    expect(p.margin[0]).toBeCloseTo(1 - 0.92, 4);
    expect(p.margin[1]).toBeCloseTo(1 - 0.91, 4);
  });

  it('宽度给译文留富余但不超过画布', () => {
    expect(boxToPlacement(box(0.1, 0.1, 0.3, 0.05)).width).toBeCloseTo(0.33, 4);
    expect(boxToPlacement(box(0, 0.1, 1, 0.05)).width).toBe(1);
  });
});

// ---- 样式 ----

describe('blockTextStyle', () => {
  it('估出来的字号 / 颜色 / 对齐用上，字体按目标语言选', () => {
    const style = blockTextStyle({ font_size: 0.052, color: '#E3312B', align: 'right' }, 'ko', box(0.6, 0.06, 0.3, 0.07));
    expect(style.font_size).toBe(0.052);
    expect(style.color).toBe('#E3312B');
    expect(style.align).toBe('right');
    expect(style.font_family).not.toBe('');
  });

  it('估不出的字段回落默认值，并开自动换行', () => {
    const style = blockTextStyle(null, 'ko', box(0.3, 0.5, 0.4, 0.06));
    expect(style.color).toBe('#FFFFFF');
    expect(style.wrap_width).toBeCloseTo(0.44, 4);
  });

  it('估出「没有描边」时不留默认黑边——那会让干净的字看起来变脏', () => {
    const style = blockTextStyle({ color: '#FFFFFF', stroke_color: null }, 'ko', box(0.3, 0.5, 0.4, 0.06));
    expect(style.stroke_width).toBe(0);
  });
});

// ---- 图层 ----

describe('blockToTextLayer', () => {
  const opts = () => ({ lang: 'ko', remove: [] as [number, number][], postDuration: 24.6, newId });

  it('译文 → 带时段、带 origin 标记的文字图层', () => {
    const layer = blockToTextLayer({ ...blocks()[0], translated: '한정 무료' }, opts())!;
    expect(layer.type).toBe('text');
    expect(layer.text).toBe('한정 무료');
    expect(layer.origin).toBe(SCREEN_ORIGIN);
    expect(layer.lang).toBe('ko');
    expect(layer.screen_block).toBe('s0');
    expect(layer.t).toEqual([1, 4]);
  });

  it('时段经 trim.remove 换算到剪后时间轴', () => {
    const layer = blockToTextLayer({ ...blocks()[1], translated: '지금' }, { ...opts(), remove: [[0, 2]] })!;
    expect(layer.t).toEqual([3, 6]);
  });

  it('整块落在删除区里就不生成', () => {
    expect(blockToTextLayer({ ...blocks()[0], translated: '한정' }, { ...opts(), remove: [[0, 10]] })).toBeNull();
  });

  it('没有译文、被关掉、或会动的文字都不生成', () => {
    expect(blockToTextLayer({ ...blocks()[0], translated: '' }, opts())).toBeNull();
    expect(blockToTextLayer({ ...blocks()[0], translated: 'x', enabled: false }, opts())).toBeNull();
    expect(blockToTextLayer({ ...blocks()[0], translated: 'x', moving: true }, opts())).toBeNull();
  });

  it('人调过的几何和样式按 screen_block 接回去，不被自动估的值覆盖', () => {
    const previous = new Map([['s0', { anchor: 'center' as const, margin: [0.01, 0.02] as [number, number], width: 0.5, style: { ...blockTextStyle(null, 'ko', box(0, 0, 1, 1)), color: '#00FF00' } }]]);
    const layer = blockToTextLayer({ ...blocks()[0], translated: '한정' }, { ...opts(), previous })!;
    expect(layer.anchor).toBe('center');
    expect(layer.width).toBe(0.5);
    expect(layer.style.color).toBe('#00FF00');
  });

  it('终点裁到剪后时长', () => {
    const layer = blockToTextLayer({ ...blocks()[1], translated: 'x' }, { ...opts(), postDuration: 6 })!;
    expect(layer.t[1]).toBe(6);
  });
});

describe('blockToMaskLayer', () => {
  it('遮盖比原框略大一圈，免得反锯齿的边露出来', () => {
    const mask = blockToMaskLayer(blocks()[0], { remove: [], postDuration: 24.6, newId })!;
    expect(mask.type).toBe('mask');
    expect(mask.width).toBeGreaterThan(0.3);
    expect(mask.height).toBeGreaterThan(0.07);
    expect(mask.origin).toBe(SCREEN_ORIGIN);
  });

  it('会动的文字不盖', () => {
    expect(blockToMaskLayer({ ...blocks()[0], moving: true }, { remove: [], postDuration: 24.6, newId })).toBeNull();
  });
});

// ---- 合并 ----

describe('mergedBlocks', () => {
  it('按 id 对上译文，版本里多出来的 id 丢掉', () => {
    const merged = mergedBlocks({ status: 'done', blocks: blocks() }, { status: 'done', texts: [{ id: 's1', translated: '다운로드' }, { id: 's9', translated: '幽灵' }] });
    expect(merged.map((b) => b.translated)).toEqual(['', '다운로드']);
  });
});

// ---- 套用 ----

describe('applyScreenTextToSpec', () => {
  function spec(): EditSpec {
    return emptySpec();
  }

  it('生成译文层，并在没有无字版时补上顶替遮盖', () => {
    const s = spec();
    applyScreenTextToSpec(s, 'ko', ctx(screen()));

    const texts = s.layers.filter((l) => l.origin === SCREEN_ORIGIN && l.type === 'text');
    const masks = s.layers.filter((l) => l.origin === SCREEN_ORIGIN && l.type === 'mask');
    expect(texts).toHaveLength(2);
    expect(masks).toHaveLength(2);
    expect(s.source_variant).toBe('original');
  });

  it('遮盖排在第一个文字图层之前（契约 §2 层级规则）', () => {
    const s = spec();
    applyScreenTextToSpec(s, 'ko', ctx(screen()));

    const firstMask = s.layers.findIndex((l) => l.type === 'mask');
    const firstText = s.layers.findIndex((l) => l.type === 'text');
    expect(firstMask).toBeGreaterThanOrEqual(0);
    expect(firstMask).toBeLessThan(firstText);
  });

  it('无字版可用时切到 clean，并且不再生成遮盖', () => {
    const s = spec();
    const sc = screen({ erase: { status: 'done', stale: false, clean_url: '/media/batches/b/v/clean.mp4' } });
    applyScreenTextToSpec(s, 'ko', ctx(sc));

    expect(s.source_variant).toBe('clean');
    expect(s.layers.filter((l) => l.type === 'mask')).toHaveLength(0);
  });

  it('无字版过期时退回原片并提示重擦', () => {
    const s = spec();
    const sc = screen({ erase: { status: 'done', stale: true, clean_url: '/media/batches/b/v/clean.mp4' } });
    const warnings = applyScreenTextToSpec(s, 'ko', ctx(sc));

    expect(s.source_variant).toBe('original');
    expect(warnings.join()).toContain('重新擦除');
  });

  it('换语言时把上一版的层整批换掉，不会越堆越多', () => {
    const s = spec();
    applyScreenTextToSpec(s, 'ko', ctx(screen()));
    const sc = screen({ versions: { ja: { status: 'done', texts: [{ id: 's0', translated: '期間限定' }], stale: false } } });
    applyScreenTextToSpec(s, 'ja', ctx(sc));

    const texts = s.layers.filter((l) => l.origin === SCREEN_ORIGIN && l.type === 'text');
    expect(texts).toHaveLength(1);
    expect(texts.every((l) => l.lang === 'ja')).toBe(true);
  });

  it('不碰改语言生成的层——两边各清各的', () => {
    const s = spec();
    s.layers.push({ id: 'l_loc', type: 'text', text: '字幕', style: blockTextStyle(null, 'ko', box(0, 0, 1, 1)), anchor: 'bottom-center', margin: [0, 0.12], width: 0.8, rotate: 0, opacity: 1, t: [0, 3], origin: 'localize', lang: 'ko' } as TextLayer);
    applyScreenTextToSpec(s, 'ko', ctx(screen()));

    expect(s.layers.some((l) => l.origin === 'localize')).toBe(true);
  });

  it('会动的文字单独提示，不静默丢掉', () => {
    const sc = screen();
    sc.detect!.blocks = [{ ...blocks()[0], moving: true }];
    const warnings = applyScreenTextToSpec(spec(), 'ko', ctx(sc));

    expect(warnings.join()).toContain('会动');
  });

  it('只擦不改语言：不传语言时不生成任何文字层，但无字版照样切', () => {
    const s = spec();
    const sc = screen({ erase: { status: 'done', stale: false, clean_url: '/x/clean.mp4' } });
    const warnings = applyScreenTextToSpec(s, '', ctx(sc));

    expect(s.layers.filter((l) => l.origin === SCREEN_ORIGIN)).toHaveLength(0);
    expect(s.source_variant).toBe('clean');
    expect(warnings).toEqual([]);
  });

  it('还没识别过时不改图层，只回到原片', () => {
    const s = spec();
    const warnings = applyScreenTextToSpec(s, 'ko', ctx({ detect: null, erase: null, versions: {} }));

    expect(s.layers).toHaveLength(0);
    expect(s.source_variant).toBe('original');
    expect(warnings.join()).toContain('还没有画面文字识别结果');
  });
});

describe('stripScreenText（多语言导出「原版」）', () => {
  it('去掉画面文字层并切回原片——漏了就会导出一个字都没有的空画面', () => {
    const s = emptySpec();
    const sc = screen({ erase: { status: 'done', stale: false, clean_url: '/x/clean.mp4' } });
    applyScreenTextToSpec(s, 'ko', ctx(sc));
    expect(s.source_variant).toBe('clean');

    stripScreenText(s);

    expect(screenLayers(s)).toHaveLength(0);
    expect(s.source_variant).toBe('original');
  });
});

describe('辅助判断', () => {
  it('硬字幕提示把识别框的完整位置、宽度和样式交给改语言字幕', () => {
    const sc = screen();
    sc.detect!.subtitle_band = { box: box(0.15, 0.78, 0.7, 0.06), style: { font_size: 0.04, color: '#EEEEEE' } };
    const hint = bandHint(sc, 'ja')!;
    expect(hint.anchor).toBe('bottom-center');
    expect(hint.width).toBeCloseTo(0.77, 4);
    expect(hint.style).toMatchObject({ font_size: 0.04, color: '#EEEEEE', wrap_width: 0.77 });
  });

  it('cleanReady 要求 done、没过期、有文件', () => {
    expect(cleanReady({ erase: { status: 'done', stale: false, clean_url: '/x' }, versions: {} })).toBe(true);
    expect(cleanReady({ erase: { status: 'done', stale: true, clean_url: '/x' }, versions: {} })).toBe(false);
    expect(cleanReady({ erase: { status: 'running' }, versions: {} })).toBe(false);
    expect(cleanReady(null)).toBe(false);
  });

  it('screenTextActive 覆盖识别 / 擦除 / 任一语言', () => {
    expect(screenTextActive({ detect: { status: 'running', blocks: [] }, versions: {} })).toBe(true);
    expect(screenTextActive({ erase: { status: 'queued' }, versions: {} })).toBe(true);
    expect(screenTextActive({ versions: { ko: { status: 'running', texts: [] } } })).toBe(true);
    expect(screenTextActive(screen())).toBe(false);
    expect(screenTextActive(null)).toBe(false);
  });

  it('appliedScreenLang 读出当前套用的语言', () => {
    const s = emptySpec();
    expect(appliedScreenLang(s)).toBeNull();
    applyScreenTextToSpec(s, 'ko', ctx(screen()));
    expect(appliedScreenLang(s)).toBe('ko');
  });

  it('screenLayerTemplate 只记文字层调过的几何与样式', () => {
    const s = emptySpec();
    applyScreenTextToSpec(s, 'ko', ctx(screen()));
    const tpl = screenLayerTemplate(s);
    expect([...tpl.keys()].sort()).toEqual(['s0', 's1']);
  });
});

describe('与多片段拼接共存（契约 §2）', () => {
  it('有 sequence 时不写 clean——后端会 400 挡下，写了会让套用整批保存失败', () => {
    const s = emptySpec();
    s.sequence = { clips: [{ id: 'c_1', video_id: 'v_1', in: 0, out: 4 }] };
    const sc = screen({ erase: { status: 'done', stale: false, clean_url: '/x/clean.mp4' } });

    const warnings = applyScreenTextToSpec(s, 'ko', ctx(sc));

    expect(s.source_variant).toBe('original');
    // 退回原片就还需要遮盖顶替原文字
    expect(s.layers.filter((l) => l.type === 'mask').length).toBeGreaterThan(0);
    expect(warnings.join()).toContain('多片段拼接');
  });
});

describe('detectStatusText', () => {
  it('tells queueing apart from recognising, with frame progress', () => {
    expect(detectStatusText({ status: 'queued', blocks: [] })).toContain('排队中');
    expect(detectStatusText({ status: 'running', blocks: [] })).toContain('抽帧');
    expect(detectStatusText({ status: 'running', blocks: [], progress: { done: 3, total: 12 } })).toBe('识别中 3/12 帧…');
    expect(detectStatusText({ status: 'failed', blocks: [], error: '画面文字识别失败（403）' })).toBe('失败：画面文字识别失败（403）');
    expect(detectStatusText(null)).toBe('未开始');
  });
});

describe('screenTextFinishText', () => {
  it('does not repeat the prefix the backend already wrote', () => {
    const text = screenTextFinishText({ detect: { status: 'failed', blocks: [], error: '画面文字识别失败（403）：Access denied.' }, versions: {} });
    expect(text).toBe('画面文字识别失败（403）：Access denied.');
    expect(screenTextFinishText({ detect: { status: 'failed', blocks: [], error: '抽帧失败' }, versions: {} })).toBe('画面文字识别失败：抽帧失败');
  });
});

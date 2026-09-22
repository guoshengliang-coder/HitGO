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
  eraseStatusText,
  estimateTextWidth,
  skippedFramesText,
  fitScreenText,
  FIT_MIN_FONT_SCALE,
  screenBlockLayout,
  sourceBoxToCanvas,
  stripScreenText,
} from './screentext';
import { wrapLineRanges, wrapTokens } from './textWrap';
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
    // 框宽 × 1.1，再补回左右内边距与描边（HIG-86）：文字的可用宽度 = 原框宽 × 1.1，不再被扣掉约 54px。
    const pads = 2 * style.padding * 1920 + 2 * style.stroke_width * 1920;
    expect(style.wrap_width).toBeCloseTo((0.4 * 1080 * 1.1 + pads) / 1080, 4);
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
    expect(hint.style).toMatchObject({ font_size: 0.04, color: '#EEEEEE' });
    // 可用文字宽 = 带宽 × 1.1；wrap_width / 图层宽另补回左右内边距与描边（HIG-86）。
    const pads = 2 * hint.style!.padding! * 1920 + 2 * hint.style!.stroke_width! * 1920;
    expect(hint.style!.wrap_width).toBeCloseTo((0.77 * 1080 + pads) / 1080, 4);
    expect(hint.width).toBe(hint.style!.wrap_width);
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


// --- HIG-86：画幅换算与「放不下先缩后放」 ---------------------------------------

const blurFrame = { fill: 'blur' as const, W: 1080, H: 1920 };

describe('sourceBoxToCanvas', () => {
  it('9:16 源片原样返回', () => {
    const out = sourceBoxToCanvas(box(0.2, 0.3, 0.4, 0.05), { srcW: 720, srcH: 1280, frame: blurFrame });
    expect(out.box).toEqual(box(0.2, 0.3, 0.4, 0.05));
    expect(out.fontScale).toBeCloseTo(1, 6);
  });

  it('1:1 源片落到画布中间那块正方形里，字号按源画面在画布上的高度缩', () => {
    const out = sourceBoxToCanvas(box(0.25, 0.1, 0.5, 0.1), { srcW: 1080, srcH: 1080, frame: blurFrame });
    expect(out.box.x).toBeCloseTo(0.25, 4);
    expect(out.box.y).toBeCloseTo((420 + 108) / 1920, 4);
    expect(out.box.w).toBeCloseTo(0.5, 4);
    expect(out.box.h).toBeCloseTo(108 / 1920, 3);
    expect(out.fontScale).toBeCloseTo(1080 / 1920, 6);
  });

  it('16:9 源片：字号约为原来的 0.32 倍——以前直接当成画布比例，字大了 3 倍', () => {
    const out = sourceBoxToCanvas(box(0.1, 0.8, 0.8, 0.08), { srcW: 1920, srcH: 1080, frame: blurFrame });
    expect(out.fontScale).toBeCloseTo((1080 * 0.5625) / 1920, 6);
    expect(out.box.y).toBeGreaterThan(0.4);
    expect(out.box.y + out.box.h).toBeLessThan(0.7);
  });

  it('不知道源片尺寸时原样返回', () => {
    expect(sourceBoxToCanvas(box(0.1, 0.1, 0.2, 0.2), null).fontScale).toBe(1);
  });
});

/** 按 fit 的结果在 wrap_width 内实际折行：返回行数和最宽的单词是否放得下。 */
function wrapped(text: string, fontSize: number, wrapWidth: number, padding = 0.01, stroke = 0.004) {
  const px = fontSize * 1920;
  const inner = wrapWidth * 1080 - 2 * padding * 1920 - 2 * stroke * 1920;
  const m = (s: string) => estimateTextWidth(s, px);
  const lines = wrapLineRanges(text, inner, m).length;
  const wordsFit = wrapTokens(text).every(([a, b]) => m(text.slice(a, b).trim()) <= inner + 1e-6);
  return { lines, wordsFit };
}

describe('fitScreenText', () => {
  const style = (font_size: number, w = 0.1) => blockTextStyle({ font_size }, 'en', box(0, 0, w, 0.1));

  it('放得下时字号不变，可用宽度 = 原框宽 × 1.1', () => {
    const st = style(0.03, 0.4);
    const fit = fitScreenText('SALE', st, 0.4, 1);
    expect(fit.font_size).toBe(0.03);
    expect(fit.wrap_width).toBeCloseTo(st.wrap_width!, 3);
  });

  it('截图 4：小按钮的中文翻成长英文，单词整词换行，不再一字母一行', () => {
    const text = 'Lucky wheel ¥0.45 withdrawal';
    const fit = fitScreenText(text, style(0.03), 0.12, 1);
    const out = wrapped(text, fit.font_size, fit.wrap_width);
    expect(out.wordsFit).toBe(true);
    expect(out.lines).toBeLessThanOrEqual(2);
    expect(fit.font_size).toBeGreaterThanOrEqual(0.03 * FIT_MIN_FONT_SCALE - 1e-6);
    expect(fit.wrap_width).toBeGreaterThan(0.12);
  });

  it('稍长一点先缩字号、不放宽', () => {
    const st = style(0.04, 0.3);
    const fit = fitScreenText('Download now', st, 0.3, 1);
    expect(fit.font_size).toBeLessThan(0.04);
    expect(fit.font_size).toBeGreaterThanOrEqual(0.04 * FIT_MIN_FONT_SCALE - 1e-6);
    expect(fit.wrap_width).toBeCloseTo(st.wrap_width!, 3);
  });

  it('最宽只到画布宽', () => {
    const fit = fitScreenText('Supercalifragilisticexpialidocious-extraordinarily-long', style(0.08), 0.1, 1);
    expect(fit.wrap_width).toBeLessThanOrEqual(1);
  });
});

describe('screenBlockLayout', () => {
  it('左对齐的块放宽时守住左边，不往左边跑出去', () => {
    const block: ScreenBlock = { id: 'b', text: '提现', box: box(0.1, 0.5, 0.1, 0.03), t: [0, 1], lines: 1, style: { font_size: 0.03, align: 'left' }, moving: false, enabled: true };
    const out = screenBlockLayout(block, 'Withdraw to your wallet instantly', 'en');
    expect(out.anchor.endsWith('left')).toBe(true);
    expect(out.margin[0]).toBeLessThanOrEqual(0.1);
    expect(out.margin[0]).toBeGreaterThan(0.07);
    expect(out.style.wrap_width!).toBeGreaterThan(0.1);
  });

  it('非 9:16 源片的块换算后再排版', () => {
    const block: ScreenBlock = { id: 'b', text: 'SALE', box: box(0.3, 0.1, 0.4, 0.06), t: [0, 1], lines: 1, style: { font_size: 0.05, align: 'center' }, moving: false, enabled: true };
    const out = screenBlockLayout(block, 'SALE', 'en', { source: { srcW: 1080, srcH: 1080, frame: blurFrame } });
    expect(out.style.font_size).toBeCloseTo(0.05 * (1080 / 1920), 4);
    expect(out.anchor.startsWith('top')).toBe(true);
    expect(out.margin[1]).toBeCloseTo((420 + 0.1 * 1080) / 1920, 3);
  });
});

describe('eraseStatusText / skippedFramesText（HIG-86）', () => {
  it('擦除中带上供应商状态', () => {
    expect(eraseStatusText({ status: 'running', vendor_status: '排队中（状态 0）' })).toBe('擦除中…供应商：排队中（状态 0）');
    expect(eraseStatusText({ status: 'running' })).toBe('擦除中…');
    expect(eraseStatusText({ status: 'failed', error: '擦除超过 3600 秒仍未完成' })).toContain('3600');
    expect(eraseStatusText(null)).toBe('未开始');
  });

  it('跳过的帧数只在识别完成后提示', () => {
    expect(skippedFramesText({ status: 'done', blocks: [], skipped_frames: 2 })).toContain('2 帧');
    expect(skippedFramesText({ status: 'done', blocks: [] })).toBe('');
    expect(skippedFramesText({ status: 'running', blocks: [], skipped_frames: 2 })).toBe('');
  });
});

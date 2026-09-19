import { describe, expect, it } from 'vitest';
import { CJK_MAX_CHARS, LATIN_MAX_CHARS, breakPoints, charRatio, cueCharLimit, sliceWindow, snapBreakOffset, splitCueRanges, visibleLength } from './cueSplit';

const pieces = (text: string, opts?: { maxChars?: number; lang?: string }) => splitCueRanges(text, opts).map(([a, b]) => text.slice(a, b));

describe('cueCharLimit', () => {
  it('按文本里占多数的脚本判定，不按语言码', () => {
    expect(cueCharLimit('欢迎来到 HitGO，我们开始吧。')).toBe(CJK_MAX_CHARS);
    expect(cueCharLimit('힛고에 오신 것을 환영합니다.')).toBe(CJK_MAX_CHARS);
    expect(cueCharLimit('ยินดีต้อนรับสู่ HitGO')).toBe(CJK_MAX_CHARS);
    expect(cueCharLimit('Gratis, gratis: rumput topowhere dan navigator.')).toBe(LATIN_MAX_CHARS);
    expect(cueCharLimit('Добро пожаловать в HitGO')).toBe(LATIN_MAX_CHARS);
  });

  it('韩语里混英文品牌名仍算无空格脚本', () => {
    expect(cueCharLimit('HitGO 힛고에 오신 것을 환영합니다')).toBe(CJK_MAX_CHARS);
  });

  it('没有字母类字符时才看 lang', () => {
    expect(cueCharLimit('12:30 — 3.5%', 'ja')).toBe(CJK_MAX_CHARS);
    expect(cueCharLimit('12:30 — 3.5%', 'en')).toBe(LATIN_MAX_CHARS);
    expect(cueCharLimit('12:30 — 3.5%')).toBe(LATIN_MAX_CHARS);
  });
});

describe('breakPoints', () => {
  it('句末与从句标点分档，连续标点和收尾引号跟着上一段走', () => {
    const t = '真的吗？！他说「好」，然后走了。';
    const by = new Map(breakPoints(t).map((p) => [p.at, p.kind]));
    expect(by.get(t.indexOf('他'))).toBe('sentence'); // 「？！」整体在左段
    expect(by.get(t.indexOf('然'))).toBe('clause'); // 「」，」整体在左段
  });

  it('沿用 posterSplit 的半角标点例外：数字 / 时间 / 域名内部不断句', () => {
    const t = 'It costs 3.5 at 10:30 on HitGO.com today.';
    const kinds = breakPoints(t);
    expect(kinds.filter((p) => p.kind === 'sentence')).toHaveLength(0); // 只有末尾的句号，落在文本末不算
    expect(kinds.every((p) => p.kind === 'word')).toBe(true);
  });

  it('换行是最高优先级的切点', () => {
    const t = '第一行\n第二行';
    expect(breakPoints(t).find((p) => p.at === 4)?.kind).toBe('newline');
  });
});

describe('splitCueRanges', () => {
  it('整条不超上限就原样一段，手写的两行排版不动它', () => {
    expect(pieces('힛고에 오신 것을\n환영합니다.')).toEqual(['힛고에 오신 것을\n환영합니다.']);
  });

  it('长中文句在标点处切成长度均衡的几段', () => {
    const out = pieces('欢迎来到 HitGO，这是一个面向投放素材的视频后期工作台，今天我们从改语言开始讲起。');
    expect(out.length).toBeGreaterThan(1);
    expect(out.join('')).toBe('欢迎来到 HitGO，这是一个面向投放素材的视频后期工作台，今天我们从改语言开始讲起。');
    expect(out.every((s) => /[，。]$/.test(s) || s === out[out.length - 1])).toBe(true);
  });

  it('长拉丁句在词边界切，不切断单词', () => {
    const t = 'Gratis gratis gratis rumput topowhere dan navigator berdefinisi tinggi sekali lagi';
    const out = pieces(t);
    expect(out.length).toBeGreaterThan(1);
    expect(out.join(' ')).toBe(t);
    expect(out.every((s) => !/^\s|\s$/.test(s))).toBe(true);
  });

  it('句末标点比从句标点更值得切，即使稍微远一点', () => {
    // 中点落在「，」附近，但「。」只远两个字，罚分让句号胜出
    const out = pieces('今天天气很好。我们出去走走，然后回家。', { maxChars: 10 });
    expect(out[0]).toBe('今天天气很好。');
  });

  it('没有标点也没有空格时按字形硬切', () => {
    const out = pieces('ยินดีต้อนรับสู่แพลตฟอร์มตัดต่อวิดีโอของเรา');
    expect(out.length).toBeGreaterThan(1);
    expect(out.join('')).toBe('ยินดีต้อนรับสู่แพลตฟอร์มตัดต่อวิดีโอของเรา');
  });

  it('过短的碎片并回相邻段', () => {
    const out = pieces('好的。这是一段足够长的说明文字用来触发拆分逻辑继续往下走。', { maxChars: 12 });
    expect(out[0].startsWith('好的。')).toBe(true);
    expect(out[0].length).toBeGreaterThan(3); // 「好的。」没有单独成段
  });

  it('空白与纯空白文本', () => {
    expect(splitCueRanges('   ')).toEqual([]);
    expect(pieces('  hi  ')).toEqual(['hi']);
  });
});

describe('sliceWindow', () => {
  it('按权重摊分，首尾相接且末端严格等于窗口末端', () => {
    const out = sliceWindow([10, 20], [1, 1, 2]);
    expect(out[0][1]).toBe(out[1][0]);
    expect(out[1][1]).toBe(out[2][0]);
    expect(out[0]).toEqual([10, 12.5]);
    expect(out[2][1]).toBe(20);
  });

  it('太短的段钉成最短时长，其余按权重重分', () => {
    const out = sliceWindow([0, 10], [1, 99], 0.7);
    expect(out[0]).toEqual([0, 0.7]);
    expect(out[1]).toEqual([0.7, 10]);
  });

  it('整个窗口都摊不开时等分', () => {
    const out = sliceWindow([0, 1], [5, 1, 1], 0.7);
    expect(out.map(([a, b]) => Math.round((b - a) * 1000) / 1000)).toEqual([0.333, 0.334, 0.333]);
    expect(out[2][1]).toBe(1);
  });

  it('单段与零长窗口', () => {
    expect(sliceWindow([3, 5], [1])).toEqual([[3, 5]]);
    expect(sliceWindow([3, 3], [1, 1])).toEqual([[3, 3], [3, 3]]);
    expect(sliceWindow([0, 5], [])).toEqual([]);
  });
});

describe('charRatio 与 snapBreakOffset', () => {
  it('charRatio 只数可见字符', () => {
    expect(charRatio('ab cd', 3)).toBe(0.5);
    expect(charRatio('   ', 2)).toBe(0);
    expect(charRatio('abcd', 99)).toBe(1);
  });

  it('snapBreakOffset 吸附到标点而不是更近的词边界', () => {
    const t = '今天天气很好。我们出去走走。';
    expect(snapBreakOffset(t, 0.55)).toBe(t.indexOf('我'));
  });

  it('太短的文本切不动', () => {
    expect(snapBreakOffset('a', 0.5)).toBeNull();
  });

  it('没有标点的拉丁文吸附到词边界', () => {
    const t = 'alpha beta gamma delta';
    const at = snapBreakOffset(t, 0.5);
    expect(at).not.toBeNull();
    expect(t[(at as number) - 1]).toBe(' ');
  });
});

describe('visibleLength', () => {
  it('不数空白', () => {
    expect(visibleLength(' a\nb ')).toBe(2);
    expect(visibleLength('abcd', 1, 3)).toBe(2);
  });
});

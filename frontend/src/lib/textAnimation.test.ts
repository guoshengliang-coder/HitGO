import { describe, expect, it } from 'vitest';
import cases from './fixtures/textAnimationCases.json';
import { animationSummary, contractAnimation, ease, easingName, easingPoints, EASINGS, hasAnimation, NEW_PRESET_DEFAULTS, phaseLengths, previewSpan, sampleAnimation, switchPreset } from './textAnimation';
import type { TextAnimation } from '../types';

type Case = { name: string; animation: TextAnimation; window: number; u: number; expect: { opacity: number; dx: number; dy: number; scale: number } };

describe('sampleAnimation 对照后端 golden（HIG-40）', () => {
  for (const c of (cases as { cases: Case[] }).cases) {
    it(`${c.name} @ ${c.u}`, () => {
      const f = sampleAnimation(c.animation, c.u, c.window);
      expect(f.opacity).toBeCloseTo(c.expect.opacity, 5);
      expect(f.dx).toBeCloseTo(c.expect.dx, 5);
      expect(f.dy).toBeCloseTo(c.expect.dy, 5);
      expect(f.scale).toBeCloseTo(c.expect.scale, 5);
    });
  }
});

describe('textAnimation helpers', () => {
  it('hasAnimation', () => {
    expect(hasAnimation(undefined)).toBe(false);
    expect(hasAnimation({})).toBe(false);
    expect(hasAnimation({ loop: { preset: 'blink' } })).toBe(true);
  });
  it('phaseLengths 按时段压缩，缺省 0.5 秒', () => {
    expect(phaseLengths({ in: { preset: 'fade' }, out: { preset: 'pop' } }, 3)).toEqual([0.5, 0.5]);
    expect(phaseLengths({ in: { preset: 'fade', duration: 2 }, out: { preset: 'pop', duration: 2 } }, 3)).toEqual([2, 1]);
  });
  it('contractAnimation：空的不发，补缺省；区间时段里入场 + 出场压进时段', () => {
    expect(contractAnimation({}, null)).toBeUndefined();
    expect(contractAnimation({ in: { preset: 'fade' }, loop: { preset: 'float' } }, null)).toEqual({ in: { preset: 'fade', duration: 0.5 }, loop: { preset: 'float', period: 1.2 } });
    expect(contractAnimation({ in: { preset: 'fade', duration: 1 }, out: { preset: 'pop', duration: 1 } }, 1.5)).toEqual({ in: { preset: 'fade', duration: 1 }, out: { preset: 'pop', duration: 0.5 } });
    expect(contractAnimation({ in: { preset: 'fade', duration: 5 } }, null)).toEqual({ in: { preset: 'fade', duration: 5 } });
  });
});

describe('animationSummary / previewSpan', () => {
  it('摘要按入场 / 出场 / 循环列出，出场用自己的叫法', () => {
    expect(animationSummary(undefined)).toBe('无');
    expect(animationSummary({ in: { preset: 'pop' }, out: { preset: 'fade' }, loop: { preset: 'blink' } })).toBe('入场 弹入 · 出场 渐隐 · 循环 闪烁');
  });
  it('试播区间落在时段里', () => {
    const anim: TextAnimation = { in: { preset: 'fade', duration: 0.5 }, out: { preset: 'pop', duration: 1 }, loop: { preset: 'float', period: 1 } };
    expect(previewSpan(anim, 'in', [2, 8])).toEqual([2, 2.8]);
    expect(previewSpan(anim, 'out', [2, 8])).toEqual([6.7, 8]);
    expect(previewSpan(anim, 'loop', [2, 8])).toEqual([2.5, 4.5]);
    expect(previewSpan(anim, 'loop', [2, 3])).toEqual([2.5, 3]);
  });
});

describe('HIG-44 高级项', () => {
  it('每条曲线都从 0 走到 1', () => {
    for (const { v } of EASINGS) {
      for (const settle of [true, false]) {
        expect(ease(v, 0, settle)).toBeCloseTo(0, 5);
        expect(ease(v, 1, settle)).toBeCloseTo(1, 2);
      }
      expect(easingPoints(v, true, 8)).toHaveLength(9);
    }
  });
  it('没写 easing 时按预设取曲线', () => {
    expect(easingName({ preset: 'pop' }, 'in')).toBe('back');
    expect(easingName({ preset: 'pop' }, 'out')).toBe('ease_in');
    expect(easingName({ preset: 'slide_up' }, 'in')).toBe('ease_out');
    expect(easingName({ preset: 'fade', easing: 'bounce' }, 'in')).toBe('bounce');
  });
  it('contractAnimation：高级项等于契约缺省时不发，其余原样带上', () => {
    expect(
      contractAnimation({ in: { preset: 'pop', easing: 'back', scale: 0.5, overshoot: 1.70158, delay: 0 }, out: { preset: 'slide_up', distance: 0.05, fade: true, easing: 'ease_in' }, loop: { preset: 'blink', amount: 1 } }, null),
    ).toEqual({ in: { preset: 'pop', duration: 0.5 }, out: { preset: 'slide_up', duration: 0.5 }, loop: { preset: 'blink', period: 1.2 } });
    expect(
      contractAnimation({ in: { preset: 'slide_left', distance: 0.1234, fade: false, easing: 'elastic', delay: 0.4, scale: 2 }, loop: { preset: 'float', amount: 2.5 } }, null),
    ).toEqual({ in: { preset: 'slide_left', duration: 0.5, distance: 0.123, fade: false, easing: 'elastic', delay: 0.4 }, loop: { preset: 'float', period: 1.2, amount: 2.5 } });
    // 回弹强度只对 back 曲线发
    expect(contractAnimation({ in: { preset: 'fade', overshoot: 3 } }, null)).toEqual({ in: { preset: 'fade', duration: 0.5 } });
    expect(contractAnimation({ out: { preset: 'fade', easing: 'back', overshoot: 3 } }, null)).toEqual({ out: { preset: 'fade', duration: 0.5, easing: 'back', overshoot: 3 } });
  });
  it('contractAnimation：延迟 + 入场 + 出场压进区间时段', () => {
    const c = contractAnimation({ in: { preset: 'fade', duration: 1, delay: 1 }, out: { preset: 'fade', duration: 1 } }, 1.5)!;
    expect((c.in!.delay ?? 0) + c.in!.duration! + (c.out?.duration ?? 0)).toBeLessThanOrEqual(1.5);
    expect(c.in).toEqual({ preset: 'fade', duration: 0.5, delay: 1 });
    expect(c.out).toBeUndefined(); // 压到 0.01 仍放不下：出场让给入场
  });
  it('入场延迟推迟入场与循环，试播区间把延迟算进去', () => {
    const anim = { in: { preset: 'fade' as const, duration: 0.5, delay: 1 }, loop: { preset: 'breathe' as const, period: 1 } };
    expect(sampleAnimation(anim, 0.9, 4).opacity).toBe(0);
    expect(sampleAnimation(anim, 1.4, 4).scale).toBe(1);
    expect(previewSpan(anim, 'in', [0, 4])).toEqual([0, 1.8]);
    expect(previewSpan(anim, 'loop', [0, 4])).toEqual([1.5, 3.5]);
    const [di, d] = phaseLengths(anim, 1.2);
    expect(di).toBeCloseTo(0.2, 9);
    expect(d).toBe(0);
  });
  it('换预设：新选滑动用新幅度，同类之间沿用', () => {
    expect(switchPreset(undefined, 'slide_up')).toEqual({ preset: 'slide_up', duration: 0.5, distance: NEW_PRESET_DEFAULTS.slide_up!.distance });
    expect(switchPreset({ preset: 'slide_up', duration: 0.8, distance: 0.3, easing: 'bounce' }, 'slide_left')).toEqual({ preset: 'slide_left', duration: 0.8, distance: 0.3, easing: 'bounce' });
    expect(switchPreset({ preset: 'slide_up', duration: 0.8, distance: 0.3, fade: false }, 'pop')).toEqual({ preset: 'pop', duration: 0.8 });
    expect(switchPreset({ preset: 'pop', scale: 2, delay: 0.3 }, 'pop')).toEqual({ preset: 'pop', duration: 0.5, scale: 2, delay: 0.3 });
  });
  it('逐字进摘要、试播区间与 hasAnimation', () => {
    const anim = { reveal: { preset: 'typewriter' as const, duration: 2 } };
    expect(hasAnimation(anim)).toBe(true);
    expect(animationSummary(anim)).toBe('逐字 打字机');
    expect(previewSpan({ ...anim, in: { preset: 'fade', delay: 0.5 } }, 'reveal', [1, 10])).toEqual([1, 3.8]);
    expect(contractAnimation({ reveal: { preset: 'wipe', unit: 'char', cursor: true, easing: 'linear' } }, null)).toEqual({ reveal: { preset: 'wipe', duration: 1 } });
    expect(contractAnimation({ reveal: { preset: 'typewriter', unit: 'word', cursor: true, easing: 'ease_out', duration: 2.345 } }, 3)).toEqual({
      reveal: { preset: 'typewriter', duration: 2.35, unit: 'word', cursor: true, easing: 'ease_out' },
    });
  });
});

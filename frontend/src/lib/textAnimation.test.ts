import { describe, expect, it } from 'vitest';
import cases from './fixtures/textAnimationCases.json';
import { animationSummary, contractAnimation, hasAnimation, phaseLengths, previewSpan, sampleAnimation } from './textAnimation';
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

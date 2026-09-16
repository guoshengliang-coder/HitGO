import { describe, expect, it } from 'vitest';
import { nudgeValue, parseShown, SCRUB_PX_PER_STEP, scrubValue, shownValue, tidy } from './scrub';

describe('scrubValue', () => {
  it('位移不足一档不改值', () => {
    expect(scrubValue(0.08, SCRUB_PX_PER_STEP - 1, 0.005)).toBe(0.08);
    expect(scrubValue(0.08, -(SCRUB_PX_PER_STEP - 1), 0.005)).toBe(0.08);
  });
  it('每 4px 走一档，方向跟随 dx', () => {
    expect(scrubValue(0.08, SCRUB_PX_PER_STEP * 3, 0.005)).toBe(0.095);
    expect(scrubValue(0.08, -SCRUB_PX_PER_STEP * 2, 0.005)).toBe(0.07);
  });
  it('shift 十倍、alt 十分之一', () => {
    expect(scrubValue(0, SCRUB_PX_PER_STEP, 1, { shift: true })).toBe(10);
    expect(scrubValue(0, SCRUB_PX_PER_STEP, 1, { alt: true })).toBe(0.1);
  });
  it('夹在 min / max 之间，且没有浮点尾巴', () => {
    expect(scrubValue(0.01, -SCRUB_PX_PER_STEP * 5, 0.005, { min: 0.01 })).toBe(0.01);
    expect(scrubValue(1.99, SCRUB_PX_PER_STEP * 5, 0.01, { max: 2 })).toBe(2);
    expect(scrubValue(0.1, SCRUB_PX_PER_STEP * 2, 0.1)).toBe(0.3);
  });
});

describe('nudgeValue', () => {
  it('上下键按 step 走，shift 十倍，夹在范围内', () => {
    expect(nudgeValue(5, 1, 1)).toBe(6);
    expect(nudgeValue(5, -1, 1, { shift: true })).toBe(-5);
    expect(nudgeValue(360, 1, 1, { max: 360 })).toBe(360);
  });
});

describe('shownValue / parseShown', () => {
  it('内部单位与显示值互转，默认 ×100', () => {
    expect(shownValue(0.085, 100)).toBe(8.5);
    expect(shownValue(0.004, 1000)).toBe(4);
    expect(parseShown('8.5', 100)).toBe(0.085);
    expect(parseShown(' 12 ', 100)).toBe(0.12);
    expect(parseShown('-3', 1)).toBe(-3);
  });
  it('非法输入返回 null，越界夹住', () => {
    expect(parseShown('', 100)).toBeNull();
    expect(parseShown('abc', 100)).toBeNull();
    expect(parseShown('500', 100, 0.01, 2)).toBe(2);
  });
  it('tidy 去掉浮点尾巴', () => {
    expect(tidy(0.1 + 0.2)).toBe(0.3);
  });
});

import { describe, expect, it } from 'vitest';
import { placePopover } from './popover';

const vp = { width: 1000, height: 800 };
const size = { width: 260, height: 360 };

describe('placePopover', () => {
  it('空间够时放在下方左对齐', () => {
    expect(placePopover({ left: 100, top: 100, width: 28, height: 28 }, size, vp)).toEqual({ left: 100, top: 134 });
  });
  it('下方放不下翻到上方', () => {
    expect(placePopover({ left: 100, top: 600, width: 28, height: 28 }, size, vp)).toEqual({ left: 100, top: 234 });
  });
  it('上下都放不下时贴底限位且不越过顶边', () => {
    expect(placePopover({ left: 100, top: 300, width: 28, height: 28 }, size, { width: 1000, height: 500 })).toEqual({ left: 100, top: 132 });
    expect(placePopover({ left: 100, top: 100, width: 28, height: 28 }, size, { width: 1000, height: 300 }).top).toBe(8);
  });
  it('右侧贴边时向左限位（右栏场景）', () => {
    expect(placePopover({ left: 950, top: 100, width: 28, height: 28 }, size, vp).left).toBe(1000 - 8 - 260);
  });
});

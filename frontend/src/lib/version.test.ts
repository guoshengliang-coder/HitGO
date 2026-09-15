import { describe, expect, it } from 'vitest';
import { formatVersion } from './version';

describe('formatVersion', () => {
  it('tag 原样显示', () => {
    expect(formatVersion('v0.8.0')).toBe('v0.8.0');
    expect(formatVersion(' v0.8.0\n')).toBe('v0.8.0');
  });

  it('完整 git describe 裁成最近的 tag', () => {
    expect(formatVersion('v0.8.0-3-gabc1234')).toBe('v0.8.0');
    expect(formatVersion('v1.0.0-rc-12-g0f3e9a1')).toBe('v1.0.0-rc');
  });

  it('取不到版本时显示 dev', () => {
    expect(formatVersion('')).toBe('dev');
    expect(formatVersion('  ')).toBe('dev');
    expect(formatVersion(undefined)).toBe('dev');
    expect(formatVersion(null)).toBe('dev');
  });
});

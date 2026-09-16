import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateOr, fmtSize } from './datetime';

describe('fmtDate', () => {
  it('formats an ISO string as YYYY-MM-DD HH:mm in local time', () => {
    // 用本地时间构造，避免测试跟着运行机器的时区漂
    const d = new Date(2026, 8, 16, 15, 42, 7);
    expect(fmtDate(d.toISOString())).toBe('2026-09-16 15:42');
  });

  it('zero-pads month, day, hour and minute', () => {
    const d = new Date(2026, 0, 2, 3, 4, 0);
    expect(fmtDate(d.toISOString())).toBe('2026-01-02 03:04');
  });

  it('returns the input unchanged when it is not a date', () => {
    expect(fmtDate('not-a-date')).toBe('not-a-date');
    expect(fmtDate('')).toBe('');
  });
});

describe('fmtDateOr', () => {
  it('falls back when there is no timestamp', () => {
    expect(fmtDateOr(null)).toBe('—');
    expect(fmtDateOr(undefined)).toBe('—');
    expect(fmtDateOr('', '待定')).toBe('待定');
  });

  it('formats when there is one', () => {
    const d = new Date(2026, 8, 16, 15, 42);
    expect(fmtDateOr(d.toISOString())).toBe('2026-09-16 15:42');
  });
});

describe('fmtSize', () => {
  it('switches unit at the KB and MB boundaries', () => {
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(1023)).toBe('1023 B');
    expect(fmtSize(1024)).toBe('1 KB');
    expect(fmtSize(1024 * 1024 - 1)).toBe('1024 KB');
    expect(fmtSize(1024 * 1024)).toBe('1.0 MB');
    expect(fmtSize(7.4 * 1024 * 1024)).toBe('7.4 MB');
  });
});

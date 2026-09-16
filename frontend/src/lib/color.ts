// 颜色换算（取色器用）：hex ↔ RGB ↔ HSV，#RRGGBB / #RRGGBBAA 解析与格式化。
// spec 里的颜色一律大写 hex；带透明度时是 8 位，alpha=FF 时可省略成 6 位。

export interface RGBA {
  r: number; // 0-255
  g: number;
  b: number;
  a: number; // 0-1
}

export interface HSV {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0').toUpperCase();

/** 解析 #RGB / #RRGGBB / #RRGGBBAA（# 可省略）；非法返回 null。 */
export function parseHex(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  let s = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return null;
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) / 255 : 1 };
}

/** 格式化为大写 hex。withAlpha=false 时总是 6 位；否则 alpha<1 才带 AA。 */
export function formatHex(c: RGBA, withAlpha = true): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const a = Math.round(clamp(c.a, 0, 1) * 255);
  return withAlpha && a < 255 ? base + hex2(a) : base;
}

/** 规范化任意输入为大写 hex；非法时返回 fallback。 */
export function normalizeHex(input: string | null | undefined, fallback = '#000000', withAlpha = true): string {
  const c = parseHex(input);
  return c ? formatHex(c, withAlpha) : fallback;
}

/** 只取 RGB 部分的 #RRGGBB。 */
export function opaqueHex(input: string | null | undefined, fallback = '#000000'): string {
  return normalizeHex(input, fallback, false);
}

export function rgbToHsv({ r, g, b }: Pick<RGBA, 'r' | 'g' | 'b'>): HSV {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): Pick<RGBA, 'r' | 'g' | 'b'> {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** alpha(0-1) → 百分比整数。 */
export const alphaToPercent = (a: number) => Math.round(clamp(a, 0, 1) * 100);
/** 百分比 → alpha(0-1)，非法按 100%。 */
export const percentToAlpha = (p: number) => (Number.isFinite(p) ? clamp(p, 0, 100) / 100 : 1);

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { alphaToPercent, formatHex, hsvToRgb, parseHex, percentToAlpha, rgbToHsv, type HSV } from '../../lib/color';
import { addCustomColor, loadCustomColors, PRESET_COLORS, removeCustomColor, saveCustomColors } from '../../lib/colorSwatches';
import { placePopover } from '../../lib/popover';

// 剪映式取色器：色块 + hex 触发，弹层含 SV 面板、色相条、吸管、Hex/RGB 输入、透明度、自定义色与预设色板。
// alpha=false 时输出 #RRGGBB（遮盖色块、成片纯色边）；true 时 alpha<100% 输出 #RRGGBBAA。

interface EyeDropperCtor {
  new (): { open: () => Promise<{ sRGBHex: string }> };
}
const eyeDropper = (): EyeDropperCtor | undefined => (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

type Mode = 'hex' | 'rgb';

export function ColorPicker({
  value,
  onChange,
  alpha = false,
  showHex = true,
  fallback = '#000000',
  label = '颜色',
}: {
  value: string | null | undefined;
  onChange: (hex: string) => void;
  alpha?: boolean;
  showHex?: boolean;
  fallback?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shown = formatHex(parseHex(value) ?? parseHex(fallback)!, alpha);
  return (
    <span className="cp-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`cp-trigger ${open ? 'open' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <i className="checker" />
        <i style={{ background: shown }} />
      </button>
      {showHex && <span className="mono small">{shown}</span>}
      {open && <ColorPanel value={shown} alpha={alpha} anchor={triggerRef} label={label} onChange={onChange} onClose={() => setOpen(false)} />}
    </span>
  );
}

function ColorPanel({
  value,
  alpha,
  anchor,
  label,
  onChange,
  onClose,
}: {
  value: string;
  alpha: boolean;
  anchor: React.RefObject<HTMLElement>;
  label: string;
  onChange: (hex: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const init = parseHex(value)!;
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(init));
  const [a, setA] = useState(alpha ? init.a : 1);
  const [mode, setMode] = useState<Mode>('hex');
  const [custom, setCustom] = useState<string[]>(() => loadCustomColors());
  const lastEmitted = useRef(value);

  // 外部改了值（撤销、重置）：同步进来；自己发出的值不回灌，免得灰色时色相跳回 0。
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const c = parseHex(value);
    if (!c) return;
    lastEmitted.current = value;
    setHsv(rgbToHsv(c));
    setA(alpha ? c.a : 1);
  }, [value, alpha]);

  const emit = useCallback(
    (nextHsv: HSV, nextA: number) => {
      setHsv(nextHsv);
      setA(nextA);
      const hex = formatHex({ ...hsvToRgb(nextHsv), a: nextA }, alpha);
      if (hex !== lastEmitted.current) {
        lastEmitted.current = hex;
        onChange(hex);
      }
    },
    [alpha, onChange],
  );
  const emitHex = (hex: string) => {
    const c = parseHex(hex);
    if (!c) return;
    const h = rgbToHsv(c);
    // 灰色没有色相：保留当前色相，SV 面板不跳
    emit(h.s === 0 ? { ...h, h: hsv.h } : h, alpha ? c.a : 1);
  };

  useLayoutEffect(() => {
    const el = anchor.current;
    const panel = panelRef.current;
    if (!el || !panel) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      setPos(placePopover(r, { width: panel.offsetWidth, height: panel.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  const rgb = hsvToRgb(hsv);
  const current = formatHex({ ...rgb, a }, alpha);
  const pureHue = formatHex({ ...hsvToRgb({ h: hsv.h, s: 1, v: 1 }), a: 1 });

  const drag = (el: HTMLElement, e: RPointerEvent, apply: (x: number, y: number) => void) => {
    const r = el.getBoundingClientRect();
    const at = (cx: number, cy: number) => apply(Math.min(1, Math.max(0, (cx - r.left) / r.width)), Math.min(1, Math.max(0, (cy - r.top) / r.height)));
    el.setPointerCapture(e.pointerId);
    at(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => at(ev.clientX, ev.clientY);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const pick = async () => {
    const ED = eyeDropper();
    if (!ED) return;
    try {
      const res = await new ED().open();
      const c = parseHex(res.sRGBHex);
      if (c) emitHex(formatHex({ ...c, a }, alpha));
    } catch {
      /* 用户按 Esc 取消 */
    }
  };

  const saveCustom = () => {
    const next = addCustomColor(custom, current);
    setCustom(next);
    saveCustomColors(next);
  };
  const dropCustom = (c: string) => {
    const next = removeCustomColor(custom, c);
    setCustom(next);
    saveCustomColors(next);
  };

  return createPortal(
    <div
      ref={panelRef}
      className="cp-panel"
      role="dialog"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="cp-sv"
        style={{ background: pureHue }}
        onPointerDown={(e) => drag(e.currentTarget, e, (x, y) => emit({ h: hsv.h, s: x, v: 1 - y }, a))}
      >
        <i className="cp-sv-white" />
        <i className="cp-sv-black" />
        <i className="cp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: formatHex({ ...rgb, a: 1 }) }} />
      </div>
      <div className="cp-row">
        {eyeDropper() && (
          <button type="button" className="cp-dropper" title="吸管：从屏幕取色" aria-label="吸管" onClick={pick}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m10 2.5 3.5 3.5M11.8 4.2 4 12l-2 2 .5-2.5L10.3 3.7" />
            </svg>
          </button>
        )}
        <div className="cp-hue" onPointerDown={(e) => drag(e.currentTarget, e, (x) => emit({ ...hsv, h: x * 360 }, a))}>
          <i className="cp-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%', background: pureHue }} />
        </div>
      </div>
      {alpha && (
        <div className="cp-row">
          <div
            className="cp-alpha checker"
            onPointerDown={(e) => drag(e.currentTarget, e, (x) => emit(hsv, Math.round(x * 100) / 100))}
          >
            <i style={{ background: `linear-gradient(to right, ${formatHex({ ...rgb, a: 0 })}, ${formatHex({ ...rgb, a: 1 })})` }} />
            <i className="cp-thumb" style={{ left: `${a * 100}%`, top: '50%', background: formatHex({ ...rgb, a: 1 }) }} />
          </div>
        </div>
      )}
      <div className="cp-inputs">
        <select className="select sm" value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="输入格式">
          <option value="hex">Hex</option>
          <option value="rgb">RGB</option>
        </select>
        {mode === 'hex' ? (
          <HexInput value={formatHex({ ...rgb, a: 1 }).slice(1)} onCommit={(v) => emitHex(`#${v}${alpha ? formatHex({ r: 0, g: 0, b: 0, a }, true).slice(7) : ''}`)} />
        ) : (
          (['r', 'g', 'b'] as const).map((k) => (
            <NumInput key={k} label={k.toUpperCase()} value={rgb[k]} max={255} onCommit={(v) => emitHex(formatHex({ ...rgb, [k]: v, a }, alpha))} />
          ))
        )}
        {alpha && <NumInput label="透明度" value={alphaToPercent(a)} max={100} suffix="%" onCommit={(v) => emit(hsv, percentToAlpha(v))} />}
      </div>
      <div className="cp-sep" />
      <div className="cp-swatches">
        <button type="button" className="cp-swatch cp-add" title="把当前颜色存进色板" aria-label="保存当前颜色" onClick={saveCustom}>
          +
        </button>
        {custom.map((c) => (
          <button
            key={`c-${c}`}
            type="button"
            className="cp-swatch checker"
            title={`${c}（右键从色板移除）`}
            onClick={() => emitHex(alpha ? c : c.slice(0, 7))}
            onContextMenu={(e) => {
              e.preventDefault();
              dropCustom(c);
            }}
          >
            <i style={{ background: c }} />
          </button>
        ))}
        {PRESET_COLORS.map((c) => (
          <button key={c} type="button" className="cp-swatch" title={c} style={{ background: c }} onClick={() => emitHex(formatHex({ ...parseHex(c)!, a }, alpha))} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function HexInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim().replace(/^#/, '');
    if (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) onCommit(v.length === 3 ? v.split('').map((c) => c + c).join('') : v);
    else setDraft(value);
  };
  return (
    <input
      className="input sm mono cp-hex"
      value={draft}
      maxLength={7}
      spellCheck={false}
      aria-label="Hex"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function NumInput({ label, value, max, suffix, onCommit }: { label: string; value: number; max: number; suffix?: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() !== '' && Number.isFinite(n)) onCommit(Math.min(max, Math.max(0, n)));
    else setDraft(String(value));
  };
  return (
    <label className={`cp-num ${suffix ? 'pct' : ''}`} title={label}>
      <input
        className="input sm mono"
        value={draft}
        inputMode="numeric"
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

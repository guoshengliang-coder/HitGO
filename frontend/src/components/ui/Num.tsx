// 数值输入块（docs/DESIGN.md §3.2）：「标签 | 数值 单位」一体的 30px 块。
// 单击进入编辑；在块上按住左右拖按 step 微调（shift 十倍、alt 十分之一）；上下键步进。
// value 是内部单位，界面按 scale 放大显示（默认 ×100 显示为 %）。换算与拖动都是 lib/scrub 的纯函数。
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { nudgeValue, parseShown, SCRUB_THRESHOLD_PX, scrubValue, shownValue } from '../../lib/scrub';

export function Num({
  label,
  value,
  onChange,
  step = 0.01,
  min,
  max,
  scale = 100,
  suffix = '%',
  title,
  disabled,
  className,
}: {
  label?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  scale?: number;
  suffix?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // 编辑中的文本；null 表示显示态（显示 value 换算后的值）
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ x: number; start: number; moved: boolean; id: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const shown = shownValue(value, scale);
  const opts = { min, max };

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (disabled || e.button !== 0 || draft !== null) return;
    e.preventDefault(); // 不让浏览器把焦点给输入框：单击才进入编辑，拖动不进
    drag.current = { x: e.clientX, start: value, moved: false, id: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件 / 不支持捕获的环境：没有捕获也能拖，只是指针离开块后不再跟随 */
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < SCRUB_THRESHOLD_PX) return;
      d.moved = true;
      setScrubbing(true);
    }
    const next = scrubValue(d.start, dx, step, { ...opts, shift: e.shiftKey, alt: e.altKey });
    if (next !== value) onChange(next);
  };
  const onPointerUp = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(d.id)) e.currentTarget.releasePointerCapture(d.id);
    } catch {
      /* 同上 */
    }
    if (d.moved) {
      setScrubbing(false);
      return;
    }
    inputRef.current?.focus(); // 单击：进入编辑（onFocus 里切到草稿态并全选）
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = nudgeValue(value, e.key === 'ArrowUp' ? 1 : -1, step, { ...opts, shift: e.shiftKey, alt: e.altKey });
      onChange(next);
      setDraft(String(shownValue(next, scale)));
    } else if (e.key === 'Enter' || e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  return (
    <span
      className={`tile num ${scrubbing ? 'scrubbing' : ''} ${disabled ? 'disabled' : ''} ${className ?? ''}`}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {label && <span className="l">{label}</span>}
      <input
        ref={inputRef}
        className="v"
        type="text"
        inputMode="decimal"
        aria-label={typeof label === 'string' ? label : undefined}
        value={draft ?? String(shown)}
        readOnly={draft === null}
        disabled={disabled}
        onFocus={() => {
          setDraft(String(shown));
          requestAnimationFrame(() => inputRef.current?.select());
        }}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parseShown(e.target.value, scale, min, max);
          if (n !== null) onChange(n);
        }}
        onKeyDown={onKeyDown}
      />
      {suffix && <span className="u">{suffix}</span>}
    </span>
  );
}

/** 滑杆 + 数值块（不透明度、音量这类 0–1 的量），整体是一个下沉的块。 */
export function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, disabled }: { label?: ReactNode; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; disabled?: boolean }) {
  return (
    <span className="slider">
      {label && <span className="l">{label}</span>}
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={typeof label === 'string' ? label : undefined} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <Num value={value} min={min} max={max} step={step} onChange={onChange} disabled={disabled} className="compact" />
    </span>
  );
}

/** 非数值的输入块：标签在左，右侧放下拉 / 取色器 / 任意控件。 */
export function Field({ label, children, className, title }: { label: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={`tile field ${className ?? ''}`} title={title}>
      <span className="l">{label}</span>
      <span className="v">{children}</span>
    </span>
  );
}

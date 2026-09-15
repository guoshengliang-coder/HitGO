const clampNum = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** 数字输入 + 步进按钮。value 为内部单位，界面按 scale 放大显示（默认 ×100 显示为 %）。 */
export function Num({ value, onChange, step = 0.01, min, max, scale = 100, suffix = '%', title, disabled }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; scale?: number; suffix?: string; title?: string; disabled?: boolean }) {
  const shown = Math.round(value * scale * 100) / 100;
  const bump = (dir: 1 | -1) => onChange(clampNum(Math.round((value + dir * step) * 1e6) / 1e6, min, max));
  return (
    <span className="num-wrap" title={title}>
      <button className="num-step" tabIndex={-1} aria-label="减少" disabled={disabled} onClick={() => bump(-1)}>−</button>
      <input
        className="input sm num"
        type="number"
        step={step * scale}
        min={min !== undefined ? min * scale : undefined}
        max={max !== undefined ? max * scale : undefined}
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(clampNum(n / scale, min, max));
        }}
      />
      <button className="num-step" tabIndex={-1} aria-label="增加" disabled={disabled} onClick={() => bump(1)}>+</button>
      {suffix && <span className="muted small">{suffix}</span>}
    </span>
  );
}

/** 滑块 + 数字（不透明度、音量这类 0–1 的量）。 */
export function Slider({ value, onChange, min = 0, max = 1, step = 0.01, disabled }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; disabled?: boolean }) {
  return (
    <span className="inline slider-row">
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <Num value={value} min={min} max={max} step={step} onChange={onChange} disabled={disabled} />
    </span>
  );
}

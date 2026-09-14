import { useEditor, usePostDuration } from '../../store/editor';
import { VARIANT_DEFS, type FillMode, type OutputQuality, type OutputVariant, type VariantKey, ANCHORS, type Anchor } from '../../types';
import { countSafeZoneOverlaps, effectivePlacement, layerName } from '../../lib/spec';
import { formatSeconds } from '../../lib/time';
import { estimateOutputBytes, formatBytes, qualityOf } from '../../lib/estimate';

const FILL_LABEL: Record<FillMode, string> = { blur: '模糊背景', color: '纯色', crop: '裁切' };
const QUALITY_LABEL: Record<OutputQuality, string> = { standard: '标准', high: '高清' };
const QUALITY_TIP = '标准 = 更快更小（veryfast / crf 20）；高清 = 更慢更清晰（medium / crf 19）';

function OverrideEditor({ variantKey }: { variantKey: VariantKey }) {
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const assets = useEditor((s) => s.assets);
  const setOverride = useEditor((s) => s.setOverride);
  if (!spec) return null;
  const variant = spec.outputs.find((o) => o.variant_key === variantKey);
  if (!variant) return null;
  return (
    <div className="section">
      <div className="section-title">在 {VARIANT_DEFS.find((v) => v.key === variantKey)?.label} 上微调图层</div>
      {spec.layers.length === 0 && <div className="hint">没有图层可微调。</div>}
      {spec.layers.map((l) => {
        const ov = variant.layer_overrides?.[l.id];
        const eff = effectivePlacement(l, ov);
        return (
          <div key={l.id} className="output-item">
            <div className="head">
              <span className="lname" style={{ flex: 1 }}>{layerName(l, assets)}</span>
              {ov && <button className="btn ghost sm" onClick={() => setOverride(variantKey, l.id, null)}>还原</button>}
            </div>
            <div className="prop-grid">
              <span>锚点</span>
              <select className="select sm" value={eff.anchor} onChange={(e) => setOverride(variantKey, l.id, { anchor: e.target.value as Anchor })}>
                {ANCHORS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <span>边距 X / Y</span>
              <div className="inline">
                <input className="input sm num" type="number" step={1} value={Math.round(eff.margin[0] * 100)} onChange={(e) => setOverride(variantKey, l.id, { margin: [Number(e.target.value) / 100, eff.margin[1]] })} />
                <input className="input sm num" type="number" step={1} value={Math.round(eff.margin[1] * 100)} onChange={(e) => setOverride(variantKey, l.id, { margin: [eff.margin[0], Number(e.target.value) / 100] })} />
                <span className="muted small">%</span>
              </div>
              <span>宽度</span>
              <div className="inline">
                <input className="input sm num" type="number" step={1} min={1} value={Math.round(eff.width * 100)} onChange={(e) => setOverride(variantKey, l.id, { width: Number(e.target.value) / 100 })} />
                <span className="muted small">%</span>
              </div>
              <span>旋转 / 透明</span>
              <div className="inline">
                <input className="input sm num" type="number" step={1} value={Math.round(eff.rotate)} onChange={(e) => setOverride(variantKey, l.id, { rotate: Number(e.target.value) })} />
                <input className="input sm num" type="number" step={5} min={0} max={100} value={Math.round(eff.opacity * 100)} onChange={(e) => setOverride(variantKey, l.id, { opacity: Number(e.target.value) / 100 })} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OutputsPanel({ onSaveAndRender, targetCount, fileCount }: { onSaveAndRender: () => void; targetCount: number; fileCount: number }) {
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const setOutputs = useEditor((s) => s.setOutputs);
  const selectedVariant = useEditor((s) => s.selectedVariantKey);
  const setSelectedVariant = useEditor((s) => s.setSelectedVariant);
  const overrideMode = useEditor((s) => s.overrideMode);
  const setOverrideMode = useEditor((s) => s.setOverrideMode);
  const saveScope = useEditor((s) => s.saveScope);
  const setSaveScope = useEditor((s) => s.setSaveScope);
  const selectedIds = useEditor((s) => s.selectedIds);
  const videos = useEditor((s) => s.videos);
  const zone = useEditor((s) => s.safeZones.find((z) => z.key === s.safeZoneKey));
  const assets = useEditor((s) => s.assets);
  const rendering = useEditor((s) => s.rendering);
  const calibration = useEditor((s) => s.outputCalibration);
  const postDuration = usePostDuration();
  const outputs = spec?.outputs ?? [];
  const overlaps = spec ? countSafeZoneOverlaps(spec, zone, assets) : 0;
  const estimates = Object.fromEntries(outputs.map((o) => [o.variant_key, estimateOutputBytes(o, postDuration, calibration)])) as Record<string, number>;
  const totalBytes = outputs.reduce((n, o) => n + (estimates[o.variant_key] ?? 0), 0);
  const tiers = Array.from(new Set(outputs.map((o) => QUALITY_LABEL[qualityOf(o)])));
  const calibrated = Object.keys(calibration).length > 0;

  const toggle = (key: VariantKey, on: boolean) => {
    const def = VARIANT_DEFS.find((v) => v.key === key)!;
    let next: OutputVariant[];
    if (on) next = [...outputs, { variant_key: key, aspect: def.aspect, fill: 'blur', quality: 'standard' }];
    else next = outputs.filter((o) => o.variant_key !== key);
    if (next.length === 0) return; // 至少一个输出
    next.sort((a, b) => VARIANT_DEFS.findIndex((v) => v.key === a.variant_key) - VARIANT_DEFS.findIndex((v) => v.key === b.variant_key));
    setOutputs(next);
    if (!next.find((o) => o.variant_key === selectedVariant)) setSelectedVariant(next[0].variant_key);
  };
  const patch = (key: VariantKey, p: Partial<OutputVariant>) => setOutputs(outputs.map((o) => (o.variant_key === key ? { ...o, ...p } : o)));
  const isOn = (key: VariantKey) => outputs.some((o) => o.variant_key === key);
  const selectedOn = isOn(selectedVariant);

  return (
    <div className="panel">
      <div className="panel-head">③ 输出</div>
      <div className="panel-body">
        <div className="section">
          <div className="section-title">输出变体</div>
          {VARIANT_DEFS.map((def) => {
            const o = outputs.find((x) => x.variant_key === def.key);
            const on = !!o;
            return (
              <div key={def.key} className={`output-item ${on ? 'on' : ''} ${selectedVariant === def.key ? 'selected' : ''}`} onClick={() => setSelectedVariant(def.key)}>
                <div className="head">
                  <input type="checkbox" checked={on} disabled={on && outputs.length === 1} onChange={(e) => toggle(def.key, e.target.checked)} onClick={(e) => e.stopPropagation()} />
                  <b>{def.label}</b>
                  <span className="muted small">{def.note}</span>
                  <span className="spacer" />
                  <span className="mono muted small">{def.width}×{def.height}</span>
                </div>
                {on && o && (
                  <div className="inline" onClick={(e) => e.stopPropagation()}>
                    <select className="select sm" value={o.fill} onChange={(e) => patch(def.key, { fill: e.target.value as FillMode, color: e.target.value === 'color' ? (o.color ?? '#000000') : undefined })}>
                      {(Object.keys(FILL_LABEL) as FillMode[]).map((f) => (
                        <option key={f} value={f}>{FILL_LABEL[f]}</option>
                      ))}
                    </select>
                    {o.fill === 'color' && (
                      <>
                        <input type="color" className="color" value={o.color ?? '#000000'} onChange={(e) => patch(def.key, { color: e.target.value })} />
                        <span className="mono small">{o.color ?? '#000000'}</span>
                      </>
                    )}
                    {o.layer_overrides && Object.keys(o.layer_overrides).length > 0 && <span className="pill edited">已微调 {Object.keys(o.layer_overrides).length}</span>}
                  </div>
                )}
                {on && o && (
                  <div className="inline" onClick={(e) => e.stopPropagation()}>
                    <span className="muted small">质量</span>
                    <span className="chips" title={QUALITY_TIP} role="radiogroup" aria-label={`${def.label} 质量`}>
                      {(['standard', 'high'] as OutputQuality[]).map((qk) => (
                        <button key={qk} role="radio" aria-checked={qualityOf(o) === qk} className={`chip ${qualityOf(o) === qk ? 'active' : ''}`} onClick={() => patch(def.key, { quality: qk })}>
                          {QUALITY_LABEL[qk]}
                        </button>
                      ))}
                    </span>
                    <span className="spacer" />
                    <span className="mono muted small" title={calibrated ? '按本批次已完成任务的实际码率校准' : '按编码档位的典型码率估算'}>
                      约 {formatBytes(estimates[def.key] ?? 0)}（估算）
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {selectedOn && selectedVariant !== '9x16' && (
          <label className="inline">
            <input type="checkbox" checked={overrideMode} onChange={(e) => setOverrideMode(e.target.checked)} />
            在此变体上微调图层
          </label>
        )}
        {overrideMode && selectedOn && <OverrideEditor variantKey={selectedVariant} />}

        <div className="section">
          <div className="section-title">规格摘要</div>
          <dl className="kv">
            <dt>剪后时长</dt>
            <dd>{formatSeconds(postDuration, 2)}</dd>
            <dt>编码</dt>
            <dd>H.264 / AAC · {tiers.join(' + ') || '标准'}</dd>
            <dt>成片大小</dt>
            <dd title={calibrated ? '已按本批次实际码率校准' : '按典型码率估算'}>
              约 {formatBytes(totalBytes)}（估算{outputs.length > 1 ? `，${outputs.length} 个文件` : ''}）
            </dd>
            <dt>图层</dt>
            <dd>{spec?.layers.length ?? 0}</dd>
            <dt>安全区检查</dt>
            <dd style={{ color: overlaps ? 'var(--st-failed-fg)' : 'var(--st-done-fg)' }}>{overlaps ? `${overlaps} 个图层与遮挡区重叠` : '无重叠'}</dd>
          </dl>
        </div>

        <div className="section">
          <div className="section-title">保存范围</div>
          <div className="chips">
            <button className={`chip ${saveScope === 'current' ? 'active' : ''}`} onClick={() => setSaveScope('current')}>仅当前</button>
            <button className={`chip ${saveScope === 'selected' ? 'active' : ''}`} onClick={() => setSaveScope('selected')} disabled={!selectedIds.length}>选中 {selectedIds.length} 条</button>
            <button className={`chip ${saveScope === 'all' ? 'active' : ''}`} onClick={() => setSaveScope('all')}>全部 {videos.length} 条</button>
          </div>
          <div className="hint">每条视频按各自的 spec 生成任务；只有当前视频的配置在本页编辑，其他视频使用它们已保存的配置（可先用「批量应用」同步）。</div>
        </div>
      </div>
      <div className="panel-foot">
        <button className="btn primary" onClick={onSaveAndRender} disabled={rendering || targetCount === 0}>
          {rendering ? '处理中…' : `保存并回传 · ${targetCount} 条 · ${fileCount} 个文件`}
        </button>
      </div>
    </div>
  );
}

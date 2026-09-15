import { Link } from 'react-router-dom';
import { useEditor, type SafeZoneView } from '../../store/editor';
import { STEPS } from '../../lib/steps';
import { IconRedo, IconUndo } from '../ui/Icons';
import { ThemeToggle } from '../ui/ThemeToggle';

const SAFE_VIEWS: { v: SafeZoneView; label: string; tip: string }[] = [
  { v: 'frames', label: '框线', tip: '显示遮挡区框线与安全框' },
  { v: 'overlay', label: '遮挡示意', tip: '叠加平台界面示意图（无示意图的预设退回框线）' },
  { v: 'none', label: '关闭', tip: '不显示安全区' },
];

export function TopBar({ onExport }: { onExport: () => void }) {
  const batch = useEditor((s) => s.batch);
  const step = useEditor((s) => s.step);
  const setStep = useEditor((s) => s.setStep);
  const safeZones = useEditor((s) => s.safeZones);
  const safeZoneKey = useEditor((s) => s.safeZoneKey);
  const setSafeZoneKey = useEditor((s) => s.setSafeZoneKey);
  const safeZoneView = useEditor((s) => s.safeZoneView);
  const setSafeZoneView = useEditor((s) => s.setSafeZoneView);
  const zone = safeZones.find((z) => z.key === safeZoneKey);
  const overlayMissing = safeZoneView === 'overlay' && !zone?.overlay_url;
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.canUndo());
  const canRedo = useEditor((s) => s.canRedo());
  const saveState = useEditor((s) => s.saveState);
  const saveError = useEditor((s) => s.saveError);
  const rendering = useEditor((s) => s.rendering);

  const saveText = { idle: '', dirty: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' }[saveState];

  return (
    <div className="topbar">
      <Link to="/" className="brand">
        Hit<b>GO</b>
      </Link>
      <span className="batch-name" title={batch?.name}>
        {batch?.name ?? '…'}
      </span>
      <span className="muted small mono">{batch?.video_count ?? 0} 条</span>
      <div className="steps" role="tablist">
        {STEPS.map((s) => (
          <button key={s.key} role="tab" aria-selected={step === s.key} className={`step-btn ${step === s.key ? 'active' : ''}`} onClick={() => setStep(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <label className="inline small muted">
        安全区
        <select className="select sm" value={safeZoneKey} onChange={(e) => setSafeZoneKey(e.target.value)}>
          {safeZones.map((z) => (
            <option key={z.key} value={z.key}>
              {z.name}
            </option>
          ))}
        </select>
      </label>
      <span className="seg" role="radiogroup" aria-label="安全区显示">
        {SAFE_VIEWS.map((o) => (
          <button key={o.v} role="radio" aria-checked={safeZoneView === o.v} className={`seg-btn ${safeZoneView === o.v ? 'active' : ''}`} title={o.tip} onClick={() => setSafeZoneView(o.v)}>
            {o.label}
          </button>
        ))}
      </span>
      {overlayMissing && <span className="muted small">该预设无示意图，显示框线</span>}
      <ThemeToggle />
      <button className="btn icon" onClick={undo} disabled={!canUndo} aria-label="撤销" title="撤销（⌘Z）">
        <IconUndo />
      </button>
      <button className="btn icon" onClick={redo} disabled={!canRedo} aria-label="重做" title="重做（⇧⌘Z）">
        <IconRedo />
      </button>
      <span className={`save-indicator ${saveState === 'error' ? 'error' : ''}`} title={saveError ?? undefined}>
        {saveText}
      </span>
      <Link to={`/batches/${batch?.id}/outputs`} className="btn">
        已回传
      </Link>
      <button className="btn primary" onClick={onExport} disabled={rendering} title="保存并导出成片：选择导出这一批、勾选的几条或仅当前这条">
        {rendering ? '导出中…' : '导出'}
      </button>
    </div>
  );
}

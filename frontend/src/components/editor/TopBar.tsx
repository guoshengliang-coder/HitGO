// 编辑器顶栏：品牌 + 版本号、模块 tab、配色 / 撤销重做 / 保存状态 / 导出。
// 批次名在左栏「全选」上方（HIG-14），安全区在画布下方 QuickBar（HIG-13），顶栏不再放。
import { Link } from 'react-router-dom';
import { useEditor } from '../../store/editor';
import { STEPS } from '../../lib/steps';
import { AppVersion } from '../ui/AppVersion';
import { IconRedo, IconUndo } from '../ui/Icons';
import { ThemeToggle } from '../ui/ThemeToggle';

export function TopBar({ onExport }: { onExport: () => void }) {
  const batch = useEditor((s) => s.batch);
  const step = useEditor((s) => s.step);
  const setStep = useEditor((s) => s.setStep);
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
      <span className="brand-group">
        <Link to="/" className="brand">
          Hit<b>GO</b>
        </Link>
        <AppVersion />
      </span>
      <div className="steps" role="tablist">
        {STEPS.map((s) => (
          <button key={s.key} role="tab" aria-selected={step === s.key} className={`step-btn ${step === s.key ? 'active' : ''}`} onClick={() => setStep(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <span className="spacer" />
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
      <Link to={batch ? `/outputs?batch=${encodeURIComponent(batch.id)}` : '/outputs'} className="btn">
        产物
      </Link>
      <button className="btn primary" onClick={onExport} disabled={rendering} title="保存并导出成片：选择导出这一批、勾选的几条或仅当前这条">
        {rendering ? '导出中…' : '导出'}
      </button>
    </div>
  );
}

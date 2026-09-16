// 编辑器顶栏（docs/DESIGN.md §4.1）：品牌两行（字标 + 版本号）、连体模块组（图标上文字下）、
// 右侧：保存状态 · [撤销|重做] · 主题 · 产物 · 导出（唯一的实心橙）。
// 批次名在左栏「全选」上方（HIG-14），安全区在画布下方 QuickBar（HIG-13），顶栏不再放。
// 撤销 / 重做只在这里：历史是一条栈，撤销的不只是时间线上的动作（§9.1）。
import { Link } from 'react-router-dom';
import { useEditor } from '../../store/editor';
import { STEPS, type Step } from '../../lib/steps';
import { APP_VERSION } from '../../lib/version';
import { IconCut, IconExport, IconGlobe, IconGrid, IconRedo, IconSticker, IconSubtitle, IconText, IconUndo, IconWave } from '../ui/Icons';
import { ThemeToggle } from '../ui/ThemeToggle';

const STEP_ICON: Record<Step, () => JSX.Element> = {
  trim: IconCut,
  audio: IconWave,
  text: IconText,
  sticker: IconSticker,
  subtitle: IconSubtitle,
  localize: IconGlobe,
};

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

  const saveText = { idle: '已保存', dirty: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' }[saveState];

  return (
    <div className="topbar">
      <Link to="/" className="brand2" title={`HitGO ${APP_VERSION}`}>
        <span className="wm">
          Hit<b>GO</b>
        </span>
        <span className="ver">{APP_VERSION || 'dev'}</span>
      </Link>
      <div className="modes" role="tablist">
        {STEPS.map((s) => {
          const Icon = STEP_ICON[s.key];
          return (
            <button key={s.key} role="tab" aria-selected={step === s.key} aria-label={s.label} className={`mode ${step === s.key ? 'active' : ''}`} onClick={() => setStep(s.key)}>
              <Icon />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
      <span className="spacer" />
      <span className={`save-indicator ${saveState} ${saveState === 'error' ? 'error' : ''}`} title={saveError ?? undefined}>
        <i />
        {saveText}
      </span>
      <span className="btn-group">
        <button className="btn icon" onClick={undo} disabled={!canUndo} aria-label="撤销" title="撤销（⌘Z）">
          <IconUndo />
        </button>
        <button className="btn icon" onClick={redo} disabled={!canRedo} aria-label="重做" title="重做（⇧⌘Z）">
          <IconRedo />
        </button>
      </span>
      <ThemeToggle />
      <Link to={batch ? `/outputs?batch=${encodeURIComponent(batch.id)}` : '/outputs'} className="btn">
        <IconGrid /> 产物
      </Link>
      <button className="btn primary" onClick={onExport} disabled={rendering} title="保存并导出成片：选择导出这一批、勾选的几条或仅当前这条">
        <IconExport /> {rendering ? '导出中…' : '导出'}
      </button>
    </div>
  );
}

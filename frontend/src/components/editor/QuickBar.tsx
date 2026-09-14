// 画布下方的快捷操作条：撤销 / 重做、删左 / 删右、删除、居中、安全区显示、比例、快捷键表。
// 提示文案统一走 lib/shortcuts 的 hintFor（纯 CSS tooltip：data-tip）。

import { useEditor } from '../../store/editor';
import { hintFor } from '../../lib/shortcuts';
import { anchorParts, makeAnchor, reanchor, round4 } from '../../lib/layout';
import { layerAspect } from '../../lib/spec';
import { VARIANT_DEFS, type VariantKey } from '../../types';
import { IconCenter, IconCenterH, IconCenterV, IconCutLeft, IconCutRight, IconHelp, IconRedo, IconSafeZone, IconTrash, IconUndo } from '../ui/Icons';

const REF = { W: 1080, H: 1920 };
const SAFE_VIEW_LABEL = { frames: '框线', overlay: '遮挡示意', none: '关闭' } as const;

export function QuickBar() {
  const step = useEditor((s) => s.step);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.canUndo());
  const canRedo = useEditor((s) => s.canRedo());
  const removeBefore = useEditor((s) => s.removeBefore);
  const removeAfter = useEditor((s) => s.removeAfter);
  const canRemoveBefore = useEditor((s) => s.canRemoveBefore());
  const canRemoveAfter = useEditor((s) => s.canRemoveAfter());
  const selectedRange = useEditor((s) => s.selectedRangeIndex);
  const deleteRange = useEditor((s) => s.deleteRemoveRange);
  const selectedLayerId = useEditor((s) => s.selectedLayerId);
  const layer = useEditor((s) => (s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((l) => l.id === s.selectedLayerId) ?? null : null));
  const assets = useEditor((s) => s.assets);
  const removeLayer = useEditor((s) => s.removeLayer);
  const updateLayer = useEditor((s) => s.updateLayer);
  const safeZoneView = useEditor((s) => s.safeZoneView);
  const cycleSafeZoneView = useEditor((s) => s.cycleSafeZoneView);
  const zone = useEditor((s) => s.safeZones.find((z) => z.key === s.safeZoneKey));
  const selectedVariant = useEditor((s) => s.selectedVariantKey);
  const outputs = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.outputs ?? [] : []));
  const setSelectedVariant = useEditor((s) => s.setSelectedVariant);
  const setStep = useEditor((s) => s.setStep);
  const setShortcutsOpen = useEditor((s) => s.setShortcutsOpen);

  const center = (axis: 'h' | 'v' | 'both') => {
    if (!layer || layer.locked) return;
    const aspect = layerAspect(layer, assets);
    const { ax, ay } = anchorParts(layer.anchor);
    const next = axis === 'both' ? 'center' : axis === 'h' ? makeAnchor('center', ay) : makeAnchor(ax, 'center');
    const p = reanchor(layer, aspect, REF, next);
    const margin: [number, number] = [axis === 'v' ? round4(p.margin[0]) : 0, axis === 'h' ? round4(p.margin[1]) : 0];
    updateLayer(layer.id, { anchor: next, margin });
  };

  const canDelete = step === 1 ? selectedRange !== null : step === 2 ? !!selectedLayerId : false;
  const onDelete = () => {
    if (step === 1 && selectedRange !== null) deleteRange(selectedRange);
    else if (step === 2 && selectedLayerId) removeLayer(selectedLayerId);
  };
  const layerOk = step === 2 && !!layer && !layer.locked;
  const overlayMissing = safeZoneView === 'overlay' && !zone?.overlay_url;

  return (
    <div className="quickbar">
      <button className="btn icon" onClick={undo} disabled={!canUndo} aria-label="撤销" data-tip={hintFor('undo')}>
        <IconUndo />
      </button>
      <button className="btn icon" onClick={redo} disabled={!canRedo} aria-label="重做" data-tip={hintFor('redo')}>
        <IconRedo />
      </button>
      <span className="qb-sep" />
      {step === 1 && (
        <>
          <button className="btn" onClick={removeBefore} disabled={!canRemoveBefore} data-tip={hintFor('remove-before')}>
            <IconCutLeft /> 删左
          </button>
          <button className="btn" onClick={removeAfter} disabled={!canRemoveAfter} data-tip={hintFor('remove-after')}>
            <IconCutRight /> 删右
          </button>
        </>
      )}
      {step !== 3 && (
        <button className="btn icon danger" onClick={onDelete} disabled={!canDelete} aria-label="删除" data-tip={step === 1 ? hintFor('delete-range') : hintFor('delete-layer')}>
          <IconTrash />
        </button>
      )}
      {step === 2 && (
        <>
          <span className="qb-sep" />
          <button className="btn icon" onClick={() => center('h')} disabled={!layerOk} aria-label="水平居中" data-tip={hintFor('center-h')}>
            <IconCenterH />
          </button>
          <button className="btn icon" onClick={() => center('v')} disabled={!layerOk} aria-label="垂直居中" data-tip={hintFor('center-v')}>
            <IconCenterV />
          </button>
          <button className="btn icon" onClick={() => center('both')} disabled={!layerOk} aria-label="居中" data-tip={hintFor('center')}>
            <IconCenter />
          </button>
        </>
      )}
      <span className="spacer" />
      <button
        className={`btn ${safeZoneView === 'none' ? '' : 'on'}`}
        onClick={cycleSafeZoneView}
        data-tip={`${hintFor('safe-zone-view')}：${SAFE_VIEW_LABEL[safeZoneView]}${overlayMissing ? '（该预设无示意图，显示框线）' : ''} · 点击切换`}
        aria-label="安全区显示"
      >
        <IconSafeZone mode={safeZoneView} /> {SAFE_VIEW_LABEL[safeZoneView]}
      </button>
      <label className="qb-ratio" data-tip="切换输出比例并进入输出步骤">
        <span className="muted small">比例</span>
        <select
          className="select sm"
          value={selectedVariant}
          onChange={(e) => {
            const k = e.target.value as VariantKey;
            setSelectedVariant(k);
            setStep(3);
          }}
        >
          {VARIANT_DEFS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
              {outputs.some((o) => o.variant_key === d.key) ? '' : '（未启用）'}
            </option>
          ))}
        </select>
      </label>
      <button className="btn icon" onClick={() => setShortcutsOpen(true)} aria-label="快捷键" data-tip={hintFor('shortcuts')}>
        <IconHelp />
      </button>
    </div>
  );
}

// 画布下方的快捷操作条，只放画布相关操作：居中（步骤 2）、安全区显示、画布比例、快捷键表。
// 撤销 / 重做、删左 / 删右、删除在时间线工具条（TimelineTools），顶栏也有撤销 / 重做。
// 提示文案统一走 lib/shortcuts 的 hintFor（纯 CSS tooltip：data-tip）。

import { useEditor } from '../../store/editor';
import { hintFor } from '../../lib/shortcuts';
import { alignPlacement, type AlignEdge } from '../../lib/layout';
import { layerAspect } from '../../lib/spec';
import { VARIANT_DEFS, type VariantKey } from '../../types';
import { IconCenter, IconCenterH, IconCenterV, IconHelp, IconSafeZone } from '../ui/Icons';

const REF = { W: 1080, H: 1920 };
const SAFE_VIEW_LABEL = { frames: '框线', overlay: '遮挡示意', none: '关闭' } as const;

export function QuickBar() {
  const step = useEditor((s) => s.step);
  const layer = useEditor((s) => (s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((l) => l.id === s.selectedLayerId) ?? null : null));
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const safeZoneView = useEditor((s) => s.safeZoneView);
  const cycleSafeZoneView = useEditor((s) => s.cycleSafeZoneView);
  const zone = useEditor((s) => s.safeZones.find((z) => z.key === s.safeZoneKey));
  const selectedVariant = useEditor((s) => s.selectedVariantKey);
  const outputs = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.outputs ?? [] : []));
  const setSelectedVariant = useEditor((s) => s.setSelectedVariant);
  const setShortcutsOpen = useEditor((s) => s.setShortcutsOpen);

  const center = (axis: 'h' | 'v' | 'both') => {
    if (!layer || layer.locked) return;
    const aspect = layerAspect(layer, assets);
    const edges: AlignEdge[] = axis === 'both' ? ['center-h', 'center-v'] : axis === 'h' ? ['center-h'] : ['center-v'];
    let p = { anchor: layer.anchor, margin: layer.margin, width: layer.width };
    for (const e of edges) p = alignPlacement(p, aspect, REF, e);
    updateLayer(layer.id, { anchor: p.anchor, margin: p.margin });
  };

  const layerOk = step === 2 && !!layer && !layer.locked;
  const overlayMissing = safeZoneView === 'overlay' && !zone?.overlay_url;

  return (
    <div className="quickbar">
      {step === 2 && (
        <>
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
      <label className="qb-ratio" data-tip="切换编辑画布的比例（9:16 为基准，其他比例上的拖动写入该变体的 layer_overrides）">
        <span className="muted small">画布</span>
        <select className="select sm" value={selectedVariant} onChange={(e) => setSelectedVariant(e.target.value as VariantKey)}>
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

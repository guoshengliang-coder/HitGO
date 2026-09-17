// 画布下方的快捷操作条，只放画布相关操作：居中（文本 / 贴纸 / 字幕模块）、安全区、快捷键表。
// 画布比例由剪辑模块「成片画面」的画幅页签决定（HIG-29）；预览非 9:16 时居中只改该画幅（写覆盖），安全区不可用。
// 安全区只在这里设置（HIG-13）：按钮是开关，开启时才在旁边展开预设与显示方式，关闭时全部收起。
// 撤销 / 重做、删左 / 删右、删除在时间线工具条（TimelineTools），顶栏也有撤销 / 重做。
// 提示文案统一走 lib/shortcuts 的 hintFor（纯 CSS tooltip：data-tip）。

import { useEditor, type SafeZoneMode } from '../../store/editor';
import { hintFor } from '../../lib/shortcuts';
import { alignPlacement, placeLayer, type AlignEdge } from '../../lib/layout';
import { placementOfBox } from '../../lib/variantLayout';
import { layerAspect, outputFor } from '../../lib/spec';
import { layerTypeForStep } from '../../lib/steps';
import { IconCenter, IconCenterH, IconCenterV, IconHelp, IconSafeZone } from '../ui/Icons';

const REF = { W: 1080, H: 1920 };
const SAFE_MODES: { v: SafeZoneMode; label: string; tip: string }[] = [
  { v: 'frames', label: '框线', tip: '显示遮挡区框线与安全框' },
  { v: 'overlay', label: '遮挡示意', tip: '叠加平台界面示意图（无示意图的预设退回框线）' },
];

export function QuickBar() {
  const step = useEditor((s) => s.step);
  const layer = useEditor((s) => (s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((l) => l.id === s.selectedLayerId) ?? null : null));
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const safeZoneView = useEditor((s) => s.safeZoneView);
  const setSafeZoneView = useEditor((s) => s.setSafeZoneView);
  const toggleSafeZone = useEditor((s) => s.toggleSafeZone);
  const safeZones = useEditor((s) => s.safeZones);
  const safeZoneKey = useEditor((s) => s.safeZoneKey);
  const setSafeZoneKey = useEditor((s) => s.setSafeZoneKey);
  const setShortcutsOpen = useEditor((s) => s.setShortcutsOpen);
  const previewKey = useEditor((s) => s.previewVariantKey);
  const spec = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId] : null));
  const editLayerOnPreview = useEditor((s) => s.editLayerOnPreview);
  const isRef = previewKey === '9x16';

  const center = (axis: 'h' | 'v' | 'both') => {
    if (!layer || layer.locked) return;
    const aspect = layerAspect(layer, assets);
    const edges: AlignEdge[] = axis === 'both' ? ['center-h', 'center-v'] : axis === 'h' ? ['center-h'] : ['center-v'];
    const onVariant = editLayerOnPreview(layer.id, ({ box, anchor }) => {
      const { placement, aspect: a, canvas } = placementOfBox(box, anchor, previewKey, spec ? outputFor(spec, previewKey) : undefined);
      let q = placement;
      for (const e of edges) q = alignPlacement(q, a, canvas, e);
      return { box: placeLayer(q, a, canvas), anchor: q.anchor };
    });
    if (onVariant) return;
    let p = { anchor: layer.anchor, margin: layer.margin, width: layer.width };
    for (const e of edges) p = alignPlacement(p, aspect, REF, e);
    updateLayer(layer.id, { anchor: p.anchor, margin: p.margin });
  };

  const layerStep = !!layerTypeForStep(step);
  const layerOk = layerStep && !!layer && !layer.locked;
  const safeOn = safeZoneView !== 'none';
  const zone = safeZones.find((z) => z.key === safeZoneKey);
  const overlayMissing = safeZoneView === 'overlay' && !zone?.overlay_url;

  return (
    <div className="quickbar">
      {layerStep && (
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
        className={`btn ${safeOn && isRef ? 'on' : ''}`}
        onClick={toggleSafeZone}
        disabled={!isRef}
        aria-pressed={safeOn}
        data-tip={isRef ? `${hintFor('safe-zone-view')}：${safeOn ? '已开启 · 点击关闭' : '已关闭 · 点击开启'}` : '安全区按竖版平台定义，只在预览 9:16 时显示'}
      >
        <IconSafeZone mode={safeZoneView} /> 安全区
      </button>
      {safeOn && isRef && (
        <>
          <select className="select sm" value={safeZoneKey} onChange={(e) => setSafeZoneKey(e.target.value)} aria-label="安全区预设">
            {safeZones.map((z) => (
              <option key={z.key} value={z.key}>
                {z.name}
              </option>
            ))}
          </select>
          <span className="seg" role="radiogroup" aria-label="安全区显示方式">
            {SAFE_MODES.map((o) => (
              <button key={o.v} role="radio" aria-checked={safeZoneView === o.v} className={`seg-btn ${safeZoneView === o.v ? 'active' : ''}`} title={o.tip} onClick={() => setSafeZoneView(o.v)}>
                {o.label}
              </button>
            ))}
          </span>
          {overlayMissing && <span className="muted small">该预设无示意图，显示框线</span>}
        </>
      )}
      <button className="btn icon" onClick={() => setShortcutsOpen(true)} aria-label="快捷键" data-tip={hintFor('shortcuts')}>
        <IconHelp />
      </button>
    </div>
  );
}

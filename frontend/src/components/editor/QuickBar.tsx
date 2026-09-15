// 画布下方的快捷操作条，只放画布相关操作：居中（文本 / 贴纸模块）、安全区显示、快捷键表。
// 画布固定 9:16（HIG-8 起编辑器只产出一个 9:16 输出），不再提供比例切换。
// 撤销 / 重做、删左 / 删右、删除在时间线工具条（TimelineTools），顶栏也有撤销 / 重做。
// 提示文案统一走 lib/shortcuts 的 hintFor（纯 CSS tooltip：data-tip）。

import { useEditor } from '../../store/editor';
import { hintFor } from '../../lib/shortcuts';
import { alignPlacement, type AlignEdge } from '../../lib/layout';
import { layerAspect } from '../../lib/spec';
import { layerTypeForStep } from '../../lib/steps';
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
  const setShortcutsOpen = useEditor((s) => s.setShortcutsOpen);

  const center = (axis: 'h' | 'v' | 'both') => {
    if (!layer || layer.locked) return;
    const aspect = layerAspect(layer, assets);
    const edges: AlignEdge[] = axis === 'both' ? ['center-h', 'center-v'] : axis === 'h' ? ['center-h'] : ['center-v'];
    let p = { anchor: layer.anchor, margin: layer.margin, width: layer.width };
    for (const e of edges) p = alignPlacement(p, aspect, REF, e);
    updateLayer(layer.id, { anchor: p.anchor, margin: p.margin });
  };

  const layerStep = !!layerTypeForStep(step);
  const layerOk = layerStep && !!layer && !layer.locked;
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
        className={`btn ${safeZoneView === 'none' ? '' : 'on'}`}
        onClick={cycleSafeZoneView}
        data-tip={`${hintFor('safe-zone-view')}：${SAFE_VIEW_LABEL[safeZoneView]}${overlayMissing ? '（该预设无示意图，显示框线）' : ''} · 点击切换`}
        aria-label="安全区显示"
      >
        <IconSafeZone mode={safeZoneView} /> {SAFE_VIEW_LABEL[safeZoneView]}
      </button>
      <button className="btn icon" onClick={() => setShortcutsOpen(true)} aria-label="快捷键" data-tip={hintFor('shortcuts')}>
        <IconHelp />
      </button>
    </div>
  );
}

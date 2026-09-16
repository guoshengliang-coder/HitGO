// 「贴纸」模块右侧面板（HIG-8）：图层 / 原料库 / 我上传的 三个 tab，素材再按图片 / 视频筛选。
// 只管贴纸图层；分类只用素材已有的 source 与 kind，不改契约。

import { useMemo, useState } from 'react';
import { useEditor } from '../../store/editor';
import { isAssetReady, isVideoAsset, type StickerLayer } from '../../types';
import { newLayerId } from '../../lib/spec';
import { filterAssets, type AssetBucket, type StickerKindFilter } from '../../lib/assets';
import { AssetCard } from '../../pages/AssetsPage';
import { IconSticker } from '../ui/Icons';
import { LayerList, LayerProps } from './LayerParts';

type StickerTab = 'layers' | AssetBucket;

const TABS: { key: StickerTab; label: string }[] = [
  { key: 'layers', label: '图层' },
  { key: 'library', label: '原料库' },
  { key: 'mine', label: '我上传的' },
];

const KINDS: { key: StickerKindFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
];

export function StickerPanel() {
  const [tab, setTab] = useState<StickerTab>('layers');
  const [kind, setKind] = useState<StickerKindFilter>('all');
  const [q, setQ] = useState('');
  const assets = useEditor((s) => s.assets);
  const selected = useEditor((s) => {
    const l = s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : undefined;
    return l?.type === 'sticker' ? l : null;
  });
  const addLayer = useEditor((s) => s.addLayer);
  const stickers = useMemo(() => (tab === 'layers' ? [] : filterAssets(assets, { type: 'sticker', bucket: tab, kind, q })), [assets, tab, kind, q]);

  const addSticker = (assetId: string) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!isAssetReady(asset)) return; // 还在预处理：加进去也渲染不出来
    const l: StickerLayer = { id: newLayerId(), type: 'sticker', asset_id: assetId, anchor: 'top-left', margin: [0.08, 0.12], width: 0.35, rotate: 0, opacity: 1, t: 'all' };
    if (isVideoAsset(asset)) l.playback = 'loop';
    addLayer(l);
    setTab('layers');
  };

  return (
    <div className="panel">
      <div className="tabs" role="tablist" style={{ padding: '0 8px' }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'layers' ? (
        <div className="panel-body">
          <div className="inline">
            <button className="btn" onClick={() => setTab('library')}>
              <IconSticker /> 添加贴纸
            </button>
          </div>
          <LayerList type="sticker" emptyHint="还没有贴纸。去「原料库」或「我上传的」里点选添加，加入后可在画布上拖动、缩放、旋转。" />
          {selected && <LayerProps key={selected.id} layer={selected} />}
        </div>
      ) : (
        <div className="panel-body">
          <div className="inline">
            <span className="chips" role="radiogroup" aria-label="素材形态">
              {KINDS.map((k) => (
                <button key={k.key} role="radio" aria-checked={kind === k.key} className={`chip ${kind === k.key ? 'active' : ''}`} onClick={() => setKind(k.key)}>
                  {k.label}
                </button>
              ))}
            </span>
            <input className="input sm" placeholder="搜索贴纸…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          </div>
          {stickers.length === 0 ? (
            <div className="empty small">
              {q || kind !== 'all'
                ? '没有匹配的贴纸。'
                : tab === 'library'
                  ? '原料库为空 · 把文件放进仓库的 samples/stickers 作为内置示例，正式环境接原料库 API'
                  : '还没有贴纸，去「素材库」上传。'}
            </div>
          ) : (
            <div className="sticker-grid">
              {stickers.map((a) => (
                <AssetCard key={a.id} asset={a} onPick={() => addSticker(a.id)} />
              ))}
            </div>
          )}
          <div className="hint">点击贴纸即添加为图层（宽 35%，左上锚点，边距 8% / 12%，全程显示）。视频贴纸默认循环播放，可在属性里改。</div>
        </div>
      )}
    </div>
  );
}

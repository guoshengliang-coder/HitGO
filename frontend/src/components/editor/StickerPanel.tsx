// 「贴纸」模块右侧面板（HIG-8）：图层 / 原料库 / 我上传的 三个 tab，素材再按图片 / 视频筛选。
// 只管贴纸图层；分类只用素材已有的 source 与 kind，不改契约。
// HIG-46：面板整体可拖入 JPG / PNG，也可点「上传图片」选文件，上传后直接加为图层；素材卡片可拖到画布 / 时间线上。

import { useMemo, useRef, useState } from 'react';
import { useEditor } from '../../store/editor';
import { isAssetReady, type Asset } from '../../types';
import { newLayerId } from '../../lib/spec';
import { defaultMargin, IMAGE_ACCEPT, IMAGE_ACCEPT_TEXT, newStickerLayer } from '../../lib/imageDrop';
import { rejectedText } from '../../lib/fileDrop';
import { DropZone } from '../ui/DropZone';
import { dropImages } from './stickerDrop';
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
  const setToast = useEditor((s) => s.setToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const stickers = useMemo(() => (tab === 'layers' ? [] : filterAssets(assets, { type: 'sticker', bucket: tab, kind, q })), [assets, tab, kind, q]);

  const addSticker = (assetId: string) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!isAssetReady(asset)) return; // 还在预处理：加进去也渲染不出来
    if (!asset) return;
    addLayer(newStickerLayer(newLayerId(), asset));
    setTab('layers');
  };

  // 拖入或选择的图片：上传后按面板默认位置依次错开加图层
  const addImages = (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    void dropImages(files, (_a: Asset, i: number) => ({ margin: defaultMargin(i) })).finally(() => {
      setUploading(false);
      setTab('layers');
    });
  };

  return (
    <DropZone
      className="panel"
      accept={IMAGE_ACCEPT}
      disabled={uploading}
      hint="松手添加为贴纸（JPG / PNG）"
      onFiles={(accepted, rejected) => {
        // 有可收的图片时，跳过提示会被上传进度盖掉，所以一并交给上传（uploadImages 会带上跳过的文件名）
        if (!accepted.length) {
          const skipped = rejectedText(rejected, IMAGE_ACCEPT_TEXT);
          if (skipped) setToast(skipped);
          return;
        }
        addImages([...accepted, ...rejected]);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          addImages(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
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
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading} title="选择 JPG / PNG，上传后直接加为贴纸；也可以把图片拖进这里、画布或时间线">
              {uploading ? '上传中…' : '上传图片'}
            </button>
          </div>
          <LayerList type="sticker" emptyHint="还没有贴纸。去「原料库」或「我上传的」里点选添加，或把 JPG / PNG 拖进来；加入后可在画布上拖动、缩放、旋转。" />
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
                  : '还没有贴纸：把 JPG / PNG 拖进来、点「图层」页的「上传图片」，或去「素材库」上传。'}
            </div>
          ) : (
            <div className="sticker-grid">
              {stickers.map((a) => (
                <AssetCard key={a.id} asset={a} onPick={() => addSticker(a.id)} draggable />
              ))}
            </div>
          )}
          <div className="hint">点击贴纸即添加为图层（宽 35%，左上锚点，边距 8% / 12%，全程显示）；也可以把卡片拖到画布或时间线上指定位置 / 起点。视频贴纸默认循环播放，可在属性里改。</div>
        </div>
      )}
    </DropZone>
  );
}

// 「贴纸」模块右侧面板（HIG-8）：图层 / 原料库 / 我上传的 三个 tab，素材再按图片 / 视频筛选。
// 只管贴纸图层；分类只用素材已有的 source 与 kind，不改契约。
// HIG-46 / HIG-67：面板整体可拖入图片或视频，也可点「上传素材」选文件，上传后直接加为图层；素材卡片可拖到画布 / 时间线上。
// 视频素材上传后要先预处理，就绪才加图层（stickerDrop.settleAssets）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../../store/editor';
import { isAssetReady, isVideoAsset, type Asset, type ShapeLayer } from '../../types';
import { newLayerId } from '../../lib/spec';
import { defaultMargin, newStickerLayer, OVERLAY_ACCEPT, OVERLAY_ACCEPT_TEXT } from '../../lib/imageDrop';
import { rejectedText } from '../../lib/fileDrop';
import { DropZone } from '../ui/DropZone';
import { dropOverlays } from './stickerDrop';
import { filterAssets, type AssetBucket } from '../../lib/assets';
import { AssetCard } from '../../pages/AssetsPage';
import { IconSticker } from '../ui/Icons';
import { Section } from '../ui/Section';
import { LayerList, LayerProps } from './LayerParts';

type StickerTab = 'layers' | AssetBucket;
const SHAPES: { key: ShapeLayer['shape']; label: string }[] = [
  { key: 'rect', label: '矩形' }, { key: 'ellipse', label: '圆形' },
  { key: 'triangle', label: '三角形' }, { key: 'line', label: '直线' },
  { key: 'arrow', label: '箭头' }, { key: 'star', label: '星形' },
];

const TABS: { key: StickerTab; label: string }[] = [
  { key: 'layers', label: '图层' },
  { key: 'library', label: '原料库' },
  { key: 'mine', label: '我上传的' },
];

/** 素材按形态分两组（HIG-67）：图片走「贴纸」，视频走「叠加素材」，各自一个可折叠分组。 */
const GROUPS: { key: 'image' | 'video'; label: string; help: string }[] = [
  { key: 'image', label: '贴纸', help: 'JPG / PNG / WEBP / GIF' },
  { key: 'video', label: '叠加素材', help: 'MP4 / MOV / WEBM · 可裁剪' },
];

export function StickerPanel() {
  const [tab, setTab] = useState<StickerTab>('layers');
  const [q, setQ] = useState('');
  const assets = useEditor((s) => s.assets);
  const selected = useEditor((s) => {
    const l = s.currentVideoId && s.selectedLayerId ? s.specs[s.currentVideoId]?.layers.find((x) => x.id === s.selectedLayerId) : undefined;
    return l?.type === 'sticker' || l?.type === 'shape' ? l : null;
  });
  const drawingShape = useEditor((s) => s.drawingShape);
  const setDrawingShape = useEditor((s) => s.setDrawingShape);
  const updateSelectedShapeStyle = useEditor((s) => s.updateSelectedShapeStyle);
  const layerFocusVersion = useEditor((s) => s.layerFocusVersion);
  useEffect(() => {
    if (selected) setTab('layers');
  }, [layerFocusVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const addLayer = useEditor((s) => s.addLayer);
  const setToast = useEditor((s) => s.setToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const replacingLayerId = useEditor((s) => s.replacingLayerId);
  const setReplacingLayer = useEditor((s) => s.setReplacingLayer);
  const replaceLayerAsset = useEditor((s) => s.replaceLayerAsset);
  const stickers = useMemo(() => (tab === 'layers' ? [] : filterAssets(assets, { type: 'sticker', bucket: tab, kind: 'all', q })), [assets, tab, q]);

  // 点了「替换素材」就把面板翻到素材页，省得用户自己找（HIG-67）
  useEffect(() => {
    if (replacingLayerId && tab === 'layers') setTab('mine');
  }, [replacingLayerId, tab]);

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
    void dropOverlays(files, (_a: Asset, i: number) => ({ margin: defaultMargin(i) })).finally(() => {
      setUploading(false);
      setTab('layers');
    });
  };

  return (
    <DropZone
      className="panel"
      accept={OVERLAY_ACCEPT}
      disabled={uploading}
      hint="松手添加为叠加素材（图片 / 视频）"
      onFiles={(accepted, rejected) => {
        // 有可收的素材时，跳过提示会被上传进度盖掉，所以一并交给上传（uploadOverlays 会带上跳过的文件名）
        if (!accepted.length) {
          const skipped = rejectedText(rejected, OVERLAY_ACCEPT_TEXT);
          if (skipped) setToast(skipped);
          return;
        }
        addImages([...accepted, ...rejected]);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept={OVERLAY_ACCEPT}
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
          <div className="inline panel-add-row">
            <button className="btn action" onClick={() => setTab('library')}>
              <IconSticker /> 添加贴纸
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading} title="选择图片或视频，上传后直接加为图层；也可以把文件拖进这里、画布或时间线">
              {uploading ? '上传中…' : '上传素材'}
            </button>
          </div>
          <LayerList type="sticker" emptyHint="还没有叠加素材。去「原料库」或「我上传的」里点选添加，或把图片 / 视频拖进来；加入后可在画布上拖动、缩放、旋转。" />
          <div className="section">
            <div className="section-title">绘制图形</div>
            <div className="inline" style={{ flexWrap: 'wrap' }}>
              {SHAPES.map((s) => <button key={s.key} type="button" className={`btn sm ${drawingShape === s.key ? 'primary' : ''}`} onClick={() => setDrawingShape(drawingShape === s.key ? null : s.key)}>{s.label}</button>)}
            </div>
            <div className="hint">选一种图形，在预览画布按住鼠标拖动画出；再次点击工具退出绘制。</div>
          </div>
          <LayerList type="shape" emptyHint="还没有图形。选择上方工具并在预览画布拖动。" />
          {selected?.type === 'shape' && <div className="section">
            <div className="section-title">图形外观</div>
            <div className="stack">
              <label className="field">形状
                <select className="input" value={selected.shape} onChange={(e) => updateSelectedShapeStyle({ shape: e.target.value as ShapeLayer['shape'] })}>{SHAPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
              </label>
              {selected.shape !== 'line' && selected.shape !== 'arrow' && <label className="field">填充颜色 <input type="color" value={selected.fill} onChange={(e) => updateSelectedShapeStyle({ fill: e.target.value })} /></label>}
              <label className="field">描边颜色 <input type="color" value={selected.stroke} onChange={(e) => updateSelectedShapeStyle({ stroke: e.target.value })} /></label>
              <label className="field">描边粗细 <input className="input" type="number" min="0" max="0.1" step="0.001" value={selected.stroke_width} onChange={(e) => updateSelectedShapeStyle({ stroke_width: Number(e.target.value) })} /></label>
              {selected.shape === 'rect' && <label className="field">圆角 <input className="input" type="number" min="0" max="0.5" step="0.01" value={selected.radius} onChange={(e) => updateSelectedShapeStyle({ radius: Number(e.target.value) })} /></label>}
            </div>
          </div>}
          {selected && <LayerProps key={selected.id} layer={selected} />}
        </div>
      ) : (
        <div className="panel-body">
          {replacingLayerId && (
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <span className="hint" style={{ margin: 0 }}>点一个素材完成替换，图层的位置、时段与属性都保留。</span>
              <button className="btn ghost sm" onClick={() => setReplacingLayer(null)}>取消</button>
            </div>
          )}
          <div className="inline">
            <input className="input sm" placeholder="搜索素材…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          </div>
          {stickers.length === 0 ? (
            <div className="empty small">
              {q
                ? '没有匹配的素材。'
                : tab === 'library'
                  ? '原料库为空 · 把文件放进仓库的 samples/stickers 作为内置示例，正式环境接原料库 API'
                  : '还没有素材：把图片 / 视频拖进来、点「图层」页的「上传素材」，或去「素材库」上传。'}
            </div>
          ) : (
            <>
              {GROUPS.map((g) => {
                const items = stickers.filter((a) => (g.key === 'video') === isVideoAsset(a));
                if (!items.length) return null;
                return (
                  <Section key={g.key} id={`sticker.${g.key}`} title={g.label} help={g.help} bodyClass="stack">
                    <div className="sticker-grid">
                      {items.map((a) => (
                        <AssetCard
                          key={a.id}
                          asset={a}
                          onPick={() => (replacingLayerId ? replaceLayerAsset(replacingLayerId, a.id) : addSticker(a.id))}
                          draggable
                        />
                      ))}
                    </div>
                  </Section>
                );
              })}
            </>
          )}
          <div className="hint">点击素材即添加为图层（宽 35%，左上锚点，边距 8% / 12%，全程显示）；也可以把卡片拖到画布或时间线上指定位置 / 起点。叠加素材默认循环播放，入点 / 出点和播放方式在选中后的属性里改。</div>
        </div>
      )}
    </DropZone>
  );
}

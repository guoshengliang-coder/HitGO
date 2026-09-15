import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { isVideoAsset, type Asset, type AssetType } from '../types';
import { acceptFor, canDelete, filterAssets, type AssetBucket } from '../lib/assets';
import { ensureFontLoaded } from '../lib/fonts';
import { IconTrash } from '../components/ui/Icons';

export function AssetCard({ asset, onDelete, onPick }: { asset: Asset; onDelete?: () => void; onPick?: () => void }) {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    if (asset.type === 'font') void ensureFontLoaded(asset).then(() => setFontReady(true));
  }, [asset]);
  const video = isVideoAsset(asset);
  const status = asset.status ?? 'ready';
  return (
    <div className={`asset-card ${onPick ? 'pick' : ''}`} onClick={onPick} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined} onKeyDown={(e) => onPick && e.key === 'Enter' && onPick()}>
      {asset.type === 'sticker' ? (
        <div className="thumb checker">
          {!video ? (
            <img src={asset.url} alt={asset.name} />
          ) : status === 'ready' ? (
            // 就绪后直接播预览代理当缩略图；poster 只作首帧占位（可能没有）
            <video
              src={asset.preview_url ?? asset.url}
              poster={asset.poster_url ?? undefined}
              muted
              loop
              autoPlay
              playsInline
              aria-label={asset.name}
            />
          ) : (
            <div className="asset-state small muted">{status === 'failed' ? '处理失败' : '处理中…'}</div>
          )}
          {video && status === 'ready' && (
            <div className="asset-badges">
              {asset.duration ? <span className="badge">{asset.duration.toFixed(1)}s</span> : null}
              {asset.has_alpha === false && <span className="badge" title="素材没有透明通道，会以不透明矩形叠加">不透明</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="thumb">
          <div className="font-preview" style={{ fontFamily: fontReady ? `"${asset.family}", "Noto Sans SC", sans-serif` : undefined }}>
            字体预览 Aa 汉字
          </div>
        </div>
      )}
      <div className="cap">
        <span title={status === 'failed' && asset.error ? asset.error : asset.name}>{asset.name}</span>
        {onDelete && (
          <button className="btn ghost icon sm danger" aria-label="删除素材" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <IconTrash />
          </button>
        )}
      </div>
    </div>
  );
}

export function AssetsPage() {
  const [tab, setTab] = useState<AssetType>('sticker');
  const [bucket, setBucket] = useState<AssetBucket>('mine');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const load = useCallback(async (type: AssetType) => {
    try {
      setAssets(await api.listAssets(type));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  // 视频贴纸是异步预处理的，preparing 期间轮询到 ready / failed 为止
  useEffect(() => {
    const pending = assets.filter((a) => (a.status ?? 'ready') === 'preparing');
    if (!pending.length) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      const updated = await Promise.all(
        pending.map((a) => api.getAsset(a.id).catch(() => null)),
      );
      if (!alive) return;
      const byId = new Map(updated.filter(Boolean).map((a) => [a!.id, a!]));
      if (byId.size) setAssets((prev) => prev.map((a) => byId.get(a.id) ?? a));
    }, 1500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [assets]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setProgress(0);
    try {
      await api.uploadAssets(tab, files, setProgress);
      await load(tab);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const remove = async (a: Asset) => {
    if (!window.confirm(`删除素材「${a.name}」？`)) return;
    try {
      await api.deleteAsset(a.id);
      await load(tab);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const accept = acceptFor(tab);
  const shown = filterAssets(assets, { bucket });
  const kind = tab === 'sticker' ? '贴纸' : '字体';
  const emptyText =
    bucket === 'library'
      ? `原料库还没有${kind}。把文件放进仓库的 samples/${tab === 'sticker' ? 'stickers' : 'fonts'} 目录后重启后端即可导入；正式环境会换成公司物料库。`
      : tab === 'sticker'
        ? '还没有贴纸。支持 png / webp / gif 与 mp4 / mov / webm；图片单个不超过 10 MiB，视频贴纸不超过 50 MiB、60 秒。'
        : '还没有字体。支持 ttf / otf / woff2，单个不超过 20 MiB；字体名取文件名。';

  return (
    <div className="page">
      <div className="page-head">
        <h1>素材库</h1>
        <label className="btn primary" style={{ cursor: 'pointer' }}>
          {progress !== null ? `上传中 ${Math.round(progress * 100)}%` : tab === 'sticker' ? '上传贴纸' : '上传字体'}
          <input type="file" multiple accept={accept} className="sr-only" disabled={progress !== null} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </label>
      </div>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={`tab ${tab === 'sticker' ? 'active' : ''}`} onClick={() => setTab('sticker')}>贴纸</button>
        <button className={`tab ${tab === 'font' ? 'active' : ''}`} onClick={() => setTab('font')}>字体</button>
      </div>
      {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={`chip ${bucket === 'mine' ? 'active' : ''}`} onClick={() => setBucket('mine')}>我上传的</button>
        <button className={`chip ${bucket === 'library' ? 'active' : ''}`} onClick={() => setBucket('library')}>原料库</button>
      </div>
      {shown.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <div className="asset-grid">
          {shown.map((a) => (
            <AssetCard key={a.id} asset={a} onDelete={canDelete(a) ? () => void remove(a) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

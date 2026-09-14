import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Asset, AssetType } from '../types';
import { ensureFontLoaded } from '../lib/fonts';
import { IconTrash } from '../components/ui/Icons';

export function AssetCard({ asset, onDelete, onPick }: { asset: Asset; onDelete?: () => void; onPick?: () => void }) {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    if (asset.type === 'font') void ensureFontLoaded(asset).then(() => setFontReady(true));
  }, [asset]);
  return (
    <div className={`asset-card ${onPick ? 'pick' : ''}`} onClick={onPick} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined} onKeyDown={(e) => onPick && e.key === 'Enter' && onPick()}>
      {asset.type === 'sticker' ? (
        <div className="thumb checker">
          <img src={asset.url} alt={asset.name} />
        </div>
      ) : (
        <div className="thumb">
          <div className="font-preview" style={{ fontFamily: fontReady ? `"${asset.family}", "Noto Sans SC", sans-serif` : undefined }}>
            字体预览 Aa 汉字
          </div>
        </div>
      )}
      <div className="cap">
        <span title={asset.name}>{asset.name}</span>
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

  const accept = tab === 'sticker' ? 'image/png,image/webp,image/gif,.png,.webp,.gif' : '.ttf,.otf,.woff2,font/ttf,font/otf,font/woff2';

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
      {assets.length === 0 ? (
        <div className="empty">{tab === 'sticker' ? '还没有贴纸。支持 png / webp / 静态 gif。' : '还没有字体。支持 ttf / otf / woff2；字体名取文件名。'}</div>
      ) : (
        <div className="asset-grid">
          {assets.map((a) => (
            <AssetCard key={a.id} asset={a} onDelete={() => void remove(a)} />
          ))}
        </div>
      )}
    </div>
  );
}

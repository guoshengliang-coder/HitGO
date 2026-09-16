import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { isAudioAsset, isVideoAsset, type Asset, type AssetType } from '../types';
import { BUCKET_LABEL, canDelete, filterAssets, stemLabel, stemTitle, type AssetBucket } from '../lib/assets';
import { ensureFontLoaded } from '../lib/fonts';
import { IconTrash } from '../components/ui/Icons';
import { DropZone } from '../components/ui/DropZone';
import { rejectedText } from '../lib/fileDrop';

/** 音频素材的 accept 与空态文案；剪辑步骤的音轨选择器也用。 */
/** 贴纸 / 封面素材可上传的格式（契约 §3）；jpg 没有透明通道，主要给封面用（HIG-9）。 */
export const STICKER_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm';
export const AUDIO_ACCEPT = 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,.mp3,.wav,.m4a';
export const AUDIO_EMPTY_TEXT = '还没有音频。支持 mp3 / wav / m4a，单个不超过 50 MiB；上传后在「剪辑」步骤里加为 BGM 或口播。';

export function AssetCard({ asset, onDelete, onPick }: { asset: Asset; onDelete?: () => void; onPick?: () => void }) {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    if (asset.type === 'font') void ensureFontLoaded(asset).then(() => setFontReady(true));
  }, [asset]);
  const video = isVideoAsset(asset);
  const status = asset.status ?? 'ready';
  return (
    <div className={`asset-card ${onPick ? 'pick' : ''}`} onClick={onPick} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined} onKeyDown={(e) => onPick && e.key === 'Enter' && onPick()}>
      {isAudioAsset(asset) ? (
        <div className="thumb audio">
          {status === 'ready' ? (
            // 原文件浏览器就能播；点播放器不算"选中"这张卡
            <audio src={asset.url} controls preload="none" aria-label={asset.name} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} />
          ) : (
            <div className="asset-state small muted">{status === 'failed' ? '处理失败' : '处理中…'}</div>
          )}
          {status === 'ready' && asset.duration ? (
            <div className="asset-badges">
              <span className="badge">{asset.duration.toFixed(1)}s</span>
              {asset.derived_from && <span className="badge" title={stemTitle(asset.derived_from)}>{stemLabel(asset.derived_from)}</span>}
            </div>
          ) : null}
        </div>
      ) : asset.type === 'sticker' ? (
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

  // 视频贴纸是异步预处理的，preparing 期间轮询到 ready / failed 为止。
  // 这一轮全部请求失败（断网等）时 assets 不会变，effect 不会再跑：用 retry 计数强制排下一轮，
  // 否则卡片会一直停在「处理中…」直到刷新页面（HIG-24 顺带修）
  const [retry, setRetry] = useState(0);
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
      else setRetry((n) => n + 1);
    }, 1500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [assets, retry]);

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

  const accept =
    tab === 'sticker'
      ? STICKER_ACCEPT
      : tab === 'audio'
        ? AUDIO_ACCEPT
        : '.ttf,.otf,.woff2,font/ttf,font/otf,font/woff2';
  const shown = filterAssets(assets, { bucket });
  const kind = tab === 'sticker' ? '贴纸' : tab === 'audio' ? '音频' : '字体';
  const emptyText =
    bucket === 'derived'
      ? '还没有分离结果。在编辑器的「音频」模块里对某条视频点「分离人声 / 伴奏」，产出的人声轨和伴奏轨会出现在这里，可用于任何视频。'
      : bucket === 'library'
      ? `原料库还没有${kind}。把文件放进仓库的 samples/${tab === 'sticker' ? 'stickers' : tab === 'audio' ? 'audio' : 'fonts'} 目录后重启后端即可导入；正式环境会换成公司物料库。`
      : tab === 'sticker'
        ? '还没有贴纸。支持 png / jpg / webp / gif 与 mp4 / mov / webm；图片单个不超过 10 MiB，视频贴纸不超过 50 MiB、60 秒。'
        : tab === 'audio'
          ? AUDIO_EMPTY_TEXT
          : '还没有字体。支持 ttf / otf / woff2，单个不超过 20 MiB；字体名取文件名。';

  return (
    <DropZone
      className="page"
      accept={accept}
      disabled={progress !== null}
      hint={`松手上传${kind}`}
      onFiles={(accepted, rejected) => {
        const skipped = rejectedText(rejected, tab === 'sticker' ? 'png / jpg / webp / gif / mp4 / mov / webm' : tab === 'audio' ? 'mp3 / wav / m4a' : 'ttf / otf / woff2');
        if (accepted.length) void upload(accepted).then(() => skipped && setError((prev) => (prev ? `${prev}；${skipped}` : skipped)));
        else setError(skipped);
      }}
    >
      <div className="page-head">
        <h1>素材库</h1>
        <label className="btn primary" style={{ cursor: 'pointer' }}>
          {progress !== null ? `上传中 ${Math.round(progress * 100)}%` : `上传${kind}`}
          <input type="file" multiple accept={accept} className="sr-only" disabled={progress !== null} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </label>
      </div>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={`tab ${tab === 'sticker' ? 'active' : ''}`} onClick={() => setTab('sticker')}>贴纸</button>
        <button className={`tab ${tab === 'font' ? 'active' : ''}`} onClick={() => setTab('font')}>字体</button>
        <button className={`tab ${tab === 'audio' ? 'active' : ''}`} onClick={() => setTab('audio')}>音频</button>
      </div>
      {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="chips" style={{ marginBottom: 12 }}>
        {(['mine', 'library', ...(tab === 'audio' ? (['derived'] as AssetBucket[]) : [])] as AssetBucket[]).map((b) => (
          <button key={b} className={`chip ${bucket === b ? 'active' : ''}`} onClick={() => setBucket(b)}>{BUCKET_LABEL[b]}</button>
        ))}
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
    </DropZone>
  );
}

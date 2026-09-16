// 剪辑模块里的「封面」分组（HIG-9，契约 §2 cover）：在成片最前面插一张图片或一段视频。
// 素材来自贴纸库（图片 / 视频），也可以在选择框里直接上传（jpg 也行）。
// 图片封面可调停留时长；视频封面整段播放、保留原声。封面期间不叠图层、不放 BGM，图层与音轨的时间仍从正片算起。

import { useMemo, useState } from 'react';
import { useCoverDuration, useEditor } from '../../store/editor';
import { api } from '../../api';
import { player } from '../../lib/player';
import { filterAssets, type AssetBucket, type StickerKindFilter } from '../../lib/assets';
import { COVER_MAX_DURATION, COVER_MIN_DURATION, clampCoverDuration } from '../../lib/cover';
import { formatSeconds } from '../../lib/time';
import { AssetCard, STICKER_ACCEPT } from '../../pages/AssetsPage';
import { Modal } from '../ui/Modal';
import { Num } from '../ui/Num';
import { Section } from '../ui/Section';
import { coverSummary } from '../../lib/trimSummary';
import { isAssetReady, isVideoAsset } from '../../types';

const COVER_HELP = '在成片最前面插入一张图片或一段视频。封面期间不叠文字 / 贴纸、不放 BGM，图层与音轨的时间仍从正片第一帧开始算。图片封面可调停留时长，视频封面整段播放并保留原声。';

const KINDS: { key: StickerKindFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
];

/** 选封面素材：原料库 / 我上传的，图片 / 视频筛选，可直接上传。还在预处理的视频要等它就绪。 */
function CoverPicker({ onPick, onClose }: { onPick: (assetId: string) => void; onClose: () => void }) {
  const assets = useEditor((s) => s.assets);
  const loadAssets = useEditor((s) => s.loadAssets);
  const [bucket, setBucket] = useState<AssetBucket>('mine');
  const [kind, setKind] = useState<StickerKindFilter>('all');
  const [q, setQ] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(() => filterAssets(assets, { type: 'sticker', bucket, kind, q }), [assets, bucket, kind, q]);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setProgress(0);
    try {
      await api.uploadAssets('sticker', files, setProgress);
      setBucket('mine');
      await loadAssets();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };
  const pick = (id: string) => {
    if (!isAssetReady(assets.find((a) => a.id === id))) {
      setError('这个视频还在预处理，就绪后再选。');
      return;
    }
    onPick(id);
  };
  return (
    <Modal title="选择封面" onClose={onClose} width={560}>
      <div className="inline" style={{ marginBottom: 8 }}>
        <div className="chips">
          <button className={`chip ${bucket === 'mine' ? 'active' : ''}`} onClick={() => setBucket('mine')}>我上传的</button>
          <button className={`chip ${bucket === 'library' ? 'active' : ''}`} onClick={() => setBucket('library')}>原料库</button>
        </div>
        <span className="chips" role="radiogroup" aria-label="封面形态">
          {KINDS.map((k) => (
            <button key={k.key} role="radio" aria-checked={kind === k.key} className={`chip ${kind === k.key ? 'active' : ''}`} onClick={() => setKind(k.key)}>
              {k.label}
            </button>
          ))}
        </span>
        <input className="input sm" placeholder="搜索…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <label className="btn sm" style={{ cursor: 'pointer' }}>
          {progress !== null ? `上传中 ${Math.round(progress * 100)}%` : '上传图片 / 视频'}
          <input type="file" multiple accept={STICKER_ACCEPT} className="sr-only" disabled={progress !== null} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </label>
      </div>
      {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
      {list.length === 0 ? (
        <div className="empty small">{q || kind !== 'all' ? '没有匹配的素材。' : '还没有素材。支持 png / jpg / webp / gif 图片与 mp4 / mov / webm 视频。'}</div>
      ) : (
        <div className="sticker-grid">
          {list.map((a) => (
            <AssetCard key={a.id} asset={a} onPick={() => pick(a.id)} />
          ))}
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>点击即设为封面。图片封面默认停留 1 秒，可在面板里调；视频封面整段播放并保留原声。</div>
    </Modal>
  );
}

export function CoverSection() {
  const cover = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.cover ?? null : null));
  const asset = useEditor((s) => (cover ? s.assets.find((a) => a.id === cover.asset_id) : undefined));
  const setCover = useEditor((s) => s.setCover);
  const setCoverDuration = useEditor((s) => s.setCoverDuration);
  const clearCover = useEditor((s) => s.clearCover);
  const preroll = useCoverDuration();
  const [picking, setPicking] = useState(false);

  const isVideo = isVideoAsset(asset);
  const thumb = asset ? (isVideo ? asset.poster_url ?? undefined : asset.url) : undefined;
  const name = asset?.name ?? '（素材已删除）';
  const status = !asset
    ? '素材不在素材库里，导出时不会插入封面'
    : isVideo && !isAssetReady(asset)
      ? '视频预处理中，就绪前导出不会插入封面'
      : null;

  return (
    <Section id="trim.cover" title="封面" defaultOpen={false} bodyClass="stack" summary={<span className="mono">{coverSummary(cover, preroll)}</span>} help={COVER_HELP}>
      {!cover ? (
        <div className="inline">
          <button className="btn" onClick={() => setPicking(true)}>
            添加封面
          </button>
        </div>
      ) : (
        <>
          <div className="cover-item">
            <div className="cover-thumb" style={{ backgroundImage: thumb ? `url("${thumb}")` : undefined }} />
            <div className="cover-meta">
              <div className="vname" title={name}>{name}</div>
              <div className="muted small">{isVideo ? '视频 · 整段播放，保留原声' : '图片'}</div>
              {status && <div className="small" style={{ color: 'var(--st-failed-fg)' }}>{status}</div>}
            </div>
          </div>
          <div className="prop-grid">
            <span>时长</span>
            {isVideo ? (
              <span className="mono small">{asset?.duration ? formatSeconds(asset.duration, 1) : '—'}（取视频自身时长）</span>
            ) : (
              <Num
                value={clampCoverDuration(cover.duration)}
                onChange={(v) => setCoverDuration(v)}
                step={0.1}
                min={COVER_MIN_DURATION}
                max={COVER_MAX_DURATION}
                scale={1}
                suffix="秒"
                title="图片封面停留时长（0.1–10 秒）"
              />
            )}
          </div>
          <div className="inline">
            <button className="btn sm" onClick={() => setPicking(true)}>更换</button>
            <button
              className="btn sm"
              disabled={preroll <= 0}
              onClick={() => {
                player.pause();
                player.seek(-player.preroll);
              }}
            >
              定位到封面
            </button>
            <span className="spacer" />
            <button className="btn ghost sm danger" onClick={clearCover}>移除封面</button>
          </div>
        </>
      )}
      {picking && (
        <CoverPicker
          onPick={(id) => {
            setCover(id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Section>
  );
}

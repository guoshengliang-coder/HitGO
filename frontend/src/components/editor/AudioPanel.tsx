// 音频模块（HIG-10）：源音轨、BGM / 口播、视频贴纸自带的声音都在这里管。
// BGM / 口播的时段也可以在时间线上拖动、拉伸；贴纸音轨的时段和播放方式跟着贴纸走，在贴纸模块里改。

import { useMemo, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { api } from '../../api';
import { formatSeconds } from '../../lib/time';
import { filterAssets, type AssetBucket } from '../../lib/assets';
import { audibleSpan, resolveTrack, sourceVolume, stickerAudioLayers } from '../../lib/audioTracks';
import { windowRange } from '../../lib/stickerMedia';
import { layerName } from '../../lib/spec';
import { AssetCard, AUDIO_ACCEPT } from '../../pages/AssetsPage';
import { IconTrash } from '../ui/Icons';
import { Modal } from '../ui/Modal';
import { Num, Slider } from '../ui/Num';
import type { AudioRole, AudioTrack } from '../../types';

/** 选一段音频素材作为 BGM / 口播；可以直接在这里上传（走素材库同一条上传链路）。 */
function AudioPicker({ role, onPick, onClose }: { role: AudioRole; onPick: (assetId: string) => void; onClose: () => void }) {
  const assets = useEditor((s) => s.assets);
  const loadAssets = useEditor((s) => s.loadAssets);
  const [bucket, setBucket] = useState<AssetBucket>('mine');
  const [q, setQ] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(() => filterAssets(assets, { type: 'audio', bucket, q }), [assets, bucket, q]);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setProgress(0);
    try {
      await api.uploadAssets('audio', files, setProgress);
      await loadAssets();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };
  return (
    <Modal title={role === 'bgm' ? '选择 BGM' : '选择口播'} onClose={onClose} width={520}>
      <div className="inline" style={{ marginBottom: 8 }}>
        <div className="chips">
          <button className={`chip ${bucket === 'mine' ? 'active' : ''}`} onClick={() => setBucket('mine')}>我上传的</button>
          <button className={`chip ${bucket === 'library' ? 'active' : ''}`} onClick={() => setBucket('library')}>原料库</button>
        </div>
        <input className="input sm" placeholder="搜索音频…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <label className="btn sm" style={{ cursor: 'pointer' }}>
          {progress !== null ? `上传中 ${Math.round(progress * 100)}%` : '上传音频'}
          <input type="file" multiple accept={AUDIO_ACCEPT} className="sr-only" disabled={progress !== null} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </label>
      </div>
      {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
      {list.length === 0 ? (
        <div className="empty small">{q ? '没有匹配的音频。' : '还没有音频。支持 mp3 / wav / m4a，单个不超过 50 MiB。'}</div>
      ) : (
        <div className="sticker-grid">
          {list.map((a) => (
            <AssetCard key={a.id} asset={a} onPick={() => onPick(a.id)} />
          ))}
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>点击即加为{role === 'bgm' ? ' BGM（循环、60% 音量、末尾淡出 1 秒）' : '口播（原音量、播一遍）'}，加入后可在面板里调时段、音量、淡入淡出，也可以在时间线上拖动。还在探测时长的素材要等它就绪。</div>
    </Modal>
  );
}

function TrackItem({ track, selected }: { track: AudioTrack; selected: boolean }) {
  const assets = useEditor((s) => s.assets);
  const update = useEditor((s) => s.updateAudioTrack);
  const remove = useEditor((s) => s.removeAudioTrack);
  const select = useEditor((s) => s.setSelectedTrack);
  const postDuration = usePostDuration();
  const r = resolveTrack(track);
  const asset = assets.find((a) => a.id === track.asset_id);
  const name = asset?.name.replace(/\.[a-z0-9]+$/i, '') ?? '（素材已删除）';
  const mediaDuration = asset?.duration ?? 0;
  const span = audibleSpan(track, postDuration, mediaDuration);
  const [ws, we] = r.t === 'all' ? [0, postDuration] : r.t;
  const windowLen = Math.max(0, Math.min(we, postDuration) - ws);
  const notReady = !asset || (asset.status ?? 'ready') !== 'ready';
  return (
    <div className={`track-item ${selected ? 'selected' : ''}`} onClick={() => select(track.id)}>
      <div className="track-head">
        <span className={`role ${r.role}`}>{r.role === 'voice' ? '口播' : 'BGM'}</span>
        <span className="tname" title={asset?.name}>{name}</span>
        {mediaDuration > 0 && <span className="mono muted">{formatSeconds(mediaDuration, 1)}</span>}
        <button className="btn ghost icon sm danger" aria-label="删除音轨" onClick={(e) => { e.stopPropagation(); remove(track.id); }}>
          <IconTrash />
        </button>
      </div>
      {selected && (
        <div className="prop-grid" onClick={(e) => e.stopPropagation()}>
          <span>时段</span>
          <div className="inline">
            <button className={`chip ${r.t === 'all' ? 'active' : ''}`} onClick={() => update(track.id, { t: 'all' })}>全程</button>
            <button className={`chip ${r.t !== 'all' ? 'active' : ''}`} onClick={() => r.t === 'all' && update(track.id, { t: [0, Math.min(3, postDuration)] })}>区间</button>
            {r.t !== 'all' && (
              <>
                <Num value={r.t[0]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => update(track.id, { t: [v, Math.max(v + 0.1, (r.t as [number, number])[1])] })} />
                <Num value={r.t[1]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => update(track.id, { t: [Math.min((r.t as [number, number])[0], v - 0.1), v] })} />
              </>
            )}
          </div>
          <span>音量</span>
          <Slider value={r.volume} onChange={(v) => update(track.id, { volume: Math.round(v * 100) / 100 })} />
          <span>循环</span>
          <div className="inline">
            <button className={`chip ${r.loop ? 'active' : ''}`} title="素材短于时段时从头重复；循环时起始偏移固定为 0" onClick={() => update(track.id, { loop: !r.loop })}>{r.loop ? '循环' : '播一遍'}</button>
            <span className="muted small">起始偏移</span>
            <Num value={r.offset} scale={1} step={0.5} min={0} max={mediaDuration > 0 ? Math.max(0, mediaDuration - 0.1) : undefined} suffix="s" disabled={r.loop} title="从素材第几秒开始播" onChange={(v) => update(track.id, { offset: Math.round(v * 100) / 100 })} />
          </div>
          <span>淡入</span>
          <div className="inline">
            <Num value={r.fade_in} scale={1} step={0.5} min={0} max={Math.max(0, windowLen - r.fade_out)} suffix="s" onChange={(v) => update(track.id, { fade_in: Math.round(v * 100) / 100 })} />
            <span className="muted small">淡出</span>
            <Num value={r.fade_out} scale={1} step={0.5} min={0} max={Math.max(0, windowLen - r.fade_in)} suffix="s" onChange={(v) => update(track.id, { fade_out: Math.round(v * 100) / 100 })} />
          </div>
          {notReady && <div className="error-text" style={{ gridColumn: '1 / -1' }}>{asset ? '素材还在处理中，就绪前预览和成片都不会出声。' : '素材不存在，成片里会跳过这条音轨。'}</div>}
          {!notReady && !r.loop && span < windowLen - 0.05 && (
            <div className="hint" style={{ gridColumn: '1 / -1' }}>素材只够放 {formatSeconds(span, 1)}，之后到时段结束静音；淡出落在素材播完处。要铺满可改为循环。</div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceSection() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const audio = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.audio : null));
  const setSourceVolume = useEditor((s) => s.setSourceVolume);
  const sv = sourceVolume(audio);
  const hasAudio = !!video?.has_audio;
  return (
    <div className="section">
      <div className="section-title">
        <span>源音轨</span>
        <button className={`chip ${sv === 0 ? 'active' : ''}`} disabled={!hasAudio} title="源视频自带的声音整个不要（换 BGM / 口播时常用）" onClick={() => setSourceVolume(sv === 0 ? 1 : 0)}>静音</button>
      </div>
      <div className="prop-grid">
        <span>音量</span>
        <Slider value={sv} disabled={!hasAudio} onChange={setSourceVolume} />
      </div>
      {!hasAudio && <div className="hint">源视频没有音轨；加 BGM / 口播后成片才有声音。</div>}
    </div>
  );
}

function TracksSection() {
  const audio = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.audio : null));
  const addTrack = useEditor((s) => s.addAudioTrack);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const [picking, setPicking] = useState<AudioRole | null>(null);
  const tracks = audio?.tracks ?? [];
  return (
    <div className="section">
      <div className="section-title">
        <span>BGM / 口播</span>
        <span className="mono muted">{tracks.length}</span>
      </div>
      <div className="inline">
        <button className="btn" onClick={() => setPicking('bgm')}>+ BGM</button>
        <button className="btn" onClick={() => setPicking('voice')}>+ 口播</button>
      </div>
      {tracks.length === 0 ? (
        <div className="hint">还没有叠加音轨。BGM 会循环铺满并在末尾淡出；口播按素材原长播一遍，可设区间。各音轨按原音量直接叠加，不自动压低源音轨。</div>
      ) : (
        <div className="track-list">
          {tracks.map((t) => (
            <TrackItem key={t.id} track={t} selected={selectedTrackId === t.id} />
          ))}
        </div>
      )}
      {picking && (
        <AudioPicker
          role={picking}
          onClose={() => setPicking(null)}
          onPick={(assetId) => {
            if (addTrack(assetId, picking) !== null) setPicking(null);
          }}
        />
      )}
    </div>
  );
}

const MIX_MODES: [boolean, string, string][] = [
  [false, '不合成', '成片不带这个贴纸的声音'],
  [true, '合成', '贴纸自带的声音叠加进成片（时段内，跟随播放方式）'],
];

/** 带声音的视频贴纸：在这里也能开关 mix_audio（贴纸面板里的开关保留，两边改的是同一个字段）。 */
function StickerAudioSection() {
  const layers = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.layers : undefined));
  const assets = useEditor((s) => s.assets);
  const updateLayer = useEditor((s) => s.updateLayer);
  const postDuration = usePostDuration();
  const list = useMemo(() => stickerAudioLayers(layers ?? [], assets), [layers, assets]);
  if (list.length === 0) return null;
  return (
    <div className="section">
      <div className="section-title">
        <span>贴纸音轨</span>
        <span className="mono muted">{list.length}</span>
      </div>
      <div className="track-list">
        {list.map((l) => {
          const [a, b] = windowRange(l.t, postDuration);
          const name = layerName(l, assets);
          return (
            <div key={l.id} className="track-item">
              <div className="track-head">
                <span className="role sticker">贴纸</span>
                <span className="tname" title={name}>{name}</span>
                <span className="mono muted">{l.t === 'all' ? '全程' : `${a.toFixed(1)}s – ${b.toFixed(1)}s`}</span>
              </div>
              <div className="inline" role="radiogroup" aria-label={`${name} 的音轨`}>
                {MIX_MODES.map(([mix, label, title]) => (
                  <button key={label} role="radio" aria-checked={!!l.mix_audio === mix} className={`chip ${!!l.mix_audio === mix ? 'active' : ''}`} title={title} onClick={() => updateLayer(l.id, { mix_audio: mix })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="hint">视频贴纸自带的声音按原音量叠加；时段和播放方式跟着贴纸走，在贴纸模块里改。</div>
    </div>
  );
}

export function AudioPanel({ onApply, targetCount }: { onApply: () => void; targetCount: number }) {
  return (
    <div className="panel">
      <div className="panel-head">音频</div>
      <div className="panel-body">
        <SourceSection />
        <TracksSection />
        <StickerAudioSection />
        <div className="hint">BGM / 口播的时段基于剪后时间轴，可在时间线上拖动条移动、拖两端调整（按住 ⌥ 不吸附）。修改剪辑不会自动改动音轨时段，超出剪后时长的部分成片里会被截掉。</div>
      </div>
      <div className="panel-foot">
        <button className="btn" disabled={targetCount === 0} onClick={onApply} title="源音轨音量与 BGM / 口播音轨一起套用到目标视频">
          把音频应用到选中 {targetCount} 条
        </button>
      </div>
    </div>
  );
}

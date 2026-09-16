// 音频模块（HIG-10）：源音轨、BGM / 口播、视频贴纸自带的声音都在这里管。
// BGM / 口播的时段也可以在时间线上拖动、拉伸；贴纸音轨的时段和播放方式跟着贴纸走，在贴纸模块里改。

import { useMemo, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { api } from '../../api';
import { formatSeconds } from '../../lib/time';
import { BUCKET_LABEL, filterAssets, type AssetBucket } from '../../lib/assets';
import { audibleSpan, continuationOffset, resolveTrack, sourceVolume, stickerAudioLayers } from '../../lib/audioTracks';
import { windowRange } from '../../lib/stickerMedia';
import { layerName } from '../../lib/spec';
import { AssetCard, AUDIO_ACCEPT } from '../../pages/AssetsPage';
import { IconTrash } from '../ui/Icons';
import { Modal } from '../ui/Modal';
import { Num, Slider } from '../ui/Num';
import type { AudioRole, AudioTrack, SeparationModel } from '../../types';

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
          {(['mine', 'library', 'derived'] as AssetBucket[]).map((b) => (
            <button key={b} className={`chip ${bucket === b ? 'active' : ''}`} onClick={() => setBucket(b)}>{BUCKET_LABEL[b]}</button>
          ))}
        </div>
        <input className="input sm" placeholder="搜索音频…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <label className="btn sm" style={{ cursor: 'pointer' }}>
          {progress !== null ? `上传中 ${Math.round(progress * 100)}%` : '上传音频'}
          <input type="file" multiple accept={AUDIO_ACCEPT} className="sr-only" disabled={progress !== null} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </label>
      </div>
      {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
      {list.length === 0 ? (
        <div className="empty small">{q ? '没有匹配的音频。' : bucket === 'derived' ? '还没有分离结果。在「人声 / 伴奏分离」里对当前视频跑一次，人声轨和伴奏轨会出现在这里，也能用到别的视频上。' : '还没有音频。支持 mp3 / wav / m4a，单个不超过 50 MiB。'}</div>
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
  const allTracks = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.audio?.tracks : undefined));
  const cont = r.loop && allTracks ? continuationOffset(track, allTracks, postDuration, mediaDuration) : null;
  const [ws, we] = r.t === 'all' ? [0, postDuration] : r.t;
  const windowLen = Math.max(0, Math.min(we, postDuration) - ws);
  const notReady = !asset || (asset.status ?? 'ready') !== 'ready';
  return (
    <div className={`track-item ${selected ? 'selected' : ''}`} onClick={() => select(track.id)}>
      <div className="track-head">
        <span className={`role ${r.role}`}>{r.role === 'voice' ? '口播' : 'BGM'}</span>
        {r.align === 'source' && <span className="role source" title="对齐源时间轴：随剪辑一起裁，不循环、无偏移">源</span>}
        <span className="tname" title={asset?.name}>{name}</span>
        {mediaDuration > 0 && <span className="mono muted">{formatSeconds(mediaDuration, 1)}</span>}
        {!asset && <span className="error-text small" title="素材已被删除或被重新分离 / 重新配音替换掉，导出时会跳过这条音轨">素材已失效，导出会跳过</span>}
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
          {r.align === 'source' ? (
            <>
              <span>对齐</span>
              <div className="hint">按源视频时间轴播放，删除的区间会一起跳过；不能循环或偏移。</div>
            </>
          ) : (
            <>
              <span>循环</span>
              <div className="inline">
                <button className={`chip ${r.loop ? 'active' : ''}`} title="素材短于时段时重复播放" onClick={() => update(track.id, { loop: !r.loop })}>{r.loop ? '循环' : '播一遍'}</button>
                <span className="muted small">起点</span>
                <Num value={r.offset} scale={1} step={0.5} min={0} max={mediaDuration > 0 ? Math.max(0, mediaDuration - 0.1) : undefined} suffix="s" title={r.loop ? '第一遍从素材第几秒开始，之后从头循环' : '从素材第几秒开始播'} onChange={(v) => update(track.id, { offset: Math.round(v * 100) / 100 })} />
              </div>
              {r.loop && (
                <>
                  <span />
                  <div className="inline" title="拆分出来的后半段默认接着前半段放；也可以改成从素材开头重新放">
                    <button
                      className={`chip ${cont !== null && Math.abs(r.offset - cont) < 1e-3 ? 'active' : ''}`}
                      disabled={cont === null}
                      title={cont === null ? '前面没有紧挨着的同一素材音轨可接' : `从前一段结束处（素材 ${formatSeconds(cont, 1)}）接着放`}
                      onClick={() => cont !== null && update(track.id, { offset: cont })}
                    >
                      接着放
                    </button>
                    <button className={`chip ${r.offset === 0 ? 'active' : ''}`} onClick={() => r.offset !== 0 && update(track.id, { offset: 0 })}>从头放</button>
                  </div>
                </>
              )}
            </>
          )}
          <span>淡入</span>
          <div className="inline">
            <Num value={r.fade_in} scale={1} step={0.5} min={0} max={Math.max(0, windowLen - r.fade_out)} suffix="s" onChange={(v) => update(track.id, { fade_in: Math.round(v * 100) / 100 })} />
            <span className="muted small">淡出</span>
            <Num value={r.fade_out} scale={1} step={0.5} min={0} max={Math.max(0, windowLen - r.fade_in)} suffix="s" onChange={(v) => update(track.id, { fade_out: Math.round(v * 100) / 100 })} />
          </div>
          {notReady && <div className="error-text" style={{ gridColumn: '1 / -1' }}>{asset ? '素材还在处理中，就绪前预览和成片都不会出声。' : '素材不存在，成片里会跳过这条音轨。'}</div>}
          {!notReady && !r.loop && r.align !== 'source' && span < windowLen - 0.05 && (
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
  const mutes = audio?.source_mute ?? [];
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
      {hasAudio && sv > 0 && (
        <div className="hint">
          {mutes.length > 0 ? `已静音 ${mutes.length} 段原声（${mutes.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}s`).join('、')}，剪后时间）。` : ''}
          要剪掉一段原声：在时间线上点「源音轨」，按 Q / W 静音播放头左 / 右侧，或 I、O 标一段；画面不受影响。
        </div>
      )}
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

const MODEL_OPTIONS: [SeparationModel, string, string][] = [
  ['htdemucs', '标准', 'Demucs htdemucs：一条 30 秒素材约半分钟到一分钟'],
  ['htdemucs_ft', '高质量', 'htdemucs_ft 四模型集成：人声边缘更干净，慢约 4 倍'],
];

const SEP_STATUS_TEXT: Record<string, string> = { queued: '排队中…', running: '分离中（CPU 运算，短片约一分钟）…', done: '已分离', failed: '分离失败' };

/** 人声 / 伴奏分离（契约 §1 separation）：跑模型，然后一键用分离结果替换源音轨。 */
function SeparateSection() {
  const video = useEditor((s) => s.videos.find((v) => v.id === s.currentVideoId) ?? null);
  const assets = useEditor((s) => s.assets);
  const tracks = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.audio?.tracks : undefined)) ?? [];
  const separateVideo = useEditor((s) => s.separateVideo);
  const useStem = useEditor((s) => s.useStem);
  const [model, setModel] = useState<SeparationModel>('htdemucs');
  const sep = video?.separation ?? null;
  const active = sep?.status === 'queued' || sep?.status === 'running';
  const hasAudio = !!video?.has_audio;
  const stemAsset = (id: string | null | undefined) => (id ? assets.find((a) => a.id === id) : undefined);
  const vocals = sep?.status === 'done' ? stemAsset(sep.vocals_asset_id) : undefined;
  const inst = sep?.status === 'done' ? stemAsset(sep.instrumental_asset_id) : undefined;
  const inUse = (id: string | undefined) => !!id && tracks.some((t) => t.asset_id === id);
  return (
    <div className="section">
      <div className="section-title">
        <span>人声 / 伴奏分离</span>
        {sep && <span className={`small ${sep.status === 'failed' ? 'error-text' : 'muted'}`}>{SEP_STATUS_TEXT[sep.status] ?? sep.status}{sep.status === 'done' ? `（${sep.model === 'htdemucs_ft' ? '高质量' : '标准'}）` : ''}</span>}
      </div>
      <div className="inline">
        <span className="chips" role="radiogroup" aria-label="分离模型">
          {MODEL_OPTIONS.map(([m, label, title]) => (
            <button key={m} role="radio" aria-checked={model === m} className={`chip ${model === m ? 'active' : ''}`} title={title} disabled={active} onClick={() => setModel(m)}>{label}</button>
          ))}
        </span>
        <button className="btn" disabled={!hasAudio || active} title={hasAudio ? '用 AI 把源音轨拆成人声和伴奏两条音轨（后台任务）' : '源视频没有音轨'} onClick={() => void separateVideo(model)}>
          {active ? '分离中…' : sep?.status === 'done' ? '重新分离' : '分离人声 / 伴奏'}
        </button>
      </div>
      {sep?.status === 'failed' && sep.error && <div className="error-text">{sep.error}</div>}
      {sep?.status === 'done' && (
        <div className="inline">
          <button className="btn sm" disabled={!vocals || inUse(vocals?.id)} title="源音轨静音，只保留分离出的人声；再加一条新 BGM 即可换配乐" onClick={() => useStem('vocals')}>
            {inUse(vocals?.id) ? '已用人声轨' : '只留人声（换 BGM）'}
          </button>
          <button className="btn sm" disabled={!inst || inUse(inst?.id)} title="源音轨静音，只保留分离出的伴奏；再加一条新口播即可换人声" onClick={() => useStem('instrumental')}>
            {inUse(inst?.id) ? '已用伴奏轨' : '只留伴奏（换口播）'}
          </button>
        </div>
      )}
      <div className="hint">
        {sep?.status === 'done'
          ? '分离结果也在「+ BGM / + 口播」选择器的「分离结果」栏里，可用到别的视频上。重新分离会替换掉这两条素材。'
          : '把源视频的声音拆成人声轨和伴奏轨，之后可以只留一条再叠新的 BGM 或口播。在服务器 CPU 上跑，短片约一分钟。'}
      </div>
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

export function AudioPanel() {
  return (
    <div className="panel">
      <div className="panel-head">音频</div>
      <div className="panel-body">
        <SourceSection />
        <SeparateSection />
        <TracksSection />
        <StickerAudioSection />
        <div className="hint">BGM / 口播的时段基于剪后时间轴，可在时间线上拖动条移动、拖两端调整（按住 ⌥ 不吸附）。修改剪辑不会自动改动音轨时段，超出剪后时长的部分成片里会被截掉。</div>
      </div>
    </div>
  );
}

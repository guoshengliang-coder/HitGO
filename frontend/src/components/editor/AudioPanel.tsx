// 音频模块（HIG-10）：源音轨、BGM / 口播、视频贴纸自带的声音都在这里管。
// BGM / 口播的时段也可以在时间线上拖动、拉伸；贴纸音轨的时段和播放方式跟着贴纸走，在贴纸模块里改。

import { useMemo, useState } from 'react';
import { useEditor, usePostDuration } from '../../store/editor';
import { api } from '../../api';
import { formatSeconds } from '../../lib/time';
import { BUCKET_LABEL, filterAssets, type AssetBucket } from '../../lib/assets';
import { audibleSpan, continuationOffset, resolveTrack, sourceVolume, SPEED_MAX, SPEED_MIN, stickerAudioLayers } from '../../lib/audioTracks';
import { windowRange } from '../../lib/stickerMedia';
import { layerName } from '../../lib/spec';
import { AssetCard, AUDIO_ACCEPT } from '../../pages/AssetsPage';
import { IconEye, IconTrash } from '../ui/Icons';
import { Modal } from '../ui/Modal';
import { Field, Num, Slider } from '../ui/Num';
import { Seg, type SegOption } from '../ui/Seg';
import { Section } from '../ui/Section';
import type { AudioRole, AudioTrack, SeparationModel } from '../../types';

/**
 * 音频素材列表：我的 / 素材库 / 分离结果 + 搜索 + 直接上传（走素材库同一条上传链路）。
 * 弹窗选择器点选用（onPick）；音频面板里常驻一份，卡片拖到时间线上加轨（draggable，HIG-33）。
 */
export function AudioAssetList({ onPick, draggable }: { onPick?: (assetId: string) => void; draggable?: boolean }) {
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
    <>
      <div className="inline audio-list-bar" style={{ marginBottom: 8 }}>
        <div className="chips">
          {(['mine', 'library', 'derived'] as AssetBucket[]).map((b) => (
            <button key={b} className={`chip ${bucket === b ? 'active' : ''}`} onClick={() => setBucket(b)}>{BUCKET_LABEL[b]}</button>
          ))}
        </div>
        <input className="input sm" placeholder="搜索音频…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 90 }} />
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
            <AssetCard key={a.id} asset={a} onPick={onPick ? () => onPick(a.id) : undefined} draggable={draggable} />
          ))}
        </div>
      )}
    </>
  );
}

/** 选一段音频素材作为 BGM / 口播。 */
function AudioPicker({ role, onPick, onClose }: { role: AudioRole; onPick: (assetId: string) => void; onClose: () => void }) {
  return (
    <Modal title={role === 'bgm' ? '选择 BGM' : '选择口播'} onClose={onClose} width={520}>
      <AudioAssetList onPick={onPick} />
      <div className="hint" style={{ marginTop: 8 }}>点击即加为{role === 'bgm' ? ' BGM（循环、60% 音量、末尾淡出 1 秒）' : '口播（原音量、播一遍）'}，加入后可在面板里调时段、音量、淡入淡出，也可以在时间线上拖动。还在探测时长的素材要等它就绪。</div>
    </Modal>
  );
}

/** 常驻的音频素材（HIG-33）：拖到时间线上加轨，落点就是起点。 */
function LibrarySection() {
  return (
    <Section id="audio.library" title="音频素材" bodyClass="stack" hint="拖到时间线上加轨" help={LIBRARY_HELP}>
      <AudioAssetList draggable />
    </Section>
  );
}

const TIME_MODES: SegOption<'all' | 'range'>[] = [
  { v: 'all', label: '全程' },
  { v: 'range', label: '区间' },
];
const LOOP_MODES: SegOption<boolean>[] = [
  { v: true, label: '循环', title: '素材短于时段时重复播放' },
  { v: false, label: '播一遍' },
];

/** 常用倍速；「倍速」数字框可以填之间的任意值，Seg 只在正好等于某一档时高亮。 */
const SPEED_PRESETS: SegOption<number>[] = [
  { v: 0.75, label: '0.75×' },
  { v: 1, label: '1×' },
  { v: 1.25, label: '1.25×' },
  { v: 1.5, label: '1.5×' },
  { v: 2, label: '2×' },
];

const nearestSpeed = (v: number) => SPEED_PRESETS.find((o) => Math.abs(o.v - v) < 1e-6)?.v ?? v;

function TrackItem({ track, selected }: { track: AudioTrack; selected: boolean }) {
  const assets = useEditor((s) => s.assets);
  const update = useEditor((s) => s.updateAudioTrack);
  const remove = useEditor((s) => s.removeAudioTrack);
  const toggleHidden = useEditor((s) => s.toggleTrackHidden);
  const select = useEditor((s) => s.setSelectedTrack);
  const setSpeed = useEditor((s) => s.setTrackSpeed);
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
    <div className={`track-item ${selected ? 'selected' : ''} ${track.hidden ? 'hidden' : ''}`} onClick={() => select(track.id)}>
      <div className="track-head">
        <span className={`role ${r.role}`}>{r.role === 'voice' ? '口播' : 'BGM'}</span>
        {r.align === 'source' && <span className="role source" title="对齐源时间轴：随剪辑一起裁，不循环、无偏移">源</span>}
        <span className="tname" title={asset?.name}>{name}</span>
        {mediaDuration > 0 && <span className="mono muted">{formatSeconds(mediaDuration, 1)}</span>}
        {!asset && <span className="error-text small" title="素材已被删除或被重新分离 / 重新配音替换掉，导出时会跳过这条音轨">素材已失效，导出会跳过</span>}
        <button className="btn ghost icon sm" title={track.hidden ? '显示（导出时恢复）' : '隐藏（导出时也不混入，不删除）'} aria-label={track.hidden ? '显示音轨' : '隐藏音轨'} aria-pressed={!!track.hidden} onClick={(e) => { e.stopPropagation(); toggleHidden(track.id); }}>
          <IconEye off={!!track.hidden} />
        </button>
        <button className="btn ghost icon sm danger" aria-label="删除音轨" onClick={(e) => { e.stopPropagation(); remove(track.id); }}>
          <IconTrash />
        </button>
      </div>
      {selected && (
        <div className="track-body" onClick={(e) => e.stopPropagation()}>
          <Seg label="时段" options={TIME_MODES} value={r.t === 'all' ? 'all' : 'range'} onChange={(m) => update(track.id, { t: m === 'all' ? 'all' : [0, Math.min(3, postDuration)] })} />
          {r.t !== 'all' && (
            <div className="g2">
              <Num label="开始" value={r.t[0]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => update(track.id, { t: [v, Math.max(v + 0.1, (r.t as [number, number])[1])] })} />
              <Num label="结束" value={r.t[1]} scale={1} step={0.1} min={0} suffix="s" onChange={(v) => update(track.id, { t: [Math.min((r.t as [number, number])[0], v - 0.1), v] })} />
            </div>
          )}
          <Slider label="音量" value={r.volume} onChange={(v) => update(track.id, { volume: Math.round(v * 100) / 100 })} />
          {r.align === 'source' ? (
            <div className="hint">按源视频时间轴播放，删除的区间会一起跳过；不能循环、偏移或变速。</div>
          ) : (
            <>
              <div className="g2">
                <Seg label="循环" options={LOOP_MODES} value={r.loop} onChange={(loop) => update(track.id, { loop })} />
                <Num label="起点" value={r.offset} scale={1} step={0.5} min={0} max={mediaDuration > 0 ? Math.max(0, mediaDuration - 0.1) : undefined} suffix="s" title={r.loop ? '第一遍从素材第几秒开始，之后从头循环' : '从素材第几秒开始播'} onChange={(v) => update(track.id, { offset: Math.round(v * 100) / 100 })} />
              </div>
              {/* 变速（HIG-75）：atempo，音调不变；改速度时时段跟着调，播的素材内容不变 */}
              <div className="g2">
                <Seg label="速度" options={SPEED_PRESETS} value={nearestSpeed(r.speed)} onChange={(v) => setSpeed(track.id, v)} />
                <Num label="倍速" value={r.speed} scale={1} step={0.05} min={SPEED_MIN} max={SPEED_MAX} suffix="×" title="atempo 变速，音调不变。改速度时时段跟着调，播的素材内容不变" onChange={(v) => setSpeed(track.id, v)} />
              </div>
              {r.loop && (
                <Field label="拆分后" title="拆分出来的后半段默认接着前半段放；也可以改成从素材开头重新放">
                  <Seg
                    className="inner"
                    label="拆分后的起点"
                    options={[
                      { v: 'cont', label: '接着放', disabled: cont === null, title: cont === null ? '前面没有紧挨着的同一素材音轨可接' : `从前一段结束处（素材 ${formatSeconds(cont, 1)}）接着放` },
                      { v: 'zero', label: '从头放' },
                    ]}
                    value={cont !== null && Math.abs(r.offset - cont) < 1e-3 ? 'cont' : r.offset === 0 ? 'zero' : 'other'}
                    onChange={(m) => update(track.id, { offset: m === 'cont' && cont !== null ? cont : 0 })}
                  />
                </Field>
              )}
            </>
          )}
          <div className="g2">
            <Num label="淡入" value={r.fade_in} scale={1} step={0.5} min={0} max={Math.max(0, windowLen - r.fade_out)} suffix="s" onChange={(v) => update(track.id, { fade_in: Math.round(v * 100) / 100 })} />
            <Num label="淡出" value={r.fade_out} scale={1} step={0.5} min={0} max={Math.max(0, windowLen - r.fade_in)} suffix="s" onChange={(v) => update(track.id, { fade_out: Math.round(v * 100) / 100 })} />
          </div>
          {notReady && <div className="error-text">{asset ? '素材还在处理中，就绪前预览和成片都不会出声。' : '素材不存在，成片里会跳过这条音轨。'}</div>}
          {!notReady && !r.loop && r.align !== 'source' && span < windowLen - 0.05 && (
            <div className="hint">素材只够放 {formatSeconds(span, 1)}，之后到时段结束静音；淡出落在素材播完处。要铺满可改为循环。</div>
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
  const toggleSourceHidden = useEditor((s) => s.toggleSourceHidden);
  const sv = sourceVolume(audio);
  const hidden = !!audio?.source_hidden;
  const mutes = audio?.source_mute ?? [];
  const hasAudio = !!video?.has_audio;
  const summary = !hasAudio ? '无音轨' : hidden ? '已隐藏' : sv === 0 ? '静音' : `${Math.round(sv * 100)}%${mutes.length ? ` · 静音 ${mutes.length} 段` : ''}`;
  return (
    <Section id="audio.source" title="源音轨" bodyClass="stack" summary={<span>{summary}</span>} hint={hasAudio ? '时间线上选中源音轨，Q / W 静音左 / 右侧' : undefined} help={SOURCE_HELP}>
      <Slider label="音量" value={sv} disabled={!hasAudio} onChange={setSourceVolume} />
      <Field label="整条静音" title="源视频自带的声音整个不要（换 BGM / 口播时常用）">
        <button type="button" role="switch" aria-checked={sv === 0} aria-label="整条静音" className={`sw ${sv === 0 ? 'on' : ''}`} disabled={!hasAudio} onClick={() => setSourceVolume(sv === 0 ? 1 : 0)} />
      </Field>
      {hasAudio && hidden && (
        <div className="inline">
          <span className="hint" style={{ flex: 1 }}>源音轨已隐藏，成片不带原声；音量设置保留。</span>
          <button className="btn sm" onClick={toggleSourceHidden}>显示</button>
        </div>
      )}
      {!hasAudio && <div className="hint">源视频没有音轨；加 BGM / 口播后成片才有声音。</div>}
      {hasAudio && mutes.length > 0 && <div className="hint">已静音 {mutes.length} 段原声：{mutes.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}s`).join('、')}（剪后时间）。</div>}
    </Section>
  );
}

function TracksSection() {
  const audio = useEditor((s) => (s.currentVideoId ? s.specs[s.currentVideoId]?.audio : null));
  const addTrack = useEditor((s) => s.addAudioTrack);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const [picking, setPicking] = useState<AudioRole | null>(null);
  const tracks = audio?.tracks ?? [];
  return (
    <Section id="audio.tracks" title="BGM / 口播" bodyClass="stack" summary={<span>{tracks.length ? `${tracks.length} 条` : '无'}</span>} hint="时间线上可拖动条与两端" help={TRACKS_HELP}>
      <div className="inline panel-add-row">
        <button className="btn action" onClick={() => setPicking('bgm')}>＋ BGM</button>
        <button className="btn action" onClick={() => setPicking('voice')}>＋ 口播</button>
      </div>
      {tracks.length === 0 ? (
        <div className="hint">还没有叠加音轨。</div>
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
    </Section>
  );
}

const MODEL_OPTIONS: SegOption<SeparationModel>[] = [
  { v: 'htdemucs', label: '标准', title: 'Demucs htdemucs：一条 30 秒素材约半分钟到一分钟' },
  { v: 'htdemucs_ft', label: '高质量', title: 'htdemucs_ft 四模型集成：人声边缘更干净，慢约 4 倍' },
];

const LIBRARY_HELP = '把卡片拖到下方时间线上：落点就是音轨起点。落在口播音轨那一行加为口播（按素材时长放一遍），其余位置加为 BGM（循环铺到结尾，落在最开头则全程）。也可以把电脑里的 mp3 / wav / m4a 直接拖到时间线上，上传完成后自动加轨。';
const SOURCE_HELP = '源视频自带的声音。要剪掉一段原声：在时间线上点「源音轨」，按 Q / W 静音播放头左 / 右侧，或 I、O 标一段；画面不受影响。';
const TRACKS_HELP = 'BGM 会循环铺满并在末尾淡出；口播按素材原长播一遍，可设区间。各音轨按原音量直接叠加，不自动压低源音轨。时段基于剪后时间轴，可在时间线上拖动条移动、拖两端调整（按住 ⌥ 不吸附）；修改剪辑不会自动改动音轨时段，超出剪后时长的部分成片里会被截掉。';
const SEPARATE_HELP = '把源视频的声音拆成人声轨和伴奏轨，之后可以只留一条再叠新的 BGM 或口播。在服务器 CPU 上跑，短片约一分钟。分离结果也会出现在「+ BGM / + 口播」选择器的「分离结果」栏里，可用到别的视频上；重新分离会替换掉这两条素材。';
const STICKER_AUDIO_HELP = '视频贴纸自带的声音按原音量叠加；时段和播放方式跟着贴纸走，在贴纸模块里改。';

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
  const status = sep ? `${SEP_STATUS_TEXT[sep.status] ?? sep.status}${sep.status === 'done' ? `（${sep.model === 'htdemucs_ft' ? '高质量' : '标准'}）` : ''}` : '未分离';
  return (
    <Section id="audio.separate" title="人声 / 伴奏分离" bodyClass="stack" defaultOpen={false} summary={<span className={sep?.status === 'failed' ? 'error-text' : undefined}>{status}</span>} help={SEPARATE_HELP}>
      <Field label="质量">
        <Seg className="inner" label="分离模型" options={MODEL_OPTIONS} value={model} onChange={setModel} disabled={active} />
      </Field>
      <div className="inline">
        <button className="btn action" disabled={!hasAudio || active} title={hasAudio ? '用 AI 把源音轨拆成人声和伴奏两条音轨（后台任务）' : '源视频没有音轨'} onClick={() => void separateVideo(model)}>
          {active ? '分离中…' : sep?.status === 'done' ? '重新分离' : '分离人声 / 伴奏'}
        </button>
        {sep && <span className={`small ${sep.status === 'failed' ? 'error-text' : 'muted'}`}>{status}</span>}
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
    </Section>
  );
}

const MIX_MODES: SegOption<boolean>[] = [
  { v: false, label: '不合成', title: '成片不带这个贴纸的声音' },
  { v: true, label: '合成', title: '贴纸自带的声音叠加进成片（时段内，跟随播放方式）' },
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
    <Section id="audio.stickers" title="贴纸音轨" bodyClass="stack" summary={<span>{list.length} 条</span>} help={STICKER_AUDIO_HELP}>
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
              <Seg label={`${name} 的音轨`} options={MIX_MODES} value={!!l.mix_audio} onChange={(mix) => updateLayer(l.id, { mix_audio: mix })} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

export function AudioPanel() {
  return (
    <div className="panel">
      <div className="panel-head">音频</div>
      <div className="panel-body inspector">
        <SourceSection />
        <TracksSection />
        <LibrarySection />
        <SeparateSection />
        <StickerAudioSection />
      </div>
    </div>
  );
}

// 开发用内存 mock（VITE_MOCK=1）。不依赖后端 / ffmpeg，让 UI 可以独立跑起来。
// 只覆盖契约中的路由，数据保存在内存里，刷新即重置。
// 上传的视频文件会用 object URL 作为 proxy_url，可真实播放；内置示例视频没有文件，
// 播放器会退回到"合成时钟"模式（见 lib/player.ts）。

import { installMock, ApiError, type ApplyLayerMode } from '../api';
import { langLabel } from '../lib/localize';
import type { Asset, Batch, BatchDetail, BlankVideoIn, EditSpec, HighlightPhrase, Job, Layer, LocalizationTerm, LocalizationVersion, LocalizeIn, LocalizeOptions, Preset, SafeZone, SeparationModel, TranscriptCue, TtsIn, VersionCue, Video } from '../types';

const now = () => new Date().toISOString();
let seq = 100;
const nid = (p: string) => `${p}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const PRESETS_KEY = 'hitgo.mock.presets';

/** 生成平台界面示意图（1080×1920 透明 PNG，半透明线框 + 占位文字），对应 GET /api/overlays/{key}.png。 */
const overlayCache = new Map<string, string>();
function overlayImage(zone: SafeZone): string {
  const hit = overlayCache.get(zone.key);
  if (hit) return hit;
  const w = 1080;
  const h = 1920;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 3;
  for (const z of zone.zones) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(z.x * w, z.y * h, z.w * w, z.h * h);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.strokeRect(z.x * w + 1.5, z.y * h + 1.5, z.w * w - 3, z.h * h - 3);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 34px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Lorem ipsum', z.x * w + 24, z.y * h + 24);
  }
  // 右侧互动区的圆形按钮占位
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(w * 0.92, h * (0.45 + i * 0.08), 40, 0, Math.PI * 2);
    ctx.fill();
  }
  const url = c.toDataURL('image/png');
  overlayCache.set(zone.key, url);
  return url;
}

// ---- 生成占位图片 ----
function solidImage(w: number, h: number, color: string): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c.toDataURL('image/png');
}

function gradientImage(w: number, h: number, hue: number, label: string): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 45% 40%)`);
  g.addColorStop(1, `hsl(${(hue + 60) % 360} 45% 25%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `${Math.round(Math.min(w, h) / 6)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2);
  return c.toDataURL('image/jpeg', 0.7);
}

function spriteImage(duration: number, hue: number) {
  const count = Math.ceil(duration);
  const columns = 10;
  const rows = Math.ceil(count / columns);
  const tw = 90;
  const th = 160;
  const c = document.createElement('canvas');
  c.width = tw * columns;
  c.height = th * rows;
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < count; i++) {
    const x = (i % columns) * tw;
    const y = Math.floor(i / columns) * th;
    ctx.fillStyle = `hsl(${(hue + i * 7) % 360} 40% ${30 + (i % 5) * 6}%)`;
    ctx.fillRect(x, y, tw, th);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${i}s`, x + tw / 2, y + th / 2);
  }
  return { url: c.toDataURL('image/jpeg', 0.6), interval: 1, tile_width: tw, tile_height: th, columns, count };
}

/** 浏览器能不能看出 <video> 带音轨：Safari 有 audioTracks，Firefox 有 mozHasAudio；都没有（Chrome）就当有，方便调界面。 */
function videoHasAudio(el: HTMLVideoElement): boolean {
  const v = el as HTMLVideoElement & { audioTracks?: { length: number }; mozHasAudio?: boolean };
  if (v.audioTracks) return v.audioTracks.length > 0;
  if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
  return true;
}

/** mock 的"异步预处理"：用 <video> 的 loadedmetadata 拿尺寸/时长，然后把素材推到 ready。 */
function probeVideo(asset: Asset, url: string) {
  const el = document.createElement('video');
  el.preload = 'metadata';
  el.muted = true;
  const finish = (ok: boolean) => {
    if (ok) {
      asset.width = el.videoWidth || 600;
      asset.height = el.videoHeight || 240;
      asset.duration = Number.isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : 3;
      asset.fps = 30;
      asset.has_alpha = /\.webm$/i.test(asset.name);
      asset.has_audio = videoHasAudio(el);
      asset.poster_url = null; // mock 不生成首帧，画布会直接用预览代理
      asset.preview_url = url;
      asset.status = 'ready';
    } else {
      asset.status = 'failed';
      asset.error = '无法解析该视频';
    }
  };
  el.onloadedmetadata = () => window.setTimeout(() => finish(true), 800);
  el.onerror = () => window.setTimeout(() => finish(false), 800);
  el.src = url;
}

/** 合成一段单音 WAV（data URL），给 mock 的分离结果当素材：mono 8 kHz，几秒也只有几十 KB。 */
function toneWav(seconds: number, freq: number): string {
  const rate = 8000;
  const n = Math.max(1, Math.round(seconds * rate));
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = t % 1 < 0.6 ? 1 : 0.15; // 每秒一下的节奏，听得出在动
    dv.setInt16(44 + i * 2, Math.round(0.3 * env * 32767 * Math.sin(2 * Math.PI * freq * t)), true);
  }
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** mock 的音频"预处理"：拿到时长后置 ready。 */
function probeAudio(asset: Asset, url: string) {
  const el = document.createElement('audio');
  el.preload = 'metadata';
  const finish = (ok: boolean) => {
    if (ok) {
      asset.duration = Number.isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : 3;
      asset.has_audio = true;
      asset.status = 'ready';
    } else {
      asset.status = 'failed';
      asset.error = '无法解析该音频';
    }
  };
  el.onloadedmetadata = () => window.setTimeout(() => finish(true), 600);
  el.onerror = () => window.setTimeout(() => finish(false), 600);
  el.src = url;
}

// ---- 改语言（契约 §1 localization / §3 localize）----
// 语言与音色由后端下发；mock 给三种目标语言，韩语两个音色。听写 / 翻译 / 合成都用定时器和样例文本模拟。

const LOCALIZE_OPTIONS: LocalizeOptions = {
  enabled: true,
  source_langs: [
    { code: 'auto', label: '自动识别' },
    { code: 'zh', label: '中文' },
    { code: 'en', label: '英语' },
    { code: 'ja', label: '日语' },
    { code: 'ko', label: '韩语' },
  ],
  target_langs: [
    // 中文放第一位：大字报（HIG-50）朗读缺省取它。id / 标签与后端 DEFAULT_VOICES 一致（HIG-42），带性别 / 风格 / 语速标识
    {
      code: 'zh',
      label: '中文',
      voices: [
        { id: 'longxiaochun_v3', label: '龙小淳', gender: 'female', style: '知性积极', speech_rate: true },
        { id: 'longcheng_v3', label: '龙橙', gender: 'male', style: '智慧青年', speech_rate: true },
        { id: 'loongbella_v3', label: 'Bella', gender: 'female', style: '精准干练', speech_rate: true },
        { id: 'longanran_v3', label: '龙安燃', gender: 'female', style: '活泼质感·直播', speech_rate: true },
        { id: 'longfei_v3', label: '龙飞', gender: 'male', style: '热血磁性', speech_rate: true },
        { id: 'longjiqi_v3', label: '龙机器', gender: 'neutral', style: '呆萌机器人', speech_rate: true },
      ],
    },
    { code: 'ko', label: '韩语', voices: [{ id: 'loongkyong_v3', label: 'Kyong', gender: 'female', style: '韩语', speech_rate: true }, { id: 'loongjihun_v3', label: 'Jihun', gender: 'male', style: '韩语', speech_rate: true }] },
    { code: 'ja', label: '日语', voices: [{ id: 'loongtomoka_v3', label: 'Tomoka', gender: 'female', style: '日语', speech_rate: true }] },
    { code: 'en', label: '英语', voices: [{ id: 'loongabby_v3', label: 'Abby', gender: 'female', style: '美式', speech_rate: true }, { id: 'loongandy_v3', label: 'Andy', gender: 'male', style: '美式', speech_rate: true }] },
    // qwen3-tts 音色：没有语速
    { code: 'es', label: '西班牙语', voices: [{ id: 'Cherry', label: 'Cherry', gender: 'female', style: '亲切', speech_rate: false }, { id: 'Ethan', label: 'Ethan', gender: 'male', style: '阳光', speech_rate: false }] },
  ],
};

const SAMPLE_EN = ['Welcome to HitGO.', 'Trim, subtitle and dub your ads in minutes.', 'Pick a template and apply it to the whole batch.', 'Export once, publish everywhere.', 'Try it free today.'];
const SAMPLE_BY_LANG: Record<string, string[]> = {
  en: SAMPLE_EN,
  ko: ['HitGO에 오신 것을 환영합니다.', '몇 분 만에 광고를 자르고 자막과 더빙을 입히세요.', '템플릿 하나를 골라 전체 배치에 적용하세요.', '한 번 내보내고 어디서나 게시하세요.', '오늘 무료로 사용해 보세요.'],
  ja: ['HitGOへようこそ。', '数分で広告をカットし、字幕と吹き替えを付けられます。', 'テンプレートを選んでバッチ全体に適用しましょう。', '一度書き出せばどこでも公開できます。', '今すぐ無料でお試しください。'],
  zh: ['欢迎使用 HitGO。', '几分钟内完成广告的剪辑、字幕和配音。', '选一个模板套用到整批素材。', '导出一次，处处发布。', '今天就免费试用。'],
};

/** 假听写：每 3 秒一句，句长 2.4 秒（裁到视频时长）。 */
function fakeTranscript(duration: number): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (let i = 0; i * 3 + 0.4 < duration && i < 400; i++) {
    const start = Math.round((i * 3 + 0.4) * 100) / 100;
    const end = Math.round(Math.min(start + 2.4, duration) * 100) / 100;
    if (end - start < 0.1) break;
    cues.push({ i, start, end, text: SAMPLE_EN[i % SAMPLE_EN.length] });
  }
  return cues;
}

/** 假翻译：按语言取样例句（按 i 循环），术语表在译文里做字面替换。 */
function fakeTranslate(lang: string, cues: TranscriptCue[], terms: LocalizationTerm[]): VersionCue[] {
  const pool = SAMPLE_BY_LANG[lang] ?? SAMPLE_EN;
  return cues.map((c) => {
    let translated = pool[c.i % pool.length];
    for (const t of terms) translated = translated.split(t.source).join(t.target);
    return { i: c.i, translated };
  });
}

/**
 * 模拟 worker 跑一个改语言任务：模板未就绪（或 retranscribe）先听写，然后逐语言 translate → tts → mix。
 * 每个版本独立 done / failed；V03 在 tts 阶段一半概率失败（和渲染 mock 一样，用来看失败路径）。
 * stage 已是 tts 的版本（PUT versions 触发）跳过翻译；dub = false 的版本翻译完就 done（HIG-56）。
 */
// 能用复刻原声的语言（HIG-58），与后端 CLONE_MODEL_LANGS 一致
const CLONE_LANGS = ['zh', 'yue', 'en', 'fr', 'de', 'ja', 'ko', 'ru', 'pt', 'th', 'id', 'vi'];
for (const t of LOCALIZE_OPTIONS.target_langs) t.clone = CLONE_LANGS.includes(t.code);

/** 假的复刻：第一次要几秒，之后整条视频复用（HIG-58）。 */
function ensureCloneVoice(v: Video, at: (ms: number, fn: () => void) => void, delay: number): number {
  const loc = v.localization!;
  if (loc.clone_voice?.status === 'done' && loc.clone_voice.voice_id) return delay;
  loc.clone_voice = { status: 'queued', voice_id: null, model: 'cosyvoice-v3-flash', error: null, sample: null, updated_at: now() };
  at(delay + 400, () => { v.localization!.clone_voice = { ...v.localization!.clone_voice!, status: 'running', updated_at: now() }; });
  return delay + 2400;
}

function runLocalize(v: Video, targetLangs: string[], retranscribe: boolean) {
  const at = (ms: number, fn: () => void) => window.setTimeout(() => { if (v.localization) fn(); }, ms);
  let delay = 0;
  const loc = v.localization!;
  const needTranscribe = !loc.transcript || loc.transcript.status !== 'done' || retranscribe;
  if (needTranscribe) {
    loc.transcript = { status: 'queued', error: null, cues: loc.transcript?.cues ?? [], updated_at: now() };
    delay += 800;
    at(delay, () => { v.localization!.transcript = { ...v.localization!.transcript!, status: 'running', updated_at: now() }; });
    delay += 2200;
    at(delay, () => {
      const l = v.localization!;
      l.transcript = { status: 'done', error: null, cues: fakeTranscript(v.duration), updated_at: now() };
      if (l.source_lang === 'auto') l.source_lang = 'en';
      for (const ver of Object.values(l.versions)) if (ver.status === 'done') ver.stale = true;
    });
  }
  if (targetLangs.some((l) => loc.versions[l]?.source_voice)) {
    delay = ensureCloneVoice(v, at, delay);
    at(delay, () => {
      const l = v.localization!;
      if (l.clone_voice?.status !== 'done') {
        l.clone_voice = { ...l.clone_voice!, status: 'done', voice_id: `hitgo-${v.id.slice(-6)}`, sample: { from: 'source', start: 0, seconds: 14 }, updated_at: now() };
      }
      for (const lang of targetLangs) {
        const ver = l.versions[lang];
        if (ver?.source_voice) ver.voice = l.clone_voice!.voice_id!;
      }
    });
  }
  for (const lang of targetLangs) {
    const skipTranslate = loc.versions[lang]?.stage === 'tts';
    if (!skipTranslate) {
      delay += 500;
      at(delay, () => { const ver = v.localization!.versions[lang]; if (ver) Object.assign(ver, { status: 'running', stage: 'translate', updated_at: now() }); });
      delay += 1500;
      at(delay, () => {
        const l = v.localization!;
        const ver = l.versions[lang];
        if (!ver) return;
        ver.cues = fakeTranslate(lang, l.transcript?.cues ?? [], ver.terms ?? []);
        ver.stale = false;
        if (ver.dub === false) Object.assign(ver, { status: 'done', stage: null, error: null, warnings: [], voice_stale: !!ver.voice_asset_id, updated_at: now() });
      });
      if (loc.versions[lang]?.dub === false) continue;
    }
    delay += 300;
    at(delay, () => { const ver = v.localization!.versions[lang]; if (ver) Object.assign(ver, { status: 'running', stage: 'tts', updated_at: now() }); });
    delay += 2000;
    at(delay, () => {
      const ver = v.localization!.versions[lang];
      if (!ver) return;
      if (v.name.includes('V03') && Math.random() < 0.5) {
        Object.assign(ver, { status: 'failed', stage: null, error: '模拟失败：CosyVoice 返回 429（mock）', updated_at: now() });
        return;
      }
      Object.assign(ver, { stage: 'mix', updated_at: now() });
    });
    delay += 800;
    at(delay, () => {
      const ver = v.localization!.versions[lang];
      if (!ver || ver.status !== 'running') return;
      // 配音素材沿用分离的替换语义：新 id，删旧行
      const old = assets.findIndex((a) => a.id === ver.voice_asset_id);
      if (old >= 0) assets.splice(old, 1);
      const label = LOCALIZE_OPTIONS.target_langs.find((t) => t.code === lang)?.label ?? lang;
      const asset: Asset = {
        id: nid('a'),
        type: 'audio',
        kind: 'audio',
        status: 'ready',
        name: `${v.name.replace(/\.[a-z0-9]+$/i, '')} · ${label}配音.m4a`,
        url: toneWav(v.duration, 440),
        duration: v.duration,
        has_audio: true,
        source: 'derived',
        derived_from: { video_id: v.id, video_name: v.name, stem: 'dubbed', lang },
        created_at: now(),
      };
      assets.push(asset);
      const longest = Math.max(0, ...ver.cues.map((c) => c.translated.length));
      Object.assign(ver, { status: 'done', stage: null, error: null, voice_asset_id: asset.id, dub: true, voice_stale: false, warnings: longest > 30 ? ['第 2 句译文较长，已按 1.3 倍速压缩仍略超下一句起点'] : [], updated_at: now() });
    });
  }
}

function stickerImage(text: string, color: string): { url: string; width: number; height: number } {
  const w = 600;
  const h = 240;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 60);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 110px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 6);
  return { url: c.toDataURL('image/png'), width: w, height: h };
}

// ---- 内存数据 ----
const batches: Batch[] = [];
const videos: Video[] = [];
const assets: Asset[] = [];
const jobs: Job[] = [];

const safeZones: SafeZone[] = [
  {
    key: 'generic-vertical',
    name: '通用竖版',
    aspect: '9:16',
    overlay_url: '/api/overlays/generic-vertical.png',
    inner: { label: '安全区（保守）', x: 0.06, y: 0.12, w: 0.76, h: 0.62 },
    outer: { label: '安全区（宽松）', x: 0.03, y: 0.08, w: 0.82, h: 0.7 },
    zones: [
      { label: '顶部状态栏 / 标题', x: 0, y: 0, w: 1, h: 0.08 },
      { label: '右侧互动区', x: 0.85, y: 0.35, w: 0.15, h: 0.35 },
      { label: '底部文案 / 按钮', x: 0, y: 0.78, w: 1, h: 0.22 },
    ],
  },
  {
    key: 'douyin',
    name: '巨量 / 抖音',
    aspect: '9:16',
    overlay_url: '/api/overlays/douyin.png',
    inner: { label: '安全区（保守）', x: 0.06, y: 0.14, w: 0.72, h: 0.54 },
    outer: { label: '安全区（宽松）', x: 0.03, y: 0.1, w: 0.79, h: 0.62 },
    zones: [
      { label: '顶部导航', x: 0, y: 0, w: 1, h: 0.1 },
      { label: '右侧互动区', x: 0.82, y: 0.4, w: 0.18, h: 0.38 },
      { label: '底部文案 / 按钮遮挡区', x: 0, y: 0.72, w: 0.82, h: 0.28 },
    ],
  },
  {
    key: 'kuaishou',
    name: '磁力 / 快手',
    aspect: '9:16',
    overlay_url: '/api/overlays/kuaishou.png',
    inner: { label: '安全区（保守）', x: 0.06, y: 0.13, w: 0.74, h: 0.58 },
    outer: { label: '安全区（宽松）', x: 0.03, y: 0.09, w: 0.81, h: 0.67 },
    zones: [
      { label: '顶部', x: 0, y: 0, w: 1, h: 0.09 },
      { label: '右侧', x: 0.84, y: 0.45, w: 0.16, h: 0.33 },
      { label: '底部', x: 0, y: 0.76, w: 1, h: 0.24 },
    ],
  },
  // 故意不带 overlay_url：用来验证「该预设无示意图，显示框线」的退路
  { key: 'meta', name: 'Meta Reels', aspect: '9:16', overlay_url: null, inner: null, outer: { label: '', x: 0.04, y: 0.1, w: 0.8, h: 0.65 }, zones: [{ label: '底部文案', x: 0, y: 0.75, w: 0.8, h: 0.25 }, { label: '右侧', x: 0.86, y: 0.5, w: 0.14, h: 0.3 }] },
];

/** mock 下 <img> 不经过 handler，所以把 overlay_url 直接换成生成的 data URL。 */
function safeZonesForClient(): SafeZone[] {
  return safeZones.map((z) => ({ ...z, overlay_url: z.overlay_url ? overlayImage(z) : null }));
}

// ---- 预设（localStorage 持久化） ----
function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Preset[];
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    /* ignore */
  }
  return [];
}
function savePresets() {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* ignore */
  }
}
const presets: Preset[] = loadPresets();

/**
 * style_only：按 id → 相同文字 匹配，只覆盖类型相关字段与 width / rotate / opacity。
 * 没匹配上的追加到末尾；遮盖层例外，插到目标第一个文字图层之前（保持压在字幕之下），与后端 apply.py 一致。
 */
function mergeLayersStyleOnly(target: Layer[], source: Layer[]): Layer[] {
  if (!target.length) return clone(source);
  const out = clone(target);
  const used = new Set<string>();
  for (const src of source) {
    let hit = out.find((l) => !used.has(l.id) && l.id === src.id);
    if (!hit && src.type === 'text') hit = out.find((l) => !used.has(l.id) && l.type === 'text' && l.text === src.text);
    if (!hit) {
      const firstText = src.type === 'mask' ? out.findIndex((l) => l.type === 'text') : -1;
      out.splice(firstText < 0 ? out.length : firstText, 0, clone(src));
      continue;
    }
    used.add(hit.id);
    const s = clone(src);
    hit.width = s.width;
    hit.rotate = s.rotate;
    hit.opacity = s.opacity;
    if (s.type === 'sticker' && hit.type === 'sticker') {
      // 与后端 apply.py 的 _STYLE_KEYS_BY_TYPE 一致（此前这里漏了 playback / mix_audio）
      hit.asset_id = s.asset_id;
      for (const k of ['playback', 'mix_audio', 'source_in', 'source_out'] as const) {
        if (s[k] !== undefined) (hit[k] as unknown) = s[k];
        else delete hit[k];
      }
    }
    else if (s.type === 'text' && hit.type === 'text') {
      hit.text = s.text;
      if (s.spans) hit.spans = s.spans;
      else delete hit.spans;
      hit.style = s.style;
      hit.image_url = s.image_url;
      hit.image_size = s.image_size;
    } else if (s.type === 'mask' && hit.type === 'mask') {
      hit.mode = s.mode;
      hit.height = s.height;
      if (s.blur !== undefined) hit.blur = s.blur;
      else delete hit.blur;
      if (s.color !== undefined) hit.color = s.color;
      else delete hit.color;
    } else {
      // 类型不同：整个换成源图层，但保留目标的位置 / 时段
      const { anchor, margin, t } = hit;
      const idx = out.indexOf(hit);
      out[idx] = { ...s, id: hit.id, anchor, margin, t };
    }
  }
  return out;
}

function makeVideo(batchId: string, name: string, order: number, duration: number, file?: File): Video {
  const hue = (order * 47) % 360;
  const id = nid('v');
  return {
    id,
    batch_id: batchId,
    name,
    order,
    status: 'ready',
    error: null,
    width: 1080,
    height: 1920,
    duration,
    fps: 30,
    has_audio: true,
    source_url: file ? URL.createObjectURL(file) : '',
    proxy_url: file ? URL.createObjectURL(file) : '',
    poster_url: gradientImage(180, 320, hue, `V${order}`),
    sprite: spriteImage(duration, hue),
    edit_spec: null,
    edited: false,
    render_status: 'idle',
    updated_at: now(),
  };
}

function recount(batch: Batch) {
  const vs = videos.filter((v) => v.batch_id === batch.id);
  const sc = { preparing: 0, ready: 0, edited: 0, rendering: 0, done: 0, failed: 0 };
  for (const v of vs) {
    if (v.status === 'preparing') sc.preparing++;
    else if (v.status === 'failed' || v.render_status === 'failed') sc.failed++;
    else if (v.render_status === 'queued' || v.render_status === 'running') sc.rendering++;
    else if (v.render_status === 'done') sc.done++;
    else if (v.edited) sc.edited++;
    else sc.ready++;
  }
  batch.video_count = vs.length;
  batch.status_counts = sc;
}

function seed() {
  const b: Batch = {
    id: 'b_demo01',
    name: '9 月新手引导 A/B',
    created_at: now(),
    video_count: 0,
    status_counts: { preparing: 0, ready: 0, edited: 0, rendering: 0, done: 0, failed: 0 },
  };
  batches.push(b);
  const names = ['V01 新手引导A.mp4', 'V02 新手引导B.mp4', 'V03 限时活动.mov', 'V04 口播版.mp4'];
  names.forEach((n, i) => videos.push(makeVideo(b.id, n, i + 1, [24.6, 18.2, 31.0, 15.5][i])));
  videos[0].edit_spec = {
    spec_version: 1,
    trim: { remove: [[3.2, 5.8]] },
    layers: [],
    outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'blur' }],
  };
  videos[0].edited = true;
  recount(b);

  const s1 = stickerImage('限时免费', '#d9481f');
  const s2 = stickerImage('新人礼包', '#2f6fdd');
  assets.push(
    { id: 'a_demo1', type: 'sticker', name: '限时免费.png', url: s1.url, width: s1.width, height: s1.height, source: 'upload', created_at: now() },
    { id: 'a_demo2', type: 'sticker', name: '新人礼包.png', url: s2.url, width: s2.width, height: s2.height, source: 'builtin', created_at: now() },
  );
}

function tickJobs() {
  for (const j of jobs) {
    if (j.status === 'queued') {
      j.status = 'running';
      j.started_at = now();
      continue;
    }
    if (j.status === 'running') {
      j.progress = Math.min(100, j.progress + 12 + Math.round(Math.random() * 10));
      if (j.progress >= 100) {
        const v = videos.find((x) => x.id === j.video_id);
        if (v && v.name.includes('V03') && !j.error && Math.random() < 0.5) {
          j.status = 'failed';
          j.error = '模拟失败：ffmpeg 退出码 1（mock）';
        } else {
          j.status = 'done';
          j.finished_at = now();
          const dims: Record<string, [number, number]> = { '9x16': [1080, 1920], '1x1': [1080, 1080], '4x5': [1080, 1350], '16x9': [1920, 1080] };
          const configured = v?.edit_spec?.outputs.find((o) => o.variant_key === j.variant_key);
          const [w, h] = configured?.variant_key === 'custom' && configured.width && configured.height
            ? [configured.width, configured.height] : dims[j.variant_key] ?? [1080, 1920];
          j.output_url = v?.proxy_url || '';
          j.output = { width: w, height: h, duration: v?.duration ?? 0, size: 5832211, codec: 'h264/aac' };
          // 同 worker（契约 §1 Job output.audio，HIG-26）：spec 带 audio 块时记下实际混进的音轨，素材不在的算跳过
          const audio = v?.edit_spec?.audio;
          if (audio) {
            // 关掉眼睛的音轨（HIG-33）既不混入也不算跳过
            const found = audio.tracks.filter((t) => !t.hidden).map((t) => ({ t, a: assets.find((x) => x.id === t.asset_id && x.type === 'audio') }));
            const skipped = found.filter((x) => !x.a).map((x) => x.t.id);
            j.output.audio = {
              source_volume: v?.has_audio && !audio.source_hidden ? audio.source_volume : 0,
              source_mute: audio.source_mute?.length ?? 0,
              tracks: found.flatMap(({ t, a }) => (a ? [{ id: t.id, asset_id: t.asset_id, name: a.name, role: t.role ?? 'bgm' }] : [])),
              skipped,
            };
            if (skipped.length) j.error = '警告：' + skipped.map((id) => `音轨 ${id}：音频素材不存在或未就绪，已跳过`).join('；');
          }
          j.callback = {
            session_id: j.batch_id,
            source_id: j.video_id,
            variant_key: j.variant_key,
            status: 'done',
            output: { url: `https://hitgo.example/media/outputs/${j.id}.mp4`, ...j.output },
            edit_spec: v?.edit_spec ?? null,
            operator: { id: 'demo', name: '演示用户' },
            idempotency_key: `${j.batch_id}:${j.video_id}:${j.variant_key}:1`,
          };
        }
      }
    }
  }
  for (const v of videos) {
    const js = jobs.filter((j) => j.video_id === v.id);
    if (!js.length) continue;
    const latest = js.slice(-Math.max(1, v.edit_spec?.outputs.length ?? 1));
    if (latest.some((j) => j.status === 'running')) v.render_status = 'running';
    else if (latest.some((j) => j.status === 'queued')) v.render_status = 'queued';
    else if (latest.some((j) => j.status === 'failed')) v.render_status = 'failed';
    else v.render_status = 'done';
  }
  for (const b of batches) recount(b);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

async function handler(method: string, url: string, body?: unknown): Promise<unknown> {
  const body_ = body;
  await new Promise((r) => setTimeout(r, 80));
  const [path, qs] = url.split('?');
  const q = new URLSearchParams(qs ?? '');
  const m = (re: RegExp) => path.match(re);
  let mm: RegExpMatchArray | null;

  if (path === '/api/auth') return method === 'GET' ? { required: false, ok: true } : {};
  if (path === '/api/safe-zones') return safeZonesForClient();
  if ((mm = m(/^\/api\/overlays\/([^/]+)\.png$/))) {
    const z = safeZones.find((x) => x.key === mm![1] && x.overlay_url);
    if (!z) throw new ApiError(404, '示意图不存在');
    return overlayImage(z);
  }

  if (path === '/api/presets') {
    const type = method === 'GET' ? q.get('type') : (body as { type?: string }).type;
    if (type !== 'text_style') throw new ApiError(400, 'type 只支持 text_style');
    if (method === 'GET') return clone([...presets].reverse());
    const { name, data } = body as { name?: string; data?: Record<string, unknown> };
    const nm = (name ?? '').trim();
    if (nm.length < 1 || nm.length > 40) throw new ApiError(400, '名称需 1–40 字符');
    const p: Preset = { id: nid('p'), type: 'text_style', name: nm, data: clone(data ?? {}), created_at: now() };
    presets.push(p);
    savePresets();
    return clone(p);
  }
  if ((mm = m(/^\/api\/presets\/([^/]+)$/))) {
    const i = presets.findIndex((p) => p.id === mm![1]);
    if (i < 0) throw new ApiError(404, '预设不存在');
    presets.splice(i, 1);
    savePresets();
    return undefined;
  }

  if (path === '/api/batches') {
    if (method === 'GET') return clone([...batches].reverse());
    const b: Batch = { id: nid('b'), name: (body as { name: string }).name || '未命名批次', created_at: now(), video_count: 0, status_counts: { preparing: 0, ready: 0, edited: 0, rendering: 0, done: 0, failed: 0 } };
    batches.push(b);
    return clone(b);
  }
  if ((mm = m(/^\/api\/batches\/([^/]+)$/))) {
    const b = batches.find((x) => x.id === mm![1]);
    if (!b) throw new ApiError(404, '批次不存在');
    if (method === 'PATCH') {
      const nm = ((body as { name?: string }).name ?? '').trim();
      if (nm.length < 1 || nm.length > 255) throw new ApiError(400, '名称不能为空');
      b.name = nm;
      return clone(b);
    }
    if (method === 'DELETE') {
      batches.splice(batches.indexOf(b), 1);
      for (let i = videos.length - 1; i >= 0; i--) if (videos[i].batch_id === b.id) videos.splice(i, 1);
      return undefined;
    }
    const detail: BatchDetail = { ...b, videos: videos.filter((v) => v.batch_id === b.id) };
    return clone(detail);
  }
  if ((mm = m(/^\/api\/batches\/([^/]+)\/videos$/))) {
    const b = batches.find((x) => x.id === mm![1]);
    if (!b) throw new ApiError(404, '批次不存在');
    const form = body as FormData;
    const files = form.getAll('files') as File[];
    const created: Video[] = [];
    let order = videos.filter((v) => v.batch_id === b.id).length;
    for (const f of files) {
      order += 1;
      // 图片（HIG-50）：后端转成 5 秒静止源片；mock 里直接把图当海报、时长 5 秒、无音轨
      const isImage = /\.(jpe?g|png)$/i.test(f.name);
      const v = makeVideo(b.id, f.name, order, isImage ? 5 : 20, isImage ? undefined : f);
      if (isImage) {
        v.kind = 'image';
        v.has_audio = false;
        v.poster_url = URL.createObjectURL(f);
      }
      v.status = 'preparing';
      videos.push(v);
      created.push(v);
      setTimeout(() => {
        v.status = 'ready';
        recount(b);
      }, 1500);
    }
    recount(b);
    return clone(created);
  }
  if ((mm = m(/^\/api\/batches\/([^/]+)\/blank$/))) {
    // 空白素材（HIG-50）：纯色源片，mock 里用海报色块代替
    const b = batches.find((x) => x.id === mm![1]);
    if (!b) throw new ApiError(404, '批次不存在');
    const { name, color = '#000000', duration = 10, aspect = '9:16' } = (body ?? {}) as BlankVideoIn;
    if (!(duration > 0 && duration <= 600)) throw new ApiError(400, 'duration 必须在 (0, 600] 秒内');
    const order = videos.filter((v) => v.batch_id === b.id).length + 1;
    const v = makeVideo(b.id, name || `空白素材 ${order}`, order, duration);
    const size = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] }[aspect] ?? [1080, 1920];
    v.kind = 'blank';
    v.has_audio = false;
    v.width = size[0];
    v.height = size[1];
    v.poster_url = solidImage(180, Math.round((180 * size[1]) / size[0]), color);
    v.status = 'preparing';
    videos.push(v);
    setTimeout(() => {
      v.status = 'ready';
      recount(b);
    }, 800);
    recount(b);
    return clone(v);
  }
  if ((mm = m(/^\/api\/batches\/([^/]+)\/apply$/))) {
    const { source_video_id, target_video_ids, modules, layer_mode } = body as { source_video_id: string; target_video_ids: string[]; modules: string[]; layer_mode?: ApplyLayerMode };
    const src = videos.find((v) => v.id === source_video_id);
    if (!src?.edit_spec) throw new ApiError(400, '源视频没有编辑配置');
    if (layer_mode && layer_mode !== 'replace' && layer_mode !== 'style_only') throw new ApiError(400, 'layer_mode 只支持 replace | style_only');
    const out: Video[] = [];
    for (const id of target_video_ids) {
      const t = videos.find((v) => v.id === id);
      if (!t || t.id === src.id) continue;
      const spec: EditSpec = t.edit_spec ? clone(t.edit_spec) : { spec_version: 1, trim: { remove: [] }, layers: [], outputs: [{ variant_key: '9x16', aspect: '9:16', fill: 'blur' }] };
      if (modules.includes('trim')) spec.trim = { remove: clone(src.edit_spec.trim.remove).filter(([a]) => a < t.duration).map(([a, b]) => [a, Math.min(b, t.duration)] as [number, number]) };
      if (modules.includes('layers')) spec.layers = layer_mode === 'style_only' ? mergeLayersStyleOnly(spec.layers, src.edit_spec.layers) : clone(src.edit_spec.layers);
      if (modules.includes('outputs')) spec.outputs = clone(src.edit_spec.outputs);
      if (modules.includes('audio')) {
        if (src.edit_spec.audio) spec.audio = clone(src.edit_spec.audio);
        else delete spec.audio;
      }
      if (modules.includes('cover')) {
        if (src.edit_spec.cover) spec.cover = clone(src.edit_spec.cover);
        else delete spec.cover;
      }
      t.edit_spec = spec;
      t.edited = true;
      t.updated_at = now();
      out.push(t);
    }
    for (const b of batches) recount(b);
    return clone(out);
  }
  if ((mm = m(/^\/api\/batches\/([^/]+)\/jobs$/))) return clone(jobs.filter((j) => j.batch_id === mm![1]).reverse());
  if ((mm = m(/^\/api\/batches\/([^/]+)\/outputs$/))) {
    const bid = mm[1];
    const done = jobs.filter((j) => j.batch_id === bid && j.status === 'done');
    done.sort((a, b) => {
      const va = videos.find((v) => v.id === a.video_id)?.order ?? 0;
      const vb = videos.find((v) => v.id === b.video_id)?.order ?? 0;
      return va - vb || a.variant_key.localeCompare(b.variant_key);
    });
    return clone(done);
  }
  if (path === '/api/outputs') {
    const limit = Number(q.get('limit') ?? 100);
    const offset = Number(q.get('offset') ?? 0);
    const term = (q.get('q') ?? '').trim().toLowerCase();
    const langParam = q.get('lang') ?? '';
    const done = jobs
      .filter((j) => j.status === 'done')
      .map((j) => ({
        ...j,
        batch_name: batches.find((b) => b.id === j.batch_id)?.name ?? null,
        video_name: videos.find((v) => v.id === j.video_id)?.name ?? null,
      }))
      .filter((j) => !term || [j.name, j.batch_name, j.video_name, j.lang ? langLabel(null, j.lang) : ''].some((s) => (s ?? '').toLowerCase().includes(term)))
      .filter((j) => !langParam || (langParam === 'original' ? !j.lang : j.lang === langParam));
    done.sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at) || b.id.localeCompare(a.id));
    return clone(done.slice(offset, offset + limit));
  }
  if ((mm = m(/^\/api\/videos\/([^/]+)\/spec$/))) {
    const v = videos.find((x) => x.id === mm![1]);
    if (!v) throw new ApiError(404, '视频不存在');
    const spec = (body as { edit_spec: EditSpec }).edit_spec;
    if (!spec || !Array.isArray(spec.outputs) || spec.outputs.length === 0) throw new ApiError(400, 'outputs 至少一个');
    v.edit_spec = clone(spec);
    v.edited = true;
    v.updated_at = now();
    for (const b of batches) recount(b);
    return clone(v);
  }
  if ((mm = m(/^\/api\/videos\/([^/]+)\/separate$/))) {
    const v = videos.find((x) => x.id === mm![1]);
    if (!v) throw new ApiError(404, '视频不存在');
    if (v.status !== 'ready') throw new ApiError(400, '视频尚未预处理完成，暂时不能分离');
    if (!v.has_audio) throw new ApiError(400, '源视频没有音轨，没有可分离的内容');
    if (v.separation && (v.separation.status === 'queued' || v.separation.status === 'running')) throw new ApiError(409, '这条视频正在分离中，请等它完成');
    const model = ((body as { model?: SeparationModel } | undefined)?.model ?? 'htdemucs') as SeparationModel;
    v.separation = { ...(v.separation ?? {}), status: 'queued', model, error: null, updated_at: now() };
    // 模拟 separator worker：2 秒后 running，再 3 秒 done，产出两条 derived 音频（合成的音，只为跑通链路）
    window.setTimeout(() => {
      if (!v.separation) return;
      v.separation = { ...v.separation, status: 'running', updated_at: now() };
      window.setTimeout(() => {
        if (!v.separation) return;
        for (const id of [v.separation.vocals_asset_id, v.separation.instrumental_asset_id]) {
          const i = assets.findIndex((a) => a.id === id);
          if (i >= 0) assets.splice(i, 1);
        }
        const base = v.name.replace(/\.[a-z0-9]+$/i, '');
        const mk = (stem: 'vocals' | 'instrumental'): Asset => ({
          id: nid('a'),
          type: 'audio',
          kind: 'audio',
          status: 'ready',
          name: `${base} · ${stem === 'vocals' ? '人声' : '伴奏'}.m4a`,
          url: toneWav(v.duration, stem === 'vocals' ? 660 : 220),
          duration: v.duration,
          has_audio: true,
          source: 'derived',
          derived_from: { video_id: v.id, video_name: v.name, stem },
          created_at: now(),
        });
        const vocals = mk('vocals');
        const inst = mk('instrumental');
        assets.push(vocals, inst);
        v.separation = { status: 'done', model, error: null, vocals_asset_id: vocals.id, instrumental_asset_id: inst.id, updated_at: now() };
      }, 3000);
    }, 2000);
    return clone(v);
  }
  if (path === '/api/localize/options') return clone(LOCALIZE_OPTIONS);
  if ((mm = m(/^\/api\/tts\/preview\/([^/]+)\/([^/]+)$/))) {
    // 音色试听（HIG-42）：每个音色一个不同音高的 1.5 秒提示音，听得出换了
    const lang = decodeURIComponent(mm[1]);
    const voice = decodeURIComponent(mm[2]);
    const t = LOCALIZE_OPTIONS.target_langs.find((x) => x.code === lang);
    const idx = t?.voices.findIndex((v) => v.id === voice) ?? -1;
    if (idx < 0) throw new ApiError(400, '不支持的语言或音色');
    await new Promise((r) => setTimeout(r, 600));
    return toneWav(1.5, 220 + idx * 60);
  }
  if (path === '/api/tts') {
    // 朗读（HIG-50）：约每秒 4 个字的一段提示音，先 preparing 再 ready
    const { text, lang, voice, name } = body as TtsIn;
    const t = (text ?? '').trim();
    if (!t) throw new ApiError(400, '文案不能为空');
    const seconds = Math.max(1, Math.round((t.length / 4) * 10) / 10);
    const a: Asset = {
      id: nid('a'), type: 'audio', kind: 'audio', name: name || t.slice(0, 20), url: toneWav(seconds, 330),
      source: 'derived', status: 'preparing', derived_from: { stem: 'tts', lang, voice, text: t.slice(0, 40) }, created_at: now(),
    };
    assets.push(a);
    setTimeout(() => {
      a.duration = seconds;
      a.has_audio = true;
      a.status = 'ready';
    }, 1200);
    return clone(a);
  }
  if (path === '/api/highlight') {
    // 重点词（HIG-50）：mock 只按规则挑日期 / 数字 + 单位 / 金额 / 倍数
    const { text, max_phrases = 8 } = body as { text: string; max_phrases?: number };
    const re = /\d+月\d+日(?:至\d+月\d+日)?|\d{4}年|[¥￥$]\d+(?:\.\d+)?|\d+(?:\.\d+)?%|[一二三四五六七八九十两\d]+倍[\u4e00-\u9fff]{0,2}|[一二三四五六七八九十两\d]+(?:天|元|个|次|折|万|亿)/g;
    const phrases: HighlightPhrase[] = [];
    for (const mt of text.matchAll(re)) {
      if (phrases.length >= max_phrases) break;
      phrases.push({ text: mt[0], start: mt.index ?? 0, end: (mt.index ?? 0) + mt[0].length });
    }
    return { phrases };
  }
  if ((mm = m(/^\/api\/videos\/([^/]+)\/localize$/))) {
    const v = videos.find((x) => x.id === mm![1]);
    if (!v) throw new ApiError(404, '视频不存在');
    if (v.status !== 'ready') throw new ApiError(400, '视频尚未预处理完成，暂时不能改语言');
    if (!v.has_audio) throw new ApiError(400, '源视频没有音轨，没有可听写的内容');
    const body = (body_ as LocalizeIn | undefined) ?? { target_langs: [] };
    const targetLangs = Array.from(new Set(body.target_langs ?? []));
    if (targetLangs.length < 1 || targetLangs.length > 5) throw new ApiError(400, 'target_langs 需 1–5 种目标语言');
    const bad = targetLangs.find((l) => !LOCALIZE_OPTIONS.target_langs.some((t) => t.code === l));
    if (bad) throw new ApiError(400, `不支持的目标语言：${bad}`);
    const sourceLang = body.source_lang ?? 'auto';
    if (sourceLang !== 'auto' && !LOCALIZE_OPTIONS.source_langs.some((s) => s.code === sourceLang)) throw new ApiError(400, `不支持的源语言：${sourceLang}`);
    const loc = v.localization ?? { source_lang: sourceLang, transcript: null, versions: {} };
    const tActive = loc.transcript?.status === 'queued' || loc.transcript?.status === 'running';
    if (tActive) throw new ApiError(409, '这条视频正在听写中，请等它完成');
    if (targetLangs.some((l) => loc.versions[l]?.status === 'queued' || loc.versions[l]?.status === 'running')) throw new ApiError(409, '请求的语言版本正在生成中，请等它完成');
    if (sourceLang !== 'auto' || !loc.transcript || body.retranscribe) loc.source_lang = sourceLang;
    const sourceVoice = !!body.use_source_voice;
    if (sourceVoice) {
      const unclonable = targetLangs.find((l) => !CLONE_LANGS.includes(l));
      if (unclonable) throw new ApiError(400, `${LOCALIZE_OPTIONS.target_langs.find((t) => t.code === unclonable)?.label ?? unclonable}暂不支持用原声配音，请改用系统音色`);
    }
    for (const lang of targetLangs) {
      const voice = sourceVoice ? '' : (body.voices?.[lang] ?? LOCALIZE_OPTIONS.target_langs.find((t) => t.code === lang)?.voices[0]?.id ?? null);
      const prev = loc.versions[lang];
      const ver: LocalizationVersion = { status: 'queued', stage: null, voice, terms: clone(body.terms ?? []), cues: prev?.cues ?? [], stale: false, error: null, warnings: [], voice_asset_id: prev?.voice_asset_id ?? null, dub: body.dub ?? true, voice_stale: prev?.voice_stale ?? false, source_voice: sourceVoice, updated_at: now() };
      loc.versions[lang] = ver;
    }
    v.localization = loc;
    runLocalize(v, targetLangs, !!body.retranscribe);
    return clone(v);
  }
  if ((mm = m(/^\/api\/videos\/([^/]+)\/localize\/transcript$/))) {
    const v = videos.find((x) => x.id === mm![1]);
    if (!v) throw new ApiError(404, '视频不存在');
    const loc = v.localization;
    if (!loc?.transcript || loc.transcript.status !== 'done') throw new ApiError(400, '模板还没有听写完成');
    if (Object.values(loc.versions).some((x) => x.status === 'queued' || x.status === 'running')) throw new ApiError(409, '有语言版本正在生成中，请等它完成');
    const body = body_ as { cues: { i: number; text: string }[]; source_lang?: string };
    for (const e of body.cues ?? []) {
      const c = loc.transcript.cues.find((x) => x.i === e.i);
      if (c) c.text = e.text;
    }
    if (body.source_lang && body.source_lang !== 'auto') loc.source_lang = body.source_lang;
    loc.transcript.updated_at = now();
    for (const ver of Object.values(loc.versions)) ver.stale = true;
    return clone(v);
  }
  if ((mm = m(/^\/api\/videos\/([^/]+)\/localize\/versions\/([^/]+)$/))) {
    const v = videos.find((x) => x.id === mm![1]);
    if (!v) throw new ApiError(404, '视频不存在');
    const lang = mm[2];
    const ver = v.localization?.versions[lang];
    if (!ver) throw new ApiError(404, '没有这个语言的版本');
    if (ver.status === 'queued' || ver.status === 'running') throw new ApiError(409, '这个版本正在生成中，请等它完成');
    if (method === 'DELETE') {
      const i = assets.findIndex((a) => a.id === ver.voice_asset_id);
      if (i >= 0) assets.splice(i, 1);
      delete v.localization!.versions[lang];
      return undefined;
    }
    if (!ver.cues.length) throw new ApiError(400, '这个版本还没有译文，请先生成');
    const body = body_ as { cues: { i: number; translated: string }[]; voice?: string; use_source_voice?: boolean };
    const undubbed = !ver.voice_asset_id || !!ver.voice_stale;
    if (!(body.cues ?? []).length && !body.voice && body.use_source_voice === undefined && !undubbed) throw new ApiError(400, '没有改动的句子时必须指定音色');
    const sourceVoice = body.use_source_voice === undefined ? !!ver.source_voice && !body.voice : body.use_source_voice;
    if (sourceVoice && !CLONE_LANGS.includes(lang)) {
      throw new ApiError(400, `${LOCALIZE_OPTIONS.target_langs.find((t) => t.code === lang)?.label ?? lang}暂不支持用原声配音，请改用系统音色`);
    }
    for (const e of body.cues ?? []) {
      const c = ver.cues.find((x) => x.i === e.i);
      if (c) c.translated = e.translated;
    }
    if (sourceVoice) ver.voice = '';
    else if (body.voice) ver.voice = body.voice;
    else if (ver.source_voice) ver.voice = LOCALIZE_OPTIONS.target_langs.find((t) => t.code === lang)?.voices[0]?.id ?? null;
    Object.assign(ver, { status: 'queued', stage: 'tts', dub: true, source_voice: sourceVoice, error: null, warnings: [], updated_at: now() });
    runLocalize(v, [lang], false);
    return clone(v);
  }
  if ((mm = m(/^\/api\/videos\/([^/]+)$/))) {
    const v = videos.find((x) => x.id === mm![1]);
    if (!v) throw new ApiError(404, '视频不存在');
    if (method === 'PATCH') {
      const nm = ((body as { name?: string }).name ?? '').trim();
      if (nm.length < 1 || nm.length > 255) throw new ApiError(400, '名称不能为空');
      v.name = nm;
      v.updated_at = now();
      return clone(v);
    }
    if (method === 'DELETE') {
      if (jobs.some((j) => j.video_id === v.id && (j.status === 'queued' || j.status === 'running'))) throw new ApiError(409, '这条视频有进行中的渲染任务，等任务结束后再删除');
      videos.splice(videos.indexOf(v), 1);
      for (const b of batches) recount(b);
      return undefined;
    }
    return clone(v);
  }
  if (path === '/api/assets/upload-ticket' || /^\/api\/batches\/[^/]+\/upload-ticket$/.test(path)) {
    return { upload_url: null, ticket: null, expires_at: null };
  }
  if (path === '/api/assets') {
    if (method === 'GET') {
      const type = q.get('type');
      const source = q.get('source');
      return clone(assets.filter((a) => (!type || a.type === type) && (!source || a.source === source)));
    }
    const form = body as FormData;
    const type = form.get('type') as 'sticker' | 'font' | 'audio';
    const files = form.getAll('files') as File[];
    const created: Asset[] = [];
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a: Asset = { id: nid('a'), type, name: f.name, url, source: 'upload', created_at: now() };
      if (type === 'audio') {
        // 音频素材：后端只异步探测时长；这里用 <audio> 的 loadedmetadata 模拟
        a.kind = 'audio';
        a.status = 'preparing';
        void probeAudio(a, url);
      } else if (type !== 'sticker') {
        a.family = f.name.replace(/\.[a-z0-9]+$/i, '');
      } else if (/\.(mp4|mov|webm)$/i.test(f.name)) {
        // 视频贴纸：和后端一样先返回 preparing，稍后由 GET /api/assets/{id} 轮询到 ready
        a.kind = 'video';
        a.status = 'preparing';
        void probeVideo(a, url);
      } else {
        a.kind = 'image';
        a.status = 'ready';
        const dims = await new Promise<[number, number]>((res) => {
          const img = new Image();
          img.onload = () => res([img.naturalWidth, img.naturalHeight]);
          img.onerror = () => res([600, 240]);
          img.src = url;
        });
        a.width = dims[0];
        a.height = dims[1];
      }
      assets.push(a);
      created.push(a);
    }
    return clone(created);
  }
  if ((mm = m(/^\/api\/assets\/([^/]+)$/))) {
    const i = assets.findIndex((a) => a.id === mm![1]);
    if (method === 'GET') return i >= 0 ? clone(assets[i]) : undefined;
    if (i >= 0) {
      if (assets[i].source !== 'upload' && assets[i].source !== 'derived') throw new ApiError(400, '只能删除自己上传或分离出来的素材');
      assets.splice(i, 1);
    }
    return undefined;
  }
  if (path === '/api/uploads/layer-image') {
    const form = body as FormData;
    const file = form.get('file') as Blob;
    const url = URL.createObjectURL(file);
    const dims = await new Promise<[number, number]>((res) => {
      const img = new Image();
      img.onload = () => res([img.naturalWidth, img.naturalHeight]);
      img.onerror = () => res([0, 0]);
      img.src = url;
    });
    return { url, width: dims[0], height: dims[1] };
  }
  if (path === '/api/render') {
    const { video_ids, items, name, variant_keys } = body as { video_ids?: string[]; items?: { video_id: string; lang?: string | null; edit_spec?: EditSpec }[]; name?: string; variant_keys?: string[] };
    const created: Job[] = [];
    for (const item of items ?? (video_ids ?? []).map((video_id) => ({ video_id, lang: null, edit_spec: undefined }))) {
      const v = videos.find((x) => x.id === item.video_id);
      const spec = item.edit_spec ?? v?.edit_spec;
      if (!v || !spec) continue;
      const missing = (variant_keys ?? []).filter((k) => !spec.outputs.some((o) => o.variant_key === k));
      if (missing.length) throw new ApiError(400, `视频 ${v.name} 的编辑参数里没有输出 ${missing.join(', ')}`);
      for (const o of spec.outputs.filter((x) => !variant_keys || variant_keys.includes(x.variant_key))) {
        const j: Job = { id: nid('j'), batch_id: v.batch_id, video_id: v.id, variant_key: o.variant_key, name: name?.trim() || null, lang: item.lang ?? null, status: 'queued', progress: 0, error: null, output_url: null, output: null, callback: null, created_at: now(), started_at: null, finished_at: null };
        jobs.push(j);
        created.push(j);
      }
      v.render_status = 'queued';
    }
    return clone(created);
  }
  if (path === '/api/jobs') {
    const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
    return clone(jobs.filter((j) => ids.includes(j.id)));
  }
  if ((mm = m(/^\/api\/jobs\/([^/]+)\/retry$/))) {
    const j = jobs.find((x) => x.id === mm![1]);
    if (!j) throw new ApiError(404, '任务不存在');
    if (j.status !== 'failed') throw new ApiError(409, '只有失败的任务才能重试');
    j.status = 'queued';
    j.progress = 0;
    j.error = 'retried';
    return clone(j);
  }
  if ((mm = m(/^\/api\/jobs\/([^/]+)$/))) {
    const j = jobs.find((x) => x.id === mm![1]);
    if (!j) throw new ApiError(404, '任务不存在');
    return clone(j);
  }
  throw new ApiError(404, `mock 未实现：${method} ${url}`);
}

export function setupMocks() {
  seed();
  setInterval(tickJobs, 700);
  installMock(handler);
  console.info('[HitGO] mock 模式已启用（VITE_MOCK=1）');
}

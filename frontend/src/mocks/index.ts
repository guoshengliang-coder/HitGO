// 开发用内存 mock（VITE_MOCK=1）。不依赖后端 / ffmpeg，让 UI 可以独立跑起来。
// 只覆盖契约中的路由，数据保存在内存里，刷新即重置。
// 上传的视频文件会用 object URL 作为 proxy_url，可真实播放；内置示例视频没有文件，
// 播放器会退回到"合成时钟"模式（见 lib/player.ts）。

import { installMock, ApiError, type ApplyLayerMode } from '../api';
import type { Asset, Batch, BatchDetail, EditSpec, Job, Layer, Preset, SafeZone, SeparationModel, Video } from '../types';

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

/** style_only：按 id → 相同文字 匹配，只覆盖类型相关字段与 width / rotate / opacity。 */
function mergeLayersStyleOnly(target: Layer[], source: Layer[]): Layer[] {
  if (!target.length) return clone(source);
  const out = clone(target);
  const used = new Set<string>();
  for (const src of source) {
    let hit = out.find((l) => !used.has(l.id) && l.id === src.id);
    if (!hit && src.type === 'text') hit = out.find((l) => !used.has(l.id) && l.type === 'text' && l.text === src.text);
    if (!hit) {
      out.push(clone(src));
      continue;
    }
    used.add(hit.id);
    const s = clone(src);
    hit.width = s.width;
    hit.rotate = s.rotate;
    hit.opacity = s.opacity;
    if (s.type === 'sticker' && hit.type === 'sticker') hit.asset_id = s.asset_id;
    else if (s.type === 'text' && hit.type === 'text') {
      hit.text = s.text;
      if (s.spans) hit.spans = s.spans;
      else delete hit.spans;
      hit.style = s.style;
      hit.image_url = s.image_url;
      hit.image_size = s.image_size;
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
          const [w, h] = dims[j.variant_key] ?? [1080, 1920];
          j.output_url = v?.proxy_url || '';
          j.output = { width: w, height: h, duration: v?.duration ?? 0, size: 5832211, codec: 'h264/aac' };
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
      const v = makeVideo(b.id, f.name, order, 20, f);
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
  if ((mm = m(/^\/api\/videos\/([^/]+)$/))) {
    const v = videos.find((x) => x.id === mm![1]);
    if (!v) throw new ApiError(404, '视频不存在');
    if (method === 'DELETE') {
      videos.splice(videos.indexOf(v), 1);
      for (const b of batches) recount(b);
      return undefined;
    }
    return clone(v);
  }
  if (path === '/api/assets/upload-ticket') {
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
    const { video_ids } = body as { video_ids: string[] };
    const created: Job[] = [];
    for (const vid of video_ids) {
      const v = videos.find((x) => x.id === vid);
      if (!v?.edit_spec) continue;
      for (const o of v.edit_spec.outputs) {
        const j: Job = { id: nid('j'), batch_id: v.batch_id, video_id: v.id, variant_key: o.variant_key, status: 'queued', progress: 0, error: null, output_url: null, output: null, callback: null, created_at: now(), started_at: null, finished_at: null };
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

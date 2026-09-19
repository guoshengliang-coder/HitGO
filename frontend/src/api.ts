// 类型化 API 客户端，路由与契约第 3 节一一对应。
// VITE_MOCK=1 时由 src/mocks 提供内存实现（见 request()）。

import type { Asset, AssetType, Batch, BatchDetail, BlankVideoIn, EditSpec, HighlightOut, Job, LocalizeIn, LocalizeOptions, Preset, PresetType, SafeZone, ScreenTextIn, ScreenTextOptions, TtsIn, UploadTicket, Video, SeparationModel } from './types';
import { oversizedUpload } from './lib/assets';

export const MOCK = import.meta.env.VITE_MOCK === '1';

// Cloudflare's 100 MB body limit includes multipart framing. Keep margin so a
// large asset never silently falls back to the proxied origin when ticketing fails.
const DIRECT_ASSET_UPLOAD_MIN_BYTES = 90 * 1024 * 1024;

/** Browser-decodable PNGs which Pillow rejects can be rewritten as plain PNGs once. */
async function reencodeRejectedPng(files: File[], error: unknown): Promise<File[] | null> {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  const index = files.findIndex((file) => file.name.toLowerCase().endsWith('.png') && error.message.startsWith(`${file.name}：无法解析图片`));
  if (index < 0) return null;
  const file = files[index];
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return null;
      const rewritten = new File([blob], file.name, { type: 'image/png' });
      const tooBig = oversizedUpload('sticker', [rewritten]);
      if (tooBig) throw new ApiError(400, `${file.name}：重新编码后${tooBig}`, 'UPLOAD_IMAGE_TOO_LARGE');
      return files.map((item, i) => i === index ? rewritten : item);
    } finally {
      bitmap.close();
    }
  } catch (decodeError) {
    if (decodeError instanceof ApiError) throw decodeError;
    throw new ApiError(400, `${file.name}：浏览器也无法读取图片内容，请重新导出为 PNG 后上传`, 'UPLOAD_IMAGE_DECODE_FAILED');
  }
}

/** 批量应用 layers 模块的方式：replace 整体替换；style_only 只覆盖样式，保留目标的 anchor / margin / t。 */
export type ApplyLayerMode = 'replace' | 'style_only';

/** POST /api/render 的一项（HIG-43）：lang null = 原版；edit_spec 缺省 = 用视频上保存的 spec。 */
export interface RenderItem {
  video_id: string;
  lang: string | null;
  edit_spec?: EditSpec;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  diagnosticId?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Put the stable code next to the human-readable cause when an upload fails. */
export function uploadErrorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}${error.code ? `（错误码：${error.code}）` : ''}${error.diagnosticId ? `（诊断编号：${error.diagnosticId}）` : ''}`;
  return error instanceof Error ? error.message : String(error);
}

type UploadStage = 'ticket' | 'upload';
type UploadChannel = 'direct' | 'same_origin' | 'unknown';

function reportVideoUploadFailure(report: {
  request_id: string; batch_id: string; stage: UploadStage; channel: UploadChannel;
  code: string; status: number; file_count: number; total_bytes: number; elapsed_ms: number;
}): void {
  if (MOCK) return;
  // A small same-origin request can still reach the app when the CDN rejects a large body.
  // Reporting must never replace or delay the original upload error.
  try {
    void fetch('/api/uploads/diagnostic', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report), keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* offline or browser shutdown: the error and ID remain visible to the user */
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let mockHandler: ((method: Method, url: string, body?: unknown) => Promise<unknown>) | null = null;
export function installMock(handler: typeof mockHandler) {
  mockHandler = handler;
}

async function request<T>(method: Method, url: string, body?: unknown): Promise<T> {
  if (MOCK && mockHandler) return (await mockHandler(method, url, body)) as T;
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = `请求失败（${res.status}）`;
    let code: string | undefined;
    try {
      const j = await res.json();
      if (j && typeof j.detail === 'string') detail = j.detail;
      else if (j && j.detail) detail = JSON.stringify(j.detail);
      if (j && typeof j.code === 'string') code = j.code;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET 一段音频并给出能播的 URL：mock 直接回 data URL；真实后端把 wav 读成 blob 转 object URL，错误按 JSON detail 报。 */
async function requestAudioUrl(url: string): Promise<string> {
  if (MOCK && mockHandler) return (await mockHandler('GET', url)) as string;
  const res = await fetch(url);
  if (!res.ok) {
    let detail = `请求失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j && typeof j.detail === 'string') detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  return URL.createObjectURL(await res.blob());
}

/** 带上传进度的 multipart 上传（XMLHttpRequest）。 */
export function uploadWithProgress<T>(
  url: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
  headers: Record<string, string> = {},
): Promise<T> {
  if (MOCK && mockHandler) {
    onProgress?.(0.5);
    return mockHandler('POST', url, form).then((r) => {
      onProgress?.(1);
      return r as T;
    });
  }
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch (e) {
          reject(new ApiError(xhr.status, '上传已发送，但无法解析服务端响应', 'UPLOAD_RESPONSE_INVALID'));
        }
      } else {
        let detail = xhr.status === 413 ? '上传请求超过当前通道的大小限制，请检查上传服务配置' : `上传失败（${xhr.status}）`;
        let code = xhr.status === 413 ? 'UPLOAD_REQUEST_TOO_LARGE' : `UPLOAD_HTTP_${xhr.status}`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
          if (typeof j?.code === 'string') code = j.code;
        } catch {
          /* ignore */
        }
        reject(new ApiError(xhr.status, detail, code));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, '网络错误：上传被中断，请检查网络后重试', 'UPLOAD_NETWORK_ERROR'));
    xhr.onabort = () => reject(new ApiError(0, '上传已取消', 'UPLOAD_ABORTED'));
    xhr.send(form);
  });
}

export const api = {
  // 认证
  authStatus: () => request<{ required: boolean; ok: boolean }>('GET', '/api/auth'),
  authLogin: (code: string) => request<unknown>('POST', '/api/auth', { code }),

  // 批次
  listBatches: () => request<Batch[]>('GET', '/api/batches'),
  createBatch: (name: string) => request<Batch>('POST', '/api/batches', { name }),
  getBatch: (id: string) => request<BatchDetail>('GET', `/api/batches/${id}`),
  renameBatch: (id: string, name: string) => request<Batch>('PATCH', `/api/batches/${id}`, { name }),
  deleteBatch: (id: string) => request<void>('DELETE', `/api/batches/${id}`),
  uploadVideos: async (batchId: string, files: File[], onProgress?: (f: number) => void) => {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    let stage: UploadStage = 'ticket';
    let channel: UploadChannel = 'unknown';
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    try {
      const target = await request<UploadTicket>('POST', `/api/batches/${batchId}/upload-ticket`);
      if (target?.upload_url && target.ticket) {
        channel = 'direct';
        stage = 'upload';
        return await uploadWithProgress<Video[]>(target.upload_url, form, onProgress, {
          'X-Upload-Ticket': target.ticket, 'X-Upload-Request-ID': requestId,
        });
      }
      if (target?.upload_url === null && target.ticket === null) {
        channel = 'same_origin';
        stage = 'upload';
        return await uploadWithProgress<Video[]>(`/api/batches/${batchId}/videos`, form, onProgress, {
          'X-Upload-Request-ID': requestId,
        });
      }
      throw new ApiError(0, '上传服务返回的凭证不完整，请稍后重试', 'UPLOAD_TICKET_INVALID');
    } catch (error) {
      const failure = error instanceof ApiError
        ? error
        : new ApiError(0, stage === 'ticket' ? '无法取得上传凭证，请检查网络后重试' : '上传失败，请稍后重试',
          stage === 'ticket' ? 'UPLOAD_TICKET_REQUEST_FAILED' : 'UPLOAD_UNKNOWN_ERROR');
      failure.code ??= stage === 'ticket' ? 'UPLOAD_TICKET_REQUEST_FAILED' : 'UPLOAD_UNKNOWN_ERROR';
      failure.diagnosticId = requestId;
      reportVideoUploadFailure({
        request_id: requestId, batch_id: batchId, stage, channel,
        code: failure.code, status: failure.status, file_count: files.length,
        total_bytes: files.reduce((total, file) => total + file.size, 0),
        elapsed_ms: Math.max(0, Date.now() - started),
      });
      throw failure;
    }
  },
  /** 空白素材（HIG-50，契约 §3）：201 Video（kind = blank），worker 生成源片，之后轮询 GET /api/videos/{id}。 */
  createBlankVideo: (batchId: string, body: BlankVideoIn) => request<Video>('POST', `/api/batches/${batchId}/blank`, body),
  applySpec: (batchId: string, body: { source_video_id: string; target_video_ids: string[]; modules: string[]; layer_mode?: ApplyLayerMode }) =>
    request<Video[]>('POST', `/api/batches/${batchId}/apply`, body),
  batchJobs: (batchId: string) => request<Job[]>('GET', `/api/batches/${batchId}/jobs`),
  batchOutputs: (batchId: string) => request<Job[]>('GET', `/api/batches/${batchId}/outputs`),
  /** 跨批次的已完成产物，按完成时间倒序；q 按导出名称 / 批次名 / 视频名 / 语言名搜索（HIG-27）；lang 只要某个语言，original = 原版（HIG-43）。 */
  allOutputs: (limit = 100, offset = 0, q = '', lang = '') =>
    request<Job[]>('GET', `/api/outputs?limit=${limit}&offset=${offset}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`),
  downloadMediaFiles: async (options: Record<string, unknown>): Promise<void> => {
    const response = await fetch('/api/media-export/files', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(typeof detail?.detail === 'string' ? detail.detail : `导出失败（HTTP ${response.status}）`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = 'HitGO_media.zip';
      document.body.append(link);
      link.click();
      link.remove();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  },
  /**
   * 批量下载（HIG-47）：提交隐藏表单到 POST /api/outputs/zip，响应是附件，浏览器边收边写盘、不进内存。
   * 表单目标是隐藏 iframe，页面本身不跳转。成功时是附件下载，iframe 不会加载出页面；
   * 后端返回 400 之类的错误时 iframe 会加载出 JSON，读出 detail 交给 onError。mock 模式没有后端，返回 false。
   */
  downloadOutputsZip: (jobIds: string[], onError?: (message: string) => void): boolean => {
    if (MOCK) return false;
    const frameName = 'hitgo-download';
    let frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${frameName}"]`);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.name = frameName;
      frame.hidden = true;
      document.body.appendChild(frame);
    }
    frame.onload = () => {
      let text = '';
      try {
        text = frame?.contentDocument?.body?.textContent ?? '';
      } catch {
        return; // 读不到（非同源）就不提示
      }
      if (!text.trim()) return;
      try {
        const j = JSON.parse(text) as { detail?: unknown };
        onError?.(typeof j.detail === 'string' ? j.detail : '打包下载失败');
      } catch {
        onError?.('打包下载失败');
      }
    };
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/outputs/zip';
    form.target = frameName;
    form.hidden = true;
    for (const id of jobIds) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'job_ids';
      input.value = id;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
    return true;
  },

  // 视频
  getVideo: (id: string) => request<Video>('GET', `/api/videos/${id}`),
  renameVideo: (id: string, name: string) => request<Video>('PATCH', `/api/videos/${id}`, { name }),
  putSpec: (id: string, edit_spec: EditSpec) => request<Video>('PUT', `/api/videos/${id}/spec`, { edit_spec }),
  separateVideo: (id: string, model: SeparationModel) => request<Video>('POST', `/api/videos/${id}/separate`, { model }),
  deleteVideo: (id: string) => request<void>('DELETE', `/api/videos/${id}`),

  // 改语言（契约 §3）：一个任务 = 听写（模板未就绪时）+ 逐语言 翻译 → 合成 → 混音；都是 202 + Video，之后轮询 GET /api/videos/{id}
  localizeVideo: (id: string, body: LocalizeIn) => request<Video>('POST', `/api/videos/${id}/localize`, body),
  /** 修正模板文本，不触发任务；所有版本会被标为 stale。 */
  updateTranscript: (id: string, body: { cues: { i: number; text: string }[]; source_lang?: string }) => request<Video>('PUT', `/api/videos/${id}/localize/transcript`, body),
  /** 改译文 / 换音色后只重跑 TTS + 混音。use_source_voice 缺省沿用该版本上次的选择（HIG-58）。 */
  updateVersionCues: (id: string, lang: string, body: { cues: { i: number; translated: string }[]; voice?: string; use_source_voice?: boolean }) =>
    request<Video>('PUT', `/api/videos/${id}/localize/versions/${lang}`, body),
  deleteVersion: (id: string, lang: string) => request<void>('DELETE', `/api/videos/${id}/localize/versions/${lang}`),
  getLocalizeOptions: () => request<LocalizeOptions>('GET', '/api/localize/options'),

  // 画面文字（契约 §3，HIG-38）：识别 → 逐语言翻译 → 擦除；202 + Video，之后轮询 GET /api/videos/{id}。
  // target_langs 可以为空——只识别 + 擦除（去掉旧字幕再自己配字）是合法用法。
  screenText: (id: string, body: ScreenTextIn) => request<Video>('POST', `/api/videos/${id}/screen-text`, body),
  /** 修正识别出来的文字 / 框 / 时段，不触发任务；所有译文与无字版会被标为 stale。 */
  updateScreenBlocks: (id: string, blocks: { id: string; text?: string; box?: { x: number; y: number; w: number; h: number }; t?: [number, number]; enabled?: boolean }[]) =>
    request<Video>('PUT', `/api/videos/${id}/screen-text/blocks`, { blocks }),
  /** 修正某个语言的画面文字译文，不触发任务。 */
  updateScreenTexts: (id: string, lang: string, texts: { id: string; translated: string }[]) =>
    request<Video>('PUT', `/api/videos/${id}/screen-text/versions/${lang}`, { texts }),
  deleteScreenVersion: (id: string, lang: string) => request<void>('DELETE', `/api/videos/${id}/screen-text/versions/${lang}`),
  /** 删掉无字版（连文件）；spec 里仍写着 clean 的会在渲染时自动回落原片。 */
  deleteScreenErase: (id: string) => request<void>('DELETE', `/api/videos/${id}/screen-text/erase`),
  getScreenTextOptions: () => request<ScreenTextOptions>('GET', '/api/screen-text/options'),

  // 大字报（契约 §3，HIG-50）
  /** 朗读文案：202 + preparing 的音频素材，之后轮询 GET /api/assets/{id} 直到 ready / failed。lang / voice 取自 getLocalizeOptions。 */
  synthesizeTts: (body: TtsIn) => request<Asset>('POST', '/api/tts', body),
  /** 音色试听（HIG-42）：一句固定文案的 wav，服务端按音色缓存；返回可直接交给 Audio 的 URL（object URL / mock 的 data URL）。 */
  ttsPreview: (lang: string, voice: string) => requestAudioUrl(`/api/tts/preview/${encodeURIComponent(lang)}/${encodeURIComponent(voice)}`),
  /** 挑重点词组（同步，最长约 20 秒）；区间与 TextSpan 同一索引空间。 */
  highlight: (text: string, maxPhrases?: number) => request<HighlightOut>('POST', '/api/highlight', { text, ...(maxPhrases ? { max_phrases: maxPhrases } : {}) }),

  // 素材
  listAssets: (type: AssetType) => request<Asset[]>('GET', `/api/assets?type=${type}`),
  getAsset: (id: string) => request<Asset>('GET', `/api/assets/${id}`),
  uploadAssets: async (type: AssetType, files: File[], onProgress?: (f: number) => void) => {
    const tooBig = oversizedUpload(type, files);
    if (tooBig) throw new ApiError(400, tooBig);
    const needsDirect = files.reduce((total, file) => total + file.size, 0) >= DIRECT_ASSET_UPLOAD_MIN_BYTES;
    // 主域名走 CDN，单个请求超过 100 MB 会被直接拒掉；配置了上传子域名时直传过去（契约 §3）。
    // 小文件可兼容未配置票据的旧后端；大文件必须直传，不能退回会被 CDN 拒绝的主域名。
    const target = await request<UploadTicket>('POST', '/api/assets/upload-ticket').catch(() => {
      if (needsDirect) throw new ApiError(0, '大文件上传无法取得直传票据，请稍后重试', 'UPLOAD_TICKET_REQUEST_FAILED');
      return null;
    });
    if (needsDirect && !(target?.upload_url && target.ticket)) throw new ApiError(0, '大文件上传通道未就绪，无法经主站上传，请联系管理员检查上传服务', target?.upload_url || target?.ticket ? 'UPLOAD_TICKET_INVALID' : 'UPLOAD_DIRECT_REQUIRED');
    const send = (uploadFiles: File[]) => {
      const form = new FormData();
      form.append('type', type);
      for (const file of uploadFiles) form.append('files', file, file.name);
      return target?.upload_url && target.ticket
        ? uploadWithProgress<Asset[]>(target.upload_url, form, onProgress, { 'X-Upload-Ticket': target.ticket })
        : uploadWithProgress<Asset[]>('/api/assets', form, onProgress);
    };
    try {
      return await send(files);
    } catch (error) {
      if (type !== 'sticker') throw error;
      const rewritten = await reencodeRejectedPng(files, error);
      if (!rewritten) throw error;
      onProgress?.(0);
      return send(rewritten);
    }
  },
  deleteAsset: (id: string) => request<void>('DELETE', `/api/assets/${id}`),

  // 文字图层 PNG
  uploadLayerImage: (blob: Blob) => {
    const form = new FormData();
    form.append('file', blob, 'layer.png');
    return uploadWithProgress<{ url: string; width: number; height: number }>('/api/uploads/layer-image', form);
  },

  // 渲染
  /**
   * name：本次导出的名称，写到每个任务上（可选，HIG-27）。
   * 传 RenderItem[]（HIG-43）时每项带语言，可带自己的 spec 快照：同一视频的多个语言一次提交。
   */
  render: (targets: string[] | RenderItem[], name?: string, variant_keys?: string[], output_format?: 'source' | 'mp4' | 'mov' | 'png' | 'jpg') =>
    request<Job[]>('POST', '/api/render', {
      ...(targets.length && typeof targets[0] === 'object' ? { items: targets } : { video_ids: targets }),
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(variant_keys?.length ? { variant_keys } : {}),
      ...(output_format ? { output_format } : {}),
    }),
  getJob: (id: string) => request<Job>('GET', `/api/jobs/${id}`),
  retryJob: (id: string) => request<Job>('POST', `/api/jobs/${id}/retry`),
  getJobs: (ids: string[]) => request<Job[]>('GET', `/api/jobs?ids=${ids.join(',')}`),

  // 预设
  listPresets: (type: PresetType) => request<Preset[]>('GET', `/api/presets?type=${type}`),
  createPreset: (body: { type: PresetType; name: string; data: Record<string, unknown> }) => request<Preset>('POST', '/api/presets', body),
  deletePreset: (id: string) => request<void>('DELETE', `/api/presets/${id}`),

  // 配置
  safeZones: () => request<SafeZone[]>('GET', '/api/safe-zones'),
};

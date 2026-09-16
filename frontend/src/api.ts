// 类型化 API 客户端，路由与契约第 3 节一一对应。
// VITE_MOCK=1 时由 src/mocks 提供内存实现（见 request()）。

import type { Asset, AssetType, Batch, BatchDetail, EditSpec, Job, LocalizeIn, LocalizeOptions, Preset, PresetType, SafeZone, SeparationModel, UploadTicket, Video } from './types';
import { oversizedUpload } from './lib/assets';

export const MOCK = import.meta.env.VITE_MOCK === '1';

/** 批量应用 layers 模块的方式：replace 整体替换；style_only 只覆盖样式，保留目标的 anchor / margin / t。 */
export type ApplyLayerMode = 'replace' | 'style_only';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    try {
      const j = await res.json();
      if (j && typeof j.detail === 'string') detail = j.detail;
      else if (j && j.detail) detail = JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
          reject(new ApiError(xhr.status, '响应解析失败'));
        }
      } else {
        let detail = `上传失败（${xhr.status}）`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
        } catch {
          /* ignore */
        }
        reject(new ApiError(xhr.status, detail));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, '网络错误：上传被中断，请检查网络后重试'));
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
  uploadVideos: (batchId: string, files: File[], onProgress?: (f: number) => void) => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    return uploadWithProgress<Video[]>(`/api/batches/${batchId}/videos`, form, onProgress);
  },
  applySpec: (batchId: string, body: { source_video_id: string; target_video_ids: string[]; modules: string[]; layer_mode?: ApplyLayerMode }) =>
    request<Video[]>('POST', `/api/batches/${batchId}/apply`, body),
  batchJobs: (batchId: string) => request<Job[]>('GET', `/api/batches/${batchId}/jobs`),
  batchOutputs: (batchId: string) => request<Job[]>('GET', `/api/batches/${batchId}/outputs`),
  /** 跨批次的已完成产物，按完成时间倒序；q 按导出名称 / 批次名 / 视频名搜索（HIG-27）。 */
  allOutputs: (limit = 100, offset = 0, q = '') =>
    request<Job[]>('GET', `/api/outputs?limit=${limit}&offset=${offset}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`),

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
  /** 改译文 / 换音色后只重跑 TTS + 混音。 */
  updateVersionCues: (id: string, lang: string, body: { cues: { i: number; translated: string }[]; voice?: string }) => request<Video>('PUT', `/api/videos/${id}/localize/versions/${lang}`, body),
  deleteVersion: (id: string, lang: string) => request<void>('DELETE', `/api/videos/${id}/localize/versions/${lang}`),
  getLocalizeOptions: () => request<LocalizeOptions>('GET', '/api/localize/options'),

  // 素材
  listAssets: (type: AssetType) => request<Asset[]>('GET', `/api/assets?type=${type}`),
  getAsset: (id: string) => request<Asset>('GET', `/api/assets/${id}`),
  uploadAssets: async (type: AssetType, files: File[], onProgress?: (f: number) => void) => {
    const tooBig = oversizedUpload(type, files);
    if (tooBig) throw new ApiError(400, tooBig);
    const form = new FormData();
    form.append('type', type);
    for (const f of files) form.append('files', f, f.name);
    // 主域名走 CDN，单个请求超过 100 MB 会被直接拒掉；配置了上传子域名时直传过去（契约 §3）。
    // 取票失败（旧后端没有这个接口等）就退回同源上传，小文件照样能传。
    const target = await request<UploadTicket>('POST', '/api/assets/upload-ticket').catch(() => null);
    if (target?.upload_url && target.ticket) {
      return uploadWithProgress<Asset[]>(target.upload_url, form, onProgress, { 'X-Upload-Ticket': target.ticket });
    }
    return uploadWithProgress<Asset[]>('/api/assets', form, onProgress);
  },
  deleteAsset: (id: string) => request<void>('DELETE', `/api/assets/${id}`),

  // 文字图层 PNG
  uploadLayerImage: (blob: Blob) => {
    const form = new FormData();
    form.append('file', blob, 'layer.png');
    return uploadWithProgress<{ url: string; width: number; height: number }>('/api/uploads/layer-image', form);
  },

  // 渲染
  /** name：本次导出的名称，写到每个任务上（可选，HIG-27）。 */
  render: (video_ids: string[], name?: string) => request<Job[]>('POST', '/api/render', name?.trim() ? { video_ids, name: name.trim() } : { video_ids }),
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

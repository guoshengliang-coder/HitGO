// 类型化 API 客户端，路由与契约第 3 节一一对应。
// VITE_MOCK=1 时由 src/mocks 提供内存实现（见 request()）。

import type { Asset, AssetType, Batch, BatchDetail, EditSpec, Job, Preset, PresetType, SafeZone, Video } from './types';

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

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
    xhr.onerror = () => reject(new ApiError(0, '网络错误'));
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

  // 视频
  getVideo: (id: string) => request<Video>('GET', `/api/videos/${id}`),
  putSpec: (id: string, edit_spec: EditSpec) => request<Video>('PUT', `/api/videos/${id}/spec`, { edit_spec }),
  deleteVideo: (id: string) => request<void>('DELETE', `/api/videos/${id}`),

  // 素材
  listAssets: (type: AssetType) => request<Asset[]>('GET', `/api/assets?type=${type}`),
  uploadAssets: (type: AssetType, files: File[], onProgress?: (f: number) => void) => {
    const form = new FormData();
    form.append('type', type);
    for (const f of files) form.append('files', f, f.name);
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
  render: (video_ids: string[]) => request<Job[]>('POST', '/api/render', { video_ids }),
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

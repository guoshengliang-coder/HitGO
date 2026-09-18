import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, uploadErrorText } from './api';

class FakeXHR {
  static last: FakeXHR;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  url = '';
  headers: Record<string, string> = {};
  status = 201;
  responseText = '[]';

  constructor() { FakeXHR.last = this; }
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(_body: FormData) { this.onload?.(); }
}

afterEach(() => vi.unstubAllGlobals());

describe('batch video upload', () => {
  it('uses the batch-bound upload URL and ticket', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      upload_url: 'https://up.example/api/batches/b_one/videos', ticket: 'signed', expires_at: 'soon',
    }) }));
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    await api.uploadVideos('b_one', [new File(['video'], 'a.mp4')]);
    expect(FakeXHR.last.url).toBe('https://up.example/api/batches/b_one/videos');
    expect(FakeXHR.last.headers['X-Upload-Ticket']).toBe('signed');
    expect(FakeXHR.last.headers['X-Upload-Request-ID']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the same-origin route when no upload host is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      upload_url: null, ticket: null, expires_at: null,
    }) }));
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    await api.uploadVideos('b_one', [new File(['video'], 'a.mp4')]);
    expect(FakeXHR.last.url).toBe('/api/batches/b_one/videos');
    expect(FakeXHR.last.headers['X-Upload-Request-ID']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows a stable code when the edge rejects an oversized request', async () => {
    class RejectedXHR extends FakeXHR {
      override send(body: FormData) {
        this.status = 413;
        this.responseText = '<html>Request Entity Too Large</html>';
        super.send(body);
      }
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      upload_url: null, ticket: null, expires_at: null,
    }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', RejectedXHR);
    await expect(api.uploadVideos('b_one', [new File(['video'], 'a.mp4')])).rejects.toMatchObject({
      status: 413, code: 'UPLOAD_REQUEST_TOO_LARGE',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/uploads/diagnostic', expect.objectContaining({ method: 'POST' }));
    const report = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(report).toMatchObject({
      batch_id: 'b_one', stage: 'upload', channel: 'same_origin', status: 413,
      code: 'UPLOAD_REQUEST_TOO_LARGE', file_count: 1,
    });
    expect(report.request_id).toBe(FakeXHR.last.headers['X-Upload-Request-ID']);
    expect(report).not.toHaveProperty('file_name');
    expect(uploadErrorText(new ApiError(413, '文件过大', 'UPLOAD_REQUEST_TOO_LARGE'))).toContain('错误码：UPLOAD_REQUEST_TOO_LARGE');
  });

  it('rejects an incomplete ticket instead of silently using the CDN route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      upload_url: 'https://up.example/api/batches/b_one/videos', ticket: null,
    }) }));
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    await expect(api.uploadVideos('b_one', [new File(['video'], 'a.mp4')])).rejects.toMatchObject({
      code: 'UPLOAD_TICKET_INVALID',
    });
  });
});

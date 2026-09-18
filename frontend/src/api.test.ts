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

describe('asset upload (HIG-6 return)', () => {
  const largeVideo = () => {
    const file = new File(['video'], 'large.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: 120 * 1024 * 1024 });
    return file;
  };

  it('does not send a large sticker through the proxied origin when ticketing fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ticket offline')));
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    await expect(api.uploadAssets('sticker', [largeVideo()])).rejects.toMatchObject({ code: 'UPLOAD_TICKET_REQUEST_FAILED' });
    expect(FakeXHR.last?.url).not.toBe('/api/assets');
  });

  it('uses the direct host and ticket for a large sticker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      upload_url: 'https://up.example/api/assets', ticket: 'signed', expires_at: 'soon',
    }) }));
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    await api.uploadAssets('sticker', [largeVideo()]);
    expect(FakeXHR.last.url).toBe('https://up.example/api/assets');
    expect(FakeXHR.last.headers['X-Upload-Ticket']).toBe('signed');
  });

  it('keeps the same-origin fallback for small images', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('old backend')));
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    await api.uploadAssets('sticker', [new File(['png'], 'small.png', { type: 'image/png' })]);
    expect(FakeXHR.last.url).toBe('/api/assets');
  });

  it('reencodes a PNG once when the server rejects it but the browser can decode it', async () => {
    class ImageXHR extends FakeXHR {
      static bodies: FormData[] = [];
      override send(body: FormData) {
        ImageXHR.bodies.push(body);
        if (ImageXHR.bodies.length === 1) {
          this.status = 400;
          this.responseText = JSON.stringify({ detail: 'LINE Pay.png：无法解析图片' });
        }
        super.send(body);
      }
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ upload_url: null, ticket: null }) }));
    vi.stubGlobal('XMLHttpRequest', ImageXHR);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 2, height: 2, close: vi.fn() }));
    vi.stubGlobal('document', { createElement: () => ({
      width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['normalized'], { type: 'image/png' })),
    }) });
    await api.uploadAssets('sticker', [new File(['original'], 'LINE Pay.png', { type: 'image/png' })]);
    expect(ImageXHR.bodies).toHaveLength(2);
    expect((ImageXHR.bodies[1].get('files') as File).name).toBe('LINE Pay.png');
    expect((ImageXHR.bodies[1].get('files') as File).size).toBe(10);
  });

  it('reports a damaged PNG instead of retrying it indefinitely', async () => {
    class ImageXHR extends FakeXHR {
      static sends = 0;
      override send(body: FormData) {
        ImageXHR.sends++;
        this.status = 400;
        this.responseText = JSON.stringify({ detail: 'LINE Pay.png：无法解析图片' });
        super.send(body);
      }
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ upload_url: null, ticket: null }) }));
    vi.stubGlobal('XMLHttpRequest', ImageXHR);
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
    await expect(api.uploadAssets('sticker', [new File(['broken'], 'LINE Pay.png', { type: 'image/png' })])).rejects.toMatchObject({ code: 'UPLOAD_IMAGE_DECODE_FAILED' });
    expect(ImageXHR.sends).toBe(1);
  });
});

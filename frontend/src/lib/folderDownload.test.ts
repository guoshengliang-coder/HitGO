import { afterEach, expect, it, vi } from 'vitest';
import { saveOutputFile, type OutputDirectory } from './folderDownload';

afterEach(() => vi.unstubAllGlobals());

it('streams each output into a distinct file without overwriting an existing name', async () => {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const directory: OutputDirectory = {
    getFileHandle: vi.fn(async (name, options) => {
      if (!options?.create && name !== 'video.mp4') throw new DOMException('missing', 'NotFoundError');
      return { createWritable: async () => ({ write: async (bytes: Uint8Array) => { chunks.push(bytes); }, close: async () => { closed = true; }, abort: async () => {} }) };
    }),
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
  const name = await saveOutputFile(directory, '/media/output.mp4', 'video.mp4');
  expect(name).toBe('video (1).mp4');
  expect([...chunks[0]]).toEqual([1, 2, 3]);
  expect(closed).toBe(true);
});

/** Save finished outputs one by one using the browser's directory picker. */
export interface WritableOutputFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface OutputDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    createWritable(): Promise<WritableOutputFile>;
  }>;
}

export function canPickOutputDirectory(): boolean {
  return typeof window !== 'undefined' && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickOutputDirectory(): Promise<OutputDirectory> {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<OutputDirectory> }).showDirectoryPicker;
  if (!picker) throw new Error('当前浏览器不支持直接保存到文件夹，请使用 ZIP 下载');
  return picker();
}

async function unusedName(directory: OutputDirectory, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 0; n < 10000; n++) {
    const candidate = n ? `${base} (${n})${ext}` : name;
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return candidate;
      throw error;
    }
  }
  throw new Error(`文件名冲突过多：${name}`);
}

export async function saveOutputFile(directory: OutputDirectory, url: string, name: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
  const savedName = await unusedName(directory, name);
  const handle = await directory.getFileHandle(savedName, { create: true });
  const target = await handle.createWritable();
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await target.write(value);
    }
    await target.close();
    return savedName;
  } catch (error) {
    await target.abort().catch(() => undefined);
    throw error;
  }
}

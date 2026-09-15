import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 界面上显示的版本号原始值（HIG-14，只显示最近的 tag）：
 * HITGO_VERSION 环境变量 → .hitgo-version（scripts/deploy.sh 在服务器构建前写入，镜像里没有 .git）
 * → 本地 git describe → 空（界面显示 dev）。
 */
function resolveVersion(): string {
  if (process.env.HITGO_VERSION) return process.env.HITGO_VERSION;
  try {
    const v = readFileSync(new URL('./.hitgo-version', import.meta.url), 'utf8').trim();
    if (v) return v;
  } catch {
    /* 没有文件 */
  }
  try {
    return execSync('git describe --tags --abbrev=0', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/media': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

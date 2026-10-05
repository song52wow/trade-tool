import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 前端构建：产物落在 `dist/ui`，由 `src/main.ts` 的服务端静态托管。
 *
 * `emptyOutDir: false` 是必须的——`build` 脚本先跑 tsup 写 `dist/*.js`，
 * vite 若清空 `dist` 会把服务端产物一起删掉。
 */
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      // 开发时前端独立跑在 5173，API 转发到后端 8787
      '/api': 'http://127.0.0.1:8787',
    },
  },
});

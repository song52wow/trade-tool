import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // 默认 Node 环境（路由、作业、纯函数）。需要 DOM 的 UI 用例在文件顶部用
    // `@vitest-environment jsdom` 单独声明，避免为一个用例把整个包切成 DOM 环境。
    environment: 'node',
    setupFiles: [],
  },
});

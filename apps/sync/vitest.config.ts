import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 用例要连真实 PG，串行执行避免抢同一个 schema
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

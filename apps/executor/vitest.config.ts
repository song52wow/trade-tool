import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 本服务用例默认用替身（不连 PG、不出网）；要连库的那些仍需串行
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

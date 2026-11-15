import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // CLI 的用例都是纯函数（区间、汇总、报告渲染），不连库、不出网。
    testTimeout: 10_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 测试要连真实 PG（迁移、COPY、事务都必须真跑），串行执行避免抢同一个 schema
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

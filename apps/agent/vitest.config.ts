import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 用例要连真实 PG（迁移、事务都必须真跑），串行执行避免抢同一个 schema。
    // 端到端那条还要起假交易所与假模型服务，并让**真的 Python 引擎**算指标，
    // 因此超时给得比默认宽。
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

/**
 * 真库测试设施的**转出口**。
 *
 * 实现已经提到 `packages/data/src/testing-pg.ts`（与 `testing.ts` 同一个理由：
 * `apps/executor` 等包也要用「真库 + 真迁移」，设施只有一份，不复制）。
 * 这个文件保留下来，是为了让既有用例的 import 路径（`./helpers/pg.js`）不用改。
 */

export {
  TEST_PG,
  TEST_DATABASE_CONFIG,
  FIXED_NOW_MS,
  createTestSchema,
  closedBarOpen,
  insertBars,
  barTimes,
} from '../../src/testing-pg.js';

export type { TestSchema } from '../../src/testing-pg.js';

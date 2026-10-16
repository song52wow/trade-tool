import {
  assertSchemaVersion,
  migrate,
  schemaStatus,
  type MigrateResult,
  type SchemaStatus,
} from '@trade-tool/data';

import { withContext } from '../context.js';

/** `trade-tool db migrate` —— 应用迁移。必须幂等，可反复执行（R-15 第 4 条 / AC-1）。 */
export async function runMigrate(options: { json?: boolean } = {}): Promise<number> {
  return withContext(async ({ pool }) => {
    const result: MigrateResult = await migrate(pool);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.current === result.latest ? 0 : 1;
    }
    // 「库比代码新」必须报错（R-1.3 / R-19.7）。只看 `applied.length === 0` 会把它
    // 误报成「已是最新」：例如库里已应用 999_future 而代码只到 001_init，migrate 无事可做，
    // 于是 exit 0，直到某条命令按旧 schema 静默跑崩。
    if (result.current !== result.latest) {
      console.error(
        `[SCHEMA_VERSION_MISMATCH] 数据库 schema（${result.current || '<空>'}）` +
          `与代码（${result.latest}）不一致：请更新迁移文件与两侧读写代码。`,
      );
      return 1;
    }
    if (result.applied.length === 0) {
      console.log(`数据库 schema 已是最新（${result.current}），无变更。`);
      return 0;
    }
    console.log(`已应用迁移：${result.applied.join(', ')}`);
    if (result.skipped.length > 0) console.log(`跳过（已应用）：${result.skipped.join(', ')}`);
    console.log(`schema 版本：${result.current}`);
    return 0;
  });
}

/** `trade-tool db status` —— 只读查看版本比对结果。 */
export async function runDbStatus(options: { json?: boolean } = {}): Promise<number> {
  return withContext(async ({ pool }) => {
    const status: SchemaStatus = await schemaStatus(pool);
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return status.ok ? 0 : 1;
    }
    console.log(`当前版本：${status.current || '<空库>'}`);
    console.log(`代码版本：${status.latest}`);
    if (status.ok) {
      console.log('✔ schema 版本匹配');
      return 0;
    }
    if (status.ahead.length > 0) console.error(`✘ 数据库比代码新：${status.ahead.join(', ')}`);
    if (status.behind.length > 0) console.error(`✘ 数据库落后，缺少：${status.behind.join(', ')}`);
    return 1;
  });
}

/**
 * 非 migrate 命令进入业务逻辑前的版本闸门（R-1.3 / R-19.7）。
 * 版本不匹配必须**报错**而不是继续运行。
 */
export async function assertSchema(pool: Parameters<typeof assertSchemaVersion>[0]): Promise<void> {
  await assertSchemaVersion(pool);
}

import { SyncError } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool, PoolClient } from './pool.js';
import { listMigrations, resolveSqlDir, type MigrationFile } from './sql-files.js';

/**
 * 版本化迁移（R-1）。
 *
 * 不变量：
 *   1. 可重复执行且幂等——已应用的版本直接跳过，空库能一路迁到最新（R-1.2）。
 *   2. 每个文件在**单个事务**内应用，失败整体回滚，不留半套结构。
 *   3. 版本不匹配必须**报错**，不得按旧 schema 静默运行（R-1.3 / R-19.7）。
 */

export interface MigrateOptions {
  /** 迁移文件目录，默认自动定位 packages/data/sql */
  sqlDir?: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  /** 迁移后库里的最高版本 */
  current: string;
  /** 代码侧已知的最高版本 */
  latest: string;
}

function newest(migrations: readonly MigrationFile[]): string {
  const last = migrations[migrations.length - 1];
  if (!last) throw new SyncError('CONFIG_INVALID', '迁移目录中没有任何 .sql 文件');
  return last.version;
}

/**
 * 表不存在时按「一个版本都没应用」处理。
 *
 * `schema_migrations` 的 DDL **只在 `sql/*.sql` 里**（R-2.5：迁移文件是 schema 的唯一来源），
 * 本模块不再内联一份影子定义——否则日后改了 SQL 而忘了这里，两处会静默漂移。
 * 代价是首次迁移前这张表确实不存在，此时 to_regclass 返回 NULL，按空集合处理即可。
 */
async function schemaTableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ reg: string | null }>(
    `SELECT to_regclass('schema_migrations')::text AS reg`,
  );
  return result.rows[0]?.reg != null;
}

async function appliedVersions(client: PoolClient): Promise<Set<string>> {
  if (!(await schemaTableExists(client))) return new Set();
  const result = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(result.rows.map((row) => row.version));
}

export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const sqlDir = resolveSqlDir(options.sqlDir);
  const migrations = listMigrations(sqlDir);
  if (migrations.length === 0) {
    throw new SyncError('CONFIG_INVALID', `迁移目录为空：${sqlDir}`);
  }

  const client = await pool.connect();
  try {
    const already = await appliedVersions(client);
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      if (already.has(migration.version)) {
        skipped.push(migration.version);
        continue;
      }
      await client.query('BEGIN');
      try {
        // 整个文件作为一个批次发送（simple query protocol 支持多语句）。
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
          migration.version,
          Date.now(),
        ]);
        await client.query('COMMIT');
        applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new SyncError(
          'DB_TRANSACTION_ROLLBACK',
          `迁移 ${migration.file} 失败并已回滚：${(error as Error).message}`,
          { version: migration.version, file: migration.file },
        );
      }
    }

    const current = await currentVersion(client);
    return { applied, skipped, current, latest: newest(migrations) };
  } catch (error) {
    throw toSyncError(error, '应用数据库迁移失败');
  } finally {
    client.release();
  }
}

async function currentVersion(client: PoolClient): Promise<string> {
  if (!(await schemaTableExists(client))) return '';
  const result = await client.query<{ version: string | null }>(
    'SELECT max(version) AS version FROM schema_migrations',
  );
  return result.rows[0]?.version ?? '';
}

export interface SchemaStatus {
  /** 库中已应用的版本集合 */
  applied: string[];
  /** 代码侧已知的版本集合 */
  known: string[];
  current: string;
  latest: string;
  /** 库比代码新（代码落后，缺迁移文件） */
  ahead: string[];
  /** 代码比库新（库没跑迁移） */
  behind: string[];
  ok: boolean;
}

/** 读取并比对版本，不做任何写入。 */
export async function schemaStatus(
  pool: Pool,
  options: MigrateOptions = {},
): Promise<SchemaStatus> {
  const migrations = listMigrations(resolveSqlDir(options.sqlDir));
  const known = migrations.map((m) => m.version);
  const client = await pool.connect();
  try {
    const applied = [...(await appliedVersions(client))].sort();
    const appliedSet = new Set(applied);
    const knownSet = new Set(known);
    return {
      applied,
      known,
      current: applied[applied.length - 1] ?? '',
      latest: newest(migrations),
      ahead: applied.filter((v) => !knownSet.has(v)),
      behind: known.filter((v) => !appliedSet.has(v)),
      ok: applied.length === known.length && known.every((v) => appliedSet.has(v)),
    };
  } catch (error) {
    throw toSyncError(error, '读取 schema 版本失败');
  } finally {
    client.release();
  }
}

/**
 * 启动时的版本闸门（R-1.3 / R-19.7）。
 * 库比代码新或比代码旧，都必须报错退出——**不得按旧 schema 继续运行**。
 */
export async function assertSchemaVersion(
  pool: Pool,
  options: MigrateOptions = {},
): Promise<SchemaStatus> {
  const status = await schemaStatus(pool, options);
  if (status.ok) return status;

  const details = {
    applied: status.applied,
    known: status.known,
    current: status.current,
    latest: status.latest,
    ahead: status.ahead,
    behind: status.behind,
  };
  if (status.ahead.length > 0) {
    throw new SyncError(
      'SCHEMA_VERSION_MISMATCH',
      `数据库 schema 比代码新：库内多出 ${status.ahead.join(', ')}，请先更新迁移文件与读写代码`,
      details,
    );
  }
  throw new SyncError(
    'SCHEMA_VERSION_MISMATCH',
    `数据库 schema 落后：缺少 ${status.behind.join(', ')}，请先执行 \`trade-tool db migrate\``,
    details,
  );
}

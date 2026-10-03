import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 迁移文件定位。
 *
 * 迁移文件以 `packages/data/sql/*.sql` 为**唯一来源**（R-2.5）：TS 与 Python 都不另持
 * 影子定义。这里只负责在 dev（从 `src/` 直跑）与 dist（打包后）两种布局下都找得到它。
 */

const PACKAGE_NAME = '@trade-tool/data';
const MIGRATION_PREFIX = /^\d{3}_/;

/** 从当前模块向上找到 `package.json.name === '@trade-tool/data'` 的目录。 */
function findPackageRoot(from: string): string | undefined {
  let dir = from;
  for (let i = 0; i < 10; i += 1) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
        if (parsed.name === PACKAGE_NAME) return dir;
      } catch {
        // package.json 读不出来就继续往上找，不在此处抛错
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function resolveSqlDir(explicit?: string): string {
  if (explicit) return resolve(process.cwd(), explicit);
  const fromEnv = process.env.TRADE_TOOL_SQL_DIR;
  if (fromEnv && fromEnv.trim() !== '') return resolve(process.cwd(), fromEnv);

  const startDir = dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(startDir);
  if (!root) {
    throw new Error(
      `未能定位 @trade-tool/data 的包根目录（从 ${startDir} 向上未找到 package.json name=${PACKAGE_NAME}）`,
    );
  }
  const sqlDir = resolve(root, 'sql');
  if (!existsSync(sqlDir)) throw new Error(`迁移目录不存在：${sqlDir}`);
  return sqlDir;
}

export interface MigrationFile {
  /** 文件名去扩展名，即版本号，如 `001_init` */
  version: string;
  file: string;
  sql: string;
}

function versionOf(file: string): string {
  return file.replace(/\.sql$/, '');
}

/**
 * 按版本号升序列出迁移。文件名必须是 `NNN_xxx.sql`。
 * 顺序即应用顺序，因此排序必须是**确定性**的，不能依赖文件系统返回顺序。
 */
export function listMigrations(sqlDir: string): MigrationFile[] {
  const entries = readdirSync(sqlDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const migrations: MigrationFile[] = [];
  for (const name of entries) {
    if (!MIGRATION_PREFIX.test(name)) {
      throw new Error(`迁移文件名必须形如 001_init.sql，实际：${name}（目录 ${sqlDir}）`);
    }
    migrations.push({
      version: versionOf(name),
      file: resolve(sqlDir, name),
      sql: readFileSync(resolve(sqlDir, name), 'utf8'),
    });
  }
  return migrations;
}

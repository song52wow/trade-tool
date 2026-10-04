import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目级 .env 文件名。固定叫 .env，与 docker compose 的自动读取同名同路径。 */
export const ENV_FILENAME = '.env';

/** 标识 monorepo 根目录的文件，与 `packages/data` 侧 findRepoRoot 同一判据。 */
const ROOT_MARKER = 'pnpm-workspace.yaml';

export interface LoadEnvOptions {
  /** 向上查找的起点，默认取本模块所在位置（源码与 dist 都能定位到同一个根）。 */
  from?: string;
  /** 显式指定 .env 路径；给出后不再向上查找，且文件不存在时报错。 */
  envFile?: string;
}

export interface LoadEnvResult {
  /** 实际加载的文件；没找到时为 null。 */
  path: string | null;
  /** 这次真正注入 `process.env` 的变量名——已在环境里的不会被覆盖，因此不在其中。 */
  loaded: string[];
}

/**
 * 从给定位置向上找到 `pnpm-workspace.yaml`，定位 monorepo 根目录。
 *
 * 抛错而非回落 cwd：`.env` 找错位置会静默地让密码缺失，等到连库才炸，
 * 错误位置与真实问题隔了整条链路（AGENTS.md 第 9 条）。
 */
export function findProjectRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    const parent = dirname(dir);
    if (existsSync(resolve(parent, ROOT_MARKER))) return parent;
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`未能定位 monorepo 根目录（未找到 ${ROOT_MARKER}）`);
}

/**
 * 加载仓库根目录的 `.env` 到 `process.env`，让配置、密码等不必经 shell export。
 *
 * 三个刻意的语义：
 * 1. **不覆盖已存在的变量**（`process.loadEnvFile` 的原生行为）。CI 与生产注入的值
 *    永远压过文件，`.env` 只负责「本机默认值」。
 * 2. **找不到就跳过**，不报错。没有 `.env` 本身是合法状态——变量可能全由外部注入。
 * 3. **显式指定路径时文件必须存在**，否则抛错：那属于调用方的笔误，不该静默。
 *
 * 必须在任何读取 `process.env` 的代码之前调用（入口文件第一行），否则不生效。
 */
export function loadProjectEnv(options: LoadEnvOptions = {}): LoadEnvResult {
  const explicit = options.envFile?.trim() ?? '';
  const path =
    explicit !== '' ? resolve(explicit) : resolve(findProjectRoot(options.from), ENV_FILENAME);

  if (!existsSync(path)) {
    if (explicit !== '') throw new Error(`指定的 ${ENV_FILENAME} 不存在: ${path}`);
    return { path: null, loaded: [] };
  }

  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(path);
  } catch (error) {
    throw new Error(`读取 ${ENV_FILENAME} 失败: ${path} (${(error as Error).message})`);
  }
  const loaded = Object.keys(process.env).filter((key) => !before.has(key));
  return { path, loaded };
}

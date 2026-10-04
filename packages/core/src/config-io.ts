import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { configSchema, defaultConfig, type TradeToolConfig } from './config.js';

export const CONFIG_FILENAME = 'trade-tool.config.json';

/** 工作根目录：优先 TRADE_TOOL_HOME，否则取当前工作目录。 */
export function resolveHome(cwd = process.cwd()): string {
  const fromEnv = process.env.TRADE_TOOL_HOME;
  if (fromEnv && fromEnv.trim() !== '') {
    return isAbsolute(fromEnv) ? fromEnv : resolve(cwd, fromEnv);
  }
  return cwd;
}

export function resolveConfigPath(cwd = process.cwd()): string {
  return resolve(resolveHome(cwd), CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * R-13：密码**必须经环境变量注入，不得写入配置文件**。
 *
 * `databaseSchema` 里根本没有 `password` 字段，而 zod 的 object 默认会**静默剥离**未知键，
 * 于是一份写了 `database.password` 的配置会被安静地接受、密码被丢掉，
 * 直到真正连库时才报「密码缺失」——错误位置与真实问题隔了一整条链路。
 * 这正是 AGENTS.md 第 9 条「不静默兜底」要禁止的。这里显式拒绝并说清怎么改。
 */
function assertNoPasswordInConfig(parsed: unknown): void {
  if (!isRecord(parsed) || !isRecord(parsed['database'])) return;
  if (!('password' in parsed['database'])) return;
  throw new Error(
    '配置校验失败: database.password 不得写入配置文件——' +
      '密码只能经环境变量注入（默认变量名 TRADE_TOOL_PG_PASSWORD，可用 database.passwordEnv 改名）',
  );
}

/** 读配置并做 schema 校验；文件不存在时抛错，交给上层决定是否回落默认值。 */
export async function loadConfig(configPath = resolveConfigPath()): Promise<TradeToolConfig> {
  const raw = await readFile(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON: ${configPath} (${(error as Error).message})`);
  }
  assertNoPasswordInConfig(parsed);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`配置校验失败: ${detail}`);
  }
  return result.data;
}

export async function loadConfigOrDefault(
  configPath = resolveConfigPath(),
): Promise<TradeToolConfig> {
  try {
    return await loadConfig(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultConfig();
    }
    throw error;
  }
}

export async function saveConfig(
  config: TradeToolConfig,
  configPath = resolveConfigPath(),
): Promise<string> {
  const validated = configSchema.parse(config);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return configPath;
}

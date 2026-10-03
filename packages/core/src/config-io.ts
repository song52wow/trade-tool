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

/** 读配置并做 schema 校验；文件不存在时抛错，交给上层决定是否回落默认值。 */
export async function loadConfig(configPath = resolveConfigPath()): Promise<TradeToolConfig> {
  const raw = await readFile(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON: ${configPath} (${(error as Error).message})`);
  }
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

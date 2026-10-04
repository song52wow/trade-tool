import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { resolveHome } from '@trade-tool/core';

import { findRepoRoot } from './bridge.js';

export interface CacheEntry<T> {
  key: string;
  savedAt: string;
  value: T;
}

/**
 * 缓存目录。传入的**相对**路径按 `TRADE_TOOL_HOME` 解析，与 `rawDir` / `metaDir` /
 * `reports` 同一套约定；绝对路径原样使用。
 *
 * 之前这里按 `process.cwd()` 解析相对路径，于是同一个 cacheDir 在
 * `pnpm --filter … start`（cwd = apps/cli）与仓库根直跑之间会落到两个不同目录，
 * `TRADE_TOOL_HOME` 对缓存也完全失效——看起来像缓存失效的重复下载。
 */
function cacheRoot(dir?: string): string {
  if (!dir) return resolve(resolveHome(), 'data', 'cache');
  return isAbsolute(dir) ? dir : resolve(resolveHome(), dir);
}

function cacheFile(key: string, dir?: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  return resolve(cacheRoot(dir), `${safe}.json`);
}

export async function readCache<T>(key: string, dir?: string): Promise<T | undefined> {
  try {
    const raw = await readFile(cacheFile(key, dir), 'utf8');
    return (JSON.parse(raw) as CacheEntry<T>).value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeCache<T>(key: string, value: T, dir?: string): Promise<string> {
  const file = cacheFile(key, dir);
  await mkdir(cacheRoot(dir), { recursive: true });
  const entry: CacheEntry<T> = { key, savedAt: new Date().toISOString(), value };
  await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return file;
}

export { findRepoRoot };

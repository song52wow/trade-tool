import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { resolveHome } from '@trade-tool/core';

import { findRepoRoot } from './bridge.js';

export interface CacheEntry<T> {
  key: string;
  savedAt: string;
  value: T;
}

function cacheRoot(dir?: string): string {
  if (dir) return resolve(process.cwd(), dir);
  return resolve(resolveHome(), 'data', 'cache');
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

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ENV_FILENAME, findProjectRoot, loadProjectEnv } from '../src/env.js';

/** 造一棵 <root>/apps/cli/src 的目录树，根下放 pnpm-workspace.yaml 作为定位标记。 */
function scaffold(options: { env?: string; marker?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'trade-tool-env-'));
  mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true });
  if (options.marker !== false) writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n');
  if (options.env !== undefined) writeFileSync(join(root, ENV_FILENAME), options.env);
  return root;
}

const snapshot = new Map<string, string | undefined>();
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!snapshot.has(key)) delete process.env[key];
  }
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  snapshot.clear();
});

/** 记住变量当前值，用例内可改，afterEach 还原。 */
function stage(key: string, value: string | undefined): void {
  if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('loadProjectEnv', () => {
  it('从 monorepo 根加载 .env 并注入变量', () => {
    const root = scaffold({ env: 'TRADE_TOOL_PG_PASSWORD=from_env_file\n' });
    stage('TRADE_TOOL_PG_PASSWORD', undefined);

    const result = loadProjectEnv({ from: join(root, 'apps', 'cli', 'src', 'index.ts') });

    expect(result.path).toBe(join(root, ENV_FILENAME));
    expect(result.loaded).toEqual(['TRADE_TOOL_PG_PASSWORD']);
    expect(process.env['TRADE_TOOL_PG_PASSWORD']).toBe('from_env_file');
  });

  it('不覆盖已存在的变量：外部注入压过 .env', () => {
    const root = scaffold({ env: 'TRADE_TOOL_PG_PASSWORD=from_env_file\n' });
    stage('TRADE_TOOL_PG_PASSWORD', 'from_shell');

    const result = loadProjectEnv({ from: join(root, 'apps', 'cli', 'src', 'index.ts') });

    expect(process.env['TRADE_TOOL_PG_PASSWORD']).toBe('from_shell');
    expect(result.loaded).toEqual([]);
  });

  it('根目录没有 .env 时返回空结果而不是抛错', () => {
    const root = scaffold();
    stage('TRADE_TOOL_PG_PASSWORD', undefined);

    const result = loadProjectEnv({ from: join(root, 'apps', 'cli', 'src', 'index.ts') });

    expect(result).toEqual({ path: null, loaded: [] });
  });

  it('显式指定 envFile 时文件必须存在', () => {
    const root = scaffold();
    expect(() => loadProjectEnv({ envFile: join(root, 'missing.env') })).toThrow(/不存在/);
  });

  it('显式 envFile 优先于向上查找', () => {
    const root = scaffold({ env: 'TRADE_TOOL_PG_PASSWORD=from_env_file\n' });
    const explicit = join(root, 'other.env');
    writeFileSync(explicit, 'TRADE_TOOL_PG_PASSWORD=from_explicit\n');
    stage('TRADE_TOOL_PG_PASSWORD', undefined);

    const result = loadProjectEnv({
      from: join(root, 'apps', 'cli', 'src', 'index.ts'),
      envFile: explicit,
    });

    expect(result.path).toBe(explicit);
    expect(process.env['TRADE_TOOL_PG_PASSWORD']).toBe('from_explicit');
  });
});

describe('findProjectRoot', () => {
  it('从嵌套位置向上找到根目录', () => {
    const root = scaffold();
    expect(findProjectRoot(join(root, 'apps', 'cli', 'src', 'index.ts'))).toBe(root);
  });

  it('没有标记文件时抛错，不回落 cwd', () => {
    const root = scaffold({ marker: false });
    expect(() => findProjectRoot(join(root, 'apps', 'cli', 'src', 'index.ts'))).toThrow(
      /pnpm-workspace\.yaml/,
    );
  });
});

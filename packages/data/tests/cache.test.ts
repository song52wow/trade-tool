import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCache, writeCache } from '../src/cache.js';

let home: string;
let before: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trade-tool-home-'));
  before = process.env['TRADE_TOOL_HOME'];
  process.env['TRADE_TOOL_HOME'] = home;
});

afterEach(() => {
  if (before === undefined) delete process.env['TRADE_TOOL_HOME'];
  else process.env['TRADE_TOOL_HOME'] = before;
});

describe('cache 目录解析', () => {
  it('相对 dir 按 TRADE_TOOL_HOME 解析，不跟随 cwd', async () => {
    const file = await writeCache('BTCUSDT_1h_500', [{ close: 1 }], 'data/cache');

    expect(file).toBe(join(home, 'data', 'cache', 'BTCUSDT_1h_500.json'));
    // cwd 是 packages/data，绝不能落到这里
    expect(file.startsWith(resolve(process.cwd(), 'data'))).toBe(false);
  });

  it('不传 dir 时默认落在 <TRADE_TOOL_HOME>/data/cache', async () => {
    const file = await writeCache('DEFAULT_KEY', { ok: true });

    expect(file).toBe(join(home, 'data', 'cache', 'DEFAULT_KEY.json'));
  });

  it('绝对 dir 原样使用', async () => {
    const absolute = mkdtempSync(join(tmpdir(), 'trade-tool-abs-'));

    const file = await writeCache('ABS_KEY', [1, 2], absolute);

    expect(file).toBe(join(absolute, 'ABS_KEY.json'));
  });

  it('键里的非法文件名字符被替换，不会逃出目录', async () => {
    const file = await writeCache('../../escape', { x: 1 }, 'data/cache');

    expect(resolve(file, '..')).toBe(join(home, 'data', 'cache'));
    expect(existsSync(file)).toBe(true);
  });
});

describe('cache 往返', () => {
  it('写入后能读回同值', async () => {
    const value = [{ close: 1.5 }, { close: 2.5 }];
    await writeCache('ROUNDTRIP', value, 'data/cache');

    await expect(readCache('ROUNDTRIP', 'data/cache')).resolves.toEqual(value);
  });

  it('未命中返回 undefined', async () => {
    await expect(readCache('NOT_THERE', 'data/cache')).resolves.toBeUndefined();
  });
});

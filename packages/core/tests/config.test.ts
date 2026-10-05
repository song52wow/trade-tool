import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configSchema, defaultConfig } from '../src/config.js';
import { loadConfig } from '../src/config-io.js';
import { isSyncError } from '../src/market-sync.js';
import { sma } from '../src/strategy.js';
import { intervalToMs } from '../src/types.js';

describe('configSchema', () => {
  it('补全默认值后可通过校验', () => {
    const parsed = configSchema.parse({ market: { symbol: 'ETHUSDT', interval: '1h' } });
    expect(parsed.market.feeRate).toBe(0.0005);
    expect(parsed.data.python).toBe('uv');
    expect(parsed.version).toBe(1);
  });

  it('拒绝非法周期', () => {
    const result = configSchema.safeParse({ market: { symbol: 'X', interval: '7m' } });
    expect(result.success).toBe(false);
  });

  it('defaultConfig 自洽', () => {
    expect(() => configSchema.parse(defaultConfig())).not.toThrow();
  });
});

describe('配置文件里的明文密码（R-13）', () => {
  it('写了 database.password 直接拒绝，且是结构化的 CONFIG_INVALID', async () => {
    // zod 会**静默剥离**未知键，所以这条断言守的是「显式拒绝」而不是「解析失败」：
    // 一旦哪天改成静默接受，密码会一路被丢掉，直到连库时才报一个位置完全不对的错。
    const dir = await mkdtemp(join(tmpdir(), 'tt-config-'));
    const file = join(dir, 'trade-tool.config.json');
    await writeFile(
      file,
      JSON.stringify({ market: { symbol: 'X' }, database: { password: 'hunter2' } }),
      'utf8',
    );
    const error = await loadConfig(file).catch((e: unknown) => e);
    expect(isSyncError(error)).toBe(true);
    if (isSyncError(error)) expect(error.code).toBe('CONFIG_INVALID');
    expect(String(error)).toContain('passwordEnv');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('sma', () => {
  it('窗口不足时前段为 undefined', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it('拒绝非正窗口', () => {
    expect(() => sma([1, 2], 0)).toThrow(RangeError);
  });
});

describe('intervalToMs', () => {
  it('1h = 3600000ms', () => {
    expect(intervalToMs('1h')).toBe(3_600_000);
  });
});

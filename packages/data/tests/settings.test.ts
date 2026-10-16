/**
 * 运行期设置（v0.5.0）的读写用例：加密凭据 + 止盈止损策略。
 *
 * 重点：
 *   * 控制面那条读路径**永远拿不到明文**（这是整个特性的前提，不是顺手加的）；
 *   * 策略优先级只有一份实现（标的 > 全局 > 配置），页面与 executor 用的是同一个；
 *   * schema 的 CHECK 真的挡住了「global 行带 symbol」「ATR 倍数为 0」这类脏数据。
 *
 * 跑在随机命名的独立 schema 上（helpers/pg.ts），**绝不连生产库**。
 */

import { SyncError } from '@trade-tool/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearCredential,
  readCredentialStatus,
  readCredentials,
  resolvePolicy,
  deleteRiskPolicy,
  listRiskPolicies,
  writeCredential,
  writeRiskPolicy,
} from '../src/index.js';
import type { ExecutorConfig } from '@trade-tool/core';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const EXCHANGE = 'binance';
const SYMBOL = 'SETTINGSUSDC';
const OTHER = 'OTHERUSDC';
const T0 = 1_760_000_000_000;
const KEY = Buffer.from('c'.repeat(64), 'hex');

const CONFIG_FALLBACK: ExecutorConfig = {
  enabled: false,
  atrPeriod: 14,
  atrInterval: '1m',
  atrWindowBars: 240,
  stopAtrMult: 2,
  takeProfitAtrMult: 3,
  symbols: [],
  onPartialFill: 'ignore',
  workingType: 'MARK_PRICE',
  priceProtect: true,
  maxEntryNotional: 0,
  apiKeyEnv: 'TRADE_TOOL_BINANCE_API_KEY',
  apiSecretEnv: 'TRADE_TOOL_BINANCE_API_SECRET',
  recvWindowMs: 5_000,
  reconnectBaseMs: 2_000,
  reconnectMaxMs: 60_000,
};

let schema: TestSchema;

beforeEach(async () => {
  schema = await createTestSchema('set');
});

afterEach(async () => {
  await schema.close();
});

describe('凭据：控制面读路径永远拿不到明文', () => {
  it('未配置时如实报 configured=false', async () => {
    const status = await readCredentialStatus(schema.pool, EXCHANGE);
    expect(status).toMatchObject({ configured: false, hint: null, updatedAt: null });
  });

  it('写入后状态只含「配没配 + 末 4 位」', async () => {
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'abcdef123456',
      apiSecret: 'super-secret-value',
      now: T0,
    });

    const status = await readCredentialStatus(schema.pool, EXCHANGE);
    expect(status.configured).toBe(true);
    expect(status.hint).toBe('3456');
    expect(status.updatedAt).toBe(T0);
    // 整个状态对象里不允许出现 secret 本身
    expect(JSON.stringify(status)).not.toContain('super-secret-value');
  });

  it('落库的是密文：原始 SQL 里搜不到明文', async () => {
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'abcdef123456',
      apiSecret: 'super-secret-value',
      now: T0,
    });
    const rows = await schema.pool.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM executor_credentials WHERE exchange = $1',
      [EXCHANGE],
    );
    expect(rows.rows[0]?.ciphertext.toString('utf8')).not.toContain('super-secret-value');
  });

  it('只有 executor 那条读路径能拿到明文', async () => {
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'abcdef123456',
      apiSecret: 'super-secret-value',
      now: T0,
    });
    expect(await readCredentials(schema.pool, KEY, EXCHANGE)).toEqual({
      apiKey: 'abcdef123456',
      apiSecret: 'super-secret-value',
    });
  });

  it('主密钥换了就解不开，且报错指向「重新录入」', async () => {
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'k-1234',
      apiSecret: 's',
      now: T0,
    });
    const wrong = Buffer.from('d'.repeat(64), 'hex');
    await expect(readCredentials(schema.pool, wrong, EXCHANGE)).rejects.toThrow(/重新在控制面录入/);
  });

  it('再次写入是覆盖而不是保留旧值', async () => {
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'old-1111',
      apiSecret: 's1',
      now: T0,
    });
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'new-2222',
      apiSecret: 's2',
      now: T0 + 1,
    });
    const creds = await readCredentials(schema.pool, KEY, EXCHANGE);
    expect(creds?.apiKey).toBe('new-2222');
    expect((await readCredentialStatus(schema.pool, EXCHANGE)).hint).toBe('2222');
  });

  it('清空后视为没有凭据，而不是拿空 IV 去解密', async () => {
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'old-1111',
      apiSecret: 's1',
      now: T0,
    });
    await clearCredential(schema.pool, EXCHANGE, T0 + 5);
    expect(await readCredentials(schema.pool, KEY, EXCHANGE)).toBeNull();
  });

  it('清空后状态**不算已配置**（否则页面会说谎）', async () => {
    await writeCredential(schema.pool, KEY, {
      exchange: EXCHANGE,
      apiKey: 'old-1111',
      apiSecret: 's1',
      now: T0,
    });
    await clearCredential(schema.pool, EXCHANGE, T0 + 5);

    // tombstone 行还在（updatedAt 变新，页面能显示「已清空」），
    // 但 configured 必须是 false ——executor 实际拿不到任何凭据。
    const status = await readCredentialStatus(schema.pool, EXCHANGE);
    expect(status.configured).toBe(false);
    expect(status.hint).toBeNull();
    expect(status.updatedAt).toBe(T0 + 5);
  });

  it('空值拒绝入库', async () => {
    await expect(
      writeCredential(schema.pool, KEY, {
        exchange: EXCHANGE,
        apiKey: '  ',
        apiSecret: 's',
        now: T0,
      }),
    ).rejects.toThrow(SyncError);
  });
});

describe('策略：优先级只有一份实现', () => {
  it('库里什么都没有时回落配置文件', async () => {
    const resolved = await resolvePolicy(schema.pool, EXCHANGE, SYMBOL, CONFIG_FALLBACK);
    expect(resolved).toMatchObject({ stopAtrMult: 2, takeProfitAtrMult: 3, source: 'config' });
  });

  it('只有全局行时用全局', async () => {
    await writeRiskPolicy(schema.pool, {
      scope: 'global',
      exchange: EXCHANGE,
      symbol: '',
      atrPeriod: 14,
      atrInterval: '1h',
      stopAtrMult: 2.5,
      takeProfitAtrMult: 4,
      now: T0,
    });
    expect(await resolvePolicy(schema.pool, EXCHANGE, SYMBOL, CONFIG_FALLBACK)).toMatchObject({
      stopAtrMult: 2.5,
      source: 'global',
    });
  });

  it('标的覆盖压过全局', async () => {
    await writeRiskPolicy(schema.pool, {
      scope: 'global',
      exchange: EXCHANGE,
      symbol: '',
      atrPeriod: 14,
      atrInterval: '1h',
      stopAtrMult: 2.5,
      takeProfitAtrMult: 4,
      now: T0,
    });
    await writeRiskPolicy(schema.pool, {
      scope: 'symbol',
      exchange: EXCHANGE,
      symbol: SYMBOL,
      atrPeriod: 21,
      atrInterval: '4h',
      stopAtrMult: 1.5,
      takeProfitAtrMult: 6,
      now: T0,
    });
    expect(await resolvePolicy(schema.pool, EXCHANGE, SYMBOL, CONFIG_FALLBACK)).toMatchObject({
      atrPeriod: 21,
      atrInterval: '4h',
      stopAtrMult: 1.5,
      takeProfitAtrMult: 6,
      source: 'symbol',
    });
    // 别的标的仍然走全局——覆盖必须是**按标的**的，不能漏出去。
    expect(await resolvePolicy(schema.pool, EXCHANGE, OTHER, CONFIG_FALLBACK)).toMatchObject({
      stopAtrMult: 2.5,
      source: 'global',
    });
  });

  it('删除覆盖后回到全局', async () => {
    await writeRiskPolicy(schema.pool, {
      scope: 'global',
      exchange: EXCHANGE,
      symbol: '',
      atrPeriod: 14,
      atrInterval: '1h',
      stopAtrMult: 2.5,
      takeProfitAtrMult: 4,
      now: T0,
    });
    await writeRiskPolicy(schema.pool, {
      scope: 'symbol',
      exchange: EXCHANGE,
      symbol: SYMBOL,
      atrPeriod: 21,
      atrInterval: '4h',
      stopAtrMult: 1.5,
      takeProfitAtrMult: 6,
      now: T0,
    });
    await deleteRiskPolicy(schema.pool, 'symbol', EXCHANGE, SYMBOL);
    expect(await resolvePolicy(schema.pool, EXCHANGE, SYMBOL, CONFIG_FALLBACK)).toMatchObject({
      source: 'global',
      stopAtrMult: 2.5,
    });
  });

  it('listRiskPolicies 把全局与覆盖分开返回', async () => {
    await writeRiskPolicy(schema.pool, {
      scope: 'global',
      exchange: EXCHANGE,
      symbol: '',
      atrPeriod: 14,
      atrInterval: '1h',
      stopAtrMult: 2.5,
      takeProfitAtrMult: 4,
      now: T0,
    });
    await writeRiskPolicy(schema.pool, {
      scope: 'symbol',
      exchange: EXCHANGE,
      symbol: SYMBOL,
      atrPeriod: 21,
      atrInterval: '4h',
      stopAtrMult: 1.5,
      takeProfitAtrMult: 6,
      now: T0,
    });
    const rows = await listRiskPolicies(schema.pool, EXCHANGE);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.scope === 'global')).toHaveLength(1);
    expect(rows.filter((r) => r.scope === 'symbol')).toHaveLength(1);
  });
});

describe('策略：schema 挡住脏数据', () => {
  it('global 行不允许带 symbol', async () => {
    await expect(
      writeRiskPolicy(schema.pool, {
        scope: 'global',
        exchange: EXCHANGE,
        symbol: SYMBOL,
        atrPeriod: 14,
        atrInterval: '1h',
        stopAtrMult: 2,
        takeProfitAtrMult: 3,
        now: T0,
      }),
    ).rejects.toThrow(/全局默认策略不能带标的/);
  });

  it('ATR 倍数为 0 被 CHECK 挡住（会让止损落在入场价上）', async () => {
    await expect(
      writeRiskPolicy(schema.pool, {
        scope: 'symbol',
        exchange: EXCHANGE,
        symbol: SYMBOL,
        atrPeriod: 14,
        atrInterval: '1h',
        stopAtrMult: 0,
        takeProfitAtrMult: 3,
        now: T0,
      }),
    ).rejects.toThrow();
  });

  it('未实现的周期被 CHECK 挡住，不留到取数时才报错', async () => {
    await expect(
      writeRiskPolicy(schema.pool, {
        scope: 'symbol',
        exchange: EXCHANGE,
        symbol: SYMBOL,
        atrPeriod: 14,
        atrInterval: '5m',
        stopAtrMult: 2,
        takeProfitAtrMult: 3,
        now: T0,
      }),
    ).rejects.toThrow();
  });
});

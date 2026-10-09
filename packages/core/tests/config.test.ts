import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configSchema, defaultConfig } from '../src/config.js';
import { loadConfig } from '../src/config-io.js';
import { MANUAL_INTERVENTION_CODES, isSyncError } from '../src/market-sync.js';
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

/** 只关心 data 段的用例：补上必填的 market，其余交给各自的断言。 */
function parseData(data: Record<string, unknown>) {
  return configSchema.parse({ market: { symbol: 'ETHUSDT', interval: '1h' }, data });
}

describe('indicatorSpecs', () => {
  it('缺省值与 005_indicators.sql 的表集合一致（AC-2）', () => {
    const parsed = parseData({});
    const specs = parsed.data.indicatorSpecs;
    // 7 张表全部有缺省参数集：少任何一个，那张表就永远不会被写入，
    // 而控制面只会显示「该周期 0 行」——看不出是「没配」还是「还没算」。
    expect(Object.keys(specs).sort()).toEqual(
      ['atr', 'boll', 'kdj', 'ma', 'macd', 'obv', 'rsi'].sort(),
    );
    expect(specs.ma.map((m) => m.window)).toEqual([5, 10, 20, 60]);
    expect(specs.macd).toEqual([{ fast: 12, slow: 26, signal: 9 }]);
    expect(specs.boll).toEqual([{ period: 20, kMilli: 2000 }]);
    expect(specs.kdj).toEqual([{ n: 9, kPeriod: 3, dPeriod: 3 }]);
    expect(specs.obv).toEqual([{}]);
  });

  it('缺省行集数为 10（附录 B.2：体积的直接决定因素）', () => {
    const { indicatorSpecs } = parseData({}).data;
    const count =
      indicatorSpecs.ma.length +
      indicatorSpecs.macd.length +
      indicatorSpecs.rsi.length +
      indicatorSpecs.boll.length +
      indicatorSpecs.kdj.length +
      indicatorSpecs.atr.length +
      indicatorSpecs.obv.length;
    expect(count).toBe(10);
  });

  it('{} = 显式关闭指标层，是合法配置（R-12.2 / AC-23）', () => {
    const parsed = parseData({ indicatorSpecs: {} });
    const specs = parsed.data.indicatorSpecs;
    const count =
      specs.ma.length +
      specs.macd.length +
      specs.rsi.length +
      specs.boll.length +
      specs.kdj.length +
      specs.atr.length +
      specs.obv.length;
    expect(count).toBe(0);
  });

  it('参数必须是正整数：浮点 / 负数 / 零一律拒绝（R-1.4）', () => {
    for (const bad of [2.5, -1, 0, '5', true]) {
      expect(() => parseData({ indicatorSpecs: { rsi: [{ period: bad }] } })).toThrow();
    }
  });

  it('kMilli 允许 0（k = 0 时三轨重合），但不允许负数', () => {
    expect(
      parseData({ indicatorSpecs: { boll: [{ period: 20, kMilli: 0 }] } }).data.indicatorSpecs.boll,
    ).toEqual([{ period: 20, kMilli: 0 }]);
    expect(() => parseData({ indicatorSpecs: { boll: [{ period: 20, kMilli: -1 }] } })).toThrow();
  });

  it('改窗口是「改配置」而不是「改 schema」（AC-3 / R-3.3）', () => {
    const parsed = parseData({
      indicatorSpecs: {
        ma: [{ kind: 'sma', window: 30 }],
        macd: [{ fast: 8, slow: 17, signal: 9 }],
      },
    });
    expect(parsed.data.indicatorSpecs.ma).toEqual([{ kind: 'sma', window: 30 }]);
    expect(parsed.data.indicatorSpecs.macd).toEqual([{ fast: 8, slow: 17, signal: 9 }]);
  });

  it('indicatorIntervals 出现 1m / 5m / 其它一律拒绝（N-2 / N-3）', () => {
    for (const bad of ['1m', '5m', '2h', 'foo']) {
      expect(() => parseData({ indicatorIntervals: [bad] })).toThrow();
    }
  });

  it('indicatorIntervals 允许子集与空数组（显式关闭）', () => {
    expect(parseData({ indicatorIntervals: ['1h', '4h'] }).data.indicatorIntervals).toEqual([
      '1h',
      '4h',
    ]);
    expect(parseData({ indicatorIntervals: [] }).data.indicatorIntervals).toEqual([]);
  });
});

describe('MANUAL_INTERVENTION_CODES', () => {
  it('指标层的三个码都需人工介入（v0.3.0 R-12.3）', () => {
    for (const code of [
      'INDICATOR_FAILED',
      'INDICATOR_MISMATCH',
      'INDICATOR_IMPL_STALE',
    ] as const) {
      expect(MANUAL_INTERVENTION_CODES.has(code)).toBe(true);
    }
  });

  it('SYNC_ALREADY_RUNNING 不算人工介入：那是良性并发，不是故障', () => {
    expect(MANUAL_INTERVENTION_CODES.has('SYNC_ALREADY_RUNNING')).toBe(false);
  });

  it('可恢复的 PG 错误不算人工介入', () => {
    for (const code of [
      'DB_CONNECTION_FAILED',
      'DB_DEADLOCK',
      'DB_TRANSACTION_ROLLBACK',
    ] as const) {
      expect(MANUAL_INTERVENTION_CODES.has(code)).toBe(false);
    }
  });
});

describe('intervalToMs', () => {
  it('1h = 3600000ms', () => {
    expect(intervalToMs('1h')).toBe(3_600_000);
  });
});

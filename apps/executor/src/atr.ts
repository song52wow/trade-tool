/**
 * ATR 取数适配：把「按成交时刻算 ATR」接到跨语言接缝上（v0.4.0）。
 *
 * 为什么不直接让 TS 读 K 线自己算：指标公式只允许出现在 `quant_core`
 * （AGENTS.md 硬性约定 4）。而且 K 线**不经 stdout 传输**（R-2.1）——
 * 这里只把控制信息交给 `python -m quant_data risk-atr`，回一个 ATR 小摘要，
 * 读库与算公式都在 Python 侧完成。服务不联网、不吃交易所配额。
 */

import { runPython, type PythonRuntime } from '@trade-tool/data';
import { SyncError, type ExecutorConfig } from '@trade-tool/core';

/** `risk-atr` 的返回摘要。字段名与 Python 侧 `AtrSnapshot.to_dict()` 一致。 */
export interface AtrSnapshot {
  symbol: string;
  interval: string;
  intervalMs: number;
  period: number;
  atr: number;
  barsUsed: number;
  segmentFrom: number;
  segmentTo: number;
  asOfMs: number;
  /**
   * 持仓期极值（v0.7.0）：移动止损的基准。
   *
   * `from` / `to` 是**实际取数的那段**的起止，**可能短于整个持仓期**——
   * 因为极值不许跨缺口，取的是 `asOf` 侧那个极大连续段。短了就如实回传，
   * 让调用方知道「这个极值只覆盖到这里」，而不是猜一个覆盖全程的值。
   */
  extreme: { high: number; low: number; from: number; to: number };
  /**
   * 取数范围内最后一根已收盘 K 线的收盘价（与 `extreme` 同一段数据、同一次取数）。
   *
   * 用来判断「算出来的新止损位是不是已经越过现价」——越过了挂上去会立刻触发，
   * 等于用市价平仓。**必须**跟 ATR / 极值同一次返回：分两次取，中间会落进一根新 K 线，
   * 两者来自不同时刻，判断随即失去意义；另开 REST 取价则会给服务凭空加一条出网路径。
   */
  lastClose: number;
}

export interface AtrProvider {
  /**
   * 取某个时刻、某个标的的 ATR。
   *
   * `override` 让**每个标的用各自的策略参数**（v0.5.0 起策略可在控制面按标的覆盖）。
   * 不传就用构造时的配置兜底——测试与「库里没配策略」的情形都走这一档。
   */
  atrAt(
    symbol: string,
    asOfMs: number,
    /**
     * 持仓起点。**必填**：极值是「持仓期内」的极值，没有起点就算不出来。
     * 刻意不给缺省值——默认成 0 或 `asOf` 都会算出一个看似正常的极值，
     * 而它其实没有意义（AGENTS.md 约定 8）。
     */
    entryTimeMs: number,
    override?: { interval?: string; period?: number },
  ): Promise<AtrSnapshot>;
}

export interface CreateAtrProviderOptions {
  runtime: PythonRuntime;
  /** libpq 连接串。经环境变量注入，不进 argv。 */
  dsn: string;
  config: ExecutorConfig;
  timeoutMs?: number;
}

/** 收一个「必须是有限数字」的字段，否则明确报错。 */
function finite(value: unknown, field: string, symbol: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SyncError('INTERNAL_ERROR', `risk-atr 返回的 ${field} 不是有限数字：${symbol}`, {
      symbol,
      field,
      value: String(value),
    });
  }
  return value;
}

/**
 * 校验返回的摘要。
 *
 * 这一步不是多余的：Python 侧万一改了字段名或返回了字符串化的数字，
 * `atr` 会静默变成 `NaN`，再往后 `deriveBracketPlan` 会因为 ATR <= 0 抛错——
 * 但那时错误信息指向「策略参数」，而不是「接缝返回了坏数据」，排查会被带偏。
 */
function validate(raw: unknown, symbol: string): AtrSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    throw new SyncError('INTERNAL_ERROR', `risk-atr 没有返回 JSON 对象：${symbol}`, { symbol });
  }
  const r = raw as Record<string, unknown>;
  const need = (field: string): number => finite(r[field], field, symbol);
  const rawExtreme = r['extreme'];
  if (typeof rawExtreme !== 'object' || rawExtreme === null) {
    // 极值缺字段时**不静默补 0**：补 0 会让 Chandelier 算出一个「止损 = −k×ATR」
    // 的怪价，而它要到价格反向运行时才显形（v0.7.0 R-6.3）。
    throw new SyncError(
      'INTERNAL_ERROR',
      `risk-atr 返回的摘要里没有 extreme 字段：${symbol}（Python 侧可能还没升级到 v0.7.0 的摘要形状）`,
      { symbol },
    );
  }
  const e = rawExtreme as Record<string, unknown>;
  const extreme = {
    high: finite(e['high'], 'extreme.high', symbol),
    low: finite(e['low'], 'extreme.low', symbol),
    from: finite(e['from'], 'extreme.from', symbol),
    to: finite(e['to'], 'extreme.to', symbol),
  };

  const snapshot: AtrSnapshot = {
    symbol: typeof r['symbol'] === 'string' ? r['symbol'] : symbol,
    interval: typeof r['interval'] === 'string' ? r['interval'] : String(r['interval']),
    intervalMs: need('intervalMs'),
    period: need('period'),
    atr: need('atr'),
    barsUsed: need('barsUsed'),
    segmentFrom: need('segmentFrom'),
    segmentTo: need('segmentTo'),
    asOfMs: need('asOfMs'),
    extreme,
    lastClose: need('lastClose'),
  };
  if (snapshot.atr <= 0) {
    throw new SyncError('RISK_ATR_UNAVAILABLE', `risk-atr 返回了非正的 ATR：${snapshot.atr}`, {
      symbol,
      atr: snapshot.atr,
    });
  }
  return snapshot;
}

export function createAtrProvider(options: CreateAtrProviderOptions): AtrProvider {
  const { runtime, dsn, config } = options;
  return {
    async atrAt(
      symbol: string,
      asOfMs: number,
      entryTimeMs: number,
      override?: { interval?: string; period?: number },
    ): Promise<AtrSnapshot> {
      // 参数一律来自「本次解析出的那份策略」，不在这里兜底：调用方已经决定过优先级，
      // 这一层再兜一次就会出现「页面显示 A、实际按 B 算」的分裂。
      const interval = override?.interval ?? config.atrInterval;
      const period = override?.period ?? config.atrPeriod;
      const { value } = await runPython<unknown>({
        runtime,
        module: 'quant_data',
        args: [
          'risk-atr',
          '--symbol',
          symbol,
          '--interval',
          interval,
          '--period',
          String(period),
          '--as-of-ms',
          String(asOfMs),
          // 持仓起点：极值按「持仓期内」算，缺了它就没有极值。
          '--entry-time',
          String(entryTimeMs),
          '--window-bars',
          String(config.atrWindowBars),
        ],
        env: { TRADE_TOOL_PG_DSN: dsn },
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      return validate(value, symbol);
    },
  };
}

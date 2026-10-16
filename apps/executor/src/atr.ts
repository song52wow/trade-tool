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
  const need = (field: string): number => {
    const value = r[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SyncError('INTERNAL_ERROR', `risk-atr 返回的 ${field} 不是有限数字：${symbol}`, {
        symbol,
        field,
        value: String(value),
      });
    }
    return value;
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

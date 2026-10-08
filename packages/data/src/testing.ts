import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本地假交易所——**仅供测试**（R-16.5：测试过程中**不得访问真实网络**）。
 *
 * 放在 `src/` 而不是 `tests/` 是为了让 `apps/sync` 等包也能直接 import 它：
 * 全局限速、生命周期、错误隔离这些验收都需要「真实 Python 引擎 + 真实 PG + 假交易所」
 * 才能证成，各自复制一份假交易所只会让它们漂移。它不做任何 import 期副作用，
 * 只有显式调用 `startMockExchange()` 才会起服务。
 *
 * 它实现 Python 侧需要的两个端点，并把 base URL 通过 `TRADE_TOOL_BINANCE_BASE_URL`
 * 注入子进程，因此可以在不碰 Binance 的前提下跑**真实的 Python 引擎**。
 *
 * 标的全部用合成名（`TESTAAAUSDC` 之类），这既是 fixture 允许的范围，
 * 也顺带证明源码里没有任何真实合约名（R-5 / AC-15）。
 */

export const MINUTE = 60_000;

export interface MockSymbolSpec {
  symbol: string;
  contractType: string;
  status: string;
  onboardDate: number;
}

export interface MockBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
  trades: number | null;
}

export interface MockExchange {
  url: string;
  /** 收到的 kline 请求，用于断言分页、去重、起点边界 */
  readonly klineRequests: { symbol: string; startTime?: number; endTime?: number; limit: number }[];
  /** 逐标的注入交易所侧故障（用于缺口重试上限、边界违规等场景） */
  failKlines(symbol: string, error: MockKlineFailure | null): void;
  /** 清空**所有**已注入的故障——只传 `failKlines('', null)` 是清不掉的 */
  clearFailures(): void;
  /**
   * 清空**全部注入态**：故障、时间偏移、人为制造的缺口、限速。
   *
   * 用例之间必须调用它（`resetExchange()`）。只重置标的集合（`setSymbols`）是不够的：
   * 时间偏移与 dropRange 独立于 `specs` / `bars` 存活，一旦某个用例**中途失败或超时**
   * 没走到自己的复原语句（AC-31 末尾的 `shiftAllTimes(sym, 0)`、AC-7 的 dropRange），
   * 状态就会漏进后面的用例——实测见过它表现为另一个用例抛
   * `BACKFILL_BOUNDARY_VIOLATION`：一个看似「同步逻辑坏了」的错误，真实原因却是
   * 上一个用例超时留下的偏移。那种失败信息比失败本身更难查。
   */
  resetOverrides(): void;
  /** 人为删掉某段时间的 bar，制造缺口（AC-7） */
  dropRange(symbol: string, from: number, to: number): void;
  /** 人为篡改最后一根的 close（AC-30 最后一根自愈） */
  tamperLastBarClose(symbol: string, close: number): void;
  /** 覆盖返回的 bar 时间，模拟交易所忽略 startTime（AC-31 边界违规） */
  shiftAllTimes(symbol: string, deltaMs: number): void;
  setSymbols(specs: readonly MockSymbolSpec[]): void;
  /** 交易所被整体限速时，kline 端点返回的 HTTP 状态 */
  setRateLimit(status: number | null, retryAfterSec: number): void;
  requests: { exchangeInfo: number; klines: number };
  close(): Promise<void>;
}

export type MockKlineFailure =
  { kind: 'http'; status: number; body: unknown } | { kind: 'network' };

interface MockServerOptions {
  symbols?: readonly MockSymbolSpec[];
  /** 默认生成的历史长度（1m bar 数） */
  historyBars?: number;
  /** 生成的最后一根「收盘时间」——固定值以便断言 */
  nowMs: number;
}

/** 12 字段顺序与 Binance 一致（附录 A.2），必须按下标解析。 */
function toKlineArray(bar: MockBar): unknown[] {
  return [
    bar.time,
    String(bar.open),
    String(bar.high),
    String(bar.low),
    String(bar.close),
    String(bar.volume),
    bar.time + MINUTE - 1,
    bar.quoteVolume === null ? null : String(bar.quoteVolume),
    bar.trades === null ? null : bar.trades,
    '0',
    '0',
    '0',
  ];
}

export async function startMockExchange(options: MockServerOptions): Promise<MockExchange> {
  const nowMs = options.nowMs;
  const lastClosed = Math.floor(nowMs / MINUTE) * MINUTE - MINUTE;
  const historyBars = options.historyBars ?? 600;

  const specs = new Map<string, MockSymbolSpec>();
  for (const spec of options.symbols ?? []) specs.set(spec.symbol, { ...spec });

  const bars = new Map<string, MockBar[]>();
  const dropRanges = new Map<string, { from: number; to: number }[]>();
  const failures = new Map<string, MockKlineFailure>();
  const shifts = new Map<string, number>();
  let rateLimit: { status: number; retryAfterSec: number } | null = null;

  const klineRequests: MockExchange['klineRequests'] = [];
  const requests = { exchangeInfo: 0, klines: 0 };

  const baseFor = (i: number): number => 100 + (i % 97) * 0.5;

  function buildSeries(symbol: string): MockBar[] {
    const spec = specs.get(symbol);
    const from = spec ? spec.onboardDate : lastClosed - (historyBars - 1) * MINUTE;
    const start = Math.floor(from / MINUTE) * MINUTE;
    const count = Math.floor((lastClosed - start) / MINUTE) + 1;
    const out: MockBar[] = [];
    for (let i = 0; i < count; i += 1) {
      const time = start + i * MINUTE;
      const base = baseFor(i);
      out.push({
        time,
        open: base,
        high: base + 1,
        low: base - 1,
        close: base + 0.25,
        volume: 10 + (i % 13),
        // 每 5 根缺一个可选字段，用于验证「交易所未提供」的 NULL 语义（R-4.2）
        quoteVolume: i % 5 === 0 ? null : base * 2,
        trades: i % 5 === 0 ? null : 5 + (i % 11),
      });
    }
    return out;
  }

  function seriesFor(symbol: string): MockBar[] {
    const cached = bars.get(symbol);
    if (cached) return cached;
    const built = buildSeries(symbol);
    bars.set(symbol, built);
    return built;
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    };

    if (url.pathname === '/fapi/v1/exchangeInfo') {
      requests.exchangeInfo += 1;
      send(200, {
        timezone: 'UTC',
        symbols: [...specs.values()].map((spec) => ({
          symbol: spec.symbol,
          contractType: spec.contractType,
          status: spec.status,
          onboardDate: spec.onboardDate,
          filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }],
        })),
      });
      return;
    }

    if (url.pathname === '/fapi/v1/klines') {
      requests.klines += 1;
      const symbol = url.searchParams.get('symbol') ?? '';
      const startTime = url.searchParams.get('startTime');
      const endTime = url.searchParams.get('endTime');
      const limit = Number(url.searchParams.get('limit') ?? '500');
      klineRequests.push({
        symbol,
        ...(startTime === null ? {} : { startTime: Number(startTime) }),
        ...(endTime === null ? {} : { endTime: Number(endTime) }),
        limit,
      });

      if (rateLimit) {
        res.writeHead(rateLimit.status, {
          'content-type': 'application/json',
          'retry-after': String(rateLimit.retryAfterSec),
        });
        res.end(JSON.stringify({ code: -1003, msg: 'Too many requests.' }));
        return;
      }

      const failure = failures.get(symbol);
      if (failure) {
        if (failure.kind === 'network') {
          req.destroy();
          return;
        }
        send(failure.status, failure.body);
        return;
      }

      if (!specs.has(symbol)) {
        send(400, { code: -1121, msg: 'Invalid symbol.' });
        return;
      }

      let series = seriesFor(symbol).filter((bar) => {
        const holes = dropRanges.get(symbol) ?? [];
        return !holes.some((hole) => bar.time >= hole.from && bar.time <= hole.to);
      });

      // 先按未平移的时间过滤（模拟交易所正确处理了 startTime / endTime），
      // 再把返回的时间整体平移 —— 这样才能构造出「返回了 time < startTime 的 bar」
      // 这一边界违规场景（AC-31）。若先平移再过滤，结果会被过滤成空集。
      if (startTime !== null) {
        const from = Number(startTime);
        series = series.filter((bar) => bar.time >= from);
      }
      if (endTime !== null) {
        const to = Number(endTime);
        series = series.filter((bar) => bar.time <= to);
      }

      const shift = shifts.get(symbol) ?? 0;
      const sliced = series.slice(0, limit).map((bar) => ({ ...bar, time: bar.time + shift }));
      // 关键：**最后一根是进行中的 bar**（附录 A.4），引擎必须无条件丢弃它。
      send(200, sliced.map(toKlineArray));
      return;
    }

    send(404, { code: -1121, msg: 'Unknown endpoint.' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    klineRequests,
    requests,
    failKlines: (symbol, error) => {
      if (error === null) failures.delete(symbol);
      else failures.set(symbol, error);
    },
    clearFailures: () => failures.clear(),
    resetOverrides: () => {
      failures.clear();
      shifts.clear();
      dropRanges.clear();
      rateLimit = null;
      klineRequests.length = 0;
      requests.exchangeInfo = 0;
      requests.klines = 0;
    },
    dropRange: (symbol, from, to) => {
      const list = dropRanges.get(symbol) ?? [];
      list.push({ from, to });
      dropRanges.set(symbol, list);
    },
    tamperLastBarClose: (symbol, close) => {
      const series = seriesFor(symbol);
      const last = series[series.length - 1];
      if (last) {
        series[series.length - 1] = {
          ...last,
          close,
          high: Math.max(last.high, close),
          low: Math.min(last.low, close),
        };
      }
    },
    shiftAllTimes: (symbol, deltaMs) => shifts.set(symbol, deltaMs),
    setSymbols: (next) => {
      specs.clear();
      for (const spec of next) specs.set(spec.symbol, { ...spec });
      bars.clear();
    },
    setRateLimit: (status, retryAfterSec) => {
      rateLimit = status === null ? null : { status, retryAfterSec };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 三个合成标的，`onboardDate` 刻意相差很大——证明首次起点真的来自运行时元数据。 */
export function makeMockSymbols(nowMs: number): MockSymbolSpec[] {
  const day = 24 * 60 * MINUTE;
  return [
    {
      symbol: 'TESTAAAUSDC',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      onboardDate: nowMs - 30 * day,
    },
    {
      symbol: 'TESTBBBUSDC',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      onboardDate: nowMs - 120 * day,
    },
    {
      symbol: 'TESTCCCUSDC',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      onboardDate: nowMs - 7 * day,
    },
  ];
}

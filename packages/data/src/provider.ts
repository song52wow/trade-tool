import { createLogger, type Bar, type Interval } from '@trade-tool/core';

import { readCache, writeCache } from './cache.js';
import { runPython, seriesBufferBytes, type PythonRuntime } from './bridge.js';

const log = createLogger('data:provider');

/** python 侧 quant_data 的返回契约，两端必须同时改。 */
export interface PythonSeries {
  symbol: string;
  interval: Interval;
  bars: Bar[];
}

export interface LoadBarsOptions {
  symbol: string;
  interval: Interval;
  bars: number;
  runtime: PythonRuntime;
  timeoutMs?: number;
  /** 命中缓存时直接返回，跳过 python */
  useCache?: boolean;
  cacheDir?: string;
}

function cacheKey(options: LoadBarsOptions): string {
  return `${options.symbol}_${options.interval}_${options.bars}`;
}

function assertSeries(value: unknown): PythonSeries {
  if (typeof value !== 'object' || value === null) {
    throw new Error('python 返回值不是对象');
  }
  const series = value as Partial<PythonSeries>;
  if (!Array.isArray(series.bars) || series.bars.length === 0) {
    throw new Error('python 返回的 bars 为空');
  }
  for (const [i, bar] of series.bars.entries()) {
    for (const field of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
      if (typeof bar?.[field] !== 'number' || !Number.isFinite(bar[field] as number)) {
        throw new Error(`python 返回的 bars[${i}].${field} 非法`);
      }
    }
  }
  return series as PythonSeries;
}

/**
 * 拉取 K 线：优先读本地缓存，未命中则通过 python 侧生成/获取后回写缓存。
 * 这里是 TS 与 Python 唯一的运行时交界处，上层只关心 Bar[]。
 */
export async function loadBars(options: LoadBarsOptions): Promise<Bar[]> {
  const key = cacheKey(options);
  if (options.useCache !== false) {
    const cached = await readCache<Bar[]>(key, options.cacheDir);
    if (cached && cached.length > 0) {
      log.info(`cache hit ${key} (${cached.length} bars)`);
      return cached;
    }
  }

  log.info(`fetching ${key} via python(${options.runtime})`);
  const { value } = await runPython<PythonSeries>({
    runtime: options.runtime,
    module: 'quant_data',
    args: [
      'generate',
      '--symbol',
      options.symbol,
      '--interval',
      options.interval,
      '--bars',
      String(options.bars),
    ],
    // 系列链路的 bars 走 stdout（既有合成源，AC-29 要求不回归），
    // 因此缓冲必须随 bar 数放大，否则 4MiB 的摘要上限会在约 3 万根处硬失败。
    maxBufferBytes: seriesBufferBytes(options.bars),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const series = assertSeries(value);
  if (options.useCache !== false) {
    await writeCache(key, series.bars, options.cacheDir);
  }
  return series.bars;
}

import {
  lastDefined,
  sma,
  type Bar,
  type Interval,
  type Signal,
  type Strategy,
} from '@trade-tool/core';

export interface MaCrossParams {
  fast: number;
  slow: number;
}

/** 双均线交叉：快线上穿慢线做多，下穿平仓。纯函数，无状态。 */
export class MaCrossStrategy implements Strategy {
  readonly name = 'ma-cross';
  readonly closeOnExit = true;
  readonly interval: Interval;
  private readonly fast: number;
  private readonly slow: number;

  constructor(interval: Interval, params: Partial<MaCrossParams> = {}) {
    this.interval = interval;
    this.fast = params.fast ?? 20;
    this.slow = params.slow ?? 60;
    if (this.fast >= this.slow) {
      throw new RangeError(`fast(${this.fast}) 必须小于 slow(${this.slow})`);
    }
  }

  onBar(bar: Bar, history: readonly Bar[]): Signal | undefined {
    if (history.length < this.slow) return undefined;
    const closes = history.map((b) => b.close);
    const fastNow = lastDefined(sma(closes, this.fast));
    const slowNow = lastDefined(sma(closes, this.slow));
    const fastPrev = lastDefined(sma(closes.slice(0, -1), this.fast));
    const slowPrev = lastDefined(sma(closes.slice(0, -1), this.slow));
    if (fastNow === undefined || slowNow === undefined) return undefined;
    if (fastPrev === undefined || slowPrev === undefined) return undefined;

    if (fastPrev <= slowPrev && fastNow > slowNow) {
      return { symbol: 'MA', time: bar.time, side: 'long', strength: 1, reason: 'ma-golden-cross' };
    }
    if (fastPrev >= slowPrev && fastNow < slowNow) {
      return { symbol: 'MA', time: bar.time, side: 'short', strength: 1, reason: 'ma-death-cross' };
    }
    return undefined;
  }
}

import type { Bar, Interval, Signal } from './types.js';

/**
 * 策略统一接口：输入历史 K 线，输出信号。
 * 保持纯函数（无 IO、无随机），回测与实盘复用同一份实现。
 */
export interface Strategy {
  readonly name: string;
  readonly interval: Interval;
  /** 返回该 bar 时间点上产生的信号，无信号则不返回值 */
  onBar(bar: Bar, history: readonly Bar[]): Signal | undefined;
  /** 可选：策略在最后收盘时是否强制平仓 */
  readonly closeOnExit?: boolean;
}

/** 简单移动均线；窗口不足时返回 undefined 序列对齐问题交由调用方用 lookback 处理。 */
export function sma(values: readonly number[], window: number): (number | undefined)[] {
  if (window <= 0) throw new RangeError('sma window 必须为正整数');
  const out: (number | undefined)[] = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    sum += v;
    if (i >= window) sum -= values[i - window]!;
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

export function lastDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (v !== undefined) return v;
  }
  return undefined;
}

import type { StoredInterval } from '@trade-tool/core';

/**
 * 桶宽（毫秒）。**刻意不 import `@trade-tool/core` 的 `intervalToMs`**。
 *
 * 那个函数是 `core` 的**值**导出，而 `core` 的 barrel 同时导出 `config-io` / `env`
 * （它们 import `node:fs` / `node:path`）。从 UI 引用它的**值**会把 Node 内置模块
 * 拖进浏览器产物，vite 直接构建失败。UI 一贯只 `import type` 引用 core，原因就在这里。
 *
 * 这两个常量属于**展示层**（页面上显示哪几个周期、怎么把分钟换算成根），
 * 由 UI 自己持有既不违反分层，也避免了打包问题。要与服务端对齐由 AC-12 的
 * 「回包带 `intervalMs` 生效值」保证——页面不猜，一律用服务端给的数。
 */
const BAR_MS_BY_INTERVAL: Readonly<Record<StoredInterval, number>> = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function intervalMs(interval: StoredInterval): number {
  return BAR_MS_BY_INTERVAL[interval];
}

import type { BarDto, BarsDto } from '../../../src/types';

/**
 * 缺口统计。**单位是「根」而不是「分钟」**。
 *
 * v0.1.0 时期周期固定 1m，缺一根就等于缺一分钟，写「缺 30 分钟」没有歧义。
 * 有了派生周期之后这句话会变成谎话：4h 图上少一根是**缺了 4 小时的数据**，
 * 而它的根因通常是上游 1m 缺了 30 根。两者必须分开说（v0.2.0 R-7.3），
 * 所以这里一律用「根」，把分钟换算交给调用方按所选周期决定。
 */
export interface GapStats {
  /** 首末两根之间应有的根数（含端点） */
  expected: number;
  present: number;
  missing: number;
  /** 连续缺失的段数 */
  holes: number;
  /** 连续缺失最长的一段（根） */
  longest: number;
}

/**
 * 窗口内的缺口统计，**只在首末两根之间算**。
 *
 * 图上就只画这一段，头尾还没同步到的部分不算缺口（那是覆盖范围，不是洞）。
 * 空输入返回 null——没有数据时不该显示「缺 0 根」。
 *
 * `barMs` 来自**服务端回传的 `intervalMs`**（R-7.3），不是前端写死的 60_000：
 * 写死就等于在 4h 图上按分钟步进，「缺 1 根」会被算成 1 根却跨越 4 小时。
 */
export function gapStats(bars: readonly BarDto[], barMs: number): GapStats | null {
  if (bars.length === 0) return null;
  const step = barMs > 0 ? barMs : 1;
  const first = bars[0]?.time ?? 0;
  const last = bars[bars.length - 1]?.time ?? first;
  const expected = Math.floor((last - first) / step) + 1;
  let holes = 0;
  let longest = 0;
  let run = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]?.time ?? first;
    const cur = bars[i]?.time ?? first;
    const missing = Math.max(0, Math.round((cur - prev) / step) - 1);
    if (missing > 0) {
      holes += 1;
      run += missing;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return {
    expected,
    present: bars.length,
    missing: Math.max(0, expected - bars.length),
    holes,
    longest,
  };
}

/** 缺一根对应的时长文案。1m 仍是「分钟」，其余按周期说「根（≈ 时长）」。 */
export function describeSpan(barMs: number, count: number): string {
  if (barMs === 60_000) return `${count.toLocaleString('zh-CN')} 分钟`;
  const hours = (barMs * count) / 3_600_000;
  if (hours < 48) return `${hours.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 小时`;
  return `${(hours / 24).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 天`;
}

/** 把 `1m` 的分钟数换算成当前周期下的「约几根」，用于说明上游 1m 根因。 */
export function minutesToBars(minutes: number, barMs: number): number {
  return Math.round((minutes * 60_000) / barMs);
}

export const EMPTY_BARS: BarsDto = {
  symbol: '',
  interval: '1m',
  intervalMs: intervalMs('1m'),
  limit: 0,
  items: [],
};

/** 页面上的周期切换控件。顺序由短到长，读起来是「越来越粗」。 */
export const ALL_INTERVALS: readonly StoredInterval[] = ['1m', '15m', '1h', '4h', '1d'];

const MINUTE = 60_000;

/** epoch 毫秒 → 本地可读时间；null 显式显示成「—」，不假装是 0。 */
export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * epoch 毫秒 → **本地**日期（`YYYY-MM-DD`）。
 *
 * 必须与 {@link fmtTime} 用同一个时区：这里原来走 `toISOString()`（UTC），
 * 而 `fmtTime` 走本地，拼在同一行（对账面板的「快照时间」）时，
 * UTC+8 的凌晨会显示成「2026-11-10 2026/11/11 00:30」——差一天。
 */
export function fmtDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const date = new Date(ms);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('zh-CN');
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < MINUTE) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 60 * MINUTE) return `${(ms / MINUTE).toFixed(1)} 分钟`;
  return `${(ms / (60 * MINUTE)).toFixed(1)} 小时`;
}

/** 「多久之前」，用于 lastRunAt / lastSuccessAt 这类相对时间。 */
export function fmtAgo(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined) return '从未';
  const diff = now - ms;
  if (diff < 0) return '刚刚';
  if (diff < 5_000) return '刚刚';
  if (diff < MINUTE) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 60 * MINUTE) return `${Math.round(diff / MINUTE)} 分钟前`;
  if (diff < 24 * 60 * MINUTE) return `${Math.round(diff / (60 * MINUTE))} 小时前`;
  return `${Math.round(diff / (24 * 60 * MINUTE))} 天前`;
}

export function fmtPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(ratio < 0.01 && ratio > 0 ? 2 : 1)}%`;
}

/**
 * 价格（**坐标轴 / 概览**用）：按量级定小数位，保留约 6 位有效数字。
 *
 * 图与卡片上的价格差一个数量级就会看起来「图是平的、数据其实在动」，所以低价标的
 * 必须留够小数位；高价标的又不能刷一屏零。末尾的零交给 `maximumFractionDigits` 去掉。
 *
 * 这个口径原来在 `CandleChart` 与 `ChainCurveChart` 各写了一份（逐字相同）；
 * 2026-11-14 链上那一页不再画走势图，`ChainCurveChart` 已删。
 */
export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const digits = Math.min(8, Math.max(2, 6 - Math.ceil(Math.log10(abs) + 1)));
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

/**
 * 价格（**下单 / 对账 / 方案**用）：最多 8 位小数，保留可对照的原始精度。
 *
 * 与 {@link fmtPrice} 的区别是**不按量级压缩**：止盈止损的三个价、方案的进场价
 * 都要拿去和交易所上的单子逐位对照，显示层把 65000.12 抹成 65,000.1 就是错的。
 */
export function fmtPriceExact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 8 });
}

/** 金额（盈亏刻度）：两位小数就够，多了是噪声。 */
export function fmtAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

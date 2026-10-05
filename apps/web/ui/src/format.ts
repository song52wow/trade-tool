const MINUTE = 60_000;

/** epoch 毫秒 → 本地可读时间；null 显式显示成「—」，不假装是 0。 */
export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function fmtDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toISOString().slice(0, 10);
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

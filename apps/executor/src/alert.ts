/**
 * 对账差异 → 告警条目的转换（v0.8.0）。
 *
 * 单独一个文件，是因为它有**两个读者**：executor 的周期对账要用它推飞书，
 * 而它的口径（哪些算一条告警、指纹怎么算）不该散落在调用点里。
 *
 * 指纹只由「是什么事」决定（差异类型 + 标的 + 入场单号），**不含**这轮的具体数值：
 * 价格、证据那些每次都可能变，掺进指纹会让每轮都算「新告警」，冷却就形同虚设。
 */

import { severityLabel, type AlertItem, type ReconcileReport } from '@trade-tool/core';

/**
 * 把一份对账报告变成一条告警；没有差异时返回 `null`。
 *
 * 一次对账的**所有**差异合成一条消息，而不是一条差异一条消息：
 * 一个裸仓往往同时命中好几条判据（「没有止损单」+「有仓位没记录」），
 * 拆开推就成了「一个问题推了三遍」，反而让人以为有三件事。
 */
export function buildReconcileAlert(report: ReconcileReport): AlertItem | null {
  if (report.differences.length === 0) return null;

  const severity = report.differences.some((item) => item.severity === 'critical')
    ? 'critical'
    : 'warning';

  const lines = report.differences.map((item) => {
    const entry = item.entryOrderId === null ? '' : `（入场 ${item.entryOrderId}）`;
    return `[${severityLabel(item.severity)}] ${item.symbol}${entry}：${item.message}`;
  });

  const fingerprint = report.differences
    .map((item) => `${item.kind}|${item.symbol}|${item.entryOrderId ?? '-'}`)
    .sort()
    .join(',');

  return {
    fingerprint: `reconcile|${fingerprint}`,
    severity,
    title:
      `交易对账发现 ${String(report.counts.total)} 处差异` +
      `（紧急 ${String(report.counts.critical)} / 注意 ${String(report.counts.warning)}）`,
    lines,
    resolvedTitle: '交易对账已恢复正常',
  };
}

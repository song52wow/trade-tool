/**
 * 对账差异 → 告警条目的转换（v0.8.0）。
 *
 * 单独一个文件，是因为它有**两个读者**：executor 的周期对账要用它推飞书，
 * 而它的口径（哪些算一条告警、指纹怎么算）不该散落在调用点里。
 *
 * 指纹只由「是什么事」决定（差异类型 + 标的 + 入场单号），**不含**这轮的具体数值：
 * 价格、证据那些每次都可能变，掺进指纹会让每轮都算「新告警」，冷却就形同虚设。
 */

import {
  RECONCILE_KINDS,
  severityLabel,
  type AlertItem,
  type ReconcileReport,
} from '@trade-tool/core';

/**
 * 把一份对账报告变成一条告警；没有**要通知的**差异时返回 `null`。
 *
 * @param kinds 启用了哪些内容种类（交易对账的差异类型）。**空数组 = 一样都不推**。
 *
 * 一次对账的**所有**差异合成一条消息，而不是一条差异一条消息：
 * 一个裸仓往往同时命中好几条判据（「没有止损单」+「有仓位没记录」），
 * 拆开推就成了「一个问题推了三遍」，反而让人以为有三件事。
 */
export function buildReconcileAlert(
  report: ReconcileReport,
  kinds: readonly string[] = RECONCILE_KINDS,
): AlertItem | null {
  // **只保留用户勾选了的那些内容**。没勾的不推，但**仍然参与指纹**吗？不参与——
  // 指纹只由「被推出去的那些差异」决定，这样「新增一条没勾的差异」不会触发
  // 一条内容完全相同的新消息（那种重复比不报还烦人）。
  const enabled = new Set(kinds);
  const differences = report.differences.filter((item) => enabled.has(item.kind));
  if (differences.length === 0) return null;

  const severity = differences.some((item) => item.severity === 'critical')
    ? 'critical'
    : 'warning';

  const lines = differences.map((item) => {
    const entry = item.entryOrderId === null ? '' : `（入场 ${item.entryOrderId}）`;
    return `[${severityLabel(item.severity)}] ${item.symbol}${entry}：${item.message}`;
  });

  const fingerprint = differences
    .map((item) => `${item.kind}|${item.symbol}|${item.entryOrderId ?? '-'}`)
    .sort()
    .join(',');

  return {
    fingerprint: `reconcile|${fingerprint}`,
    // 这类是「仓位有问题」——推��里要能一眼看出是报错，不是成交。
    category: 'error',
    severity,
    title:
      `交易对账发现 ${String(differences.length)} 处差异` +
      `（紧急 ${String(differences.filter((i) => i.severity === 'critical').length)} / ` +
      `注意 ${String(differences.filter((i) => i.severity === 'warning').length)}）`,
    lines,
    resolvedTitle: '交易对账已恢复正常',
  };
}

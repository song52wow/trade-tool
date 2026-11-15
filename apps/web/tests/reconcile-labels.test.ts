/**
 * 对账差异的「服务端下发文案」。
 *
 * 锁的是一条**唯一来源**：差异类型的中文标题只在 core 的 `RECONCILE_KIND_INFO`
 * 里存在一份，控制面把它随 DTO 带下去。页面原来自己抄了一张 `KIND_LABEL`
 * （AGENTS §7 第 6 条），两边措辞不同、改一处另一处不知道——那正是要消掉的重复。
 */

import { RECONCILE_KIND_INFO } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

import { withReconcileKindLabels } from '../src/service.js';

describe('withReconcileKindLabels', () => {
  const base = {
    exchange: 'binance',
    symbol: null,
    scope: { exchangePositions: 1, exchangeAlgoOrders: 0, localUnsettled: 1 },
    healthy: false,
    counts: { total: 1, critical: 1, warning: 0 },
    differences: [
      {
        kind: 'missing-stop-order' as const,
        severity: 'critical' as const,
        symbol: 'BTCUSDT',
        entryOrderId: 'order-1',
        message: '本地记着已挂上，交易所没有那张止损单',
        evidence: {},
      },
    ],
    checkedAt: 1_760_000_000_000,
  };

  it('每条差异带上 label 与 hint，且与 core 的词表逐字一致', () => {
    const dto = withReconcileKindLabels(base);
    expect(dto.differences[0]?.label).toBe(RECONCILE_KIND_INFO['missing-stop-order'].label);
    expect(dto.differences[0]?.hint).toBe(RECONCILE_KIND_INFO['missing-stop-order'].hint);
    // 原有字段一个不丢
    expect(dto.differences[0]?.message).toBe(base.differences[0]?.message);
    expect(dto.counts).toEqual(base.counts);
    expect(dto.healthy).toBe(false);
  });

  it('不修改入参（纯函数）', () => {
    withReconcileKindLabels(base);
    expect(base.differences[0]).not.toHaveProperty('label');
  });
});

import { describe, expect, it } from 'vitest';

import { buildReconcileAlert } from '../src/alert.js';
import type { ReconcileReport } from '@trade-tool/core';

/**
 * 对账差异卡片的**排版**口径。
 *
 * 重点是「单号必须在卡片里」：差异说的是「本地的单和交易所的单对不上」，
 * 而排查这件事的钥匙就是单号——拿着它去交易所的订单记录里查，
 * 不用靠「哪个标的、什么时候」去猜是哪一张单。
 */
function reportWith(differences: ReconcileReport['differences']): ReconcileReport {
  return {
    exchange: 'binance',
    symbol: null,
    checkedAt: 1_760_000_000_000,
    healthy: false,
    counts: { critical: 1, warning: 0, total: differences.length },
    differences,
    scope: { localUnsettled: 1, exchangePositions: 1, exchangeAlgoOrders: 1 },
  };
}

describe('对账差异卡片', () => {
  it('差异行带上入场单号与交易所条件单号', () => {
    const alert = buildReconcileAlert(
      reportWith([
        {
          kind: 'price-mismatch',
          severity: 'critical',
          symbol: 'BTCUSDT',
          entryOrderId: '28644519453',
          message: 'BTCUSDT 止损单还在交易所，但触发价与本地记录不一致。',
          evidence: {
            exchangeAlgoId: 900123,
            exchangeTriggerPrice: 84_000,
            localStopPrice: 83_000,
          },
        },
      ]),
    );
    expect(alert).not.toBeNull();
    const lines = (alert?.lines ?? []).join('\n');
    expect(lines).toContain('入场 28644519453');
    expect(lines).toContain('交易所条件单 900123');
  });

  it('本地记的那侧单号也带出来（交易所没有对应单时）', () => {
    const alert = buildReconcileAlert(
      reportWith([
        {
          kind: 'missing-stop-order',
          severity: 'critical',
          symbol: 'BTCUSDT',
          entryOrderId: '42',
          message: 'BTCUSDT 仓位当前没有止损保护。',
          evidence: { localSlAlgoId: 900456, localStopPrice: 83_000 },
        },
      ]),
    );
    const lines = (alert?.lines ?? []).join('\n');
    expect(lines).toContain('本地止损单 900456');
  });

  it('一个单号都没有时，不留空括号', () => {
    const alert = buildReconcileAlert(
      reportWith([
        {
          kind: 'record-without-position',
          severity: 'warning',
          symbol: 'SOLUSDT',
          entryOrderId: '99',
          message: 'SOLUSDT 本地记着已挂单，交易所已无该仓位。',
          evidence: {},
        },
      ]),
    );
    const lines = (alert?.lines ?? []).join('\n');
    expect(lines).not.toContain('单号：');
  });

  it('没勾选的内容类型不推', () => {
    const alert = buildReconcileAlert(
      reportWith([
        {
          kind: 'price-mismatch',
          severity: 'critical',
          symbol: 'BTCUSDT',
          entryOrderId: '42',
          message: '触发价对不上',
          evidence: { exchangeAlgoId: 1 },
        },
      ]),
      ['missing-stop-order'],
    );
    expect(alert).toBeNull();
  });
});

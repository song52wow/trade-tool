/**
 * 交易对账（v0.6.0）：把交易所当前真实的持仓与挂单，同本地 `risk_bracket` 比对。
 *
 * 这一层只做**取数 + 编排**，判据在 `packages/core/src/reconcile.ts`（纯函数）。
 * CLI 与控制面共用同一个入口，因此两个出口对同一份事实给出的结论必然一致。
 *
 * 三条边界，不可协商：
 *
 * 1. **只读**。不下单、不撤单、不写库。对账的产物是一份差异清单，处置一律人工决定。
 * 2. **缺凭据就报错**，不静默跳过交易所侧。少查一半再显示「一致」，是最坏的一种报告。
 * 3. **出网**。这是私有签名接口，因此对账不能挂在页面的自动刷新节奏上（`/bars` 可以，
 *    因为它只打 PG）。
 */

import { reconcileBrackets, type ReconcileReport } from '@trade-tool/core';

import type { BinancePrivateClient } from './binance-private.js';
import { listUnsettledBrackets } from './db/risk.js';
import type { Pool } from './db/pool.js';

export interface ReconcileOptions {
  pool: Pool;
  client: BinancePrivateClient;
  exchange: string;
  /** 缺省 = 全账户对账。 */
  symbol?: string;
  /** 可注入时钟，测试里固定住。 */
  now?: () => number;
}

/**
 * 跑一次对账。
 *
 * 两次 REST 的**范围必须一致**：本地查了哪个标的，交易所就只查哪个标的。反过来会让
 * 「本地那条 armed 记录」去和一份**根本没有它**的交易所快照比对，从而报出一条纯属虚构
 * 的「止损单不见了」——那是最容易被当真、也最经不起推敲的假警报。
 */
export async function runReconciliation(options: ReconcileOptions): Promise<ReconcileReport> {
  const { pool, client, exchange } = options;
  const now = options.now ?? (() => Date.now());
  const scope = options.symbol ?? null;
  const query = scope === null ? {} : { symbol: scope };

  const [local, positions, algoOrders] = await Promise.all([
    listUnsettledBrackets(pool, exchange, scope ?? undefined),
    client.positionRisk(query),
    client.openAlgoOrders(query),
  ]);

  return reconcileBrackets({
    exchange,
    symbol: scope,
    checkedAt: now(),
    local,
    positions,
    algoOrders,
  });
}

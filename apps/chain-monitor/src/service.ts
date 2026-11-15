/**
 * 链上仓位监控的编排（v1.2.0）。
 *
 * ## 一轮做什么
 *
 * 对每一笔配置的仓位：
 *   1. 读链上事实（`packages/data` 的 `readChainPosition`）；
 *   2. 算账（`packages/core` 的纯函数：持仓构成、手续费、成本、盈亏）；
 *   3. 落库（采样一行 + 滚动状态）；
 *   4. 判定要不要推（`packages/core` 的纯函数判据）；
 *   5. 推（`packages/core` 的通知层，文案在本 app 的 `alert.ts`）。
 *
 * ## 三条纪律
 *
 * * **一笔坏的不拖垮别的**：每笔仓位单独 try，出错就把它记进 `last_error`，
 *   继续下一笔。一笔仓位读不到，不代表其它仓位也读不到。
 * * **推不出去不算说过**：只有**真的发出去**了才更新「上次推送」的基准；
 *   推送失败要留记录（页面与日志都能看见），否则「群里没有消息」会变成无头案。
 * * **读失败必须常驻可见**：`last_error` 写进库里，页面直接显示，
 *   而不是弹一下就没了（AGENTS.md 约定 9）。
 */

import {
  computeChainPositionSnapshot,
  decideChainPositionAlert,
  rollChainPositionCost,
  type AlertDispatcher,
  type ChainAlertState,
  type ChainConfig,
  type ChainPositionConfig,
  type ChainPositionSnapshot,
} from '@trade-tool/core';
import {
  BscClient,
  insertChainAlert,
  insertChainSnapshot,
  markChainPositionAlerted,
  positionKeyHex,
  readChainPosition,
  readChainPositionByToken,
  readChainPositionState,
  updateChainPositionState,
  upsertChainPosition,
  type Pool,
} from '@trade-tool/data';

import { buildChainPositionAlert } from './alert.js';

/**
 * 告警记账的作用域。
 *
 * 与其它作用域分开：一次 `dispatch` 只看得见自己这个作用域的条目，
 * 而「已恢复」是按「上一轮有、这一轮没有」判的。链上仓位的提醒都是**事件**
 * （`oneShot`），不参与「已恢复」判定，但作用域仍然要分开——
 * 否则别的作用域推一条事件，会把这里的条目当成「问题消失了」。
 */
export const CHAIN_ALERT_SCOPE = 'chain-position';

/** 一笔仓位这一轮的结果。 */
export interface ChainPositionPollResult {
  positionKey: string;
  /** 这一轮有没有出错。 */
  ok: boolean;
  error: string | null;
  /** 判据认为该不该推。 */
  alert: boolean;
  /** 真的推出去没有。 */
  sent: boolean;
  reasons: string[];
  snapshot: ChainPositionSnapshot | null;
}

export interface ChainMonitorServiceOptions {
  pool: Pool;
  config: ChainConfig;
  client: BscClient;
  alerts: AlertDispatcher;
  /** 注入时钟（测试用）。 */
  now?: () => number;
}

export interface ChainMonitorService {
  /** 跑一轮：读链、算账、落库、按需推送。 */
  pollOnce(): Promise<ChainPositionPollResult[]>;
}

/**
 * 建监控服务。
 *
 * 判据与文案都不在这里：判据在 core、文案在 `alert.ts`——
 * 这一层只负责把它们接起来。
 */
export function createChainMonitorService(
  options: ChainMonitorServiceOptions,
): ChainMonitorService {
  const { pool, config, client, alerts } = options;
  const now = options.now ?? ((): number => Date.now());

  async function pollPosition(position: ChainPositionConfig): Promise<ChainPositionPollResult> {
    const facts = await readChainPosition(client, position);
    const positionKey = positionKeyHex(position.positionManager, facts.tickLower, facts.tickUpper);

    const existing = await readChainPositionState(pool, positionKey);
    const state: ChainAlertState = {
      baselineDone: existing?.baselineDone ?? false,
      lastAlertPrice: existing?.lastAlertPrice ?? null,
      lastAlertPnlPct: existing?.lastAlertPnlPct ?? null,
      lastAlertAt: existing?.lastAlertAt ?? null,
      lastLiquidity: existing?.lastLiquidity ?? null,
      inRange: existing?.lastInRange ?? null,
    };

    // 成本只在「已经算过一次」之后才滚动——第一次的成本要从投入的币反推，
    // 而投入的币是**原始单位**的字符串，用 BigInt 解析，浮点会丢低位。
    const costKnown = existing !== null && existing.costUsdt > 0;
    const rolled = costKnown
      ? rollChainPositionCost({
          liquidity: facts.liquidity,
          lastLiquidity: state.lastLiquidity === null ? null : BigInt(state.lastLiquidity),
          costUsdt: existing.costUsdt,
          realizedUsdt: existing.realizedUsdt,
          sqrtPriceX96: facts.sqrtPriceX96,
          tickLower: facts.tickLower,
          tickUpper: facts.tickUpper,
          decimals0: facts.decimals0,
          decimals1: facts.decimals1,
        })
      : { costUsdt: 0, realizedUsdt: existing?.realizedUsdt ?? 0 };

    const snapshot = computeChainPositionSnapshot({
      block: facts.block,
      sqrtPriceX96: facts.sqrtPriceX96,
      tick: facts.tick,
      tickLower: facts.tickLower,
      tickUpper: facts.tickUpper,
      liquidity: facts.liquidity,
      amount0: facts.amount0,
      amount1: facts.amount1,
      fee0: facts.fee0,
      fee1: facts.fee1,
      // 投入的两个币：配置里存的**已经是原始单位**（18 位小数的整数字符串），
      // 因此直接按 BigInt 解析。**不要再过一遍 toRaw**——
      // 那会把 3.4 个币当成 3.4e18 个币，成本与盈亏整个差 1e18 倍
      // （2026-11-11 实测踩过：反推存入价格直接失败）。
      depositAmount0: BigInt(position.depositAmount0),
      depositAmount1: BigInt(position.depositAmount1),
      // 成本**第一次**不给：让它自己去反推存入价格（那是唯一能拿到「投入那一刻
      // 的价」的办法）。已经算过之后才用滚动出来的成本。
      ...(costKnown ? { costUsdt: rolled.costUsdt } : {}),
      realizedUsdt: rolled.realizedUsdt,
      decimals0: facts.decimals0,
      decimals1: facts.decimals1,
    });

    // 仓位先登记（控制面读的是这张表），再写采样。
    await upsertChainPosition(pool, {
      positionKey,
      chain: position.chain,
      positionManager: position.positionManager,
      pool: position.pool,
      token0: position.token0,
      token1: position.token1,
      tokenId: position.tokenId,
      owner: facts.owner,
      tickLower: facts.tickLower,
      tickUpper: facts.tickUpper,
      symbol0: position.symbol0 ?? null,
      symbol1: position.symbol1 ?? null,
      depositAmount0: position.depositAmount0,
      depositAmount1: position.depositAmount1,
      depositTx: position.depositTx ?? null,
      nowMs: now(),
    });

    await insertChainSnapshot(pool, {
      positionKey,
      ts: now(),
      block: facts.block,
      price: snapshot.price,
      amount0: snapshot.amount0,
      amount1: snapshot.amount1,
      valueUsdt: snapshot.valueUsdt,
      costUsdt: snapshot.costUsdt,
      realizedUsdt: snapshot.realizedUsdt,
      pnlUsdt: snapshot.pnlUsdt,
      pnlPct: snapshot.pnlPct,
      feeUsdt: snapshot.feeUsdt,
      inRange: snapshot.inRange,
      liquidity: snapshot.liquidity,
    });

    const decision = decideChainPositionAlert({
      snapshot,
      state,
      thresholds: config.thresholds,
      nowMs: now(),
    });

    let sent = false;
    if (decision.alert) {
      const item = buildChainPositionAlert({
        position: {
          positionKey,
          symbol0: position.symbol0 ?? position.token0,
          symbol1: position.symbol1 ?? position.token1,
          tokenId: position.tokenId,
          // 链上链接要用的那几项：缺一个就少一条链接，其余照常给。
          chain: position.chain,
          pool: position.pool,
          positionManager: position.positionManager,
          owner: position.owner,
          depositTx: position.depositTx,
        },
        snapshot,
        reasons: decision.reasons,
      });
      // 「要通知哪些内容」写在通道里，**过滤必须在构造条目时做**——
      // 没勾的内容不该进条目（否则会混进指纹，触发一条内容相同的新消息）。
      const dispatched = await alerts.dispatch(
        (channel) => (channel.kinds.includes('chain-position-alert') ? [item] : []),
        CHAIN_ALERT_SCOPE,
      );
      sent = dispatched.sent > 0;
      await insertChainAlert(pool, {
        positionKey,
        ts: now(),
        reasons: decision.reasons.join('；'),
        sent,
        detail: {
          price: snapshot.price,
          valueUsdt: snapshot.valueUsdt,
          pnlUsdt: snapshot.pnlUsdt,
          pnlPct: snapshot.pnlPct,
          failed: dispatched.failed,
          suppressed: dispatched.suppressed,
        },
      });
    }

    await updateChainPositionState(pool, positionKey, {
      costUsdt: snapshot.costUsdt,
      realizedUsdt: snapshot.realizedUsdt,
      lastLiquidity: snapshot.liquidity.toString(),
      inRange: snapshot.inRange,
      baselineDone: true,
      lastPollAt: now(),
      lastError: null,
    });

    if (decision.alert && sent) {
      // 只有**真的发出去**了才更新基准：没推出去就当成「已经说过」，
      // 这条提醒就永远丢了。
      await markChainPositionAlerted(pool, positionKey, {
        price: snapshot.price,
        pnlPct: snapshot.pnlPct,
        atMs: now(),
      });
    }

    return {
      positionKey,
      ok: true,
      error: null,
      alert: decision.alert,
      sent,
      reasons: decision.reasons,
      snapshot,
    };
  }

  return {
    async pollOnce(): Promise<ChainPositionPollResult[]> {
      const results: ChainPositionPollResult[] = [];
      for (const position of config.positions) {
        try {
          results.push(await pollPosition(position));
        } catch (error) {
          const message = (error as Error).message;
          console.error(`[chain-monitor] 仓位读取失败：${message}`);
          // 出错也要把「最后一次错误」留在**对应的那一行**上——页面要**常驻可见**，
          // 而不是弹一下就没了（AGENTS.md 约定 9）。
          // 仓位 key 需要 tick 区间才算得出来，而读失败时恰恰拿不到 tick，
          // 于是用配置里就有的「管理器 + tokenId」找回那一行。
          try {
            const existing = await readChainPositionByToken(
              pool,
              position.positionManager,
              position.tokenId,
            );
            if (existing !== null) {
              await updateChainPositionState(pool, existing.positionKey, {
                lastPollAt: now(),
                lastError: message,
              });
            }
          } catch {
            // 连状态都写不进去（多半是库连不上）——那就只有日志了。
          }
          results.push({
            positionKey: '',
            ok: false,
            error: message,
            alert: false,
            sent: false,
            reasons: [],
            snapshot: null,
          });
        }
      }
      return results;
    },
  };
}

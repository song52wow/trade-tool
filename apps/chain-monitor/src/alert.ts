/**
 * 链上仓位告警的文案转换（v1.2.0）。
 *
 * 判据在 core（`packages/core/src/chain-alert.ts`），这里只负责把它变成
 * 通知层认识的那一条（category / severity / title / lines / highlights）。
 *
 * **分开的理由**：改一句措辞不该动到「要不要推」的判定；
 * 判定与文案合成一处的话，两边迟早分叉（AGENTS.md §5 第 5 条）。
 */

import type { AlertItem } from '@trade-tool/core';

import { buildChainPositionLinks, fromRaw, type ChainPositionSnapshot } from '@trade-tool/core';

/** 一笔仓位的显示信息（够拼出消息就行）。 */
export interface ChainAlertPositionInfo {
  positionKey: string;
  symbol0: string;
  symbol1: string;
  tokenId: string;
  /** 链标识（当前只有 `bsc`）。用来决定链上链接指向哪个站点。 */
  chain: string;
  /** 池子合约地址。 */
  pool?: string | undefined;
  /** 仓位管理器（PositionManager）合约地址。 */
  positionManager?: string | undefined;
  /** 仓位持有人地址。 */
  owner?: string | undefined;
  /** 投入那笔交易的哈希。 */
  depositTx?: string | undefined;
}

/**
 * 拼一条告警。
 *
 * `fingerprint` 只由「是哪笔仓位」决定——同一笔仓位的不同次提醒是同一件事，
 * 去重与冷却才有意义（指纹里塞进本轮的数值，每次都会被当成新告警，
 * 冷却就形同虚设）。
 *
 * **末尾带链上链接**：告警说「价格跌出区间」之后，人要做的下一件事就是去链上看
 * （看仓位还在不在、看能不能加流动性）。链接由 core 的 `buildChainPositionLinks`
 * 拼——与控制面那一页**同一份实现**，两处各拼一次就会有一处变成死链。
 */
export function buildChainPositionAlert(input: {
  position: ChainAlertPositionInfo;
  snapshot: ChainPositionSnapshot;
  reasons: readonly string[];
}): AlertItem {
  const { position, snapshot, reasons } = input;
  const cleared = snapshot.liquidity === 0n;
  const pnlSign = snapshot.pnlUsdt >= 0 ? '+' : '';

  const links = buildChainPositionLinks({
    chain: position.chain,
    pool: position.pool,
    positionManager: position.positionManager,
    tokenId: position.tokenId,
    owner: position.owner,
    depositTx: position.depositTx,
  });

  return {
    fingerprint: `chain-position-alert|${position.positionKey}`,
    category: 'info',
    // 仓位被清空是大事，其余是「注意」。
    severity: cleared ? 'critical' : 'warning',
    title: cleared
      ? `链上仓位已清空：${position.symbol0}/${position.symbol1} #${position.tokenId}`
      : `链上仓位异动：${position.symbol0}/${position.symbol1} #${position.tokenId}`,
    lines: [
      `触发原因：${reasons.join('；')}`,
      `现价：${snapshot.price.toFixed(4)} ${position.symbol1}` +
        `（区间 ${snapshot.priceLower.toFixed(2)}–${snapshot.priceUpper.toFixed(2)}，` +
        `${snapshot.inRange ? '区间内' : '区间外'}）`,
      `持仓：${fromRaw(snapshot.amount0).toFixed(4)} ${position.symbol0}` +
        ` + ${fromRaw(snapshot.amount1).toFixed(2)} ${position.symbol1}`,
      `当前价值：${snapshot.valueUsdt.toFixed(2)} ${position.symbol1}` +
        `（含手续费 ${snapshot.feeUsdt >= 0 ? '+' : ''}${snapshot.feeUsdt.toFixed(2)}）`,
      `投入成本：${snapshot.costUsdt.toFixed(2)} ${position.symbol1}`,
      // 链接单独占一行：飞书发的是**文本**消息，URL 会被自动识别成可点的链接。
      ...(links.explorer.position === null ? [] : [`区块浏览器：${links.explorer.position}`]),
      ...(links.liquidity.position === null ? [] : [`流动性平台：${links.liquidity.position}`]),
    ],
    highlights: [
      `浮动盈亏：${pnlSign}${snapshot.pnlUsdt.toFixed(2)} ${position.symbol1}` +
        `（${pnlSign}${snapshot.pnlPct.toFixed(2)}%）`,
    ],
    // 这是**事件**（推过就算），不是持续状态——下一轮它不在了不等于「问题消失了」，
    // 不该推「已恢复」。
    oneShot: true,
  };
}

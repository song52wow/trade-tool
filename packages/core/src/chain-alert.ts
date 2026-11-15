/**
 * 链上仓位的告警判据（v1.2.0，纯函数）。
 *
 * ## 这一层只判「要不要说」
 *
 * 判据在 core、文案在 app（`apps/chain-monitor/src/alert.ts`）、通道在
 * `packages/core/src/notify.ts`——与仓库其它层同一套分法。
 * 判据与文案合成一处的话，改一句措辞就会动到判定，两边迟早分叉。
 *
 * ## 三条口径
 *
 * 1. **不刷屏**：只有「值得让人看一眼」的变化才推。价格动 0.1% 就推一条，
 *    三天后群里就没人看了——而没人看等于没接（AGENTS.md §6.9 第 2 条）。
 * 2. **不漏**：仓位被清空、有人加仓/减仓、价格出了设定区间——这三件事**立刻**推，
 *    不受阈值与冷却的限制（清空更是要推，仓位没了是大事）。
 * 3. **不重复**：冷却期内同一件事不推第二遍；「上次推送」的基准只在**真的推出去**
 *    之后才更新——没推出去不算说过。
 */

import type { ChainPositionSnapshot } from './chain-v3.js';

/** 上一次留下的状态（来自 `chain_position` 表）。 */
export interface ChainAlertState {
  /** 是否已经建立过基线（第一次采样只建基线，不当成「变化」）。 */
  baselineDone: boolean;
  /** 上次**真的推出去**时的价格。 */
  lastAlertPrice: number | null;
  /** 上次**真的推出去**时的盈亏百分比。 */
  lastAlertPnlPct: number | null;
  /** 上次推送的时刻（毫秒）。 */
  lastAlertAt: number | null;
  /** 上一轮的流动性（原始单位，字符串）。 */
  lastLiquidity: string | null;
  /** 上一轮价格是否在区间内。 */
  inRange: boolean | null;
}

/** 阈值（来自配置）。 */
export interface ChainAlertThresholds {
  /** 价格较上次推送变动超过这个百分比就推。 */
  priceMovePct: number;
  /** 盈亏较上次推送变动超过这么多个百分点就推。 */
  pnlMovePp: number;
  /** 两次推送之间至少隔这么久（毫秒）。 */
  cooldownMs: number;
}

/** 判定结果。 */
export interface ChainAlertDecision {
  /** 这一轮要不要推。 */
  alert: boolean;
  /** 触发原因（人话，直接进消息与页面）。 */
  reasons: string[];
  /** 因为冷却而被压住（有原因但不推）。 */
  suppressed: boolean;
}

/**
 * 判定这一轮要不要推。
 *
 * @param snapshot 这一轮的仓位状态
 * @param state 上一次留下的状态
 * @param thresholds 阈值
 * @param nowMs 当前时刻（毫秒）
 */
export function decideChainPositionAlert(input: {
  snapshot: Pick<ChainPositionSnapshot, 'price' | 'pnlPct' | 'inRange' | 'liquidity'>;
  state: ChainAlertState;
  thresholds: ChainAlertThresholds;
  nowMs: number;
}): ChainAlertDecision {
  const { snapshot, state, thresholds, nowMs } = input;
  /**
   * **事件类**原因（加仓 / 减仓、进出区间）与**阈值类**原因（价格、盈亏动了多少）
   * 必须分开记：前者是「发生过这件事」，后者是「数字走了一段」。
   *
   * 合成一个数组再统一过冷却是本文件最初的写法，结果是：冷却期内的加仓/减仓
   * 被压住，而 `chain_position.last_liquidity` 那一轮已经前移，下一轮比不出差异
   * ——这件事就**永久丢了**（正是文件头第 2 条「不漏」要防的）。
   */
  const urgent: string[] = [];
  const gradual: string[] = [];

  if (!state.baselineDone) {
    return { alert: true, reasons: ['首次监控，建立基线'], suppressed: false };
  }

  const liquidity = snapshot.liquidity.toString();
  const closed = snapshot.liquidity === 0n;

  if (closed) {
    if (state.lastLiquidity !== '0') {
      // 仓位没了：这是大事，**不受冷却限制**。
      return { alert: true, reasons: ['仓位已经清空（流动性归零）'], suppressed: false };
    }
    return { alert: false, reasons: [], suppressed: false };
  }

  if (state.lastLiquidity !== null && liquidity !== state.lastLiquidity) {
    urgent.push('仓位流动性变了（有人加仓或减仓）');
  }

  if (state.inRange !== null && snapshot.inRange !== state.inRange) {
    urgent.push(snapshot.inRange ? '价格回到设定区间' : '价格跌出设定区间');
  }

  if (state.lastAlertPrice !== null && state.lastAlertPrice !== 0) {
    const move = ((snapshot.price - state.lastAlertPrice) / state.lastAlertPrice) * 100;
    if (Math.abs(move) >= thresholds.priceMovePct) {
      gradual.push(`价格较上次推送动了 ${move >= 0 ? '+' : ''}${move.toFixed(2)}%`);
    }
  }

  if (state.lastAlertPnlPct !== null) {
    const delta = snapshot.pnlPct - state.lastAlertPnlPct;
    if (Math.abs(delta) >= thresholds.pnlMovePp) {
      gradual.push(`盈亏较上次推送变了 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} 个百分点`);
    }
  }

  const reasons = [...urgent, ...gradual];
  if (reasons.length === 0) {
    return { alert: false, reasons: [], suppressed: false };
  }

  // 事件类**绕过冷却**：它是一次性的事实，被压住就再也不会出现第二次。
  // 阈值类照旧过冷却——价格每轮都在动，不压就会变成刷屏。
  if (urgent.length > 0) {
    return { alert: true, reasons, suppressed: false };
  }

  // 冷却：同一件事别在半小时内推两遍。
  if (state.lastAlertAt !== null && nowMs - state.lastAlertAt < thresholds.cooldownMs) {
    return { alert: false, reasons, suppressed: true };
  }

  return { alert: true, reasons, suppressed: false };
}

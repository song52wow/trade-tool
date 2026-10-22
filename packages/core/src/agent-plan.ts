/**
 * 执行方案的**可执行性**判据（v1.0.0 自动下单）。
 *
 * ## 为什么它住在 core
 *
 * 「这份方案能不能自动执行」这一条判据要出现在**四个地方**：
 *
 *   1. `apps/agent` —— 自动批准（开关打开时直接落 `approved`）；
 *   2. `apps/web` —— 控制面的人工批准；
 *   3. `apps/cli` —— 命令行的人工批准；
 *   4. `apps/executor` —— 消费 `approved` 方案时的兜底检查。
 *
 * 四处各写一遍的话，迟早有一处忘了改，而那一处恰好就是**批了一份永远执行不了的
 * 方案**的地方——它会永远卡在「已批准」，每轮被捞出来又跳过，
 * 而页面上显示「等 executor 消费」，看上去像是有一单在等着下。
 * 那是「以为会做、实际什么也没做」（AGENTS.md §5 第 9 条）。
 *
 * 所以判据**只有这一份**，四处共用（AGENTS.md §5 第 5 条：同一概念只有一个名字）。
 */

import { SyncError } from './market-sync.js';

/**
 * 限价进场**不能自动执行**。
 *
 * 理由很实在：限价单可能永远不成交，而不成交的仓位**没有止损保护**——
 * 那是最贵的状态（裸仓）。
 *
 * 真正的限价单生命周期（挂着不成交怎么办、过期怎么撤、部分成交怎么算）
 * 是另一套东西，需要自己的状态机；本仓库这一期**没有**做。
 */
export const LIMIT_ENTRY_UNSUPPORTED =
  '限价进场暂不支持自动执行（只支持市价进场）：限价单可能永远不成交，' +
  '而挂着不成交的仓位没有止损保护。请改用市价进场，或在交易所手动下单。';

/** 一份方案的进场方式（与 `agent-trader.ts` 的 `entryType` 同义）。 */
export type AutoExecutableEntryType = 'market' | 'limit' | null;

/**
 * 这份方案的进场方式**能不能自动执行**。
 *
 * 只有**市价**能：限价单可能永远不成交（见 {@link LIMIT_ENTRY_UNSUPPORTED}）。
 * `null`（没有进场方式）同样不能——那是残缺的方案。
 *
 * @param entryType 方案里的进场方式。
 * @param action 方案的 `action`。`hold`（这一轮不做）与 `failed`（出不了方案）
 *   没有可执行的进场，也不能执行。
 */
export function isAutoExecutable(
  entryType: AutoExecutableEntryType,
  action: 'enter' | 'hold' | 'failed' = 'enter',
): boolean {
  if (action !== 'enter') return false;
  return entryType === 'market';
}

/**
 * 这份方案**为什么**不能自动执行。不能执行时给出**能照着改**的原因。
 *
 * @returns 不能执行的原因；能执行时返回 `null`。
 */
export function autoExecutableProblem(
  entryType: AutoExecutableEntryType,
  action: 'enter' | 'hold' | 'failed' = 'enter',
): string | null {
  if (action !== 'enter') {
    return `方案是「${action === 'hold' ? '这一轮不做' : '出不了方案'}」，没有可执行的进场，不能批准`;
  }
  if (entryType === 'limit') return LIMIT_ENTRY_UNSUPPORTED;
  if (entryType === null || entryType === undefined) return '方案没有进场方式，不能批准';
  return null;
}

/**
 * 人工批准（控制面 / 命令行）前的检查。**不能批准就抛错**，并说清为什么。
 *
 * 单独抽出来是为了**能被测**：批准路径在 web 与 CLI 两处，都要连真库，
 * 而判据本身是纯的——把它抽成纯函数，两处共用一份实现，
 * 测试也只需要测这一份（§5 第 5 条：同一概念只有一个名字）。
 *
 * @param planId 方案号（写进错误信息，方便人去找那一份）。
 * @throws SyncError 'CONFIG_INVALID' 这份方案不能批准。
 */
export function assertApprovable(input: {
  planId: string;
  entryType: AutoExecutableEntryType;
  action: 'enter' | 'hold' | 'failed';
}): void {
  const problem = autoExecutableProblem(input.entryType, input.action);
  if (problem === null) return;
  throw new SyncError('CONFIG_INVALID', `方案 ${input.planId} 不能批准：${problem}`, {
    planId: input.planId,
    action: input.action,
    entryType: input.entryType,
  });
}

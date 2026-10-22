/**
 * 自动执行开关的闸门（v1.0.0）。
 *
 * ## 它防的是什么
 *
 * `agent.execute.enabled` 的含义是「方案自动变成真实订单」。
 * **本期没有实现那条路径**——`apps/executor` 还不消费 `status='approved'` 的方案。
 *
 * 于是开关打开时只有两种可能的表现：
 *
 * - **启动即报错**（本模块做的事）：操作者立刻知道「这条路还没通」。
 * - **照常跑、什么也不做**：日志写着「自动执行：开」，实际一笔单都没下。
 *
 * 后者是这个仓库最忌讳的一种失败——「看起来成功了，其实什么都没做」。
 * 它比直接报错危险得多：报错只吵一次，而「以为在下单」会让人把真钱押在一个
 * 根本不会动的开关上。
 *
 * ## 为什么放在这里、而不是各入口各判一次
 *
 * 守护进程（`main.ts`）与命令行（`apps/cli` 的 `agent run`）**共用同一个编排**，
 * 因此闸门也必须共用一份：两处各写一遍，迟早有一处忘了加，
 * 而那一处恰好就是操作者以为在下单的那次运行。
 */

import { SyncError, type AgentConfig } from '@trade-tool/core';

/**
 * 自动执行没实现时，把开关按「配置不合法」拒绝掉。
 *
 * @throws SyncError 'CONFIG_INVALID' `execute.enabled = true`。
 */
export function assertAutoExecutionDisabled(config: AgentConfig): void {
  if (!config.execute.enabled) return;
  throw new SyncError(
    'CONFIG_INVALID',
    'agent.execute.enabled = true，但自动执行路径本期未实现：' +
      '方案现在只落库（trading_plan.status = advisory），需要人工审核后手动执行。' +
      '请把 agent.execute.enabled 改回 false',
    { agentExecuteEnabled: true },
  );
}

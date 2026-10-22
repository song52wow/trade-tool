/**
 * `trade-tool agent` —— 分析师 / 交易员 Agent（v1.0.0）。
 *
 * 两个子命令：
 *
 *   * `run`    —— 现在就跑一轮（分析 → 出方案 → 落库），把结果打在屏幕上；
 *   * `report` —— 看**已经存下来**的最近一次报告与方案（不调模型）。
 *
 * `run` 与常驻的 `apps/agent` 走**同一份编排实现**（`@trade-tool/agent`），
 * 因此「命令行跑出来的方案」与「守护进程跑出来的方案」口径一致——
 * 两处各写一遍的话，页面上显示的与实际下的会对不上。
 *
 * `report` 只读库：它是「上周那笔到底怎么决定的」的答案来源，
 * 不该因为模型今天挂了就连历史都看不了。
 *
 * `--json` 输出纯 JSON 到 stdout，一切提示走 stderr。
 */

import { SyncError, type AnalystVerdict } from '@trade-tool/core';
import {
  listAnalystReports,
  listSymbolEntries,
  listTradingPlans,
  readAnalystReportById,
  readLatestAnalystReport,
  readLatestTradingPlan,
  readTradingPlanById,
  type AnalystReportRow,
  type TradingPlanRow,
} from '@trade-tool/data';
import { createAgentService, createEquityReader } from '@trade-tool/agent';

import { withContext } from '../context.js';

export interface AgentRunOptions {
  symbol?: string;
  json?: boolean;
}

export interface AgentReportOptions {
  symbol?: string;
  limit?: string;
  json?: boolean;
}

function stanceText(stance: AnalystVerdict['stance']): string {
  if (stance === 'bullish') return '看多';
  if (stance === 'bearish') return '看空';
  return '中性';
}

/**
 * 打印一份报告与一份方案。
 *
 * `reportMissingHint` 是「没有报告」时该说的话。两种情形必须分开：
 * 「从没分析过」与「这一轮失败了」——前者是正常状态，后者是要人看的东西。
 * 混成一句「还没有报告」，就等于把失败显示成了「还没开始」。
 */
function renderReport(
  report: AnalystReportRow | null,
  plan: TradingPlanRow | null,
  reportMissingHint = '还没有分析师报告：先跑一次 `trade-tool agent run`。',
): void {
  if (report === null) {
    console.log(reportMissingHint);
  } else {
    console.log(
      `分析师报告 #${report.id}（${report.interval}，数据时刻 ${new Date(report.asOfMs).toISOString()}）：`,
    );
    console.log(
      `  立场：${stanceText(report.stance)}　信心：${report.confidence.toFixed(3)}` +
        `　综合分：${report.bias.toFixed(3)}　一致性：${report.agreement.toFixed(3)}`,
    );
    console.log(
      `  技术面 ${report.technical.score.toFixed(2)}｜情绪面 ${report.sentiment.score.toFixed(2)}` +
        `｜基本面 ${report.fundamental.score.toFixed(2)}`,
    );
    for (const [name, facet] of [
      ['技术面', report.technical],
      ['情绪面', report.sentiment],
      ['基本面', report.fundamental],
    ] as const) {
      for (const note of facet.notes) {
        console.log(`    · ${name}：${note}`);
      }
    }
    console.log(`  理由：${report.rationale}`);
    if (report.degraded) {
      console.log('  ⚠ 情绪面有数据没取到（见 notes），这一轮的情绪面分数仅供参考。');
    }
  }

  console.log('');
  if (plan === null) {
    console.log('还没有执行方案。');
    return;
  }
  if (plan.action === 'failed') {
    console.log(`执行方案 #${plan.id}：**未出方案**——${plan.failureReason ?? '（没写原因）'}`);
    return;
  }
  if (plan.action === 'hold') {
    console.log(`执行方案 #${plan.id}：**这一轮不做**——${plan.rationale}`);
    return;
  }
  // 把「这份方案基于哪份报告」写出来：报告按数据时刻 upsert（同一个 id），
  // 而方案每轮新建（id 递增），两个号天然不一样。不写出来就像是对不上。
  console.log(
    `执行方案 #${plan.id}（${plan.status}` +
      `${plan.reportId === null ? '' : `，基于报告 #${plan.reportId}`}）：` +
      `${plan.side} ${plan.entryType} @ ${plan.entryPrice}`,
  );
  console.log(
    `  数量 ${plan.quantity}　名义 ${plan.notional?.toFixed(2)}　` +
      `止损 ${plan.stopPrice}　止盈 ${plan.takeProfitPrice}`,
  );
  console.log(
    `  风险 ${plan.riskAmount?.toFixed(2)}（权益的 ${((plan.riskFraction ?? 0) * 100).toFixed(3)}%，` +
      `来源 ${plan.equitySource}）　R:R ${plan.riskReward?.toFixed(2)}`,
  );
  console.log(`  理由：${plan.rationale}`);
  for (const adjustment of plan.adjustments) {
    console.log(`  ⚠ 已调整：${adjustment}`);
  }
  if (plan.status === 'advisory') {
    console.log('  （这只是建议：自动执行关着，它不会变成真实订单。）');
  }
}

/**
 * 跑一轮。
 *
 * 标的：`-s` 指定 → 配置里的 `agent.symbols` → 库里正在同步的标的。
 */
export async function runAgent(options: AgentRunOptions = {}): Promise<number> {
  return withContext(async (ctx) => {
    const { pool, config, exchange } = ctx;
    if (!config.agent.llm.enabled) {
      throw new SyncError(
        'CONFIG_INVALID',
        'agent.llm.enabled = false：没有模型就出不了方案。' +
          '在配置里打开 agent.llm.enabled 并给出 baseUrl 与 model。',
        { agentLlmEnabled: false },
      );
    }

    const symbol = options.symbol?.trim();
    let symbols: string[];
    if (symbol !== undefined && symbol !== '') {
      symbols = [symbol];
    } else if (config.agent.symbols.length > 0) {
      symbols = [...config.agent.symbols].sort();
    } else {
      const entries = await listSymbolEntries(pool, exchange);
      symbols = entries
        .filter((entry) => entry.desiredState === 'running')
        .map((entry) => entry.symbol)
        .sort();
    }
    if (symbols.length === 0) {
      throw new SyncError(
        'CONFIG_INVALID',
        '没有可分析的标的：用 -s 指定，或在配置里写 agent.symbols，或先同步一个标的',
        { symbols: [] },
      );
    }

    const llm = (await import('@trade-tool/data')).createLlmClient({
      baseUrl: config.agent.llm.baseUrl,
      model: config.agent.llm.model,
      apiKeyEnv: config.agent.llm.apiKeyEnv,
      timeoutMs: config.agent.llm.timeoutMs,
    });
    const service = createAgentService({
      ctx,
      llm,
      config: config.agent,
      readEquity: createEquityReader({
        pool,
        config: config.agent,
        exchange,
        executor: config.executor,
      }),
    });

    const results = [];
    for (const one of symbols) {
      results.push(await service.analyzeSymbol(one));
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const result of results) {
        // **按这一轮落库的 id 读**，不去读「最近一条」。
        // 读「最近一条」的话，这一轮分析师失败时会显示**上一轮**的报告——
        // 看上去像「这次分析过了」，其实那一行是旧数据。
        const report =
          result.reportId === null
            ? null
            : await readAnalystReportById(pool, exchange, result.symbol, result.reportId);
        const plan =
          result.planId === null
            ? null
            : await readTradingPlanById(pool, exchange, result.symbol, result.planId);
        console.log(`=== ${result.symbol} ===`);
        if (result.failure !== null) {
          console.log(`本轮未出方案：${result.failure}`);
        }
        renderReport(
          report,
          plan,
          result.reportId === null && result.failure !== null
            ? '这一轮没有分析师报告（模型这一步就失败了）。'
            : '还没有分析师报告：先跑一次 `trade-tool agent run`。',
        );
        console.log('');
      }
    }
    // 有标的没出方案 → 退出码 1：那是要人看的东西，不是运行失败。
    const failed = results.filter((r) => r.failure !== null).length;
    return failed === 0 ? 0 : 1;
  });
}

/** 看最近存下来的报告与方案（只读，不调模型）。 */
export async function runAgentReport(options: AgentReportOptions = {}): Promise<number> {
  return withContext(async (ctx) => {
    const { pool, exchange } = ctx;
    const symbol = options.symbol?.trim();
    const limit = Number(options.limit ?? '10');
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new SyncError(
        'CONFIG_INVALID',
        `--limit 必须是正整数（收到 ${String(options.limit)}）`,
        {
          limit: options.limit,
        },
      );
    }

    if (symbol !== undefined && symbol !== '') {
      const report = await readLatestAnalystReport(pool, exchange, symbol);
      const plan = await readLatestTradingPlan(pool, exchange, symbol);
      if (options.json) {
        console.log(JSON.stringify({ report, plan }, null, 2));
      } else {
        renderReport(report, plan);
      }
      return 0;
    }

    const reports = await listAnalystReports(pool, exchange, { limit });
    const plans = await listTradingPlans(pool, exchange, { limit });
    if (options.json) {
      console.log(JSON.stringify({ reports, plans }, null, 2));
      return 0;
    }
    if (reports.length === 0 && plans.length === 0) {
      console.log('还没有任何报告或方案。');
      return 0;
    }
    for (const report of reports) {
      const plan = plans.find((p) => p.reportId === report.id) ?? null;
      console.log(`=== ${report.symbol} ===`);
      renderReport(report, plan);
      console.log('');
    }
    return 0;
  });
}

// @vitest-environment jsdom
// Agent 面板的用例（v1.0.0）。四条都是「不骗人」的硬要求：
//   * 从没分析过是**正常**状态，不能显示成报错；
//   * 方案是「建议」时必须写明它不会变成真实订单（默认只出方案、不下单）；
//   * **已调整**（风险被夹住、止盈被抬高）必须显式显示——
//     「模型说要冒 3% 的险，程序把它夹到了 1%」这件事，人得知道；
//   * 读到形状不对的响应**不许把整页带崩**，但必须常驻可见地报错。
import './setup.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentPanel } from '../../ui/src/components/AgentPanel';
import type { AgentReportDto, AgentViewDto, TradingPlanDto } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = 1_760_000_000_000;

function report(overrides: Partial<AgentReportDto> = {}): AgentReportDto {
  return {
    id: '1',
    symbol: 'AAAUSDT',
    interval: '1h',
    asOfMs: NOW,
    createdAtMs: NOW,
    stance: 'bullish',
    confidence: 0.72,
    bias: 0.61,
    agreement: 0.88,
    technical: { score: 0.7, notes: ['均线多头排列'] },
    sentiment: { score: 0.4, notes: ['资金费率为正'] },
    fundamental: { score: 0.1, notes: ['流动性充足'] },
    atr: 2.5,
    lastClose: 100,
    rationale: '趋势与情绪同向。',
    degraded: false,
    ...overrides,
  };
}

function plan(overrides: Partial<TradingPlanDto> = {}): TradingPlanDto {
  return {
    id: '9',
    symbol: 'AAAUSDT',
    reportId: '1',
    createdAtMs: NOW,
    action: 'enter',
    status: 'advisory',
    side: 'BUY',
    entryType: 'market',
    entryPrice: 100,
    stopPrice: 95,
    takeProfitPrice: 110,
    quantity: 2,
    notional: 200,
    riskAmount: 10,
    equity: 1000,
    equitySource: 'exchange',
    riskFraction: 0.01,
    riskReward: 2,
    stance: 'bullish',
    confidence: 0.72,
    rationale: '顺势进场。',
    adjustments: [],
    failureReason: null,
    entryOrderId: null,
    executionFailureReason: null,
    approvable: true,
    approvableReason: null,
    ...overrides,
  };
}

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

describe('AgentPanel', () => {
  it('从没分析过：显示「还没有被分析过」，不是报错', async () => {
    stubFetch({ symbol: 'AAAUSDT', report: null, plan: null });
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText(/还没有被分析过/)).toBeTruthy());
    expect(screen.queryByText(/读取 Agent 报告失败/)).toBeNull();
  });

  it('有报告：显示三面分数、合成立场与一致性', async () => {
    stubFetch({ symbol: 'AAAUSDT', report: report(), plan: null } satisfies AgentViewDto);
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText('看多')).toBeTruthy());
    expect(screen.getByText(/均线多头排列/)).toBeTruthy();
    expect(screen.getByText(/资金费率为正/)).toBeTruthy();
    expect(screen.getByText(/趋势与情绪同向/)).toBeTruthy();
    // 一致性要显示出来：它决定这个结论有多可信
    expect(screen.getByText(/一致性 0.880/)).toBeTruthy();
  });

  it('情绪面降级：显式说明「仅供参考」，不让缺项悄悄溜过去', async () => {
    stubFetch({
      symbol: 'AAAUSDT',
      report: report({ degraded: true }),
      plan: null,
    } satisfies AgentViewDto);
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText(/情绪面有数据没取到/)).toBeTruthy());
  });

  it('有方案：显示进场、仓位、止损，并写明「这只是建议」', async () => {
    stubFetch({ symbol: 'AAAUSDT', report: null, plan: plan() } satisfies AgentViewDto);
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText(/BUY market/)).toBeTruthy());
    expect(screen.getByText(/止损 95/)).toBeTruthy();
    // 默认只出方案、不下单：这句话必须在页面上
    expect(screen.getByText(/这只是建议/)).toBeTruthy();
    // 报告与方案是两个号（报告按数据时刻 upsert，方案每轮新建），
    // 不写清楚「基于哪份报告」，页面上就像是对不上
    expect(screen.getByText(/基于报告 #1/)).toBeTruthy();
  });

  it('方案被夹过：调整记录必须显示出来', async () => {
    stubFetch({
      symbol: 'AAAUSDT',
      report: null,
      plan: plan({ adjustments: ['风险比例超过上限 0.0100，夹到上限：0.0300 → 0.0100'] }),
    } satisfies AgentViewDto);
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText(/已调整/)).toBeTruthy());
    expect(screen.getByText(/风险比例超过上限/)).toBeTruthy();
  });

  it('方案不能批准：不给批准按钮，但说清为什么；驳回照常能用', async () => {
    // 限价进场不能自动执行。判据在 core 里算好传过来（`approvable` / `approvableReason`），
    // 页面不自己判一遍——那是第二份实现，措辞迟早漂移。
    const reason = '限价进场暂不支持自动执行（只支持市价进场）';
    stubFetch({
      symbol: 'AAAUSDT',
      report: null,
      plan: plan({
        entryType: 'limit',
        approvable: false,
        approvableReason: reason,
      }),
    } satisfies AgentViewDto);
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText(/BUY limit/)).toBeTruthy());
    // 原因要显示出来：不给按钮却不解释，用户只会以为页面坏了
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    // 驳回始终可用——不能用不代表不能拒
    expect(screen.getByRole('button', { name: '驳回' })).toBeTruthy();
  });

  it('方案失败：显示失败原因，而不是一片空白', async () => {
    stubFetch({
      symbol: 'AAAUSDT',
      report: null,
      plan: plan({
        action: 'failed',
        status: 'advisory',
        side: null,
        entryType: null,
        entryPrice: null,
        stopPrice: null,
        takeProfitPrice: null,
        quantity: null,
        notional: null,
        riskAmount: null,
        riskFraction: null,
        riskReward: null,
        rationale: '分析师模型调用失败：超时',
        failureReason: '分析师模型调用失败：超时',
        entryOrderId: null,
        executionFailureReason: null,
        approvable: false,
        approvableReason: '方案是「出不了方案」，没有可执行的进场，不能批准',
      }),
    } satisfies AgentViewDto);
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText(/未出方案/)).toBeTruthy());
    expect(screen.getByText(/分析师模型调用失败/)).toBeTruthy();
  });

  it('读到形状不对的响应：常驻可见地报错，但不把整页带崩', async () => {
    // 形状不对的典型来源：控制面还是改动前启动的旧进程，回包根本不是 Agent 视图
    stubFetch({ items: [] });
    render(<AgentPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => expect(screen.getByText(/形状不对/)).toBeTruthy());
    // 关键：不许抛异常把整页带崩
    expect(screen.getByText(/分析师与交易员/)).toBeTruthy();
  });
});

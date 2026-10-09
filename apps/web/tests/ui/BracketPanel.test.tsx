// @vitest-environment jsdom
// 止盈止损面板的用例（v0.4.0）。三条都是「不骗人」的硬要求：
//   * 一条记录都没有是**正常**状态，不能显示成报错；
//   * failed 被 limit 截掉时仍要显式提醒——仓位有、但没有保护单是最该被看见的一种；
//   * 只挂上止盈单（单号不成对）必须标红，不能和「成交后被交易所撤单」显示得一样。
import './setup.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BracketPanel } from '../../ui/src/components/BracketPanel';
import type { BracketsDto } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = 1_760_000_000_000;

function payload(overrides: Partial<BracketsDto> = {}): BracketsDto {
  return {
    symbol: 'AAAUSDT',
    limit: 20,
    items: [],
    countsByState: { armed: 0, take_profit: 0, stop_loss: 0, cancelled: 0, failed: 0 },
    ...overrides,
  };
}

function armed() {
  return {
    entryOrderId: 'order-1',
    exchange: 'binance',
    symbol: 'AAAUSDT',
    entryPrice: 100,
    entryTime: NOW - 3_600_000,
    filledQty: 2,
    positionSide: 'LONG',
    atr: 2.5,
    atrPeriod: 14,
    atrInterval: '1h',
    atrWindowFrom: NOW - 7_200_000,
    atrWindowTo: NOW - 3_600_000,
    stopPrice: 96,
    takeProfit: 108,
    tpOrderId: 111,
    slOrderId: 222,
    state: 'armed' as const,
    lastError: null,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 3_600_000,
  };
}

function stubFetch(body: BracketsDto) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    ),
  );
}

describe('BracketPanel', () => {
  it('没有任何记录时显示空状态，而不是报错', async () => {
    stubFetch(payload());
    render(<BracketPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => {
      expect(screen.getByText(/还没有买入成交/)).toBeTruthy();
    });
  });

  it('显示入场价、止盈价、止损价与 ATR', async () => {
    stubFetch(payload({ items: [armed()] }));
    render(<BracketPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => {
      expect(screen.getByText('100')).toBeTruthy();
    });
    expect(screen.getByText('108')).toBeTruthy();
    expect(screen.getByText('96')).toBeTruthy();
    expect(screen.getByText('2.5')).toBeTruthy();
    // 止盈/止损相对入场价的距离，让用户一眼看出风险收益比。
    expect(screen.getByText('+8.00%')).toBeTruthy();
    expect(screen.getByText('-4.00%')).toBeTruthy();
  });

  it('failed 被 limit 截掉时仍然显式提醒', async () => {
    // items 里一条 failed 都没有，但 counts 说有 2 笔——这是最容易被漏掉的情况。
    stubFetch(
      payload({
        items: [armed()],
        countsByState: { armed: 1, take_profit: 0, stop_loss: 0, cancelled: 0, failed: 2 },
      }),
    );
    render(<BracketPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => {
      expect(screen.getByText(/另有 2 笔「挂单失败」不在最近 20 条里/)).toBeTruthy();
    });
  });

  it('单号不成对时标红说明（两张单必须都在）', async () => {
    stubFetch(
      payload({
        items: [{ ...armed(), state: 'failed', tpOrderId: 111, slOrderId: null }],
        countsByState: { armed: 0, take_profit: 0, stop_loss: 0, cancelled: 0, failed: 1 },
      }),
    );
    render(<BracketPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => {
      expect(screen.getByText('单号不成对')).toBeTruthy();
    });
  });

  it('读取失败时把错误常驻显示，不静默吞掉', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    render(<BracketPanel symbol="AAAUSDT" tick={0} />);

    await waitFor(() => {
      expect(screen.getByText(/读取止盈止损记录失败/)).toBeTruthy();
    });
  });
});

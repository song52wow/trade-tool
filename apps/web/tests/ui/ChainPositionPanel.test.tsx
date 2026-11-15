// @vitest-environment jsdom
// 链上仓位页面的用例（v1.2.0）。
//
// 页面分两层：**卡片列表**（`#/chain`）与**详情**（`#/chain/<仓位键>`）。
// 硬要求：
//   * **没配置仓位**是正常状态，要说清下一步，不能显示空白页；
//   * **还没采过样**不能显示成 0（0 会被读成「这个仓位一文不值」）；
//   * **盈亏的百分数**是 -0.25% 而不是 -25%——乘错一次 100 就差 100 倍；
//   * **读取失败必须常驻可见**，不能只弹一下 toast；
//   * **APY 必须带着口径**（数字离开「按最近几天年化」就是个来路不明的百分数）。
import './setup.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChainPositionPanel,
  formatLiquidity,
  formatRawAmount,
} from '../../ui/src/components/ChainPositionPanel';
import type { ChainPositionDto, ChainSnapshotDto } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = 1_760_000_000_000;

const MANAGER = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364';
const POOL = '0xB2c8244FBeee2dA006b5D9Cf09908081f807C649';
const OWNER = '0xa6150000000000000000000000000000000004488';

/**
 * 一笔仓位的页面数据。
 *
 * `links` 与 `apy` 在真实链路里都是**服务端算好**的
 * （core 的 `buildChainPositionLinks` / `computeChainApy`），
 * 这里手写一份：前端只负责显示，不自己拼链接、不自己算年化。
 */
function position(overrides: Partial<ChainPositionDto> = {}): ChainPositionDto {
  return {
    positionKey: '0xabc123',
    chain: 'bsc',
    symbol0: 'pPOLY',
    symbol1: 'USDT',
    tokenId: '7784261',
    owner: OWNER,
    positionManager: MANAGER,
    pool: POOL,
    token0: '0xtoken0',
    token1: '0xtoken1',
    links: {
      explorer: {
        pool: `https://bscscan.com/address/${POOL}`,
        position: `https://bscscan.com/nft/${MANAGER}/7784261`,
        owner: `https://bscscan.com/address/${OWNER}`,
        depositTx: 'https://bscscan.com/tx/0x0919aaaa615',
        token0: 'https://bscscan.com/token/0xtoken0',
        token1: 'https://bscscan.com/token/0xtoken1',
      },
      liquidity: {
        position: 'https://pancakeswap.finance/liquidity/7784261?chain=bsc',
        positions: 'https://pancakeswap.finance/liquidity/positions?network=56',
      },
    },
    apy: {
      apyPct: 22.31,
      windowMs: 7 * 24 * 60 * 60 * 1000,
      feeUsdt: 1.28,
      capitalUsdt: 75.15,
      note: null,
    },
    price: 11.8404,
    priceLower: 11.4716,
    priceUpper: 12.427,
    inRange: true,
    valueUsdt: 74.92,
    costUsdt: 75.15,
    realizedUsdt: 0,
    pnlUsdt: -0.19,
    // 已经是**百分数**：-0.25 表示 -0.25%
    pnlPct: -0.25,
    feeUsdt: 0.03,
    amount0: '3817796370563371000000',
    amount1: '29717601928740590000000',
    liquidity: '550060234221891411106',
    lastPollAt: NOW - 60_000,
    lastAlertAt: NOW - 600_000,
    lastError: null,
    depositTx: '0x0919aaaa615',
    ...overrides,
  };
}

/**
 * 一次采样的明细（详情页「采样明细」表格的一行）。
 *
 * 与仓位的口径一致：`pnlPct` **已经是百分数**，`feeUsdt` 是**累计未领**手续费。
 */
function snapshot(overrides: Partial<ChainSnapshotDto> = {}): ChainSnapshotDto {
  return {
    ts: NOW - 15 * 60_000,
    block: '67382915',
    price: 11.8404,
    valueUsdt: 74.92,
    pnlUsdt: -0.19,
    pnlPct: -0.25,
    feeUsdt: 0.03,
    inRange: true,
    ...overrides,
  };
}

/**
 * 假 fetch。用**最长前缀**匹配（与 fixtures.ts 同一套约定）：
 * 前缀相近时按书写顺序取谁太脆——按长度从长到短取才稳。
 */
function stubFetch(handlers: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      /**
       * 采样明细的 URL **以 `/api/chain/positions` 开头**，
       * 不单列一个更长的前缀的话，采样请求会落到仓位列表那个前缀上，
       * 拿到一批形状完全不对的数据（页面上会显示一堆乱码行）。
       */
      const all: Record<string, unknown> = {
        '/api/chain/positions/0xabc123/snapshots': {
          positionKey: '0xabc123',
          limit: 500,
          items: [snapshot()],
        },
        ...handlers,
      };
      const key = Object.keys(all)
        .filter((k) => url.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(all[key]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

/**
 * 取某张指标卡上的数值。
 *
 * 断言**精确到卡片**：整页搜「0.00 USDT」会连「已实现盈亏」一起命中——
 * 那个 0 是账上真实的 0（还没赚到钱），不是「未采样」，两者不能混为一谈。
 *
 * ⚠️ **只在指标卡区里找**：详情页的「采样明细」表头里也有「现价」「当前价值」
 * 「浮动盈亏」这几个字（它们是**另一块**的东西），全页面找会命中两个，
 * `getByText` 遇到多个直接抛错。
 */
function cardValue(label: string): string {
  const cards = document.querySelector('.cards');
  const card = Array.from(cards?.querySelectorAll('.card') ?? []).find(
    (c) => c.querySelector('.label')?.textContent === label,
  );
  return card?.querySelector('.value')?.textContent ?? '';
}

/**
 * 采样明细表的**表头**（一列一个字段）。
 *
 * 只查表头那一行：明细里的行也有「现价」「当前价值」这些内容，
 * 全表查会把数据行一起捞进来。
 */
function snapTableHeaders(): string[] {
  const table = document.querySelector('.chain-snap-table table');
  return Array.from(table?.querySelectorAll('th') ?? []).map((th) => th.textContent ?? '');
}

describe('链上仓位：卡片列表', () => {
  it('没配置任何仓位：说清下一步，而不是空白页', async () => {
    stubFetch({ '/api/chain/positions': { items: [] } });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey={null} />);

    await waitFor(() => expect(screen.getByText(/尚未配置链上仓位/)).toBeTruthy());
    // 「没配」是正常状态，不能显示成错误
    expect(screen.queryByText(/读取链上仓位失败/)).toBeNull();
  });

  it('刷新失败时保留上一次的数据，并常驻说明这是旧数据', async () => {
    // 回归用例：原来读取失败是**整页 return**，一次抖动就把卡片与服务状态全丢掉；
    // 同一页的其它面板都是「保留旧数据 + 注明是旧的」。
    let fail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith('/api/chain/positions')) {
          if (fail) return new Response('boom', { status: 500 });
          return new Response(JSON.stringify({ items: [position()] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { rerender } = render(<ChainPositionPanel tick={0} now={NOW} positionKey={null} />);
    await waitFor(() => expect(screen.getByText('pPOLY / USDT')).toBeTruthy());

    fail = true;
    rerender(<ChainPositionPanel tick={3} now={NOW} positionKey={null} />); // 面板刷新分档

    await waitFor(() => expect(screen.getByText(/读取链上仓位失败/)).toBeTruthy());
    // 旧数据仍在，且明确标注「不是现在的链上状态」
    expect(screen.getByText('pPOLY / USDT')).toBeTruthy();
    expect(screen.getByText(/上一次成功读到的数据/)).toBeTruthy();
  });

  it('卡片上直接给出重点：值多少、赚没赚、在不在区间、年化多少', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey={null} />);

    await waitFor(() => expect(screen.getByText('pPOLY / USDT')).toBeTruthy());
    // 值与盈亏
    expect(screen.getByText('74.92 USDT')).toBeTruthy();
    expect(screen.getByText('-0.19 USDT')).toBeTruthy();
    // 区间状态：标签与尺子上的结论各一处（「区间内」出现两次是正常的）
    expect(screen.getAllByText('区间内').length).toBeGreaterThan(0);
    // 区间尺也在卡上：不用点进去就知道价格离边界多远
    expect(screen.getByRole('img', { name: /现价 .*定价区间 .*区间内/ })).toBeTruthy();
    // 年化：数字 + 口径
    expect(screen.getByText('22.31%')).toBeTruthy();
    expect(screen.getByText(/按最近 7\.0 天累计手续费年化/)).toBeTruthy();
  });

  it('APY 算不出来时：显示「—」并说清为什么，不给一个编出来的数', async () => {
    stubFetch({
      '/api/chain/positions': {
        items: [
          position({
            apy: {
              apyPct: null,
              windowMs: 3_600_000,
              feeUsdt: 0.01,
              capitalUsdt: 75.15,
              note: '采样还不到一天，年化没有意义',
            },
          }),
        ],
      },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey={null} />);

    await waitFor(() => expect(screen.getByText('采样还不到一天，年化没有意义')).toBeTruthy());
    expect(screen.queryByText('22.31%')).toBeNull();
  });

  it('多笔仓位：每笔一张卡，不藏在下拉里', async () => {
    stubFetch({
      '/api/chain/positions': {
        items: [
          position(),
          position({ positionKey: '0xdef456', tokenId: '7784262', symbol0: 'pPEPE' }),
        ],
      },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey={null} />);

    await waitFor(() => expect(screen.getByText('pPOLY / USDT')).toBeTruthy());
    expect(screen.getByText('pPEPE / USDT')).toBeTruthy();
    expect(screen.getByText(/共 2 笔/)).toBeTruthy();
    // 卡片就是入口：整张卡是一个链接（点哪都行）
    const card = screen.getByRole('link', { name: /pPOLY \/ USDT/ });
    expect(card.getAttribute('href')).toBe('#/chain/0xabc123');
  });

  it('点卡片进详情（路由变了，不是组件内部状态）', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey={null} />);

    await waitFor(() => expect(screen.getByText('pPOLY / USDT')).toBeTruthy());
    const card = screen.getByRole('link', { name: /pPOLY \/ USDT/ });
    card.click();

    // 详情是**另一条路由**：地址栏要变，前进/后退才有用
    await waitFor(() => expect(window.location.hash).toBe('#/chain/0xabc123'));
  });
});

describe('链上仓位：详情', () => {
  it('显示仓位身份、持有人地址与区间', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText('pPOLY / USDT')).toBeTruthy());
    expect(screen.getByText('#7784261')).toBeTruthy();
    expect(screen.getByText('bsc')).toBeTruthy();
    // 持有人地址**完整显示**：它是「这笔仓位是谁的」的唯一凭据，截断了没法核对
    expect(screen.getByText(OWNER)).toBeTruthy();
    expect(screen.getByText(/11.4716 ~ 12.427/)).toBeTruthy();
  });

  it('顶部先给一句人话结论：在不在区间、赚了还是亏了、成本多少', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() =>
      expect(
        screen.getByText(
          /价格在定价区间内，仓位在赚手续费；当前浮亏 0\.19 USDT（-0\.25%），成本 75\.15 USDT/,
        ),
      ).toBeTruthy(),
    );
  });

  it('价格出区间时，结论句说的是「只剩一种币、不赚手续费」', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position({ inRange: false, pnlUsdt: 1.5, pnlPct: 2 })] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() =>
      expect(screen.getByText(/价格已出定价区间——只剩一种币，暂时不赚手续费/)).toBeTruthy(),
    );
    expect(screen.getByText(/当前浮盈 1\.50 USDT/)).toBeTruthy();
  });

  it('地址 / 仓位键 / L 值收进「技术细节」，默认收起（仍在 DOM 里，可查）', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText('技术细节')).toBeTruthy());
    const details = screen.getByText('技术细节').closest('details');
    expect(details).not.toBeNull();
    // 默认收起：这些排障字段不该占着首屏
    expect((details as HTMLDetailsElement).open).toBe(false);
    // 收起不等于删掉：核对链上身份时仍找得到
    expect(screen.getByText(OWNER)).toBeTruthy();
    expect(screen.getByText('0xabc123')).toBeTruthy();
  });

  it('指标卡：现价、价值、盈亏、持仓', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(cardValue('现价')).toBe('11.8404'));
    expect(cardValue('当前价值')).toBe('74.92 USDT');
    expect(cardValue('浮动盈亏')).toBe('-0.19 USDT');
    expect(screen.getByText('当前持仓')).toBeTruthy();
  });

  it('「已赚手续费」放在显眼处，并注明是未领取、已计入浮动盈亏', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText('已赚手续费')).toBeTruthy());
    expect(cardValue('已赚手续费')).toBe('+0.03 USDT');
    expect(screen.getByText('未领取 · 已计入浮动盈亏')).toBeTruthy();
  });

  it('APY 卡片：数字与口径一起给', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText('当前 APY')).toBeTruthy());
    expect(cardValue('当前 APY')).toBe('22.31%');
    // 口径必须跟着数字：孤零零一个百分数会被当成「稳赚」
    expect(screen.getByText(/按最近 7\.0 天累计手续费年化/)).toBeTruthy();
  });

  it('区间尺：条上标出现价位置，并用 aria-label 说清在区间内/外', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    const track = await screen.findByRole('img', { name: /现价 .*定价区间 .*区间内/ });
    expect(track).toBeTruthy();
    expect(screen.getByText(/现价 11\.8404/)).toBeTruthy();
    // 标题旁也给一个结论，不用去图上找
    expect(screen.getByText('现在在区间内')).toBeTruthy();
  });

  it('价格出区间时，区间尺标记出区间并说明低于下界多少', async () => {
    stubFetch({
      '/api/chain/positions': {
        items: [position({ price: 11, inRange: false })],
      },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    const track = await screen.findByRole('img', { name: /区间外/ });
    expect(track).toBeTruthy();
    expect(screen.getByText(/低于下界/)).toBeTruthy();
    expect(screen.getByText('现在在区间外')).toBeTruthy();
  });

  it('盈亏百分数是 -0.25%，不是 -25%（乘错一次 100 就差 100 倍）', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText('-0.25%')).toBeTruthy());
    // 绝不能出现 -25%（那说明前端又乘了一次 100）
    expect(screen.queryByText('-25.00%')).toBeNull();
    expect(screen.queryByText('-25%')).toBeNull();
  });

  it('持仓数量除以 1e18 显示，不显示一长串原始整数', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    // 千分位是**有意加的**（与全仓其它金额一个口径）：3,817.79 比 3817.79 好读；
    // 小数位取 4 位，与飞书告警文案一致（同一个数，两个出口别长得不一样）。
    await waitFor(() => expect(screen.getByText('3,817.7964 pPOLY')).toBeTruthy());
    expect(screen.getByText(/29,717.6019 USDT/)).toBeTruthy();
    // 原始值不该出现在页面上（它太长，且容易让人误读成「亿」）
    expect(screen.queryByText(/3817796370563371000000/)).toBeNull();
  });

  it('还没采过样：显示「尚未采样」而不是 0', async () => {
    stubFetch({
      '/api/chain/positions': {
        items: [
          position({
            price: null,
            inRange: null,
            valueUsdt: null,
            pnlUsdt: null,
            pnlPct: null,
            feeUsdt: null,
            amount0: null,
            amount1: null,
          }),
        ],
      },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getAllByText('尚未采样').length).toBeGreaterThan(0));
    // 指标卡**一张都不许显示 0**：0 会被读成「这个仓位一文不值」——那是谎报。
    expect(cardValue('现价')).toBe('—');
    expect(cardValue('当前价值')).toBe('—');
    expect(cardValue('浮动盈亏')).toBe('—');
    expect(cardValue('当前持仓')).toBe('—');
    // 整页也不该有「0.00 USDT」这种**采样值**的零
    // （「已实现盈亏」那个 0 是账上真实的 0，不是未采样——它不算在内）
    expect(screen.queryByText('0.0000')).toBeNull();
  });

  it('链上查看：区块浏览器与流动性平台的链接都在，新标签页打开', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText('链上查看')).toBeTruthy());
    expect(screen.getByText('区块浏览器')).toBeTruthy();
    expect(screen.getByText('流动性平台')).toBeTruthy();

    // 仓位 NFT → 区块浏览器的 NFT 页
    const nft = screen.getByRole('link', { name: '仓位 NFT' });
    expect(nft.getAttribute('href')).toBe(`https://bscscan.com/nft/${MANAGER}/7784261`);
    // 流动性平台 → 这笔仓位的详情页
    const positionLink = screen.getByRole('link', { name: '这笔仓位' });
    expect(positionLink.getAttribute('href')).toBe(
      'https://pancakeswap.finance/liquidity/7784261?chain=bsc',
    );
    // 外链一律新标签页，且带 noopener（少了它，新页面能反过来操纵这一页）
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });

  it('链不认识时：明说没有外部链接，而不是摆一排空按钮', async () => {
    stubFetch({
      '/api/chain/positions': {
        items: [
          position({
            links: {
              explorer: {
                pool: null,
                position: null,
                owner: null,
                depositTx: null,
                token0: null,
                token1: null,
              },
              liquidity: { position: null, positions: null },
            },
          }),
        ],
      },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText(/这条链没有配外部链接/)).toBeTruthy());
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('定价区间：下界与上界明写出来，未采样时也照样给', async () => {
    stubFetch({
      '/api/chain/positions': {
        items: [
          position({
            price: null,
            inRange: null,
            valueUsdt: null,
            pnlUsdt: null,
            pnlPct: null,
            feeUsdt: null,
            amount0: null,
            amount1: null,
          }),
        ],
      },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    // 区间由 tick 决定，**不依赖采样**：还没采到样也必须给得出来
    await waitFor(() => expect(screen.getByText('下界 11.4716')).toBeTruthy());
    expect(screen.getByText('上界 12.427')).toBeTruthy();
    // 现价未知就说不知道，不能瞎标一个位置
    expect(screen.getByText(/还没采样，暂不知道现价在不在区间/)).toBeTruthy();
  });

  it('最后采样失败：错误常驻显示，不静默吞掉', async () => {
    stubFetch({
      '/api/chain/positions': { items: [position({ lastError: 'RPC 超时' })] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText(/最后一次采样失败：RPC 超时/)).toBeTruthy());
    // 必须说清「上面的数字是上一次的」，否则用户会以为那就是现在的链上状态
    expect(screen.getByText(/上一次成功的采样/)).toBeTruthy();
  });

  it('采样明细：每一次采样一行，用表格摆出来', async () => {
    stubFetch({
      '/api/chain/positions/0xabc123/snapshots': {
        positionKey: '0xabc123',
        limit: 500,
        items: [
          snapshot({ ts: NOW - 30 * 60_000, price: 11.5, inRange: true }),
          snapshot({
            ts: NOW - 15 * 60_000,
            price: 12.9,
            inRange: false,
            pnlUsdt: 1.2,
            pnlPct: 1.6,
          }),
        ],
      },
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    // ⚠️ 等的是**表格本身**而不是面板标题：标题是立刻渲染的，
    // 等它等于没等——表格要等取数回来才出现（这坑真踩到过：偶发失败）。
    await waitFor(() =>
      expect(snapTableHeaders()).toEqual([
        '采样时间',
        '现价',
        '区间',
        '当前价值',
        '浮动盈亏',
        '累计手续费',
        '区块高度',
      ]),
    );
    // 两次采样都在
    expect(screen.getByText('11.5')).toBeTruthy();
    expect(screen.getByText('12.9')).toBeTruthy();
    // 区间内外都标出来了
    expect(screen.getAllByText('区间内').length).toBeGreaterThan(0);
    expect(screen.getAllByText('区间外').length).toBeGreaterThan(0);
    // 总数照实写出来
    expect(screen.getByText(/共 2 条采样/)).toBeTruthy();
  });

  it('采样明细按时间倒序：最新的在最上面', async () => {
    stubFetch({
      '/api/chain/positions/0xabc123/snapshots': {
        positionKey: '0xabc123',
        limit: 500,
        items: [
          snapshot({ ts: NOW - 30 * 60_000, price: 11.1 }),
          snapshot({ ts: NOW - 15 * 60_000, price: 11.2 }),
        ],
      },
      '/api/chain/positions': { items: [position()] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    // 等**两行数据都到了**再比顺序（等标题没用：标题立刻就有）。
    await waitFor(() => {
      const rows = screen.getAllByRole('row').filter((r) => r.querySelector('td') !== null);
      expect(rows).toHaveLength(2);
    });
    const rows = screen.getAllByRole('row').filter((r) => r.querySelector('td') !== null);
    // 表头是第一行，数据行里第一行是**最新**那条（11.2）
    expect(rows[0]?.textContent).toContain('11.2');
    expect(rows[1]?.textContent).toContain('11.1');
  });

  it('采样明细读不到：常驻报错，但不影响上面的当前指标', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/snapshots')) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ items: [position()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xabc123" />);

    await waitFor(() => expect(screen.getByText(/读取采样明细失败/)).toBeTruthy());
    // 采样明细读不到，**不等于**整个仓位读不到——上面的指标照旧
    expect(screen.getByText('当前价值')).toBeTruthy();
    expect(cardValue('当前价值')).toBe('74.92 USDT');
  });

  it('读取仓位失败：错误常驻显示，不静默吞掉', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":{"code":"DB_CONNECTION_FAILED","message":"连接被拒"}}', {
            status: 503,
          }),
      ),
    );
    render(<ChainPositionPanel tick={0} now={NOW} positionKey={null} />);

    await waitFor(() => expect(screen.getByText(/读取链上仓位失败/)).toBeTruthy());
    expect(screen.getByText(/DB_CONNECTION_FAILED/)).toBeTruthy();
  });

  it('路由给了仓位键、库里却没有这一笔：说清并给一条回去的路', async () => {
    stubFetch({
      '/api/chain/positions': { items: [] },
    });
    render(<ChainPositionPanel tick={0} now={NOW} positionKey="0xdeadbeef" />);

    // 库里一笔都没有 → 走「尚未配置」那一支；这里再补一条「库里没有这一笔」的
    await waitFor(() => expect(screen.getByText(/尚未配置链上仓位/)).toBeTruthy());
  });
});

/**
 * 原始单位换算。
 *
 * 这两条**曾经悄悄失灵过**：`formatRawAmount` 写成「整数后面补 18 个零」，
 * 于是小数点根本没挪——页面显示的是一长串原始整数（3,817,796,370,563,371,000,000），
 * 看的人以为这个仓位有 38 亿个币。**这类错不会报错，只会骗人**，
 * 所以纯函数必须单独钉死。
 */
describe('原始单位换算', () => {
  it('代币数量：1e18 = 1 个币，小数点挪 18 位', () => {
    // 默认显示 4 位小数：与飞书告警文案同一精度（两个出口别长得不一样）。
    expect(formatRawAmount('3817796370563371000000')).toBe('3,817.7964');
    expect(formatRawAmount('29717601928740590000000')).toBe('29,717.6019');
    expect(formatRawAmount('1000000000000000000')).toBe('1');
    expect(formatRawAmount('0')).toBe('0');
    expect(formatRawAmount('1500000000000000000')).toBe('1.5');
    // 空值是「没采到」，不是 0
    expect(formatRawAmount(null)).toBe('—');
    expect(formatRawAmount('')).toBe('—');
  });

  it('小数位超过 4 位时四舍五入（不是截断）', () => {
    // 3.818850601383304894 → 3.8189（第 5 位是 5，进位）
    expect(formatRawAmount('3818850601383304894')).toBe('3.8189');
    // 29.705119358672012474 → 29.7051（第 5 位是 1，不进位）
    expect(formatRawAmount('29705119358672012474')).toBe('29.7051');
    // 想要更多位时可以把上限调大（库里始终是原始单位，账面精度没变）
    expect(formatRawAmount('3818850601383304894', 18)).toBe('3.818850601383304894');
  });

  it('流动性：原样显示（L 值是 Q96 刻度，除以 1e18 会得到没有单位的数）', () => {
    expect(formatLiquidity('550060234221891411106')).toBe('550,060,234,221,891,411,106');
    expect(formatLiquidity(null)).toBe('—');
  });
});

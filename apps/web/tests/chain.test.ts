/**
 * 链上仓位的两条读路由（v1.2.0）。
 *
 * 重点不是「能返回数据」，而是三条**不骗人**的硬要求：
 *   1. **回包结构**要对得上前端约定的形状（`items` + 每项的字段名）；
 *   2. **字段映射**不能错位——尤其是 `pnlPct`（它已经是百分数，
 *      页面不能再乘一次 100）与「原始单位」的字符串（页面才除以 1e18）；
 *   3. **空数据**是正常状态（200 + 空数组），不是 404；
 *      读失败必须**报错**而不是静默返回空数组（否则页面会显示成「一切正常」）。
 */

import { describe, expect, it } from 'vitest';

import { buildApp, type WebDeps } from '../src/server.js';
import type { ChainPositionDto, ChainSnapshotDto } from '../src/types.js';

const NOW = 1_760_000_000_000;

const position: ChainPositionDto = {
  positionKey: '0xabc123',
  chain: 'bsc',
  symbol0: 'pPOLY',
  symbol1: 'USDT',
  tokenId: '7784261',
  owner: '0xa6150000000000000000000000000000000004488',
  positionManager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
  pool: '0xB2c8244FBeee2dA006b5D9Cf09908081f807C649',
  token0: '0xtoken0',
  token1: '0xtoken1',
  links: {
    explorer: {
      pool: 'https://bscscan.com/address/0xB2c8244FBeee2dA006b5D9Cf09908081f807C649',
      position: 'https://bscscan.com/nft/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364/7784261',
      owner: 'https://bscscan.com/address/0xa6150000000000000000000000000000000004488',
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
  // ⚠️ 已经是**百分数**：-0.25 表示 -0.25%。页面直接显示，不能再乘 100。
  pnlPct: -0.25,
  feeUsdt: 0.03,
  amount0: '3817796370563371000000',
  amount1: '29717601928740590000000',
  liquidity: '550060234221891411106',
  lastPollAt: NOW - 60_000,
  lastAlertAt: NOW - 600_000,
  lastError: null,
  depositTx: '0x0919aaaa615',
};

const snapshot: ChainSnapshotDto = {
  ts: NOW - 60_000,
  block: '132918540',
  price: 11.8404,
  valueUsdt: 74.92,
  pnlUsdt: -0.19,
  pnlPct: -0.25,
  feeUsdt: 0.03,
  inRange: true,
};

/** 只覆盖链上那两条，其余用空实现——这个文件只关心链上路由。 */
function deps(overrides: Partial<WebDeps> = {}): WebDeps {
  const base: WebDeps = {
    getOverview: async () => {
      throw new Error('本用例不关心概览');
    },
    listSymbols: async () => [],
    getSymbol: async () => null,
    listExchangeSymbols: async () => ({
      exchange: 'binance',
      count: 0,
      cachedAt: NOW,
      ageMs: 0,
      stale: false,
      symbols: [],
    }),
    addSymbol: async () => {
      throw new Error('不该被调用');
    },
    removeSymbol: async () => undefined,
    lifecycle: async () => {
      throw new Error('不该被调用');
    },
    listGaps: async () => [],
    listBars: async () => [],
    listBrackets: async () => ({
      symbol: 'AAAUSDT',
      limit: 20,
      items: [],
      countsByState: {
        armed: 0,
        partial_armed: 0,
        trailing: 0,
        take_profit: 0,
        stop_loss: 0,
        cancelled: 0,
        failed: 0,
      },
    }),
    reconcile: async () => {
      throw new Error('不该被调用');
    },
    reattach: async () => {
      throw new Error('不该被调用');
    },
    latestReconciliation: async () => null,
    getCredentialStatus: async () => ({
      exchange: 'binance',
      configured: false,
      hint: null,
      updatedAt: null,
      masterKeyReady: true,
    }),
    writeCredentials: async () => {
      throw new Error('不该被调用');
    },
    clearCredentials: async () => {
      throw new Error('不该被调用');
    },
    getNotifyStatus: async () => {
      throw new Error('不该被调用');
    },
    writeNotifySettings: async () => {
      throw new Error('不该被调用');
    },
    clearNotifySettings: async () => {
      throw new Error('不该被调用');
    },
    testNotify: async () => ({ ok: true, sentAt: NOW }),
    getRiskPolicy: async () => {
      throw new Error('不该被调用');
    },
    writeRiskPolicy: async () => {
      throw new Error('不该被调用');
    },
    deleteRiskPolicy: async () => ({ ok: true }),
    estimate: async () => {
      throw new Error('不该被调用');
    },
    listAgentView: async () => ({ symbol: 'AAAUSDT', report: null, plan: null }),
    listChainPositions: async () => [position],
    listChainSnapshots: async () => [snapshot],
    setTradingPlanStatus: async () => {
      throw new Error('不该被调用');
    },
    getAgentLlmStatus: async () => {
      throw new Error('不该被调用');
    },
    writeAgentLlmSettings: async () => {
      throw new Error('不该被调用');
    },
    clearAgentLlmSettings: async () => {
      throw new Error('不该被调用');
    },
    startJob: async () => {
      throw new Error('不该被调用');
    },
    listJobs: async () => [],
    getJob: async () => null,
  };
  return Object.assign(base, overrides);
}

describe('GET /api/chain/positions', () => {
  it('回包是 { items: [...] }，字段名与前端约定一致', async () => {
    const app = buildApp(deps());
    const body = (await (await app.request('/api/chain/positions')).json()) as {
      items: ChainPositionDto[];
    };

    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toMatchObject({
      positionKey: '0xabc123',
      chain: 'bsc',
      symbol0: 'pPOLY',
      symbol1: 'USDT',
      tokenId: '7784261',
      owner: '0xa6150000000000000000000000000000000004488',
      price: 11.8404,
      priceLower: 11.4716,
      priceUpper: 12.427,
      inRange: true,
      valueUsdt: 74.92,
      costUsdt: 75.15,
      realizedUsdt: 0,
      pnlUsdt: -0.19,
      pnlPct: -0.25,
      feeUsdt: 0.03,
      amount0: '3817796370563371000000',
      amount1: '29717601928740590000000',
      liquidity: '550060234221891411106',
      lastPollAt: NOW - 60_000,
      lastAlertAt: NOW - 600_000,
      lastError: null,
      depositTx: '0x0919aaaa615',
    });
  });

  it('原始单位原样透出：字符串，不在服务端换算成小数', async () => {
    const app = buildApp(deps());
    const body = (await (await app.request('/api/chain/positions')).json()) as {
      items: ChainPositionDto[];
    };

    // 服务端要是自作主张除成 3.817796370563371，页面就再也拿不到精确的原始值了。
    expect(typeof body.items[0]?.amount0).toBe('string');
    expect(body.items[0]?.amount0).toBe('3817796370563371000000');
    expect(body.items[0]?.liquidity).toBe('550060234221891411106');
  });

  it('一笔仓位都没配时 200 + 空数组，不是 404', async () => {
    const app = buildApp(deps({ listChainPositions: async () => [] }));
    const res = await app.request('/api/chain/positions');
    const body = (await res.json()) as { items: unknown[] };

    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('读失败时报错，不静默返回空数组', async () => {
    const app = buildApp(
      deps({
        listChainPositions: async () => {
          throw new Error('连接被拒');
        },
      }),
    );
    const res = await app.request('/api/chain/positions');
    const body = (await res.json()) as { error: { code: string; message: string } };

    // 返回 200 + 空数组会让页面显示成「没有配置仓位」——那是谎报。
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toContain('连接被拒');
  });
});

describe('GET /api/chain/positions/:positionKey/snapshots', () => {
  it('回包带 positionKey、生效 limit 与升序的采样点', async () => {
    const app = buildApp(deps());
    const body = (await (
      await app.request('/api/chain/positions/0xabc123/snapshots?limit=50')
    ).json()) as {
      positionKey: string;
      limit: number;
      items: ChainSnapshotDto[];
    };

    expect(body.positionKey).toBe('0xabc123');
    expect(body.limit).toBe(50);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      ts: NOW - 60_000,
      block: '132918540',
      price: 11.8404,
      valueUsdt: 74.92,
      pnlUsdt: -0.19,
      pnlPct: -0.25,
      feeUsdt: 0.03,
      inRange: true,
    });
  });

  it('不传 limit 用缺省 200', async () => {
    const seen: number[] = [];
    const app = buildApp(
      deps({
        listChainSnapshots: async (_key, options) => {
          seen.push(options.limit);
          return [];
        },
      }),
    );
    await app.request('/api/chain/positions/0xabc123/snapshots');

    expect(seen).toEqual([200]);
  });

  it('非法 limit 报 400 且**不落到查询层**', async () => {
    for (const raw of ['0', '-5', '1.5', 'abc']) {
      const seen: number[] = [];
      const app = buildApp(
        deps({
          listChainSnapshots: async (_key, options) => {
            seen.push(options.limit);
            return [];
          },
        }),
      );
      const res = await app.request(`/api/chain/positions/0xabc123/snapshots?limit=${raw}`);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFIG_INVALID');
      expect(seen).toEqual([]);
    }
  });

  it('positionKey 为空时报 400，不查库', async () => {
    const seen: string[] = [];
    const app = buildApp(
      deps({
        listChainSnapshots: async (key) => {
          seen.push(key);
          return [];
        },
      }),
    );
    const res = await app.request('/api/chain/positions/%20/snapshots');

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFIG_INVALID');
    expect(seen).toEqual([]);
  });

  it('没采过样时 200 + 空数组，不是 404', async () => {
    const app = buildApp(deps({ listChainSnapshots: async () => [] }));
    const res = await app.request('/api/chain/positions/0xabc123/snapshots');
    const body = (await res.json()) as { items: unknown[] };

    // 「还没采过样」是完全正常的状态；404 会让页面误以为路由不存在。
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('读失败时报错，不静默返回空数组', async () => {
    const app = buildApp(
      deps({
        listChainSnapshots: async () => {
          throw new Error('表不存在');
        },
      }),
    );
    const res = await app.request('/api/chain/positions/0xabc123/snapshots');
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(500);
    expect(body.error.message).toContain('表不存在');
  });
});

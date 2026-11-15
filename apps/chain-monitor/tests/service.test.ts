/**
 * 监控一轮的编排测试：**假链 + 真库**（全程不出网）。
 *
 * 链上事实由本地假 BSC 节点按真链的 ABI 布局返回，库是随机 schema + 从空库跑迁移。
 *
 * 锁的是四条纪律（`src/service.ts` 文件头里写的那几条）：
 *   * 一轮 = 读链 → 算账 → 落库 → 判定 → 推送，顺序不能乱；
 *   * **推不出去不算说过**——推送失败时「上次推送」的基准不能动；
 *   * **读失败必须常驻可见**——错误写在对应那一行上，页面能看见；
 *   * **一笔坏的不拖垮别的**——另一笔仓位照常处理。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AlertDispatcher,
  chainSchema,
  type AlertChannel,
  type NotifyEvent,
} from '@trade-tool/core';
import {
  BscClient,
  createTestSchema,
  listChainAlerts,
  listChainPositions,
  listChainSnapshots,
  startMockBscNode,
  type MockBscState,
} from '@trade-tool/data';

import { createChainMonitorService } from '../src/service.js';

const POOL = '0xb2c8244fbeee2da006b5d9cf09908081f807c649';
const MANAGER = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364';
const TOKEN0 = '0x0000000000000000000000000000000000000001';
const TOKEN1 = '0x0000000000000000000000000000000000000002';
const OWNER = '0xa6156641dfcda456985fe6d79cd62313b2d04488';

const LIQUIDITY = 550060234221891411106n;
const TICK_LOWER = 24400;
const TICK_UPPER = 25200;
/** tick 24716 对应的价格（11.8404 USDT/pPOLY）。 */
const SQRT_PRICE = 272624679396422263054081193139n;

function baseState(): MockBscState {
  return {
    pool: POOL,
    positionManager: MANAGER,
    token0: TOKEN0,
    token1: TOKEN1,
    position: {
      tokenId: '7784261',
      owner: OWNER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity: LIQUIDITY,
      feeGrowth0Last: 0n,
      feeGrowth1Last: 0n,
      owed0: 0n,
      owed1: 0n,
    },
    sqrtPriceX96: SQRT_PRICE,
    tick: 24716,
    decimals0: 18,
    decimals1: 18,
    feeGrowthGlobal0: 9_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthGlobal1: 60_900_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside0Lower: 1_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside0Upper: 2_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside1Lower: 20_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside1Upper: 10_000_000_000_000_000_000_000_000_000_000_000n,
    poolFee: 10_000,
    blockNumber: 132_930_326n,
  };
}

/** 一笔仓位的配置（与链上事实一一对应）。 */
function positionConfig(tokenId = '7784261') {
  return {
    chain: 'bsc',
    positionManager: MANAGER,
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    tokenId,
    owner: OWNER,
    depositAmount0: '3400000000000000000',
    depositAmount1: '34677495886492744054',
    symbol0: 'pPOLY',
    symbol1: 'USDT',
  };
}

/** 记录推送内容的假通道。 */
function recordingChannel(events: NotifyEvent[], fail = false): AlertChannel {
  return {
    notifier: {
      enabled: true,
      async notify(event: NotifyEvent): Promise<void> {
        events.push(event);
        if (fail) throw new Error('假故障：推送失败');
      },
    },
    kinds: ['chain-position-alert'],
    repeatCooldownMs: 0,
  };
}

describe('链上仓位监控的一轮', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>;
  let node: Awaited<ReturnType<typeof startMockBscNode>>;
  let events: NotifyEvent[];
  let nowMs = 1_760_000_000_000;

  beforeAll(async () => {
    ctx = await createTestSchema('chainmon');
    node = await startMockBscNode(baseState());
  });

  afterAll(async () => {
    await node.close();
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE chain_position_alert, chain_position_snapshot, chain_position');
    node.state = baseState();
    node.failWith(null);
    events = [];
    nowMs = 1_760_000_000_000;
  });

  function service(overrides: { failPush?: boolean; positions?: unknown[] } = {}) {
    const config = chainSchema.parse({
      enabled: true,
      rpcEndpoints: [node.url],
      pollIntervalMs: 900_000,
      positions: overrides.positions ?? [positionConfig()],
      thresholds: { priceMovePct: 1.5, pnlMovePp: 1.5, cooldownMs: 1_800_000 },
    });
    const channel = recordingChannel(events, overrides.failPush ?? false);
    const alerts = new AlertDispatcher({ channel });
    return createChainMonitorService({
      pool: ctx.pool,
      config,
      client: new BscClient({ endpoints: [node.url] }),
      alerts,
      now: () => nowMs,
    });
  }

  it('第一轮：建基线、落库、推一条', async () => {
    const results = await service().pollOnce();
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.ok).toBe(true);
    expect(result.alert).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.reasons).toContain('首次监控，建立基线');
    // 账算得出来：现值与成本都在
    expect(result.snapshot?.valueUsdt).toBeCloseTo(74.92, 1);
    expect(result.snapshot?.costUsdt).toBeCloseTo(75.15, 1);

    // 仓位已登记，采样已落库
    const positions = await listChainPositions(ctx.pool);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.tokenId).toBe('7784261');
    const snapshots = await listChainSnapshots(ctx.pool, positions[0]!.positionKey);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.price).toBeCloseTo(11.8404, 3);

    // 消息发出去了
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toContain('pPOLY/USDT');
  });

  it('第二轮没变化：不推', async () => {
    const svc = service();
    await svc.pollOnce();
    events.length = 0;
    nowMs += 900_000;

    const results = await svc.pollOnce();
    expect(results[0]!.alert).toBe(false);
    expect(results[0]!.sent).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('价格动了超过阈值：推一条', async () => {
    const svc = service();
    await svc.pollOnce();
    events.length = 0;
    // 越过冷却期（默认 30 分钟），否则「刚推过」会把它压住——
    // 那是对的：同一条提醒半小时内不重复。
    nowMs += 2_000_000;

    // 价格从 11.8404 挪到约 12.59（+6.3%），越过 1.5% 的阈值
    node.state.sqrtPriceX96 = 281_085_000_000_000_000_000_000_000_000n;
    node.state.tick = 25000;

    const results = await svc.pollOnce();
    expect(results[0]!.alert).toBe(true);
    expect(results[0]!.sent).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('推不出去：不算「已经说过」，基准不动，下一轮还会试', async () => {
    const svc = service({ failPush: true });
    const results = await svc.pollOnce();
    expect(results[0]!.alert).toBe(true);
    // 推送失败 → 没发出去
    expect(results[0]!.sent).toBe(false);

    const positions = await listChainPositions(ctx.pool);
    // 「上次推送」的基准必须还是空的：没推出去就不能当成说过
    expect(positions[0]!.lastAlertPrice).toBeNull();
    // 但失败也要留记录（页面与日志都能看见）
    const alerts = await listChainAlerts(ctx.pool, positions[0]!.positionKey);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.sent).toBe(false);
  });

  it('读链失败：错误常驻在对应那一行上', async () => {
    const svc = service();
    await svc.pollOnce();

    node.failWith(-32000, '节点抽风');
    nowMs += 900_000;
    const results = await svc.pollOnce();
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain('节点全部不可用');

    const positions = await listChainPositions(ctx.pool);
    expect(positions[0]!.lastError).toContain('节点全部不可用');
  });

  it('一笔坏的不拖垮别的', async () => {
    const svc = service({
      positions: [positionConfig('7784261'), { ...positionConfig('7784262'), owner: OWNER }],
    });
    // 第二笔的 tokenId 在链上不存在 → 它的 tick 区间读不出来，会抛错
    const results = await svc.pollOnce();
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    // 好的那一笔照样落库
    expect(await listChainPositions(ctx.pool)).toHaveLength(1);
  });

  it('仓位被清空：立刻推，不受冷却限制', async () => {
    const svc = service();
    await svc.pollOnce();
    events.length = 0;
    nowMs += 60_000; // 远在冷却期内

    node.state.position.liquidity = 0n;
    node.state.poolLiquidity = 0n;
    node.state.managerLiquidity = 0n;

    const results = await svc.pollOnce();
    expect(results[0]!.alert).toBe(true);
    expect(results[0]!.sent).toBe(true);
    expect(results[0]!.reasons).toContain('仓位已经清空（流动性归零）');
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
  });
});

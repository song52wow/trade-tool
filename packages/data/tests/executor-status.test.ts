/**
 * executor 状态行的读写（2026-11-06）。
 *
 * 守的是「活着」与「能用」必须分开记：
 *   * 私有接口全挂时**心跳照跳**（进程确实还活着），
 *     而「服务能不能用」是另一列——合成一个「在线」就是骗人；
 *   * 恢复之后**错误列要清空**：一条三小时前的旧错挂在那儿，
 *     会让人以为现在也是坏的。
 *
 * 真库、真迁移、真 SQL（行情与交易所在这里不参与）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deleteExecutorStatus,
  markExecutorPrivateApi,
  readExecutorStatus,
  upsertExecutorStatus,
} from '../src/index.js';

import { createTestSchema } from './helpers/pg.js';

const NOW = 1_760_000_000_000;

describe('executor 状态行', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>;

  beforeAll(async () => {
    ctx = await createTestSchema('execstat');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('没有行 = 确切地「没在跑」（不是「不确定」）', async () => {
    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW);
    expect(view.state).toBe('stopped');
    expect(view.pid).toBeNull();
    // 「没在跑」与「不能用」是两件事：这里不能显示成「不可用」。
    expect(view.privateApiOk).toBeNull();
  });

  it('刚起来还没成功调用过私有接口时是「未知」，不是「不可用」', async () => {
    await upsertExecutorStatus(ctx.pool, 'binance', NOW, 4242);
    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW + 1_000);
    expect(view.state).toBe('running');
    // 「还没调用过」是未知，不是「不能用」——把未知说成可用或不可用都是骗人。
    expect(view.privateApiOk).toBeNull();
    expect(view.lastPrivateOkAt).toBeNull();
  });

  it('心跳新鲜 = 运行中；私有接口失败不影响「进程还活着」这一维', async () => {
    await upsertExecutorStatus(ctx.pool, 'binance', NOW, 4242);
    await markExecutorPrivateApi(ctx.pool, 'binance', {
      ok: false,
      code: '-2015',
      message: 'Invalid API-key, IP, or permissions for action',
    });

    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW + 1_000);
    expect(view.state).toBe('running');
    expect(view.pid).toBe(4242);
    expect(view.privateApiOk).toBe(false);
    expect(view.lastErrorCode).toBe('-2015');
    expect(view.lastErrorMessage).toContain('Invalid API-key');
    // 一次都没成功过 → 没有「上次成功」的时刻，不能拿 0 冒充。
    expect(view.lastPrivateOkAt).toBeNull();
  });

  it('心跳超阈值 = 失联（进程被强杀或卡死）', async () => {
    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW + 120_000);
    expect(view.state).toBe('stale');
    expect(view.ageMs).toBe(120_000);
  });

  it('恢复之后错误列被清空，「上次成功」被记上', async () => {
    await upsertExecutorStatus(ctx.pool, 'binance', NOW, 4242);
    await markExecutorPrivateApi(ctx.pool, 'binance', {
      ok: false,
      code: '-2015',
      message: 'Invalid API-key',
    });
    await markExecutorPrivateApi(ctx.pool, 'binance', { ok: true }, NOW + 5_000);

    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW + 6_000);
    expect(view.privateApiOk).toBe(true);
    expect(view.lastErrorCode).toBeNull();
    expect(view.lastErrorMessage).toBeNull();
    expect(view.lastPrivateOkAt).toBe(NOW + 5_000);
  });

  it('私有接口先坏、状态行后建时，那次失败**不会**被吞掉', async () => {
    // 启动顺序：先播种（私有接口调用）→ 后写心跳。
    // 若这里用的是 UPDATE 而不是 upsert，行还不存在、影响 0 行，
    // 那次失败就被静默丢掉——紧接着心跳把它建成「正常」。
    await deleteExecutorStatus(ctx.pool, 'binance');
    await markExecutorPrivateApi(ctx.pool, 'binance', {
      ok: false,
      code: '-2015',
      message: 'Invalid API-key, IP, or permissions for action',
    });
    await upsertExecutorStatus(ctx.pool, 'binance', NOW, 4242);

    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW + 1_000);
    expect(view.privateApiOk).toBe(false);
    expect(view.lastErrorCode).toBe('-2015');
  });

  it('心跳刷新不会冲掉「上次失败的原因」', async () => {
    await upsertExecutorStatus(ctx.pool, 'binance', NOW, 4242);
    await markExecutorPrivateApi(ctx.pool, 'binance', {
      ok: false,
      code: '-2015',
      message: 'Invalid API-key',
    });
    // 再刷一次心跳（私有接口仍然挂着）
    await upsertExecutorStatus(ctx.pool, 'binance', NOW + 1_000, 4242);

    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW + 2_000);
    expect(view.privateApiOk).toBe(false);
    expect(view.lastErrorCode).toBe('-2015');
    expect(view.lastBeatAt).toBe(NOW + 1_000);
  });

  it('优雅退出后删掉行 → 又变成确切的「没在跑」', async () => {
    await upsertExecutorStatus(ctx.pool, 'binance', NOW, 4242);
    await deleteExecutorStatus(ctx.pool, 'binance');
    const view = await readExecutorStatus(ctx.pool, 'binance', 60_000, NOW + 1_000);
    expect(view.state).toBe('stopped');
    expect(view.privateApiOk).toBeNull();
  });
});

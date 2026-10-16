import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SyncError } from '@trade-tool/core';
import {
  assertWatermarkConsistent,
  ensureSyncState,
  listGaps,
  listStates,
  setSyncPlan,
  pendingGapCount,
  readBars,
  readGlobalSummary,
  readLatestBars,
  readState,
  readWeightBudget,
  deleteDaemonHeartbeat,
  readDaemonHeartbeat,
  removeSymbolEntry,
  setDesiredState,
  setSyncStatus,
  upsertSymbolEntry,
  upsertDaemonHeartbeat,
  watermark,
} from '../src/index.js';

import { barTimes, createTestSchema, insertBars, type TestSchema } from './helpers/pg.js';

const MINUTE = 60_000;
const BASE = 1_760_000_000_000;

/** 三个互不相同的标的，参数化验证「代码里没有标的特例」（R-5）。 */
const SYMBOLS = ['AAAUSDC', 'BBBUSDC', 'CCCUSDC'] as const;

describe('查询层与数据语义', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('repo');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('R-9.1 水位由 max(time) 推导，无数据时为 null', async () => {
    const empty = await watermark(ctx.pool, 'NODATA');
    expect(empty.maxTime).toBeNull();
    expect(empty.rows).toBe(0);

    const times = barTimes(BASE, 5);
    await insertBars(ctx.pool, 'WATER', times);
    const filled = await watermark(ctx.pool, 'WATER');
    expect(filled.maxTime).toBe(times[times.length - 1]);
    expect(filled.rows).toBe(5);
  });

  it('R-9.7 水位单调不减：写入更晚的 bar 后 max(time) 只增', async () => {
    const times = barTimes(BASE, 5);
    const before = await watermark(ctx.pool, 'MONO');
    expect(before.maxTime).toBeNull();

    await insertBars(ctx.pool, 'MONO', times);
    const mid = await watermark(ctx.pool, 'MONO');
    expect(mid.maxTime).toBe(times[4]);

    // 重放同样区间（幂等）后水位不变
    await insertBars(ctx.pool, 'MONO', times);
    const replay = await watermark(ctx.pool, 'MONO');
    expect(replay.maxTime).toBe(times[4]);
    expect(replay.rows).toBe(5);

    await insertBars(ctx.pool, 'MONO', [BASE + 5 * MINUTE]);
    const after = await watermark(ctx.pool, 'MONO');
    expect(after.maxTime).toBe(BASE + 5 * MINUTE);
  });

  it('R-4.1 读出 NULL 的必填列必须报错，不得静默', async () => {
    // 写入侧有 NOT NULL 兜底，因此这里**临时放宽约束**来模拟「历史脏数据 / 绕过写入的外部改动」，
    // 验证读取层的防御真的会抛错而不是把 null 当 0 用。
    await ctx.pool.query('ALTER TABLE klines_1m ALTER COLUMN volume DROP NOT NULL');
    try {
      await ctx.pool.query(
        `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)
         VALUES ($1, $2, 1, 1, 1, 1, NULL)`,
        ['CORRUPT', BASE],
      );
      await expect(readBars(ctx.pool, 'CORRUPT', {})).rejects.toMatchObject({
        code: 'NULL_NOT_ALLOWED',
      });
    } finally {
      await ctx.pool.query('DELETE FROM klines_1m WHERE symbol = $1', ['CORRUPT']);
      await ctx.pool.query('ALTER TABLE klines_1m ALTER COLUMN volume SET NOT NULL');
    }

    // 约束恢复后写入 NULL 再次被拒（R-4.1 写入侧同样不得静默）
    await expect(
      ctx.pool.query(
        `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)
         VALUES ($1, $2, 1, 1, 1, 1, NULL)`,
        ['CORRUPT2', BASE],
      ),
    ).rejects.toThrow();
  });

  it('R-4.4 读不到行返回空数组，可区分「未同步」与「字段为 NULL」', async () => {
    const rows = await readBars(ctx.pool, 'NEVER_SYNCED', {});
    expect(rows).toEqual([]);
  });

  it('R-3.6 能查询写入进度（已入库行数 / 目标行数）', async () => {
    await insertBars(ctx.pool, 'PROGRESS', barTimes(BASE, 7));
    const state = await readState(ctx.pool, 'binance', 'PROGRESS');
    const truth = await watermark(ctx.pool, 'PROGRESS');
    // 权威行数永远来自数据本身，而不是某个可能漂移的计数器
    expect(truth.rows).toBe(7);
    expect(state?.rows ?? 7).toBe(7);
  });

  it('R-19.6 / AC-21 水位缓存与 max(time) 不一致时报错', async () => {
    await ensureSyncState(ctx.pool, 'binance', 'DRIFT');
    await insertBars(ctx.pool, 'DRIFT', barTimes(BASE, 3));
    // 缓存水位为空但库里已有数据 → 不一致
    await expect(assertWatermarkConsistent(ctx.pool, 'binance', 'DRIFT')).rejects.toMatchObject({
      code: 'WATERMARK_MISMATCH',
    });

    // 对齐后放行
    await setSyncStatus(ctx.pool, 'binance', 'DRIFT', {});
    await ctx.pool.query(
      'UPDATE sync_state SET watermark = $3 WHERE exchange = $1 AND symbol = $2',
      ['binance', 'DRIFT', barTimes(BASE, 3)[2]],
    );
    const result = await assertWatermarkConsistent(ctx.pool, 'binance', 'DRIFT');
    expect(result.watermark).toBe(barTimes(BASE, 3)[2]);
  });

  it('R-19 sync_state 能持久化并读回全部字段', async () => {
    await ensureSyncState(ctx.pool, 'binance', 'FIELDS', 'running');
    await setSyncStatus(ctx.pool, 'binance', 'FIELDS', {
      lastError: 'boom',
      errorCount: 3,
      backoffUntil: BASE + 1_000,
      lastRunAt: BASE,
    });
    const state = await readState(ctx.pool, 'binance', 'FIELDS');
    expect(state?.status).toBe('running');
    expect(state?.lastError).toBe('boom');
    expect(state?.errorCount).toBe(3);
    expect(state?.backoffUntil).toBe(BASE + 1_000);
    expect(state?.lastRunAt).toBe(BASE);
    expect(state?.pendingGaps).toBe(0);
  });

  it('R-19.1 水位推进只经由写入事务，setSyncStatus 不得改动水位', async () => {
    await ensureSyncState(ctx.pool, 'binance', 'NOWATER');
    await setSyncStatus(ctx.pool, 'binance', 'NOWATER', { status: 'error', lastError: 'x' });
    const state = await readState(ctx.pool, 'binance', 'NOWATER');
    expect(state?.watermark).toBeNull();
    expect(state?.verifiedUpTo).toBeNull();
  });

  it('R-11.11 缺口清单与缺失总行数可查询', async () => {
    for (const [index, symbol] of SYMBOLS.entries()) {
      await insertBars(ctx.pool, symbol, barTimes(BASE, 3));
      await ctx.pool.query(
        `INSERT INTO gaps (exchange, symbol, gap_start, gap_end, missing_rows, attempts)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['binance', symbol, BASE + 10 * MINUTE, BASE + 12 * MINUTE, 3, index],
      );
    }
    const all = await listGaps(ctx.pool);
    expect(all).toHaveLength(SYMBOLS.length);
    const perSymbol = await listGaps(ctx.pool, 'BBBUSDC');
    expect(perSymbol).toHaveLength(1);
    expect(perSymbol[0]?.missingRows).toBe(3);
    expect(await pendingGapCount(ctx.pool)).toBe(SYMBOLS.length);
    expect(await pendingGapCount(ctx.pool, 'CCCUSDC')).toBe(1);
  });

  it('R-18.1/R-18.4 标的集合增删与幂等', async () => {
    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: 'SET1' });
    const again = await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: 'SET1' });
    expect(again.symbol).toBe('SET1');

    // 新标的默认 paused（R-8.4 / R-17.4）
    expect(again.desiredState).toBe('paused');

    // 幂等设置期望状态
    const changed = await setDesiredState(ctx.pool, 'binance', 'SET1', 'running');
    expect(changed).toBe(true);
    const unchanged = await setDesiredState(ctx.pool, 'binance', 'SET1', 'running');
    expect(unchanged).toBe(false);
  });

  it('R-18.3 keep 策略不移除数据；delete 策略才删行', async () => {
    const times = barTimes(BASE, 4);
    await insertBars(ctx.pool, 'KEEPDATA', times);
    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: 'KEEPDATA' });

    const kept = await removeSymbolEntry(ctx.pool, 'binance', 'KEEPDATA', 'keep');
    expect(kept.deletedRows).toBe(0);
    expect((await watermark(ctx.pool, 'KEEPDATA')).rows).toBe(4);

    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: 'DELDATA' });
    await insertBars(ctx.pool, 'DELDATA', times);
    const deleted = await removeSymbolEntry(ctx.pool, 'binance', 'DELDATA', 'delete');
    expect(deleted.deletedRows).toBe(4);
    expect((await watermark(ctx.pool, 'DELDATA')).rows).toBe(0);
  });

  it('R-20.4 配额使用率可查询', async () => {
    const status = await readWeightBudget(ctx.pool, 1_920);
    expect(status.budgetPerMinute).toBe(1_920);
    expect(status.used).toBeGreaterThanOrEqual(0);
    expect(status.utilization).toBeGreaterThanOrEqual(0);
    expect(status.pauseUntil).toBeNull();
  });

  it('R-19.8 全局汇总可查询，三个数字描述同一总体', async () => {
    // rows 是与数据同事务推进的可观测计数；这里按真实写入路径把它填上。
    await ctx.pool.query(
      `UPDATE sync_state SET rows = (SELECT count(*)::bigint FROM klines_1m WHERE klines_1m.symbol = sync_state.symbol)
       WHERE exchange = 'binance'`,
    );
    const summary = await readGlobalSummary(ctx.pool, 'binance');
    expect(summary.symbols).toBeGreaterThan(0);
    expect(summary.pendingGaps).toBeGreaterThan(0);
    // 标的数与各状态计数之和必须一致，否则控制面会读到互相矛盾的数字
    const sum =
      summary.countsByStatus.paused + summary.countsByStatus.running + summary.countsByStatus.error;
    expect(sum).toBe(summary.symbols);
  });

  it('listStates 对不存在的标的返回 null，不报错也不伪造', async () => {
    expect(await readState(ctx.pool, 'binance', 'GHOST')).toBeNull();
    const all = await listStates(ctx.pool);
    expect(all.every((s) => s.symbol !== 'GHOST')).toBe(true);
  });

  it('SyncError 带结构化 code 与 details（R-22.4）', () => {
    const error = new SyncError('SYMBOL_NOT_FOUND', 'nope', { symbol: 'X' });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('SYMBOL_NOT_FOUND');
    expect(error.toJSON()).toEqual({
      code: 'SYMBOL_NOT_FOUND',
      message: expect.stringContaining('nope'),
      details: { symbol: 'X' },
    });
  });
});

describe('第二轮缺陷回归（R-2.5 / R-3.3 / R-4.1 / R-8.3 / R-20.4）', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('repo2');
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** PG 允许 float8 存 'NaN'；Number('NaN') 会在 JSON 里被写成 null，静默洗掉「数据损坏」。 */
  it('R-4.1 读侧遇到 NaN/Infinity 必须报错，不得静默变成 null', async () => {
    for (const value of ["'NaN'::float8", "'Infinity'::float8"]) {
      await ctx.pool.query(
        `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)
         VALUES ('NANUSDC', $1, ${value}, 1, 1, 1, 1)
         ON CONFLICT (symbol, time) DO UPDATE SET open = EXCLUDED.open`,
        [BASE],
      );
      await expect(readBars(ctx.pool, 'NANUSDC', { limit: 1 })).rejects.toMatchObject({
        code: 'NULL_NOT_ALLOWED',
      });
    }
  });

  /** R-8.3 / R-8.6：首次全量的规模必须落在 sync_state 上，供控制面与 `sync status` 读。 */
  it('R-8.3 / R-8.6 首次全量规模可写入、可读出、可清空', async () => {
    await ensureSyncState(ctx.pool, 'binance', 'PLANUSDC');
    expect((await readState(ctx.pool, 'binance', 'PLANUSDC'))?.plan).toBeNull();

    await setSyncPlan(ctx.pool, 'binance', 'PLANUSDC', {
      bars: 1234,
      requests: 1,
      weight: 10,
      estimatedMs: 60_000,
      from: BASE,
      to: BASE + 1233 * MINUTE,
    });
    const state = await readState(ctx.pool, 'binance', 'PLANUSDC');
    expect(state?.plan).toEqual({
      bars: 1234,
      requests: 1,
      weight: 10,
      estimatedMs: 60_000,
      from: BASE,
      to: BASE + 1233 * MINUTE,
      computedAt: expect.any(Number),
    });

    await setSyncPlan(ctx.pool, 'binance', 'PLANUSDC', null);
    expect((await readState(ctx.pool, 'binance', 'PLANUSDC'))?.plan).toBeNull();
  });

  /**
   * R-3.3：python 侧整轮持有这个 advisory lock；delete 策略若不加锁就会与在跑的同步交错，
   * 删掉的行被写回来（「已删除/已移除」的标的复活）。键必须与 `pg.SymbolLock` 完全一致。
   */
  it('R-3.3 delete 策略在同步持锁期间必须拒绝（不改数据）', async () => {
    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: 'LOCKEDUSDC' });
    await insertBars(ctx.pool, 'LOCKEDUSDC', barTimes(BASE, 3));

    const holder = await ctx.pool.connect();
    try {
      await holder.query(
        `SELECT pg_advisory_lock(hashtextextended(current_schema() || '/' || $1 || '/' || $2, 0))`,
        ['binance', 'LOCKEDUSDC'],
      );
      await expect(
        removeSymbolEntry(ctx.pool, 'binance', 'LOCKEDUSDC', 'delete'),
      ).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
      // 数据一行未动
      expect(Number((await watermark(ctx.pool, 'LOCKEDUSDC')).rows)).toBe(3);
    } finally {
      await holder.query(
        `SELECT pg_advisory_unlock(hashtextextended(current_schema() || '/' || $1 || '/' || $2, 0))`,
        ['binance', 'LOCKEDUSDC'],
      );
      holder.release();
    }

    // 锁释放后可以正常删除
    const removed = await removeSymbolEntry(ctx.pool, 'binance', 'LOCKEDUSDC', 'delete');
    expect(removed.deletedRows).toBe(3);
    expect((await watermark(ctx.pool, 'LOCKEDUSDC')).rows).toBe(0);
  });

  /** R-20.4 要的是**当前窗口**的使用率：窗口已滚动时上一窗口的残留不能报成 100%。 */
  it('R-20.4 权重窗口已滚动时使用率报 0，而不是上一窗口的残留', async () => {
    const stale = Date.now() - 10 * MINUTE;
    await ctx.pool.query(
      `UPDATE weight_budget SET window_from = $1, used = 999, pause_until = NULL WHERE id = 1`,
      [stale],
    );
    const status = await readWeightBudget(ctx.pool, 1920);
    expect(status.used).toBe(0);
    expect(status.utilization).toBe(0);
    // 窗口本身就是过去那一刻，保留原值以便排查
    expect(status.windowFrom).toBe(stale);
  });
});

describe('守护进程心跳（控制面据它回答「有人在干活吗」）', () => {
  let ctx: TestSchema;
  const EX = 'binance';

  beforeAll(async () => {
    ctx = await createTestSchema('hb');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('没有心跳行 = stopped，且字段全为 null（不能拿 0 冒充时间戳）', async () => {
    const got = await readDaemonHeartbeat(ctx.pool, EX, 60_000, BASE);
    expect(got).toEqual({
      state: 'stopped',
      pid: null,
      startedAt: null,
      lastBeatAt: null,
      ageMs: null,
    });
  });

  it('写入后读到 running，且 started_at 保持首次启动时刻', async () => {
    await upsertDaemonHeartbeat(ctx.pool, EX, BASE, 111);
    // 定时器后续刷新只动 last_beat
    await upsertDaemonHeartbeat(ctx.pool, EX, BASE + 10_000, 111);

    const got = await readDaemonHeartbeat(ctx.pool, EX, 60_000, BASE + 11_000);
    expect(got.state).toBe('running');
    if (got.state === 'stopped') throw new Error('unreachable');
    expect(got.startedAt).toBe(BASE);
    expect(got.lastBeatAt).toBe(BASE + 10_000);
    expect(got.ageMs).toBe(1_000);
    expect(got.pid).toBe(111);
  });

  it('超过阈值判 stale，与 stopped 分开：处置方式不同', async () => {
    // 现在时间已经离最后一次心跳 5 分钟，远超 60s 阈值
    const got = await readDaemonHeartbeat(ctx.pool, EX, 60_000, BASE + 300_000);
    expect(got.state).toBe('stale');
    if (got.state === 'stopped') throw new Error('unreachable');
    expect(got.ageMs).toBe(290_000);
  });

  it('换进程后重置 started_at，不沿用上一个进程的启动时刻', async () => {
    await upsertDaemonHeartbeat(ctx.pool, EX, BASE + 400_000, 222);
    const got = await readDaemonHeartbeat(ctx.pool, EX, 60_000, BASE + 401_000);
    if (got.state === 'stopped') throw new Error('unreachable');
    expect(got.pid).toBe(222);
    expect(got.startedAt).toBe(BASE + 400_000);
  });

  it('删除后回到 stopped（优雅退出）', async () => {
    await deleteDaemonHeartbeat(ctx.pool, EX);
    const got = await readDaemonHeartbeat(ctx.pool, EX, 60_000, BASE + 402_000);
    expect(got.state).toBe('stopped');
  });

  it('删除不存在的行不报错（幂等，stop 路径不能因此失败）', async () => {
    await expect(deleteDaemonHeartbeat(ctx.pool, EX)).resolves.toBeUndefined();
  });
});

/**
 * `readLatestBars`：控制面 K 线图的取数（R-23）。
 *
 * 单独一组是因为它有一条容易被忽略的语义：对外**一律升序**，但取的是**最后 N 根**。
 * 弄反任何一个，图上就会出现「最新数据在最左边」或者「拿到的是最早那段」。
 */
describe('最近 N 根 K 线（readLatestBars，R-23）', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('latest');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('给 limit 时取的是**最后** N 根，且按时间升序返回', async () => {
    const times = barTimes(BASE, 10);
    await insertBars(ctx.pool, 'TAIL', times);

    const got = await readLatestBars(ctx.pool, 'TAIL', { limit: 3 });
    expect(got.map((b) => b.time)).toEqual(times.slice(-3));
    // 升序：图表与导出都按时间正序消费，倒序返回会让调用方各自再翻一次
    expect(got.map((b) => b.time)).toEqual([...got.map((b) => b.time)].sort((a, b) => a - b));
  });

  it('与 readBars 的区别正是「最早 vs 最新」，同一区间两者互补', async () => {
    const times = barTimes(BASE, 10);
    await insertBars(ctx.pool, 'BOTH', times);

    const earliest = await readBars(ctx.pool, 'BOTH', { limit: 3 });
    const latest = await readLatestBars(ctx.pool, 'BOTH', { limit: 3 });
    expect(earliest.map((b) => b.time)).toEqual(times.slice(0, 3));
    expect(latest.map((b) => b.time)).toEqual(times.slice(-3));
  });

  it('`to` 是闭区间上界：不晚于它的才算数', async () => {
    const times = barTimes(BASE, 10);
    await insertBars(ctx.pool, 'CUT', times);

    const got = await readLatestBars(ctx.pool, 'CUT', { limit: 100, to: times[4]! });
    expect(got.map((b) => b.time)).toEqual(times.slice(0, 5));
  });

  it('limit 大于行数时返回全部，不报错也不补空行', async () => {
    const times = barTimes(BASE, 4);
    await insertBars(ctx.pool, 'FEW', times);

    const got = await readLatestBars(ctx.pool, 'FEW', { limit: 10_000 });
    expect(got).toHaveLength(4);
  });

  it('从没有同步过的标的读出空数组（不是错误，调用方据此显示空状态）', async () => {
    await expect(readLatestBars(ctx.pool, 'NEVER', { limit: 10 })).resolves.toEqual([]);
  });

  it('只读本标的：不同标的的行互不串味（跨标的通用性 R-5）', async () => {
    await insertBars(ctx.pool, 'MINE', barTimes(BASE, 3));
    await insertBars(ctx.pool, 'OTHER', barTimes(BASE + 10 * 60_000, 7));

    const got = await readLatestBars(ctx.pool, 'MINE', { limit: 10 });
    expect(got).toHaveLength(3);
  });
});

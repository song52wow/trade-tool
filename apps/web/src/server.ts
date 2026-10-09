import { Hono } from 'hono';
import {
  INTERVAL_MS,
  SyncError,
  type GapRecord,
  type RemovePolicy,
  type StoredInterval,
} from '@trade-tool/core';

import { parseBarLimit, parseIndicatorIntervalParam, parseIntervalParam } from './bars.js';
import { toErrorBody } from './errors.js';
import { type IndicatorInterval } from '@trade-tool/data';

import type {
  AddSymbolBody,
  BarDto,
  ExchangeListDto,
  IndicatorsDto,
  JobDto,
  JobKind,
  LifecycleAction,
  OverviewDto,
  RemoveSymbolBody,
  StartJobBody,
  SymbolDetailDto,
  SymbolRowDto,
} from './types.js';

/**
 * 控制面所需的全部能力。
 *
 * 路由层只认这个接口，不认 `SyncService` 也不认连接池——于是路由测试可以用纯替身跑，
 * 既不需要 PG 也不需要网络（与仓库「测试过程中不得访问真实网络」一致）。
 */
export interface WebDeps {
  getOverview(): Promise<OverviewDto>;
  listSymbols(): Promise<SymbolRowDto[]>;
  getSymbol(symbol: string): Promise<SymbolDetailDto | null>;
  listExchangeSymbols(options?: { refresh?: boolean }): Promise<ExchangeListDto>;
  addSymbol(symbol: string): Promise<SymbolRowDto>;
  removeSymbol(symbol: string, policy: RemovePolicy): Promise<void>;
  lifecycle(symbol: string, action: LifecycleAction): Promise<SymbolRowDto>;
  listGaps(symbol: string): Promise<GapRecord[]>;
  /**
   * 最近 N 根 K 线，升序。`limit` 已由路由夹到上限内，这里拿到的就是生效值。
   * `interval` 同样已过白名单（未实现的周期在路由层就 400 了），这里不再重复校验。
   */
  listBars(symbol: string, options: { limit: number; interval: StoredInterval }): Promise<BarDto[]>;
  /**
   * 某周期下**全部已物化**的指标序列（R-10.1）。
   *
   * 仍是**纯读**：只打 PG，不出网、不写库、不消耗配额，因此可以挂在页面的刷新节奏上。
   * `interval` 已在路由层过白名单（1m / 5m / 其它 → 400），这里拿到的就是生效值。
   */
  listIndicators(
    symbol: string,
    options: { limit: number; interval: IndicatorInterval },
  ): Promise<IndicatorsDto>;
  estimate(symbol: string): Promise<SymbolDetailDto['estimate']>;
  startJob(input: { kind: JobKind; symbol: string; target?: number | undefined }): Promise<JobDto>;
  listJobs(): Promise<JobDto[]>;
  getJob(id: string): Promise<JobDto | null>;
}

const LIFECYCLE: readonly LifecycleAction[] = ['start', 'pause', 'resume'];

/** 会登记为长任务（202 + job id）的动作。 */
const JOB_ACTIONS: readonly JobKind[] = ['full', 'verify', 'aggregate'];

async function bodyOf<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new SyncError('CONFIG_INVALID', '请求体不是合法 JSON');
  }
}

/** 空字符串 / 纯空白一律当缺省——URL 里的空格几乎都是拼错。 */
function normalizeSymbol(raw: string): string {
  const symbol = raw.trim();
  if (symbol === '') throw new SyncError('CONFIG_INVALID', 'symbol 不能为空');
  return symbol;
}

export function buildApp(deps: WebDeps): Hono {
  const app = new Hono();

  /** 所有路由共用一套错误出口：SyncError 带 code 出去，退出码语义在 HTTP 上保留。 */
  app.onError((error, c) => {
    const { status, body } = toErrorBody(error);
    return c.json(body, status as 400);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/overview', async (c) => c.json(await deps.getOverview()));

  app.get('/api/symbols', async (c) => c.json({ items: await deps.listSymbols() }));

  app.post('/api/symbols', async (c) => {
    const body = await bodyOf<AddSymbolBody>(c);
    if (typeof body?.symbol !== 'string') {
      throw new SyncError('CONFIG_INVALID', '缺少 symbol');
    }
    return c.json(await deps.addSymbol(normalizeSymbol(body.symbol)), 201);
  });

  app.get('/api/symbols/:symbol', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    const detail = await deps.getSymbol(symbol);
    if (detail === null) {
      throw new SyncError('SYMBOL_NOT_FOUND', `${symbol} 不在标的集合里`, { symbol });
    }
    return c.json(detail);
  });

  app.delete('/api/symbols/:symbol', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    const raw = await bodyOf<Partial<RemoveSymbolBody>>(c).catch(
      () => ({}) as Partial<RemoveSymbolBody>,
    );
    const policy = raw?.policy ?? 'keep';
    if (policy !== 'keep' && policy !== 'archive' && policy !== 'delete') {
      throw new SyncError('CONFIG_INVALID', `未知的 removePolicy：${String(policy)}`, { policy });
    }
    await deps.removeSymbol(symbol, policy);
    return c.json({ ok: true, symbol, policy });
  });

  /**
   * 一个路径两种动作，避免注册两个同路径 handler（后者会被前者遮蔽）。
   * 生命周期立即返回（幂等，R-17.2/17.6）；重活儿返回 202 + job id。
   */
  app.post('/api/symbols/:symbol/:action', async (c) => {
    const action = c.req.param('action');
    const symbol = normalizeSymbol(c.req.param('symbol'));

    if (LIFECYCLE.includes(action as LifecycleAction)) {
      return c.json(await deps.lifecycle(symbol, action as LifecycleAction));
    }
    if (JOB_ACTIONS.includes(action as JobKind)) {
      const body = await bodyOf<Partial<StartJobBody>>(c).catch(
        () => ({}) as Partial<StartJobBody>,
      );
      const job = await deps.startJob({
        kind: action as JobKind,
        symbol,
        target: typeof body?.target === 'number' ? body.target : undefined,
      });
      return c.json(job, 202);
    }
    throw new SyncError('CONFIG_INVALID', `未知操作：${action}`, {
      action,
      allowed: [...LIFECYCLE, ...JOB_ACTIONS],
    });
  });

  app.get('/api/symbols/:symbol/gaps', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    return c.json({ symbol, items: await deps.listGaps(symbol) });
  });

  /**
   * K 线图取数（R-23 / R-7.1）：最近 N 根，**只读本地库**。
   *
   * 不出网、不写库，也不占用交易所配额——它是纯读，因此可以挂在页面的刷新节奏上。
   * 库里没有该标的数据时返回 `items: []`（200），不是 404：这个标的确实可能存在于
   * 页面之外的库里而只是没同步过，「没数据」是正常答案，页面要如实显示空状态。
   *
   * `?interval=` 缺省 `1m`（向后兼容）；非法或未实现的周期 → 400 `CONFIG_INVALID`，
   * **一次查询都不发**。回包带上**实际生效**的 `interval` 与 `intervalMs`，页面据此
   * 把缺口换算成「几根 / 几段 / 最长连续」（R-7.3）。
   */
  app.get('/api/symbols/:symbol/bars', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    const limit = parseBarLimit(c.req.query('limit'));
    const interval = parseIntervalParam(c.req.query('interval'));
    return c.json({
      symbol,
      interval,
      intervalMs: INTERVAL_MS[interval],
      limit,
      items: await deps.listBars(symbol, { limit, interval }),
    });
  });

  /**
   * 指标取数（R-10）：最近 N 根，按所选周期，**纯读本地库**。
   *
   * `?interval=` 只接受 `15m / 1h / 4h / 1d`；`1m` / `5m` / `foo` → 400
   * `CONFIG_INVALID`，**一次查询都不发**。绝不静默回落到某个周期：用户以为在看 4h、
   * 实际拿到 1h，正是最典型的静默兜底（AC-12）。
   *
   * 回包带上**实际生效**的 `interval` / `intervalMs` / `implVersion` / `specs`，
   * 以及「指标比 K 线短多少根、为什么短」——预热期与未收盘的最后一根会让指标序列
   * 天然短一截，不说清楚就会被当成数据缺失（R-10.4 / R-2.4）。
   */
  app.get('/api/symbols/:symbol/indicators', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    const limit = parseBarLimit(c.req.query('limit'));
    const interval = parseIndicatorIntervalParam(c.req.query('interval'));
    return c.json(await deps.listIndicators(symbol, { limit, interval }));
  });

  /** 规模预估（R-8.3）：首次全量前必须先算给人看，确认弹窗的数据就来自这里。 */
  app.get('/api/symbols/:symbol/estimate', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    return c.json({ symbol, estimate: await deps.estimate(symbol) });
  });

  app.get('/api/jobs', async (c) => c.json({ items: await deps.listJobs() }));

  app.get('/api/jobs/:id', async (c) => {
    const job = await deps.getJob(c.req.param('id'));
    if (job === null) {
      throw new SyncError('SYMBOL_NOT_FOUND', `作业不存在：${c.req.param('id')}`, {
        id: c.req.param('id'),
      });
    }
    return c.json(job);
  });

  app.get('/api/exchange', async (c) => {
    const refresh = c.req.query('refresh') === 'true';
    return c.json(await deps.listExchangeSymbols({ refresh }));
  });

  return app;
}

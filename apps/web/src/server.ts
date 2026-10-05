import { Hono } from 'hono';
import { SyncError, type GapRecord, type RemovePolicy } from '@trade-tool/core';

import { toErrorBody } from './errors.js';
import type {
  AddSymbolBody,
  ExchangeListDto,
  JobDto,
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
  estimate(symbol: string): Promise<SymbolDetailDto['estimate']>;
  startJob(input: {
    kind: 'full' | 'verify';
    symbol: string;
    target?: number | undefined;
  }): Promise<JobDto>;
  listJobs(): Promise<JobDto[]>;
  getJob(id: string): Promise<JobDto | null>;
}

const LIFECYCLE: readonly LifecycleAction[] = ['start', 'pause', 'resume'];

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
    if (action === 'full' || action === 'verify') {
      const body = await bodyOf<Partial<StartJobBody>>(c).catch(
        () => ({}) as Partial<StartJobBody>,
      );
      const job = await deps.startJob({
        kind: action,
        symbol,
        target: typeof body?.target === 'number' ? body.target : undefined,
      });
      return c.json(job, 202);
    }
    throw new SyncError('CONFIG_INVALID', `未知操作：${action}`, {
      action,
      allowed: [...LIFECYCLE, 'full', 'verify'],
    });
  });

  app.get('/api/symbols/:symbol/gaps', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    return c.json({ symbol, items: await deps.listGaps(symbol) });
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

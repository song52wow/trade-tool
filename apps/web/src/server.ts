import { Hono } from 'hono';
import {
  INTERVAL_MS,
  RECONCILE_KINDS,
  SyncError,
  type GapRecord,
  type ReconcileKind,
  type RemovePolicy,
  type StoredInterval,
} from '@trade-tool/core';

import {
  DEFAULT_BRACKET_LIMIT,
  MAX_BRACKET_LIMIT,
  parseBarLimit,
  parseIntervalParam,
} from './bars.js';
import { toErrorBody } from './errors.js';

import type {
  AddSymbolBody,
  BarDto,
  BracketsDto,
  CredentialStatusDto,
  CredentialWriteBody,
  ExchangeListDto,
  JobDto,
  JobKind,
  LifecycleAction,
  NotifyStatusDto,
  NotifyWriteBody,
  OverviewDto,
  RemoveSymbolBody,
  RiskPolicyEntryDto,
  RiskPolicyScopeDto,
  RiskPolicyViewDto,
  RiskPolicyWriteBody,
  ReconcileReport,
  StartJobBody,
  SymbolDetailDto,
  SymbolRowDto,
} from './types.js';
import { checkOrigin } from './csrf.js';

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
   * 某标的最近的止盈止损记录（v0.4.0），倒序。
   *
   * 仍是**纯读**：只打 PG，不下单、不改状态、不出网，因此可以挂在页面的刷新节奏上。
   * 库里没有记录时返回 200 + `items: []`——「还没成交过」是完全正常的状态。
   */
  listBrackets(symbol: string, options: { limit: number }): Promise<BracketsDto>;
  /**
   * 交易对账（v0.6.0）：交易所真实持仓/挂单 vs 本地记录，**只报告不动手**。
   *
   * 与上面那些纯读本地库的取数不同，这条**要签名访问交易所私有接口**，因此：
   *   * 不挂在刷新节奏上，只在用户点按钮时跑一次；
   *   * `symbol` **必填**——不带标的的 `openAlgoOrders` 权重是 40（带标的只要 1），
   *     一个能被随手连点的接口不该默认按那个价走。全账户对账走 CLI。
   */
  reconcile(symbol: string): Promise<ReconcileReport>;
  /**
   * 最近一次**自动**对账的快照；从没跑过时 `null`。
   *
   * 纯读本地表，因此可以挂在刷新节奏上——与 `/bars` 同性质：出网发生在
   * executor 里，这里只是把已经算好的结果读出来。
   */
  latestReconciliation(): Promise<ReconcileReport | null>;
  /**
   * 凭据状态（v0.5.0）。**只回「配没配」与末 4 位**。
   *
   * WebDeps 里刻意**没有**任何能返回明文密钥的方法：控制面在类型层面就没有这个能力。
   */
  getCredentialStatus(): Promise<CredentialStatusDto>;
  /** 写入加密后的凭据。返回状态而非明文。 */
  writeCredentials(input: { apiKey: string; apiSecret: string }): Promise<CredentialStatusDto>;
  clearCredentials(): Promise<CredentialStatusDto>;
  /**
   * 通知设置状态（v0.8.0）。**只回状态**，没有明文地址。
   *
   * 与凭据那条线同一条安全线：控制面从设计上就没有把凭据显示出来的能力。
   */
  getNotifyStatus(): Promise<NotifyStatusDto>;
  writeNotifySettings(body: NotifyWriteBody): Promise<NotifyStatusDto>;
  clearNotifySettings(): Promise<NotifyStatusDto>;
  /**
   * 发送一条测试消息（v0.8.0）。
   *
   * 它是**唯一**一条会拿明文地址出网的控制面路径：不解密就发不出去。
   * 回包只有「成没成」，**绝不**把地址带出去。
   */
  testNotify(): Promise<{ ok: true; sentAt: number }>;
  /** 策略总览。`symbol` 为 null 时 `resolved` 用全局默认推算。 */
  getRiskPolicy(symbol: string | null): Promise<RiskPolicyViewDto>;
  writeRiskPolicy(body: RiskPolicyWriteBody): Promise<RiskPolicyEntryDto>;
  deleteRiskPolicy(input: { scope: RiskPolicyScopeDto; symbol: string }): Promise<{ ok: true }>;
  estimate(symbol: string): Promise<SymbolDetailDto['estimate']>;
  startJob(input: { kind: JobKind; symbol: string; target?: number | undefined }): Promise<JobDto>;
  listJobs(): Promise<JobDto[]>;
  getJob(id: string): Promise<JobDto | null>;
}

const LIFECYCLE: readonly LifecycleAction[] = ['start', 'pause', 'resume'];

/**
 * 写操作的来源校验（v0.5.0）。控制面无鉴权且局域网可达，
 * 挡掉「别的网页借用户的浏览器改我们的密钥」这条路。
 */
function assertSameOrigin(c: {
  req: { method: string; url: string; header(name: string): string | undefined };
}): void {
  // 比对用的是**请求自身的完整 URL**，不是 Host 头：Host 可以被伪造，
  // 而 URL 是服务端根据真实连接解析出来的。
  const check = checkOrigin(c.req.method, c.req.header('origin'), c.req.url);
  if (!check.ok) {
    throw new SyncError('CONFIG_INVALID', check.reason ?? '拒绝非同源写请求', {
      code: 'CROSS_SITE',
    });
  }
}

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
   * 止盈止损记录（v0.4.0）：最近 N 条，倒序，**纯读本地库**。
   *
   * 不下单、不改状态、不出网，因此可以挂在页面的刷新节奏上。库里没有记录时返回
   * `items: []`（200），不是 404——「这个标的还没成交过」是完全正常的状态，
   * 页面要如实显示空状态而不是报错。
   *
   * 回包带上**实际生效**的 `limit` 与全量 `countsByState`：后者统计的是**全部**记录，
   * 不受 limit 影响，所以「列表里看不到但确实有 failed」的情况仍能被发现。
   */
  app.get('/api/symbols/:symbol/brackets', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    const limit = Math.min(
      parseBarLimit(c.req.query('limit'), DEFAULT_BRACKET_LIMIT),
      MAX_BRACKET_LIMIT,
    );
    return c.json(await deps.listBrackets(symbol, { limit }));
  });

  /**
   * 交易对账（v0.6.0）：**手动触发**的只读快照。
   *
   * 与 `/bars` 的关键差别：`/bars` 只打 PG，所以能挂在 5s 刷新节奏上；这条要走交易所
   * 私有接口（签名 + 消耗请求权重 + 出网），因此**绝不自动刷新**——页面只在用户点按钮
   * 时调一次，并在界面上写明「这是一次性快照」。
   *
   * `symbol` **必填**：不带标的的 `GET /fapi/v1/openAlgoOrders` 权重是 **40**（带标的
   * 只要 1）。一个能被反复连点的接口不该默认按 40 计价，因此全账户对账走 CLI。
   *
   * 一致返回 200 + `healthy: true`，**不是 404**：查出来「没问题」是完全正常的答案，
   * 与「这个路由不存在」必须分开。
   */
  /**
   * 最近一次**自动**对账快照，**全账户范围**。
   *
   * 自动对账按全账户跑（一次 positionRisk + 一次 openAlgoOrders 就够，逐标的反而更贵），
   * 因此这里也只有一份。单个标的的差异由**页面**按 symbol 过滤展示——
   * 过滤是视图行为，不是判据，判据仍只有 core 那一份。
   */
  app.get('/api/reconcile/latest', async (c) => {
    return c.json({ report: await deps.latestReconciliation() });
  });

  app.get('/api/symbols/:symbol/reconcile', async (c) => {
    const symbol = normalizeSymbol(c.req.param('symbol'));
    return c.json(await deps.reconcile(symbol));
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

  // ------------------------------------------------- 运行期设置（v0.5.0）
  //
  // 下面这些路由能改**真实下单**用的凭据与倍数，因此每个写操作都先过来源校验，
  // 并且不接受任何形式的读回明文。见 csrf.ts 与 types.ts 里 CredentialStatusDto 的说明。

  /**
   * 凭据状态。**只回「配没配」与末 4 位**，没有 secret 也没有密文——
   * 控制面从设计上就没有把密钥显示出来的能力。
   */
  app.get('/api/settings/credentials', async (c) => c.json(await deps.getCredentialStatus()));

  app.put('/api/settings/credentials', async (c) => {
    assertSameOrigin(c);
    const body = await bodyOf<CredentialWriteBody>(c);
    if (typeof body?.apiKey !== 'string' || typeof body?.apiSecret !== 'string') {
      throw new SyncError('CONFIG_INVALID', '缺少 apiKey 或 apiSecret');
    }
    if (body.apiKey.trim() === '' || body.apiSecret.trim() === '') {
      throw new SyncError('CONFIG_INVALID', 'apiKey 与 apiSecret 都不能为空');
    }
    // 提交上来的 secret 只流向这一行；回包走 `getCredentialStatus`，因此不可能回显。
    return c.json(await deps.writeCredentials({ apiKey: body.apiKey, apiSecret: body.apiSecret }));
  });

  app.delete('/api/settings/credentials', async (c) => {
    assertSameOrigin(c);
    return c.json(await deps.clearCredentials());
  });

  // ------------------------------------------------- 飞书通知设置（v0.8.0）

  /**
   * 通知设置状态。**没有明文地址**，只有「配没配 / 末 4 位 / 生效来源」。
   */
  app.get('/api/settings/notify', async (c) => c.json(await deps.getNotifyStatus()));

  app.put('/api/settings/notify', async (c) => {
    assertSameOrigin(c);
    const body = await bodyOf<NotifyWriteBody>(c);
    if (typeof body?.enabled !== 'boolean') {
      throw new SyncError('CONFIG_INVALID', '缺少 enabled（必须是布尔值）');
    }
    if (typeof body?.webhookUrl !== 'string') {
      throw new SyncError('CONFIG_INVALID', '缺少 webhookUrl（留空表示「保持原样」）');
    }
    if (body.secret !== undefined && typeof body.secret !== 'string') {
      throw new SyncError('CONFIG_INVALID', 'secret 必须是字符串');
    }
    if (!Array.isArray(body.kinds)) {
      throw new SyncError('CONFIG_INVALID', '缺少 kinds（要通知哪些内容）');
    }
    // 取值必须是已知的差异类型：页面只能从服务端下发的目录里勾。
    for (const kind of body.kinds) {
      if (typeof kind !== 'string' || !RECONCILE_KINDS.includes(kind as ReconcileKind)) {
        throw new SyncError('CONFIG_INVALID', `未知的通知内容：${String(kind)}`, { kind });
      }
    }
    if (!Number.isInteger(body.repeatCooldownMs) || body.repeatCooldownMs < 0) {
      throw new SyncError(
        'CONFIG_INVALID',
        `repeatCooldownMs 必须是不小于 0 的整数毫秒，收到：${String(body.repeatCooldownMs)}`,
      );
    }
    return c.json(await deps.writeNotifySettings(body));
  });

  app.delete('/api/settings/notify', async (c) => {
    assertSameOrigin(c);
    return c.json(await deps.clearNotifySettings());
  });

  /**
   * 发送一条测试消息。
   *
   * **出网**，因此要过来源校验；回包只有「成没成」。
   * 失败要如实报错（带上飞书返回的错误码），而不是回一句「已发送」——
   * 「看起来成功其实什么都没发」是这个仓库最忌讳的状态。
   */
  app.post('/api/settings/notify/test', async (c) => {
    assertSameOrigin(c);
    return c.json(await deps.testNotify());
  });

  /** 策略总览：全局默认 + 全部标的覆盖 + 该标的最终生效的那一套。 */
  app.get('/api/settings/risk-policy', async (c) => {
    const symbol = c.req.query('symbol');
    return c.json(await deps.getRiskPolicy(symbol === undefined ? null : symbol));
  });

  app.put('/api/settings/risk-policy', async (c) => {
    assertSameOrigin(c);
    const body = await bodyOf<RiskPolicyWriteBody>(c);
    if (body?.scope !== 'global' && body?.scope !== 'symbol') {
      throw new SyncError(
        'CONFIG_INVALID',
        `scope 必须是 global 或 symbol，收到：${String(body?.scope)}`,
      );
    }
    return c.json(await deps.writeRiskPolicy(body));
  });

  app.delete('/api/settings/risk-policy', async (c) => {
    assertSameOrigin(c);
    const scope = c.req.query('scope');
    if (scope !== 'global' && scope !== 'symbol') {
      throw new SyncError(
        'CONFIG_INVALID',
        `scope 必须是 global 或 symbol，收到：${String(scope)}`,
      );
    }
    return c.json(await deps.deleteRiskPolicy({ scope, symbol: c.req.query('symbol') ?? '' }));
  });

  return app;
}

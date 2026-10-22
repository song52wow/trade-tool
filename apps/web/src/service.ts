import {
  INTERVAL_MS,
  NOTIFY_KIND_INFO,
  NOTIFY_KINDS,
  SyncError,
  createNotifier,
  loadConfigOrDefault,
  parseSecretKey,
  percentToRatio,
  ratioToPercent,
  describeClockSkew,
  SECRET_KEY_ENV,
  STORED_INTERVALS,
  type GapRecord,
  type RemovePolicy,
  type SymbolEntry,
  type SymbolSyncState,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  aggregateSymbol,
  assertSchemaVersion,
  BinancePrivateClient,
  buildContext,
  createPool,
  estimateFirstPull,
  getAllStates,
  getGaps,
  getState,
  countBracketsByState,
  clearCredential,
  clearNotifySettings as clearNotifySettingsRow,
  listBrackets,
  listRiskPolicies,
  readCredentialStatus,
  readNotifyStatus,
  readNotifyTarget,
  recordReconciliation,
  resolvePolicy,
  writeCredential,
  writeNotifySettings as writeNotifySettingsRow,
  deleteRiskPolicy as deleteRiskPolicyRow,
  writeRiskPolicy as writeRiskPolicyRow,
  listExchangeSymbols,
  readDaemonHeartbeat,
  readDerivedIntervals,
  readLatestBars,
  readLatestReconciliation,
  readLatestAnalystReport,
  readLatestTradingPlan,
  readTradingPlanById,
  updateTradingPlanStatus,
  resolveActiveCredentials,
  resolveContract,
  runReconciliation,
  schemaStatus,
  syncSymbol,
  verifySymbol,
  type AnalystReportRow,
  type MarketContext,
  type Pool,
  type TradingPlanRow,
  exchangeEndpointsFromEnv,
} from '@trade-tool/data';
import { createSyncService, HEARTBEAT_INTERVAL_MS, type SyncService } from '@trade-tool/sync';

import { clampBarLimit, MAX_BRACKET_LIMIT } from './bars.js';
import { JobRegistry, type JobRunnerOptions } from './jobs.js';
import { mergeSymbolRows } from './rows.js';
import type { WebDeps } from './server.js';

/**
 * 主密钥探测。**两种状态都要能问**，而不是只有「有没有」：
 *   * `masterKeyStatus()` —— 页面用来提前显示「当前不能保存」，避免填完提交才失败；
 *   * `requireMasterKey()` —— 真正写入时拿密钥，缺了就抛错而不是拿空密钥硬加。
 *
 * 探测**只判断能不能解析**，不缓存密钥本身，也不把它写进任何日志。
 */
function masterKeyStatus(): { ok: boolean; reason?: string } {
  try {
    parseSecretKey(process.env[SECRET_KEY_ENV]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function requireMasterKey(): Buffer {
  return parseSecretKey(process.env[SECRET_KEY_ENV]);
}

/**
 * 主密钥的**可缺省**版本：只给交易对账用（v0.6.0）。
 *
 * 写凭据必须要有主密钥（`requireMasterKey`），但对账是只读的：主密钥没注入只意味着
 * 读不到库里加密存的那份，环境变量注入的仍可用。为此把对账整条封在「主密钥必须已
 * 配置」后面，是凭空加一道门槛。
 */
function masterKeyOrNull(): Buffer | null {
  const raw = process.env[SECRET_KEY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  return requireMasterKey();
}
import type {
  AgentReportDto,
  AgentViewDto,
  BarDto,
  BracketsDto,
  CredentialStatusDto,
  NotifyStatusDto,
  RiskPolicyEntryDto,
  RiskPolicyViewDto,
  TradingPlanDto,
  DaemonStatusDto,
  ReconcileReport,
  ExchangeListDto,
  OverviewDto,
  SymbolDetailDto,
  SymbolRowDto,
} from './types.js';

export interface WebRuntime extends WebDeps {
  /** schema 闸门：库与代码版本不一致时抛错，不让页面在旧结构上继续操作（R-1.3 / R-19.7）。 */
  assertSchema(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 用真实依赖装配控制面。
 *
 * 这里刻意**不**内嵌守护进程：R-19 要求状态先落库再生效、R-22.6 说跨进程协作不需要
 * 新通信机制，所以 `apps/sync` 作为独立进程继续跑；本应用只通过原语改意图，
 * 通过作业做一次性拉取。两者写同一张表时由单写者锁（R-3.3）挡住，作业侧再提前用
 * 409 拦一道，让用户看到可执行的提示而不是锁冲突堆栈。
 */
export function createWebRuntime(config: TradeToolConfig): WebRuntime {
  const pool: Pool = createPool(config.database);
  // 用底层 createSyncService 而非 createSyncServiceFromConfig：后者会再建一个连接池，
  // 于是同一进程两个池、各自 10 条连接上限（database.poolMax）。
  const ctx: MarketContext = buildContext(pool, config);
  const service: SyncService = createSyncService(ctx, { config });

  const states = async (): Promise<SymbolSyncState[]> => getAllStates(ctx);

  const entries = (): Promise<SymbolEntry[]> => service.primitives.listSymbols();

  const allRows = async () =>
    mergeSymbolRows({
      entries: await entries(),
      states: await states(),
      fallbackExchange: ctx.exchange,
    });

  const jobs = new JobRegistry({
    runFull: async (symbol) => ({ ...(await syncSymbol(ctx, symbol, {})) }),
    runVerify: async (symbol) => ({ ...(await verifySymbol(ctx, symbol)) }),
    // v0.2.0 R-7.6：重建派生表。走 --rebuild（先删后算），因为作业的用途就是
    // 「修复不一致」，而补齐对已被篡改的桶无效。
    runAggregate: async (symbol) => ({
      ...(await aggregateSymbol(ctx, symbol, {}, { rebuild: true })),
    }),
    readProgress: async (symbol) => {
      const state = await getState(ctx, symbol);
      return { rows: state?.rows ?? null, pendingGaps: state?.pendingGaps ?? null };
    },
    isDaemonOwned: async (symbol) => {
      const entry = (await entries()).find((e) => e.symbol === symbol);
      return entry?.desiredState === 'running';
    },
  } satisfies JobRunnerOptions);

  /**
   * 心跳超阈值的下限 60s。
   *
   * 上界跟着守护进程的**心跳间隔**（`HEARTBEAT_INTERVAL_MS`，10s）走，取 3 倍留出抖动
   * 余量——判超时用的是「心跳年龄」，节拍当然要按心跳，而不是按同步轮次的
   * `pollIntervalMs`（默认 15s；拿它去乘会把阈值算歪，且默认值下永远被 60s 下限盖住）。
   * 下限保证即便有人把心跳间隔调得极小，阈值也不会小到一次调度延迟就误报离线。
   */
  const daemonStaleMs = Math.max(60_000, HEARTBEAT_INTERVAL_MS * 3);

  const daemonStatus = async (now: number): Promise<DaemonStatusDto> => {
    const beat = await readDaemonHeartbeat(pool, ctx.exchange, daemonStaleMs, now);
    return { ...beat, staleAfterMs: daemonStaleMs };
  };

  return {
    // assertSchemaVersion 在版本不匹配时抛错；匹配时返回值对调用方没有意义。
    assertSchema: async () => {
      await assertSchemaVersion(pool);
    },

    async getOverview(): Promise<OverviewDto> {
      const now = Date.now();
      const [schema, summary, exchange, daemon] = await Promise.all([
        schemaStatus(pool),
        service.primitives.getSummary(),
        listExchangeSymbols(ctx),
        daemonStatus(now),
      ]);
      return {
        schema,
        summary,
        exchange: {
          exchange: exchange.exchange,
          count: exchange.count,
          cachedAt: exchange.cachedAt,
          ageMs: exchange.ageMs,
          stale: exchange.stale,
        },
        daemon,
        jobs: { active: jobs.activeCount(), recent: jobs.list().slice(0, 5) },
        now,
      };
    },

    async listSymbols(): Promise<SymbolRowDto[]> {
      return allRows();
    },

    async getSymbol(symbol): Promise<SymbolDetailDto | null> {
      const row = (await allRows()).find((r) => r.symbol === symbol) ?? null;
      if (row === null) return null;
      // 合约规格是快照：拿不到（缓存过期且出网失败）不该让整个详情页打不开，
      // 但必须显式是 null 让页面显示「未知」，不拿旧值假装有。
      const contract = await resolveContract(ctx, symbol).catch(() => null);
      // 派生统计（R-7.5 / AC-15）：让用户能回答「为什么没有 4h 蜡烛」。
      // 传**实际启用的周期集合**而不是布尔：R-9.1 允许只启用一个子集，没启用的周期
      // 必须如实返回 withheldReason='disabled'，而不是报 0 个桶（AC-22）。
      const derived = await readDerivedIntervals(pool, symbol, STORED_INTERVALS, {
        enabled: config.data.aggregateIntervals,
      });
      return { ...row, contract, gaps: await getGaps(ctx, symbol), estimate: null, derived };
    },

    async listExchangeSymbols(options): Promise<ExchangeListDto> {
      return listExchangeSymbols(ctx, options ?? {});
    },

    async addSymbol(symbol): Promise<SymbolRowDto> {
      await service.primitives.addSymbol(symbol);
      const row = (await allRows()).find((r) => r.symbol === symbol);
      if (row === undefined) throw new Error(`添加 ${symbol} 后仍读不到该标的，状态无法确定`);
      return row;
    },

    async removeSymbol(symbol, policy: RemovePolicy): Promise<void> {
      await service.primitives.removeSymbol(symbol, policy);
    },

    async lifecycle(symbol, action) {
      if (action === 'start') await service.primitives.start(symbol);
      else if (action === 'pause') await service.primitives.pause(symbol);
      else await service.primitives.resume(symbol);
      const row = (await allRows()).find((r) => r.symbol === symbol);
      if (row === undefined) {
        throw new Error(`生命周期变更后 ${symbol} 读不到，状态无法确定`);
      }
      return row;
    },

    async listGaps(symbol): Promise<GapRecord[]> {
      return getGaps(ctx, symbol);
    },

    /**
     * 最近 N 根 K 线（R-23 / R-7.1），按所选周期。
     *
     * 只读本地表，不出网也不写库——所以它能挂在页面的刷新节奏上，代价只是一次走主键的
     * 倒序 LIMIT。这里再夹一次上限：路由已经夹过，但 `WebRuntime` 也会被直接调用
     * （测试、将来的其它前端），上限不能只长在 HTTP 那一层。
     *
     * `quote_volume` / `trades` 读出来但不进 DTO：图上用不到，白白撑大每次响应。
     */
    async listBars(symbol, options): Promise<BarDto[]> {
      const limit = clampBarLimit(options?.limit);
      const bars = await readLatestBars(pool, symbol, { limit, interval: options?.interval });
      return bars.map(({ time, open, high, low, close, volume }) => ({
        time,
        open,
        high,
        low,
        close,
        volume,
      }));
    },

    /**
     * 止盈止损记录（v0.4.0）：最近 N 条 + **全量**五态计数。
     *
     * 纯读：只打 PG，不下单、不改状态、不出网，因此能挂在页面的 5s 刷新节奏上。
     *
     * 计数单独查而不是从截断后的 `items` 里数：控制面只回最近 N 条，而 `failed`
     * 通常是最老的记录——用截断过的列表反推，会让「有保护单没挂上」显示成一切正常
     * （v0.4.0 规则 3 / 5）。
     */
    async listBrackets(symbol, options): Promise<BracketsDto> {
      const limit = Math.min(clampBarLimit(options?.limit), MAX_BRACKET_LIMIT);
      const [items, countsByState] = await Promise.all([
        listBrackets(pool, ctx.exchange, symbol, limit),
        countBracketsByState(pool, ctx.exchange, symbol),
      ]);
      return { symbol, limit, items, countsByState };
    },

    // 预估要出网读元数据但**不写库**（R-8.3），所以由确认弹窗按需单独触发。
    estimate: (symbol) => estimateFirstPull(ctx, symbol),

    /**
     * 分析师报告与执行方案（v1.0.0）：**只读**本地表。
     *
     * 纯读：只打 PG，不调模型、不出网、不下单，因此能挂在页面的 5s 刷新节奏上。
     *
     * 报告与方案**分别**取「最近一条」：方案可能来自上一份报告（这一轮分析师失败时，
     * 只会写一条 `action = 'failed'` 的方案而没有新报告）。因此页面上要能同时看到
     * 「最新报告」与「最新方案」，而不是把它们捆在一起——捆在一起会让人以为
     * 那份方案就是基于那份报告做的。
     */
    async listAgentView(symbol): Promise<AgentViewDto> {
      const [report, plan] = await Promise.all([
        readLatestAnalystReport(pool, ctx.exchange, symbol),
        readLatestTradingPlan(pool, ctx.exchange, symbol),
      ]);
      return {
        symbol,
        report: report === null ? null : toAgentReportDto(report),
        plan: plan === null ? null : toTradingPlanDto(plan),
      };
    },

    /**
     * 批准 / 驳回一份执行方案（v1.0.0 自动下单）。
     *
     * ⚠️ **批准本身不下单**。真正的下单由 `apps/executor` 消费 `approved` 的方案完成，
     * 而 executor 只在 `agent.execute.enabled` 开着时才消费。因此：
     *
     * - 开关**关着**时：批准只是把方案标成 `approved`（为将来打开开关做准备），
     *   executor 压根不看它——**不会有单下出去**；
     * - 开关**打开**时：Agent 产出的方案本来就直接进 `approved`，
     *   executor 会消费它。这一条路由留给「上一轮开关是关着的」那种情况。
     *
     * 页面必须把这两件事说清楚，否则用户会以为「点了批准 = 立刻开仓」。
     */
    async setTradingPlanStatus(symbol, planId, status): Promise<TradingPlanDto> {
      if (status !== 'approved' && status !== 'rejected') {
        throw new SyncError('CONFIG_INVALID', `不允许把方案状态改成 ${status}`, { status });
      }
      const plan = await readTradingPlanById(pool, ctx.exchange, symbol, planId);
      if (plan === null) {
        throw new SyncError('DB_UNIQUE_VIOLATION', `方案 ${planId} 不存在`, { planId });
      }
      if (status === 'approved') {
        // 只批准**真能执行**的方案。
        //
        // 批准一份「这一轮不做」或「出不了方案」的记录没有意义——它没有进场可执行，
        // 而执行器每轮都会把它捞出来又跳过。与其让用户以为自己批了个会执行的方案，
        // 不如在这里就说清楚。
        if (plan.action !== 'enter') {
          throw new SyncError(
            'CONFIG_INVALID',
            `方案 ${planId} 是「${plan.action === 'hold' ? '这一轮不做' : '出不了方案'}」，` +
              '没有可执行的进场，不能批准',
            { planId, action: plan.action },
          );
        }
        // 限价进场**暂不支持自动执行**（挂着的限价单可能永远不成交，
        // 而不成交的仓位没有止损保护）。在这里就拒绝，
        // 免得用户批了一份注定执行不了的方案。
        if (plan.entryType === 'limit') {
          throw new SyncError(
            'CONFIG_INVALID',
            '限价进场暂不支持自动执行（只支持市价进场）：限价单可能永远不成交，' +
              '而挂着不成交的仓位没有止损保护。请改用市价进场，或在交易所手动下单。',
            { planId, entryType: plan.entryType },
          );
        }
      }
      await updateTradingPlanStatus(pool, planId, status);
      const updated = await readTradingPlanById(pool, ctx.exchange, symbol, planId);
      if (updated === null) {
        throw new SyncError('DB_UNIQUE_VIOLATION', `方案 ${planId} 读不到了`, { planId });
      }
      return toTradingPlanDto(updated);
    },

    /**
     * 交易对账（v0.6.0）：**只读**地比对交易所与本地，绝不下单/撤单/写库。
     *
     * 需要明文凭据来签名私有接口（AGENTS.md 约定 2 的同一原则：密钥只经环境变量与
     * `X-MBX-APIKEY` 出现，不进 argv、不打日志）。这里**不回传任何密钥字段**——
     * `WebDeps` 的签名里就没有能带出明文的位置，报告里只有 algoId 与价格。
     *
     * 主密钥缺失不算致命：这只意味着读不到控制面里加密存的那份凭据，环境变量注入的
     * 仍可用；两条都拿不到时 `resolveActiveCredentials` 抛错并说清缺哪个变量。
     */
    /**
     * 最近一次**自动**对账的结果（v0.6.0 由 executor 周期写入）。
     *
     * 面板默认展示这个而不是让用户点一下才算数：自动对账才是常态，手动按钮只是
     * 「我现在就想看一眼」的补充。从没跑过时返回 `null` ——「还没对过账」与
     * 「对过了、一致」在界面上必须能分开说。
     */
    async latestReconciliation(): Promise<ReconcileReport | null> {
      // 空串 = 全账户范围，与 executor 自动对账的范围一致。
      return readLatestReconciliation(pool, ctx.exchange, '');
    },

    async reconcile(symbol: string): Promise<ReconcileReport> {
      const credentials = await resolveActiveCredentials({
        pool,
        masterKey: masterKeyOrNull(),
        exchange: ctx.exchange,
        apiKeyEnv: config.executor.apiKeyEnv,
        apiSecretEnv: config.executor.apiSecretEnv,
      });
      const client = new BinancePrivateClient({
        credentials,
        ...exchangeEndpointsFromEnv(config.executor),
      });
      // 手动对账同样要校时钟：不然这里的每个签名请求都 -1021，
      // 而「查失败」与「查出差异」在界面上必须能分开说（AGENTS.md §6.5）。
      const skew = await client.measureClockSkew();
      console.error(`[web] 手动对账前校时：${describeClockSkew(skew)}`);
      const report = await runReconciliation({
        pool,
        client,
        exchange: ctx.exchange,
        symbol,
      });
      // 手动这一轮也落快照：否则界面会继续显示**上一次自动**的结果，
      // 而用户刚刚点的按钮看起来像什么都没发生。
      await recordReconciliation(pool, report, Date.now());
      return report;
    },

    /**
     * 凭据状态。**主密钥缺失时如实说 `masterKeyReady: false`**：
     * 页面必须能提前显示「当前不能保存」，而不是让人填完提交才失败。
     */
    async getCredentialStatus(): Promise<CredentialStatusDto> {
      const status = await readCredentialStatus(pool, ctx.exchange);
      return { ...status, masterKeyReady: masterKeyStatus().ok };
    },

    async writeCredentials(input): Promise<CredentialStatusDto> {
      const key = requireMasterKey();
      const status = await writeCredential(pool, key, {
        exchange: ctx.exchange,
        apiKey: input.apiKey,
        apiSecret: input.apiSecret,
        now: Date.now(),
      });
      // 回包永远走状态形状：写完之后**没有任何字段**能把明文带出去。
      return { ...status, masterKeyReady: true };
    },

    async clearCredentials(): Promise<CredentialStatusDto> {
      await clearCredential(pool, ctx.exchange, Date.now());
      return this.getCredentialStatus();
    },

    /**
     * 通知设置状态（v0.8.0）。**只回状态**，没有明文地址。
     *
     * 主密钥缺失时如实说 `masterKeyReady: false`：面板那一档存的是密文，
     * 没有主密钥就既存不进去、也读不出来——页面必须能提前显示「当前不能保存」，
     * 而不是让人填完提交才失败。
     */
    async getNotifyStatus(): Promise<NotifyStatusDto> {
      const status = await readNotifyStatus({
        pool,
        masterKey: masterKeyOrNull(),
        config: config.notify,
      });
      return {
        ...status,
        // 可勾选的内容目录：**由 core 的那一份派生**，页面不自己抄。
        topics: NOTIFY_KINDS.map((kind) => ({ kind, ...NOTIFY_KIND_INFO[kind] })),
        masterKeyReady: masterKeyStatus().ok,
      };
    },

    async writeNotifySettings(body): Promise<NotifyStatusDto> {
      const key = requireMasterKey();
      // 当前生效的地址：面板那一档或环境变量那一档。「留空 = 保持原样」在两种
      // 来源下都成立，用户不必把环境变量里的地址抄一遍才能保存开关与参数。
      const { target } = await readNotifyTarget({
        pool,
        masterKey: masterKeyOrNull(),
        config: config.notify,
      });
      await writeNotifySettingsRow(
        pool,
        key,
        {
          enabled: body.enabled,
          webhookUrl: body.webhookUrl,
          secret: body.secret,
          clearSecret: body.clearSecret === true,
          kinds: body.kinds,
          repeatCooldownMs: body.repeatCooldownMs,
          now: Date.now(),
        },
        target,
      );
      // 写完重新读一遍状态：回包里的「生效来源」必须是从库里读出来的事实，
      // 而不是「我们刚写了什么」的自我复述。
      return this.getNotifyStatus();
    },

    async clearNotifySettings(): Promise<NotifyStatusDto> {
      await clearNotifySettingsRow(pool, Date.now());
      return this.getNotifyStatus();
    },

    /**
     * 发送一条测试消息。
     *
     * 这是**唯一**一条会拿明文地址出网的控制面路径：不解密就发不出去。
     * 明文只活在这一个函数里，**不进回包**——回包只有「成没成」。
     *
     * 失败如实抛错（带上飞书的错误码），不假装成功。
     */
    async testNotify(): Promise<{ ok: true; sentAt: number }> {
      const { target, source } = await readNotifyTarget({
        pool,
        masterKey: masterKeyOrNull(),
        config: config.notify,
      });
      if (target === null) {
        // 「读不到」与「没有」是两回事：控制面录入过、但主密钥没注入时，
        // 提示应该说清缺的是主密钥，而不是让人以为地址没填。
        const status = await readNotifyStatus({
          pool,
          masterKey: masterKeyOrNull(),
          config: config.notify,
        });
        if (status.panel?.configured === true) {
          throw new SyncError(
            'CONFIG_INVALID',
            '控制面录入的地址读不出来：主密钥环境变量 ' +
              `${SECRET_KEY_ENV} 没有注入或长度不合法。` +
              '请先在 .env 里配好主密钥并重启控制面。',
            { source },
          );
        }
        throw new SyncError(
          'CONFIG_INVALID',
          '还没有可用的 webhook 地址，无法发送测试消息。' +
            '请在本页填入地址并保存，或在环境变量里配置。',
          { source },
        );
      }
      const notifier = createNotifier({ webhookUrl: target.webhookUrl, secret: target.secret });
      await notifier.notify({
        title: '这是一条测试消息',
        severity: 'info',
        lines: [
          '如果你在飞书群里看到了这条消息，说明通道是通的。',
          '之后对账发现差异（尤其是「仓位当前没有止损保护」）就会推到这里。',
        ],
      });
      return { ok: true, sentAt: Date.now() };
    },

    async getRiskPolicy(symbol): Promise<RiskPolicyViewDto> {
      const entries = await listRiskPolicies(pool, ctx.exchange);
      const global = entries.find((e) => e.scope === 'global') ?? null;
      const overrides = entries.filter((e) => e.scope === 'symbol');
      const resolved =
        symbol === null
          ? await resolvePolicy(pool, ctx.exchange, '', config.executor)
          : await resolvePolicy(pool, ctx.exchange, symbol, config.executor);
      // 库里存的是 [0, 1]，对外一律给**百分数**：浏览器端不引 core（它带 node
      // 内置模块，打包进 UI 会炸），于是换算只能在这侧做——而换算本身仍然只有
      // core 里的那一份实现，浏览器端一行算术都不写。
      return {
        exchange: ctx.exchange,
        global: global === null ? null : toPolicyDto(global),
        overrides: overrides.map(toPolicyDto),
        resolved: { ...toPolicyDto(resolved), source: resolved.source },
      };
    },

    async writeRiskPolicy(body): Promise<RiskPolicyEntryDto> {
      const saved = await writeRiskPolicyRow(pool, {
        scope: body.scope,
        exchange: ctx.exchange,
        symbol: body.symbol ?? '',
        atrPeriod: body.atrPeriod,
        atrInterval: body.atrInterval,
        stopAtrMult: body.stopAtrMult,
        takeProfitAtrMult: body.takeProfitAtrMult,
        takeProfit1Ratio: percentToRatio(body.takeProfit1Percent),
        trailAtrMult: body.trailAtrMult,
        breakevenAfterTp1: body.breakevenAfterTp1,
        now: Date.now(),
      });
      return toPolicyDto(saved);
    },

    async deleteRiskPolicy(input): Promise<{ ok: true }> {
      await deleteRiskPolicyRow(pool, input.scope, ctx.exchange, input.symbol);
      return { ok: true };
    },

    startJob: (input) => jobs.start(input),
    listJobs: async () => jobs.list(),
    getJob: async (id) => jobs.get(id),

    async close(): Promise<void> {
      await service.close();
      await pool.end().catch(() => undefined);
    },
  };
}

export { loadConfigOrDefault };

/**
 * 库里的策略行 → 对外的 DTO：比例换算成百分数。
 *
 * 只有这一处做换算（`ratioToPercent` 在 core 里也只有一份实现）。
 * 页面拿到的永远是 `0`–`100`，因此页面上不会出现「存 0.8、显示 0.8、以为是 0.8%」
 * 这种只在某一层发生的换算漂移。
 */
function toPolicyDto(row: {
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  takeProfitAtrMult: number;
  takeProfit1Ratio: number;
  trailAtrMult: number;
  breakevenAfterTp1: boolean;
  scope?: 'global' | 'symbol';
  exchange?: string;
  symbol?: string;
  updatedAt?: number;
}): RiskPolicyEntryDto {
  return {
    atrPeriod: row.atrPeriod,
    atrInterval: row.atrInterval,
    stopAtrMult: row.stopAtrMult,
    takeProfitAtrMult: row.takeProfitAtrMult,
    takeProfit1Percent: ratioToPercent(row.takeProfit1Ratio),
    trailAtrMult: row.trailAtrMult,
    breakevenAfterTp1: row.breakevenAfterTp1,
    scope: row.scope ?? 'global',
    exchange: row.exchange ?? '',
    symbol: row.symbol ?? '',
    updatedAt: row.updatedAt ?? 0,
  };
}

// ------------------------------------------- Agent 报告与方案的 DTO 转换（v1.0.0）

/**
 * 数据库行 → 页面用的报告。
 *
 * **只搬运，不加工**：分数、立场、信心都是 core 的纯函数算出来的，这里原样透出。
 * 加工（例如把分数映射成颜色）属于展示层的事，那是页面的活。
 */
function toAgentReportDto(row: AnalystReportRow): AgentReportDto {
  return {
    id: row.id,
    symbol: row.symbol,
    interval: row.interval,
    asOfMs: row.asOfMs,
    createdAtMs: row.createdAtMs,
    stance: row.stance,
    confidence: row.confidence,
    bias: row.bias,
    agreement: row.agreement,
    technical: { score: row.technical.score, notes: row.technical.notes },
    sentiment: { score: row.sentiment.score, notes: row.sentiment.notes },
    fundamental: { score: row.fundamental.score, notes: row.fundamental.notes },
    atr: row.atr,
    lastClose: row.lastClose,
    rationale: row.rationale,
    degraded: row.degraded,
  };
}

/** 数据库行 → 页面用的方案。 */
function toTradingPlanDto(row: TradingPlanRow): TradingPlanDto {
  return {
    id: row.id,
    symbol: row.symbol,
    reportId: row.reportId,
    createdAtMs: row.createdAtMs,
    action: row.action,
    status: row.status,
    side: row.side,
    entryType: row.entryType,
    entryPrice: row.entryPrice,
    stopPrice: row.stopPrice,
    takeProfitPrice: row.takeProfitPrice,
    quantity: row.quantity,
    notional: row.notional,
    riskAmount: row.riskAmount,
    equity: row.equity,
    equitySource: row.equitySource,
    riskFraction: row.riskFraction,
    riskReward: row.riskReward,
    stance: row.stance,
    confidence: row.confidence,
    rationale: row.rationale,
    adjustments: row.adjustments,
    failureReason: row.failureReason,
    entryOrderId: row.entryOrderId,
    executionFailureReason: row.executionFailureReason,
  };
}

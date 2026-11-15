# @trade-tool/data

行情数据层，**TS ↔ Python 唯一的运行时交界**，也是本次 v0.1.0 的**跨语言契约中枢**。

## 构成

- `db/sql-files.ts` — 定位并加载 `sql/*.sql` 迁移文件。**迁移文件是 schema 的唯一来源**，
  两侧都不得另持影子定义。
- `db/migrate.ts` — 版本化迁移：`migrate`（幂等）、`schemaStatus`（只读比对）、
  `assertSchemaVersion`（启动闸门，版本不匹配**必须报错**而不是按旧 schema 继续跑）。
  ⚠️ **写迁移时的一条硬规则**（2026-10-21 实测踩到）：PostgreSQL 的 `DROP COLUMN` 会**自动删掉
  引用该列的 CHECK 约束**，而且**一声不响**——迁移跑完、版本对得上，守门人却已经没了
  （迁移 `014` 退役 `decision_take_profit1_atr_mult` 时顺带删掉了
  `risk_bracket_decision_llm_params_check`，补在 `015` 里）。**退役任何一列之前，
  先查一遍 `pg_constraint` 里有没有约束提到它**，被顺带删掉的要用新迁移补回来。
- `db/pool.ts` — PG 连接池与连接串。密码**只从环境变量读**（`database.passwordEnv`），
  配置文件里只存变量名。`buildDsn` 产出给 Python 用的 libpq 连接串。
- `db/errors.ts` — PG 错误分类（R-21.6）：连接失败 / 唯一冲突 / 事务回滚 / 死锁，
  每类的重试策略不同。
- `db/repo.ts` — 查询层。水位的**权威来源是 `max(time)`**，`sync_state.watermark` 只是
  可观测缓存，二者不一致时报 `WATERMARK_MISMATCH` 而不是二选一。首次全量的规模预估
  （迁移 `002_sync_plan` 的 `plan_*` 列）也在这里读写，供 `sync status` 暴露进度分母。
  `removeSymbolEntry(policy='delete')` 会取与 Python 侧 `SymbolLock` **同一个键**的
  advisory lock——删除是 TS 侧唯一写 `klines_1m` 的路径，不能与在跑的一轮同步交错。
- `db/notify.ts` — 飞书通知通道的运行期设置（v0.8.0，迁移 `011_notify_settings`）。
  地址与签名密钥**密文**落库；`resolveAll()` 是「**哪一份在生效**」的唯一实现
  （控制面录入优先，配置文件 + 环境变量兜底），面板状态、executor 的生效设置、
  测试发送用的地址都从它派生。
- `db/agent.ts` — 分析师报告与执行方案的读写（v1.0.0，迁移 `017_agent_decisions`）。
  `recordAnalystReport` 按 `(exchange, symbol, as_of_ms)` **幂等 upsert**
  （同一份数据时刻的同一标的只留一份报告）；`recordTradingPlan` / `updateTradingPlanStatus`
  管 `advisory → approved / rejected / expired` 这条状态机。
  ⚠️ **`executed` 不由 `updateTradingPlanStatus` 写**：它只能由执行器在**真的下过单之后**
  写（`markTradingPlanExecuted`），且必须同时写下单号与时刻。让控制面也能置 `executed` 的话，
  页面上点一下就能造出一条「已下单」的假记录。
  另有 `claimTradingPlan`（`approved → executing` 的**幂等锚点**，带乐观锁）、
  `markTradingPlanExecutionFailed`（失败必须带原因）、`listApprovedTradingPlans` /
  `listExecutingTradingPlans`。
  表上的**表级** CHECK 约束各自守一条不变式（`enter` 三件套齐全、止损止盈分居两侧、
  `hold` 不许带原因、`action='failed'` 必须带原因、`executed` 只能来自 `enter`）。
  ⚠️ **「失败」有两个，守门人也得有两个**：`action='failed'`（这一轮出不了方案，说清
  `failure_reason`）与 `status='failed'`（这一笔没下出去，说清 `execution_failure_reason`）
  各自的约束**必须并存**——写成同名的话，后一条的 `DROP CONSTRAINT` 会**顺带删掉**前一条
  （AGENTS.md §5 第 12 条）。
- `db/llm-settings.ts` — 模型接入的运行期设置（v1.0.0，迁移 `019_agent_llm_settings`）。
  地址 / 模型 / 超时明文存，API 密钥**密文**落库。`resolveAll()` 是「**哪一份在生效**」
  的唯一实现（控制面录入优先，配置文件 + 环境变量兜底），与 `db/notify.ts` 同一套形状。
  ⚠️ **判据不看 `enabled`**：`enabled` 是那一档内部的开关，混进优先级会出现
  「我在控制面关了模型，Agent 还在调模型」。
  `readAgentLlmStatus()` 给控制面，**不含明文**；`resolveAgentLlmSettings()` 给 agent 进程，
  含明文。
- `sql/020_agent_prompt_notify.sql` — 「要通知哪些内容」多**两种**：「Agent 提示词」
  与「止盈止损档位提示词」（`notify_settings.kinds` 扩枚举）。
  ⚠️ **扩枚举**：旧值一个不少、约束名也不改
  （AGENTS.md §5 第 12 条），而且**新插入的行默认不勾**它们——提示词带着行情与账户权益，
  默认就发等于「装了包就把仓位信息交给第三方群」。迁移也**不动**已经配好的那一份：
  要发得用户自己在控制面勾上。
- `sql/022_sync_notify.sql` — 「要通知哪些内容」多**两种**：「标的同步失败」
  与「同步停摆」（`notify_settings.kinds` 扩枚举）。
  ⚠️ **扩枚举**：旧值一个不少、约束名也不改（AGENTS.md §5 第 12 条）。
  与 `020` 相反，这两种是**默认勾上**的——同步器此前一个通知出口都没有，
  标的被钉死、整个同步停摆都只写日志，目标机上实测静默过一次 5 小时 55 分。
  因此列默认值与**存量行都补勾**（照 `016` / `018` 的做法）：
  不补勾的话，升级之后这两条推送会**一声不吭地不发生**。
- `sql/023_trend_decision_source.sql` — 决策来源多一个 `llm-trend`
  （`risk_bracket.decision_source` 扩枚举）：v1.1.0 的趋势档位决策里，模型看到的是
  **完整趋势上下文**而不是只有收益率数列，两种来源**必须能分开查**——
  「模型当时看到了什么」正是事后复盘要回答的第一个问题。
  ⚠️ **扩枚举**：旧值一个不少、约束名也不改（AGENTS.md §5 第 12 条）。
  同一次迁移把「LLM 决策的数必须齐全」那条联合约束**同时管住两种模型来源**。
- `db/executor-status.ts` — 止盈止损服务（executor）自己的状态行（2026-11-06，迁移
  `024_executor_status`）。**「进程活着」与「服务能用」分成两组列**：
  `last_beat` 由独立于业务动作的定时器刷新（私有接口全挂时心跳照跳），
  `private_api_ok` / `last_private_ok_at` / `last_error_code` / `last_error_message`
  记的是**最近一次私有接口调用的结果**。合成一个「在线」就是骗人——2026-10-31 到
  11-06 那 6 天静默，页面显示的就是一个会骗人的界面。
  读侧 `readExecutorStatus()` 判三态（`running` / `stale` / `stopped`），
  与 `daemon_heartbeat` 同一套语义：**行不存在 = 确切地「没在跑」**。
- `sql/024_executor_status.sql` — `executor_status`（单行表，按 exchange 一行）。
- `sql/025_executor_notify.sql` — 「要通知哪些内容」多**一种**：「止盈止损服务不可用」
  （`notify_settings.kinds` 扩枚举）。
  ⚠️ **扩枚举**：旧值一个不少、约束名也不改（AGENTS.md §5 第 12 条）。
  与 `020` 相反，这一种是**默认勾上**的：私有接口一挂，executor 既挂不出单、
  也跑不出对账——**连告警的原料都没有**，不补勾就等于默认不发。
  因此列默认值与**存量行都补勾**（照 `016` / `018` / `022` 的做法）。
- `bsc-v3.ts` — 链上（BSC）**只读**访问（v1.2.0）：纯 TS 的 keccak256、JSON-RPC 客户端
  与 PancakeSwap V3 仓位的链上事实。
  ⚠️ **keccak 自己实现的理由**：Node 的 `crypto` 只有 **NIST 的 sha3-256**，
  填充规则与 Ethereum 用的原始 Keccak 不同，算出来的函数选择器全错，
  而且**错得很安静**（调用返回空数据，不报错）。
  ⚠️ **判据只能是公开常量**：2026-11-11 实测踩到 ρ/π 步骤的两个下标写反，
  哈希照样能算出一串 32 字节、不报任何错，但选择器全错
  （`positions(uint256)` 算成 `0xeb778fda`，正确的是 `0x99fbab88`）。
  判据见 `tests/bsc-v3.test.ts`（keccak256("") / keccak256("abc") 的标准值）。
  链上事实**互相校验**：仓位管理器的 `positions(uint256)` 与池子的 `positions(bytes32)`
  两处流动性对不上就抛错；池子查不到（key 算错）也抛错——**不能当成「仓位没了」**。
- `db/chain-position.ts` — 链上仓位的登记 / 采样 / 告警记录（v1.2.0，迁移
  `026_chain_position`）。金额列用 `numeric`（18 位小数的代币数量是 1e18 量级，
  `double precision` 装不下），价格与盈亏用 `double precision`。
  ⚠️ **「上一轮的流动性」与「这一轮的」是两件事**：前者是滚动状态列 `last_liquidity`，
  后者在采样表里。2026-11-11 实测踩过：列表查询写成 `s.liquidity AS last_liquidity`
  **撞上了表里同名的列**，后出现的把前一个盖掉 → 「上一轮的值」永远是「这一轮的值」，
  **加减仓与清空都检测不出来**，而且一声不响。两个数必须能同时读出来。
- `sql/026_chain_position.sql` — 链上仓位的三张表：`chain_position`（配置 + 滚动状态）、
  `chain_position_snapshot`（每次采样）、`chain_position_alert`（推过什么、推没推出去）。
- `sql/027_chain_notify.sql` — 「要通知哪些内容」多**一种**：「链上仓位异动」
  （`notify_settings.kinds` 扩枚举）。
  ⚠️ **扩枚举**：旧值一个不少、约束名也不改（AGENTS.md §5 第 12 条）。
  列默认值与**存量行都补勾**（照 `016` / `018` / `022` / `025` 的做法）：
  控制面存的是**一份勾选清单**，新增种类时清单不会自动多出这一项，
  不补勾的话监控会「判定该推、通道按没勾静默跳过」——一条也发不出去。
  ⚠️ 两种提示词镜像**不补**：它们默认不勾（带着行情与账户权益）。
- `market.ts` — 控制面唯一需要认识的东西：调 Python 干活 + 查 PG 看状态，收敛成结构化输入输出。
  `loadAgentContext()` 是 v1.0.0 的入口：调 Python 的 `market-context` 子命令，
  再读库内 `contract_spec` 快照，拼成 `ContractFacts` 交给 core 的
  `buildAnalystContext` 做纯映射。
- `binance-private.ts` — 私有 REST（签名、查仓、挂撤条件单）与**用户数据流**。
  `isPrivateApiUnusableError()` 判定「这个错误是不是意味着**整条私有接口**不可用」
  （鉴权被拒 `-2015`、key 坏了 `-2014`、时钟越界 `-1021`、签名不对 `-1022`、
  以及连都连不上的网络错误），与**业务失败**（余额不足 `-2019`、参数非法 `-1100`）
  严格分开：后者是这一笔的问题，接口本身好得很。判据只有这一份实现，
  用它的是 `apps/executor/src/health.ts`（「止盈止损服务不可用」那条告警）。
  ⚠️ **用户数据流的重连纪律在这里**（AGENTS.md §6.3.1 规则 7）：Node 的 `WebSocket`
  在代理掐断隧道时可能**只派发 `error`、不派发 `close`**，重连若只挂在 `onClose` 上，
  那个 `await` 就永远不返回——进程活着、日志干净，但一个成交事件都收不到，
  新开的仓从此裸奔（2026-10-26 实测：裸仓持续 24 小时）。
  所以**连接级失败（`error`、keepalive 失败）一律关掉 socket 并回调 `onClose`**，
  由调用方统一重连；单条**消息**处理失败则不拆连接。`onClose` 只通知一次。
  错误信息必须显式取 `ErrorEvent` 的 `message` / `error.message`——
  `JSON.stringify(event)` 得到的是 `{}`，断因全丢。
  判据只有这一份实现，用例在 `tests/user-data-stream.test.ts`。
- `bridge.ts` — `python -m quant_data` 子进程调用。**只传控制信息**，不传数据。
- `provider.ts` / `cache.ts` — 既有离线合成链路（`source: 'synthetic'`），行为未变。

## 写边界

`repo.ts` 只做读，以及标的集合这类控制面元数据的写。
**K 线、缺口水位、`sync_state` 的推进全部在 Python 侧的事务里完成**——
这是「批量写入与状态推进必须同事务」（R-19.5）唯一能成立的地方，因为 `COPY` 只发生在 Python 进程内。

## 跨语言约定

1. Python 模块通过 `-m` 启动，因此 `src/quant_x/__main__.py` 必须存在。
2. 成功：退出码 0，stdout = 单个 JSON 文档（结果摘要），日志走 stderr。
3. 失败：退出码非 0，stderr **最后一行**为 `QUANT_DATA_ERROR {"code":…,"message":…,"details":…}`，
   错误码与 `@trade-tool/core` 的 `SyncErrorCode` 一一对应。
4. PG 连接串经 `TRADE_TOOL_PG_DSN` 环境变量注入，不进 argv。
5. 交易所 base URL 可用 `TRADE_TOOL_BINANCE_BASE_URL` 覆盖，测试据此指向本地假交易所。
6. 时间统一 epoch 毫秒；库内列一律 `bigint`。
7. 跨语言调用都允许失败，上层按「抛错 + 明确错误信息」处理，不做静默兜底。

## 测试

```bash
pnpm --filter @trade-tool/data test
```

需要一个可重复的 PostgreSQL（默认 `127.0.0.1:5432/trade_tool`）。每个用例跑在随机命名的
独立 schema 上，从空库执行迁移，结束时整段 `DROP SCHEMA … CASCADE`——**不会碰到任何业务表**。
`sync-integration.test.ts` 会拉起一个本地假交易所，让**真实的 Python 引擎**跑完整接缝，
全程不访问真实网络。

`agent-context.test.ts` 是分析师 Agent 的行情上下文端到端用例：真 PG + 真 Python 引擎

- 假交易所，验的是「派生 K 线 → `market-context` → stdout 的 JSON → zod 契约 → 纯映射」
  这条链路。它能抓到替身抓不到的问题：Python 改了字段名，载荷是**拼进提示词的字符串**，
  字段一错模型照样会给出看起来合理的结论——**整条错误链没有一处会报错**。

### 真库隔离设施放在 `src/testing-pg.ts`（不是 `tests/`）

`createTestSchema()` / `insertBars()` 这些在 `src/testing-pg.ts`，从 `src/index.ts` 导出。
**理由与 `src/testing.ts`（假交易所）完全一样**：`apps/sync`、`apps/executor` 等包也要写
「真库 + 真迁移」的用例，而这套隔离设施**只有一份**。留在 `tests/` 里，别的包就只能复制一份——
复制品会各自漂移，于是「测试库连错」这种事故只在某个包里偶发。

`tests/helpers/pg.ts` 现在只是**转出口**，为的是既有用例的 import 路径不用改。
新用例**直接**从 `@trade-tool/data` 导入。

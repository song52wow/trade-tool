# @trade-tool/agent

分析师 Agent + 交易员 Agent（v1.0.0）：**看这个标的值不值得做，以及怎么做**。

```
一轮（每个标的）
  │
  ├─ 行情上下文
  │    ├─ 技术面：python -m quant_data market-context（现算，不物化 indicator_* 表）
  │    ├─ 情绪面：Binance 公开合约接口（7 个，免密钥）
  │    └─ 基本面：库内 contract_spec 快照 + 公开 ticker 24h
  │         ↓
  ├─ 分析师 Agent：三个面各打一个分 → 纯函数合成立场 / 信心 / 一致性
  │         ↓  （报告落库 analyst_report）
  ├─ 交易员 Agent：立场 → 进场方式 / 仓位大小 / 止损止盈
  │         ↓  （方案落库 trading_plan）
  └─ 结束：**默认不下单**。方案只是建议。
```

## 四条边界

1. **模型只输出比例，不输出价格与数量**。模型能说的只有：三个面的分数、置信度、
   止损 / 止盈的 ATR 倍数、风险占权益的百分比、进场方式与偏移。
   **绝对价格、数量、名义金额、亏损金额一律由程序算**——价格走 `deriveBracketPlan`
   （`apps/executor` 挂单走 `deriveStagedPlan`，两者算式与对齐方向逐字相同），
   数量走「愿意亏多少钱 ÷ 每股亏多少」
   再按 `stepSize` 对齐。理由：模型说「买 0.35 个」完全可能是在算 3.5 个，
   而**没有任何一处会报错**；比例算错时绝对金额仍然可控。

2. **总立场由程序合成，不由模型给**。模型给三个面的分数，`aggregateAnalystReport`
   按权重算出 stance / confidence / agreement。否则「报告里写着看多、库里记的是看空」
   这类漂移无从查起。**一致性会折进 confidence**：三个面互相矛盾时，
   即便模型自评信心很高，合成后的信心也会被压下去。

3. **失败必须留痕**。模型超时 / 输出不合法 / 方案算不出来——都落一条 `action='failed'`
   的方案并写明原因，**不静默跳过**。理由很实在：页面上要能回答「这个标的今天分析过没有」，
   而「分析过但没结论」与「压根没分析」是两件完全不同的事。

4. **「可执行」的口径与执行器一致**。自动执行只支持**市价**进场，因此
   **限价方案不自动批准**（落 `advisory` + 显眼日志）。批准一份执行不了的方案，
   它会永远卡在 `approved`——每轮被捞出来又跳过，而页面上显示「已批准、等 executor 消费」，
   看上去像是有一单在等着下。**三处口径必须一致**：agent 的自动批准、
   控制面的人工批准、CLI 的人工批准。

## 方向与结论矛盾怎么办

| 分析师结论 | 允许的方向         | 处置                     |
| ---------- | ------------------ | ------------------------ |
| 看多       | 做多 / 不做        | 做空 → **拒绝出方案**    |
| 看空       | 做空 / 不做        | 做多 → **拒绝出方案**    |
| 中性       | 做多 / 做空 / 不做 | 允许，但**风险敞口减半** |

「看多却做空」是真矛盾：两个 Agent 读同一份数据得出相反结论，出方案等于把矛盾变成真钱。
「中性」不是「不许做」——它说的是「没有明确倾向」，但没有方向性确认时仓位就该小，
所以风险上限按 `agent.risk.neutralRiskFactor` 打折（缺省一半）。

## 越界怎么处置：夹住还是拒绝

界线是「夹住是否仍然安全」：

- 风险比例超上限 → **夹到上限**（往下夹更安全）
- 盈亏比不达标 → **抬高止盈倍数**到达标（往上抬更保守）
- 名义金额超上限 → **按上限缩量**（缩量更安全）
- 算出来的数量低于交易所最小下单量 → **拒绝**（没法夹：「买 0.0001 个 BTC」不是一笔小单，
  是一笔**不存在的单**）

每一处夹住都会记进 `adjustments`，落库、页面、CLI 都看得见。

## 三个面的数据从哪来

| 面     | 数据来源                                      | 取不到时                                    |
| ------ | --------------------------------------------- | ------------------------------------------- |
| 技术面 | Python 现算（`quant_data/market_context.py`） | **直接报错**（`AGENT_CONTEXT_UNAVAILABLE`） |
| 情绪面 | Binance 公开合约接口（7 个，免密钥）          | **降级**：记 `notes` + `degraded=true`      |
| 基本面 | 库内 `contract_spec` 快照 + 公开 ticker 24h   | 缺项记 `null`                               |

**取不到的项一律是 `null`，不是 0**：「资金费率是 0」与「资金费率没取到」是两件完全不同的事，
模型对它们的判断应当相反。

情绪面用的 7 个公开端点（都不需要密钥）：

```
/fapi/v1/premiumIndex            标记价 / 指数价 / 资金费率
/fapi/v1/fundingRate             资金费率历史（现接口缺项时兜底）
/fapi/v1/openInterest            持仓量
/futures/data/openInterestHist   持仓量变化
/futures/data/globalLongShortAccountRatio  多空账户比
/futures/data/takerlongshortRatio           主动买卖比
/fapi/v1/ticker/24hr             24h 成交额 / 成交笔数 / 涨跌幅
```

**技术面在 Python 侧现算，不物化 `indicator_*` 表**：指标层默认关闭且占同步 72% 耗时，
按需算单标的几百根是毫秒级。指标公式仍然只有一份——`quant_core/indicators.py`。
**客观倾向分也在 Python 侧算**（`objective_bias()`），给模型一个锚点：模型可以不同意，
但分数与锚点差太远时，复核的人一眼看得出。

**合约规格读库里 `contract_spec` 快照**，不重新拉 exchangeInfo：规格必须与下单用的是同一份，
否则「方案的 tick 对齐」与「交易所接受的 tick」会分家。

## 权益从哪来：显式二选一

仓位大小是「愿意亏多少钱 ÷ 每股亏多少」算出来的，分母是**账户权益**，所以算仓位必须知道权益。
`agent.equitySource` 显式选一条（**不做优先级解析**）：

- `exchange`：从交易所读实时余额。要凭据（`executor.apiKeyEnv` / `apiSecretEnv`
  或控制面里加密存的那份）。
- `config`：用 `agent.equity` 写的数。适合「只做分析、不碰账户」，但它是**手动维护**的。

缺省 `exchange`：权益写错会直接变成仓位算错，而仓位算错就是真钱。
读不到权益**抛错，不返回 0**（0 会被当成「账户没钱」，于是算出 0 数量——
一个看起来正常、实际什么都不做的方案）。

## 默认只出方案；打开开关才真的下单

`agent.execute.enabled` 缺省 `false`。方案落库时 `status = 'advisory'`，
控制面与 CLI 都看得到，但**不会有单下出去**。

开关打开时，`apps/agent` 产出的**可执行**方案（`action = 'enter'`）直接落
`status = 'approved'`，由 `apps/executor` 消费并变成真实订单。

⚠️ **自动下单走的是 `apps/executor`，不是 `apps/agent`**：下单要用交易所凭据，
凭据在 executor 那边。因此要下单还必须 executor 那边有凭据。

⚠️ **只支持市价进场**：限价单可能永远不成交，而不成交的仓位**没有止损保护**。
因此**限价方案不自动批准**（落 `advisory` + 一条显眼日志）——
批准一份执行不了的方案，它会永远卡在 `approved`，每轮被捞出来又跳过，
而页面上显示「已批准、等 executor 消费」，看上去像是有一单在等着下。
控制面与 CLI 的**人工**批准同样拒绝限价，三处口径一致。

⚠️ **不许出现「两处开关」**：用户已经打开「允许自动下单」，还要再去控制面点一次
批准，于是「开关打开了却没下单」看起来像是坏了。因此控制面与 CLI 的「批准」是
**预先批准**——executor 在开关关着时压根不消费方案。

执行器的细节（认领 → 下单 → 回填、幂等锚点、方案档位优先）见
[`apps/executor/README.md`](../executor/README.md) 与 AGENTS.md §6.12。

## 模型接入在控制面设

模型地址 / 模型名 / API 密钥 / 超时现在可以在控制面录入（密文落库），
改完**下一轮就生效**，不必重启进程。

- 控制面那一档填全了 → 用控制面那份；否则回落到配置文件 + 环境变量。
- 判据只有一份实现（`packages/data/src/db/llm-settings.ts` 的 `resolveAll`），
  且**不看 `enabled`**（那是那一档内部的开关）。
- 控制面的读路径**永远拿不到明文密钥**：只给「配没配 / 末 4 位 / 生效来源」。
  主密钥没注入时状态是「不知道」，不是「没配」。

详见 AGENTS.md §6.13。

## 文件

| 文件             | 职责                                                            |
| ---------------- | --------------------------------------------------------------- |
| `src/service.ts` | `createAgentService()`：一轮的编排（分析 → 方案 → 落库）        |
| `src/daemon.ts`  | `createAgentDaemon()`：定时循环，标的逐个顺序跑                 |
| `src/equity.ts`  | `createEquityReader()`：读账户权益（读不到抛错，不返回 0）      |
| `src/llm.ts`     | `createLlmResolver()`：每轮重新解析模型接入（控制面改完即生效） |
| `src/main.ts`    | 进程入口（`bin: trade-tool-agent`）                             |
| `src/index.ts`   | 对外 barrel                                                     |

## 运行

```bash
cp .env.example .env
# 填 TRADE_TOOL_LLM_API_KEY（或改 agent.llm.apiKeyEnv 指向别的变量）
# 配置 trade-tool.config.json：
#   "agent": { "enabled": true,
#              "llm": { "enabled": true, "baseUrl": "https://…/v1", "model": "…" } }
pnpm --filter @trade-tool/agent start
```

模型接入也可以**在控制面设**（地址 / 模型 / 密钥 / 超时），此时配置文件里那一份
只是兜底。

单跑一次（与守护进程**同一份编排**，口径一致）：

```bash
pnpm --filter @trade-tool/cli start -- agent run -s BTCUSDT
pnpm --filter @trade-tool/cli start -- agent report        # 只读库，不调模型
pnpm --filter @trade-tool/cli start -- agent plan 42 --approve  # 预先批准一份方案
pnpm --filter @trade-tool/cli start -- agent plan 42 --reject   # 驳回一份方案
```

前置条件：目标标的的**派生周期** K 线（`15m` / `1h` / `4h` / `1d`）已被 `apps/sync`
同步到。技术面取不到就**报错**，不换周期、不用 0 顶替。

## 落库

两张表，迁移 `017_agent_decisions`（结构见 `packages/data/sql/017_agent_decisions.sql`）：

- `analyst_report`：三面分数 + 合成立场 + 理由 + **当时喂给模型的完整上下文** + 模型原始返回。
  留上下文是因为只存结论的话，模型改了提示词就再也复现不了「它当时看到了什么」。
  唯一索引 `(exchange, symbol, as_of_ms)`：同一份数据时刻的同一标的只留一份报告。
- `trading_plan`：`action`（`enter` / `hold` / `failed`）、进场三件套、风险、权益来源、
  `adjustments`、`failure_reason`，以及 `status` 状态机
  （`advisory` → `approved` / `rejected` / `expired` → `executing` → `executed` / `failed`）。
  `executing` 与 `failed` 是补自动执行时扩出来的两个状态。

**表级 CHECK 约束**（另有各列自己的取值约束）各自守一条不变式：`enter` 三件套齐全、
止损止盈分居两侧、`hold` 不许带原因、`action='failed'` 必须带原因、`executed` 只能来自 `enter`。
它们是最后一道闸：页面上显示的方案是给人看的，库里那条是事实。

⚠️ **「失败」有两个，守门人也得有两个**：`action='failed'` 是「这一轮**出不了方案**」
（要说清 `failure_reason`），`status='failed'` 是「这一笔**没下出去**」
（要说清 `execution_failure_reason`）。两条约束**必须并存**——写成同名的话，
后一条的 `DROP CONSTRAINT` 会顺带删掉前一条，于是「出不了方案必须说为什么」
这条守门人无声消失（AGENTS.md §5 第 12 条）。

规则的完整版见 AGENTS.md §6.11。

`createEquityReader` 留了一个 `createClient` 注入点：私有客户端的 REST 基址是
**写死的主网地址**（`resolveExchangeEndpoints`），没法指向本地假服务器——
不留这个口子，「交易所返回 0 时必须抛错」那条最要紧的判据就没法直接验。

## 停止与退出

进程收到 `SIGINT` / `SIGTERM` 时：

1. `daemon.stop()` 置停止标志，并**打断**「等下一轮」的那段休眠——
   `agent.intervalMs` 缺省 15 分钟，不打断的话进程管理器（systemd / docker
   通常只给 10 秒宽限）会直接**强杀**，这一轮就停在半路。
2. **等正在跑的那一轮跑完**再退出（`daemon.whenStopped()`）。
   半轮是「看起来成功了，其实什么都没做」的一种：报告落了、方案没落，
   页面上会有一份报告，而与之对应的方案永远不会有。
3. 关连接池、退出码 0。

启动失败（配置不合法、缺模型）**不打印 Node 堆栈**，
而是一行 `[agent] 启动失败：<错误码>: <说清怎么配的话>`，退出码 1
（与 `apps/executor` 同一套写法）。

## 测试

```bash
pnpm --filter @trade-tool/agent test
```

- `tests/service.test.ts` —— 编排层的纯替身用例：问几次模型、顺序、失败留痕、
  方向矛盾、以及**自动执行开关**（开着 → 方案落 `approved`；关着 → 落 `advisory`）。
- `tests/daemon.test.ts` —— 守护进程的三条刻意选择：标的集合**每轮重读**、
  **单个标的出错不影响其它**、**不并发**（顺序跑），外加停止语义。
- `tests/equity.test.ts` —— 权益读取：**读不到就抛错，绝不返回 0**
  （0 会被当成「账户没钱」，于是出一份「数量 0、看起来完全正常」的方案）；
  `equitySource = 'config'` 时**根本不碰交易所**（不需要凭据）。
- `tests/integration.test.ts` —— **端到端**：真 PG（真迁移）+ 真 Python 引擎
  - 假交易所（真 HTTP）+ 假模型服务（真 HTTP，OpenAI 兼容协议）。
    它验的是替身抓不到的那类问题：**接口对不上**——
    模型的回包形状、Python 的 stdout 形状、PG 的列名，任意一个对不上，
    症状都是「方案里某个字段是空的」，而替身版测试照样绿。
    用例还会断言「价格与数量是程序算的」：数量 = 风险金额 ÷ 止损距离，
    价格落在 tick 网格上，止损止盈分居进场价两侧。

真库隔离设施是**全仓唯一一份**：`packages/data/src/testing-pg.ts`（从 `@trade-tool/data`
导出 `createTestSchema` / `TEST_PG` / `TestSchema`）。每次测试跑在独立 schema 上，
结束时整段 DROP，**不得碰任何业务库**。

# AGENTS.md

给在这个仓库里干活的 AI agent / 新人的操作说明。结构与理由见 `README.md`。

## 这个仓库是什么

双轨 monorepo：TypeScript（pnpm + Turborepo）做编排与交互，Python（uv workspace）做计算密集部分。
跨语言只有一个接缝：`packages/data` → `python -m quant_data`。

## 环境

```bash
pnpm install     # TS 依赖（Node >= 22, pnpm >= 11）
pnpm py:sync     # Python 依赖（uv >= 0.11）
cp .env.example .env   # 项目内配置：TRADE_TOOL_HOME + TRADE_TOOL_PG_PASSWORD
docker compose up -d   # PostgreSQL 16，变量取自 .env
```

`pnpm` 必须与 `package.json` 的 `packageManager` 字段一致，否则在仓库内**任何** pnpm 命令都会
以 `Cannot verify the identity of the @pnpm/exe…` 失败（`pnpm -v` 也不例外）。

本机配置与密码一律走仓库根的 `.env`，**不要让用户往 shell 里 export**。`apps/cli` 与
`apps/sync` 的入口第一行调 `loadProjectEnv()`（`packages/core/src/env.ts`），因此
凡是新增的、需要在运行期读到的环境变量，只要写进 `.env.example` 并在入口之前加载即可；
`bridge.ts` 透传 `process.env`，Python 子进程自动继承。已存在的环境变量不被 `.env` 覆盖。

pnpm 11 会在安装时拦截依赖的构建脚本。当前只有 `esbuild` 被批准（见 `pnpm-workspace.yaml` 的
`allowBuilds`）。**新增带 postinstall 的依赖时，不要用 `--ignore-scripts` 绕过**，
而是把包名加进 `allowBuilds` 并在提交里说明理由。

## 提交前必跑

```bash
pnpm check      # = build + TS 测试 + Python 测试
```

单项：`pnpm typecheck`、`pnpm py:lint`（ruff）、`pnpm py:typecheck`（mypy --strict）。
`pnpm format` 跑 Prettier；Python 侧用 `pnpm py:format`。

## 放置代码的位置

| 新东西                                       | 放哪                                                 |
| -------------------------------------------- | ---------------------------------------------------- |
| 领域类型、配置 schema、策略接口              | `packages/core/src`                                  |
| 行情接入、缓存、Python 调用                  | `packages/data/src`                                  |
| **数据库表结构 / 迁移**                      | **`packages/data/sql/`**（唯一来源）                 |
| PG 客户端、schema 闸门、查询层               | `packages/data/src/db`                               |
| **派生周期（桶对齐 / 覆盖判据 / 聚合）**     | **`python/packages/quant-data/src/aggregate.py`**    |
| **带时间锚的取数（如「按成交时刻算 ATR」）** | **`python/packages/quant-data/src/risk.py`**         |
| **私有交易接口（下单 / 用户数据流）**        | **`packages/data/src/binance-private.ts`**           |
| 止盈止损编排、幂等、执行记录                 | `apps/executor/src` + `packages/data/src/db/risk.ts` |
| **新策略**                                   | **`python/packages/quant-backtest/src/`**            |
| 命令行命令                                   | `apps/cli/src/commands/`                             |
| 常驻同步、生命周期、控制原语                 | `apps/sync/src`                                      |
| 控制面 HTTP 路由与前端页面                   | `apps/web/src` + `apps/web/ui`                       |
| **部署镜像与编排（服务器）**                | **`deploy/`**（Dockerfile + compose；根 `compose.yaml` 只是本机开发库） |
| 计算密集逻辑、指标、真实行情源               | `python/packages/*/src`                              |

## 派生周期层（v0.2.0）

高周期 K 线**只由库内 1m 派生**，不向交易所取。四条不可协商的规则：

1. **判据只有一份实现**：`aggregate.judge_bucket`。「能不能写」由它决定，扣留统计与
   `--check` 全部复用。把判据再抄进一条 SQL，会让写入与校验各有一套规则，而两者一旦
   漂移，`--check` 就会对着一条永远不满足的判据报出无穷多个 missing。
2. **只写「已收盘且 1m 全覆盖」的桶**。不足的桶不写，缺口因此原样投影成高周期的空白；
   被扣留的量与原因必须由 SQL 从 1m 推导并报出，**不落「扣留表」**（那是第二套状态）。
3. **聚合挂在 1m 的唯一写入出口**（`write_bars_and_aggregate`）并与每批同事务。任何新增
   的 1m 写入路径都必须经过它，否则聚合会变成「看运气」——而且是**静默**的。
4. **表名不可参数化**。周期必须先过 `INTERVAL_TABLES` 白名单再进 SQL；遇到未实现周期
   （`5m` / `2h` / 任意未知值）一律 `CONFIG_INVALID`，绝不静默回落到 1m。

新增派生周期时：加一列白名单映射 + 一张同形状的表 + 迁移里的一轮登记，
**桶对齐与覆盖判据按桶宽 W 参数化，不要改判据本身**。

## 硬性约定

1. **依赖方向单向**：`core` 不依赖任何 workspace 包；
   跨语言调用只从 `packages/data` 发起。出现反向依赖说明分层错了。
2. **跨语言契约 = 数据库 schema**：改 schema 必须**同提交**更新迁移文件与两侧读写代码，且两侧对同一列的
   类型 / 单位 / NULL 语义必须一致。时间统一毫秒时间戳，数据库列用 `bigint` 而非 `timestamptz`。
   PG 连接串经 `TRADE_TOOL_PG_DSN` 环境变量注入，不进 argv。
3. **schema 唯一来源是 `packages/data/sql/*.sql`**：不得在 TS 或 Python 侧另持影子定义。
4. **策略与指标都是纯函数**：输入等长序列、输出等长数组；不读时钟、不做 IO、不用随机数。
   指标公式**只允许**出现在 `quant_core`（v0.3.0）。
5. **对外导出走 barrel**：包内模块互相 import 用显式 `.js` 后缀，对外只从 `src/index.ts` 导出。
6. **tsconfig 不复制**：一律 `extends` `@trade-tool/tsconfig/*`。
7. **Python 类型**：`mypy --strict` 必须过，公开函数全标注类型；不要用 `# type: ignore` 掩盖。
8. **ruff 忽略 RUF001/002/003**：仓库注释是中文，全角标点会被误判，不要去"修"它们。
9. **不静默兜底**：跨语言调用、IO、配置加载失败一律抛错并给出可读信息，不返回空值假装成功。
10. **不硬编码标的**：源码里不得出现具体合约名（测试 fixture 除外）。标的合法性一律由
    运行时元数据判定，标的集合是动态的。

## 测试用 PostgreSQL

`packages/data` 与 `apps/sync` 的测试需要一个可重复的 PG（默认 `127.0.0.1:5432/trade_tool`，
密码 `trade`）——`docker compose up -d` 起的库正好就是这套默认值，测试不需要额外环境变量。
每个用例跑在**随机命名的独立 schema** 上，从空库执行迁移，结束时整段
`DROP SCHEMA … CASCADE`——测试**不得连生产库**。

需要真实交易所的用例用 `tests/helpers/mock-exchange.ts` 起一个本地假 HTTP 服务器，
并把 `TRADE_TOOL_BINANCE_BASE_URL` 指向它，让**真实的 Python 引擎**跑完整接缝。
**测试过程中不得访问真实网络。**

假交易所必然与当时的真实交易所一致，因此**它验证的是逻辑，不是契约**：止盈止损的整条
下单路径在 mock 上跑通，交易所改版时照样在主网上炸。接缝处（端点、URL、字段名）必须有
对着契约写的断言测试，见「止盈止损层」下的「交易所接缝必须核对契约」。

## 止盈止损层（v0.4.0）

买入成交 → ATR → 止盈止损。五条**不可协商**的规则：

1. **只用已收盘的 bar**：bar 起点 `t`、桶宽 `W`，则窗口上界是 `time <= asOf − W`。
   把未收盘的 bar 喂进 Wilder ATR，止损位会随价格实时漂移。
2. **不跨缺口**：窗口必须是**极大连续段**的尾部。回补久远的缺口不得改写此后成交对应的 ATR。
3. **取不到就拒绝下单**：`RISK_ATR_UNAVAILABLE`，并说清缺多少根。**绝不**换更小的周期、
   也**绝不**用 0 顶替——ATR=0 会让止损正好落在入场价上。
4. **先占坑再动手**：`(exchange, symbol, entry_order_id)` 是幂等锚点。用户数据流在续期与
   重连后会重放事件，而止盈止损是真的会下单。占坑后失败留 `failed` 行 + `last_error`，
   好过「下单成功但没记下来，重连后再挂一次」。
5. **两张单要么都挂上要么都不挂**：先止盈后止损；第二张失败就撤掉第一张。留一张有止盈
   没止损的单，比什么都不挂更危险。

Binance U 本位**没有单请求 OCO**（`/fapi/v1/order/oco` 已下架）：用
`TAKE_PROFIT_MARKET` + `STOP_MARKET`（`closePosition=true`），仓位平掉后另一张
**由交易所自动撤销**。因此本地**不轮询、不盯市**——不要在控制面或守护进程里再实现一套
「触发后撤另一张」的逻辑。

### 交易所接缝必须核对契约（2026-10-10 教训）

上面这些关于 Binance 的陈述**全部核对于 2026-10-10**。它们会过期，而过期的写法比没有
更危险：读代码的人会默认「这个文件的交易所部分被人校准过」。改动接缝、或依赖任何关于
交易所行为的陈述之前，**重新核对官方文档并更新核对日期**。

两条硬约束：

1. **接缝的「值」必须有断言测试**：端点路径、WS URL、字段名、状态取值。测试要对着
   契约断言，而不是对着自己的实现复述。今天 `listenKeyUrl` 从对变错时 122 个测试全绿，
   因为没有任何用例断言过那个地址。
2. **在下第一笔真单之前做一次只读的端点存活性探测**。用非法参数打真实端点：返回参数
   错误（如 `-1116`）说明端点活着，返回 `Order type not supported for this endpoint`
   说明已迁走。零成本，且不需要真的下单。

2026-10-10 一天内连续踩中两次同批改造（Binance 2026-03-06 公告 / 2026-04-23 生效）：

| 变更                                      | 旧的坏法                                               | 为什么当时看不出来                                                    |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 用户数据流必须走 `/private/ws?listenKey=` | 旧地址**握手成功**、不报错、不重连，但一个事件都收不到 | 服务看起来完全正常，实际完全失明；`risk_bracket` 连 `failed` 行都没有 |
| 条件单迁到 `/fapi/v1/algoOrder`           | 前面所有环节全绿，直到下单那一刻才被拒                 | 事件、ATR、算价、落库都通过了，失败点离根因很远                       |

更糟的是它们**互相遮挡**：第一次挂单先撞上 `-2015`（API key 没开合约权限），修完权限
才露出真正的 Algo 迁移问题。**「立刻报错」的错误比「看起来成功其实没做事」的错误友好
得多**——设计接缝时优先选择前者。

> 检索到的文档证据必须与**代码里实际在用的路径**对照，不能只用来回答用户问的那一个问题。
> 问「移动止损能不能做」时检索到的《下条件单》页面里就写着老接口已废弃，但那份结果
> 当时只被当成新功能的可行性依据，没有被当成对现有代码的审计材料。

新增口径时：策略放 `packages/core/src/risk-policy.ts`（纯函数），
ATR 取数放 `quant_data.risk`，交易所差异放 `packages/data/src/binance-private.ts`，
执行记录放 `sql/006_risk_bracket.sql` + `packages/data/src/db/risk.ts`。

### `Retry-After` 是不可信输入，暂停必须封顶（2026-10-12 教训）

线上事故：交易所回过一次 **HTTP 418**（IP 因重复违规被自动封禁），带着
`Retry-After: 44994`（约 12.5 小时）。旧代码把它写成 `pause_until = now + 44994s`
并用 `GREATEST` 落库，结果是**这一次的封禁被固化成绝对时间戳，且再也没有任何路径能收回它**
——交易所几分钟后早已解封，本地却仍停在 12 小时后的暂停里，同步彻底停摆。

停摆之所以「不可恢复」是两个细节叠出来的，任一单独存在都还能自愈：

1. `pause_until` 只会被写长（`GREATEST`），交易所恢复后没有任何东西去收缩它；
2. 封顶值若 ≥ `MAX_RESERVE_WAIT_MS`，`reserve` 一进门就超过等待上限而**立即**抛
   `RATE_LIMITED`，于是一轮都撑不过，还是得等满整个暂停。

因此 `MAX_PAUSE_SECONDS`（5 分钟）**必须小于** `MAX_RESERVE_WAIT_MS`：这样 `reserve`
能在本轮内 sleep 等待到期并自动恢复，不需要人工介入。`register_pause` 也因此改成直接覆盖
而非 `GREATEST` ——封顶后的值每次都由 now 重算，正常时序下本就是单调递增，覆盖与
`GREATEST` 等价，却能让已写坏的存量值在下一轮 429 时自动回到合理范围。

> 教训不止于限流：**任何把外部响应写进「到某个时刻为止」的绝对时间戳的地方，
> 都必须能到期自愈。** 「只在失败时写、从不主动收回」的状态机，就是一次外部事件
> 足以让系统永久停摆的形状。

排查这类停摆时先分清**症状与病因**：日志里刷屏的 `RATE_LIMITED`（配额不足）可能完全是
假象，先直接探测交易所（一次 `curl` 就能看出配额是否真的耗尽），再看 `weight_budget`
那一行的 `pause_until` 是否还停在未来。

## 交易对账层（v0.6.0）

止盈止损只有写入侧，而**占坑（PG）与下单（交易所）无法原子提交**——进程死在中间是必然的。
这类漂移不产生任何日志：用户数据流不重放历史，页面又只读本地表，于是「本地记着
`armed`、交易所那张单早没了」能一直安静地存在。四条**不可协商**的规则：

1. **只报告，绝不动手**。判据是 `packages/core/src/reconcile.ts` 的纯函数：不写库、
   不下单、不撤单，处置一律人工决定。补挂一张止损会平掉真实仓位且不可逆——
   「自动修复」与「报告」的风险完全不对称，因此**不要**在对账里加任何写操作。
2. **判据只有一份实现**，CLI 与控制面共用。两个出口给出不同结论的那一天，
   报告就再也没人敢信了。新增差异类型时同时更新两处出口的呈现，而不是各写一份判断。
3. **范围必须一致**：本地查了哪个标的，交易所就只查哪个标的。拿全账户的快照去比一条
   单标的的本地记录，会报出一条纯属虚构的「止损单不见了」——那是最容易被当真、
   也最经不起推敲的假警报。
4. **严重度按「仓位是否有止损保护」分档**，不按「是否异常」分。
   「本地记着已挂单却没有止损单」是紧急，「只有止损没止盈」只是注意；
   合成一档就是把最要紧的那种淹掉。

对账**必须出网**（签名访问私有接口），因此与 `/bars` 那类纯读本地库的取数不同：
**不许挂自动刷新**，控制面上是手动按钮 + 常驻可见的快照时间（一份十分钟前的「一致」
不该长得和刚查出来的一样）。不带标的的 `GET /fapi/v1/openAlgoOrders` 权重是 **40**
（带标的只要 1），因此控制面路由按标的走，全账户对账走 CLI。

条件单的编号约定（`rsk-<tp|sl>-<entryOrderId>`）在 `packages/core/src/risk-ids.ts`，
**下单与对账共用一份**：两处各写一遍前缀解析，漂移的症状是「止损挂在错误的仓位上」，
而那在两边日志里都完全正常。`orderType` 在**查询侧**回 `TAKE_PROFIT` / `STOP`、
**下单侧**发 `TAKE_PROFIT_MARKET` / `STOP_MARKET`，两套取值都必须原样透传给
`algoOrderTag()`，**不要**在解析层「顺手统一」——统一掉差异，判据就失去了依据。

## 技术指标层（v0.3.0）

指标实现在 **`python/packages/quant-core/src/quant_core/indicators.py`**，
全仓库**唯一一份**；TS 侧（`packages/*`、`apps/*`）**不得出现任何指标实现**。
两侧各有 `sma` 就意味着同一根 K 线上的同一个指标会因浮点舍入而分叉，
症状是「回测赚钱、实盘不赚」且几乎无法定位。

四条不可协商的规则：

1. **参数是数据不是表结构**：`indicator_*` 的参数列直接进主键，改窗口 / 加参数集是
   **插新行、零 DDL**。不得出现 `ma_20` 这类把参数写进列名的形态，也不得用
   `params_hash` 代替可查的参数列。
2. **`impl_version` 进主键**（`quant_core.INDICATOR_IMPL_VERSION`）：口径变更 / 修 bug
   **必须**递增，纯重构不递增。写侧发现混版即抛 `INDICATOR_IMPL_STALE` 拒绝写入。
3. **连续段各自独立重算，段间不递推**：回补一个久远的缺口**不得**静默改写此后的指标值。
   缺口就是噪声，不得跨越。
4. **预热期不落库**：不写 NaN、不写 NULL、更不写 0 冒充缺失。库里每一行都是有效值。

`window` 是 PostgreSQL 的**完全保留字**，因此指标表里那一列叫 `bars`；配置侧仍叫
`window`（JSON 不受 SQL 关键字约束），两者只经 `quant_data.indicators._CONFIG_KEYS` 映射。

## 加一个新策略的完整步骤

1. 在 `python/packages/quant-backtest/src/` 实现策略：**只消费 `quant_core` 的指标序列**，
   引擎内不得写任何指标公式（`Strategy` 侧的旧 TS 接口已随 `packages/backtest` 一并退场）。
2. 从 `quant_backtest/__init__.py` 导出。
3. 在 `quant_backtest/__main__.py` 注册到策略分派处，经 argv 接收控制信息。
4. 在 `packages/core/src/config.ts` 的 `backtestSchema` 里登记可配置参数。
5. 补 `python/packages/quant-backtest/tests/` 用例；**必须**覆盖「无未来函数」
   （构造只有未来数据才成立的信号，断言不产生交易）与 O(n) 复杂度。

## 命令行入口

```bash
pnpm --filter @trade-tool/cli start -- <command>   # 源码直跑
node apps/cli/dist/index.js <command>              # 构建产物
pnpm --filter @trade-tool/web start                 # 控制面（http://127.0.0.1:8787）
```

stdout 是命令结果（日志走 stderr），`--json` 时输出纯 JSON，便于管道处理。

## 控制面（apps/web）

日常操作的网页形态，做法上有五条**硬约束**，改代码时别绕过：

1. **重活儿不阻塞 HTTP**：几十分钟量级的操作要么只写意图、要么只登记 job 并返回 id，
   都不许把 HTTP 请求挂在原地等（R-17.6）。首次全量的路径是「先算规模 → 写
   `desired_state`」，由 `apps/sync` 去跑；`verify` 才登记 job。凡是 job，进度每次从
   `sync_state` 重读，不许用内存计数当进度。
2. **单写者**：控制面作业不得接管 `desired_state = running` 的标的，返回 409 并提示先
   pause——那是 `apps/sync` 守护进程的地盘（R-3.3）。页面与守护进程靠「先落库再生效」
   协作，**不要**在控制面里再起一个守护进程。
3. **首次全量必须先算规模**（R-8.3），没有「缩短范围」的选项。判据是「库里有没有历史」：
   没有历史要先 `GET /api/symbols/:symbol/estimate` 并要求确认，已有历史只是增量。
4. **不假装在同步**：「开始同步」只写 `desired_state`，干活的是独立进程 `apps/sync`。
   守护进程离线时页面必须如实显示（横幅 + 卡片 + 按钮标签），不允许出现「显示同步中、
   数据却不动」的界面。存活读 `daemon_heartbeat` 表，三态 `running` / `stale` / `stopped`
   分开（处置方式不同：继续用 / 查日志 / 去启动）。心跳的语义是**「同步循环在跑」**，
   不是「进程在」：定时器必须独立于同步轮次（只在轮次边界写会被长达几十分钟的首次全量
   误判成离线），但**循环退出时必须一起停**——否则全局性错误让循环退出后心跳还在刷，
   页面会把死循环读成在线，正是这条禁止的界面。退出时**不删**行（进程还活着，删了会
   误报 stopped），让它自然变旧判成 stale；只有优雅退出才删行。

5. **K 线只画真实的行**（R-23）：`/api/symbols/:symbol/bars` 是**纯读**——只打 PG，
   不出网、不消耗交易所配额，因此才能挂在 5s 刷新节奏上。`?interval=` 缺省 `1m`；
   非法或**未实现**的周期（`5m` / `2h` / `foo`）必须 400，**不得静默回落**到 1m——
   用户以为在看 4h、实际拿到 1m，正是最典型的静默兜底。横轴按**时间**排（缺口要
   显形成空白），**不按行序**排；缺一根就是空一根，不插值、不拿均价线顶替。缺口在图外
   量化写明（缺多少**根** / 几段 / 最长多长），**按所选周期报**——把 1m 的分钟数原样贴到
   4h 图上是错的。取数量有上限且**回传生效值**，非法 `limit` 报错而不是静默换值；读失败
   常驻可见。`/bars` 的 **404 要单列**成「控制面还是改动前启动的旧进程，请重启」——
   路由在启动时注册，这一句比 `404 Not Found` 有用得多。
   改这张图时别把它换成「按序号排的通用图表」——那会把空洞压成连续走势。

   桶宽来自**服务端回传的 `intervalMs`**，不在前端写死。
   写死 60_000 会把「4h 图上缺一根」说成「缺一分钟」。

标的口径是 `symbols` 集合 ∪ `sync_state`，与 `readGlobalSummary` 的计数保持一致；
只列集合成员会让「用 `data fetch` 写过但没进集合」的标的带着真实数据从页面上消失。

路由只依赖 `WebDeps` 接口，测试用纯替身（不连 PG、不出网）；需要 DOM 的 UI 用例在文件
顶部声明 `@vitest-environment jsdom`，并 import `tests/ui/setup.ts`（recharts 依赖
`ResizeObserver`）。**首屏取数用 `useLayoutEffect`**：effect 里抛异常会中止同一次 commit
里剩下的全部 effect，图表组件一个 `ResizeObserver` 就能让整页停在「读取中」。

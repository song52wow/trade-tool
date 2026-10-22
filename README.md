# trade-tool

量化 / 交易工具集，**双轨 monorepo**：TypeScript 负责编排与交互，Python 负责计算密集的行情与回测。

```
trade-tool/
├── apps/
│   ├── cli/                     @trade-tool/cli        命令行入口（一次性命令）
│   ├── sync/                    @trade-tool/sync       常驻同步守护进程 + 控制原语
│   ├── web/                     @trade-tool/web        控制面：HTTP API + 看板（直接 import 原语）
│   ├── executor/                @trade-tool/executor   止盈止损：成交 → 净仓位 → ATR → 条件单（会真实下单）＋ 执行 Agent 方案
│   └── agent/                   @trade-tool/agent      分析师 + 交易员 Agent：分析 → 执行方案（默认不下单）
├── packages/
│   ├── tsconfig/                @trade-tool/tsconfig   共享 tsconfig 预设
│   ├── core/                    @trade-tool/core       领域模型 / 配置 / 错误码（**无指标实现**）
│   └── data/                    @trade-tool/data       PG 客户端 + 迁移 + 查询层 + Python 桥接
├── python/                      uv workspace（根）
│   └── packages/
│       ├── quant-core/          数据结构 + **7 组技术指标的唯一实现**
│       ├── quant-data/          行情网络层 + 增量续传 + 派生聚合 + 指标物化 + PG 批量写入 + risk-atr + market-context
│       └── quant-backtest/      **唯一的回测实现**（信号 t 收盘确认、成交 t+1 开盘）
├── packages/data/sql/           版本化数据库迁移（schema 的唯一来源）
├── pnpm-workspace.yaml          TS 侧 workspace + 构建脚本白名单
├── turbo.json                   任务编排与缓存
└── tsconfig.base.json           语言级基线
```

## 依赖方向

```
apps/cli ─────> packages/data ───────> packages/core
apps/sync ────> packages/data ───────> packages/core
apps/web ─────> packages/sync ───────> packages/data ──> packages/core
apps/executor ─> packages/data ───────> packages/core
apps/agent ───> packages/data ───────> packages/core
                      │
                      └─(唯一跨语言接缝: python -m quant_data)─> python/quant-*
```

规则：`core` 不依赖任何 workspace 包；包之间只依赖 `core`；跨语言只允许从 `packages/data` 出去；
`apps/sync` 与 `apps/web` **不得**绕过 `packages/data` 直接连 PG 读写。
`apps/cli`、`apps/sync`、`apps/web`、`apps/executor`、`apps/agent` 是**五个独立入口**：CLI 只读 `sync status`、
不改生命周期；控制面只写 `desired_state`（先落库再生效），真正拉数据的始终是 `apps/sync`
守护进程；`apps/executor` 只做止盈止损，不碰行情同步的生命周期；
`apps/agent` 只出方案，既不碰行情同步的生命周期，**下单也不由它做**——
下单在 `apps/executor`（凭据与私有接口都在那边）。

## 环境要求

Node >= 22、pnpm >= 11、uv >= 0.11、PostgreSQL >= 16。运行 `pnpm --filter @trade-tool/cli start -- doctor` 自检。

配置与密码都放在**项目内的 `.env`**，不需要往 shell 里 export：

```bash
cp .env.example .env      # 按本机情况改，主要是 TRADE_TOOL_HOME 与 TRADE_TOOL_PG_PASSWORD
```

`.env` 已被 `.gitignore` 忽略，`.env.example` 是入库的模板。五个入口（`apps/cli`、`apps/sync`、
`apps/web`、`apps/executor`、`apps/agent`）启动时会自动加载仓库根的 `.env`
（`packages/core` 的 `loadProjectEnv()`，底层是 Node 内置的
`process.loadEnvFile`），因此连同 Python 子进程（`bridge.ts` 透传 `process.env`）都能拿到密码。
**已存在的环境变量不会被 `.env` 覆盖**，CI 与生产注入的值始终优先。

`TRADE_TOOL_HOME` 是工作根目录：配置文件、`data/cache`、`data/raw`、`data/meta`、
`reports/` 全部相对它解析。它必须是**绝对路径**——相对路径按进程 cwd 解析，而
`pnpm --filter … start` 的 cwd 是 `apps/cli`，直跑 `dist` 又是仓库根。

数据库密码**只经环境变量注入**，不写进配置文件（`config init` 生成的 JSON 里写
`database.password` 会被直接拒绝）：

```bash
export TRADE_TOOL_PG_PASSWORD=...        # 变量名可由 database.passwordEnv 改
```

## 快速开始

```bash
pnpm install          # 装 TS 依赖
pnpm py:sync          # 装 Python 依赖（uv）
pnpm build            # turbo 构建全部 TS 包
cp .env.example .env  # 项目内配置，见上

docker compose up -d  # PostgreSQL 16（变量取自 .env，与应用同源）

pnpm --filter @trade-tool/cli start -- config init
pnpm --filter @trade-tool/cli start -- db migrate        # 迁移（幂等）
pnpm --filter @trade-tool/cli start -- data fetch -b 500 # 离线合成数据
pnpm --filter @trade-tool/cli start -- backtest -b 500
```

行情缓存在 `$TRADE_TOOL_HOME/data/cache/`，回测报告在 `$TRADE_TOOL_HOME/reports/`。
K 线本体存在 PostgreSQL 的 `klines_1m` 表里；`15m` / `1h` / `4h` / `1d` 由它**本地派生**
（随同步自动增量，不向交易所取高周期接口），只写「已收盘且 1m 全覆盖」的桶——桶内缺一根
就不写，图上留白而不是画一根半截蜡烛。手动补齐 / 重建 / 校验走：

```bash
pnpm --filter @trade-tool/cli start -- data aggregate -s <SYMBOL>            # 补齐
pnpm --filter @trade-tool/cli start -- data aggregate -s <SYMBOL> --rebuild  # 先删后算
pnpm --filter @trade-tool/cli start -- data aggregate -s <SYMBOL> --check    # 只读校验
```

7 组技术指标（MA / MACD / RSI / BOLL / KDJ / ATR / OBV）由**库内已收盘的派生 K 线**
派生，**唯一的实现**在 `python/packages/quant-core`。参数是数据不是表结构——改窗口、
加一组参数集都只是插新行、零迁移；预热期**不落库**，因此库里每一行都是有效值。

**这层默认关闭**（`data.indicatorSpecs` 缺省 `{}`）。物化挂在 1m 的每批写入出口上，
一轮首次全量会把同一批指标重写几百遍——实测占单轮同步 **72%** 的耗时（见 AGENTS.md §6.2）。
默认配置下没有任何消费方读这些表：止盈止损的 ATR 直接读派生 K 线，回测只消费
`quant_core` 的公式。要看得显式写出参数集，再用 CLI 补齐 / 校验：

```bash
pnpm --filter @trade-tool/cli start -- data indicators -s <SYMBOL>            # 补齐
pnpm --filter @trade-tool/cli start -- data indicators -s <SYMBOL> --rebuild  # 先删后算
pnpm --filter @trade-tool/cli start -- data indicators -s <SYMBOL> --check    # 只读校验
```

两处口径值得记住（实现见 `quant_core/indicators.py`）：**MACD 柱取 `DIF − DEA`**
（国际口径；国内软件的 `2×(DIF−DEA)` 请读侧自行 ×2），**KDJ 横盘时 `RSV = 50`**
（分母为 0 时没有信息，取中性点而不是产生 `NaN`）。

回测的实现同样全部在 Python 侧。成交模型是**信号在 `t` 收盘确认、成交在 `t+1` 开盘**
——改动前是「看到本根收盘价、又以本根收盘价成交」，那是一个可复现的未来函数。
因此**回测报告里的数字会有意变化**；命令行的参数、报告文件路径与命名、stdout 格式、
`--json` 与退出码全部不变。

## 止盈止损（`apps/executor`，v0.4.0）

监听 Binance U 本位永续的成交事件，按**净仓位**判定开仓（BUY 开多 / SELL 开空），
在成交时刻算 ATR(14)，用对称倍数换算成止盈止损，并交给交易所挂着：

```
SL = 入场价 − stopAtrMult × ATR        （缺省 2 倍）
TP = 入场价 + takeProfitAtrMult × ATR   （缺省 3 倍）
```

ATR 来自**本地库已收盘的连续 K 线**（`python -m quant_data risk-atr`），因此这一层不出网、
不吃交易所配额；库里数据不够就报 `RISK_ATR_UNAVAILABLE` 并**拒绝下单**，绝不换周期或用 0
顶替——止损位等于入场价就是当场平仓。两张单都朝**远离入场价**的方向对齐到标的的最小
价格变动：按四舍五入把止损往入场价挪半个 tick，就足以让「2×ATR 的止损」实际更近。

Binance U 本位**没有单请求 OCO**（`/fapi/v1/order/oco` 已下架），因此这里挂的是
`TAKE_PROFIT_MARKET` + `STOP_MARKET`（都带 `closePosition=true`）：仓位平掉后剩余那张
**由交易所自动撤销**，本地不轮询、不盯市。顺序是先止盈后止损，且第二张没挂上就撤掉第一张——
留一张有止盈没止损的单，比什么都不挂更危险。

```bash
pnpm --filter @trade-tool/executor start   # 需 executor.enabled = true（会真实下单）
```

幂等靠 `risk_bracket` 表的主键 `(exchange, symbol, entry_order_id)`：**先占坑再动手**，
冲突即说明这笔成交已处理过（用户数据流会重放事件，而止盈止损是真的会下单）。
细节见 `apps/executor/README.md`。

### 让模型决定档位（v0.9.0，默认关闭）

配置里写 `executor.llm.enabled = true`（另需 `baseUrl` / `model` 与环境变量
`TRADE_TOOL_LLM_API_KEY`）之后，每笔买入成交会先问一次模型「这笔仓的档位用多少」，
再挂单。

**模型只决定倍数，不决定价格**：它说「止损 2.5 倍、止盈 4 倍」，价格仍由程序按
ATR 算（`deriveStagedPlan`）。这样价格计算保持是可复现的纯函数，而模型的输出
过一道与配置档位**同一份**取值范围的校验——越界直接拒绝，不会变成平仓指令。

模型超时、报错、输出不合法或档位自相矛盾时，**降级到 `risk_policy` 的档位**并照常挂单
（仓位不能裸着），同时把 `decision_source='config-fallback'` 与原因**落库**、推一条
`llm-fallback` 告警。事后能查出「这次是模型定的还是配置定的」。

代价是**裸仓窗口**：模型响应时间不可控，而它在「成交 → 挂单」之间。
`executor.llm.timeoutMs`（缺省 8 秒）是这个窗口的上限。
细则见 `AGENTS.md` §6.10。

## 分析师 / 交易员 Agent（`apps/agent`，v1.0.0）

两个 Agent 回答两个问题：

- **分析师**：这个标的**值不值得碰**，以及**凭什么**——技术面（价格结构与指标）+
  情绪面（持仓者的钱往哪边压：资金费率、基差、持仓量、多空比、主动买卖比）+
  基本面（合约规格、流动性、持有成本），各打一个分。
- **交易员**：既然值得做，**怎么做**——进场方式、仓位多大、止损放哪。

```
行情上下文（Python 现算技术面 + 公开接口取情绪面 + 库里取合约规格）
      ↓
分析师 Agent：三个面各打一个分 → 纯函数合成立场 / 信心 / 一致性   → 报告落库
      ↓
交易员 Agent：立场 → 进场方式 / 仓位大小 / 止损止盈                 → 方案落库
      ↓
默认到此为止：**只出方案，不下单**
      ↓
（agent.execute.enabled = true 时）方案进 approved → apps/executor 变成真实订单
```

**模型只输出比例，不输出价格与数量**。模型能说的只有分数、置信度、ATR 倍数、
风险占权益的百分比、进场方式与偏移；**绝对价格、数量、名义金额一律由程序算**——
价格走 `deriveBracketPlan`（`apps/executor` 挂单走 `deriveStagedPlan`，两者算式与对齐方向
逐字相同），数量走
「愿意亏多少钱 ÷ 每股亏多少钱」再按 `stepSize` 对齐。理由很实在：模型说「买 0.35 个」
完全可能是在算 3.5 个，而**没有任何一处会报错**；比例算错时绝对金额仍然可控。

**总立场由程序合成，不由模型给**。模型给三个面的分数，`aggregateAnalystReport` 按权重算出
立场 / 信心 / 一致性。否则「报告里写着看多、库里记的是看空」这类漂移无从查起。
三个面互相矛盾时，一致性会折进信心——互相矛盾的面本来就不该被当成高置信度结论。

**方向与结论矛盾就不出方案**：分析师看多而交易员做空，是两个 Agent 读同一份数据得出相反
结论，出方案等于把矛盾变成真钱。「中性」不算矛盾，但**风险敞口减半**。

**失败必须留痕**：模型超时、输出不合法、方案算不出来，都落一条 `action='failed'` 的方案并写明
原因。页面上要能回答「这个标的今天分析过没有」，而「分析过但没结论」与「压根没分析」
是两件完全不同的事。

```bash
pnpm --filter @trade-tool/agent start                # 常驻（需 agent.enabled = true）
pnpm --filter @trade-tool/cli start -- agent run     # 单跑一次
pnpm --filter @trade-tool/cli start -- agent report  # 只读库，看最近一次报告与方案
pnpm --filter @trade-tool/cli start -- agent plan 42 --approve  # 预先批准一份方案
```

`agent run` 与守护进程**共用同一份编排**，口径一致；`agent report` 是纯读，
不调模型也不写库——它是「上周那笔到底怎么决定的」的答案来源，不该因为模型今天挂了
就连历史都看不了。

⚠️ **默认只出方案，不下单**：`agent.execute.enabled` 缺省 `false`，方案落库时
`status = 'advisory'`，控制面与 CLI 都看得到。

⚠️ **打开这个开关就会真的下单**（v1.0.0 已实现）：Agent 产出的可执行方案直接进
`approved`，由 `apps/executor` 消费并变成真实订单（**只支持市价进场**——
限价单可能永远不成交，而不成交的仓位没有止损保护，因此**限价方案不自动批准**，
控制面与 CLI 的人工批准也拒绝它）。
下单走 executor 而不是 agent，因为下单要用交易所凭据，而凭据在 executor 那边。

模型接入（地址 / 模型 / 密钥 / 超时）**可以在控制面设**（密文落库），改完下一轮就生效，
不必重启进程；配置文件 + 环境变量降级为兜底档。

细则见 [`apps/agent/README.md`](apps/agent/README.md) 与 `AGENTS.md` §6.11–§6.13。

## 交易对账（v0.6.0）

止盈止损只有写入侧：占坑在 PG、下单在交易所，两者无法原子提交。进程死在中间是必然的
——单挂上了而单号没回填，或本地记着 `armed` 而那张单早没了。这类漂移**没有任何日志会
告诉你**：用户数据流不重放历史，页面又只读本地表，于是一切看上去正常。

对账就是补上这个只读的眼睛：拉交易所真实的持仓与条件单，同本地 `risk_bracket` 比对。

**默认是自动的**：`apps/executor` 每 5 分钟做一次全账户对账（`executor.reconcileIntervalMs`
设为 `0` 可关闭），启动时立刻先跑一次。结果落 `reconcile_run` 表，控制面详情页读的就是它。

为什么自动：止盈止损的「单已挂上、单号没回填」只在崩溃那一瞬间发生，迟到几小时再查也
来得及；但**在交易所 App 上手动开的仓**是持续形成的漂移——只靠人想起来跑一次命令，等于
没有对账。上面 ETHUSDT / SOLUSDT 两条「紧急」正是这一类。

```bash
pnpm --filter @trade-tool/cli start -- reconcile                 # 手动跑一次（全账户）
pnpm --filter @trade-tool/cli start -- reconcile -s BTCUSDT      # 单标的
```

为什么默认全账户：一次 `positionRisk`（权重 5）+ 一次 `openAlgoOrders`（权重 **40**）= 45，
而逐标的每个标的 6——全账户既更便宜、覆盖也更全。

控制面上是只读面板（显示最近一次快照 + 查询时间，过期会标黄），另留「立即对账」按钮供
当场重查。**只报告，不动手**：不下单、不撤单、不改 `risk_bracket`，处置一律人工决定——
自动补挂一张止损会平掉真实仓位，且不可逆。

判据只有一份实现（`packages/core/src/reconcile.ts`，纯函数），CLI 与控制面共用，因此两个
出口不可能给出不同结论。差异分两档而不是「有异常 / 没异常」：

| 差异                           | 严重度 | 含义                                                 |
| ------------------------------ | ------ | ---------------------------------------------------- |
| `missing-stop-order`           | 紧急   | 本地记为已挂单，交易所没有止损单——**仓位当前是裸的** |
| `unprotected-position`         | 紧急   | 一笔入场成交占坑成功但没挂上单，而仓位还在           |
| `position-without-record`      | 紧急   | 交易所有仓位，本地没有任何未终结记录                 |
| `missing-take-profit-order`    | 注意   | 止损还在，止盈没了                                   |
| `price-mismatch`               | 注意   | 单还在，但触发价与本地记录不一致                     |
| `record-without-position`      | 注意   | 本地记为已挂单，交易所已无仓位（平仓事件多半没收到） |
| `orphan-algo-order`            | 注意   | 交易所挂着我方单，但本地没有记录引用它               |
| `unexpected-take-profit-order` | 注意   | 本地已进入移动止损阶段，交易所却还挂着止盈单         |
| `trail-move-failed`            | 注意   | 已进入移动止损，但有换档尝试没成功——止损位停在旧档   |

「有止盈没止损」是紧急，「只有止损没止盈」只是注意——合成「有没有问题」会让最要紧的
那种被淹掉。

判据**按阶段分流**：「这一阶段的形态上该有什么」由事实判，不由「有没有」判。
`trailing` 行本来就没有止盈单（第一段已成交），`partial_armed` 行在**第一段成交后**
（`tp1_filled_at` 有值）那张单也**本来就该消失**——这两条都不报差异。
否则会每轮发一条假警报，而假警报是让整份报告失去可信度的最快方式。

**对账必须出网**：它要签名访问交易所私有接口（`GET /fapi/v3/positionRisk`、
`GET /fapi/v1/openAlgoOrders`）。但出网的那一步**不在控制面**——控制面不许再起守护进程，
所以周期对账放在本来就常驻的 `apps/executor` 里；控制面只读已经算好的快照，
因此可以安全地挂刷新节奏。

## 飞书通知（v0.8.0）

这个仓库里最贵的故障不是报错，而是**没人知道**：止盈止损挂单失败、仓位在交易所裸奔、
在 App 上手动开的仓——这些事在日志里只是几行 warn，而日志没人盯着。飞书通知就是给对账
配的一个「出口」：差异一发现就推到你手机上。

开起来要三步，缺一不可：

1. 飞书群里「设置 → 群机器人 → 添加机器人 → 自定义机器人」，复制它的 webhook 地址；
2. 填进 `.env`：`TRADE_TOOL_FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx`
   （这地址**本身就是凭据**，拿到就能往群里发消息，别提交）；
3. 在 `trade-tool.config.json` 里写 `"notify": { "enabled": true }`。

> **也可以不碰文件**：控制面「设置」页里有一块**飞书通知**，直接在那儿填地址、开关开关、
> 调参数，保存即可。地址会以密文落库（和交易所密钥同一套加密），页面只显示末 4 位、
> **永不回显明文**。控制面那一档**优先于**配置文件 + 环境变量；页面会写明当前生效的是
> 哪一档。改完**不必重启 executor**——它每轮对账时都会重新读一次设置（默认 5 分钟内生效）。
>
> 没配主密钥（`TRADE_TOOL_SECRET_KEY`）时页面会**禁用表单并说清缺什么**，而不是让你填完
> 再失败。

少了第 3 步 → 不推送，executor 的启动日志里写着「飞书通知未启用」。
开了却没填第 2 步 → **executor 直接启动失败**。宁可起不来，也不要「以为通知过了、
其实群里什么都没有」——那是这个仓库最忌讳的一种状态。

推什么：对账的差异。一轮对账的多个差异**合成一条**消息（一个裸仓常同时命中好几条判据，
拆开推就成了「一个问题推了三遍」）。差异消失时会再推一条「交易对账已恢复正常」。

**推哪些内容由你逐项勾选**（每种一句话说明）：9 种对账差异，外加交易生命周期事件。比如
「止盈单没了」这种你觉得是噪音的就别勾，「仓位没有止损保护」这种一定要勾。勾选项的清单
由服务端下发，页面不会自己抄一份。没勾的内容照样记在日志里，只是不来烦你。改勾选只影响
**之后**的推送，不会撤回已发出去的。

生命周期事件：

- **止盈止损挂单成功** —— 附**预估**收益与预估亏损（打到止盈 / 打到止损各多少）。
- **一轮买卖完成** —— 附**实际**盈亏：毛利、累计手续费、净盈亏。
- **第一段止盈成交** —— 分批形态下那一段兑现了，附成交价与这一段落袋的盈亏。
  没有它的话，「一半仓位已经兑现」这件事只存在于库里与日志里。
- **移动止损换档** —— 附新旧两档的价。同一笔仓位在冷却期内只推一次
  （换档可能发生很多次，每次都推就是刷屏）。

**金额一律用 USDT 算**（这批合约就是 USDT 计价，(价差)×数量 天然就是 USDT，不换算）。实际
盈亏**扣掉手续费**，而且是**整轮**的——入场那笔也收（只扣出场那笔，收益会永远算虚高）。

消息是**飞书卡片**：头部按严重度上色（紧急红 / 注意橙 / 提示蓝），标题里直接写着
**推送类型**（🛡️ 止盈止损 / 🚨 报错 / 💰 成交）和关键数字，**金额单独加粗**——飞书的消息
列表只显示标题，所以「是什么事、这一轮赚没赚」在推送预览里就能看到，不用点开。
万一飞书拒收（关键词没配对之类），会**自动退回纯文本**再发一次，原因也会记进日志。

不刷屏：同一件事在冷却期（默认 30 分钟）内只推一次；严重度变了（注意 → 紧急）立刻重推。
一个一直存在的裸仓不会每 5 分钟刷你一次——被无视的告警等于没接。

其余可调项在 `notify` 段：`minSeverity`（默认 `warning`＝紧急与注意都推；改成 `critical`
就只推「仓位当前没有止损保护」那一类）、`repeatCooldownMs`（冷却时长）。
机器人的「安全设置」如果选了「签名校验」，把密钥填进 `TRADE_TOOL_FEISHU_WEBHOOK_SECRET`。

实现全在 [`packages/core/src/notify.ts`](packages/core/src/notify.ts)，契约核对日期
**2026-10-19**（官方《自定义机器人使用指南》）。

## 控制面（`apps/web`）

`docs/…sync.md` 最初把控制面列为下期，只交付数据层原语（R-22）——`@trade-tool/sync`
的原语就是为它准备的交付边界。现在 `apps/web` 把它接上了（R-23 … R-25）：
Hono 提供 JSON API，Vite + React 提供看板，**直接 import 原语**，不 shell out 解析 stdout。
本期不做的只剩**鉴权 / 多用户**（N-7）。

```bash
pnpm build
pnpm --filter @trade-tool/web start        # http://127.0.0.1:8787（地址见 .env）
```

能做：状态总览（行数/占用/缺口/配额/可同步标的数/守护进程在线状态）、标的集合增删、
同步开关、带规模预估与二次确认的首次全量、数据体检、缺口清单、K 线图（可切周期，
）与派生周期的扣留统计。

> 页面上**不显示指标**：`/api/symbols/:symbol/indicators` 与指标面板已随「指标层默认关闭」
> 一起删除。K 线图只有蜡烛与真实缺口。任何将来加回指标线的读侧都要遵守同一条：
> **在缺口处断开**（不跨缺口连线），并写明指标序列比 K 线短多少根、为什么（预热期与
> 未收盘的最后一根），不让它看起来像数据缺失。指标值语义是「**收盘后可用**」。

界面上**只有一个主流程**：「开始同步」→「同步中 · 暂停」。点开始后守护进程先补全历史，
之后每轮增量拉取最新——补全与实时是同一个持续动作，不拆成两个按钮。行内不再有
「拉取」「校验」：全量/增量由守护进程负责，「数据体检」是低频重操作，放在详情面板里。

四条约束是硬来的，不是实现偏好：

- **重活儿不阻塞 HTTP** —— 首次全量是几十分钟量级，接口只登记作业并返回 job id（R-17.6），
  进度每次从 `sync_state` 重读，关掉页面也不影响。
- **单写者** —— 作业拒绝接管 `desired_state = running` 的标的并返回 409，提示先 pause；
  那是 `apps/sync` 守护进程的地盘（R-3.3）。
- **首次全量必须先算规模** —— 点「开始同步」时若该标的库里还没有历史，先请求
  `GET /api/symbols/:symbol/estimate` 拿行数/请求数/权重，弹确认框，没有「缩短范围」的
  选项（R-8.3）。已有历史时只是增量，直接开。
- **不假装在同步** —— 「开始同步」本身只写 `desired_state`，真正干活的是独立的
  `apps/sync` 进程。守护进程没在跑时，页面挂常驻横幅、按钮标签与卡片都如实显示
  「未运行」，点开始也会先说明「意图会记录但不会拉数据」。存活判定读
  `daemon_heartbeat` 表（`003_daemon_heartbeat.sql`）：守护进程用**独立于同步轮次**的
  定时器刷 `last_beat`（一轮首次全量可达几十分钟，只在轮次边界写会被误判成离线），
  优雅退出删行，被强杀则由阈值判超时。三态 `running` / `stale` / `stopped` 分开报，
  因为处置方式不同：前者继续用，`stale` 去查日志，`stopped` 去启动进程。

守护进程仍是独立的 `apps/sync` 进程：控制面只写 `desired_state`，两边靠「先落库再生效」
（R-19）协作，不需要新通信机制。细节见 `apps/web/README.md`。

## 本地数据库（docker compose）

`compose.yaml` 只定义一个 `postgres:16` 服务，变量从 `.env` 自动读取——密码因此只有一处来源，
应用侧不用再 export。它只绑 `127.0.0.1`，数据落在命名卷 `trade-tool-pgdata`。

```bash
docker compose up -d      # 起库（首次会拉镜像）
docker compose ps         # 等 STATUS 变成 healthy
docker compose down       # 停库，保留数据卷
```

本机没有 Docker Desktop 时用 colima（本仓库的 docker context 指向它）：`colima start`
之后容器带 `restart: unless-stopped`，colima 起来时会自动恢复。

## 部署到服务器（deploy/）

`compose.yaml` 是**本机开发**用的，上面那份只是本地依赖。要把整套服务（控制面 /
常驻同步 / 止盈止损 / PostgreSQL）部署到一台服务器上，走 `deploy/`：

```bash
./deploy/build-image.sh          # 本机构建镜像 → dist-deploy/trade-tool-deploy.tar
```

镜像在本机构建、`docker save` / `docker load` 搬运，目标机不需要 git / pnpm / uv。
`deploy/compose.yaml` 里三个应用服务（web / sync / executor）共用同一个镜像、只靠 `command` 区分；
止盈止损放在 `executor` profile 里，`docker compose up -d` 不会启动它。
`apps/agent`（分析师 / 交易员 Agent）暂不在部署编排里——它默认只出方案、不下单。
完整的搬运步骤、环境变量、排查表见 [`deploy/README.md`](deploy/README.md)。

## 常驻同步（v0.1.0）

```bash
trade-tool db migrate                                  # 应用迁移
trade-tool data sync --symbol BTCUSDC                  # 增量续传（主入口）
trade-tool data backfill --symbol BTCUSDC --from <ms> --to <ms>
trade-tool data verify --symbol BTCUSDC                # 全表缺口扫描
trade-tool data gaps --symbol BTCUSDC                  # 待回补缺口清单
trade-tool data symbols --source binance --json        # 运行时发现可用标的
trade-tool sync status --json                          # 同步状态与全局汇总
```

`apps/sync` 提供常驻守护进程与**控制原语**（`addSymbol` / `removeSymbol` / `listSymbols` /
`start` / `pause` / `resume` / `getStatus` / `getSummary`），全部幂等、类型完整、不依赖 HTTP 框架，
供控制面直接 `import`。生命周期变更**不走 CLI**，走这套原语。

配置里的标的集合支持两种写法——纯字符串（默认 `paused`）或显式给出每标的期望状态：

```jsonc
{ "sync": { "symbols": ["SOLUSDC", { "symbol": "DOGEUSDC", "desiredState": "running" }] } }
```

新增标的默认 `paused`（R-8.4），规模预估会在**开启之前**写进 `sync_state`，
由 `sync status` 暴露，控制面据此决定要不要开始首次全量。

```ts
import { createSyncServiceFromConfig } from '@trade-tool/sync';

const service = createSyncServiceFromConfig(config);
await service.primitives.addSymbol('BTCUSDC'); // 默认 paused
await service.primitives.start('BTCUSDC'); // 才启动首次全量
```

## 常用命令

| 命令                                                      | 作用                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm build` / `pnpm typecheck` / `pnpm test`             | Turborepo 编排的 TS 侧全量校验                       |
| `pnpm check`                                              | 构建 + 双端测试，提交前跑这个                        |
| `pnpm format`                                             | Prettier 格式化 TS/JSON/MD                           |
| `pnpm py:test` / `py:lint` / `py:typecheck` / `py:format` | Python 侧 pytest / ruff / mypy(strict) / ruff format |
| `pnpm clean`                                              | 清空各包 dist                                        |

测试需要一个可重复的 PostgreSQL。默认连 `127.0.0.1:5432` 的 `trade_tool` 库，
每个用例跑在**随机命名的独立 schema** 上并在结束时整段删除，因此不会碰到任何业务表。
用 `TRADE_TOOL_TEST_PG_{HOST,PORT,DATABASE,USER,PASSWORD}` 覆盖连接参数。

## 跨语言契约（最重要）

TS 与 Python 通过 `packages/data/src/bridge.ts` 交互。**v0.1.0 起，跨语言契约是数据库 schema**，
不再是 stdout 里的数据——这是本次最根本的改动。

1. Python 模块通过 `-m` 启动，因此 `src/quant_x/__main__.py` 必须存在。
2. **K 线数据只经 PostgreSQL 传输，不经 stdout**。桥接只传控制信息：命令、参数、结果摘要
   （行数、时间范围、状态码）。因此 `maxBuffer` 不再是数据量的约束。
   唯一例外是既有的 `generate`（**离线合成源**）：它的 bars 本来就经 stdout 回给 TS，
   AC-29 要求这条链路不得回归，因此 `bridge.ts` 给它单独的、按 bar 数放大的 stdout 预算。
3. 成功时 stdout = 单个 JSON 文档（就是那份摘要），日志一律走 stderr；不允许 `NaN` / `Infinity`。
4. 失败时退出码非 0，且 **stderr 最后一行**固定为
   `QUANT_DATA_ERROR {"code":"...","message":"...","details":{...}}`，错误码与 TS 侧 `SyncErrorCode` 一一对应。
5. PostgreSQL 连接串经 **`TRADE_TOOL_PG_DSN` 环境变量**注入，不进 argv，避免密码出现在进程列表里。
6. Binance base URL 可用 `TRADE_TOOL_BINANCE_BASE_URL` 覆盖——测试据此指向本地假交易所，
   **测试过程中不访问真实网络**。
7. **schema 的唯一来源是 `packages/data/sql/*.sql`**。改 schema 必须同提交更新两侧的读写代码与迁移文件；
   两侧对同一列的类型、单位、NULL 语义必须一致。
8. 时间统一为 **epoch 毫秒**，数据库列一律 `bigint`，不使用 `timestamptz`。
9. `time/open/high/low/close/volume` 为 `NOT NULL`；`quote_volume` / `trades` 允许 NULL，
   语义严格为「交易所未提供该字段」，**禁止用 `0` 冒充缺失**。

## 当前状态

- **真实行情**：Binance USDⓈ-M 永续 1m K 线已接入 PostgreSQL。**同步链路的标的全部运行时解析**，
  没有任何标的白名单或按标的的特例逻辑；`onboardDate` / `contractType` / `status` 一律来自
  `exchangeInfo`（R-5 / R-7）。
  默认配置里的 `market.symbol`（`BTCUSDT`）只服务**离线合成源与回测**，同步链路不读它——
  `data sync` 必须显式给 `--symbol`。
- **离线链路仍在**：`source: 'synthetic'` 走 `generate_series`，默认行为与既有测试不变。
- 回测为单标的、单持仓，**信号在 `t` 收盘确认、成交在 `t+1` 开盘**，扣双边手续费与滑点。
- **分析师 / 交易员 Agent 已实现**（v1.0.0）：常驻进程 + CLI 单跑，控制面有面板。
  **默认只出方案、不下单**；`agent.execute.enabled = true` 时方案进 `approved`，
  由 `apps/executor` 变成真实订单（**只支持市价进场**）。
- **模型接入可以在控制面设**（v1.0.0）：地址 / 模型 / API 密钥 / 超时，密钥密文落库，
  改完下一轮生效；配置文件 + 环境变量降级为兜底档。

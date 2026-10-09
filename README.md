# trade-tool

量化 / 交易工具集，**双轨 monorepo**：TypeScript 负责编排与交互，Python 负责计算密集的行情与回测。

```
trade-tool/
├── apps/
│   ├── cli/                     @trade-tool/cli        命令行入口（一次性命令）
│   ├── sync/                    @trade-tool/sync       常驻同步守护进程 + 控制原语
│   ├── web/                     @trade-tool/web        控制面：HTTP API + 看板（直接 import 原语）
│   └── executor/                @trade-tool/executor   止盈止损：买入成交 → ATR → 条件单（会真实下单）
├── packages/
│   ├── tsconfig/                @trade-tool/tsconfig   共享 tsconfig 预设
│   ├── core/                    @trade-tool/core       领域模型 / 配置 / 错误码（**无指标实现**）
│   └── data/                    @trade-tool/data       PG 客户端 + 迁移 + 查询层 + Python 桥接
├── python/                      uv workspace（根）
│   └── packages/
│       ├── quant-core/          数据结构 + **7 组技术指标的唯一实现**
│       ├── quant-data/          行情网络层 + 增量续传 + 派生聚合 + 指标物化 + PG 批量写入 + risk-atr
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
                      │
                      └─(唯一跨语言接缝: python -m quant_data)─> python/quant-*
```

规则：`core` 不依赖任何 workspace 包；包之间只依赖 `core`；跨语言只允许从 `packages/data` 出去；
`apps/sync` 与 `apps/web` **不得**绕过 `packages/data` 直接连 PG 读写。
`apps/cli`、`apps/sync`、`apps/web`、`apps/executor` 是**四个独立入口**：CLI 只读 `sync status`、
不改生命周期；控制面只写 `desired_state`（先落库再生效），真正拉数据的始终是 `apps/sync`
守护进程；`apps/executor` 只做止盈止损，不碰行情同步的生命周期。

## 环境要求

Node >= 22、pnpm >= 11、uv >= 0.11、PostgreSQL >= 16。运行 `pnpm --filter @trade-tool/cli start -- doctor` 自检。

配置与密码都放在**项目内的 `.env`**，不需要往 shell 里 export：

```bash
cp .env.example .env      # 按本机情况改，主要是 TRADE_TOOL_HOME 与 TRADE_TOOL_PG_PASSWORD
```

`.env` 已被 `.gitignore` 忽略，`.env.example` 是入库的模板。`apps/cli` 与 `apps/sync`
启动时会自动加载仓库根的 `.env`（`packages/core` 的 `loadProjectEnv()`，底层是 Node 内置的
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
控制面读的是物化表（纯读本地库，不出网），所以指标跟同步走：

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

监听 Binance U 本位永续的成交事件，**只在买入成交**上按成交时刻算 ATR(14)，用对称倍数
换算成止盈止损，并交给交易所挂着：

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
叠加均线 / BOLL，副图 MACD / RSI / KDJ / ATR / OBV）与派生周期的扣留统计。

图上的指标同样遵守「只画真实的行」：**指标线在缺口处断开**（不跨缺口连线），
而指标序列天然比 K 线短——少的正是预热期与未收盘的最后一根，图外会写明少了多少根与原因，
不会让它看起来像数据缺失。指标值语义是「**收盘后可用**」。

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
- 回测为单标的、单持仓、收盘成交模型，扣双边手续费与滑点。

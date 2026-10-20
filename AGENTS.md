# AGENTS.md

给在这个仓库里干活的 AI agent 与新人：**该放哪儿、不许做什么、改完跑什么**。
本文件是硬约束的**唯一权威清单**，只写规矩与理由。谁写什么，别互相抄：

| 想知道                              | 看哪里                                 |
| ----------------------------------- | -------------------------------------- |
| 仓库结构、依赖方向、每层为什么      | [`README.md`](README.md)               |
| 需求与验收（`R-*` / `AC-*` 的原文） | [`docs/`](docs/README.md)              |
| 某个包 / 应用的实现细节             | 各自的 `README.md`                     |
| 环境变量全集与逐条注释              | [`.env.example`](.env.example)         |
| 部署到服务器                        | [`deploy/README.md`](deploy/README.md) |

两条元规矩，先记住再看别的：

1. **同提交更新**（v0.3.0 AC-20）：改动涉及「东西放哪儿 / 什么不许做」时，**同一个提交里**
   改本文件与 [`README.md`](README.md)；只顺手动了某个包的实现，就改那个包的 `README.md`，
   不要往这里堆细节。
2. **§5 的编号是外部锚点**：`packages/*`、`apps/*`、`python/*`、`sql/*` 里共有二十多处按号
   引用它（`AGENTS.md 硬性约定 2`、`约定 9`、`控制面硬约束 2`、`对账层规则 1` …）。
   **只许追加，不许重排、改号、删号**；确实要删条目，先把引用改完（见 §11）。

改完本文件跑 `npx prettier --write AGENTS.md`——`pnpm format:check` 会检查它。

## 0 速查

```bash
# 一次性
pnpm install && pnpm py:sync && cp .env.example .env && docker compose up -d
pnpm --filter @trade-tool/cli start -- doctor     # 自检 node / pnpm / uv / git
```

```bash
# 提交前。注意 pnpm check 不含类型检查与 lint，别只跑它
pnpm check                        # build + TS 测试 + Python 测试
pnpm typecheck                    # 改过 TS 类型必跑
pnpm py:lint && pnpm py:typecheck # 改过 Python 必跑（ruff / mypy --strict）
pnpm format:check                 # 任意文件（Prettier；Python 侧另有 pnpm py:format）
```

开工顺序：**查 §4 决定放哪儿 → 读 §6 里对应的那一层 → 按 §8 补用例**。

最容易踩的几个坑：

| 坑                                    | 症状                                                | 见               |
| ------------------------------------- | --------------------------------------------------- | ---------------- |
| pnpm 版本与 `packageManager` 不一致   | 仓库内**任何** pnpm 命令都失败（连 `pnpm -v` 也是） | §2.4             |
| 新增进程入口忘了调 `loadProjectEnv()` | 读不到 `.env`，表现为「配置明明填了却说没配」       | §2.2             |
| 凭据 / DSN 走了 argv 或配置文件       | 密码出现在 `ps` 与 git 里                           | §5 第 2 条       |
| 失败时返回空值 / 默认值而不是抛错     | 「看起来成功了，其实什么都没做」，最难查            | §5 第 9 条       |
| 判据被抄成第二份实现                  | 两个出口结论不一致，此后没人再敢信任何一份          | §6.1、§6.2、§6.5 |

## 1 这个仓库是什么

**双轨 monorepo**：TypeScript（pnpm + Turborepo）做编排与交互，Python（uv workspace）
做计算密集的行情、指标与回测。跨语言只有**一个接缝**：`packages/data` → `python -m quant_data`。

```
apps/cli ─────> packages/data ───────> packages/core
apps/sync ────> packages/data ───────> packages/core
apps/web ─────> apps/sync ───────────> packages/data ──> packages/core
apps/executor ─> packages/data ───────> packages/core
                     │
                     └─(唯一跨语言接缝: python -m quant_data)─> python/quant-*
```

四个进程入口，职责**不重叠**——不要在控制面里再起守护进程，也不要让 CLI 改生命周期：

| 进程            | 职责                                                      |
| --------------- | --------------------------------------------------------- |
| `apps/cli`      | 一次性命令（`db` / `data` / `backtest` / `reconcile`）    |
| `apps/sync`     | 常驻同步守护进程，**唯一真的拉行情的人**，控制原语在此    |
| `apps/web`      | 控制面：HTTP API + 看板；只写意图，另有一条一次性手动对账 |
| `apps/executor` | 止盈止损：买入成交 → ATR → 条件单（**会真下单**）         |

CLI 的完整命令表与约定见 [`apps/cli/README.md`](apps/cli/README.md)（失败非 0 退出且 stdout
无输出、`--source binance` 绝不回退到合成数据、`--json` 不豁免首次全量确认、取不满 N 根要报错）。

## 2 环境与配置

### 2.1 起环境

```bash
pnpm install           # TS 依赖（Node >= 22、pnpm 见 §2.4）
pnpm py:sync           # Python 依赖（uv >= 0.11，Python >= 3.12）
cp .env.example .env   # 项目内配置，按注释改
docker compose up -d   # PostgreSQL 16，变量取自 .env
```

本机没有 Docker Desktop 时用 colima（本仓库 docker context 指向它）。注意 colima 默认只挂
`/Users`、**不挂 `/Volumes`**——仓库在 `/Volumes/...` 时绑定挂载会被当成不存在的源路径。

### 2.2 配置只走仓库根的 `.env`

**不要让用户往 shell 里 `export`。** 规则是「**每个进程入口都调 `loadProjectEnv()`**
（[`packages/core/src/env.ts`](packages/core/src/env.ts)）」。当前四处，缺一不可：

```
apps/cli/src/index.ts   apps/sync/src/main.ts   apps/web/src/main.ts   apps/executor/src/main.ts
```

**新增入口必须照做**，且必须在任何读 `process.env` 的模块之前调用。已经存在的环境变量
**不会被 `.env` 覆盖**（CI / 生产注入的值优先）。
[`packages/data/src/bridge.ts`](packages/data/src/bridge.ts) 透传 `process.env`，
因此 Python 子进程自动继承同一份配置。

加一个新变量要三步，缺一不可：

1. 写进 [`.env.example`](.env.example)，**带注释**说明作用、默认值与不改的后果；
2. 在入口加载（已存在的那四个通常不用动，新入口要动）；
3. 读不到时抛 `SyncError('CONFIG_INVALID', …)`，并说清**怎么配**。

模板里没有的变量视为不存在（已有一处例外，见 §7）。

### 2.3 变量总表

| 变量                                                    | 作用 / 坑                                                                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRADE_TOOL_HOME`                                       | 工作根：配置文件、`data/cache`、`data/raw`、`data/meta`、`reports/`。**必须绝对路径**（相对路径按 cwd 解析，而各处 cwd 不同）                                                                 |
| `TRADE_TOOL_PG_{HOST,PORT,USER,DATABASE,PASSWORD}`      | 本地 PG，默认与 [`compose.yaml`](compose.yaml) 同源（`trade` / `trade_tool` / 5432）                                                                                                          |
| `TRADE_TOOL_PG_DSN`                                     | 交给 Python 的完整连接串，由 TS 拼好注入。**只经环境变量，不进 argv**（不进 `.env.example`）                                                                                                  |
| `TRADE_TOOL_WEB_{HOST,PORT}`                            | 控制面监听（默认 `127.0.0.1:8787`）。**不要改成 `0.0.0.0`**：本期无鉴权，见 §6.6                                                                                                              |
| `TRADE_TOOL_BINANCE_BASE_URL`                           | 覆盖交易所 **REST** 基址，Python 侧读它（`quant_data/http.py`）。**不要拿它切环境**：本地跑 Demo 用 `executor.environment = demo`，那时由 TS 往子进程注入 demo 基址；测试用它指向本地假交易所 |
| `TRADE_TOOL_BINANCE_DEMO_STREAM_URL`                    | Demo 用户数据流**基址**（不带 `/private/ws?listenKey=`）。只在 `executor.environment = demo` 时必填，本仓库**不内置默认值**                                                                   |
| `TRADE_TOOL_BINANCE_API_KEY` / `_API_SECRET`            | 行情同步**不需要**；只有 `apps/executor` 下单用。名字可由 `executor.apiKeyEnv` / `apiSecretEnv` 改                                                                                            |
| `TRADE_TOOL_SECRET_KEY`                                 | 凭据静态加密主密钥（32 字节 = 64 位 hex 或 44 位 base64）。**丢了就解不开库里的密文**，只能重新录入，见 §6.4                                                                                  |
| `TRADE_TOOL_FEISHU_WEBHOOK_URL` / `_SECRET`             | 飞书自定义机器人的 webhook 地址（**它本身就是凭据**）与可选的签名密钥。只在 `notify.enabled = true` 时需要，见 §6.9                                                                           |
| `TRADE_TOOL_TEST_PG_{HOST,PORT,DATABASE,USER,PASSWORD}` | 测试库连接参数覆盖（默认同上）。Python 侧另认 `TRADE_TOOL_TEST_PG_DSN`                                                                                                                        |

只在 `deploy/` 里出现、本机开发用不到的：`TRADE_TOOL_IMAGE`、`TRADE_TOOL_PG_BIND`、
`TRADE_TOOL_{HTTP,HTTPS,NO}_PROXY`、`TRADE_TOOL_NODE_OPTIONS`、`TRADE_TOOL_PG_WAIT_SECONDS`、
`TRADE_TOOL_SKIP_MIGRATE`。见 [`deploy/.env.example`](deploy/.env.example)。

### 2.4 pnpm 的两个坑

1. **pnpm 必须与 `package.json` 的 `packageManager` 一致**（当前 `pnpm@11.23.0`）。不一致时
   仓库内**任何** pnpm 命令都会以 `Cannot verify the identity of the @pnpm/exe…` 失败，
   `pnpm -v` 也不例外。`engines` 只声明了 `node`，pnpm 的版本约束**机器不可校验**——
   唯一的自动防线是 [`deploy/Dockerfile`](deploy/Dockerfile) 走 corepack（而不是
   `npm i -g pnpm`，正是为了这条）。
2. **pnpm 11 会拦截依赖的构建脚本**。当前只批准了 `esbuild`
   （[`pnpm-workspace.yaml`](pnpm-workspace.yaml) 的 `allowBuilds`）。新增带 postinstall 的
   依赖时，**不要用 `--ignore-scripts` 绕过**，而是把包名加进 `allowBuilds` 并在提交说明里
   写清理由。

## 3 提交前必跑

| 你改了什么     | 跑什么                                                            |
| -------------- | ----------------------------------------------------------------- |
| 任何东西       | `pnpm check`（= `build && test && py:test`）                      |
| TS 类型 / 接口 | 再加 `pnpm typecheck`                                             |
| Python         | 再加 `pnpm py:lint`（ruff）、`pnpm py:typecheck`（mypy --strict） |
| 任意文件格式   | `pnpm format:check`（Prettier）；Python 侧 `pnpm py:format`       |
| 文档           | `npx prettier --write <目标文件>`                                 |

四件必须说清的事：

- **`pnpm check` 不做类型检查、也不做 lint。** 它绿了不代表能提交（定义见
  [`package.json`](package.json)）。
- **`pnpm lint` 是空转**：根脚本存在，但七个 workspace 包都没有 `lint` 任务，Turbo 会打印
  `No tasks were executed…` 并以 0 退出。别把它当成检查过了。
- **ruff 忽略 `RUF001/002/003`**：本仓库注释是中文，全角标点会被误判成「易混淆的同形字符」，
  不要去「修」这些全角标点。测试目录另有 `N802` / `ANN401` 忽略（中文用例名、替身工厂）。
- **仓库里没有 CI**。上面这张表全靠人与 agent 自觉执行，没有机器兜底。

## 4 新代码放哪儿

| 新东西                                       | 放哪                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| 领域类型、配置 schema、错误码、纯函数判据    | `packages/core/src`                                                       |
| 行情接入、缓存、Python 调用                  | `packages/data/src`                                                       |
| **数据库表结构 / 迁移（唯一来源）**          | **`packages/data/sql/`**                                                  |
| PG 客户端、schema 闸门、查询层               | `packages/data/src/db`                                                    |
| **派生周期（桶对齐 / 覆盖判据 / 聚合）**     | **`python/packages/quant-data/src/quant_data/aggregate.py`**              |
| **带时间锚的取数（如「按成交时刻算 ATR」）** | **`python/packages/quant-data/src/quant_data/risk.py`**                   |
| **技术指标公式（全仓唯一一份）**             | **`python/packages/quant-core/src/quant_core/indicators.py`**             |
| **私有交易接口（下单 / 用户数据流）**        | **`packages/data/src/binance-private.ts`**                                |
| 止盈止损编排、幂等、执行记录                 | `apps/executor/src` + `packages/data/src/db/risk.ts`                      |
| **凭据静态加密**                             | **`packages/core/src/secret.ts`** + `packages/data/src/db/credentials.ts` |
| **告警通道（飞书推送、去重与冷却）**         | **`packages/core/src/notify.ts`**（转换在 `apps/executor/src/alert.ts`）  |
| **通知设置的读写与「哪一份在生效」**         | **`packages/data/src/db/notify.ts`**（密文落库 + 优先级解析）             |
| **新策略 / 回测引擎**                        | **`python/packages/quant-backtest/src/`**                                 |
| 命令行命令                                   | `apps/cli/src/commands/`                                                  |
| 常驻同步、生命周期、控制原语                 | `apps/sync/src`                                                           |
| 控制面 HTTP 路由与前端页面                   | `apps/web/src` + `apps/web/ui`                                            |
| **部署镜像与编排（服务器）**                 | **`deploy/`**（根 [`compose.yaml`](compose.yaml) 只是本机开发库）         |

`packages/backtest` 已退场，不要再往 TS 侧放回测或指标。

## 5 硬性约定

> **编号是锚点，只许追加。** 当前被代码引用的号：2（跨语言契约）、3（schema 唯一来源）、
> 4（纯函数 / 指标唯一）、5（barrel / 单一类型名）、7（Python 类型）、8（配置缺失即报错）、
> 9（不静默兜底）、10（不硬编码标的）。要改这些号的语义，先
> `grep -rn "AGENTS\.md" --include=*.ts --include=*.sql .`。

1. **依赖方向单向**：`core` 不依赖任何 workspace 包；包之间只依赖 `core`；跨语言调用只从
   `packages/data` 发起。出现反向依赖说明分层错了（例：把序列生成器放进 `quant_data`
   会逼回测反向依赖同步层，所以它在 `quant_core`）。
2. **跨语言契约 = 数据库 schema**：改 schema 必须**同提交**更新迁移文件与两侧读写代码，且两侧
   对同一列的类型 / 单位 / NULL 语义一致。接缝上另有几条固定值，改动前先读
   [`packages/data/README.md`](packages/data/README.md#跨语言约定)：

   - Python 模块以 `-m` 启动，因此 `src/quant_x/__main__.py` 必须存在；
   - 成功时 stdout 是**单个 JSON 摘要**（K 线不经 stdout，唯一例外是离线合成源 `generate`）；
     日志一律 stderr，stdout 里不允许出现 `NaN` / `Infinity`；
   - 失败时退出码非 0，且 **stderr 最后一行**固定为
     `QUANT_DATA_ERROR {"code":…,"message":…,"details":…}`，错误码与 `SyncErrorCode` 一一对应；
   - 时间统一毫秒时间戳，数据库列用 `bigint` 而不是 `timestamptz`；
   - PG 连接串经 `TRADE_TOOL_PG_DSN` 环境变量注入，**不进 argv**（否则密码会出现在 `ps` 里）；
   - `quote_volume` / `trades` 的 NULL 语义严格是「交易所未提供」，**禁止用 0 冒充缺失**；
   - 密钥类配置一律「只写环境变量名」：配置文件里出现明文密码会被直接拒绝
     （`database.password`、`executor.apiKeyEnv` 是这套做法的两个样本）。

3. **schema 唯一来源是 `packages/data/sql/*.sql`**：不得在 TS 或 Python 侧另持影子定义
   （包括「把判据的形状抄成列」这种变体）。Python 测试也直接执行这些 SQL 文件。
4. **策略与指标都是纯函数**：输入等长序列、输出等长数组；不读时钟、不做 IO、不用随机数。
   指标公式**只允许**出现在 `quant_core`；策略只消费指标序列，不在引擎里写公式。
5. **对外导出走 barrel，同一概念只有一个名字**：包内模块互相 import 用显式 `.js` 后缀，
   对外只从 `src/index.ts` 导出（`apps/web` 是 HTTP 服务，没有 `src/index.ts`，属正常）。
   一个类型若已归某个模块所有（如 `RemovePolicy` 归 `market-sync.ts`），别在别处再起一个同名
   或同义的；转发可以，重写不行。
6. **tsconfig 不复制**：一律 `extends` `@trade-tool/tsconfig/*`。已知例外只有
   `apps/web/ui/tsconfig.json`（前端 JSX 需要独立配置）——不要照它抄，新包用
   `@trade-tool/tsconfig/*`。
7. **Python 类型**：`mypy --strict` 必须过，公开函数全标注类型。**不要用 `# type: ignore`
   掩盖问题**（它会静默关掉整条检查）；确实需要收窄时用 `cast`，并让理由留在代码里。
8. **配置与外部输入缺失就报错**：读不到 DSN、密钥、端点、周期白名单外的值时，一律
   `CONFIG_INVALID` 并说清怎么配。**不放宽、不回落、不猜、不用 0 / 空值 / 默认周期顶替**
   （「拿不到就回落到主网」「未知周期当 1m」都属于这一类）。
9. **不静默兜底**：跨语言调用、IO、配置加载、PG 查询失败一律抛错并给出可读信息，不返回空值
   假装成功。控制面侧同一条：**读取失败必须常驻可见**，不能只弹一下 toast。
   「看起来成功其实没做事」比「立刻报错」危险得多——设计接缝时优先选后者。
10. **不硬编码标的**：同步链路里不得出现具体合约名（测试 fixture 是唯一例外）；标的合法性一律由
    运行时元数据（`exchangeInfo` 的 `status` / `contractType` / `onboardDate`）判定，
    标的集合是动态的。`defaultConfig()` 里的 `market.symbol` 是**有意的例外**，它只服务离线
    合成源与回测，同步链路不读它（见 §7）。
11. **写入只走 `packages/data`**：`apps/*` 不得直接连 PG（`pg` 只出现在 `packages/data`），
    控制面与守护进程都不例外（v0.1.0 R-2.4）。业务写入的边界另见
    [`packages/data/README.md`](packages/data/README.md#写边界)：K 线、水位、`sync_state` 的推进
    **全部在 Python 侧的事务里**完成（因为 `COPY` 只发生在 Python 进程内），TS 侧只写标的集合
    这类元数据。

## 6 各层规矩

`R-*` / `AC-*` 编号出自 [`docs/`](docs/README.md) 的需求文档。**引用时带版本前缀**
（写成「v0.1.0 R-3.3」），因为编号在不同版本文档里各用各的。

| 层                 | 版本   | 需求 / 设计文档                                                                  | 细节                                                                  |
| ------------------ | ------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 数据底座与同步     | v0.1.0 | [`docs/v0.1.0-…`](docs/v0.1.0-binance-perp-market-sync.md)                       | `packages/data/README.md`、`apps/sync/README.md`                      |
| 派生周期           | v0.2.0 | [`docs/v0.2.0-…`](docs/v0.2.0-multi-timeframe-klines.md)                         | §6.1                                                                  |
| 技术指标           | v0.3.0 | [`docs/v0.3.0-…`](docs/v0.3.0-technical-indicators.md)                           | §6.2                                                                  |
| 止盈止损           | v0.4.0 | **无需求文档**                                                                   | [`apps/executor/README.md`](apps/executor/README.md)、§6.3            |
| 凭据与运行期设置   | v0.5.0 | **无需求文档**                                                                   | [`sql/007`](packages/data/sql/007_executor_settings.sql) 头注释、§6.4 |
| 交易对账           | v0.6.0 | **无需求文档**                                                                   | [`README.md`](README.md) 的对账一节、§6.5                             |
| 两段止盈与移动止损 | v0.7.0 | [`docs/v0.7.0-…`](docs/v0.7.0-staged-take-profit-trailing-stop.md)（**已实现**） | §6.8                                                                  |
| 通知层（飞书告警） | v0.8.0 | **无需求文档**                                                                   | §6.9                                                                  |

### 6.0 迁移与表的索引

schema 的唯一来源是 `packages/data/sql/*.sql`；**每张迁移文件头部的注释就是它的设计理由**，
改之前先读。迁移必须幂等（`IF NOT EXISTS` / 可重复执行的 `ALTER`），因为每个入口启动都会跑一遍。

| 迁移                    | 内容                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `001_init`              | `klines_1m`、`gaps`、`symbols`、`sync_state`、`contract_spec`、`weight_budget`、`schema_migrations`     |
| `002_sync_plan`         | `sync_state.plan_*`（首次全量的规模预估，开启之前就写进去）                                             |
| `003_daemon_heartbeat`  | `daemon_heartbeat`                                                                                      |
| `004_klines_agg`        | `klines_{15m,1h,4h,1d}`（列与 `klines_1m` 逐列一致）                                                    |
| `005_indicators`        | `indicator_{ma,macd,rsi,boll,kdj,atr,obv}`                                                              |
| `006_risk_bracket`      | `risk_bracket`（幂等锚点 + ATR 快照 + `last_error`）                                                    |
| `007_executor_settings` | `executor_credentials`（密文 + 末 4 位提示）、`risk_policy`（global / symbol 两作用域）                 |
| `008_algo_order_ids`    | `risk_bracket` 的条件单编号列改名（Algo 编号空间，与普通 orderId 不通）                                 |
| `009_reconcile_run`     | `reconcile_run`（观测快照）                                                                             |
| `010_risk_trailing`     | 两段止盈的阶段（`partial_armed` / `trailing`）与移动止损档位。**v0.7.0 设计，未落地**                   |
| `011_notify_settings`   | 飞书通知通道的运行期设置（v0.8.0）：地址与签名密钥**密文**落库 + 开关与参数。**新增迁移，两侧都要登记** |
| `012_trade_pnl`         | 盈亏的**事实**（v0.8.0）：`risk_bracket` 增累计平仓量 / 成交额 / 手续费；通知内容类型扩到 11 种         |
| `013_llm_decision`      | LLM 决策的留痕（v0.9.0）：`risk_bracket` 增决策来源 / 生效档位 / 理由 / 降级原因                        |

### 6.1 派生周期层（v0.2.0）

高周期 K 线**只由库内 1m 派生**，不向交易所取。四条不可协商的规则：

1. **判据只有一份实现**：`quant_data.aggregate.judge_bucket`。「能不能写」由它决定，扣留统计与
   `--check` 全部复用它。把判据再抄进一条 SQL，写入与校验就会各有一套规则；一旦漂移，
   `--check` 会对着一条永远不满足的判据报出无穷多个 missing。（当前有一处违反，见 §7 第 1 条。）
2. **只写「已收盘且 1m 全覆盖」的桶**。不足的桶不写，缺口因此原样投影成高周期的空白；
   被扣留的量与原因必须由 SQL 从 1m 推导并报出，**不落「扣留表」**（那是第二套状态）。
   `data.aggregateIntervals = []` 是**显式关闭**，不是静默跳过——关闭状态必须可见。
   **不提供**「放宽覆盖判据」「写半截桶」这类开关。
3. **聚合挂在 1m 的唯一写入出口**（`write_bars_and_aggregate`）并与每批同事务。任何新增的 1m
   写入路径都必须经过它，否则聚合会变成「看运气」——而且是**静默**的。
   ⚠️ 它**自己不开事务**，事务由调用方（`quant_data/sync.py`）开；新增调用方必须自己包事务，
   否则聚合与 1m 会分家。
4. **表名不可参数化**。周期必须先过 `INTERVAL_TABLES` 白名单
   （[`packages/core/src/types.ts`](packages/core/src/types.ts)）再进 SQL；遇到未实现周期
   （`5m` / `2h` / 任意未知值）一律 `CONFIG_INVALID`，绝不静默回落到 1m。

**桶对齐与覆盖判据按桶宽 W 参数化（`bucket_start` 取模，不用 `date_trunc`），不要改判据本身。**
`5m` 仍留在 `INTERVALS` 枚举里（历史遗留），但不在 `STORED_INTERVALS` / `DERIVED_INTERVALS`
里——它是「未实现周期」的活样本，删它之前先看谁在拿它做测试。

新增一个派生周期，要动的**不止**「一列映射 + 一张表」——按顺序过一遍：

1. `packages/core/src/types.ts`：`STORED_INTERVALS`、`DERIVED_INTERVALS`、`INTERVAL_TABLES`
   （三处）。
2. `packages/core/src/config.ts`：`aggregateIntervals` 与 `indicatorIntervals` 的 enum + 默认值。
3. `python/.../quant_data/aggregate.py`：`DERIVED_TABLES` + `BUCKET_WIDTHS_MS`。
4. `packages/data/sql/`：新增一张与 `klines_1m` 同形状的表 + 一轮迁移登记；
   `005_indicators.sql` 里 **7 张指标表**的 `interval` CHECK 白名单要同步加值。
5. `apps/web/ui/src/components/`：`gaps.ts` 的周期表与 `RiskPolicyPanel.tsx` 的白名单。
   （页面上已无指标面板：`indicators.tsx` / `IndicatorPanels.tsx` 与 `/indicators` 路由
   已随「指标层默认关闭」删除，见 §6.2。）
6. `packages/data/src/db/repo.ts` 里控制面用的周期白名单与响应字段。

### 6.2 技术指标层（v0.3.0）

指标实现在 **`python/packages/quant-core/src/quant_core/indicators.py`**，全仓库**唯一一份**；
TS 侧（`packages/*`、`apps/*`）**不得出现任何指标实现**。两侧各有 `sma` 就意味着同一根 K 线上的
同一个指标会因浮点舍入而分叉，症状是「回测赚钱、实盘不赚」且几乎无法定位。

四条不可协商的规则：

1. **参数是数据不是表结构**：`indicator_*` 的参数列直接进主键，改窗口 / 加参数集是
   **插新行、零 DDL**。不得出现 `ma_20` 这类把参数写进列名的形态，也不得用 `params_hash`
   代替可查的参数列。
2. **`impl_version` 进主键**（`quant_core.INDICATOR_IMPL_VERSION`）：口径变更 / 修 bug
   **必须**递增，纯重构不递增。写侧发现混版即抛 `INDICATOR_IMPL_STALE` 拒绝写入。
3. **连续段各自独立重算，段间不递推**：回补一个久远的缺口**不得**静默改写此后的指标值。
   缺口就是噪声，不得跨越。
4. **预热期不落库**：不写 NaN、不写 NULL、更不写 0 冒充缺失。库里每一行都是有效值。
   语义是「**收盘后可用**」，任何画指标线的读侧都必须在缺口处**断开**（不跨缺口连线）。

`window` 是 PostgreSQL 的**完全保留字**，所以参数列名按指标各取本名：MA 用 `bars`，
RSI / BOLL / ATR 用 `period`，KDJ 用 `n` / `k_period` / `d_period`，MACD 用
`fast` / `slow` / `signal`。配置侧一律叫 JS 里的名字（如 `window`），两者**只**经
`quant_data.indicators._CONFIG_KEYS` 映射——别假设所有指标表有一个统一的主参数列名。
BOLL 的 `k` 以**千分之一整数** `kMilli` 存（浮点参数不得进主键）。

两处口径值得记住：**MACD 柱取 `DIF − DEA`**（国际口径；国内软件的 `2×(DIF−DEA)` 请读侧自行
×2），**KDJ 横盘时 `RSV = 50`**（分母为 0 时没有信息，取中性点而不是产生 `NaN`）。
1m 不做指标物化是**容量结论**不是疏漏（单标的 1m 约 320 万行 ≈ 4.3 GB，
四个高周期合计约 386 MB）。

**指标层默认关闭**（`data.indicatorSpecs` 缺省 `{}`，v0.3.0 起缺省是 10 个参数集）。
理由是实测的：物化挂在 1m 的**每批**写入出口上（R-5.1），一轮 43k 根的首次全量被切成
216 批，同一批指标于是被 `216 × 4 × 7` 重写一遍——单轮同步里指标占 **72%** 的墙钟
（profiler：`psycopg.wait` 61.9s/76.8s，纯计算仅 3s），`sync-integration` 从 **698s
降到 301s**。而默认配置下**没有任何消费方读这些表**：

- 止盈止损的 ATR 走 `quant_data.risk`，`ATR_TABLES = {1m: klines_1m, **DERIVED_TABLES}`
  ——**`indicator_atr` 不在链路上，全仓也没有任何读取方**；
- 回测只消费 `quant_core` 的指标序列，不碰指标表；
- 控制面的 `/indicators` 路由与两个 UI 组件已随此次改动删除。

要打开就显式写出参数集（见 `packages/core/src/config.ts` 的 `indicatorSpecs`）。
**不要**把物化重新挂回每批——真要恢复物化，先把它改成一轮一次或按触及区间合并。

### 6.3 止盈止损层（v0.4.0）

成交 → **净仓位** → ATR → 止盈止损。多空都支持。十条**不可协商**的规则：

1. **只用已收盘的 bar**：bar 起点 `t`、桶宽 `W`，则窗口上界是 `time <= asOf − W`。
   把未收盘的 bar 喂进 Wilder ATR，止损位会随价格实时漂移。
2. **不跨缺口**：窗口必须是**极大连续段**的尾部。回补久远的缺口不得改写此后成交对应的 ATR。
3. **取不到就拒绝下单**：`RISK_ATR_UNAVAILABLE`，并说清缺多少根。**绝不**换更小的周期、
   也**绝不**用 0 顶替——ATR=0 会让止损正好落在入场价上（当场平仓）。表上也有 `atr > 0`
   的 CHECK。
4. **先占坑再动手**：`risk_bracket` 的主键 `(exchange, symbol, entry_order_id)` 是幂等锚点。
   用户数据流在续期与重连后会重放事件，而止盈止损是真的会下单。占坑后失败留 `failed` 行 +
   `last_error`，好过「下单成功但没记下来，重连后再挂一次」。ATR 快照与窗口边界随记录一起存，
   好让事后能回答「当时为什么止损在那个价」，而不必复算（复算会因数据回补而变）。
5. **两张单要么都挂上要么都不挂**：先止盈后止损；第二张失败就撤掉第一张。留一张有止盈没止损的
   单，比什么都不挂更危险。反过来先挂止损也不行——止损失败会留下一张撤不掉的止盈单。
6. **REST 基址与用户数据流地址必须来自同一次选择**：`executor.environment`（`live` / `demo`）
   经 [`packages/core/src/exchange-endpoints.ts`](packages/core/src/exchange-endpoints.ts) 的
   `resolveExchangeEndpoints` **一起**解析出两个地址，**不给它们各配一个变量**。只改一半会复现
   历史上那个失败模式：下单进沙箱、成交事件从主网流过来，于是永远等不到挂单，而日志与界面都
   正常。四处 `new BinancePrivateClient`（executor / 对账 CLI / 控制面手动对账 / 测试）
   **一律**走 `exchangeEndpointsFromEnv(config.executor)`，不许各传各的。
   `demo` 的 WS 基址仍**不内置代码默认值**，缺 `TRADE_TOOL_BINANCE_DEMO_STREAM_URL`
   就抛 `CONFIG_INVALID`——启动时炸好过接一条猜出来的流。**但"两种说法互相矛盾"已经过时**：
   2026-10-15 核对官方 USDⓈ-M Futures General Info 的 "Testnet API Information"，
   现行答案是 `wss://demo-fstream.binance.com`（REST 为 `https://demo-fapi.binance.com`，
   与代码里的 `DEMO_REST_BASE_URL` 一致）；另一个候选 `fstream.binancefuture.com`
   在同日只读探测里返回 404，已不是有效基址。本地要跑沙箱就改这一处配置，
   不要拿 `TRADE_TOOL_BINANCE_BASE_URL` 凑：它只覆盖 REST，而且 `demo` 下这个基址本来就由
   `pythonEnvFromEnv` 注入 Python 子进程，人去设它只会造出「下单在 demo、行情在主网」的
   又一处分叉。
   Binance 已于 2025-08-27 关停老 Futures Testnet，`testnet.binancefuture.com` 只在
   **尚未更新的单 endpoint 文档页**里出现；权威来源是 General Info 页——它同时也是上面
   那个 demo host 的权威来源。
7. **开仓 / 减仓 / 平仓由净仓位的符号判定，不由成交方向判定**（v0.4.1 支持做空时新增）。
   「一笔 SELL 是开空仓还是平多仓」不能只看方向——交易所的净仓位才是事实。
   v0.4.0 的「`side !== 'BUY'` 即忽略」在只做多时成立，支持做空后它是**错的**：
   会把开空仓当减仓忽略，把减多仓当开空仓挂上一整套保护。判据三段：
   净仓位 `= 0` → 工具外平仓；符号与方向相反 → 减仓，忽略；符号与方向一致 → 新开仓。
   判据是纯函数 `classifyFill`，净额由 `packages/core/src/net-position.ts` 的
   `NetPositionTracker` 维护，**只有一份实现**（AGENTS.md §6.1 第 1 条的同一原则）。

   **净额怎么来（这里踩过两个坑）**：
   - ❌ 不能从 `ORDER_TRADE_UPDATE` 里取 `a.P`：USDⓈ-M 上这个**订单**事件不带仓位，
     仓位在 `ACCOUNT_UPDATE` 里。实测该字段恒为 `null`——那是死代码。
   - ❌ 也不能改成「等 `ACCOUNT_UPDATE` 到了再处理成交」：官方只保证**同一事件类型内部**
     按 `T` / `E` 严格有序，两类事件之间**没有顺序保证**，成交事件完全可能先到。
   - ✅ 取法：**流内增量净额**——启动时从 `positionRisk` 播种一次，之后每笔成交
     `净额 += ±lastFilledQty`。单向持仓模式下与交易所逐笔等价，且不依赖事件顺序、
     不需要每笔出网。`ACCOUNT_UPDATE` 只作**校正信号**（收到就覆盖），不作来源。
   - `main.ts` 必须**启动时与每次重连后各播种一次**：断线期间事件不重放，
     沿用旧净额会让之后每笔成交的「开仓 / 减仓」判定都建立在错误基线上。
   - 净额归零（`ACCOUNT_UPDATE` 或成交判定得到）时**顺手把未终结记录收敛成
     `cancelled`**，否则那条僵尸行会挡住该标的后续所有新开仓。
     ⚠️ **但只有成交事件能做这件事**。`ACCOUNT_UPDATE` 看到「归零」时**分不清是
     我们的条件单成交还是用户手动平仓**，抢先收敛会与 `settle()` 并发写同一行：
     实测（2026-10-16）止损成交被记成「工具外平掉」，终态 `stop_loss` 被覆盖成
     `cancelled`——最该被看见的一次交易被抹掉了。所以收敛一律交给成交判定，
     兜底放在**重连 / 启动播种之后**（那个时刻没有任何在途事件，见 `main.ts`
     的 `seedNetPositions()` → `convergeFlatPositions()`）。
   - `ACCOUNT_UPDATE` 校正净额时**不要**打「流内增量曾失步」的警告：账户事件先到是
     **正常时序**，那笔成交会被下面的撮合时间去重跳过，净额随即收敛。把它当异常报，
     每次正常平仓都会误报一遍。失步的真正可观测信号是对账的 `record-without-position`。
   - 撮合时间去重**只能跳过累加，不能跳过判定**：那笔成交正是把仓位变平的一笔，
     `classifyFill` 必须看它，否则工具外平仓的收敛又会被跳过。
   - 同一标的的事件**仍然要串行**：`onmessage` 每条消息各起一个 Promise，
     而 `closeOutside` 与 `settle` 会并发写同一行。日志用 `markBracketSettled` 的
     `rowCount` 判断「真的更新了」——否则两条并发路径都会宣称「N 条已收敛」。
   - 浮点残差必须用容差（`POSITION_EPSILON = 1e-9`）判空仓：逐笔累加后
     `-0.1 + -0.05 + 0.15` 得到的是 `-2.8e-17`，写成 `=== 0` 会让平仓永远不被识别。
   - **双向持仓模式直接拒绝**：两侧净额相消得 0，会把「仍有仓位」误判成已平仓。
   - `openUserDataStream` 的 `onmessage` 是每条消息各起一个 Promise、彼此不排队，
     而净额是逐笔累加的，因此 `main.ts` 另有一层**按 symbol 串行**（`createSerialRunner`）。

8. **私有请求的时间戳必须校准**（v0.4.1 新增）。签名里的 `timestamp` 与
   `recvWindow` 是**防重放**机制，它假定本机与交易所时钟同源。本机时钟偏 1 秒就会让
   **每一个**私有请求吃 -1021——挂单、撤单、对账、续期 listenKey 全在里面，
   而报错长得和普通网络故障一模一样。实测 demo 端点对未来时间戳的容差是**硬的
   ~1000ms**，`recvWindow` 调到 60000 也无效，所以调参救不了。
   进程启动时用**无签名**的 `/fapi/v1/time` 测量偏移（`packages/core/src/clock-skew.ts`），
   签名时减掉，并把补偿量打到启动日志与 `doctor` 里——**补偿必须可见**，
   否则就是约定 9 说的「看起来成功了，其实什么都没做」。偏移超过 60 秒直接抛错
   并指向修系统时钟：那个量级不是可补偿的误差。
9. **同一标的不叠第二套 `closePosition`**。占坑的幂等键含 `entry_order_id`，
   它防的是「同一入场订单被重复处理」，**不防**「同一仓位被挂了两套保护」。
   两张单都是 `closePosition=true`、不带数量，保护的是**当时全部净仓位**而非各自那一笔，
   于是加仓或反手会得到多组触发价重叠的保护。新开仓前先查该标的未终结记录，
   命中就**跳过并留 `warn`**，不改写旧记录（「加仓后止损该不该移动」是策略决策，不是程序
   该擅自做的）。**排除同一笔 `entry_order_id` 自己**——事件重放走的是幂等那条路，
   报成跳过会把真正的原因掩盖掉。
10. **工具外平仓必须能收敛成 `cancelled`**。在交易所 App 上按一次平仓，本地不会收到
    任何事件（本服务只认 `rsk-` 前缀的单），记录会永远停在 `armed`，之后每 5 分钟报一次
    `missing-stop-order`（紧急）；更坏的是这条僵尸行在反向仓位存在时替它「顶包」，
    把 `record-without-position` 一并掩盖掉。**行不删**：主键是幂等锚点，删了行，
    万一该入场订单的事件被重放，`ON CONFLICT DO NOTHING` 就挡不住重复挂单。

Binance U 本位**没有单请求 OCO**（`/fapi/v1/order/oco` 已下架）：用 `TAKE_PROFIT_MARKET` +
`STOP_MARKET`（`closePosition=true`），**下单走 `POST /fapi/v1/algoOrder` +
`algoType=CONDITIONAL`**（不是 `/fapi/v1/order`），仓位平掉后另一张**由交易所自动撤销**。
因此本地**不轮询、不盯市**——不要在控制面或守护进程里再实现一套「触发后撤另一张」的逻辑。

⚠️ **v0.7.0 会动这个模型**（分批止盈 + 移动止损）：第一段止盈必须带 `quantity`，
因而**不再享有自动撤销**。改这个模型前先读 §6.8 与需求文档；上面这段里
「自动撤销」的说法在分批形态下只对**止损单**成立。

两张单都朝**远离入场价**的方向对齐到标的的最小价格变动（`alignToTick`，按步长整数倍对齐，
不是按 tickSize 的小数位数——`tickSize = 0.5` 时两者结果不同）。按四舍五入把止损往入场价挪
半个 tick，就足以让「2×ATR 的止损」变成刚挂上就必被扫。

条件单编号 `rsk-<tp|sl>-<entryOrderId>` 在
[`packages/core/src/risk-ids.ts`](packages/core/src/risk-ids.ts)，**下单与对账共用一份**：
两处各写一遍前缀解析，漂移的症状是「止损挂在错误的仓位上」，而两边日志都完全正常。
`orderType` 在**查询侧**回 `TAKE_PROFIT` / `STOP`、**下单侧**发 `TAKE_PROFIT_MARKET` /
`STOP_MARKET`，两套取值都必须原样透传给 `algoOrderTag()`，**不要**在解析层「顺手统一」——
统一掉差异，判据就失去了依据。

保守默认值（都会变成真实的平仓指令，所以取保守的一侧）：`executor.enabled = false`、
`workingType = MARK_PRICE`（抗插针）、`onPartialFill = ignore`（部分成交不重算）。

新增口径时：策略放 `packages/core/src/risk-policy.ts`（纯函数），ATR 取数放 `quant_data.risk`，
交易所差异放 `packages/data/src/binance-private.ts`，执行记录放 `sql/006_risk_bracket.sql` +
`packages/data/src/db/risk.ts`。

### 6.3.1 用户数据流的连接纪律

重连循环**必须先 `closeListenKey` 释放上一个 key，再 `createListenKey` 申请新的**。
Binance 在账户已有有效 listenKey 时，`POST /fapi/v1/listenKey` 会**返回现有那个**，
而一个 listenKey 只允许一个活跃连接——于是每次重连都在拿同一个 key 建新连接，
旧连接尚未被服务端回收，两者互相挤掉，症状是「连上马上断、来回抖几次」。

实测（2026-10-16）：不释放时，进程内所有连接都是同一个 key，启动后连断 2~3 次才稳定；
释放后启动即稳定。释放失败**不阻止重连**（key 可能已过期，而拿不到旧连接正是我们要的）。

**为什么这件事必须认真对待**：用户数据流**不重放**断线期间的事件。断线窗口里发生的成交
永远不会被处理，因此**不会为它补挂止盈止损**——结果是裸仓。重新播种只修正仓位账本，
补不出保护。当前设计靠对账的 `position-without-record`（紧急）把这种裸仓暴露出来，
即「可见但不自动修复」；是否补挂属于策略决策（要用到那个时刻的 ATR 快照），
不要在对账或重连里顺手加上。

### 6.4 凭据与运行期设置（v0.5.0）

v0.5.0 把「密钥只从环境变量读」改成「**也可以从控制面录入，但落库必须是密文**」。
约束换了落点，没有消失：

1. **密文才准落库**：AES-256-GCM，主密钥来自 `TRADE_TOOL_SECRET_KEY`（32 字节，64 位 hex 或
   44 位 base64；长度不对**直接拒绝启动**——截断的密钥「凑合能用」是最坏的结果）。
   每次写入**重新生成 12 字节 IV**：IV 复用不是「稍微弱一点」，是直接摧毁 GCM。
   选 GCM 是因为它自带认证标签：密文被改过会解密失败，而不是安静地解出一段垃圾去签名请求。
2. **明文不出边界**：只有 `apps/executor` 会解密；控制面的读取路径**只回「配没配」与末 4 位**
   （`key_hint`），不回显、也读不回明文。加密的承诺只是「库被整个拖走时拿不到可用密钥」，
   拿到运行中的进程仍然能解——**别把「加密了」当成「安全了」**。
3. **「从未配置」与「主动清空」必须分开**：行不存在 = 从未配置，`key_hint` 为空串 = 用户主动
   清空。不要用 NULL 把两者糊在一起。
4. **取值范围只有一份**：`risk_policy` 的倍数 / 周期取值范围照抄 `executorSchema`
   （[`packages/core/src/config.ts`](packages/core/src/config.ts)），页面校验、schema CHECK、
   纯函数校验三处**不许各写各的**，否则会出现「页面能填、库里存得下、纯函数算不出来」的组合。
   `global` 与 `symbol` 两个作用域的「symbol 该不该有值」用 CHECK 钉在 schema 里。
5. **改完凭据要重启 executor**：它在启动时读凭据；控制面改完只影响下一次 executor 启动。
6. 默认 `executor.enabled = false`（会真下单的服务不该因为「装了包」就在跑）。
   同理，部署时它在 compose 的 `executor` profile 里，`docker compose up -d` 不会启动它。

控制面的写操作还有一条安全线，见 §6.6。

### 6.5 交易对账层（v0.6.0）

止盈止损只有写入侧，而**占坑（PG）与下单（交易所）无法原子提交**——进程死在中间是必然的。
这类漂移不产生任何日志：用户数据流不重放历史，页面又只读本地表，于是「本地记着 `armed`、
交易所那张单早没了」能一直安静地存在。四条**不可协商**的规则：

1. **只报告，绝不动手**。判据是 [`packages/core/src/reconcile.ts`](packages/core/src/reconcile.ts)
   的纯函数：不写库、不下单、不撤单，处置一律人工决定。补挂一张止损会平掉真实仓位且不可逆——
   「自动修复」与「报告」的风险完全不对称，因此**不要**在对账里加任何写操作。
   对账链路唯一的写入是**观测快照表** `reconcile_run` 本身，除此不碰任何表（尤其
   `risk_bracket`）。
2. **判据只有一份实现**，CLI 与控制面共用。两个出口给出不同结论的那一天，报告就再也没人敢信了。
   新增差异类型时同时更新两处出口的呈现，而不是各写一份判断。
3. **范围必须一致**：本地查了哪个标的，交易所就只查哪个标的。拿全账户的快照去比一条单标的的
   本地记录，会报出一条纯属虚构的「止损单不见了」——那是最容易被当真、也最经不起推敲的假警报。
4. **严重度按「仓位是否有止损保护」分档**，不按「是否异常」分。「本地记着已挂单却没有止损单」
   是紧急，「只有止损没止盈」只是注意；合成一档就是把最要紧的那种淹掉。七个差异类型的严重度见
   [`README.md`](README.md) 的对账表。

对账**必须出网**（签名访问私有接口），因此**自动周期对账放在 `apps/executor`**（本来就常驻、
本来就持有凭据、本来就在用户数据流旁边），**控制面不许再起守护进程**；控制面只保留一条
**一次性**的手动入口（详情页的「立即对账」按钮，走 `GET /api/symbols/:symbol/reconcile`，
它确实会出网并覆盖快照）。落地口径：

- `executor.reconcileIntervalMs`（默认 **5 分钟**，`0` 关闭）：启动立刻跑一次，之后按周期跑。
  启动就跑是因为重启往往正是漂移产生的时刻（进程死在占坑与下单之间）。
- **默认全账户**，不是逐标的：全账户是 `positionRisk`（权重 5）+ `openAlgoOrders`（**40**）
  各一次，而逐标的各带一次 symbol（5 + 1）——全账户既更便宜、覆盖也更全，正好能抓到
  「在交易所 App 上手动开的仓」这类工具外的仓位。（5 / 40 有代码注释依据；「45」与「逐标的 6」
  只是那两处的算式，没有常量也没有断言测试，别当成会自我校验的事实。）
- **对账失败绝不影响挂单**：它是旁观者，抛出去就等于「对账挂了 → 止盈止损也停了」。
- 结果落 `sql/009_reconcile_run.sql`，**每个 `(exchange, scope)` 保留最近 50 次**——注意裁剪
  写在 TS 侧（`packages/data/src/db/reconcile.ts` 的 `KEEP_PER_SCOPE`），不在迁移里。
  这张表是**观测快照**，不是判据、也不是任何写路径的依赖——删掉它只会让界面变盲，
  不会改变一笔止损的存亡。
- 控制面读这张表（纯读本地库，因此可以挂刷新节奏）。快照**会过期**，所以查询时间常驻可见，
  超过 15 分钟在界面上标出「已过期，请以「立即对账」为准」。
- 「从没跑过」必须返回 `null` 而不是空报告：「还没对过账」与「对过了、一致」在界面上必须能
  分开说。
- 差异除了进日志，还会经**通知层**推到飞书（§6.9）。那仍然是「只报告」：不改任何账本，
  也不碰交易所——**告警不是处置**，处置一律人工决定。

### 6.6 控制面（apps/web）

日常操作的网页形态。做法上有五条**硬约束**，改代码时别绕过：

1. **重活儿不阻塞 HTTP**：几十分钟量级的操作要么只写意图、要么只登记 job 并返回 id，
   都不许把 HTTP 请求挂在原地等（v0.1.0 R-17.6）。「开始同步」走的是「先算规模 → 写
   `desired_state`」，由 `apps/sync` 去跑；`verify` / `aggregate` 才登记 job。
   凡是 job，进度每次从 `sync_state` 重读，不许用内存计数当进度。
2. **单写者**：控制面作业不得接管 `desired_state = running` 的标的，返回 409 并提示先 pause——
   那是 `apps/sync` 守护进程的地盘（v0.1.0 R-3.3）。页面与守护进程靠「先落库再生效」协作，
   **不要**在控制面里再起一个守护进程。（生命周期动作 `start` / `pause` / `resume` 本身是
   幂等的，**故意不 409**；409 只针对作业。）
3. **首次全量必须先算规模**（v0.1.0 R-8.3），没有「缩短范围」的选项。判据是前端的
   `sync_state.rows > 0`：没有历史要先 `GET /api/symbols/:symbol/estimate` 并要求确认，
   已有历史只是增量。注意**服务端不强制**这一步——闸门在前端，直接 POST 生命周期不会被拦；
   另外这个判据看的是 `sync_state` 而不是 `klines_1m`，「用 `data fetch` 写过但没进集合」的
   标的会被判成「没有历史」（多弹一次确认，不会漏数据）。
4. **不假装在同步**：「开始同步」只写 `desired_state`，干活的是独立进程 `apps/sync`。
   守护进程离线时页面必须如实显示（横幅 + 卡片 + 按钮标签），不允许出现「显示同步中、
   数据却不动」的界面。存活读 `daemon_heartbeat` 表，三态 `running` / `stale` / `stopped`
   分开（处置方式不同：继续用 / 查日志 / 去启动）。心跳的语义是**「同步循环在跑」**，
   不是「进程在」：定时器（10s，`HEARTBEAT_INTERVAL_MS`）必须独立于同步轮次（只在轮次边界
   写会被长达几十分钟的首次全量误判成离线），但**循环退出时必须一起停**——否则全局性错误让
   循环退出后心跳还在刷，页面会把死循环读成在线，正是这条禁止的界面。判 `stale` 的阈值是
   `max(60s, 心跳间隔 × 3)`。**优雅退出删行**（让「行不存在」= 确切离线）；被强杀删不掉，
   由阈值兜底判成 `stale`——不要改成「退出时统一不删」，那会把离线说成在线。
5. **K 线只画真实的行**（v0.1.0 R-23）：`/api/symbols/:symbol/bars` 是**纯读**——只打 PG，
   不出网、不消耗交易所配额，因此才能挂在 5s 刷新节奏上。`?interval=` 缺省 `1m`；
   非法或**未实现**的周期（`5m` / `2h` / `foo`）必须 400，**不得静默回落**到 1m——用户以为
   在看 4h、实际拿到 1m，正是最典型的静默兜底。横轴按**时间**排（缺口要显形成空白），
   **不按行序**排；缺一根就是空一根，不插值、不拿均价线顶替。缺口在图外量化写明（缺多少
   **根** / 几段 / 最长多长），**按所选周期报**——把 1m 的分钟数原样贴到 4h 图上是错的
   （「上游 1m 缺了多少分钟」是另一套口径，前端会分开折算，别混）。取数量有上限（2000）且
   **回传生效值**：非法 `limit`（0 / 负数 / 小数 / 非数字）报错，**超上限是截断到 2000 而不是
   报错**；读失败常驻可见。`/bars` 的 **404 要单列**成「控制面还是改动前启动的旧进程，
   请重启」——路由在启动时注册，这一句比 `404 Not Found` 有用得多。改这张图时别把它换成
   「按序号排的通用图表」——那会把空洞压成连续走势。桶宽来自**服务端回传的 `intervalMs`**，
   不在前端算（写死 `60_000` 会把「4h 图上缺一根」说成「缺一分钟」；前端另有一个
   `DEFAULT_BAR_MS` 兜底常量与一份展示用周期表，但缺口折算必须用服务端值）。

> **指标路由已移除**：`GET /api/symbols/:symbol/indicators` 与页面的指标面板已随
> 「指标层默认关闭」删除（§6.2）。K 线图因此只剩蜡烛与真实缺口，`/bars` 的上述约束
> 全部不变。要恢复指标展示，先按 §6.2 打开物化，再把读路径加回来——不要只加回路由，
> 那会画出库里根本没有的行。

另有两条与安全 / 依赖有关的固定做法：

- **控制面没有鉴权**，且能触发全量拉取、能读库里的全部数据，还能写交易所密钥。因此默认只绑
  `127.0.0.1`，并把 `TRADE_TOOL_WEB_HOST` 在 `.env.example` 里**刻意保持注释**；写操作另做
  来源校验（[`apps/web/src/csrf.ts`](apps/web/src/csrf.ts) 的 `checkOrigin`：有 `Origin` 必须
  同源，没有则放行 curl / CLI / executor）。改动监听地址或写操作路由前先想清楚这一条。
- **只用浏览器原生控件**，不引入 UI 组件库（`apps/web` 的运行期依赖只有 react / react-dom /
  recharts / hono）。弹窗用原生 `<dialog>`；jsdom 用例要按
  [`apps/web/tests/ui/setup.ts`](apps/web/tests/ui/setup.ts) 的方式打桩。

标的口径是 `symbols` 集合 ∪ `sync_state`，与 `readGlobalSummary` 的计数保持一致；只列集合成员
会让「用 `data fetch` 写过但没进集合」的标的带着真实数据从页面上消失。

路由只依赖 `WebDeps` 接口，测试用纯替身（不连 PG、不出网）。

### 6.7 回测与加一个新策略

回测的实现全在 Python：`python/packages/quant-backtest/src/quant_backtest/`。成交模型是
**信号在 `t` 收盘确认、成交在 `t+1` 开盘**；唯一策略 `signals_from_ma_cross` 内联在
`engine.py`，它只消费 `quant_core` 的指标序列（`sma`），**引擎内不得写任何指标公式**。
回测报告里的数字会因这个成交模型而与旧版本**有意不同**（旧实现「以本根收盘价成交」
是一个可复现的未来函数）。

> **先说清两个缺口，免得你照更旧的描述动手**：`backtest.strategy` 目前是**死配置**
> （`quant_backtest/__main__.py` 把 `"ma-cross"` 硬编码，
> [`packages/core/src/config.ts`](packages/core/src/config.ts) 的 `backtestSchema.strategy`
> 从未被读取，CLI 只读 `backtest.params`）；回测也**只吃合成数据**（`--source` 的取值只有
> `synthetic`）。所以「新增一个策略」不是照 5 步做，而是**先补出策略注册 / 分派层**。
> 两条都记在 §7。

现在能照做的是这几步：

1. 策略函数写进 `quant_backtest/`（新文件或 `engine.py` 旁），**只消费 `quant_core` 的指标**，
   预热段与最后一根一律给 0 信号（最后一根无法在 `t+1` 成交）。
2. 从 `quant_backtest/__init__.py` 导出。
3. 若要让配置生效，先补分派层，再把参数登记进 `backtestSchema`。
4. 补 `python/packages/quant-backtest/tests/` 用例；**必须**覆盖「无未来函数」
   （构造只有未来数据才成立的信号，断言不产生交易）与 O(n) 复杂度（旧实现是 O(n²)，
   在 500 根上看不出来）。

### 6.8 两段止盈与移动止损层（v0.7.0，**已实现**）

需求在 [`docs/v0.7.0-staged-take-profit-trailing-stop.md`](docs/v0.7.0-staged-take-profit-trailing-stop.md)，
证据与 DDL 草案在同名 `-appendix`。**这一节是摘要，不是另一份需求**；实现前先读需求文档。

它要改的形态是 §6.3 的那个模型本身，因此下面五条是 §6.3 的**例外**，其余条款全部继续适用：

1. **第一段止盈不能用 `closePosition`**。`closePosition` 与 `quantity` / `reduceOnly` 互斥，
   所以「条件单只平一半」必须改成带 `quantity` 的条件单。**放弃的是止盈单那条自动撤单保证，
   不是止损单**：止损仍用 `closePosition=true`，它保护「当时剩余的全部仓位」，
   于是第一段减仓之后**止损继续有效，不需要因为减仓而重挂**（这一点让最危险的窗口根本不存在）。
2. **移动止损只朝有利方向移动，永不放宽**：`stop = max(旧档, 极值 ∓ k×ATR(最新))`，
   保本位同理。候选价向下对齐、保本位向上对齐（§6.3 的对齐结论在每一档都要重犯，
   方向反了就是「刚挂上就必被扫」）。**价没变就不动**——这条是限频的主要手段，不是优化。
3. **重挂顺序固定「先挂新、再撤旧」**。先撤后挂会造出无保护窗口；两张 `closePosition` 单在重叠期内
   即使都被触发，最坏是一次「无仓可平」的拒绝（`closePosition` 只平不开），**不会反向开仓**。
   撤旧失败**不许**当成功：不推进档位、记 `trail_last_error`，下一轮重试。
4. **极值与 ATR 必须一次取数、同一条不跨缺口规则**，各自用自己的段（极值走持仓期、ATR 走窗口）。
   两次取数之间会落进一根新 bar，公式随即失去意义。`entryTime` 是必填形参——
   拿不到持仓期起点就算不出极值，**不许默认成 0 或用窗口起点顶替**。
   两条落地口径**不是笔误**，改动前先想清楚：极值取的是 **ATR 那个周期**的 high/low
   （要「一次取数」就只能同周期；`atrInterval` 缺省 1m，与「1m 极值」一致），
   且下界是 `time >= entryTime`，**不含入场那一根**（把入场前的影线算成持仓期高点
   会让止损一开始就偏宽）。
   极值取不到只是「本轮不调整、保留上一档 + 可见原因」，它**不是** `RISK_ATR_UNAVAILABLE`
   （后者要拒绝下单），两者严重度不同，不许混成一个码。
5. **阶段由 `state` 表达，不新增 `stage` 列**：`armed` / `partial_armed` / `trailing` /
   `take_profit` / `stop_loss` / `cancelled` / `failed`，迁移只**追加** CHECK 的取值。
   `trailing` 行**只有一张止损单**；`atr` / `stop_price` / `take_profit` 三列保持入场时的值不变
   （它们记的是「第一段为什么这么算」），移动中的那一档写在 `trail_stop_price`。

还有两条跨层的硬约束：

- **移动止损定时器与对账定时器必须分开**。对账**只报告不动手**（§6.5 第 1 条），而移动止损要下单。
  合并会让「只读」这条保证失守。定时器可以重试「已落库的 `trailing` 行」的重挂（那是对**已提交**
  意图的续做），但**不修复**自己在对账里发现的漂移；仍不新增常驻进程、不引入 markPrice 流。
- **对账判据必须按阶段分流**：`missing-take-profit-order` 只对 `armed` 生效（`trailing` 本来就没有
  止盈单，按旧判据会每轮报一条假警报）；`price-mismatch` 对 `trailing` 行要比 `trail_stop_price`
  而不是 `stop_price`。**对账层第一阶段必须早于移动止损落地**，否则上线当天就在报假警报。

分批形态确实丢掉了「仓位被工具外平掉时止盈单由交易所自动撤销」——它变成由本地
`closeOutside` 撤、且**进程不在时无人撤**。这是相对 v0.4.0 的实质回退，
补偿手段是对账新增 `unexpected-take-profit-order`（只报告）。
`apps/executor/README.md` 里那句「进程崩了也不会留下裸奔仓位」在分批形态下**部分不成立**，
落地时必须照实改写，不要留着旧句子。

**不要改用交易所原生的 `TRAILING_STOP_MARKET`**：它确实存在（`activatePrice` + `callbackRate`
0.1–10，1 = 1%，追踪「下单之后的最高/最低价」），挂上就一直在、进程崩了也有效、不吃权重。
2026-10-17 已评估并**否决**：它的距离是**固定百分比，不随波动率变化**。要的是「距离跟着
ATR 走」，所以走自建 Chandelier（附录 §F.2 有完整对比）。另外它的 `orderType` 会让
`packages/core/src/risk-ids.ts` 的 `algoOrderTag` 直接抛错，真要用还得先补那一类。

### 6.9 通知层（v0.8.0）

把「系统里发生的事」推到**人看得到的地方**。这个仓库里最贵的故障不是报错，而是
**没人知道**：止盈止损挂单失败、仓位在交易所裸奔、工具外的仓位——在日志里只是几行
warn，而日志没人盯着。

通道是**飞书自定义机器人的 webhook**（不是机器人应用：它不需要管理员审核、不需要申请
消息权限，配一个地址就能用）。实现全在
[`packages/core/src/notify.ts`](packages/core/src/notify.ts)，对账侧的转换在
[`apps/executor/src/alert.ts`](apps/executor/src/alert.ts)。

四条**不可协商**的规则：

1. **推送失败必须抛错**。静默失败等于没接：调用方会以为「已经通知过了」，而群里什么
   都没有。但**推送绝不影响主流程**——对账失败绝不能拖垮挂单（§6.5），因此**调用方**
   负责兜住异常并记日志，通知层自己不吞错误。
2. **同一件事不许反复刷屏**。对账默认每 5 分钟跑一次；一个一直存在的裸仓若每轮都推，
   群里三天就没人看了——而被无视的告警等于没接。`AlertDispatcher` 负责
   **去重 + 冷却 + 恢复通知**：同一指纹在冷却期内只推一次，**严重度变了立刻重推**
   （注意 → 紧急是新情况），问题消失推一条「已恢复」。推送失败**不记账**——记了就等于
   把一条永远送不出去的告警当成「已经通知过了」。
3. **地址只走环境变量**。webhook 地址本身就是凭据（拿到它就能往群里发消息，官方明确
   要求不要外泄），因此配置里只写变量名（`notify.webhookEnv`），与 `executor.apiKeyEnv`
   同一套做法。**开着却没配地址 → 启动失败**，不静默跳过；关闭时状态也必须看得见
   （executor 启动日志里明写「飞书通知未启用」）。
4. **先发卡片，被拒才退回纯文本**。纯文本在群里就是一坨字，看不出轻重缓急；卡片的
   **头部按严重度上色**（紧急红 / 注意橙 / 提示蓝），扫一眼就知道要不要立刻处理。
   卡片头部**标题 = 类型 + 图标 + 关键数字**（`💰 成交 · BTCUSDT 净盈亏 -20.08 USDT`）：
   飞书的消息列表**只显示标题**，所以「这是止盈止损 / 报错 / 成交」与关键数值必须在这一
   眼里就说清。类型只有四种（`NOTIFY_CATEGORY_META`）：止盈止损 / 报错 / 成交 / 提示；
   严重度回答「急不急」，类型回答「是什么事」，两件事。
   金额放在 `highlights` 里：**卡片里加粗**（数值是这张卡最该被一眼看到的东西），
   纯文本兜底时同样展示，只是不加粗。
   飞书的「自定义关键词」只对 `text` / `title` 这类文本参数生效（官方文档原话），
   卡片的 `header.title` 正是 title 参数——所以固定前缀写在**标题**里，关键词照样能过检，
   正文不重复它（卡片已经很明显了）。
   被飞书**明确拒收**（回了非 0 的码）时退回纯文本再发一次，并把拒收原因记进日志——
   兜底不是静默的。**网络错误不兜底**：那意味着「不知道送没送到」，再发一次可能变成
   群里两条一样的消息。

告警有两个来源：

1. **交易对账的差异**（§6.5）：`apps/executor/src/alert.ts` 把一份报告变成一条告警，
   一轮对账的多个差异**合成一条**（一个裸仓常同时命中好几条判据，拆开推就成了「一个问
   题推了三遍」）。差异类型与严重度的判据仍然只有 `packages/core/src/reconcile.ts` 一份。
2. **交易生命周期事件**（v0.8.0）：「止盈止损挂单成功」与「一轮买卖完成」。

两类告警的区别是**状态型 vs 事件型**：状态型（对账差异）在下一轮不见了 = 问题恢复了，
因此要推「已恢复」；事件型（挂单成功、一轮完成）推过即忘，下一轮它不在了**不代表**问题
恢复了，因此不参与恢复判定（`AlertItem.oneShot`）。

### 6.9.1 要通知哪些内容：逐项勾选，不是笼统一档（v0.8.0）

通知的设置有两档，来源不同、优先级明确：

1. **控制面录入**（`sql/011_notify_settings`，地址与签名密钥**密文**落库）；
2. **配置文件 + 环境变量**（`notify` 段 + `TRADE_TOOL_FEISHU_WEBHOOK_URL` / `_SECRET`）。

四条**不可协商**的规则：

1. **优先级只有一份实现**：`packages/data/src/db/notify.ts` 的 `resolveAll()` 是**所有出口
   的唯一来源**（面板状态、executor 生效设置、测试发送用的地址都从它派生）。两处各判一次
   的话，「哪一份在生效」就有两个答案——而那正是排障时第一个要回答的问题。
2. **面板那一档是整体的**：地址、开关、参数、**要通知哪些内容**要么一起生效，要么一起不
   生效。拆开用（地址走面板、勾选走文件）会让「界面显示的和实际发生的不一致」。
3. **控制面那条读路径永远拿不到明文**：回包只有「配没配 / 末 4 位 / 生效来源 / 勾了哪些」。
   与交易所凭据同一条安全线（§6.4 第 2 条）——webhook 地址拿到就能往群里发消息。
4. **要通知哪些内容 = 逐项勾选**（`notify.kinds`），**不是**一个「最低严重度」门槛。
   理由：严重度对同一个类型是固定的，门槛只能表达「全都要」或「只要三种紧急的」，而
   用户真正想要的是「止盈单没了这种别烦我，但仓位没有止损保护一定要说」。
   取值是**通知内容类型**（`NOTIFY_KINDS`）= 8 种对账差异 + 交易生命周期事件
   （止盈止损挂单成功 / 一轮买卖完成 / LLM 决策降级）；清单只有一份，勾选项的文案由
   **服务端下发**（`NOTIFY_KIND_INFO`）——页面不自己抄一份，抄了就会漂。

另外三条：

- **每轮重新解析**：executor 在**每轮对账时**重新读一次设置，所以控制面改完**不必重启
  executor**（下一轮，默认 5 分钟内生效）。这与交易所凭据的**不同**：凭据是启动时读的
  （改了要重启）。两条别混。地址、勾选、冷却时间**一次取全**（同一个 `AlertChannel`）——
  只换地址却留着旧的勾选，那种「半更新」比不改更难查。
- **「留空 = 保持原样」**：页面上的地址与签名密钥留空表示沿用**当前生效**的那一份
  （面板的或环境变量的）；保存之后这一份会被固化到库里（地址仍然加密），此后它就是
  生效来源。**第一次**保存必须填地址——留空表示「保持原样」，而还没有原样可保持。
- **改勾选 ≠ 问题解决**：用户取消一个勾选时，「上一轮的内容不见了」与「问题真的解决了」
  在派发器看来一模一样。因此勾选一变，上一轮的记账整个作废（**不推「已恢复」**），
  按新设置从头开始。

⚠️ **新增迁移要两边都登记**：`sql/011_notify_settings.sql` 之外，**Python 侧**
`quant_data/pg.py` 的 `KNOWN_MIGRATION_VERSIONS` 也必须加（它不读写这张表，但版本闸门
两个方向都要校）。漏登记会让**所有**碰 PG 的用例报「库比代码新」——这是跨语言契约的
硬要求（§5 第 2 条）。

### 6.9.2 盈亏口径：只用计价币，事实入库、公式只有一份（v0.8.0）

通知里要出现金额，于是「这个数怎么算」就成了**硬约束**。四条不可协商：

1. **一律用计价币**（USDⓈ-M 永续即 USDT）。`(价差) × 数量` 天然就是 USDT——不换算、
   不折算、不用汇率。一旦有人拿「点数」「百分比」表达盈亏，通知、页面、日志就会各算各的。
2. **公式只有一份**：`packages/core/src/pnl.ts` 的 `estimateBracketPnl()`（预估）与
   `realizedPnl()`（实际）。**库里不存算好的盈亏金额**，只存**事实**
   （`risk_bracket` 的 `closed_qty` / `exit_notional` / `fee_amount`）——
   存两处就是两份口径，而「这一轮赚了多少」是最不能有两个答案的数。
3. **手续费是整轮的**：入场那笔也收。`fee_amount` 累计的是「入场 + 各段平仓」；
   只扣出场那笔，收益会永远算虚高。手续费取自交易所成交事件的 `n` / `N`
   （**必返**字段，缺了要报错——不能当成 0）。
4. **分批要累加**：v0.7.0 的两段模型里一轮平两段（第一段止盈 + 移动止损了结），
   成交额与手续费都**累加**。只算最后一段，净盈亏就只算了一半。

另有两条边界：

- **工具外平仓（`cancelled`）没有我们的成交** → 出场价不知道，**不算**盈亏、也不推
  这类通知（对账层的 `record-without-position` 会覆盖这件事）。如实不算，比报一个假的
  数字强。
- **方向收窄**：`risk_bracket.position_side` 与计划里的方向都只有 LONG / SHORT
  （表上的 CHECK 也只允许这两个）——`BOTH` 是账户的持仓模式，不是仓位方向。方向算错，
  「赚」会显示成「亏」。

契约核对日期 **2026-10-19**（官方《自定义机器人使用指南》）：

- 请求：`POST`，体为 `{"msg_type":"text","content":{"text":…}}`；成功回 `{"code":0,…}`；
- 签名：`HMAC-SHA256(key = "<timestamp>\n<secret>", 空串)` 再 base64。`timestamp` 是
  **秒**，且距发送时刻不超过 1 小时（官方硬性要求）；
- 错误码：11232 限频 / 19021 签名 / 19022 IP 白名单 / 19024 关键词；
- 体不超过 20 KB；单租户单机器人 100 次/分钟、5 次/秒。

改动前重新核对官方文档并更新核对日期（§10.2 的纪律对飞书同样适用）。

### 6.10 LLM 决策层（v0.9.0）

让模型参与决定止盈止损档位。**默认关闭**（`executor.llm.enabled = false`），
关闭时行为与 v0.9.0 之前**逐字一致**。五条不可协商：

1. **模型只输出倍数，不输出价格**。止盈止损的价格**永远**由
   `packages/core/src/risk-policy.ts` 的 `deriveStagedPlan` 算。模型只能选
   「止损放几倍 ATR」这类**参数**。理由：价格计算必须是纯函数（约定 4），
   而模型输出直接变成价格等于把一条不可复现的路径接到真实平仓指令上；
   而且 tick 对齐与「止损止盈必须分居入场价两侧」这两条判据在纯函数里**已有
   一份实现**（§6.1 第 1 条），模型自己算价就是第二份。
2. **取值范围只有一份**：模型的六个参数走 `packages/core/src/llm-decision.ts`
   的 zod schema，区间与 `executorSchema` 逐字一致；schema 的 CHECK 再挡一道。
   **越界不是静默截断**，而是抛 `LLM_DECISION_INVALID` 并降级。
3. **降级必须可见**：模型超时 / 报错 / 输出越界 / 档位自相矛盾时，
   默认**降级到 `risk_policy` 的档位**（不是拒绝下单——仓位已经成交了，
   不挂止损单就是裸仓），同时把 `decision_source='config-fallback'` 与
   `decision_fallback_reason` **落库**，并推一条 `llm-fallback` 告警。
   约定 9 忌讳的是「静默兜底」：兜底本身不犯规，**不留痕迹**才犯规。
4. **决策来源必须可查**：`risk_bracket.decision_source` 取三个值——
   `llm`（模型定的）/ `config`（按配置的）/ `config-fallback`（降级兜底）。
   后两者挂出去的价格可能一样，但**性质**不同：后者是需要人知道的故障，
   合并成一个值就再也分不出来了。`risk_policy` 是**可变**的，而
   `risk_bracket` 是不可变的历史，所以生效的六个倍数要**随记录一起存**。
5. **模型不参与这三件事**：不选 ATR 周期（那是取数口径，会让 ATR 快照与档位
   来自两套口径）、不选「用不用分批」（那是方法，由 `takeProfit1Ratio` 推出）、
   不输出绝对价格。

**裸仓窗口是这条路线固有的代价**：模型响应时间不可控，而它在「成交 → 挂单」
之间。因此 `executor.llm.timeoutMs`（缺省 8 秒）是**裸仓窗口的上限**——
超过就降级，不无限等。真正的消除要靠把决策提前到成交之前（预取），那是另一条路线。

代码位置：契约与纯函数在 `packages/core/src/llm-decision.ts`；HTTP 客户端在
`packages/data/src/llm.ts`（OpenAI 兼容协议，`baseUrl` 可配，密钥**只从环境变量读**）；
编排与降级在 `apps/executor/src/decision.ts`；留痕在 `sql/013_llm_decision.sql`。

## 7 已知漂移与技术债

**以下都是「代码与文档不一致」或者「代码自己写着违规」的现状，不是规格。**
动手前先确认它是否已经被修掉；照着一份过期的描述写代码，等于把一个已知 bug 复刻一遍。

| #   | 现象                                                                                                                                                                                                                                                                                                                                                                                                        | 位置                                                                                       | 正确的方向                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 控制面扣留统计用 SQL 又实现了一遍 closed / win_start / expected 的算式，文件里自己写着「与 Python 侧 `judge_bucket` 仍逐字对应」——这正是 §6.1 第 1 条禁止的形态                                                                                                                                                                                                                                             | `packages/data/src/db/repo.ts`（`readDerivedIntervals`）                                   | 让它只消费 Python 的判定结果，而不是再算一遍                                                                                                                                                    |
| 2   | `backtest.strategy` 是死配置                                                                                                                                                                                                                                                                                                                                                                                | `packages/core/src/config.ts` + `quant_backtest/__main__.py`                               | 补策略注册 / 分派层，或明确删掉该字段                                                                                                                                                           |
| 3   | 回测只接受 `--source synthetic`，`runBacktest` 也不注入 DSN；但 `__main__.py` 的模块文档声称有「真实数据路径从 PG 读」                                                                                                                                                                                                                                                                                      | `quant_backtest/__main__.py`、`packages/data/src/market.ts`                                | 要么实现 PG 取数，要么改掉文档                                                                                                                                                                  |
| 4   | `TRADE_TOOL_PYTHON_DIR` 能被读（`resolvePythonDir`），却没进 `.env.example`——按 §2.2 的口径它算「不存在的变量」                                                                                                                                                                                                                                                                                             | `packages/data/src/bridge.ts`                                                              | 补进模板并注释，或删掉这个后门                                                                                                                                                                  |
| 5   | `defaultConfig()` 里写死 `market.symbol = 'BTCUSDT'`                                                                                                                                                                                                                                                                                                                                                        | `packages/core/src/config.ts`                                                              | 这是 §5 第 10 条**唯一被容忍的形态**（只服务离线合成与回测）。别再增加第二处；同步链路必须显式传 `--symbol`                                                                                     |
| 6   | 子文档与 `README.md` 有过期描述：`packages/core/README.md` 还列着已删除的 `strategy.ts`；`apps/web/README.md` 说「三条硬约束」（实际五条）；根 `README.md` 说回测是「收盘成交模型」                                                                                                                                                                                                                         | 各 `README.md`                                                                             | 顺手改掉；**规矩以本文件为准**                                                                                                                                                                  |
| 7   | **切 `executor.environment` 不会切换已落库的账本**：`risk_bracket` / `reconcile_run` 记的是「账户侧」事实，而库里没有环境列。主网的 `armed` 记录被拿到 demo 账户上对账时，会报出 `missing-stop-order`（critical）+ `missing-take-profit-order` + `record-without-position` 三条**假警报**；更糟的是那条 `armed` 记录若与 demo 新单撞上同一个 `entryOrderId`，新仓的止盈止损会被判重跳过，仓位裸奔而日志正常 | `packages/data/sql/006_risk_bracket.sql`（无 environment 列）、`apps/executor/src/main.ts` | 切环境时**同时清理账户侧账本**（`risk_bracket` / `reconcile_run`），或给这两张表加环境维度。行情侧（`klines_*` / `symbols` / `contract_spec` / `gaps`）**不需要**动：价格与合约规格两个环境一致 |

另外两条环境事实：**仓库里没有 CI**（见 §3）；`pnpm lint` 无任务（同前）。

## 8 测试约定

### 8.1 数据库用例

`packages/data` 与 `apps/sync` 的测试需要一个可重复的 PG（默认 `127.0.0.1:5432/trade_tool`，
用户 / 密码 `trade` / `trade`）——`docker compose up -d` 起的库正好就是这套默认值，测试不需要
额外环境变量，也可用 `TRADE_TOOL_TEST_PG_*` 覆盖（Python 侧是 `TRADE_TOOL_TEST_PG_DSN`）。

隔离方式是**每次建一个随机命名的独立 schema**（TS 侧 `tt_<label>_<随机>`，多为 describe /
beforeAll 级；Python 侧是 session 级、按 PID 命名），从空库执行 `packages/data/sql/*.sql`，
结束时整段 `DROP SCHEMA … CASCADE`——**测试不得连生产库**。所以「随机 schema」不等于
「每个用例一个 schema」，别依赖前一个用例的 schema 还在。`packages/data` 的 vitest 关了文件级
并行（`fileParallelism: false`），因为迁移、`COPY`、事务都必须真跑。

### 8.2 假交易所与「不出网」

需要真实交易所的用例用 [`packages/data/src/testing.ts`](packages/data/src/testing.ts) 的
`startMockExchange()` 起一个本地假 HTTP 服务器（**放在 `src/` 而不是 `tests/`**，是为了让
`apps/sync` 等包直接 import，不必各自复制一份），并把 `TRADE_TOOL_BINANCE_BASE_URL` 指向它，
让**真实的 Python 引擎**跑完整接缝（`sync-integration.test.ts`）。Python 侧对应的是
`conftest.py` 里的 `FakeExchange`（实现 `Transport` 协议）。

注意这条环境变量只覆盖 **REST** 基址，而且**测试之外不该由人来设**：`demo` 下 TS 会把 demo
基址注入 Python 子进程，人去设它只会让行情与下单分家。本地要跑真实交易所的 Demo 环境用
`executor.environment = demo`（§6.3 第 6 条）。

**测试过程中不得访问真实网络**——这条目前是**约定，不是闸门**：vitest 没有配网络拦截，靠
「本地 mock server + Python 侧的假 Transport」构造出来。写新用例时自己守住它。

假交易所必然与当时的真实交易所一致，因此**它验证的是逻辑，不是契约**：止盈止损的整条下单路径
在 mock 上跑通，交易所改版时照样在主网上炸。接缝处（端点、URL、字段名、状态取值）必须有
**对着契约写的断言测试**，见 §10。

### 8.3 控制面与 UI 用例

路由只依赖 `WebDeps` 接口，测试用纯替身（不连 PG、不出网）；需要 DOM 的 UI 用例在文件顶部声明
`@vitest-environment jsdom`，并 import `tests/ui/setup.ts`（recharts 的 `ResponsiveContainer`
依赖 `ResizeObserver`，setup 里打桩）。

**首屏取数用 `useLayoutEffect`**：effect 里抛异常会中止同一次 commit 里剩下的全部 effect，
图表组件一个 `ResizeObserver` 就能让整页停在「读取中」。加载失败必须**常驻可见**（§5 第 9 条）。

## 9 进程入口、常用命令与部署

| 入口                                            | 说明                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `pnpm --filter @trade-tool/cli start -- <命令>` | 源码直跑（tsx）。`--help` 有命令表                   |
| `node apps/cli/dist/index.js <命令>`            | 构建产物（也是 `package.json` 的 `bin`）             |
| `pnpm --filter @trade-tool/sync start`          | 常驻同步守护进程                                     |
| `pnpm --filter @trade-tool/web start`           | 控制面 `http://127.0.0.1:8787`（地址由 `.env` 决定） |
| `pnpm --filter @trade-tool/executor start`      | 止盈止损，需 `executor.enabled = true`，**会真下单** |
| `pnpm --filter @trade-tool/cli start -- doctor` | 自检 node / pnpm / uv / git                          |

stdout 是命令结果（日志走 stderr），`--json` 时输出纯 JSON。**生命周期变更不走 CLI**，
走 `@trade-tool/sync` 的控制原语（`addSymbol` / `removeSymbol` / `listSymbols` /
`start` / `pause` / `resume` / `getStatus` / `getSummary`，全部幂等、类型完整、不依赖 HTTP 框架）。

打包细节：`tsup` 的 `banner` 一律**不要用**——各入口 `src` 自带 shebang，叠一个 banner 会得到
两个 shebang，第二个落在第 2 行，Node 只在第 1 行识别 shebang，于是构建产物无条件
`SyntaxError` 并以退出码 1 结束。

**部署到服务器**走 [`deploy/`](deploy/README.md)：本机构建镜像 → `dist-deploy/*.tar` →
目标机 `docker load`。四条落地约定：

- 四个应用服务**共用同一个镜像**，只靠 `command` 区分（共用 workspace 产物与 Python venv）；
- `pull_policy: never`：镜像是 save/load 搬过去的，标签不匹配就直接起不来，**不允许**悄悄去拉
  同名但不同版本的镜像；
- **迁移在每个容器的入口里跑**（[`deploy/entrypoint.sh`](deploy/entrypoint.sh)：等库 →
  `db migrate` → `exec`），因此不存在「web 起来了但库还是旧的」这种半个可用状态；
- 止盈止损在 `executor` profile 里，`docker compose up -d` **不会**启动它。

运行期 Python **不调 uv**（配置里 `data.python = "python3"`，用镜像内建好的 venv）。
代理要四条一起配（`HTTPS_PROXY` / `NODE_OPTIONS=--use-env-proxy` / `NO_PROXY` 含 `postgres` /
凭据只放目标机 `.env`），少一条就是「Python 通、Node 不通」的半通状态。

## 10 交易所接缝与外部证据

### 10.1 接缝必须核对契约（2026-10-10 教训）

本节关于 Binance 的陈述来自 **2026-10-10、2026-10-14 与 2026-10-15 三次核对**（见 git 历史）。它们会过期，
而**过期的写法比没有更危险**：读代码的人会默认「这个文件的交易所部分被人校准过」。
改动接缝、或依赖任何关于交易所行为的陈述之前，**重新核对官方文档并更新核对日期**。

两条硬约束：

1. **接缝的「值」必须有断言测试**：端点路径、WS URL、字段名、状态取值。测试要对着**契约**
   断言，而不是对着自己的实现复述。今天 `listenKeyUrl` 从对变错时 122 个测试全绿，因为没有
   任何用例断言过那个地址。
2. **在下第一笔真单之前做一次只读的端点存活性探测**。用非法参数打真实端点：返回参数错误
   （如 `-1116`）说明端点活着，返回 `Order type not supported for this endpoint` 说明已迁走。
   零成本，且不需要真的下单。

2026-10-10 一天内连续踩中两次同批改造（Binance 2026-03-06 公告 / 2026-04-23 生效）：

| 变更                                      | 旧的坏法                                               | 为什么当时看不出来                                                    |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 用户数据流必须走 `/private/ws?listenKey=` | 旧地址**握手成功**、不报错、不重连，但一个事件都收不到 | 服务看起来完全正常，实际完全失明；`risk_bracket` 连 `failed` 行都没有 |
| 条件单迁到 `/fapi/v1/algoOrder`           | 前面所有环节全绿，直到下单那一刻才被拒                 | 事件、ATR、算价、落库都通过了，失败点离根因很远                       |

更糟的是它们**互相遮挡**：第一次挂单先撞上 `-2015`（API key 没开合约权限），修完权限才露出
真正的 Algo 迁移问题。**「立刻报错」的错误比「看起来成功其实没做事」的错误友好得多**——
设计接缝时优先选前者。

> 检索到的文档证据必须与**代码里实际在用的路径**对照，不能只用来回答用户问的那一个问题。
> 问「移动止损能不能做」时检索到的《下条件单》页面里就写着老接口已废弃，但那份结果当时只被
> 当成新功能的可行性依据，没有被当成对现有代码的审计材料。

### 10.2 `web_search` 拿不到日期，检索结果不可自证新旧（2026-10-14 核对）

`web_search` 不是检索接口，而是一次携带服务器端搜索工具的完整模型调用。本机
（dsh 0.2.0-rc.2）实测核对出两条：

1. **结果没有日期、也没有摘要**。适配层把 `publishedAt` 映射自 `page_age`、摘要映射自 text
   块的 `citations`，而 DeepSeek 的 Anthropic 兼容层**忽略 `citations`**，也从不返回
   `page_age`——4 次搜索、每次回传 8 条来源（共 30 余条），日期与摘要各 **0** 个。渲染层只在
   字段存在时才打印 `(日期)`，所以它没错，是上游不喂。
2. **排序不含时效偏好，且模型不知道今天几号**。DSH 只注册了 `provider` / `model` / `cwd`
   三个 prompt 变量，system prompt 里**没有任何日期**。带年份、带 `latest` 的 query 照样把
   `change-log#2019-10-11`、`legacy-docs`、`python-binance` 源码与一条 2026-10-13 的新闻
   **并排**返回；索引是新的，坏的是排序没有 recency 权重。

所以「标题写着《Binance 开发者文档 / Change Log》」的 2019 年锚点，在 agent 眼里和当天公告
一样权威。三条规矩：

1. **时效敏感的检索之前先跑 `date`**，把绝对年份写进 query。别把「现在」交给训练截止日。
2. **搜索结果不构成核对**。Binance 契约一律以官方 change-log + 只读端点探测为准（§10.1），
   检索只用来找页面地址。
3. 读到的页面**必须自己认日期**：既然 `page_age` 不存在，唯一的时效判据是正文里的版本号 /
   生效日期 / 公告日期。

> 升级 DSH 后重新核对这三条。上游若给搜索子请求注入日期、或开始回传 `page_age`，第 1 条仍是
> 纪律，第 3 条才可以放宽。

## 11 维护本文档

- **§5 的编号是外部锚点**，只追加、不改号（原委见 §5 开头）。要删条目，先把全仓引用改完：

  ```bash
  grep -rn "AGENTS\.md" --include=*.ts --include=*.tsx --include=*.sql --include=*.py .
  ```

- **带日期的陈述必须重新核对再改**：§10 里「核对于 YYYY-MM-DD」的段落以及任何关于交易所行为的
  断言，改动时更新核对日期。过期的断言比没有断言更危险。
- **引用 `R-*` / `AC-*` 要带版本前缀**（`v0.1.0 R-3.3`）：编号在不同版本文档里各用各的。
- **规矩只写一份**：本文件是硬约束的权威清单。各层规则不要在 `README.md` / `apps/*/README.md`
  里另起一份编号（历史上已经出现过「三条 / 四条 / 五条」三个版本）。那些文档负责解释**为什么**
  和**怎么做**，并链接回本节。
- **已知漂移写进 §7**：发现代码与文档不一致时，别在别处悄悄改描述——更新 §7 那张表，
  或者把漂移修掉。
- **本文件必须能被 Prettier 格式化**：`npx prettier --write AGENTS.md`，不要留下会让
  `pnpm format:check` 失败的表格宽度或列表符号。

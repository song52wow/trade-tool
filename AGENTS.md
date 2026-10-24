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

| 坑                                    | 症状                                                   | 见               |
| ------------------------------------- | ------------------------------------------------------ | ---------------- |
| pnpm 版本与 `packageManager` 不一致   | 仓库内**任何** pnpm 命令都失败（连 `pnpm -v` 也是）    | §2.4             |
| 新增进程入口忘了调 `loadProjectEnv()` | 读不到 `.env`，表现为「配置明明填了却说没配」          | §2.2             |
| 凭据 / DSN 走了 argv 或配置文件       | 密码出现在 `ps` 与 git 里                              | §5 第 2 条       |
| 失败时返回空值 / 默认值而不是抛错     | 「看起来成功了，其实什么都没做」，最难查               | §5 第 9 条       |
| 判据被抄成第二份实现                  | 两个出口结论不一致，此后没人再敢信任何一份             | §6.1、§6.2、§6.5 |
| 让模型直接输出价格 / 数量             | 算错一个数量级也不报错，亏损跟着错一个数量级           | §5 第 13 条      |
| 开关打开却没有实现它                  | 日志说「开了」，实际什么也没发生                       | §6.11.1 第 6 条  |
| **批准的口径与执行器不一致**          | 批了一份执行不了的方案，它永远卡在「已批准」           | §6.12.2 第 1 条  |
| 新迁移用了**旧迁移同名的**约束        | `DROP CONSTRAINT` 顺带删掉上一条守门人，且**一声不响** | §5 第 12 条      |
| 下单成功但回填前崩了                  | 下一轮重复下单，仓位翻倍而日志与库里都看不出异常       | §6.12.1          |
| 提示词不落在任何地方                  | 「模型为什么这么答」没人答得上来，只能看到结论         | §6.9.3           |

## 1 这个仓库是什么

**双轨 monorepo**：TypeScript（pnpm + Turborepo）做编排与交互，Python（uv workspace）
做计算密集的行情、指标与回测。跨语言只有**一个接缝**：`packages/data` → `python -m quant_data`。

```
apps/cli ─────> packages/data ───────> packages/core
apps/sync ────> packages/data ───────> packages/core
apps/web ─────> apps/sync ───────────> packages/data ──> packages/core
apps/executor ─> packages/data ───────> packages/core
apps/agent ───> packages/data ───────> packages/core
                     │
                     └─(唯一跨语言接缝: python -m quant_data)─> python/quant-*
```

五个进程入口，职责**不重叠**——不要在控制面里再起守护进程，也不要让 CLI 改生命周期：

| 进程            | 职责                                                             |
| --------------- | ---------------------------------------------------------------- |
| `apps/cli`      | 一次性命令（`db` / `data` / `backtest` / `reconcile` / `agent`） |
| `apps/sync`     | 常驻同步守护进程，**唯一真的拉行情的人**，控制原语在此           |
| `apps/web`      | 控制面：HTTP API + 看板；只写意图，另有一条一次性手动对账        |
| `apps/executor` | 止盈止损：买入成交 → ATR → 条件单（**会真下单**）                |
| `apps/agent`    | 分析师 + 交易员 Agent：分析 → 出执行方案（**默认不下单**）       |

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
（[`packages/core/src/env.ts`](packages/core/src/env.ts)）」。当前五处，缺一不可：

```
apps/cli/src/index.ts   apps/sync/src/main.ts   apps/web/src/main.ts
apps/executor/src/main.ts   apps/agent/src/main.ts
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

| 变量                                                    | 作用 / 坑                                                                                                                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRADE_TOOL_HOME`                                       | 工作根：配置文件、`data/cache`、`data/raw`、`data/meta`、`reports/`。**必须绝对路径**（相对路径按 cwd 解析，而各处 cwd 不同）                                                                                                    |
| `TRADE_TOOL_PG_{HOST,PORT,USER,DATABASE,PASSWORD}`      | 本地 PG，默认与 [`compose.yaml`](compose.yaml) 同源（`trade` / `trade_tool` / 5432）                                                                                                                                             |
| `TRADE_TOOL_PG_DSN`                                     | 交给 Python 的完整连接串，由 TS 拼好注入。**只经环境变量，不进 argv**（不进 `.env.example`）                                                                                                                                     |
| `TRADE_TOOL_WEB_{HOST,PORT}`                            | 控制面监听（默认 `127.0.0.1:8787`）。**不要改成 `0.0.0.0`**：本期无鉴权，见 §6.6                                                                                                                                                 |
| `TRADE_TOOL_BINANCE_BASE_URL`                           | 覆盖交易所 **REST** 基址，Python 侧读它（`quant_data/http.py`）。**不要拿它切环境**：本地跑 Demo 用 `executor.environment = demo`，那时由 TS 往子进程注入 demo 基址；测试用它指向本地假交易所                                    |
| `TRADE_TOOL_BINANCE_DEMO_STREAM_URL`                    | Demo 用户数据流**基址**（不带 `/private/ws?listenKey=`）。只在 `executor.environment = demo` 时必填，本仓库**不内置默认值**                                                                                                      |
| `TRADE_TOOL_BINANCE_API_KEY` / `_API_SECRET`            | 行情同步**不需要**；只有 `apps/executor` 下单用。名字可由 `executor.apiKeyEnv` / `apiSecretEnv` 改                                                                                                                               |
| `TRADE_TOOL_SECRET_KEY`                                 | 凭据静态加密主密钥（32 字节 = 64 位 hex 或 44 位 base64）。**丢了就解不开库里的密文**，只能重新录入，见 §6.4。**控制面录入的模型密钥也用它加密**（v1.0.0，§6.13）——没有它，控制面那一档读不出来，只能用配置文件 + 环境变量那一档 |
| `TRADE_TOOL_FEISHU_WEBHOOK_URL` / `_SECRET`             | 飞书自定义机器人的 webhook 地址（**它本身就是凭据**）与可选的签名密钥。只在 `notify.enabled = true` 时需要，见 §6.9                                                                                                              |
| `TRADE_TOOL_TEST_PG_{HOST,PORT,DATABASE,USER,PASSWORD}` | 测试库连接参数覆盖（默认同上）。Python 侧另认 `TRADE_TOOL_TEST_PG_DSN`                                                                                                                                                           |

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

| 新东西                                                 | 放哪                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| 领域类型、配置 schema、错误码、纯函数判据              | `packages/core/src`                                                         |
| 行情接入、缓存、Python 调用                            | `packages/data/src`                                                         |
| **数据库表结构 / 迁移（唯一来源）**                    | **`packages/data/sql/`**                                                    |
| PG 客户端、schema 闸门、查询层                         | `packages/data/src/db`                                                      |
| **派生周期（桶对齐 / 覆盖判据 / 聚合）**               | **`python/packages/quant-data/src/quant_data/aggregate.py`**                |
| **带时间锚的取数（如「按成交时刻算 ATR」）**           | **`python/packages/quant-data/src/quant_data/risk.py`**                     |
| **技术指标公式（全仓唯一一份）**                       | **`python/packages/quant-core/src/quant_core/indicators.py`**               |
| **私有交易接口（下单 / 用户数据流）**                  | **`packages/data/src/binance-private.ts`**                                  |
| 止盈止损编排、幂等、执行记录                           | `apps/executor/src` + `packages/data/src/db/risk.ts`                        |
| **凭据静态加密**                                       | **`packages/core/src/secret.ts`** + `packages/data/src/db/credentials.ts`   |
| **告警通道（飞书推送、去重与冷却）**                   | **`packages/core/src/notify.ts`**（转换在 `apps/executor/src/alert.ts`）    |
| **通知设置的读写与「哪一份在生效」**                   | **`packages/data/src/db/notify.ts`**（密文落库 + 优先级解析）               |
| **新策略 / 回测引擎**                                  | **`python/packages/quant-backtest/src/`**                                   |
| **分析师 Agent 的契约与纯函数（合成立场）**            | **`packages/core/src/agent-analyst.ts`**                                    |
| **交易员 Agent 的契约与纯函数（算仓位与价）**          | **`packages/core/src/agent-trader.ts`**                                     |
| **方案「能不能自动执行」的判据（一处判据，各处共用）** | **`packages/core/src/agent-plan.ts`**                                       |
| **提示词（系统提示 / 截断 / 镜像消息的构造）**         | **`packages/core/src/model-prompt.ts`**                                     |
| **提示词镜像到飞书（运行时，agent 与 executor 共用）** | **`packages/data/src/prompt-mirror.ts`**                                    |
| **行情上下文的跨语言契约（载荷 schema）**              | **`packages/core/src/agent-context.ts`**                                    |
| **技术面现算 + 情绪面取数**                            | **`python/packages/quant-data/src/quant_data/market_context.py`**           |
| **Agent 的编排与守护循环**                             | **`apps/agent/src`**（`service.ts` 编排 + `daemon.ts` 循环）                |
| **Agent 报告与方案的读写**                             | **`packages/data/src/db/agent.ts`**                                         |
| **自动下单的执行状态机与认领**                         | **`apps/executor/src/plan-execution.ts`** + `packages/data/src/db/agent.ts` |
| **模型接入设置的读写与「哪一份在生效」**               | **`packages/data/src/db/llm-settings.ts`**（密文落库 + 优先级解析）         |
| **模型设置的每轮解析（控制面改完下一轮生效）**         | **`apps/agent/src/llm.ts`**                                                 |
| 命令行命令                                             | `apps/cli/src/commands/`                                                    |
| 常驻同步、生命周期、控制原语                           | `apps/sync/src`                                                             |
| 控制面 HTTP 路由与前端页面                             | `apps/web/src` + `apps/web/ui`                                              |
| **部署镜像与编排（服务器）**                           | **`deploy/`**（根 [`compose.yaml`](compose.yaml) 只是本机开发库）           |

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
12. **删列之前先看有没有约束提到它**：PostgreSQL 的 `DROP COLUMN` 会**自动删掉引用该列的
    CHECK 约束**，而且**一声不响**——迁移跑完、版本对得上、schema 看着还是「迁移过的样子」，
    守门人却已经没了。2026-10-21 实测踩到：迁移 `014` 退役
    `risk_bracket.decision_take_profit1_atr_mult`，顺带删掉了
    `risk_bracket_decision_llm_params_check`（「LLM 决策的数必须齐全」那条联合约束），
    直到有人去查约束才发现，补在迁移 `015` 里。
    **新迁移退役任何一列之前，先 `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = '<table>'::regclass` 查一遍**，被顺带删掉的约束要用新迁移补回来
    （补回来的那条**语义要一样**，只是少了已退役的字段）。
    ⚠️ **同一个坑的另一个形态：`DROP CONSTRAINT` 也会删掉同名的那条**。
    新迁移想「扩枚举」（给 `status` 多加两个取值）时，最省事的写法是
    `DROP CONSTRAINT IF EXISTS <旧名>` + `ADD CONSTRAINT <旧名> ...`——
    但如果旧名的**语义**与新的不是一回事（哪怕只是判据的字段换了），
    这条旧守门人就**无声消失**了。2026-10-22 实测踩到：迁移 `018` 用
    `trading_plan_failed_has_reason_check` 这个名字去表达「下单失败必须带原因」，
    而 `017` 已经用**同名**表达了「出不了方案必须带原因」——`018` 的 `DROP` 顺带删掉了它，
    于是「出不了方案必须说为什么」这条守门人消失了。
    **两条语义不同的约束必须用两个名字**（`..._failed_has_reason_check` 与
    `..._execution_failed_has_reason_check`）；**扩枚举时保留旧名、把旧值也列进去**
    （那是「扩」，不是「换」）。**改完迁移后，用空库跑一遍全部迁移，
    把 `pg_constraint` 里的约束逐条列出来核对**——那是唯一能发现「少了谁」的办法。
13. **模型只提「比例」，钱和价格由程序算**（v1.0.0 Agent 层）：LLM 参与下单决策时，
    它能说的只有**比例类**参数——风险占权益的百分之几、止损离几倍 ATR、进场挂在现价
    几个 ATR 之外。**绝对价格、数量、名义金额一律由程序算**：
    - 价格走 `deriveBracketPlan`；`apps/executor` 挂单走 `deriveStagedPlan`——
      **两个不同的函数**，但算式与 tick 对齐方向**逐字相同**
      （`deriveStagedPlan` 明确复用 v0.4.0 口径，而 v0.4.0 的口径就是 `deriveBracketPlan`），
      因此「方案上的止损价」与「交易所上的止损价」不会差一个 tick——
      这条由 `packages/core/tests/risk-policy.test.ts` 的断言担保，不靠注释；
    - 数量走「风险金额 ÷ 止损距离」再按 `stepSize` 对齐。模型直接说「买 0.35 个」
      完全可能是在算 3.5 个，而**没有任何一处会报错**；比例算错时绝对金额仍可控。
    - 总立场（看多 / 看空 / 中性）由**纯函数合成**（`aggregateAnalystReport`），
      不是模型直接给的——否则「报告里写着看多、库里记的是看空」这类漂移无从查起。
    - 越界一律**夹住并留下调整记录**（`adjustments`），不静默截断；只有「算出来
      的数量低于交易所最小下单量」「方向与结论矛盾」这种**没法夹**的情况才拒绝出方案。
      这条与 §5 第 4 条（纯函数）、§6.3 第 4 条（价格可复现）是同一件事的三面。

## 6 各层规矩

`R-*` / `AC-*` 编号出自 [`docs/`](docs/README.md) 的需求文档。**引用时带版本前缀**
（写成「v0.1.0 R-3.3」），因为编号在不同版本文档里各用各的。

| 层                              | 版本   | 需求 / 设计文档                                                                  | 细节                                                                  |
| ------------------------------- | ------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 数据底座与同步                  | v0.1.0 | [`docs/v0.1.0-…`](docs/v0.1.0-binance-perp-market-sync.md)                       | `packages/data/README.md`、`apps/sync/README.md`                      |
| 派生周期                        | v0.2.0 | [`docs/v0.2.0-…`](docs/v0.2.0-multi-timeframe-klines.md)                         | §6.1                                                                  |
| 技术指标                        | v0.3.0 | [`docs/v0.3.0-…`](docs/v0.3.0-technical-indicators.md)                           | §6.2                                                                  |
| 止盈止损                        | v0.4.0 | **无需求文档**                                                                   | [`apps/executor/README.md`](apps/executor/README.md)、§6.3            |
| 凭据与运行期设置                | v0.5.0 | **无需求文档**                                                                   | [`sql/007`](packages/data/sql/007_executor_settings.sql) 头注释、§6.4 |
| 交易对账                        | v0.6.0 | **无需求文档**                                                                   | [`README.md`](README.md) 的对账一节、§6.5                             |
| 两段止盈与移动止损              | v0.7.0 | [`docs/v0.7.0-…`](docs/v0.7.0-staged-take-profit-trailing-stop.md)（**已实现**） | §6.8                                                                  |
| 通知层（飞书告警）              | v0.8.0 | **无需求文档**                                                                   | §6.9                                                                  |
| LLM 决策（止盈止损档位）        | v0.9.0 | **无需求文档**                                                                   | §6.10                                                                 |
| **分析师 / 交易员 Agent**       | v1.0.0 | **无需求文档**                                                                   | [`apps/agent/README.md`](apps/agent/README.md)、§6.11                 |
| **自动下单（方案 → 真实订单）** | v1.0.0 | **无需求文档**                                                                   | §6.12                                                                 |
| **模型接入的控制面配置**        | v1.0.0 | **无需求文档**                                                                   | §6.13                                                                 |

### 6.0 迁移与表的索引

schema 的唯一来源是 `packages/data/sql/*.sql`；**每张迁移文件头部的注释就是它的设计理由**，
改之前先读。迁移必须幂等（`IF NOT EXISTS` / 可重复执行的 `ALTER`），因为每个入口启动都会跑一遍。

**幂等只保证「重复执行」安全，不保证「同时执行」安全。** `docker compose up -d` 会让
web / sync / executor 三个容器同时启动，三个容器各自在入口里跑一遍迁移，两个进程就会
一起去建同一张表，撞 `duplicate key value violates unique constraint
"pg_type_typname_nsp_index"`——一个失败回滚、一个成功，「迁移失败」和「迁移成功」同框出现。
因此迁移内部持一把 **session 级 advisory lock**（`packages/data/src/db/migrate.ts`，
按 schema 划分），把并发迁移串行化。**别删这把锁，也别改成 try 版本**：
try 版本会让第二个进程「拿不到锁就跳过」，那正是「库还是旧的就启动了」的静默失败。

| 迁移                           | 内容                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001_init`                     | `klines_1m`、`gaps`、`symbols`、`sync_state`、`contract_spec`、`weight_budget`、`schema_migrations`                                                                                                                                                         |
| `002_sync_plan`                | `sync_state.plan_*`（首次全量的规模预估，开启之前就写进去）                                                                                                                                                                                                 |
| `003_daemon_heartbeat`         | `daemon_heartbeat`                                                                                                                                                                                                                                          |
| `004_klines_agg`               | `klines_{15m,1h,4h,1d}`（列与 `klines_1m` 逐列一致）                                                                                                                                                                                                        |
| `005_indicators`               | `indicator_{ma,macd,rsi,boll,kdj,atr,obv}`                                                                                                                                                                                                                  |
| `006_risk_bracket`             | `risk_bracket`（幂等锚点 + ATR 快照 + `last_error`）                                                                                                                                                                                                        |
| `007_executor_settings`        | `executor_credentials`（密文 + 末 4 位提示）、`risk_policy`（global / symbol 两作用域）                                                                                                                                                                     |
| `008_algo_order_ids`           | `risk_bracket` 的条件单编号列改名（Algo 编号空间，与普通 orderId 不通）                                                                                                                                                                                     |
| `009_reconcile_run`            | `reconcile_run`（观测快照）                                                                                                                                                                                                                                 |
| `010_risk_trailing`            | 两段止盈的阶段（`partial_armed` / `trailing`）与移动止损档位。**v0.7.0 设计，未落地**                                                                                                                                                                       |
| `011_notify_settings`          | 飞书通知通道的运行期设置（v0.8.0）：地址与签名密钥**密文**落库 + 开关与参数。**新增迁移，两侧都要登记**                                                                                                                                                     |
| `012_trade_pnl`                | 盈亏的**事实**（v0.8.0）：`risk_bracket` 增累计平仓量 / 成交额 / 手续费；通知内容类型扩到 11 种                                                                                                                                                             |
| `013_llm_decision`             | LLM 决策的留痕（v0.9.0）：`risk_bracket` 增决策来源 / 生效档位 / 理由 / 降级原因                                                                                                                                                                            |
| `014_take_profit_single_mult`  | 止盈倍数**合并成一个**（v0.9.0）：退役 `risk_policy.take_profit1_atr_mult` 与 `risk_bracket.decision_take_profit1_atr_mult`；`take_profit1_ratio` 的 CHECK 收紧为 `< 1`。**新增迁移，两侧都要登记**                                                         |
| `015_restore_llm_params_check` | 补回「LLM 决策的数必须齐全」那条**联合约束**（v0.9.0）：014 用 `DROP COLUMN` 退役 `decision_take_profit1_atr_mult` 时，PostgreSQL **自动删掉了引用它的 CHECK**，于是这条守门人无声消失。**删列前先看有没有约束提到它**。**新增迁移，两侧都要登记**          |
| `016_trail_step`               | 移动止损的**档位序号**（`risk_bracket` 增 `trail_step` / `trail_moves`）+ 通知内容类型扩容到 14 种（v0.9.2）。**新增迁移，两侧都要登记**                                                                                                                    |
| `017_agent_decisions`          | 分析师报告与执行方案（v1.0.0）：`analyst_report`（三面分数 + 合成立场 + 理由 + 上下文留痕）、`trading_plan`（进场 / 仓位 / 止损 / 风险金额 / 调整记录 / 失败原因）。**新增迁移，两侧都要登记**（Python 侧不读写这两张表，但版本闸门两个方向都要校）         |
| `018_agent_plan_execution`     | 让「批准的方案」变成真实订单（v1.0.0）：`trading_plan` 增执行态列（单号 / 尝试次数 / 认领时刻 / 下单失败原因）、`status` 扩出 `executing` 与 `failed`、`risk_bracket.decision_source` 允许 `agent-plan`、通知内容类型扩到 16 种。**新增迁移，两侧都要登记** |
| `019_agent_llm_settings`       | 模型接入的运行期设置（v1.0.0）：`agent_llm_settings` 单行表（地址 / 模型 / 超时 / API 密钥**密文**）。**新增迁移，两侧都要登记**                                                                                                                            |
| `020_agent_prompt_notify`      | 通知内容类型扩到 18 种（v1.0.0）：多两种「Agent 提示词」与「止盈止损档位提示词」（`notify_settings.kinds` 扩枚举，**两种都默认不勾**）。**扩枚举要保留旧约束名、旧值一个不少**（§5 第 12 条）；列默认值与存量行都不动。**新增迁移，两侧都要登记**           |
| `021_fee_asset`                | 手续费的**币种与折算汇率**（`risk_bracket` 增 `fee_asset` / `fee_fx_rate`）：BNB 计价的手续费折成 USDT 时把「用的哪个价」留下来（v0.9.3）。**新增迁移，两侧都要登记**                                                                                       |

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
   **环境按机器分，不按仓库分**：**本地开发机只跑 demo**（不接主网、不用主网凭据做验证），
   **目标机（192.168.1.90）只跑主网**。这是 2026-10-21 用户提出的分工、2026-10-23 澄清的边界：
   「只跑 demo」说的是**本地**，生产机是主网。
   ⚠️ **别把生产机也改成 demo**：那是「密钥换了却不生效」最常见的根因——沙箱不认主网密钥，
   而 `Invalid API-key, IP, or permissions for action` 这句报错**不区分**「环境不对」
   「IP 白名单不匹配」「没开交易权限」三种情况（2026-10-23 实测：90 机器的
   `executor.environment` 一直是 `demo`，于是行情与下单都在沙箱，配的却是主网密钥）。
   ⚠️ `executorSchema.environment` 的**缺省仍是 `live`**（schema 的缺省是生产部署那条路的
   语义，不在这里动），所以「配置里漏写这个字段」= 连主网下真单。因此**每一份配置文件都要
   显式写出来**：`.local/trade-tool.config.json` 写 `demo`，`deploy/config/trade-tool.config.json`
   写 `live`。新增配置文件时同样要写，别靠缺省。
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
交易所那张单早没了」能一直安静地存在。六条**不可协商**的规则：

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
   是紧急，「只有止损没止盈」只是注意；合成一档就是把最要紧的那种淹掉。九个差异类型的严重度见
   [`README.md`](README.md) 的对账表。
5. **「这一阶段的形态上该有什么」由事实判，不由「有没有」判**。`trailing` 行本来就没有止盈单，
   `partial_armed` 行在**第一段成交后**（`tp1_filled_at` 有值）那张单也**本来就该消失**。
   没有这条事实时，对账只能把「止盈单不见了」一律报成差异——那是一条**每轮都发**的假警报，
   而假警报是让整份报告失去可信度的最快方式（§6.5 第 2 条）。
   `tp1_filled_at` 就是这条事实（v0.9.1 起才真的有代码写它，见 §6.8.3）。
6. **「账面全绿、实际空转」那类故障也要有判据**。移动止损曾出现过「一次都挪不成」
   而三方全绿的情况（§6.8.4）：止损单在交易所上（`missing-stop-order` 不报）、
   触发价与本地一致（`price-mismatch` 不报），只是那个价**从来没被更新过**。
   因此 `trailing` 行要比「**试过几次 / 成功几次**」（`trail_step` / `trail_moves`）：
   有尝试没成功 = `trail-move-failed`（**注意**级，不是紧急——仓位此刻仍受止损保护，
   只是保护得不够紧）。判据只认这一对数，不看价格。

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
5. **慢标的不堵住别人**（2026-10-23 修）：一轮同步 = 把「上次水位 → 现在」的数据一次拉完
   （`batch-size` 只是**写库**的批次大小，不是拉取上限），首次全量实测一轮 11~15 分钟。
   因此调度循环**必须**是「**启动**该跑的标的就返回」，**不许**写成「等这一轮全部标的跑完
   才进下一轮」——那会让一个标的的首次全量把全体的调度节奏钉成十几分钟一轮，
   别的标的的 1m K 线因此落后 10~15 分钟（目标机上表现为「同步停在 7 分钟前」）。
   慢标的照旧占着自己的**并发名额**（并发上限不许因此形同虚设），跑完立刻把名额让出来。
6. **K 线只画真实的行**（v0.1.0 R-23）：`/api/symbols/:symbol/bars` 是**纯读**——只打 PG，
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
  hono）。弹窗用原生 `<dialog>`；jsdom 用例要按
  [`apps/web/tests/ui/setup.ts`](apps/web/tests/ui/setup.ts) 的方式打桩。
- **图表一律手写 SVG / CSS，不用图表库**（v0.9.2 起）。K 线见
  [`apps/web/ui/src/components/CandleChart.tsx`](apps/web/ui/src/components/CandleChart.tsx)，
  状态分布见 `OverviewCards.tsx` 里的 `.dist-bar`。两个理由都还在：① **横轴必须按时间排布**
  （缺一根就是空一根，按序号排会把空洞压成连续走势，正是 R-23 明令禁止的）；② 图表库的
  `ResponsiveContainer` 挂载时读 `ResizeObserver`，jsdom 里抛错会**中止同一次 commit 里剩下的
  全部 effect**——首屏取数就此静默失效，页面永远停在「读取中」。真要加图表，先想清楚这两条。

标的口径是 `symbols` 集合 ∪ `sync_state`，与 `readGlobalSummary` 的计数保持一致；只列集合成员
会让「用 `data fetch` 写过但没进集合」的标的带着真实数据从页面上消失。

**界面规范**（`apps/web/ui/src/styles.css` 是唯一出处，细节见 `apps/web/README.md`）：

- **两套主题几何完全一致**：切主题只换颜色、不换布局，免得用户在两个主题之间重新认路。
  新增颜色时**先想清楚它在两个主题里分别是什么**，不要随手写一个 rgba。
- **窄屏不许出现横向滚动**（320px 起都不许）：表格在 ≤860px 整体变成卡片列表，
  每列的表头文案写在 `data-label` 上（DOM 不复制表头）；顶栏在 ≤720px 拆成两层，
  长文本（迁移名）换成短形式并把完整值放进 `title`。加新控件后要用无头浏览器量一遍
  `documentElement.scrollWidth`，别只看自己那台机器。
- **控件形态跟着语义走**：互斥选项（周期、区间）用分段控件，开关用 switch，
  状态用色点 + 文字，危险操作用 danger 按钮。不要一排同样大小的小按钮了事。

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
3. **重挂顺序固定「先撤旧、再挂新」**（2026-10-22 实测后改，见 §6.8.4）。
   原先写的是「先挂新、再撤旧」，理由是「先撤后挂会造出无保护窗口」——
   **那个前提在 Binance 上不成立**：同一标的、同一方向**只允许存在一张 `closePosition`
   条件单**，而条件单**没有改价接口**（`PUT /fapi/v1/order` 只支持 LIMIT，条件单已迁到
   Algo 端点）。所以「先挂新」那一步必然被拒，想换价只能「撤一张、挂一张」。
   代价是两次调用之间的**短暂无保护窗口**（一次 API 往返量级）——
   与「止损永远停在入场那一档、移动止损整条线空转」相比小得多。
   三条兜底：**撤单失败不中断**（旧单可能还在、也可能已经没了，由挂单的成败裁决）；
   **挂新失败 → 立刻用旧价挂回去**（撤旧已成功而新单没挂上时，仓位是**裸的**）；
   **恢复也失败 → 裸仓**（记可见原因，对账的 `missing-stop-order`（紧急）会报出来）。
   ⚠️ 与 v0.7.0 需求原文的 R-4.1（「先挂新、再撤旧」）**不一致**：那是历史验收记录，
   不改原文，变更记在这里（与 §6.8.1 同一处理方式）。
4. **极值与 ATR 必须一次取数、同一条不跨缺口规则**，各自用自己的段（极值走持仓期、ATR 走窗口）。
   两次取数之间会落进一根新 bar，公式随即失去意义。`entryTime` 是必填形参——
   拿不到持仓期起点就算不出极值，**不许默认成 0 或用窗口起点顶替**。
   两条落地口径**不是笔误**，改动前先想清楚：极值取的是 **ATR 那个周期**的 high/low
   （要「一次取数」就只能同周期；`atrInterval` 缺省 1m，与「1m 极值」一致），
   且下界是 `time >= entryTime`，**不含入场那一根**（把入场前的影线算成持仓期高点
   会让止损一开始就偏宽）。
   极值取不到只是「本轮不调整、保留上一档 + 可见原因」，它**不是** `RISK_ATR_UNAVAILABLE`
   （后者要拒绝下单），两者严重度不同，不许混成一个码。
   **「取不到」在摘要里是 `extreme: null`，不是抛错、不是 0、也不是缺字段**：
   极值与 ATR 在**同一次取数**里，Python 侧一抛错就把 ATR 一起带走，调用方只能把整次取数
   当成「ATR 不可用」而**拒绝下单**——而「刚开仓」时持仓期内一根已收盘 K 线都没有，
   极值**必然**取不到，于是**新开仓永远挂不上保护单**（成交事件不会重放，没有第二次机会），
   仓位从此裸奔。2026-10-21 实测踩到并修掉（见 §6.8.1）。
5. **阶段由 `state` 表达，不新增 `stage` 列**：`armed` / `partial_armed` / `trailing` /
   `take_profit` / `stop_loss` / `cancelled` / `failed`，迁移只**追加** CHECK 的取值。
   `trailing` 行**只有一张止损单**；`atr` / `stop_price` / `take_profit` 三列保持入场时的值不变
   （它们记的是「第一段为什么这么算」），移动中的那一档写在 `trail_stop_price`
   （= **交易所上那张止损单现在的价**，见 §6.8.3 第 3 条）。

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

#### 6.8.1 止盈倍数合并成一个（v0.9.0 追说明）

v0.7.0 的原文把止盈拆成「整段倍数 `takeProfitAtrMult`」与「第一段倍数 `takeProfit1AtrMult`」
两个数，各有各的输入框、各有各的列。**v0.9.0 起只留一个止盈倍数**——因为两个数表达的是
同一件事（「涨到离入场多少个 ATR」），拆成两个输入框只是让用户把同一个答案填两遍，
还多出一份「哪个数当前生效」的判断。需求原文不改（那是历史验收记录），变更记在这里。

四条不可协商的规则：

1. **止盈倍数只有一个**：`executor.takeProfitAtrMult`。`takeProfit1AtrMult` 从配置 schema、
   `risk_policy` 表、`risk_bracket` 留痕列、LLM 决策结构、web DTO 与表单里**全部消失**
   （迁移 `014_take_profit_single_mult` 直接 `DROP COLUMN`，不留空壳——留着会诱导写出第二份实现）。
2. **比例从三档变两档**：`takeProfit1Ratio` 的 `0` = 不分批（一张 `closePosition` 全平止盈单），
   `1–99` = 分批（先按比例减仓，剩余仓位进 `trailing`）。原先的 `100%` 那一档**不是被删了，
   而是被归一到 `0`**——动态策略下模型给的是一组数，`0` 与 `100%` 会挂出不同的价，
   直接删会丢表达力；合并成单一倍数后两者逐字等价。
3. **归一只有一份实现**：`packages/core/src/risk-policy.ts` 的 `normalizeTakeProfit1Ratio`
   （`1 → 0`，越界抛 `CONFIG_INVALID`）。配置 schema 用 `.transform` 复用它，
   `deriveStagedPlan` 与 LLM 决策校验都调它。**决策留痕必须在落库前归一**
   （`clampLlmDecision` 里做），否则会留下「留痕记 1、实际按 0 算」的错位。
4. **比例的 CHECK 收紧为 `< 1`**（迁移 014，`risk_policy` 与 `risk_bracket` 两处都改）：
   `1` 不是非法值但已被归一，写库前就该被挡住。

`risk_bracket.tp1_price` 列与 `partial_armed` 的 staged_check **保留不动**：它与 `take_profit`
现在同值但概念不同（第一段那张单的触发价 vs 这个仓位的止盈价），将来若变成真两段止盈各有用处。

#### 6.8.2 极值取不到时摘要回 `null`（v0.9.0 追说明）

2026-10-21 实测踩到并修掉的缺陷：**新开仓挂不上任何保护单**。它与 §6.8.1 无关，
是 v0.7.0 遗留的，实现 v0.7.0 时没暴露（单元测试的入场时刻都在过去）。

成因是一条链：极值与 ATR 在**同一次取数**里（§6.8 第 4 条的 R-6.2）→ Python 侧
`compute_position_extreme` 在「持仓期内一根已收盘 K 线都没有」时**抛错** → 一次抛错把
**同一次调用里的 ATR 一起带走** → TS 侧只看到「这次取数失败了」→ 按 §6.3 第 3 条
「取不到就拒绝下单」**拒绝挂单** → 成交事件**不会重放**，于是这笔仓位永远没有保护单。

而「持仓期内一根已收盘 K 线都没有」**不是异常，是刚开仓的常态**：成交后几秒内
没有任何一根 K 线收盘，持仓期与「已收盘 K 线」的交集必然为空（`atrInterval` 配成 1h 时
要等一小时，配 1m 也要等一分钟——但那一次机会早过了）。

三条不可协商的规则：

1. **极值取不到时摘要里的 `extreme` 是 `null`**，不是抛错、不是 0、不是 NaN、
   也不是「缺字段」。缺字段是契约破损（Python 侧版本不对），那要报错；
   `null` 是「这一项本轮没有」，是合法状态。**0 更不行**：0 会被当成价格算进
   Chandelier 公式，于是止损位变成一个从未成交过的价。
2. **调用方按 R-6.5 处置**：`null` → **本轮不移动止损、保留上一档** + 可见原因
   （`trail_last_error` + 日志），**不是**「本轮失败」，更**不是**「拒绝下单」。
   仓位仍受上一档止损保护，所以它比「失败」轻。
3. **ATR 与极值仍然是同一次取数**（R-6.2 不变）。不为了绕开这个缺陷而拆成两次调用——
   两次取数之间会落进一根新 bar，公式随即失去意义。

改这一处时**两侧要同提交改**：`quant_data/risk.py` 的摘要形状（`extreme` 可空）与
`apps/executor/src/atr.ts` 的校验（`null` 合法、缺字段报错）是同一个契约的两端。

#### 6.8.3 第一段成交之后：事实先落库、推进可重试、档位口径反过来（v0.9.1 追说明）

2026-10-21 实测踩到的缺陷：**第一段止盈成交之后，移动止损可能永远不接管**。
止损单还挂在交易所上（仓位没裸奔），但它**再也不跟着价格上移**——人只会看到一行报错。

成因是三层，一层套一层：

1. **「TP1 成交过」这个事实没有单独落库**。它只是 `markBracketTrailing`（推进到 `trailing`）
   的副作用——推进一失败，这一整段就**没影了**：成交价、数量、手续费都没记（盈亏少算一段），
   而且**没有任何东西能证明「TP1 成交过」**。没有证据就没有重试。
2. **移动止损定时器的工作集合只取 `trailing` 行**。卡在 `partial_armed` 的那行根本不在集合里，
   于是**没有任何东西会重试它**。失败原因写进了 `trail_last_error`，看着「有原因、很安全」，
   实际上那一笔仓位永远进不了移动止损。
3. **更隐蔽的一层**：`trail_stop_price` 记的是「这一轮**打算**挪到的那一档」，而订单是**之后**
   才挂的。于是「库里写了新档、交易所还挂着旧单」那一格**谁也修不了**：定时器拿它当基准，
   算出来「没变」就不动了；对账则一直报价格不符。**推进成功也不等于止损挪了。**

四条不可协商的规则：

1. **「TP1 已成交」必须先落库，且幂等**（`recordBracketTp1Fill`，`WHERE tp1_filled_at IS NULL`）。
   成交了就是成交了，**与「能不能算出移动止损」无关**：极值取不到、ATR 取不到，都不许把这一段
   吞掉。累积的平仓事实（量 / 成交额 / 手续费）也从这里记一次，重投事件**不许重复累加**
   （累加两次算出来的净盈亏是错的，而且错得看不出来）。
2. **移动止损的工作集合必须包含「TP1 已成交但没推进成功」的行**
   （`partial_armed` 且 `tp1_filled_at` 非空）。「当时算不出来」是**暂时**的
   （行情没同步到开仓之后那种），过一会儿就该重试。
   ⚠️ `partial_armed` 但 `tp1_filled_at` **为空**的行**不在**集合里——那是「TP1 还没成交」，
   属于进场保护，止损不该被移动（§6.8 第 3 条）。
3. **`trail_stop_price` 记的是交易所上那张止损单现在的价**，不是「打算挪到的那一档」。
   新档要等订单**真的挂上之后**才写（`markBracketTrailMoved`）。理由很直白：
   「阶段推进了、价位还没挪」是**可修**的（定时器下一轮接着挪），「价位写了、单还没挂」不可修。
   推进阶段（`markBracketTrailing`）只写阶段与观测（极值 / ATR 快照）。
4. **推进阶段与换档是两件事，两处各有一个唯一实现点**：
   `markBracketTrailing` 的 WHERE 只认 `partial_armed`（重放安全：第二次拿不到行），
   `markBracketTrailMoved` 的 WHERE 只认 `trailing`。
   **成交事件路径与移动止损定时器共用同一对函数**——同一个动作有两份实现，
   迟早会有一份先坏掉（这正是第 1 条的成因）。

撤旧失败仍按 R-4.3：不推进档位（账面以旧档为准，保守）、记 `trail_last_error`、
下一轮重试。阶段推进了但换档失败时，失败原因同样要常驻可见。

#### 6.8.4 止损单号必须带档位序号：号复用 = 移动止损一次都挪不成（v0.9.2 追说明）

2026-10-22 实测踩到的缺陷：**移动止损一次都没挪成功**，而账面、交易所、对账三方全绿。

症状三件套同时成立：`trail_stop_price` 恒等于入场那一档 `stop_price`；交易所上那张止损单的
`updateTime` 等于 `createTime`（挂上之后一次都没被改过）；`trail_last_error` 每 60 秒刷一次
`ClientOrderId is duplicated.`。而对账**一条差异都不报**：止损单在交易所上
（`missing-stop-order` 不报）、触发价与本地记录一致（`price-mismatch` 不报）。

成因有**两条**，缺一不可（第一条先暴露，第二条在第一条修掉之后才露出来）：

1. **自定义号被复用**：Binance 不允许同时存在两张 `clientAlgoId` 相同的挂单（重复直接被拒：
   `ClientOrderId is duplicated.`）。而止损单的自定义号只由「入场单号」派生
   （`rsk-sl-<入场单号>`），**每次挪单用的都是同一个号**——进场时挂的那张止损单用的也是它。
2. **同方向只允许一张 `closePosition` 条件单**：实测（Demo Trading，2026-10-22）
   > `An open stop or take profit order with GTE and closePosition in the direction is existing.`
   > 于是「先挂新、再撤旧」**物理上执行不了**：旧单还挂着，新单必被拒。而条件单**没有改价接口**
   > （`PUT /fapi/v1/order` 只支持 LIMIT，条件单已迁到 Algo 端点），所以想换价只能
   > **「撤一张、挂一张」**。

所以它不是「第一次成功、第二次失败」，而是**第一次就失败**。而「止损价永远停在入场那一档」
在止损还挂着的情况下**看不出任何异常**：仓位仍受保护，只是保护得不够紧。

五条不可协商的规则：

1. **每一档止损单有自己的号**：格式 `rsk-<tp|sl><档位序号>-<入场单号>`。
   **0 号沿用旧格式**（`rsk-sl-<入场单号>`）——交易所上已经挂着的那张单不必改号，
   也不必为了升级去撤单重挂。序号紧跟在 tag 后面，因此 36 字符截断**只会切到入场单号**，
   不会切掉序号（顺序反了就会把序号切掉，那比截断入场单号危险得多）。
2. **号先占后用**：每次下单尝试**先**占用一个新号（`reserveTrailStep`），哪怕那次下单最终失败。
   撤旧失败时下一轮要重挂，沿用同一个号会再撞「重复」——**重试永远失败**，那条线就此卡死。
3. **「最近一轮成没成」必须落库**（`trail_status`：`idle` / `moved` / `not-moved` / `failed`，
   迁移 `016`）。它是**唯一**能看见「移动止损在空转」的信号：价格对得上、单也还在，
   只有它能揭穿。对账据此判 `trail-move-failed`（§6.5 第 6 条）。
   ⚠️ **不许拿「尝试次数 − 成功次数」代替**：那是个**累计差**，一次失败之后永远不归零——
   移动止损早就修好了，对账却还在报「换档失败」。那是假警报，而假警报让整份报告失去可信度。
   `not-moved`（价没变 / 越过现价 / 极值取不到）**不是故障**，不许报。
   顺带：`trail_moves`（成功换过几档）回答了「挪过几次」，`trail_step`（占用过几个号）是号源。
4. **替身必须守真交易所的规则**：测试里的假交易所要校验**两条**：
   `clientAlgoId` 唯一性（同号挂第二次就抛 `ClientOrderId is duplicated.`），
   以及**同标的同方向只能有一张 `closePosition` 单**（否则就抛上面那条 GTE 报错）。
   2026-10-22 这个缺陷能活这么久，正是因为假交易所两条都不校验——
   「连挪三档」的端到端用例一直是绿的，而真交易所上第一挪就被拒。
5. **换档失败时仓位可能是裸的**：撤旧已成功、而新单没挂上 → 交易所上**一张止损单都没有**。
   那时必须**立刻用旧价挂回去**（旧价刚被交易所接受过，所以几乎不会失败），
   并把账面指向恢复出来的那张单（`sl_algo_id` 会变，价不变、档位不推进）。
   恢复也失败 → 裸仓：记可见原因，等对账的 `missing-stop-order`（紧急）报出来。

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
2. **交易生命周期事件**：「止盈止损挂单成功」「一轮买卖完成」（v0.8.0）、
   「第一段止盈成交」「移动止损换档」（v0.9.2）。

两类告警的区别是**状态型 vs 事件型**：状态型（对账差异）在下一轮不见了 = 问题恢复了，
因此要推「已恢复」；事件型（挂单成功、一轮完成、成交、换档）推过即忘，下一轮它不在了
**不代表**问题恢复了，因此不参与恢复判定（`AlertItem.oneShot`）。

⚠️ **事件型必须显式标 `oneShot`**：派发器是按**指纹**记账的，不按事件——
不标的话，下一次推别的事件时它会被当成「上一轮的问题消失了」，凭空补一条
「已恢复：…」。这不只是多一条噪音：它会把「问题真的还在」说成「已经好了」。
（2026-10-22 顺带修掉了 `llm-fallback` 的这个毛病——它一直没标。）

⚠️ **指纹只由「是什么事」决定**：一次交易里多次发生的事（移动止损换档）不能靠
「带上第几次」来区分——那样每一档都是新指纹，冷却就形同虚设，群里会被同一件事刷屏。
于是指纹只到「哪一笔仓位」为止，冷却期内只推一次，冷却期过后再推会带上**最新**的价。

⚠️ **派发器必须按「作用域」分开记账**（2026-10-22 实测踩到）：一次 `dispatch` 只看得见
**自己这个作用域**的条目，而「已恢复」是按「上一轮有、这一轮没有」判定的。
所有话题共用一份记账时，推一条生命周期事件就会把别的话题的条目当成「问题消失了」——
于是凭空多一条假「已恢复」，而**真正该恢复的那条永远推不出来**。
实测症状：对账报了一次「移动止损换档失败」，移动止损修好之后，对账不再报它了，
但群里既没有「已恢复」，反而收到一条对账的假「已恢复」。
因此 `AlertDispatcher.dispatch()` 带**作用域**参数（对账用 `reconcile`，生命周期事件用内容类型名），
记账与恢复判定都按作用域分开。

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
   取值是**通知内容类型**（`NOTIFY_KINDS`）= 9 种对账差异 + 交易生命周期事件
   （止盈止损挂单成功 / 一轮买卖完成 / LLM 决策降级 / 第一段止盈成交 / 移动止损换档 /
   Agent 方案已下单 / Agent 方案下单失败）+ **两种提示词**（§6.9.3）；
   清单只有一份，勾选项的文案由
   **服务端下发**（`NOTIFY_KIND_INFO`）——页面不自己抄一份，抄了就会漂。

   ⚠️ **两种提示词是唯二默认不勾的**（`DEFAULT_NOTIFY_KINDS` = `NOTIFY_KINDS` 去掉
   `PROMPT_MIRROR_KINDS`）：它们带着行情与**账户权益**，
   默认就发等于「装了包就把仓位信息交给第三方群」。其余各种缺省都勾上——
   它们漏推了就没人知道出事了，而提示词漏推了只是「排障时少一条线索」。

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

通知里要出现金额，于是「这个数怎么算」就成了**硬约束**。五条不可协商：

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
5. **非计价币手续费要先折算**（v0.9.3）：币安的手续费**不一定**用计价币收——开了
   BNB 抵扣就用 BNB 收。不折算就是把「0.00009805 BNB」当成「0.00009805 USDT」
   记进 `fee_amount`，差着几百倍（2026-10-23 实测踩到，净盈亏因此虚高）。
   折算按**标记价**（`/fapi/v1/premiumIndex`），纯算术在
   `packages/core/src/pnl.ts` 的 `feeInQuoteAsset()`，取价在
   `packages/data/src/binance-private.ts` 的 `markPrice()`。
   **折算失败时跳过那一笔，但绝不因此拒绝算盈亏**：保护照挂、账照样结，
   少算的那一笔在库里留下痕迹（`fee_asset` 有值而 `fee_fx_rate` 为空），
   通知里也要说人话。宁可少算，也不写一个错的数进去。

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

### 6.9.3 提示词镜像：把发给模型的那一组消息同步发到群里（v1.0.0）

模型这一环是整个仓库里**最黑**的一环：输入是几千字提示词，输出是一段 JSON，
中间没有任何东西落在日志或界面上。于是「模型为什么这么答」永远答不出来——
只能看到结论（看多 / 看空 / 止损几个 ATR），看不到**它当时看见了什么**。
提示词镜像就是补这条线索。

**有两个进程会调模型**，于是有两种提示词：

| 来源                | 谁发的                         | 频率                       | 勾选项            |
| ------------------- | ------------------------------ | -------------------------- | ----------------- |
| `agent-analyst`     | Agent 的分析师（每个标的每轮） | 缺省 15 分钟一条           | `agent-prompt`    |
| `agent-trader`      | Agent 的交易员（每个标的每轮） | 缺省 15 分钟一条           | `agent-prompt`    |
| `executor-decision` | executor 按成交价问模型要档位  | **每次成交一条**（v0.9.0） | `decision-prompt` |

实现分两半：**纯函数在 core**（`packages/core/src/model-prompt.ts`），
**运行时在 `packages/data`**（`packages/data/src/prompt-mirror.ts`）。

⚠️ **运行时为什么在 `packages/data`**：两个 app 都要镜像，而 `apps/*` 之间
**不能互相依赖**（约定 1：包之间只依赖 `core`）。`packages/data` 已经持有通知设置的
读写与优先级解析（`db/notify.ts`），而两个 app 都依赖它——于是**共用同一份**。

⚠️ **两种提示词分成两个勾选项**，因为**频率差得远**：合成一种的话，勾了它就等于
「每笔成交往群里发一条」——那是刷屏，而刷屏的告警等于没接（§6.9 第 2 条）。
分开则由用户自己取舍。

四条**不可协商**的规则：

1. **逐字**。镜像的是**真正发出去的那一组消息**（同一个数组既用来调模型、
   也用来镜像），不是重新拼一份。重新拼的那份一旦与模型看见的有出入，
   这条排障线索就废了。
2. **默认不勾**。这两种是全部通知内容里**唯二默认关闭**的
   （`DEFAULT_NOTIFY_KINDS`）：提示词里带着行情与**账户权益**，
   默认就发等于「装了包就自动把仓位信息交给第三方群」。
   其余那些内容（对账差异、挂单失败、成交）漏推了就没人知道出事了，
   而提示词漏推了只是「排障时少一条线索」——两者的严重度不同，因此默认值不同。
3. **截断要看得见**。提示词可能超过飞书单条消息的上限（卡片请求体 30 KB），
   截断时**必须写明**截了多少。悄悄截掉一半比不发更坏——
   人会以为那就是模型看见的全貌。
4. **推送绝不影响主流程**。飞书挂了、超时了、被拒了——**分析照跑、挂单照挂**。
   但**失败必须看得见**（记日志），不能一声不响（约定 9）。

⚠️ **镜像在调模型之前**：模型超时或崩了，群里那条提示词仍然在，
而那正是排障最需要的东西。

⚠️ **它不走 `AlertDispatcher`**：派发器按**指纹**去重 + 冷却，而每轮每标的的提示词
都是**不同的内容**（行情变了），按指纹压会把不同轮的提示词当成同一件事。
提示词是**事件型**（推过即忘），直接用 `Notifier.notify()`。

⚠️ **守护进程与命令行必须同一份行为**：`apps/agent` 与 `apps/cli` 共用
`createPromptMirror` + `createNotifyChannelResolver`。同一个配置，守护进程往群里发
而命令行不发——那是「同一件事两个答案」，正是这个仓库最忌讳的形态。

⚠️ **通道每条提示词解析一次**：控制面改完设置**不必重启进程**（下一条就生效），
与通知设置同一套做法。

代码位置：

| 东西                       | 在哪                                            |
| -------------------------- | ----------------------------------------------- |
| 系统提示 / 截断 / 消息构造 | `packages/core/src/model-prompt.ts`             |
| 运行时镜像 + 通道解析      | `packages/data/src/prompt-mirror.ts`            |
| 通知种类清单               | `packages/core/src/notify.ts`（`NOTIFY_KINDS`） |
| 表结构                     | `packages/data/sql/020_agent_prompt_notify.sql` |

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

### 6.11 分析师 / 交易员 Agent 层（v1.0.0）

两个 Agent 回答两个不同的问题：

- **分析师**（`packages/core/src/agent-analyst.ts`）：这个标的**值不值得碰**，以及**凭什么**。
- **交易员**（`packages/core/src/agent-trader.ts`）：既然值得做，**怎么做**——进场、仓位、止损。

它们跑在**新的进程入口** `apps/agent`（不是 sync、不是 CLI-only），CLI 通过依赖
`@trade-tool/agent` 复用**同一份编排**，所以「命令行跑出来的」与「守护进程跑出来的」口径一致。

#### 6.11.1 六条不可协商

1. **模型只输出比例，不输出价格与数量**（= §5 第 13 条）。模型能说的只有：
   三个面的分数、置信度、止损 / 止盈的 ATR 倍数、风险占权益的百分比、进场方式与偏移。
   **绝对价格、数量、名义金额、亏损金额一律由程序算**：
   - 价格走 `deriveBracketPlan`；`apps/executor` 挂单走 `deriveStagedPlan`——
     **两个不同的函数**，但算式与 tick 对齐方向**逐字相同**，
     因此「方案上的止损价」与「交易所上的止损价」不会差一个 tick；
   - 数量走「愿意亏多少钱 ÷ 每股亏多少」再按 `stepSize` 对齐。
     理由：模型说「买 0.35 个」完全可能是在算 3.5 个，而**没有任何一处会报错**；
     比例算错时绝对金额仍然可控。
2. **总立场由纯函数合成，不由模型给**。模型给三个面的分数，
   `aggregateAnalystReport` 按权重算出 stance / confidence / agreement。
   否则「报告里写着看多、库里记的是看空」这类漂移无从查起（判据只有一份，§6.1 第 1 条）。
   **一致性（agreement）要折进 confidence**：三个面互相矛盾时，即便模型自评信心很高，
   合成后的信心也会被压下去——互相矛盾的面本来就不该被当成高置信度结论。
3. **方向与结论矛盾 → 拒绝出方案**（抛 `AGENT_PLAN_INVALID`）。分析师看多而交易员做空，
   是两个 Agent 读同一份数据得出相反结论，出方案等于把矛盾变成真钱。
   但**中性结论不算矛盾**：允许两个方向，**风险敞口按 `neutralRiskFactor` 减半**。
4. **越界夹住并留痕，不静默截断**。风险比例超上限 → 夹到上限；盈亏比不达标 → 抬高止盈倍数；
   名义金额超上限 → 按上限缩量。这三处都是「往下夹更安全」，因此夹住即可，
   但每一处都要记进 `adjustments`（落库、页面、CLI 都看得见）。
   只有**没法夹**的情况才拒绝：方向矛盾、算出的数量低于交易所最小下单量。
5. **失败必须留痕**。模型超时 / 输出不合法 / 方案算不出来——都落一条 `action='failed'`
   的方案并写明原因。**不静默跳过**（§5 第 9 条）。理由很实在：页面上要能回答
   「这个标的今天分析过没有」，而「分析过但没结论」与「压根没分析」是两件完全不同的事。
6. **默认只出方案，不下单；打开开关才真的下单**。`agent.execute.enabled` 缺省 `false`，
   方案只落库（`trading_plan.status = 'advisory'`），控制面与 CLI 看得到。
   开关打开时 `apps/agent` 产出的**可执行**方案直接落 `approved`，由 `apps/executor`
   消费并变成真实订单（细节见 §6.12）。
   ⚠️ **开关打开时不许出现「两处开关」**：用户已经打开「允许自动下单」，
   还要再去控制面点一次批准，于是「开关打开了却没下单」看起来像是坏了。
   控制面与 CLI 的「批准」因此是**预先批准**（executor 在开关关着时压根不消费）。
   ⚠️ **「可执行」必须与执行器的口径一致**：自动执行**只支持市价进场**，
   因此**限价方案不自动批准**（落 `advisory` 并写一条显眼日志）。
   批准一份执行不了的方案，它就会永远卡在 `approved`——每轮被捞出来又跳过，
   而页面上显示「已批准、等 executor 消费」，看上去像是有一单在等着下。
   这是「以为会做、实际什么也没做」（§5 第 9 条）。
   ⚠️ **判据只有一份**（`packages/core/src/agent-plan.ts`），**四处共用**：
   agent 的自动批准、控制面的人工批准、CLI 的人工批准、executor 的兜底检查。

#### 6.11.2 数据的来源与「取不到」的两种待遇

三个面的数据来自三个地方，**严重度不同，因此处置也不同**：

| 面     | 数据来源                                      | 取不到时                                         |
| ------ | --------------------------------------------- | ------------------------------------------------ |
| 技术面 | Python 现算（`quant_data/market_context.py`） | **直接报错**（`AGENT_CONTEXT_UNAVAILABLE`）      |
| 情绪面 | Binance 公开合约接口（7 个，免密钥）          | **降级**：记 `notes` + `degraded=true`，照常分析 |
| 基本面 | 库内 `contract_spec` 快照 + 公开 ticker 24h   | 缺项记 `null`（见下）                            |

- **技术面缺失 = 报错**，因为没有 K 线就没有任何分析依据，硬跑只能靠编。
- **情绪面缺项 = 降级但可见**：缺哪一项写进 `notes`，并把 `degraded` 落库、页面显示。
- **取不到的项一律是 `null`，不是 0**（§5 第 2 条）。「资金费率是 0」与「资金费率没取到」
  是两件完全不同的事，模型对它们的判断应当相反。

**技术面在 Python 侧现算，不物化 `indicator_*` 表**：指标层默认关闭且占同步 72% 耗时
（§6.2），按需算单标的几百根是毫秒级。指标公式仍然**只有一份**——
`quant_core/indicators.py`（§6.2 第 1 条），TS 侧不得出现任何指标实现。

**客观倾向分在 Python 侧算**（`objective_bias()`），与 `judge_bucket` 同性质：
判据只有一份，给模型一个锚点。模型可以不同意，但分数与锚点差太远时，复核的人一眼看得出。

**合约规格读库里 `contract_spec` 快照**，不重新拉 exchangeInfo：规格必须与下单用的是**同一份**，
否则「方案的 tick 对齐」与「交易所接受的 tick」会分家。

#### 6.11.3 权益来源：显式二选一，不做优先级解析

仓位大小是「愿意亏多少钱 ÷ 每股亏多少」算出来的，分母是**账户权益**，所以算仓位就必须知道权益。
`agent.equitySource` **显式选一条**：

- `exchange`：从交易所读实时余额。要凭据（`executor.apiKeyEnv` / `apiSecretEnv` 或控制面加密存的那份）。
- `config`：用 `agent.equity` 写的数。适合「只做分析、不碰账户」，但它是**手动维护**的。

缺省 `exchange`：权益写错会直接变成仓位算错，而仓位算错就是真钱。
`equitySource = 'config'` 却没填 `equity` 时**明确失败**，不拿 0 去算
（0 会算出 0 数量——一个看起来正常、实际什么都不做的方案）。
**读不到就抛错，不返回 0**（0 会被当成「账户没钱」）。

#### 6.11.4 落库与状态机

两张表，迁移 `017_agent_decisions`（§6.0）：

- `analyst_report`：三面分数 + 合成立场 + 理由 + **当时喂给模型的完整上下文** + 模型原始返回。
  留上下文是因为只存结论的话，模型改了提示词就再也复现不了「它当时看到了什么」。
  唯一索引 `(exchange, symbol, as_of_ms)`：同一份数据时刻的同一标的只留一份报告。
- `trading_plan`：`action`（`enter` / `hold` / `failed`）、进场三件套、风险、权益来源、
  `adjustments`、`failure_reason`，以及 `status` 状态机
  （`advisory` → `approved` / `rejected` / `expired` → `executing` → `executed` / `failed`）。
  `executing` 与 `failed` 是 v1.0.0 补自动执行时扩出来的两个状态（§6.12）。

**表级 CHECK 约束**各自守一条不变式：
`enter` 三件套齐全、止损止盈分居两侧、`hold` 不许带原因、`action='failed'` 必须带原因、
`executed` 只能来自 `enter`。它们是**最后一道闸**——页面上显示的方案是给人看的，
而库里那条是事实。

⚠️ **「失败」有两个，别把两条约束写成同名**：`action='failed'` 是「这一轮**出不了方案**」，
要说清的是 `failure_reason`；`status='failed'` 是「这一笔**没下出去**」，
要说清的是 `execution_failure_reason`。两件事各自的守门人**必须并存**——
用同名约束的话，后一条的 `DROP CONSTRAINT` 会**顺带删掉**前一条，
于是「出不了方案必须说为什么」这条守门人无声消失（§5 第 12 条）。

**两个 id 的语义不一样，别把它们当成一对**：报告按 `(exchange, symbol, as_of_ms)`
**upsert**（同一份行情时刻只有一份报告，id 不变），方案**每轮新建**（id 递增）。
于是「报告 #1 + 方案 #5」是正常状态。展示时必须写明「这份方案基于报告 #几」，
否则页面上两个号对不上，看着像数据错了。

**刚跑完一轮时按 id 读，不要读「最近一条」**：「最近一条」会读到**上一轮**的——
分析师这一步失败时，就会显示上一轮的旧报告，看上去像「这次分析过了」。
`packages/data/src/db/agent.ts` 的 `readAnalystReportById` / `readTradingPlanById`
就是为这件事准备的。

#### 6.11.5 停止与退出

进程收到 `SIGINT` / `SIGTERM` 时：**打断休眠 → 等这一轮跑完 → 关池 → 退出码 0**。

两条都别省：

- **打断休眠**：`agent.intervalMs` 缺省 15 分钟。不打断的话，进程管理器
  （systemd / docker 通常只给 10 秒宽限）会直接**强杀**，这一轮停在半路。
- **等这一轮跑完**：半轮是「看起来成功了，其实什么都没做」的一种——
  报告落了、方案没落，页面上会有一份报告，而与之对应的方案永远不会有。

启动失败**不打印 Node 堆栈**，而是一行 `[agent] 启动失败：<错误码>: <怎么配>`

- 退出码 1（与 `apps/executor` 同一套写法）。

#### 6.11.6 代码位置

| 东西                                   | 在哪                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| 分析师契约与纯函数                     | `packages/core/src/agent-analyst.ts`                            |
| 交易员契约与纯函数                     | `packages/core/src/agent-trader.ts`                             |
| **方案可执行性判据（一处，四处共用）** | `packages/core/src/agent-plan.ts`                               |
| 行情上下文契约（zod）                  | `packages/core/src/agent-context.ts`                            |
| 技术面现算 + 情绪面取数                | `python/packages/quant-data/src/quant_data/market_context.py`   |
| 上下文组装 + 落库读写                  | `packages/data/src/market.ts` + `packages/data/src/db/agent.ts` |
| 编排 / 守护 / 权益                     | `apps/agent/src`（`service.ts` / `daemon.ts` / `equity.ts`）    |
| 控制面面板（可批准 / 驳回）            | `apps/web/ui/src/components/AgentPanel.tsx`                     |
| **自动下单的执行器**                   | **`apps/executor/src/plan-execution.ts`**（§6.12）              |
| **模型设置面板**                       | **`apps/web/ui/src/components/AgentLlmPanel.tsx`**（§6.13）     |
| 表结构                                 | `packages/data/sql/017_agent_decisions.sql`                     |

#### 6.11.7 三个新错误码

`AGENT_REPORT_INVALID`（模型输出不合法）、`AGENT_PLAN_INVALID`（方向矛盾 / 数量低于
最小下单量 / 盈亏比夹不动）、`AGENT_CONTEXT_UNAVAILABLE`（行情上下文取不到）。
它们加在 `SyncErrorCode` 上，控制面映射成 HTTP 502。

### 6.12 自动下单：把「批准的方案」变成真实订单（v1.0.0）

自动下单放在 **`apps/executor`**，不是 `apps/agent`：下单要用交易所凭据，而凭据在
executor 那边；且 executor 本来就持有私有接口、净仓跟踪与成交处理器。
`apps/agent` 只负责**出方案**，executor 负责**执行方案**，两边不重叠（§1 的职责表）。

#### 6.12.1 三步：认领 → 下单 → 回填

中间那一步（下单）会出网，是唯一不可回滚的一步。

- **认领**（`approved → executing`）：**幂等锚点**。
- **下单**：市价进场（`POST /fapi/v1/order`，回执 `orderId`）。
- **回填**：写回单号与时刻（`executing → executed`）。

⚠️ **为什么不能只有「下单 → 回填」两步**：下单成功但回填前进程崩掉的话，那一单已经
真实存在，而库里没有任何东西记着它。下一轮再跑一次就是**重复下单**——仓位翻倍，
而日志与库里都看不出异常。认领把「这一份方案归我了」先写进库，崩在中间时方案停在
`executing`，**不会被自动重试**（那一单到底下没下只有交易所知道），执行器把它当
「状态未知」报出来等人确认。**宁可停下来问，也不要重复下单。**

#### 6.12.2 四条不许省的规矩

1. **只支持市价进场**。限价单可能永远不成交，而不成交的仓位**没有止损保护**。
   判据**只有一份**（`packages/core/src/agent-plan.ts` 的 `autoExecutableProblem` /
   `assertApprovable`），**四处共用**，不许各写一遍：
   - agent 的**自动批准**：限价方案落 `advisory` + 一条显眼日志（不自动批准）；
   - 控制面与 CLI 的**人工批准**：**在批准时**就拒绝并说明原因；
   - executor 兜底：万一有 `approved` 的限价方案漏进来（历史数据 / 绕过批准路径），
     它**不认领**、直接跳过并写明原因——**不认领**是因为认领是幂等锚点，
     把一份永远执行不了的方案认领走只会让它卡在 `executing` 变成「状态未知」，
     那比跳过更糟。
   - **控制面页面**：它**不自己判**，而是由服务端用同一条判据算好，随 DTO 一起回给页面
     （`approvable` / `approvableReason`）。页面拿到 `approvable = false` 就不给「批准」按钮，
     并把 `approvableReason` 原样显示出来。
     ⚠️ **页面不能 import `@trade-tool/core`**：core 的 barrel 带着 `node:crypto` / `node:fs`，
     浏览器构建会**直接失败**（`createHmac is not exported by __vite-browser-external`），
     实测过。前端要 import core 的东西，只能是**类型**（`import type`，编译期擦除）。

   ⚠️ **各处各写一遍的后果**：迟早有一处忘了改，而那一处恰好就是
   「批了一份永远执行不了的方案」的地方——它会永远卡在 `approved`，
   每轮被捞出来又跳过，而页面上显示「已批准、等 executor 消费」，
   看上去像是有一单在等着下（§5 第 9 条）。

2. **自定义号带尝试次数**：`agt-p<方案id>-a<次数>`。Binance 不允许两张同
   `clientOrderId` 的挂单同时存在，沿用同一个号重试必然撞「重复」——
   与止损单号复用是同一个坑（§6.8.4）。
3. **已有仓位不叠加、已有未终结保护不开新仓**：条件单保护的是**整个净仓位**，
   重复挂会出现多组触发价互相撤销。
4. **方案档位优先于配置档位与模型决策**（`decision_source='agent-plan'`）。
   理由：方案是**人批准时看到的**，配置档位随时会被改；让人批准的数和实际挂单的数
   必须是同一个。**价格仍由 `deriveStagedPlan` 按实际成交价算**
   （方案里的进场价是估算值）。

#### 6.12.3 反查失败不抛错

成交回报带 `clientOrderId`（`o['c']`，必返），执行器据此反查方案。
**反查失败时抛错会让仓位裸奔**（最贵的状态），因此改为：按配置档位挂单 +
**显眼错误日志**。仓位有保护，比档位完全对得上更要紧。

#### 6.12.4 `executed` 只能由执行器写

`updateTradingPlanStatus` 只允许 `approved` / `rejected` / `expired`。
`executed` 只能由执行器在**真的下过单之后**写，而且必须同时写下单号与时刻
（表上的 CHECK 守着这条）。让控制面也能置 `executed` 的话，
页面上点一下就能造出一条「已下单」的假记录。

#### 6.12.5 代码位置

| 东西                         | 在哪                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| 执行器（认领 / 下单 / 回填） | `apps/executor/src/plan-execution.ts`                                  |
| 状态机与认领的落库           | `packages/data/src/db/agent.ts`                                        |
| 市价进场单                   | `packages/data/src/binance-private.ts`（`placeMarketOrder`）           |
| 自定义号                     | `packages/core/src/risk-ids.ts`                                        |
| 控制面批准 / 驳回            | `apps/web/src/server.ts` + `apps/web/ui/src/components/AgentPanel.tsx` |
| CLI 批准 / 驳回              | `apps/cli/src/commands/agent.ts`（`trade-tool agent plan`）            |

### 6.13 模型接入的配置在控制面录入（v1.0.0）

模型接入（地址 / 模型名 / API 密钥 / 超时）从「只写在配置文件」改成
**控制面录入 + 密文落库**，配置文件与环境变量降级为**兜底档**。

#### 6.13.1 哪一份在生效：判据只有一份实现

`packages/data/src/db/llm-settings.ts` 的 `resolveAll` 是**唯一**判据：
控制面那一档填全了 + 主密钥可用 → **用控制面那份**；否则 → 用配置文件 + 环境变量。

- **判据不看 `enabled`**：`enabled` 是**那一档内部**的开关。
  把它混进优先级会出现「我在控制面关了模型，Agent 还在调模型」。
- **留空 = 保持原样**：只想改超时，不想重填密钥时，留空即可（不覆盖已存的密文）。
- **「清空控制面这一份」≠「关掉模型」**：前者退回配置文件 + 环境变量，
  后者取消勾选再保存。两者混为一谈会让用户以为模型还在跑。

#### 6.13.2 控制面读路径永远拿不到明文

`readAgentLlmStatus` 只给「配没配 / 末 4 位 / 生效来源」。
主密钥没注入时 `keyConfigured` 是 `null`（= **不知道**），不能显示成「没配」——
「不知道」与「没配」在处置上完全不同。

⚠️ **读状态这条路不因「密钥读不到」而失败**：生效来源是配置文件那一档、
而那个环境变量里没有密钥时，这是**最常见的配置错误**。若读状态也抛错，
控制面整个面板就取不到东西，页面只显示一句「模型接入设置操作失败」——
用户连「生效的是哪一份」都看不到，更不知道该去补哪个变量。
所以读状态时把「读不到」如实报进 `configKeyAvailable`（页面显示「密钥读不到」
并说清去补哪个变量）；**真要调模型时仍然抛错**（`resolveAgentLlmSettings` 那条路）
——拿着空串去请求只会得到一个语焉不详的 401。

#### 6.13.3 每轮重新解析

`apps/agent/src/llm.ts` 的 `createLlmResolver` 每轮调一次，
所以控制面改完**下一轮就生效**，不必重启进程（与通知设置同一套做法）。

⚠️ **不许再拿配置文件的 `agent.llm.enabled` 当前置闸门**：模型接入可以在控制面配，
用户在控制面填好、配置文件保持默认（`enabled` 缺省 `false`）是**完全合法**的配置。
若守护进程与 CLI 各自拿 `config.agent.llm.enabled` 先判一遍，就会出现
「同一个配置，守护进程能跑、命令行说没配模型」——**同一件事两个答案**，
正是这个仓库最忌讳的形态（§6.11.1 说的「CLI 与守护进程共用同一份编排」）。
判据只有 `resolveAll` 一份；它报错时说清「生效来源是控制面录入还是配置文件」。

#### 6.13.4 代码位置

| 东西                 | 在哪                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| 设置读写与优先级解析 | `packages/data/src/db/llm-settings.ts`                               |
| 密钥加解密           | `packages/core/src/secret.ts`（`sealAgentLlmKey`）                   |
| 每轮解析             | `apps/agent/src/llm.ts`                                              |
| 控制面路由           | `apps/web/src/server.ts`（`GET/PUT/DELETE /api/settings/agent-llm`） |
| 控制面面板           | `apps/web/ui/src/components/AgentLlmPanel.tsx`                       |
| 表结构               | `packages/data/sql/019_agent_llm_settings.sql`                       |

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
| 6   | **切 `executor.environment` 不会切换已落库的账本**：`risk_bracket` / `reconcile_run` 记的是「账户侧」事实，而库里没有环境列。主网的 `armed` 记录被拿到 demo 账户上对账时，会报出 `missing-stop-order`（critical）+ `missing-take-profit-order` + `record-without-position` 三条**假警报**；更糟的是那条 `armed` 记录若与 demo 新单撞上同一个 `entryOrderId`，新仓的止盈止损会被判重跳过，仓位裸奔而日志正常 | `packages/data/sql/006_risk_bracket.sql`（无 environment 列）、`apps/executor/src/main.ts` | 切环境时**同时清理账户侧账本**（`risk_bracket` / `reconcile_run`），或给这两张表加环境维度。行情侧（`klines_*` / `symbols` / `contract_spec` / `gaps`）**不需要**动：价格与合约规格两个环境一致 |
| 7   | 控制面 `ReconcilePanel.tsx` 里有一份**差异类型的中文文案表**（`KIND_LABEL`），与 core 的 `RECONCILE_KIND_INFO` 各写一份。两边的措辞本来就不一样（页面那句更完整）                                                                                                                                                                                                                                           | `apps/web/ui/src/components/ReconcilePanel.tsx`                                            | 让差异类型带上服务端下发的文案（core 的 `RECONCILE_KIND_INFO` 是唯一来源）；`tsc` 会在这张表漏改时报错，所以它**现在不会静默漂移**，但它仍是第二份清单                                          |

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

### 8.4 「判据在 core，用例在用它的那个包」

一条判据住在 `packages/core`（纯函数），**用它的那个包也要有用例**——
core 的测试守的是「判据本身对不对」，包的测试守的是「这个包确实调用了它」。
**两者缺一不可**：判据对了但没接上，等于没接上；而判据只有 core 那一份测试守着时，
接错了地方也没人发现。

本仓库现成的例子：方案「能不能自动执行」这条判据在
`packages/core/src/agent-plan.ts`，**四个包**都用它
（`apps/agent` 自动批准、`apps/web` 人工批准、`apps/cli` 人工批准、`apps/executor` 兜底），
于是四个包各有一条用例守着「我确实用了它」（§6.12.2）。

⚠️ **前端页面是第五个使用者，但它不能直接 import core**（core 的 barrel 带 node 内置模块，
浏览器构建会失败）。页面的做法是：**服务端算好，随 DTO 传过去**。
所以「页面也用这条判据」这件事，靠的是 `apps/web` 的用例守住的——
它守的是「服务端算出来的 `approvable` / `approvableReason` 对不对」，
页面再守一条「拿到 `approvable = false` 就不给批准按钮、但把原因显示出来」。

⚠️ `apps/cli` 原本**没有测试设施**（没有 `test` 脚本、没有 vitest）。
补上它很容易（照 `apps/executor` 加 devDep + 脚本 + `tsconfig` 含 `tests`），
但别以为「这个包没测试所以没人动它」——那正是它悄悄漂移的原因。

## 9 进程入口、常用命令与部署

| 入口                                            | 说明                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @trade-tool/cli start -- <命令>` | 源码直跑（tsx）。`--help` 有命令表                                                                                                                 |
| `node apps/cli/dist/index.js <命令>`            | 构建产物（也是 `package.json` 的 `bin`）                                                                                                           |
| `pnpm --filter @trade-tool/sync start`          | 常驻同步守护进程                                                                                                                                   |
| `pnpm --filter @trade-tool/web start`           | 控制面 `http://127.0.0.1:8787`（地址由 `.env` 决定）                                                                                               |
| `pnpm --filter @trade-tool/executor start`      | 止盈止损，需 `executor.enabled = true`，**会真下单**                                                                                               |
| `pnpm --filter @trade-tool/agent start`         | 分析师 + 交易员 Agent，需 `agent.enabled = true`，**默认只出方案**；`agent.execute.enabled = true` 时产出的方案直接进 `approved`，由 executor 下单 |
| `pnpm --filter @trade-tool/cli start -- doctor` | 自检 node / pnpm / uv / git                                                                                                                        |

Agent 的两个入口（守护进程 / CLI 单跑一次）共用 `@trade-tool/agent` 的同一份编排：

```bash
pnpm --filter @trade-tool/cli start -- agent run              # 跑一轮
pnpm --filter @trade-tool/cli start -- agent run -s BTCUSDT   # 只跑一个标的
pnpm --filter @trade-tool/cli start -- agent report            # 只看库里最近的报告与方案
pnpm --filter @trade-tool/cli start -- agent plan 42 --approve  # 预先批准一份方案
pnpm --filter @trade-tool/cli start -- agent plan 42 --reject   # 驳回一份方案
```

`agent run` 与守护进程的**唯一区别**是「跑一次就停」；口径完全一致。
`agent report` 是**纯读**——它不调模型、也不写库。
`agent plan` 的批准/驳回是**预先批准**：自动执行开关关着时，executor 压根不消费方案，
所以「批准了」不等于「会有单下出去」——命令输出会明确说清这一点。

stdout 是命令结果（日志走 stderr），`--json` 时输出纯 JSON。**生命周期变更不走 CLI**，
走 `@trade-tool/sync` 的控制原语（`addSymbol` / `removeSymbol` / `listSymbols` /
`start` / `pause` / `resume` / `getStatus` / `getSummary`，全部幂等、类型完整、不依赖 HTTP 框架）。

打包细节：`tsup` 的 `banner` 一律**不要用**——各入口 `src` 自带 shebang，叠一个 banner 会得到
两个 shebang，第二个落在第 2 行，Node 只在第 1 行识别 shebang，于是构建产物无条件
`SyntaxError` 并以退出码 1 结束。

**部署到服务器**走 [`deploy/`](deploy/README.md)：本机构建镜像 → `dist-deploy/*.tar` →
目标机 `docker load`。四条落地约定：

- 三个应用服务（web / sync / executor）**共用同一个镜像**，只靠 `command` 区分
  （共用 workspace 产物与 Python venv）；
  ⚠️ `apps/agent` **暂不在部署编排里**——它默认只出方案、不下单，且要模型密钥与
  交易所凭据才跑得起来（见 `apps/agent/README.md`）；
- `pull_policy: never`：镜像是 save/load 搬过去的，标签不匹配就直接起不来，**不允许**悄悄去拉
  同名但不同版本的镜像；
- **迁移在每个容器的入口里跑**（[`deploy/entrypoint.sh`](deploy/entrypoint.sh)：等库 →
  `db migrate` → `exec`），因此不存在「web 起来了但库还是旧的」这种半个可用状态；
- 止盈止损在 `executor` profile 里，`docker compose up -d` **不会**启动它。

运行期 Python **不调 uv**（配置里 `data.python = "python3"`，用镜像内建好的 venv）。
代理要四条一起配（`HTTPS_PROXY` / `NODE_OPTIONS=--use-env-proxy` / `NO_PROXY` 含 `postgres` /
凭据只放目标机 `.env`），少一条就是「Python 通、Node 不通」的半通状态。

**代理变量的大小写陷阱（2026-10-21 实测）**：Node 的 `fetch`（undici `EnvHttpProxyAgent`）
**优先读小写的 `http_proxy` / `https_proxy`**。因此：镜像里**不许**留下这三个变量的空值
（`deploy/Dockerfile` 曾把 `ARG` 写进 `ENV`，空值固化进运行层，把大写顶掉），
`deploy/compose.yaml` 必须**同时显式注入大小写两套**、值取自同一个 `TRADE_TOOL_*`。
被遮蔽时的症状是「代理配了却连不上交易所，报错只有一句 `fetch failed`」——
看不出是代理问题，所以先在容器里 `env | grep -i proxy` 对一下。

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

### 10.3 `ORDER_TRADE_UPDATE` 的价字段：`p` 不是成交价（2026-10-22 核对）

**官方 USDⓈ-M 合约的 `ORDER_TRADE_UPDATE`，价字段是三个不同的东西**：

| 字段 | 官方含义             | 备注                                     |
| ---- | -------------------- | ---------------------------------------- |
| `p`  | 订单**原始**价格     | **市价单恒为 0**（限价单才是那个挂单价） |
| `L`  | 订单**末次成交**价格 | 本笔成交价                               |
| `ap` | 订单**平均**价格     | 该订单到目前为止的均价                   |

`l` = 末次成交量、`z` = 累计已成交量（这两个没歧义）。

**取错 `p` 的症状（一轮真实止损被算成假账）**：入场是市价单、止损触发后也是市价成交，
两者的 `p` 都是 0。拿 `p` 当成交价 → 出场价 0 → 累计成交额 0 →
「毛利 = (0 − 入场价) × 数量」变成一个巨大的负数（实测 −194 USDT），
飞书卡片上写着「出场 0」。**库里存的是事实（量、成交额、手续费），事实错了，
后面每一层算出来的数都是错的**——所以修在解析层，不在展示层。

两条规矩：

1. **成交价取 `L`，`L` 为 0 时退回 `ap`**；两个都是 0 就是「没拿到」，
   由调用方说「算不出」，**不許编数**（`core/src/pnl.ts` 的 `realizedPnl()` 返回 `null`）。
2. **用例要按真实 payload 形状写**。旧用例把 `p` 写成了成交价，
   于是「取错字段」这件事在测试里是绿的——**fixture 抄错了，实现跟着抄错，

> 一致地错**。新用例必须带上 `p: '0'`（市价单）与 `L`（真实成交价）。

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

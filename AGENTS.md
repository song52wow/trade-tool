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

| 新东西                          | 放哪                                 |
| ------------------------------- | ------------------------------------ |
| 领域类型、配置 schema、策略接口 | `packages/core/src`                  |
| 行情接入、缓存、Python 调用     | `packages/data/src`                  |
| **数据库表结构 / 迁移**         | **`packages/data/sql/`**（唯一来源） |
| PG 客户端、schema 闸门、查询层  | `packages/data/src/db`               |
| 回测循环、绩效指标、新策略      | `packages/backtest/src/strategies/`  |
| 命令行命令                      | `apps/cli/src/commands/`             |
| 常驻同步、生命周期、控制原语    | `apps/sync/src`                      |
| 控制面 HTTP 路由与前端页面      | `apps/web/src` + `apps/web/ui`       |
| 计算密集逻辑、指标、真实行情源  | `python/packages/*/src`              |

## 硬性约定

1. **依赖方向单向**：`core` 不依赖任何 workspace 包；其它包只依赖 `core`；
   跨语言调用只从 `packages/data` 发起。出现反向依赖说明分层错了。
2. **跨语言契约 = 数据库 schema**：K 线**只经 PostgreSQL 传输**，不经 stdout；
   `packages/data` → `python -m quant_data` 的桥接**只传控制信息**（命令、参数、结果摘要）。
   因此改 schema 必须**同提交**更新迁移文件与两侧读写代码，且两侧对同一列的
   类型 / 单位 / NULL 语义必须一致。时间统一毫秒时间戳，数据库列用 `bigint` 而非 `timestamptz`。
   PG 连接串经 `TRADE_TOOL_PG_DSN` 环境变量注入，不进 argv。
3. **schema 唯一来源是 `packages/data/sql/*.sql`**：不得在 TS 或 Python 侧另持影子定义。
4. **策略无状态**：`Strategy.onBar()` 必须是纯函数，无 IO、无随机数，回测与实盘共用同一实现。
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

## 加一个新策略的完整步骤

1. 在 `packages/backtest/src/strategies/<name>.ts` 实现 `Strategy` 接口。
2. 从 `packages/backtest/src/index.ts` 导出。
3. 在 `apps/cli/src/commands/backtest.ts` 注册到 `backtest.strategy` 的分派处。
4. 在 `packages/core/src/config.ts` 的 `backtestSchema` 里登记可配置参数。
5. 补 `packages/backtest/tests/` 用例；纯函数指标逻辑同样要覆盖。

## 命令行入口

```bash
pnpm --filter @trade-tool/cli start -- <command>   # 源码直跑
node apps/cli/dist/index.js <command>              # 构建产物
pnpm --filter @trade-tool/web start                 # 控制面（http://127.0.0.1:8787）
```

stdout 是命令结果（日志走 stderr），`--json` 时输出纯 JSON，便于管道处理。

## 控制面（apps/web）

日常操作的网页形态，做法上有三条**硬约束**，改代码时别绕过：

1. **重活儿不阻塞 HTTP**：首次全量/校验只登记 job 并返回 id（R-17.6），进度每次从
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
   不出网、不消耗交易所配额，因此才能挂在 5s 刷新节奏上。横轴按**时间**排（缺口要
   显形成空白），**不按行序**排；缺一分钟就是空一根，不插值、不拿均价线顶替。缺口在图外
   量化写明（缺多少分钟 / 几段 / 最长多长）。取数量有上限且**回传生效值**，非法 `limit`
   报错而不是静默换值；读失败常驻可见。`/bars` 的 **404 要单列**成「控制面还是改动前
   启动的旧进程，请重启」——路由在启动时注册，这一句比 `404 Not Found` 有用得多。
   改这张图时别把它换成「按序号排的通用图表」——那会把空洞压成连续走势。

标的口径是 `symbols` 集合 ∪ `sync_state`，与 `readGlobalSummary` 的计数保持一致；
只列集合成员会让「用 `data fetch` 写过但没进集合」的标的带着真实数据从页面上消失。

路由只依赖 `WebDeps` 接口，测试用纯替身（不连 PG、不出网）；需要 DOM 的 UI 用例在文件
顶部声明 `@vitest-environment jsdom`，并 import `tests/ui/setup.ts`（recharts 依赖
`ResizeObserver`）。**首屏取数用 `useLayoutEffect`**：effect 里抛异常会中止同一次 commit
里剩下的全部 effect，图表组件一个 `ResizeObserver` 就能让整页停在「读取中」。

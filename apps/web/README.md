# @trade-tool/web — 控制面

HTTP API + 前端看板，把 `apps/cli` 的日常操作变成网页操作（对应设计文档的 R-23 … R-25）。

## 跑起来

```bash
pnpm build                     # 先构建：tsup 出服务端，vite 出前端到 dist/ui
pnpm --filter @trade-tool/web start    # 或 node apps/web/dist/main.js
```

打开 `http://127.0.0.1:8787`。监听地址由 `.env` 的 `TRADE_TOOL_WEB_HOST` / `TRADE_TOOL_WEB_PORT` 决定。

开发时前后端分开跑：终端 A `pnpm --filter @trade-tool/web dev`（tsx watch，8787），
终端 B `pnpm --filter @trade-tool/web dev:ui`（Vite 5173，`/api` 自动代理到 8787）。

## 它和 CLI 的关系

控制面**直接 import** `@trade-tool/sync` 的原语与 `@trade-tool/data` 的查询层，
不 shell out 解析 stdout。守护进程仍然是独立的 `apps/sync` 进程：控制面只写
`desired_state`，由守护进程按 R-19「先落库再生效」响应，两者不需要新的通信机制。

## 五条硬约束

规矩以 AGENTS.md §6.6 为准，这里只列标题与一句说明：

1. **重活儿不阻塞 HTTP** —— 首次全量是几十分钟量级，接口只登记作业并立刻返回 job id
   （R-17.6）。进度每次从 `sync_state` 重读，所以关掉页面、甚至重启进程，进度依然
   与库里的事实一致。
2. **单写者** —— 作业不允许接管 `desired_state = running` 的标的，直接返回 409 并提示
   「请先 pause」——那是守护进程的地盘，两个进程写同一张表会撞单写者锁（R-3.3）。
3. **首次全量必须先算规模** —— `GET /api/symbols/:symbol/estimate` 拿到行数/请求数/权重后
   才允许发起（页面弹确认框），没有「缩短范围」这个选项（R-8.3）。
4. **不假装在同步** —— 「开始同步」只写 `desired_state`，干活的是独立进程 `apps/sync`。
   守护进程离线时页面必须如实显示（横幅 + 卡片 + 按钮标签），三态
   `running` / `stale` / `stopped` 分开报。
5. **K 线只画真实的行** —— `/bars` 是纯读，横轴按时间排，缺一根就是空一根，
   不插值、不拿均价线顶替；非法周期必须 400，**不得静默回落**到 1m。

## 标的详情页上的 Agent 面板（v1.0.0）

`AgentPanel` 是**只读**的：显示分析师的三面分数、合成立场 / 信心 / 一致性，
以及交易员算出来的进场 / 仓位 / 止损止盈与「已调整」记录。它挂在标的详情页
（`SymbolDetail`）里，**不另开路由、不另开页面**——报告与方案本就是 per-symbol 的。

数据来自 `GET /api/symbols/:symbol/agent`（只读 PG，不调模型、不出网）。
**页面不会替人做决定**：方案状态是 `advisory` 时，页面上明确写着「这只是建议，
自动执行关着，它不会变成真实订单」。控制面**不提供**批准 / 执行按钮——那属于
自动执行路径，本期未实现（见 `apps/agent/README.md`）。

读取失败必须**常驻可见**（AGENTS.md §5 第 9 条），不能只弹一下 toast。

## 列表口径

标的列表取的是 **`symbols` 集合 ∪ `sync_state`**，与 `readGlobalSummary` 的计数口径一致。
只有状态和历史、没进集合的标的（典型来源：直接跑过 `data fetch`）不会被藏起来，
而是标成「未纳管」并给一个「加入集合」按钮。

## 设置页的三块

`#/settings` 里有三个互不影响的区块，各自管自己的取数与错误——一个失败不带走另一个：

- **交易所 API 凭据** —— 密文落库，页面只显示末 4 位、永不回显；改完要重启 executor。
- **飞书通知**（v0.8.0）—— 填 webhook 地址、开关、**逐项勾选要通知哪些内容**（8 种差异
  类型，每种一句话说明）、重复提醒间隔；地址同样**密文**落库、页面只显示末 4 位。
  另有一个「发送测试消息」按钮，能立刻确认通道通不通。
  改完**不必重启 executor**：它每轮对账时重新读一次设置。
- **止盈止损策略** —— 全局默认 + 逐标的覆盖，页面显示「当前生效的是哪一层」。
  **止盈倍数只有一个**（v0.9.1 起）：它是「这次要卖的那部分，涨到离入场多远就卖」——
  减仓 0% 时卖全部，1–99% 时先卖那一部分（剩下的交给移动止损）。
  每个框下面都写明了「什么时候才生效」，「当前生效」那一栏也会显示当前是哪种形态。

三块都遵守同一条安全线：**写操作过同源校验**（`checkOrigin`），**读路径永远拿不到明文**。

## 界面

设计系统写在 [`ui/src/styles.css`](ui/src/styles.css)，两套主题**几何完全一致**
（切主题只换颜色、不换布局）。配色取两份参考的各一半：

- **Apple** —— 信息层级与留白节奏。字号有明确台阶，卡片靠「发丝线 + 极轻投影」分层
  而不是粗边框，顶栏固定在顶部并带一层毛玻璃，互斥选项（K 线周期、区间）用分段控件。
- **Pundi X** —— 深色终端的气质。暗色下用霓虹青做唯一强调色，数字与代码用等宽，
  标签是大写 + 字距的微型字，背景铺一层几乎看不见的网格。

响应式分三档：**≥1180px** 双栏（设置页左窄右宽）、**≤860px** 表格整体变成卡片列表
（`data-label` 提供行内标签，DOM 不复制表头）、**≤720px** 顶栏与导航拆成两层。
窄屏下顶栏只显示迁移**版本号**（完整迁移名在 `title` 里），否则一行放不下。

## 图表

**一律手写 SVG / CSS，不用图表库**（运行期依赖只有 react / react-dom / hono）：

- K 线：[`ui/src/components/CandleChart.tsx`](ui/src/components/CandleChart.tsx)。
  横轴按**时间**排布，缺一根就是空一根（按序号排会把空洞压成连续走势，R-23 明令禁止）。
- 状态分布：`OverviewCards.tsx` 里的 `.dist-bar`，一条按比例切开的横条。

两个理由都还在：① 横轴必须按时间；② 图表库的 `ResponsiveContainer` 挂载时读
`ResizeObserver`，jsdom 里抛错会**中止同一次 commit 里剩下的全部 effect**——
首屏取数就此静默失效，页面永远停在「读取中」。

## 测试

```bash
pnpm --filter @trade-tool/web test
```

- `tests/server.test.ts` —— 路由与 `SyncError → HTTP` 映射，用纯替身，不连 PG 也不出网。
- `tests/jobs.test.ts` —— 作业生命周期、护栏与进度采样。
- `tests/rows.test.ts` —— 集合∪状态的并集逻辑（纯函数）。
- `tests/ui/App.test.tsx` —— jsdom 下挂载 `<App />`，断言它真的去取数并渲染真实数据。

UI 用例需要 `ResizeObserver`（`CandleChart` 量容器宽度会用），由
`tests/ui/setup.ts` 打桩。

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

## 三条硬约束

1. **重活儿不阻塞 HTTP**：首次全量是几十分钟量级，接口只登记作业并立刻返回 job id
   （R-17.6）。进度每次从 `sync_state` 重读，所以关掉页面、甚至重启进程，进度依然
   与库里的事实一致。
2. **单写者**：作业不允许接管 `desired_state = running` 的标的，直接返回 409 并提示
   「请先 pause」——那是守护进程的地盘，两个进程写同一张表会撞单写者锁（R-3.3）。
3. **首次全量必须先算规模**：`GET /api/symbols/:symbol/estimate` 拿到行数/请求数/权重后
   才允许发起（页面弹确认框），没有「缩短范围」这个选项（R-8.3）。

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

三块都遵守同一条安全线：**写操作过同源校验**（`checkOrigin`），**读路径永远拿不到明文**。

## 测试

```bash
pnpm --filter @trade-tool/web test
```

- `tests/server.test.ts` —— 路由与 `SyncError → HTTP` 映射，用纯替身，不连 PG 也不出网。
- `tests/jobs.test.ts` —— 作业生命周期、护栏与进度采样。
- `tests/rows.test.ts` —— 集合∪状态的并集逻辑（纯函数）。
- `tests/ui/App.test.tsx` —— jsdom 下挂载 `<App />`，断言它真的去取数并渲染真实数据。

UI 用例需要 `ResizeObserver`（recharts 的 `ResponsiveContainer` 会用），由
`tests/ui/setup.ts` 打桩。

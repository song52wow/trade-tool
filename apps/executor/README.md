# @trade-tool/executor

常驻止盈止损服务（v0.4.0）：**成交事件 → 净仓位 → ATR → 止盈止损条件单**。多空都支持。

```
Binance 用户数据流（listenKey）
      │  同一 symbol 串行处理
      ▼
判定：是自己挂的单吗 → 是则记结算（另一张由交易所撤销）
      │ 否
      ▼
流内增量净额（启动 / 每次重连后由 positionRisk 播种）：
      ├── = 0      → 工具外平仓：未终结记录收敛为 cancelled
      ├── 方向相反  → 减仓，忽略（由它自己的单触发）
      └── 方向一致  → 新开仓（BUY 开多 / SELL 开空），继续
      ▼
该标的是否已有未终结保护？→ 是则跳过并留 warn（不叠第二套 closePosition）
      ▼
占坑 risk_bracket（exchange + symbol + entryOrderId）── 冲突即「事件重放」，跳过
      ▼
quant_data risk-atr（按成交时刻，只用库内已收盘的连续 1m）→ ATR(14)
      ▼
deriveBracketPlan：SL = 入场 ∓ 2×ATR，TP = 入场 ± 3×ATR，两张都朝远离入场价对齐 tick
      ▼
挂 TAKE_PROFIT_MARKET，再挂 STOP_MARKET（closePosition=true）→ 回填单号，state=armed

另有一条旁路：ACCOUNT_UPDATE → 覆盖本地净仓位（校正，不参与判定）
```

**为什么方向判据是净仓位而不是成交方向**：只做多时「SELL = 减仓」成立，
支持做空后它就错了——开空仓也是 SELL，而交易所的净仓位才是事实。

**净仓位为什么是「流内增量」而不是每次查接口**：`ORDER_TRADE_UPDATE` 在 USDⓈ-M 上
不带仓位（仓位在 `ACCOUNT_UPDATE` 里），而两类事件之间**没有顺序保证**，
所以既不能从成交事件里刨、也不能等账户事件。逐笔累加与交易所净额等价，且不依赖事件顺序、
不需要每笔出网。完整理由见 AGENTS.md §6.3 第 7 条与 `packages/core/src/net-position.ts`。

`handleFill` 的返回值是**可见的处理结论**（日志与测试都靠它区分「为什么没设单」）：
`ignored` / `settled` / `external-close` / `skipped-existing-bracket` / `duplicate` /
`partial-skipped` / `armed` / `failed`。

**启动时先校时钟**：本机时钟与交易所差 1 秒就会让每个私有请求吃 -1021（挂单、撤单、
对账全在里面）。`/fapi/v1/time` 是无签名的，时钟不准时依然可用，因此用它测量偏移，
并在启动日志里打出来——补偿不可见就等于没补偿。详见 `packages/core/src/clock-skew.ts`。

- `src/service.ts` — `createExecutorService()`：事件判定、幂等、下单与失败回滚。
  全部依赖（pool / 下单 / ATR）都是注入的，测试用替身，**不连 PG、不出网**。
- `src/atr.ts` — ATR 取数适配。指标公式只在 `quant_core`；这里只把控制信息交给
  `python -m quant_data risk-atr`，K 线不经 stdout（R-2.1）。
- `src/main.ts` — 进程入口（`bin: trade-tool-executor`）。默认 `executor.enabled = false`，
  不开就不启动；缺密钥直接拒绝启动。
- `src/alert.ts` — 对账报告 → 告警条目（v0.8.0）。指纹只由「是什么事」决定
  （差异类型 + 标的 + 入场单号），**不含**本轮的具体数值——掺进去会让每轮都算新告警，
  冷却就形同虚设。

## 飞书告警（v0.8.0）

周期对账发现的差异会推到飞书（实现见 `packages/core/src/notify.ts`，规则见 AGENTS.md
§6.9）。四件事值得记住：

- **推的是「报告」，不是「处置」**：不改任何账本、不碰交易所。处置一律人工决定，
  与对账「只报告不动手」是同一条保证。
- **一轮合成一条**：一个裸仓常同时命中好几条判据（「没有止损单」+「有仓位没记录」），
  拆开推就成了「一个问题推了三遍」。
- **不刷屏**：同一件事在冷却期（默认 30 分钟）内只推一次；严重度变了立刻重推；
  差异消失时推一条「已恢复」。
- **设置每轮重新读**：通道在**每轮对账时**重新解析一次（库里优先、配置文件兜底），
  所以控制面改完设置**不必重启本进程**，下一轮（默认 5 分钟内）就用新值。
  这与交易所凭据不同——凭据是启动时读的，改了要重启。

## 为什么是两次下单而不是一次

Binance U 本位永续**没有**单请求 OCO：`/fapi/v1/order/oco` 已下架，官方 TP/SL 走 algo
条件单。本服务挂 `STOP_MARKET` + `TAKE_PROFIT_MARKET`（都带 `closePosition=true`），
**仓位平掉后剩余那张由交易所自动撤销**——撤销关系在交易所侧，本地不轮询、不盯市。

⚠️ **v0.7.0 的分批形态部分推翻了上面这句保证**，照实说明：

| 形态                                   | 止盈单                    | 仓位归零时另一张自动撤销？ |
| -------------------------------------- | ------------------------- | -------------------------- |
| 不分批（`takeProfit1Ratio = 0` / `1`） | `closePosition`           | **是**，与 v0.4.0 完全一致 |
| 分批（`0 < ratio < 1`）                | `quantity` + `reduceOnly` | **否**，改由本地撤         |

原因是官方明确 `quantity` 与 `closePosition` **互斥**（同时发是 `-1106`），而带数量的单
只认数量，仓位已经是 0 时它不会自己消失。因此分批形态下：**止损单仍然是 `closePosition`**，
它继续保护减仓后的剩余仓位（这也是第一段成交后不必重挂止损的原因）；但**止盈单要由本地在
净额归零时撤**，且**进程不在时无人撤**。补偿手段是对账的 `unexpected-take-profit-order`
（只报告，不自动处理）。

移动止损（`0 < ratio < 1` 时剩余仓位的唯一自动出口）由 `src/trailing.ts` 的独立定时器
负责，与周期对账**分开**：对账是纯只读的，而移动止损要挂单撤单，合并会让「对账绝不动手」
这条保证失守。

先后顺序是刻意的：**先止盈后止损**。反过来若止损失败，我们就有一张撤不掉的止盈单，
仓位从此没有止损。若第二张没挂上，第一张会被主动撤掉。

## 幂等

用户数据流在 listenKey 续期与断线重连后会重放事件，而止盈止损是**会真实下单**的动作。
`risk_bracket` 的主键 `(exchange, symbol, entry_order_id)` 是唯一防线：先占坑再动手，
冲突即跳过。占坑后失败留下 `failed` 行 + `last_error`——宁可看得见的失败，
也不要「下单成功但没记下来，重连后再挂一次」。

## 运行

```bash
cp .env.example .env        # 填 TRADE_TOOL_BINANCE_API_KEY / _SECRET
# 配置里 executor.enabled = true（会真实下单）
pnpm --filter @trade-tool/executor start
```

前置条件：目标标的的 1m K 线已被 `apps/sync` 同步到成交时刻附近——
ATR 只从库里读，库里没有就记 `RISK_ATR_UNAVAILABLE` 并拒绝下单，
**绝不**换周期或用 0 顶替（止损位等于入场价就是当场平仓）。

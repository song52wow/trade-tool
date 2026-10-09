# @trade-tool/executor

常驻止盈止损服务（v0.4.0）：**买入成交事件 → ATR → 止盈止损条件单**。

```
Binance 用户数据流（listenKey）
      │  ORDER_TRADE_UPDATE
      ▼
判定：是自己挂的单吗 → 是则记结算（另一张由交易所撤销）
      │ 否
      ▼
只在买入成交上建保护，且必须达到门槛（FILLED，或 accumulate 模式的部分成交）
      ▼
占坑 risk_bracket（exchange + symbol + entryOrderId）── 冲突即「已处理过」，跳过
      ▼
quant_data risk-atr（按成交时刻，只用库内已收盘的连续 1m）→ ATR(14)
      ▼
deriveBracketPlan：SL = 入场 ∓ 2×ATR，TP = 入场 ± 3×ATR，两张都朝远离入场价对齐 tick
      ▼
挂 TAKE_PROFIT_MARKET，再挂 STOP_MARKET（closePosition=true）→ 回填单号，state=armed
```

- `src/service.ts` — `createExecutorService()`：事件判定、幂等、下单与失败回滚。
  全部依赖（pool / 下单 / ATR）都是注入的，测试用替身，**不连 PG、不出网**。
- `src/atr.ts` — ATR 取数适配。指标公式只在 `quant_core`；这里只把控制信息交给
  `python -m quant_data risk-atr`，K 线不经 stdout（R-2.1）。
- `src/main.ts` — 进程入口（`bin: trade-tool-executor`）。默认 `executor.enabled = false`，
  不开就不启动；缺密钥直接拒绝启动。

## 为什么是两次下单而不是一次

Binance U 本位永续**没有**单请求 OCO：`/fapi/v1/order/oco` 已下架，官方 TP/SL 走 algo
条件单。本服务挂 `STOP_MARKET` + `TAKE_PROFIT_MARKET`（都带 `closePosition=true`），
**仓位平掉后剩余那张由交易所自动撤销**——撤销关系在交易所侧，本地不轮询、不盯市，
进程崩了也不会留下裸奔仓位。

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

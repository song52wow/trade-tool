# @trade-tool/chain-monitor

链上仓位监控服务（v1.2.0）：**定时读 BSC 上的 PancakeSwap V3 仓位 → 算盈亏 → 落库 → 需要时推飞书**。

```
配置文件里的 chain.positions[]
      │  每 chain.pollIntervalMs（默认 15 分钟）一轮
      ▼
packages/data 的 readChainPosition：读链上事实
      │  仓位管理器 positions(uint256)  → tick 区间、流动性
      │  池子       positions(bytes32)  → 权威的流动性、手续费基准
      │  池子       slot0() / ticks() / feeGrowthGlobalX128()
      ▼
packages/core 的 computeChainPositionSnapshot：算账（持仓构成、成本、盈亏、手续费）
      ▼
packages/data 的 upsert / insertChainSnapshot：落库
      ▼
packages/core 的 decideChainPositionAlert：这一轮要不要推
      ▼
packages/core 的通知层 → 飞书（文案在本 app 的 src/alert.ts）
```

## 三个「不」

- **不静默兜底**：链上读不到就抛错，那一笔的 `last_error` 写进库，页面上常驻可见；
  一笔坏的不拖垮别的仓位。
- **不刷屏**：价格动 0.1% 不推。只有「仓位被清空 / 有人加减仓 / 价格出了设定区间 /
  价格或盈亏较上次推送超过阈值」才推，且两次推送之间有冷却。
- **不假装说过**：**只有真的推出去**才更新「上次推送」的基准。推送失败会留下记录
  （`chain_position_alert` 里 `sent = false`），基准不动，下一轮还会试。

## 文件

- `src/service.ts` — `createChainMonitorService()`：一轮监控的编排
  （读链 → 算账 → 落库 → 判定 → 推送）。依赖全部注入，单轮行为可测。
- `src/alert.ts` — 判据 → 一条通知文案。指纹只由「是哪笔仓位」决定，
  **不含**本轮数值——掺进去会让每轮都算新告警，冷却就形同虚设。
- `src/main.ts` — 进程入口（`bin: trade-tool-chain-monitor`）。
  默认 `chain.enabled = false`，**不开就不启动**（不出网、不建连接）；
  `chain.positions` 为空也直接退出并说清原因。

判据在 `packages/core/src/chain-alert.ts`，算账在 `packages/core/src/chain-v3.ts`，
读链在 `packages/data/src/bsc-v3.ts`，落库在 `packages/data/src/db/chain-position.ts`，
schema 在 `packages/data/sql/026_chain_position.sql`。

## 配置

配置写在 `TRADE_TOOL_HOME` 下的 `trade-tool.config.json` 的 `chain` 段：

```json
{
  "chain": {
    "enabled": true,
    "pollIntervalMs": 900000,
    "rpcEndpoints": ["https://bsc-dataseed.binance.org"],
    "positions": [
      {
        "chain": "bsc",
        "positionManager": "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364",
        "pool": "0xB2c8244FBeee2dA006b5D9Cf09908081f807C649",
        "token0": "0x...pPOLY",
        "token1": "0x...USDT",
        "tokenId": "7784261",
        "owner": "0xa6156641dfcda456985fe6d79cd62313b2d04488",
        "depositAmount0": "3400000000000000000",
        "depositAmount1": "34677495886492744054",
        "depositTx": "0x0919...6115",
        "symbol0": "pPOLY",
        "symbol1": "USDT"
      }
    ],
    "thresholds": { "priceMovePct": 1.5, "pnlMovePp": 1.5, "cooldownMs": 1800000 }
  }
}
```

`depositAmount0` / `depositAmount1` 是**原始单位**的整数字符串（18 位小数），
不是「3.4」这种带小数的写法——写成带小数会算错成本。

## 为什么「存入时的价格」是反推出来的

BSC 的公共节点**不给查历史状态**（`eth_call` 带区块号一律 403），
所以「存入那一刻的价格」拿不到。

替代口径：用**投入的币数 + 当前流动性 + 边界 tick** 反推
（`packages/core/src/chain-v3.ts` 的 `solveDepositSqrtPrice`），
每次算账都验算一遍；**对不上直接抛错**，不给一个编出来的数。
反推的相对误差 < 1e-6（Uniswap 自己的取整造成的）。

## 飞书通知

复用仓库既有通知层（`packages/core/src/notify.ts`），通知种类是
`chain-position-alert`。**通道每轮重新解析一次**（库里控制面录的密文优先，
配置文件 + 环境变量兜底），所以控制面改完设置**不必重启本进程**。

webhook 地址**不写进代码，也不写进配置文件**——用环境变量
`TRADE_TOOL_FEISHU_WEBHOOK_URL`，或在控制面「设置」页录入。

告警正文**末尾带两条链上链接**（区块浏览器 / 流动性平台）：告警说「价格跌出区间」
之后，人要做的下一件事就是去链上看。链接由 `packages/core/src/chain-links.ts` 拼，
与控制面那一页**共用同一份实现**（两处各拼一次就会有一处变成死链）。

## 测试

```bash
pnpm --filter @trade-tool/chain-monitor test
```

用例起一个**本地假 BSC 节点**（`packages/data/src/testing-bsc.ts`）与**真库**
（`packages/data/src/testing-pg.ts` 的随机 schema + 从空库跑迁移），
全程**不访问真实网络**。真节点只用来验「真链上长什么样」的那次手工核对。

## 页面

监控结果落在库里，**控制面只读**（`apps/web` 的「链上仓位」面板）：
当前价、价值、盈亏、定价区间、**当前 APY**、链上链接与最近一次错误。
控制面不写这张表——写它的只有本服务。

页面是**卡片列表 → 详情**两条路由（`#/chain` 与 `#/chain/<仓位键>`）：
列表每张卡给一眼看完的重点，点卡片进详情看全。

⚠️ 页面**不画走势图**（2026-11-14 简化）：那把一页变成了流水账。
采样明细在**详情页用表格**摆出来（一次采样一行），采样**照旧落库**
（`chain_position_snapshot`）。

当前 APY 由 `packages/core/src/chain-v3.ts` 的 `computeChainApy` 算
（**最近 7 天实收手续费 ÷ 投入成本再年化**）。它的原料是**采样表**里的累计手续费与时间戳，
所以它跟着采样走：本服务一停，数字会**停在最后一次采样那一刻**（页面上写着「上次采样 X 前」），
不会自己变新；采样表里一笔都没有时给的是一句人话原因，而不是编一个数。

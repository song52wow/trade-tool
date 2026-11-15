-- 026_chain_position：链上（BSC / PancakeSwap V3）流动性仓位的监控记录。
--
-- 为什么要有这三张表：
--   这个仓库原本只看**币安合约**的行情与仓位，而「某个人在链上的一笔 V3 流动性仓位
--   现在值多少、赚没赚」这件事，只有链上说得清。为了回答它，需要三样东西：
--     * 仓位本身（配置 + 滚动状态）→ chain_position；
--     * 每一次采样的结果（画曲线、看趋势）→ chain_position_snapshot；
--     * 每一次告警的记录（群里推过什么、推没推出去）→ chain_position_alert。
--
-- 与 `executor_status`（024）同一套思路：**「进程活着」与「服务能用」分开记**。
-- 这里分的是「最后一次采样成功」与「最后一次采样失败的原因」——
-- 只有 last_poll_at 的话，页面会显示「3 小时前更新过」，却看不出那之后一直失败。
--
-- 语义：
--   * `position_key` 是**链上身份**：Uniswap V3 的仓位 key = keccak(仓位管理器, 下界 tick,
--     上界 tick)（紧凑拼接，见 packages/data/src/bsc-v3.ts）。用它当主键，
--     同一笔仓位在多次启动之间是同一个键，不会因为配置里 tokenId 写法不同而变成两行。
--   * 金额一栏（amount0 / amount1 / liquidity / deposit_amount*）用 **numeric**：
--     18 位小数的代币数量是 1e18 量级，**超出 double precision 能精确表示的范围**
--     （2^53 ≈ 9e15）。用 double 会悄悄丢掉低位，而低位正是「这个仓位里到底有多少币」。
--   * 价格与金额（price / value_usdt / pnl_* / fee_usdt）用 double precision：
--     它们是**给人看的数**（两位小数），精度要求低，且与本仓库其它表保持一致。
--   * 时间一律 **毫秒 bigint**（跨语言契约：不用 timestamptz）。
--   * `last_error` 只在失败时写，成功时清空——留着旧的错会让页面显示「现在也是坏的」。
--
-- 本文件必须可重复执行。

CREATE TABLE IF NOT EXISTS chain_position (
    -- 链上身份：keccak(仓位管理器, tickLower, tickUpper)
    position_key       text    PRIMARY KEY,
    chain              text    NOT NULL,
    position_manager   text    NOT NULL,
    pool               text    NOT NULL,
    token0             text    NOT NULL,
    token1             text    NOT NULL,
    token_id           bigint  NOT NULL,
    owner              text    NOT NULL,
    tick_lower         integer NOT NULL,
    tick_upper         integer NOT NULL,
    -- 显示用的符号（只为展示，不参与任何判据）
    symbol0            text,
    symbol1            text,
    -- 投入时两个币的数量（**原始单位**，18 位小数）
    deposit_amount0    numeric NOT NULL,
    deposit_amount1    numeric NOT NULL,
    deposit_tx         text,

    -- ── 滚动状态（每轮更新）────────────────────────────────────────────
    -- 成本（按存入时的池子价格折算成计价币）与已实现盈亏（加减仓时结算）
    cost_usdt          double precision NOT NULL DEFAULT 0,
    realized_usdt      double precision NOT NULL DEFAULT 0,
    -- 「上次推送」时的基准：没推出去就不更新，否则这条提醒就永远丢了
    last_alert_price   double precision,
    last_alert_pnl_pct double precision,
    last_alert_at      bigint,
    -- 上一轮的流动性与区间内外状态：用来发现「有人加仓 / 减仓」「价格出了区间」
    last_liquidity     numeric,
    in_range           boolean,
    -- 是否已经建立过基线（第一次采样只建基线，不当成「变化」）
    baseline_done      boolean NOT NULL DEFAULT false,
    -- 最后一次采样成功/失败的时刻与原因
    last_poll_at       bigint,
    last_error         text,

    created_at         bigint  NOT NULL,
    updated_at         bigint  NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_position_snapshot (
    id            bigserial PRIMARY KEY,
    position_key  text    NOT NULL,
    ts            bigint  NOT NULL,
    block         bigint  NOT NULL,
    price         double precision NOT NULL,
    -- 持仓构成（原始单位）
    amount0       numeric NOT NULL,
    amount1       numeric NOT NULL,
    value_usdt    double precision NOT NULL,
    cost_usdt     double precision NOT NULL,
    realized_usdt double precision NOT NULL,
    pnl_usdt      double precision NOT NULL,
    pnl_pct       double precision NOT NULL,
    fee_usdt      double precision NOT NULL,
    in_range      boolean NOT NULL,
    liquidity     numeric NOT NULL
);

CREATE INDEX IF NOT EXISTS chain_position_snapshot_key_ts
    ON chain_position_snapshot (position_key, ts);

CREATE TABLE IF NOT EXISTS chain_position_alert (
    id           bigserial PRIMARY KEY,
    position_key text    NOT NULL,
    ts           bigint  NOT NULL,
    -- 触发原因（人话，页面与日志都直接显示它）
    reasons      text    NOT NULL,
    -- 是否真的发出去了（推送失败也要留记录，否则「群里没消息」会变成无头案）
    sent         boolean NOT NULL,
    detail       jsonb
);

CREATE INDEX IF NOT EXISTS chain_position_alert_key_ts
    ON chain_position_alert (position_key, ts);
